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
  opener: string;
}

function mkScenario(name: string): Scenario {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `relay-open-${name}-`));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(home);
  const fakeAgent = path.join(base, 'fake-agent.sh');
  fs.writeFileSync(fakeAgent, '#!/bin/sh\necho "cli-edit $(date +%s)" >> app.txt\n');
  fs.chmodSync(fakeAgent, 0o755);
  // 假「打开文件夹」命令：拿到 {{worktree}} 代入的路径作为 $1，往里面写文件——验证占位符替换真的发生
  const opener = path.join(base, 'fake-opener.sh');
  fs.writeFileSync(opener, '#!/bin/sh\necho "app-edit" >> "$1/app.txt"\n');
  fs.chmodSync(opener, 0o755);
  execFileSync('git', ['init', '-q', repo]);
  const g = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'demo\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'init']);
  return { home, repo, fakeAgent, opener };
}

function relay(s: Scenario, args: string[], expectFail = false): string {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: s.home };
  delete env.DEEPSEEK_API_KEY;
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: s.repo, encoding: 'utf8', env });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  if (!expectFail && r.status !== 0) throw new Error(`relay ${args.join(' ')} 失败：\n${out}`);
  if (expectFail && r.status === 0) throw new Error(`relay ${args.join(' ')} 应失败却成功：\n${out}`);
  return out;
}

function gitRepo(s: Scenario, args: string[]): string {
  return execFileSync('git', ['-C', s.repo, ...args], { encoding: 'utf8' }).trim();
}

function setupInited(s: Scenario): void {
  relay(s, ['init']);
  gitRepo(s, ['add', '-A']);
  gitRepo(s, ['commit', '-q', '-m', 'relay config']);
  relay(s, ['agents', 'add', 'fake', '--cmd', s.fakeAgent, '--tier', 'strong']);
  relay(s, ['agents', 'add', 'zapp', '--kind', 'app', '--cmd', `${s.opener} {{worktree}}`, '--tier', 'weak']);
}

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

function readJournal(wt: string): Record<string, unknown>[] {
  return fs
    .readFileSync(path.join(wt, '.relay', 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test('open 主路径：App 客人通道 + 软锁拒绝 + handoff 清锁 + 旧注册表无 kind 兼容', () => {
  const s = mkScenario('main');
  setupInited(s);
  relay(s, ['start', 'app guest flow']);
  const session = findSession(s);
  assert.ok(session);
  const wt = session.worktree;
  const lockFile = path.join(wt, '.relay', 'session.lock');

  // 通道互斥：run 拒 app，open 拒 cli
  const runApp = relay(s, ['run', 'zapp'], true);
  assert.ok(runApp.includes('relay open'), runApp);
  const openCli = relay(s, ['open', 'fake'], true);
  assert.ok(openCli.includes('relay run'), openCli);

  // open：写 ONBOARD + journal（有 open 无假 exit）+ 软锁 + 占位符代入后执行打开命令
  const out = relay(s, ['open', 'zapp']);
  assert.ok(out.includes('ONBOARD'), out);
  assert.ok(out.includes('relay handoff'), out);
  assert.ok(fs.existsSync(path.join(wt, '.relay', 'ONBOARD.md')), 'ONBOARD 应已写');
  const events = readJournal(wt);
  const openEv = events.find((e) => e.type === 'open');
  assert.ok(openEv, 'journal 应有 open 事件');
  assert.equal(openEv.agent, 'zapp');
  assert.equal(openEv.tier, 'weak');
  assert.ok(!('code' in openEv), 'open 事件不得有假 exit 字段');
  assert.ok(!events.some((e) => e.type === 'exit'), 'App 段不应有 exit 事件');
  assert.ok(fs.readFileSync(path.join(wt, 'app.txt'), 'utf8').includes('app-edit'), '{{worktree}} 应被代入且打开命令已执行');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { agent: string; kind: string };
  assert.equal(lock.kind, 'app');
  assert.equal(lock.agent, 'zapp');

  // 软锁期间：status 标明 App 会话；open/run/rollback 一律拒绝
  const st = relay(s, ['status']);
  assert.ok(st.includes('App 会话进行中') && st.includes('zapp'), st);
  assert.ok(relay(s, ['open', 'zapp'], true).includes('软锁'));
  assert.ok(relay(s, ['run', 'fake'], true).includes('软锁'));
  assert.ok(relay(s, ['rollback', session.startCommit], true).includes('App'), 'rollback 遇 App 软锁应拒绝');

  // handoff 是 App 段唯一收尾：成功 + 清软锁 + 交接文档归因到 zapp
  const h = relay(s, ['handoff']);
  assert.ok(h.includes('交接完成'), h);
  assert.ok(!fs.existsSync(lockFile), 'handoff 后软锁应清除');
  const handoffDoc = fs.readFileSync(path.join(wt, '.relay', 'handoff.md'), 'utf8');
  assert.ok(handoffDoc.includes('zapp'), '交接文档前任应归因到 App 客人 zapp');
  const ck = readJournal(wt).filter((e) => e.type === 'handoff').pop() as { checkpoint: string };
  assert.ok(ck.checkpoint);

  // 旧注册表兼容：手工删掉 kind 字段（旧格式），run 仍可用；
  // handoff 之后再 run，自审基准仍走 reviewBaseFor：= 主线基准 ≠ 刚打的检查点，diff 能看到 App 段业务文件
  const regPath = path.join(s.home, '.relay', 'agents.json');
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8')) as { agents: Record<string, unknown>[] };
  for (const a of reg.agents) delete a.kind;
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2) + '\n');

  relay(s, ['run', 'fake']);
  const onboard = fs.readFileSync(path.join(wt, '.relay', 'ONBOARD.md'), 'utf8');
  assert.ok(onboard.includes('强制自审'), '前任 zapp 为 weak，上岗词应含强制自审');
  assert.ok(onboard.includes('zapp'));
  const m = onboard.match(/自审基准 commit：`([0-9a-f]{7,40})`/);
  assert.ok(m, 'ONBOARD 应含自审基准 SHA');
  assert.notEqual(m[1], ck.checkpoint, '自审基准不能是刚打的检查点');
  assert.equal(m[1], session.baseCommit, '首次 handoff 后，上一段起点 = 主线基准');
  const diffNames = execFileSync('git', ['-C', wt, 'diff', `${m[1]}..HEAD`, '--name-only'], { encoding: 'utf8' });
  assert.ok(diffNames.includes('app.txt'), `对自审基准 diff 应看到 App 段改的文件：\n${diffNames}`);

  fs.rmSync(path.dirname(s.home), { recursive: true, force: true });
});

test('open --force：覆盖软锁写进 journal；打开命令失败时软锁自愈释放', () => {
  const s = mkScenario('force');
  setupInited(s);
  relay(s, ['agents', 'add', 'broken', '--kind', 'app', '--cmd', `false {{worktree}}`, '--tier', 'strong']);
  relay(s, ['start', 'force flow']);
  const session = findSession(s);
  assert.ok(session);
  const wt = session.worktree;
  const lockFile = path.join(wt, '.relay', 'session.lock');

  // 打开命令本身失败（false 退出 1）：不阻塞、软锁自愈释放、可重新 open
  const brokenOut = relay(s, ['open', 'broken'], true);
  assert.ok(brokenOut.includes('已释放软锁'), brokenOut);
  assert.ok(!fs.existsSync(lockFile), '打开失败后软锁应已释放');

  relay(s, ['open', 'zapp']);
  assert.ok(fs.existsSync(lockFile));

  // 再 open 默认拒绝；--force 覆盖成功且 journal 留痕
  assert.ok(relay(s, ['open', 'zapp'], true).includes('软锁'));
  const forced = relay(s, ['open', 'zapp', '--force']);
  assert.ok(forced.includes('覆盖'), forced);
  const zappOpens = readJournal(wt).filter((e) => e.type === 'open' && e.agent === 'zapp');
  assert.equal(zappOpens.length, 2);
  assert.equal((zappOpens[1] as { overrode?: string }).overrode, 'zapp', '第二次 open 应记录 overrode');

  // run --force 接管软锁同样留痕；cli 段结束后锁释放
  const runOut = relay(s, ['run', 'fake', '--force']);
  assert.ok(runOut.includes('覆盖'), runOut);
  const fakeRun = readJournal(wt).find((e) => e.type === 'run' && e.agent === 'fake') as { overrode?: string };
  assert.equal(fakeRun.overrode, 'zapp', 'run --force 应记录 overrode');
  assert.ok(!fs.existsSync(lockFile), 'cli run 结束后 pid 锁应释放');

  relay(s, ['handoff']);
  fs.rmSync(path.dirname(s.home), { recursive: true, force: true });
});

test('merge 遇 App 软锁：默认拒绝（主线无未交接文件、无副作用）；--force 才收尾并警告可能丢失', () => {
  const s = mkScenario('merge');
  relay(s, ['init']);
  const cfgPath = path.join(s.repo, '.relay', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
  (cfg as { gate: { command: string } }).gate.command = 'test -f app.txt';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  gitRepo(s, ['add', '-A']);
  gitRepo(s, ['commit', '-q', '-m', 'relay config']);
  relay(s, ['agents', 'add', 'fake', '--cmd', s.fakeAgent, '--tier', 'strong']);
  relay(s, ['agents', 'add', 'zapp', '--kind', 'app', '--cmd', `${s.opener} {{worktree}}`, '--tier', 'weak']);

  relay(s, ['start', 'merge with soft lock']);
  const session = findSession(s);
  assert.ok(session);
  relay(s, ['run', 'fake']);
  relay(s, ['handoff']);
  relay(s, ['open', 'zapp']); // handoff 后又开了 App（软锁重新出现）
  // App 段的未提交业务文件：没 handoff 就没 checkpoint，merge 一旦删 worktree 它就没了
  fs.writeFileSync(path.join(session.worktree, 'uncommitted-app.txt'), 'App 段未交接改动\n');

  // 默认拒绝：报软锁 + 提示先 handoff；主线无该文件、worktree/会话指针原样
  const refused = relay(s, ['merge'], true);
  assert.ok(refused.includes('软锁'), refused);
  assert.ok(refused.includes('relay handoff'), refused);
  assert.ok(!fs.existsSync(path.join(s.repo, 'app.txt')), '主线不得有业务文件');
  assert.ok(!fs.existsSync(path.join(s.repo, 'uncommitted-app.txt')), '主线不得有未交接文件');
  assert.ok(fs.existsSync(session.worktree), '被拒绝的 merge 不得删 worktree');
  assert.ok(fs.existsSync(path.join(session.worktree, '.relay', 'session.lock')), '被拒绝的 merge 不得清软锁');
  assert.ok(findSession(s), '被拒绝的 merge 不得清会话指针');

  // --force：收尾 + 明确警告可能丢失；问责链仍含 open 记录，未交接文件不进主线
  const forced = relay(s, ['merge', '--force']);
  assert.ok(forced.includes('未交接的未提交改动可能丢失'), forced);
  assert.ok(forced.includes('合并完成'), forced);
  assert.ok(!fs.existsSync(path.join(session.worktree, '.relay', 'session.lock')), 'worktree 已删，软锁随之清除');
  assert.equal(findSession(s), null);
  const body = gitRepo(s, ['log', '-1', '--format=%b']);
  assert.ok(body.includes('open zapp'), `问责链应含 open 记录：\n${body}`);
  assert.ok(fs.existsSync(path.join(s.repo, 'app.txt')));
  assert.ok(!fs.existsSync(path.join(s.repo, 'uncommitted-app.txt')), '未交接的未提交文件不得进主线');
  fs.rmSync(path.dirname(s.home), { recursive: true, force: true });
});

test('abandon 遇 App 软锁：默认拒绝（worktree 仍在、无副作用）；--force 才删除', () => {
  const s = mkScenario('abandon');
  setupInited(s);
  relay(s, ['start', 'abandon with soft lock']);
  const session = findSession(s);
  assert.ok(session);
  relay(s, ['open', 'zapp']);
  fs.writeFileSync(path.join(session.worktree, 'uncommitted-app.txt'), 'App 段未交接改动\n');
  const journalP = path.join(session.worktree, '.relay', 'journal.jsonl');
  const journalBefore = fs.readFileSync(journalP, 'utf8');

  // 默认拒绝：提示先 handoff 或明确 --force；worktree/软锁/会话指针/journal 全部原样
  const refused = relay(s, ['abandon'], true);
  assert.ok(refused.includes('relay handoff'), refused);
  assert.ok(refused.includes('--force'), refused);
  assert.ok(fs.existsSync(session.worktree), 'worktree 必须仍在');
  assert.ok(fs.existsSync(path.join(session.worktree, '.relay', 'session.lock')), '软锁必须仍在');
  assert.ok(findSession(s), '会话指针必须仍在');
  assert.equal(fs.readFileSync(journalP, 'utf8'), journalBefore, '被拒绝的 abandon 不得写 journal');

  // --force：警告 + 删 worktree（软锁随之清除）
  const forced = relay(s, ['abandon', '--force']);
  assert.ok(forced.includes('未交接的未提交改动可能丢失'), forced);
  assert.ok(forced.includes('已放弃任务'), forced);
  assert.ok(!fs.existsSync(session.worktree), 'worktree 应被删除（软锁随之清除）');
  assert.equal(findSession(s), null);
  fs.rmSync(path.dirname(s.home), { recursive: true, force: true });
});

test('open → handoff → merge：App 段先交接再合并，正常路径不受影响', () => {
  const s = mkScenario('flow');
  relay(s, ['init']);
  const cfgPath = path.join(s.repo, '.relay', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
  (cfg as { gate: { command: string } }).gate.command = 'test -f app.txt';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  gitRepo(s, ['add', '-A']);
  gitRepo(s, ['commit', '-q', '-m', 'relay config']);
  relay(s, ['agents', 'add', 'zapp', '--kind', 'app', '--cmd', `${s.opener} {{worktree}}`, '--tier', 'strong']);

  relay(s, ['start', 'app only flow']);
  const session = findSession(s);
  assert.ok(session);
  relay(s, ['open', 'zapp']);
  const lockFile = path.join(session.worktree, '.relay', 'session.lock');
  assert.ok(fs.existsSync(lockFile), 'open 后应有软锁');

  const h = relay(s, ['handoff']);
  assert.ok(h.includes('交接完成'), h);
  assert.ok(!fs.existsSync(lockFile), 'handoff 后软锁应清除');

  const m = relay(s, ['merge']);
  assert.ok(m.includes('合并完成'), m);
  assert.ok(!m.includes('未交接的未提交改动可能丢失'), '正常路径不应出现丢失警告');
  assert.ok(fs.existsSync(path.join(s.repo, 'app.txt')), '主线应有 app.txt');
  assert.equal(findSession(s), null);
  fs.rmSync(path.dirname(s.home), { recursive: true, force: true });
});
