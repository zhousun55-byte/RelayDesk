import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mockLlm, setOrder, withFakes } from './fakes';
import { sandbox, type Sandbox } from './helpers';

/**
 * 接力台 2.0 的端到端测试：接入 → 你自己在别的工具里干（接力台记账）→ 接力台调度 → 额度用完换人 →
 * 弱模型的活由强模型复核 → 终审 → 退回。全部用假的 claude（接 DeepSeek，弱）和 codex（gpt-6，强）。
 */

function prepared(name: string, extra: NodeJS.ProcessEnv = {}, opts: { git?: boolean } = {}): Sandbox {
  const s = sandbox(name, opts);
  withFakes(s, extra);
  s.relay(['detect', '--offline']);
  return s;
}

function handoff(s: Sandbox, file: string, who: string, state: string, did: string): void {
  s.write(`.relay/交接/${file}`, `# 交接：${who}\n\n- 状态：${state}\n\n## 做了什么\n\n- ${did}\n\n## 没做完 / 下一步\n\n- 接着做\n`);
}

test('自动识别：Claude Code 接的是 DeepSeek 算弱，Codex 是强；桌面程序不在的不加', () => {
  const s = prepared('detect');
  const reg = JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'agents.json'), 'utf8')) as { agents: { name: string; tier: string; harness?: string }[] };
  assert.deepEqual(
    reg.agents.map((a) => [a.name, a.harness, a.tier]),
    [
      ['claude', 'claude', 'weak'],
      ['codex', 'codex', 'strong'],
    ]
  );
  const out = s.relay(['detect', '--offline']);
  assert.match(out, /成员名单不用改/);
  assert.match(out, /强 Codex（gpt-6）/);
  assert.match(out, /弱 Claude Code（deepseek-v4-flash）/);
});

test('脱敏导出：任务、交接、账本、配置复制到空文件夹，密钥抹掉；不往有东西的文件夹、.relay 里面导', () => {
  const s = twoStints('export');
  const key = 'sk-' + 'abcdefghijklmnopqrstuvwx';
  handoff(s, 'x3.md', 'Codex · gpt-6', '已交接', `用了 ${key} 调接口`);
  const dest = path.join(s.base, '导出');
  assert.match(s.relay(['export', dest]), /导出了 \d+ 个文件/);
  for (const f of ['任务.md', 'config.json', 'journal.jsonl', '交接/x1.md', '交接/x3.md']) assert.ok(fs.existsSync(path.join(dest, f)), f);
  assert.ok(!fs.existsSync(path.join(dest, 'snapshots')), '快照不导');
  const x3 = fs.readFileSync(path.join(dest, '交接', 'x3.md'), 'utf8');
  assert.ok(!x3.includes(key) && x3.includes('[REDACTED]'));
  assert.match(s.relay(['export', dest], true), /已经有东西了/);
  assert.match(s.relay(['export', path.join(s.repo, '.relay', 'out')], true), /不能导出到 \.relay 里面/);
});

test('接入：.relay 默认只有配置进 git，任务、交接、账本不进；旧版本没改过的默认规则换成新的，改过的不动', () => {
  const s = sandbox('init-git');
  s.relay(['init', '做一个']);
  handoff(s, 'x1.md', 'Codex · gpt-6', '已交接', '写了 a');
  const tracked = s.git(['status', '--porcelain', '--untracked-files=all']).split('\n').map((l) => l.slice(3)).filter((f) => f.startsWith('.relay/'));
  assert.deepEqual(tracked.sort(), ['.relay/.gitignore', '.relay/config.json']);
  const old = ['# 接力台自己的数据，不进你的 git（任务、交接、复核、账本想提交就提交）', 'snapshots/', 'runs/', '接力本.md', '复核/*.diff', 'talk*.jsonl', '*.tmp', '*.lock', ''].join('\n');
  s.write('.relay/.gitignore', old);
  s.relay(['init']);
  assert.match(s.read('.relay/.gitignore'), /^\*$/m, '没改过的旧规则换掉');
  s.write('.relay/.gitignore', old + '!交接/\n');
  s.relay(['init']);
  assert.match(s.read('.relay/.gitignore'), /!交接\//, '改过的不动');
});

test('接入：建好 .relay、写规矩、存第一张快照；不需要 git；重复接入不重复', () => {
  const s = sandbox('init', { git: false });
  const out = s.relay(['init', '做一个', '滤镜']);
  assert.match(out, /接入了/);
  for (const f of ['.relay/接力本.md', '.relay/任务.md', '.relay/config.json', '.relay/journal.jsonl', '.relay/.gitignore', '.relay/snapshots/HEAD', 'AGENTS.md', 'CLAUDE.md']) assert.ok(s.exists(f), f);
  assert.ok(!s.exists('.git'), '没有给你建 git');
  assert.match(s.read('.relay/任务.md'), /做一个 滤镜/);
  assert.match(s.read('AGENTS.md'), /开工先读 `\.relay\/接力本\.md`/);
  const brief = s.read('.relay/接力本.md');
  assert.match(brief, /做一个 滤镜/);
  assert.match(brief, /第1棒-月日-时分-你的工具名\.md/);
  assert.equal(s.journal().filter((e) => e.type === 'init').length, 1);
  assert.match(s.relay(['init']), /已经接入过了/);
  assert.equal(s.journal().filter((e) => e.type === 'init').length, 1);
  assert.match(s.relay(['status']), /任务：做一个 滤镜/);
});

test('你自己在别的工具里接着做：接力台认出是谁、弱模型的棒标待复核、强模型写了复核就算复核过', () => {
  const s = prepared('native');
  s.relay(['init', '做滤镜']);
  // DeepSeek（在 Claude Code 里）干了一段，写了交接
  s.write('filter.xmp', '<x/>\n');
  handoff(s, '第1棒-0924-2100-claude.md', 'Claude Code · deepseek-v4-flash', '已交接', '写了 filter.xmp');
  s.relay(['snap']);
  let st = s.stints();
  assert.equal(st.length, 1);
  assert.equal(st[0].who.member, 'claude');
  assert.equal(st[0].who.tier, 'weak');
  assert.equal(st[0].status, 'handed');
  assert.equal(st[0].review, 'needed');
  assert.deepEqual(st[0].facts.paths, ['filter.xmp']);
  assert.match(s.read('.relay/复核/第1棒.diff'), /\+<x\/>/);
  const brief = s.read('.relay/接力本.md');
  assert.match(brief, /## 先复核（1 棒待复核）/);
  assert.match(brief, /第2棒-月日-时分-你的工具名\.md/);

  // Codex（强）来了：先复核、修了一处，再交接
  s.write('filter.xmp', '<x fixed="1"/>\n');
  s.write('.relay/复核/第1棒.md', '# 复核：第 1 棒\n\n- 复核人：Codex · gpt-6\n- 结论：有问题，已修好\n\n## 发现的问题和怎么处理的\n\n- 少了属性，补上了\n');
  handoff(s, '第2棒-0924-2200-codex.md', 'Codex · gpt-6', '已交接', '复核了第 1 棒，修了 filter.xmp');
  s.relay(['snap']);
  st = s.stints();
  assert.equal(st[0].review, 'done');
  assert.equal(st[0].reviews[0].verdict, 'fixed');
  assert.equal(st[1].who.member, 'codex');
  assert.equal(st[1].review, 'skip', '强模型自己交接的不用复核');
  assert.doesNotMatch(s.read('.relay/接力本.md'), /先复核/);
  assert.match(s.relay(['status']), /复核：有问题，已修好/);
});

test('额度用完被打断、没留交接：一段时间没动静后接力台替它记一笔，要复核', () => {
  const s = prepared('cutoff', { RELAY_QUIET_MS: '1' });
  s.relay(['init', '做滤镜']);
  s.write('half.txt', '写到一半\n');
  s.relay(['snap']);
  s.relay(['snap']);
  const st = s.stints();
  assert.equal(st.length, 1);
  assert.equal(st[0].status, 'unfinished');
  assert.equal(st[0].ghost, true);
  assert.equal(st[0].who.tier, 'unknown');
  assert.equal(st[0].review, 'needed');
  assert.match(s.read(st[0].handoff), /接力台代写/);
  assert.match(s.read(st[0].handoff), /half\.txt/);
  assert.match(s.read('.relay/接力本.md'), /它没留交接/);
});

test('接力台调度一棒：弱模型干完标待复核；relay review 派强模型复核', () => {
  const s = prepared('go');
  s.relay(['init']);
  s.relay(['task', '做两件事', '--step', '第一件', '第二件']);
  const out = s.relay(['go', 'claude']);
  assert.match(out, /✓ 第 1 棒（DeepSeek V4 Flash）已交接：.+；待复核$/m);
  let st = s.stints();
  assert.equal(st.length, 1);
  assert.equal(st[0].via, 'relay');
  assert.equal(st[0].who.member, 'claude');
  assert.equal(st[0].review, 'needed');
  assert.equal(s.read('work.txt'), 'claude 干了一步\n');
  assert.match(s.read('.relay/任务.md'), /- \[x\] 第一件/);
  assert.match(s.read(st[0].handoff), /Claude Code · deepseek-v4-flash/);
  // 真的按无人值守的参数、在项目文件夹里调的
  const log = fs.readFileSync(s.env.FAKE_LOG!, 'utf8');
  assert.match(log, /claude -p --output-format stream-json --verbose --permission-mode acceptEdits --settings/);

  s.relay(['review']);
  st = s.stints();
  assert.equal(st.length, 2);
  assert.equal(st[1].kind, 'review');
  assert.equal(st[1].who.member, 'codex', '复核自动挑强模型');
  assert.equal(st[0].review, 'done');
  assert.match(fs.readFileSync(s.env.FAKE_LOG!, 'utf8'), /codex exec --skip-git-repo-check --color never -C .* -s workspace-write -/);
});

test('全自动：弱模型干一棒 → 强模型复核 → 再干 → 再复核 → 强模型终审 → 完成，全程不用人动手', () => {
  const s = prepared('auto');
  setOrder(s, ['claude', 'codex']);
  s.relay(['init']);
  s.relay(['task', '做两件事', '--step', '第一件', '第二件']);
  const out = s.relay(['auto']);
  assert.match(out, /✓ 验收通过：清单 2\/2 全部打勾，GPT-6 终审过了/);
  const st = s.stints();
  assert.deepEqual(
    st.map((x) => [x.kind, x.who.member]),
    [
      ['work', 'claude'],
      ['review', 'codex'],
      ['work', 'claude'],
      ['review', 'codex'],
      ['final', 'codex'],
    ]
  );
  assert.ok(st.filter((x) => x.kind === 'work').every((x) => x.review === 'done'), '弱模型的每一棒都复核过');
  assert.equal(s.read('work.txt'), 'claude 干了一步\nclaude 干了一步\n');
});

test('全自动：复核的那位实际跑的是弱模型，写的复核不算数；两次之后停下，说清楚是「算弱不算数」', () => {
  const s = prepared('weak-reviewer', { FAKE_CLAUDE_OFFICIAL: 'pro', FAKE_CLAUDE_OFFICIAL_MODEL: 'deepseek-flash' });
  setOrder(s, ['claude', 'claude-official']);
  s.relay(['init']);
  s.relay(['task', '做一件事', '--step', '第一件']);
  const out = s.relay(['auto']);
  assert.match(out, /全自动停止：第 1 棒复核两次都不算数，写复核的都是弱模型/);
  const st = s.stints();
  assert.deepEqual(
    st.map((x) => [x.kind, x.who.member, x.who.tier]),
    [
      ['work', 'claude', 'weak'],
      ['review', 'claude-official', 'weak'],
      ['review', 'claude-official', 'weak'],
    ]
  );
  assert.equal(st[0].review, 'needed');
});

test('全自动：终审没做成，不说「终审过了」，停下来说清楚', () => {
  const s = prepared('final-fail', { FAKE_CODEX_MODE: 'final-fail' });
  setOrder(s, ['claude', 'codex']);
  s.relay(['init']);
  s.relay(['task', '做一件事', '--step', '第一件']);
  const out = s.relay(['auto']);
  assert.match(out, /全自动停止：清单都打勾了，终审出错（GPT-6，/);
  assert.doesNotMatch(out, /终审过了/);
  assert.deepEqual(
    s.stints().map((x) => [x.kind, x.who.member, x.status]),
    [
      ['work', 'claude', 'handed'],
      ['review', 'codex', 'handed'],
      ['final', 'codex', 'failed'],
    ]
  );
});

test('全自动的终审换一双眼睛：强模型自己干完的活，请另一位强模型终审', () => {
  const s = prepared('final-other', { FAKE_CLAUDE_OFFICIAL: 'pro' });
  setOrder(s, ['codex', 'claude-official', 'claude']);
  s.relay(['init']);
  s.relay(['task', '做一件事', '--step', '第一件']);
  s.relay(['auto']);
  assert.deepEqual(
    s.stints().map((x) => [x.kind, x.who.member]),
    [
      ['work', 'codex'],
      ['final', 'claude-official'],
    ]
  );
});

test('额度用完：记下什么时候恢复，自动换下一位接着做；下次调度跳过它', () => {
  const s = prepared('quota', { FAKE_CLAUDE_MODE: 'quota' });
  setOrder(s, ['claude', 'codex'], { finalReview: false });
  s.relay(['init']);
  s.relay(['task', '做一件事', '--step', '只有一件']);
  const out = s.relay(['auto']);
  assert.match(out, /✓ 验收通过/);
  const st = s.stints();
  assert.equal(st[0].who.member, 'claude');
  assert.equal(st[0].status, 'quota');
  assert.ok(st[0].quotaUntil, '记下了恢复时间');
  assert.equal(new Date(st[0].quotaUntil).getHours(), 15, '认出了「reset at 3pm」');
  assert.equal(st[1].who.member, 'codex');
  const q = JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'quota.json'), 'utf8'));
  assert.ok(q.members.claude.until);
  assert.match(s.relay(['detect', '--offline']), /额度用完/);
  // 再调度一棒：跳过还在等额度的 claude；指名它也先拦下，写清几点恢复；加 --force 照派
  s.relay(['task', '再做一件', '--step', 'x']);
  s.relay(['go']);
  assert.equal(s.stints().at(-1)!.who.member, 'codex');
  const n = s.stints().length;
  assert.match(s.relay(['go', 'claude'], true), /额度用完.*恢复；确定已经恢复了就加 --force/);
  assert.equal(s.stints().length, n, '没开新的一棒');
  s.env.FAKE_CLAUDE_MODE = 'work';
  s.relay(['go', 'claude', '--force']);
  assert.equal(s.stints().at(-1)!.who.member, 'claude');
});

test('断网：工具一直在报重连（Codex 断网时永远等下去），连着一阵只剩连不上服务器就停掉、记成出错，换下一位接着做', () => {
  const s = prepared('offline', { FAKE_CODEX_MODE: 'offline', RELAY_OFFLINE_MS: '1500' });
  s.relay(['init']);
  s.relay(['task', '做一件事', '--step', '只有一件']);
  const t0 = Date.now();
  const out = s.relay(['auto', '--no-wait']);
  assert.ok(Date.now() - t0 < 30_000, `${Date.now() - t0} 毫秒：没有一直等下去`);
  const st = s.stints();
  assert.deepEqual([st[0].who.member, st[0].status], ['codex', 'failed']);
  assert.match(st[0].note, /连不上服务器：\d+ 秒都在重连，已停止/);
  assert.deepEqual([st[1].who.member, st[1].status], ['claude', 'handed'], '换下一位接着做');
  assert.match(out, /全自动停止/);
  const q = JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'quota.json'), 'utf8'));
  assert.equal(q.errors.codex.n, 1, '记下它出过错：下一轮先派别人');
});

test('都没额度了又不等：停下交给你，说清楚原因', () => {
  const s = prepared('noquota', { FAKE_CLAUDE_MODE: 'quota', FAKE_CODEX_MODE: 'quota' });
  s.relay(['init']);
  s.relay(['task', '做一件事', '--step', 'x']);
  const out = s.relay(['auto', '--no-wait']);
  assert.match(out, /全自动停止：没有能派活的成员/);
  assert.deepEqual(
    s.stints().map((x) => [x.who.member, x.status]),
    [
      ['codex', 'quota'],
      ['claude', 'quota'],
    ]
  );
});

test('它没写交接就结束了：用它最后说的话代写一份，要复核', () => {
  const s = prepared('ghost', { FAKE_CODEX_MODE: 'nohandoff' });
  s.relay(['init']);
  s.relay(['task', '做', '--step', 'x']);
  s.relay(['go', 'codex']);
  const st = s.stints()[0];
  assert.equal(st.ghost, true);
  assert.equal(st.review, 'needed', '强模型没留交接也要复核');
  assert.match(s.read(st.handoff), /做完一步了/);
});

test('网络抖一下：原地再试一次接着做完', () => {
  const s = prepared('blip', { FAKE_CODEX_MODE: 'blip-once' });
  s.relay(['init']);
  s.relay(['task', '做', '--step', 'x']);
  s.relay(['go', 'codex']);
  const st = s.stints()[0];
  assert.equal(st.status, 'handed');
  assert.match(s.read(`.relay/runs/${path.basename(st.log)}`), /网络抖了一下/);
});

test('退回：整个文件夹恢复成第 N 棒之前，之后的棒作废；撤销退回又回来', () => {
  const s = prepared('rollback');
  s.relay(['init']);
  s.write('a.txt', '1\n');
  handoff(s, 'x1.md', 'Codex · gpt-6', '已交接', '写了 a');
  s.relay(['snap']);
  s.write('a.txt', '2\n');
  s.write('b/c.txt', '新的\n');
  handoff(s, 'x2.md', 'Claude Code · deepseek-v4-flash', '已交接', '改了 a，加了 c');
  s.relay(['snap']);
  assert.equal(s.stints().length, 2);
  const out = s.relay(['rollback', '2']);
  assert.match(out, /已退回到第 2 棒之前/);
  assert.equal(s.read('a.txt'), '1\n');
  assert.ok(!s.exists('b/c.txt'));
  assert.deepEqual(
    s.stints().map((x) => !!x.rolledBack),
    [false, true]
  );
  const brief = s.read('.relay/接力本.md');
  assert.match(brief, /退回到了「第 2 棒之前」/);
  assert.doesNotMatch(brief, /先复核/, '作废的棒不用复核');
  s.relay(['rollback', '--undo']);
  assert.equal(s.read('a.txt'), '2\n');
  assert.equal(s.read('b/c.txt'), '新的\n');
  assert.deepEqual(
    s.stints().map((x) => !!x.rolledBack),
    [false, false]
  );
});

/** 两棒：第 1 棒写 a=1，第 2 棒改 a=2、加 b/c.txt。 */
function twoStints(name: string): Sandbox {
  const s = prepared(name);
  s.relay(['init']);
  s.write('a.txt', '1\n');
  handoff(s, 'x1.md', 'Codex · gpt-6', '已交接', '写了 a');
  s.relay(['snap']);
  s.write('a.txt', '2\n');
  s.write('b/c.txt', '新的\n');
  handoff(s, 'x2.md', 'Claude Code · deepseek-v4-flash', '已交接', '改了 a，加了 c');
  s.relay(['snap']);
  return s;
}

test('退回、换任务拿着调度锁：别的进程在调度这个项目时不退回、不换任务，文件和任务都不动', () => {
  const s = twoStints('rollback-lock');
  const lock = path.join(s.repo, '.relay', 'runs', 'lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'other', at: new Date().toISOString() }));
  assert.match(s.relay(['rollback', '2'], true), /已经在调度这个项目/);
  assert.equal(s.read('a.txt'), '2\n');
  assert.ok(!s.stints().some((x) => x.rolledBack));
  const task = s.read('.relay/任务.md');
  assert.match(s.relay(['task', '换一件事'], true), /已经在调度这个项目/);
  assert.equal(s.read('.relay/任务.md'), task);
  fs.rmSync(lock);
  s.relay(['rollback', '2']);
  assert.equal(s.read('a.txt'), '1\n');
  assert.ok(!fs.existsSync(lock), '退回完锁放掉了');
});

test('退回后核对：删不掉的文件报出来、记进账本，不当作全退回了', { skip: process.getuid?.() === 0 }, () => {
  const s = twoStints('rollback-left');
  const dir = path.join(s.repo, 'b');
  fs.chmodSync(dir, 0o555);
  try {
    const out = s.relay(['rollback', '2']);
    assert.match(out, /1 个文件没能恢复.*b\/c\.txt/);
    assert.equal(s.read('a.txt'), '1\n', '别的文件照样退回');
    const rb = s.journal().filter((e) => e.type === 'rollback').pop()!;
    assert.deepEqual(rb.left, ['b/c.txt']);
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

/** 模拟退回做到一半进程没了：「退回前」那张存好、a.txt 已经改回去，还没记账本。 */
function crashedRollback(name: string): { s: Sandbox; head: string; mark: string } {
  const s = twoStints(name);
  const head = s.git(['--git-dir', path.join(s.repo, '.relay', 'snapshots'), 'rev-parse', 'HEAD']).trim();
  const mark = path.join(s.repo, '.relay', 'runs', 'rollback.json');
  fs.mkdirSync(path.dirname(mark), { recursive: true });
  fs.writeFileSync(mark, JSON.stringify({ pid: 2147483646, token: 't', ev: { ts: new Date().toISOString(), to: s.stints()[0].to, label: '第 2 棒之前', safety: head, dropped: [2], task: { unchecked: [], checked: [] } } }));
  s.write('a.txt', '1\n');
  return { s, head, mark };
}

test('退回做到一半进程没了：下次对账补记进账本，之后的棒算作废，撤销照样能回去', () => {
  const { s, head, mark } = crashedRollback('rollback-crash');
  s.relay(['snap']);
  assert.ok(!fs.existsSync(mark), '补记完记号删掉');
  const rb = s.journal().filter((e) => e.type === 'rollback').pop()!;
  assert.equal(rb.interrupted, true);
  assert.equal(rb.safety, head);
  assert.deepEqual(s.stints().map((x) => !!x.rolledBack), [false, true]);
  assert.equal(s.stints().length, 2, '改回去的 a.txt 不算成新的一棒');
  s.relay(['rollback', '--undo']);
  assert.equal(s.read('a.txt'), '2\n');
  assert.equal(s.read('b/c.txt'), '新的\n');
});

test('退回做到一半停了、没对过账就点撤销：撤销的是中途停了的那次，文件回到退回前', () => {
  const { s } = crashedRollback('rollback-crash-undo');
  s.relay(['rollback', '--undo']);
  assert.equal(s.read('a.txt'), '2\n');
  assert.equal(s.read('b/c.txt'), '新的\n');
  assert.deepEqual(s.stints().map((x) => !!x.rolledBack), [false, false]);
});

for (const git of [true, false]) {
  test(`只有接口的模型也能接一棒：内置小代理搜代码、写文件、写交接${git ? '' : '（项目不是 git 仓库）'}`, async () => {
    const s = prepared(git ? 'api' : 'api-plain', { MOCK_KEY: 'k-test' }, { git });
    s.relay(['init']);
    s.relay(['task', '写一条笔记', '--step', '写']);
    const mock = await mockLlm();
    try {
      s.relay(['workers', 'add', 'mock', '--kind', 'api', '--api-base', mock.url, '--api-model', 'mock-coder', '--api-key-env', 'MOCK_KEY']);
      const r = await s.relayAsync(['go', 'mock']);
      assert.equal(r.code, 0, r.out);
      assert.match(mock.toolResults[0], /^README\.md:1:demo$/m, '搜得到项目里的文件');
      assert.doesNotMatch(mock.toolResults[0], /\.relay\//, '不搜 .relay/');
      assert.equal(s.read('notes/llm.txt'), '模型写的\n');
      const st = s.stints()[0];
      assert.equal(st.who.member, 'mock');
      assert.equal(st.who.tier, 'weak');
      assert.equal(st.ghost, undefined, '它自己写了交接');
      assert.match(s.read(st.handoff), /写了 notes\/llm\.txt/);
    } finally {
      mock.close();
    }
  });
}

test('两个 Claude：接了 DeepSeek 的算弱、官方账号的算强；派官方账号时跳过你的设置、不带 ANTHROPIC_*，由它来复核', () => {
  const s = prepared('two-claude', { FAKE_CLAUDE_OFFICIAL: 'pro', ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'shell-token' });
  const reg = JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'agents.json'), 'utf8')) as { agents: { name: string; cmd?: string }[] };
  assert.deepEqual(
    reg.agents.map((a) => a.name),
    ['claude-official', 'claude', 'codex'],
    '按排序先后加：官方账号在前'
  );
  assert.match(reg.agents[0].cmd ?? '', /claude --settings \S+\/\.relay\/claude-official\.json$/, '你自己在终端里开官方账号的命令：盖掉接 DeepSeek 的设置');
  const over = JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'claude-official.json'), 'utf8'));
  assert.deepEqual([over.env.ANTHROPIC_BASE_URL, over.env.ANTHROPIC_AUTH_TOKEN, over.env.ANTHROPIC_MODEL], ['https://api.anthropic.com', '', ''], '那份设置里只有要盖掉的几项，没有密钥');
  s.relay(['workers', 'add', 'claude-app', '--kind', 'app', '--cmd', 'open -a Claude {{dir}}', '--label', 'Claude']);
  s.relay(['init']);
  s.relay(['task', '做两步', '--step', '第一步', '第二步']);
  const brief = s.read('.relay/接力本.md');
  assert.match(brief, /- 强：.*Claude Code 官方账号（opus）/);
  assert.match(brief, /- 强：.*Claude（opus）/, '桌面版借官方账号的模型');
  assert.match(brief, /- 弱：.*Claude Code（deepseek-v4-flash）/);

  s.relay(['go', 'claude']);
  assert.equal(s.stints()[0].who.member, 'claude');
  assert.equal(s.stints()[0].who.model, 'deepseek-v4-flash', '用回复里的模型名，不带 init 里的 [1m]');
  assert.equal(s.stints()[0].review, 'needed');
  assert.match(s.relay(['review', 'claude'], true), /不能复核：它算弱模型/);
  // 这台电脑上用过的 Opus：旧会话里是 claude-opus-5-5，最近一个会话是 claude-opus-5。派官方账号时按版本挑最新的。
  const logs = path.join(s.home, '.claude', 'projects', '-desk-');
  fs.mkdirSync(logs, { recursive: true });
  const said = (model: string) => `${JSON.stringify({ type: 'assistant', message: { model, content: [] }, timestamp: new Date().toISOString() })}\n`;
  fs.writeFileSync(path.join(logs, 'a.jsonl'), said('claude-opus-5-5'));
  fs.writeFileSync(path.join(logs, 'b.jsonl'), said('claude-opus-5'));
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(logs, 'a.jsonl'), past, past);
  s.relay(['review', 'claude-official']);
  const [first, second] = s.stints();
  assert.equal(second.who.member, 'claude-official');
  assert.equal(second.who.model, 'claude-opus-5-5', '记下工具报出来的实际模型');
  assert.equal(second.who.tier, 'strong');
  assert.equal(second.status, 'handed', '官方账号那一次没带 ANTHROPIC_* 变量，没被接到 DeepSeek');
  assert.equal(first.review, 'done');
  assert.match(first.reviews[0].byLabel, /^Claude Code 官方账号/, '复核人写认出来的身份，不写它自称的「Claude Code」');
  const calls = fs.readFileSync(path.join(s.base, 'fake.log'), 'utf8').trim().split('\n');
  const official = (l: string) => l.includes('"ANTHROPIC_BASE_URL":"https://api.anthropic.com"');
  assert.ok(calls.some((l) => l.startsWith('claude -p ') && official(l) && l.includes('--model claude-opus-5-5') && !l.includes('--setting-sources')), `用最新的 Opus，不用简称 opus（它不一定是最新版）；照常读用户设置\n${calls.join('\n')}`);
  assert.ok(calls.some((l) => l.startsWith('claude -p ') && !official(l)), '接 DeepSeek 的那位照常调用');

  // 官方账号额度用完（新版的原话）：记成额度用完，按提示里的时区记下恢复时间，不是「出错」。
  s.env.FAKE_CLAUDE_OFFICIAL_MODE = 'session-limit';
  assert.match(s.relay(['go', 'claude-official']), /额度用完.*3:50 恢复/);
  const third = s.stints()[2];
  assert.equal(third.status, 'quota');
  assert.equal(third.who.model, 'claude-opus-5-5', '没等到回复，只有开头报的简写 claude-opus-5：用调用时给的完整名字（不然卡片上一会儿 Opus 5、一会儿 Opus 5.5）');
  const q = JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'quota.json'), 'utf8')).members['claude-official'];
  const until = new Date(q.until);
  assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(until), '03:50');
  assert.ok(until.getTime() > Date.now() && until.getTime() - Date.now() <= 24 * 3600_000, '下一个 3:50');
  assert.equal(third.quotaUntil, q.until);

  // 命令行太旧、用不了最新的 Opus：当场换成 opus 再干，这一棒照样做完；记下来，下次直接用 opus，升级之后再换回来。
  fs.rmSync(path.join(s.home, '.relay', 'quota.json'));
  s.env.FAKE_CLAUDE_OFFICIAL_MODE = 'too-old';
  fs.writeFileSync(path.join(s.base, 'fake.log'), '');
  s.relay(['task', '再做一步', '--step', '第三步']);
  s.relay(['go', 'claude-official']);
  const fourth = s.stints()[3];
  assert.equal(fourth.status, 'handed', '换成 opus 之后做完了');
  const tries = fs.readFileSync(path.join(s.base, 'fake.log'), 'utf8').trim().split('\n').filter((l) => l.includes('"ANTHROPIC_BASE_URL":"https://api.anthropic.com"'));
  assert.deepEqual(
    tries.map((l) => l.match(/--model (\S+)/)?.[1]),
    ['claude-opus-5-5', 'opus']
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'cli-models.json'), 'utf8')), { 'claude-opus-5-5': '99.0.0' });
  const det = JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'detected.json'), 'utf8')).harnesses.find((h: { id: string }) => h.id === 'claude-official');
  assert.equal(det.model.model, 'opus', '名单上显示实际会用的');
  assert.match(det.note, /claude update/, '告诉你升级命令行就能用上');
  fs.writeFileSync(path.join(s.base, 'fake.log'), '');
  assert.match(s.relay(['talk', '说一句', '--ask', 'claude-official']), /Claude Opus：/, '署名是实际用的模型');
  const talkCalls = fs.readFileSync(path.join(s.base, 'fake.log'), 'utf8').trim().split('\n');
  assert.equal(talkCalls.length, 1, `记下来之后直接用 opus，不再先试一次：\n${talkCalls.join('\n')}`);
  assert.match(talkCalls[0], /--model opus/);
  // 群聊里第一次碰到：先试最新的被拒，换成 opus 再答；署名写答完之后实际用的。
  fs.rmSync(path.join(s.home, '.relay', 'cli-models.json'));
  s.relay(['detect', '--offline']);
  fs.writeFileSync(path.join(s.base, 'fake.log'), '');
  assert.match(s.relay(['talk', '再说一句', '--ask', 'claude-official']), /Claude Opus：claude 的看法/);
  assert.deepEqual(
    fs.readFileSync(path.join(s.base, 'fake.log'), 'utf8').trim().split('\n').map((l) => l.match(/--model (\S+)/)?.[1]),
    ['claude-opus-5-5', 'opus']
  );
});

test('你自己在各家工具里做的棒：拿 Claude Code 自己的记录核对——自称 Opus 的 DeepSeek 认得出来，它给自己写的复核不算数', () => {
  const s = prepared('claude-log', { FAKE_CLAUDE_OFFICIAL: 'pro' });
  s.relay(['init']);
  const logs = path.join(s.home, '.claude', 'projects', '-repo-');
  fs.mkdirSync(logs, { recursive: true });
  /** 假装 Claude Code 用某个模型改了一个文件：写文件，并在它的会话记录里记一笔。 */
  const edit = (model: string, entry: string, rel: string, text: string) => {
    s.write(rel, text);
    const row = { type: 'assistant', entrypoint: entry, message: { model, content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(s.repo, rel), content: text } }] }, timestamp: new Date().toISOString() };
    fs.appendFileSync(path.join(logs, `${entry}.jsonl`), JSON.stringify(row) + '\n');
  };
  const handoffText = (who: string, did: string) => `# 交接：${who}\n\n- 状态：已交接\n\n## 做了什么\n\n- ${did}\n`;

  // 终端里接了 DeepSeek 的 Claude Code 干了一棒，交接里却说自己是 Opus，还给自己写了复核「没问题」。
  edit('deepseek-v4-flash', 'cli', 'app.js', 'console.log(1)\n');
  edit('deepseek-v4-flash', 'cli', '.relay/交接/第1棒-0924-2100-claude.md', handoffText('Claude Code · Opus 5.5', '写了 app.js'));
  s.relay(['snap']);
  edit('deepseek-v4-flash', 'cli', '.relay/复核/第1棒.md', '# 复核：第 1 棒\n\n- 复核人：Claude Code · Opus 5.5\n- 结论：没问题\n');
  s.relay(['snap']);
  const one = s.stints()[0];
  assert.equal(one.who.member, 'claude', '以记录为准');
  assert.equal(one.who.tier, 'weak');
  assert.match(one.who.claimed, /Opus 5\.5/);
  assert.match(one.note, /Claude Code 的记录/);
  assert.equal(one.review, 'needed', '它给自己写的复核不算数');
  assert.equal(one.reviews[0].weak, true);
  assert.match(s.read('.relay/接力本.md'), /不算数/);

  // 桌面版的 Opus 接着做：复核第 1 棒、修好，再往下做。
  edit('claude-opus-5-5', 'claude-desktop', '.relay/复核/第1棒.md', '# 复核：第 1 棒\n\n- 复核人：Claude Code · Opus 5.5\n- 结论：有问题，已修好\n');
  edit('claude-opus-5-5', 'claude-desktop', 'app.js', 'console.log(2)\n');
  edit('claude-opus-5-5', 'claude-desktop', '.relay/交接/第2棒-0924-2200-claude.md', handoffText('Claude Code · Opus 5.5', '复核了第 1 棒，修了 app.js'));
  s.relay(['snap']);
  const [first, second] = s.stints();
  assert.equal(first.review, 'done');
  assert.equal(first.reviews.at(-1).verdict, 'fixed');
  assert.equal(second.who.member, 'claude-official');
  assert.equal(second.who.model, 'claude-opus-5-5', '模型名换成记录里的准确写法');
  assert.equal(second.review, 'skip', '强模型自己交接的，不用复核');
});

test('群聊：讨论（轮流说）、对比（同时答）；投票不投自己，一个 AI 一票', async () => {
  const s = prepared('talk');
  s.relay(['init', '做滤镜']);
  const t1 = s.relay(['talk', '先做哪个？', '--ask', 'claude,codex']);
  assert.match(t1, /DeepSeek V4 Flash：claude 的看法：同意/, '署名是它实际用的模型（Claude Code 接的是 DeepSeek）');
  const t2 = s.relay(['talk', '各自说说', '--ask', 'claude,codex', '--solo']);
  assert.match(t2, /claude 独立想了想/);
  assert.match(t2, /codex 独立想了想/);
  const v = s.relay(['vote', '用什么格式导出？', '--ask', 'claude,codex']);
  assert.match(v, /方案 A/);
  assert.match(v, /方案 B/);
  assert.doesNotMatch(v, /弃权/, '都没投自己');
  const votes = fs
    .readFileSync(path.join(s.repo, '.relay', 'talk.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('"vote"'))
    .map((l) => JSON.parse(l));
  const last = votes.at(-1);
  assert.equal(last.status, 'done');
  assert.equal(last.ballots.length, 2);
  for (const b of last.ballots) assert.notEqual(last.options.find((o: { key: string }) => o.key === b.choice).author, b.voter, '不投自己');
});

test('派活（边做边复核关着）：强模型先拆成小步，弱模型一棒做一步，中途不复核，做完后终审一起复核；强模型一直没干活；每一棒记下 token 用量', () => {
  const s = prepared('dispatch');
  setOrder(s, ['claude', 'codex'], { sideReview: false });
  s.relay(['init']);
  s.relay(['task', '--dispatch', '做一件大事']);
  assert.match(s.relay(['status']), /任务（派活）：做一件大事/);
  const out = s.relay(['auto']);
  assert.match(out, /✓ 验收通过：清单 4\/4 全部打勾/);
  assert.deepEqual(
    s.stints().map((x) => [x.kind, x.who.member]),
    [
      ['plan', 'codex'],
      ['work', 'claude'],
      ['work', 'claude'],
      ['work', 'claude'],
      ['work', 'claude'],
      ['final', 'codex'],
    ]
  );
  const merged = s.stints();
  assert.deepEqual(merged[5].targets, [2, 3, 4, 5], '弱模型的棒都并进终审一起复核');
  // 终审只写一份结论，接力台记到这几棒上（逐棒写复核最费强模型）
  assert.deepEqual(fs.readdirSync(path.join(s.repo, '.relay/复核')).filter((f) => f.endsWith('.md')), [path.basename(merged[5].reviewFile)]);
  assert.ok(merged.filter((x) => x.kind === 'work').every((x) => x.review === 'done' && x.reviews.at(-1).file === merged[5].reviewFile));
  const finalPrompt = fs
    .readdirSync(s.base)
    .filter((f) => f.startsWith('prompt-codex-'))
    .map((f) => fs.readFileSync(path.join(s.base, f), 'utf8'))
    .find((p) => p.includes('派来做终审'));
  assert.match(finalPrompt ?? '', /由你一起复核：第 2 棒、第 3 棒、第 4 棒、第 5 棒。不用逐棒读交接、逐棒写结论/);
  const prompts = fs
    .readdirSync(s.base)
    .filter((f) => f.startsWith('prompt-claude-'))
    .map((f) => fs.readFileSync(path.join(s.base, f), 'utf8'));
  assert.ok(prompts.some((p) => p.includes('这一棒只做任务清单里的第 1 步：「建 a.txt」')), '弱模型只拿到一步（步骤自己写的「第一步：」去掉）');
  assert.ok(prompts.some((p) => p.includes('第 4 步：「建 d.txt」')));
  assert.equal(s.stints()[1].step.text, '建 a.txt');
  const st = s.stints();
  assert.deepEqual(st[0].tokens, { input: 300, output: 40 }, 'Codex 拆解：每一轮报的用量');
  assert.deepEqual(st[1].tokens, { input: 100, output: 20 }, 'Claude Code 干活：结束时报的用量');
});

test('派活指定谁指挥、活派给谁：同一个工具的大模型拆和终审、小模型一步步做（MiMo Pro 派给 MiMo Flash 这种）；排在前面的弱模型不派', () => {
  const s = prepared('dispatch-crew');
  const file = path.join(s.home, '.relay', 'agents.json');
  const reg = JSON.parse(fs.readFileSync(file, 'utf8')) as { agents: Record<string, unknown>[] };
  const codex = reg.agents.find((a) => a.name === 'codex')!;
  reg.agents.push({ ...codex, name: 'codex-mini', model: 'gpt-6-mini', tier: 'weak' });
  codex.crew = 'codex-mini';
  fs.writeFileSync(file, JSON.stringify(reg));
  setOrder(s, ['claude', 'codex', 'codex-mini'], { lead: 'codex' });
  s.relay(['init']);
  s.relay(['task', '--dispatch', '做一件大事']);
  const out = s.relay(['auto']);
  assert.match(out, /✓ 验收通过：清单 4\/4 全部打勾/);
  const st = s.stints();
  assert.deepEqual(
    st.filter((x) => x.kind !== 'review').map((x) => [x.kind, x.who.member]),
    [
      ['plan', 'codex'],
      ['work', 'codex-mini'],
      ['work', 'codex-mini'],
      ['work', 'codex-mini'],
      ['work', 'codex-mini'],
      ['final', 'codex'],
    ],
    '弱模型 claude 排在最前也不派：活给指挥配的那位'
  );
  // 边做边复核（默认开）：指挥的那位只看不改地复核做完的几棒，和下一棒干活同时跑；快照不动、不算改了文件
  const side = st.filter((x) => x.kind === 'review');
  assert.ok(side.length >= 1 && side.every((x) => x.who.member === 'codex' && x.from === x.to && x.status === 'handed'), JSON.stringify(side));
  const works = st.filter((x) => x.kind === 'work');
  assert.ok(
    side.some((r) => works.some((w) => !(r.targets ?? []).includes(w.id) && Date.parse(w.startedAt) >= Date.parse(r.startedAt) && Date.parse(w.startedAt) <= Date.parse(r.endedAt!))),
    '复核的同时下一棒在干活'
  );
  assert.ok(works.every((w) => w.review === 'done'), '每一棒都复核过了');
  const covered = new Set(side.flatMap((r) => r.targets ?? []));
  assert.ok(works.slice(0, -1).every((w) => covered.has(w.id)), '除了最后一棒（可能并进终审），都是边做边复核的');
  assert.match(fs.readFileSync(path.join(s.repo, '.relay', '复核', `第${works[0].id}棒.md`), 'utf8'), /- 复核人：Codex[\s\S]*- 结论：没问题/, '接力台代写的复核文件');
  const sidePrompt = fs
    .readdirSync(s.base)
    .filter((f) => f.startsWith('prompt-codex-'))
    .map((f) => fs.readFileSync(path.join(s.base, f), 'utf8'))
    .find((p) => p.includes('派来边做边复核'));
  assert.match(sidePrompt ?? '', /这一棒只看不改/);
  const runs = fs.readFileSync(s.env.FAKE_LOG!, 'utf8').split('\n').filter((l) => l.startsWith('codex exec'));
  assert.equal(runs.filter((l) => / -m gpt-6-mini /.test(l)).length, 4, '做活的四棒用小模型');
  assert.ok(runs.filter((l) => / -s read-only /.test(l)).length >= 1, '边做边复核用只读模式');
  assert.equal(runs.filter((l) => !/ -m /.test(l) && !/ -s read-only /.test(l)).length, 2, '拆和终审用它自己的模型');
});

test('派活时干活的那位临时出错（连不上）：先原地再派它一次，不马上换人；下一棒日志开头写着原因', () => {
  const s = prepared('dispatch-retry', { FAKE_CLAUDE_MODE: 'blip-twice' });
  // 还有一位弱模型排在后面：刚出过错的会被排到它后面，按顺序挑就换人了——要点名再派原来那位
  const file = path.join(s.home, '.relay', 'agents.json');
  const reg = JSON.parse(fs.readFileSync(file, 'utf8')) as { agents: Record<string, unknown>[] };
  reg.agents.push({ ...reg.agents.find((a) => a.name === 'claude')!, name: 'claude-b', model: 'deepseek-v4-pro', tier: 'weak', tierSet: true });
  fs.writeFileSync(file, JSON.stringify(reg));
  setOrder(s, ['claude', 'claude-b', 'codex']);
  s.relay(['init']);
  s.relay(['task', '--dispatch', '做一件大事']);
  assert.match(s.relay(['auto']), /✓ 验收通过/);
  const works = s.stints().filter((x) => x.kind === 'work');
  assert.deepEqual(works.slice(0, 2).map((x) => [x.who.member, x.status]), [['claude', 'failed'], ['claude', 'handed']], '还是它，不换成别人');
  assert.match(s.read(works[1].log), /接手原因：上一棒出错（.*ECONNRESET.*），像是临时的，原地再来一次/);
  assert.ok(works.every((x) => x.who.member !== 'codex'), '强模型没干活');
});

test('派活边做边复核查出问题：清单里下一步前面插一步「按复核改好」，干活的人接着就改；改完的那一棒也复核', () => {
  const s = prepared('dispatch-fix', { FAKE_SIDE_BAD_ONCE: '1' });
  setOrder(s, ['claude', 'codex']);
  s.relay(['init']);
  s.relay(['task', '--dispatch', '做一件大事']);
  const out = s.relay(['auto']);
  assert.match(out, /✓ 验收通过：清单 5\/5 全部打勾/);
  const task = s.read('.relay/任务.md');
  const fix = task.match(/- \[x\] 按复核改好第 (\d+) 棒复核里指出的问题/);
  assert.ok(fix, task);
  const st = s.stints();
  const bad = st.find((x) => x.id === Number(fix![1]))!;
  assert.equal(bad.reviews?.[0]?.verdict, 'problem');
  assert.equal(bad.review, 'done', '最后终审一起过了');
  const fixer = st.find((x) => x.kind === 'work' && x.step?.text.startsWith('按复核改好'))!;
  assert.equal(fixer.who.member, 'claude', '改问题的也是干活的弱模型');
  assert.ok(fixer.id > bad.id);
  assert.ok(st.every((x) => x.kind !== 'work' || x.who.member === 'claude'), '强模型一直没干活');
});

test('接着同一段对话：打开时同一个任务里一位成员下一棒接着自己上一棒在工具里的那段对话（codex exec resume、claude --resume）；关着每棒新开；每棒记下对话编号', () => {
  const s = prepared('same-thread');
  setOrder(s, ['codex', 'claude'], { sameThread: true });
  s.relay(['init']);
  s.relay(['task', '做几件事', '--step', '甲', '乙', '丙', '丁']);
  s.relay(['go', 'codex']);
  s.relay(['go', 'codex']);
  s.relay(['go', 'claude']);
  s.relay(['go', 'claude']);
  const st = s.stints();
  assert.deepEqual(
    st.map((x) => [x.who.member, x.session?.tool, /^fake-/.test(x.session?.id ?? '')]),
    [
      ['codex', 'codex', true],
      ['codex', 'codex', true],
      ['claude', 'claude', true],
      ['claude', 'claude', true],
    ]
  );
  assert.equal(st[1].session?.id, st[0].session?.id, 'Codex 第二棒接着第一棒那段');
  assert.equal(st[3].session?.id, st[2].session?.id, 'Claude Code 第二棒接着第一棒那段');
  const log = fs.readFileSync(s.env.FAKE_LOG!, 'utf8').split('\n');
  assert.ok(log.some((l) => l.startsWith('codex exec resume ') && l.endsWith(` ${st[0].session?.id} -`)), log.join('\n'));
  assert.ok(log.some((l) => l.startsWith('claude -p ') && l.includes(`--resume ${st[2].session?.id}`)));

  // 关掉：每棒新开
  setOrder(s, ['codex', 'claude']);
  s.relay(['go', 'codex']);
  const last = s.stints().at(-1)!;
  assert.notEqual(last.session?.id, st[0].session?.id);
  // 换了任务：不接上一个任务的对话
  setOrder(s, ['codex', 'claude'], { sameThread: true });
  s.relay(['task', '换个任务', '--step', '戊']);
  s.relay(['go', 'codex']);
  assert.ok(![st[0].session?.id, last.session?.id].includes(s.stints().at(-1)!.session?.id), '新任务新开一段');
});

test('任务里写了 /技能名：派出去的这一棒开工说明后面附上这个技能的做法（派给谁都照着做）', () => {
  const s = prepared('skill-note');
  const dir = path.join(s.repo, '.agents', 'skills', 'demo-skill');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: demo-skill\ndescription: 演示\n---\n\n先写测试再写代码。\n');
  s.relay(['init']);
  s.relay(['task', '做一件事 /demo-skill', '--step', '第一件']);
  s.relay(['go', 'claude']);
  const prompts = fs.readdirSync(s.base).filter((f) => f.startsWith('prompt-claude-')).map((f) => fs.readFileSync(path.join(s.base, f), 'utf8'));
  assert.ok(prompts.some((p) => p.includes('技能「demo-skill」') && p.includes('先写测试再写代码。')), prompts.join('\n---\n').slice(-2000));
});

test('派活：弱模型出错、没有别的弱模型时停下，写明每位弱模型怎么了；不换强模型干活', () => {
  const s = prepared('dispatch-noweak', { FAKE_CLAUDE_MODE: 'fail' });
  setOrder(s, ['claude', 'codex']);
  s.relay(['init']);
  const out = s.relay(['auto', '--dispatch', '--no-wait', '做一件大事']);
  assert.match(out, /全自动停止：没有能用的弱模型：.+这次出错或做不下去/);
  assert.deepEqual(
    s.stints().map((x) => [x.kind, x.who.member]),
    [
      ['plan', 'codex'],
      ['work', 'claude'],
    ]
  );
});

test('派活的任务指定一位弱模型只做一棒：它只拿到清单里的下一步；接力的任务照旧', () => {
  const s = prepared('dispatch-once');
  setOrder(s, ['claude', 'codex']);
  s.relay(['init']);
  s.relay(['task', '--dispatch', '做两件事', '--step', '甲', '乙']);
  s.relay(['go', 'claude']);
  const latest = () => {
    const f = fs.readdirSync(s.base).filter((x) => x.startsWith('prompt-claude-')).map((x) => path.join(s.base, x));
    return fs.readFileSync(f.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0], 'utf8');
  };
  assert.match(latest(), /这一棒只做任务清单里的第 1 步：「甲」/);
  s.relay(['task', '做两件事', '--step', '甲', '乙']);
  s.relay(['go', 'claude']);
  assert.doesNotMatch(latest(), /这一棒只做/);
});

test('全自动 --no-final：这一次清单打完不终审，强模型做完就验收通过', () => {
  const s = prepared('no-final');
  setOrder(s, ['codex', 'claude']);
  s.relay(['init']);
  s.relay(['task', '做一件事', '--step', '第一件']);
  const out = s.relay(['auto', '--no-final']);
  assert.match(out, /✓ 验收通过/);
  assert.deepEqual(
    s.stints().map((x) => [x.kind, x.who.member]),
    [['work', 'codex']]
  );
});

test('派活一棒只做一步：全自动上限比步数少时，按步数的两倍算，不停在半路', () => {
  const s = prepared('dispatch-cap');
  setOrder(s, ['claude', 'codex'], { maxStints: 2 });
  s.relay(['init']);
  s.relay(['task', '--dispatch', '做一件大事']);
  const out = s.relay(['auto']);
  assert.match(out, /✓ 验收通过：清单 4\/4 全部打勾/);
  assert.equal(s.stints().filter((x) => x.kind === 'work').length, 4);
});
