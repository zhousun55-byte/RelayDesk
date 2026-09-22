import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

interface Scenario {
  home: string;
  repo: string;
  fakeAgent: string;
}

function mkScenario(name: string): Scenario {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `relay-e2e-${name}-`));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(home);
  const fakeAgent = path.join(base, 'fake-agent.sh');
  fs.writeFileSync(fakeAgent, '#!/bin/sh\necho "weak-agent edit $(date +%s)" >> app.txt\n');
  fs.chmodSync(fakeAgent, 0o755);
  execFileSync('git', ['init', '-q', repo]);
  const g = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'demo\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'init']);
  return { home, repo, fakeAgent };
}

function relay(s: Scenario, args: string[], expectFail = false): string {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: s.home };
  delete env.DEEPSEEK_API_KEY; // 保证审计阅读面走「未配置」路径，无网络依赖
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: s.repo, encoding: 'utf8', env });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  if (!expectFail && r.status !== 0) throw new Error(`relay ${args.join(' ')} 失败：\n${out}`);
  if (expectFail && r.status === 0) throw new Error(`relay ${args.join(' ')} 应失败却成功：\n${out}`);
  return out;
}

function gitRepo(s: Scenario, args: string[]): string {
  return execFileSync('git', ['-C', s.repo, ...args], { encoding: 'utf8' }).trim();
}

function setupInited(s: Scenario, configPatch: (cfg: Record<string, unknown>) => void): void {
  relay(s, ['init']);
  const cfgPath = path.join(s.repo, '.relay', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
  configPatch(cfg);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  gitRepo(s, ['add', '-A']);
  gitRepo(s, ['commit', '-q', '-m', 'relay config']); // 协议三：config.json 进主线
  relay(s, ['agents', 'add', 'fake', '--cmd', s.fakeAgent, '--tier', 'weak']);
}

/** 会话指针目录名含 repo 路径哈希，直接扫描更稳。 */
function findSession(
  s: Scenario
): { worktree: string; branch: string; startCommit: string; baseCommit: string } | null {
  const projectsDir = path.join(s.home, '.relay', 'projects');
  if (!fs.existsSync(projectsDir)) return null;
  for (const d of fs.readdirSync(projectsDir)) {
    const p = path.join(projectsDir, d, 'session.json');
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8')) as {
        worktree: string;
        branch: string;
        startCommit: string;
        baseCommit: string;
      };
    }
  }
  return null;
}

test('e2e 完整接力：start → run → handoff → run → handoff → merge（主线干净，会话文件不进主线）', () => {
  const s = mkScenario('full');
  setupInited(s, (cfg) => {
    (cfg as { gate: { command: string } }).gate.command = 'test -f app.txt';
  });

  // start：分支 + 仓库外 worktree + 主线无改动（第 2 步验收标准）
  const startOut = relay(s, ['start', 'add greeting feature']);
  assert.ok(startOut.includes('relay/'));
  const session = findSession(s);
  assert.ok(session, 'start 后应有会话指针');
  assert.ok(session.branch.startsWith('relay/'));
  assert.ok(session.worktree.startsWith(path.join(s.home, '.relay', 'worktrees')), 'worktree 必须在仓库外 ~/.relay 下');
  assert.ok(fs.existsSync(session.worktree));
  assert.ok(gitRepo(s, ['branch', '--list', session.branch]).includes(session.branch));
  assert.equal(gitRepo(s, ['status', '--porcelain']), '', '主仓库工作区必须保持干净');

  // 第一次 run（弱 agent 上岗）
  relay(s, ['run', 'fake']);
  const wt = session.worktree;
  assert.ok(fs.existsSync(path.join(wt, 'app.txt')), '假 agent 应已改动 app.txt');

  // 第一次 handoff：审计（仅事实报告，无 API key）+ 门禁通过 + 检查点
  const h1 = relay(s, ['handoff']);
  assert.ok(h1.includes('检查点'));
  const auditsDir = path.join(wt, '.relay', 'audits');
  const reports = fs.readdirSync(auditsDir).filter((f) => f.endsWith('.md'));
  assert.ok(reports.length >= 1, '审计报告应已落盘');
  const reportContent = fs.readFileSync(path.join(auditsDir, reports[reports.length - 1]), 'utf8');
  assert.ok(reportContent.includes('事实段'));
  assert.ok(reportContent.includes('app.txt'));

  // journal 应有完整事件链；start 提交的树里必须带 journal（start 事件先 append 再 commitAll）
  const journal = fs.readFileSync(path.join(wt, '.relay', 'journal.jsonl'), 'utf8');
  assert.ok(journal.includes('"type":"start"'));
  assert.ok(journal.includes('"type":"run"'));
  assert.ok(journal.includes('"type":"exit"'));
  assert.ok(journal.includes('"type":"audit"'));
  assert.ok(journal.includes('"status":"failed"'), '审计阅读面未配置应为 failed');
  assert.ok(journal.includes('"type":"gate"'));
  assert.ok(journal.includes('"type":"handoff"'));
  // start 提交的树里有 journal（回滚到 start 后仍可读的前提）
  const startTreeFiles = execFileSync(
    'git',
    ['-C', wt, 'ls-tree', '--name-only', '-r', session.startCommit, '--', '.relay/'],
    { encoding: 'utf8' }
  );
  assert.ok(startTreeFiles.includes('journal.jsonl'), `start 树里应有 journal：\n${startTreeFiles}`);

  // 第二次 run：前任 weak → ONBOARD 必须含强制自审（协议一），
  // 且自审基准是上一段的起点（≠刚打的检查点），diff 能看到前任的业务改动
  const ck1 = (JSON.parse(
    fs
      .readFileSync(path.join(wt, '.relay', 'journal.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"type":"handoff"'))
      .pop() ?? '{}'
  ) as { checkpoint: string }).checkpoint;
  relay(s, ['run', 'fake']);
  const onboard = fs.readFileSync(path.join(wt, '.relay', 'ONBOARD.md'), 'utf8');
  assert.ok(onboard.includes('强制自审'));
  assert.ok(onboard.includes('fake'));
  assert.ok(onboard.includes('git diff'));
  const m = onboard.match(/自审基准 commit：`([0-9a-f]{7,40})`/);
  assert.ok(m, 'ONBOARD 应含自审基准 SHA');
  const reviewBase = m[1];
  assert.notEqual(reviewBase, ck1, '自审基准不能是刚打的检查点（那样 diff 看不到前任改动）');
  assert.equal(reviewBase, session.baseCommit, '首次 handoff 后，上一段起点 = 主线基准');
  const diffNames = execFileSync('git', ['-C', wt, 'diff', `${reviewBase}..HEAD`, '--name-only'], {
    encoding: 'utf8',
  });
  assert.ok(diffNames.includes('app.txt'), `对自审基准 diff 应看到假 agent 改的文件：\n${diffNames}`);

  // resume 别名同样能启动（同一套逻辑）
  const aliasOut = relay(s, ['resume', '--help']);
  assert.ok(aliasOut.includes('run|resume'));

  // 第二次 handoff
  relay(s, ['handoff']);

  // status：换人决策面板
  const st = relay(s, ['status']);
  assert.ok(st.includes('add greeting feature'));
  assert.ok(st.includes('最近干活：fake'));
  assert.ok(st.includes('门禁：通过'));

  // merge：主线拿业务 diff，会话文件被剥离，分支保留
  const base = gitRepo(s, ['rev-parse', 'HEAD']);
  const mergeOut = relay(s, ['merge']);
  assert.ok(mergeOut.includes('合并完成'));
  assert.ok(fs.existsSync(path.join(s.repo, 'app.txt')), '主线应有 app.txt');
  const mainRelay = fs.readdirSync(path.join(s.repo, '.relay'));
  assert.deepEqual(mainRelay, ['config.json'], '主线 .relay 只允许 config.json');
  const subject = gitRepo(s, ['log', '-1', '--format=%s']);
  assert.ok(subject.startsWith('relay: merge relay/'), `主线提交信息应由 journal 生成：${subject}`);
  const body = gitRepo(s, ['log', '-1', '--format=%b']);
  assert.ok(body.includes('fake'));
  assert.equal(gitRepo(s, ['rev-list', `${base}..HEAD`, '--count']), '1', 'squash 后主线恰好一个新提交');
  assert.ok(gitRepo(s, ['branch', '--list', session.branch]).includes(session.branch), '接力分支应保留备查');
  assert.equal(findSession(s), null, 'merge 后会话指针应清除');
  assert.ok(relay(s, ['status']).includes('无活跃任务'));
  assert.equal(gitRepo(s, ['status', '--porcelain']), '', 'merge 后主仓库仍干净');

  fs.rmSync(path.dirname(s.home), { recursive: true, force: true });
});

test('e2e 保护路径：命中拒绝 merge，--force 才放行（F8）', () => {
  const s = mkScenario('protected');
  setupInited(s, (cfg) => {
    (cfg as { protectedPaths: string[] }).protectedPaths = ['app.txt'];
  });
  relay(s, ['start', 'touch protected file']);
  relay(s, ['run', 'fake']);
  relay(s, ['handoff']);
  const refused = relay(s, ['merge'], true);
  assert.ok(refused.includes('保护路径被改动'), refused);
  const forced = relay(s, ['merge', '--force']);
  assert.ok(forced.includes('合并完成'));
  assert.ok(fs.existsSync(path.join(s.repo, 'app.txt')));
  fs.rmSync(path.dirname(s.home), { recursive: true, force: true });
});

test('e2e 回滚：reset --hard + clean -fd 只动 worktree，主线不受影响', () => {
  const s = mkScenario('rollback');
  setupInited(s, () => {});
  const mainHeadBefore = gitRepo(s, ['rev-parse', 'HEAD']);
  relay(s, ['start', 'rollback me']);
  const session = findSession(s);
  assert.ok(session);
  // 回滚到 start 用会话指针里的 startCommit（start 事件里存的是主线基准）
  const startSha = session.startCommit;

  relay(s, ['run', 'fake']);
  relay(s, ['handoff']);
  assert.ok(fs.existsSync(path.join(session.worktree, 'app.txt')));

  const rb = relay(s, ['rollback', startSha]);
  assert.ok(rb.includes('已回滚'));
  assert.ok(!fs.existsSync(path.join(session.worktree, 'app.txt')), '回滚后 app.txt 应消失');
  // rollback 到 start 之后，journal 仍能读到 start 事件（后面追加的 rollback 事件也在）
  const journalAfter = fs.readFileSync(path.join(session.worktree, '.relay', 'journal.jsonl'), 'utf8');
  assert.ok(journalAfter.includes('"type":"start"'), '回滚到 start 后 start 事件必须仍可读');
  assert.ok(journalAfter.includes('"type":"rollback"'));
  assert.equal(gitRepo(s, ['rev-parse', 'HEAD']), mainHeadBefore, '主线绝不能被动');
  fs.rmSync(path.dirname(s.home), { recursive: true, force: true });
});

test('e2e 放弃：abandon 删 worktree、留分支、清指针（F9：失败任务不卡死 start）', () => {
  const s = mkScenario('abandon');
  setupInited(s, () => {});
  relay(s, ['start', 'doomed task']);
  const session = findSession(s);
  assert.ok(session);
  const out = relay(s, ['abandon']);
  assert.ok(out.includes('保留备查'));
  assert.ok(!fs.existsSync(session.worktree), 'worktree 应被删除');
  assert.ok(gitRepo(s, ['branch', '--list', session.branch]).includes(session.branch), '分支保留');
  assert.equal(findSession(s), null, '会话指针应清除');
  // 不卡死：可以立刻开始新任务
  relay(s, ['start', 'next task after abandon']);
  assert.ok(findSession(s));
  fs.rmSync(path.dirname(s.home), { recursive: true, force: true });
});

test('e2e 坏 journal：status 报行号；abandon --force 仍清会话、不卡死 start', () => {
  const s = mkScenario('badjournal');
  setupInited(s, () => {});
  relay(s, ['start', 'corrupt me']);
  const session = findSession(s);
  assert.ok(session);
  const jp = path.join(session.worktree, '.relay', 'journal.jsonl');
  fs.appendFileSync(jp, 'THIS IS NOT JSON\n');
  const status = relay(s, ['status'], true);
  assert.ok(status.includes('不是合法 JSON') || status.includes('第 '), status);
  const out = relay(s, ['abandon', '--force']);
  assert.ok(out.includes('保留备查') || out.includes('已放弃'), out);
  assert.equal(findSession(s), null, '坏 journal 也必须能清掉会话指针');
  relay(s, ['start', 'after corrupt abandon']);
  assert.ok(findSession(s));
  fs.rmSync(path.dirname(s.home), { recursive: true, force: true });
});

test('e2e 单写者锁：运行中的会话未释放前，第二次 run 拒绝（陈旧锁可覆盖）', () => {
  const s = mkScenario('lock');
  // 用 sleep 型假 agent 制造持锁窗口
  const slowAgent = path.join(path.dirname(s.fakeAgent), 'slow-agent.sh');
  fs.writeFileSync(slowAgent, '#!/bin/sh\nsleep 2\n');
  fs.chmodSync(slowAgent, 0o755);
  setupInited(s, () => {});
  relay(s, ['agents', 'add', 'slow', '--cmd', slowAgent, '--tier', 'strong']);

  relay(s, ['start', 'lock test']);
  const session = findSession(s);
  assert.ok(session);

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: s.home };
  delete env.DEEPSEEK_API_KEY;
  const first = spawnSync(process.execPath, [CLI, 'run', 'slow'], {
    cwd: s.repo,
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
  assert.equal(first.status, 0, first.stdout + first.stderr);

  // 同步等待期间难以并发，改为直接构造「活锁」：写一个 pid 为当前进程的锁
  const lockFile = path.join(session.worktree, '.relay', 'session.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ agent: 'slow', pid: process.pid, ts: new Date().toISOString() }));
  const journalP = path.join(session.worktree, '.relay', 'journal.jsonl');
  const runCount = (t: string): number => (t.match(/"type":"run"/g) ?? []).length;
  const before = runCount(fs.readFileSync(journalP, 'utf8'));
  const refused = relay(s, ['run', 'slow'], true);
  assert.ok(refused.includes('仍在运行'), refused);
  // 锁被拒不产生副作用：journal 不多出 run 事件（不留下没有 exit 的 run 谎言）
  assert.equal(runCount(fs.readFileSync(journalP, 'utf8')), before);
  // handoff 在活锁期间同样拒绝（单写者完整性）
  const refusedHandoff = relay(s, ['handoff'], true);
  assert.ok(refusedHandoff.includes('仍在运行'), refusedHandoff);
  // pid 已死 → 陈旧锁，run 可覆盖
  fs.writeFileSync(lockFile, JSON.stringify({ agent: 'slow', pid: 999999, ts: new Date().toISOString() }));
  const took = relay(s, ['run', 'slow']);
  assert.ok(took.includes('陈旧锁') || took.includes('退出'), took);
  fs.rmSync(path.dirname(s.home), { recursive: true, force: true });
});

test('e2e 门禁红：handoff 不阻塞，merge 拒绝（除非 --force）', () => {
  const s = mkScenario('gatered');
  setupInited(s, (cfg) => {
    (cfg as { gate: { command: string } }).gate.command = 'false'; // 恒失败门禁
  });
  relay(s, ['start', 'gate red flow']);
  relay(s, ['run', 'fake']);
  const h = relay(s, ['handoff']); // 不应抛错
  assert.ok(h.includes('交接完成'));
  assert.ok(h.includes('未通过') || h.includes('⚠'));
  const refused = relay(s, ['merge'], true);
  assert.ok(refused.includes('门禁未通过') || refused.includes('--force'), refused);
  fs.rmSync(path.dirname(s.home), { recursive: true, force: true });
});

test('e2e 审计先检查点后审计：agent 新建的未跟踪文件在事实段有内容 diff hunk，不能只有文件名', () => {
  const s = mkScenario('untracked');
  // 假 agent：新建一个从未跟踪过的文件并写入可辨认的内容
  const creator = path.join(path.dirname(s.fakeAgent), 'creator-agent.sh');
  fs.writeFileSync(creator, '#!/bin/sh\nprintf \'UNIQUE-CONTENT-9f8e7d6c\\nsecond line\\n\' > brand-new-file.txt\n');
  fs.chmodSync(creator, 0o755);
  setupInited(s, () => {});
  relay(s, ['agents', 'add', 'creator', '--cmd', creator, '--tier', 'strong']);

  relay(s, ['start', 'create brand new file']);
  relay(s, ['run', 'creator']);
  relay(s, ['handoff']);

  const session = findSession(s);
  assert.ok(session);
  const wt = session.worktree;
  assert.ok(fs.existsSync(path.join(wt, 'brand-new-file.txt')), '假 agent 应已新建文件');

  // 检查点（rollback 目标）= 第一次 commit：新文件连同内容必须已在树里
  const ck = (
    fs
      .readFileSync(path.join(wt, '.relay', 'journal.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"type":"handoff"'))
      .map((l) => JSON.parse(l) as { checkpoint: string })
      .pop() ?? { checkpoint: '' }
  ).checkpoint;
  assert.ok(ck, 'journal 应有 handoff 检查点');
  assert.equal(gitRepo(s, ['log', '-1', '--format=%s', ck]).startsWith('relay: checkpoint'), true, '检查点须是第一次 checkpoint commit');
  assert.ok(gitRepo(s, ['ls-tree', '-r', '--name-only', ck]).includes('brand-new-file.txt'), '检查点树里必须有新文件');
  assert.ok(
    gitRepo(s, ['show', `${ck}:brand-new-file.txt`]).includes('UNIQUE-CONTENT-9f8e7d6c'),
    '检查点树里的新文件必须有内容'
  );

  // 审计报告事实段：新文件的 diff hunk（带内容）必须出现，不能只有文件名
  const auditsDir = path.join(wt, '.relay', 'audits');
  const reports = fs.readdirSync(auditsDir).filter((f) => f.endsWith('.md'));
  assert.ok(reports.length >= 1);
  const report = fs.readFileSync(path.join(auditsDir, reports[reports.length - 1]), 'utf8');
  assert.ok(report.includes('+UNIQUE-CONTENT-9f8e7d6c'), `事实段应含新文件内容的 diff hunk：\n${report.slice(0, 800)}`);
  assert.ok(report.includes('diff --git a/brand-new-file.txt b/brand-new-file.txt'), '事实段应含新文件的 diff 条目');
  assert.ok(report.includes(ck), '事实段应写明审计范围（含检查点 SHA）');
  assert.ok(!report.includes('### 未跟踪文件'), '检查点先行后不应再依赖未跟踪列表当主证据');

  // handoff.md 的 diffstat 也是已提交范围，两份事实一致
  const doc = fs.readFileSync(path.join(wt, '.relay', 'handoff.md'), 'utf8');
  assert.ok(doc.includes('brand-new-file.txt'), 'handoff.md diffstat 应含新文件');

  fs.rmSync(path.dirname(s.home), { recursive: true, force: true });
});
