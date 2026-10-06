import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockLlm } from './fakes';

/**
 * 2026-09-25 全项目自查找出的问题（每一条都是当时在临时目录里复现过的反例）：
 * 复核记错了人、只打勾的弱模型不用复核、账本坏行被悄悄跳过、检查命令写的文件被当成有人在改、
 * 投票时人的一票被盖掉、讨论命令带出宿主的会话变量、汉字被切开变乱码、找工具卡住整个接力台、上次留下的工具……
 */

// 这个文件里的测试不碰你真实的家目录（会话记录、接力台的数据）。
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-selfcheck-home-')));
process.env.HOME = HOME;
process.env.RELAY_HOME = path.join(HOME, '.relay');
process.env.RELAY_SCAN_APPS = 'off';
process.env.RELAY_LOGIN_PATH = 'off';
process.env.RELAY_AUTODETECT = 'off';
fs.mkdirSync(process.env.RELAY_HOME, { recursive: true });

/* eslint-disable @typescript-eslint/no-require-imports */
const { acceptance } = require('../src/core/acceptance') as typeof import('../src/core/acceptance');
const ledger = require('../src/core/ledger') as typeof import('../src/core/ledger');
const notes = require('../src/core/notes') as typeof import('../src/core/notes');
const track = require('../src/ops/track') as typeof import('../src/ops/track');
const view = require('../src/ops/view') as typeof import('../src/ops/view');
const init = require('../src/ops/init') as typeof import('../src/ops/init');
const talkMod = require('../src/core/talk') as Record<string, unknown>;
const talk = talkMod as unknown as typeof import('../src/core/talk');
const vote = require('../src/core/vote') as typeof import('../src/core/vote');
const runner = require('../src/core/runner') as typeof import('../src/core/runner');
const harness = require('../src/core/harness') as typeof import('../src/core/harness');
const members = require('../src/core/members') as typeof import('../src/core/members');
const tier = require('../src/core/tier') as typeof import('../src/core/tier');
const detect = require('../src/core/detect') as typeof import('../src/core/detect');
const files = require('../src/core/files') as typeof import('../src/core/files');
const go = require('../src/ops/go') as typeof import('../src/ops/go');
const config = require('../src/core/config') as typeof import('../src/core/config');
/* eslint-enable @typescript-eslint/no-require-imports */

function tmpDir(name: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-${name}-`)));
}

/** 换一份工人名单（这个文件里的测试一个接一个跑）。 */
function registry(agents: Record<string, unknown>[]): void {
  fs.writeFileSync(path.join(process.env.RELAY_HOME!, 'agents.json'), JSON.stringify({ agents }));
  fs.rmSync(path.join(process.env.RELAY_HOME!, 'detected.json'), { force: true });
}

const CODEX = { name: 'codex', label: 'Codex', kind: 'cli', cmd: 'codex', tier: 'strong', model: 'gpt-6-astra', harness: 'codex' };
const DSH = { name: 'deepseek-harness', label: 'DeepSeek Harness', kind: 'cli', cmd: 'dsh', tier: 'weak', model: 'deepseek-flash', harness: 'dsh' };

/** 接入一个项目（写好任务），返回写文件的小工具。 */
function project(name: string, task = '写一个 a.txt', steps: string[] = []): { root: string; write: (rel: string, text: string) => void } {
  const root = tmpDir(name);
  fs.writeFileSync(path.join(root, 'README.md'), 'demo\n');
  init.initProject(root);
  notes.setTask(root, task, steps);
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  return { root, write };
}

const handoff = (who: string, tool: string, model: string, state = '已交接') => `# 交接：${who}\n\n- 工具：${tool}\n- 模型：${model}\n- 状态：${state}\n\n## 做了什么\n\n- 改了文件\n`;
const review = (id: number, by: string, verdict: string) => `# 复核：第 ${id} 棒\n\n- 复核人：${by}\n- 结论：${verdict}\n\n## 发现的问题和怎么处理的\n\n- a.txt 看过了\n`;

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 把文件的修改时间改成 ms（模拟「几分钟之后才有人改了它」）。 */
function touchAt(file: string, ms: number): void {
  fs.utimesSync(file, new Date(ms), new Date(ms));
}

test('复核算谁的：按复核文件改动的时间对是哪一棒写的。没人在做的时候写的认不出是谁、不算数；后来改掉强模型的结论，原来的结论还在；复核人写的是弱模型也不算', () => {
  registry([CODEX, DSH]);
  const { root, write } = project('who-reviewed');
  const stint = (id: number) => ledger.loadLedger(root).stints.find((s) => s.id === id)!;
  // 第 1 棒：弱模型干活；第 2 棒：Codex（强）干别的活，交接完了
  write('.relay/交接/第1棒-0925-1000-dsh.md', handoff('DeepSeek Harness · deepseek-flash', 'DeepSeek Harness', 'deepseek-flash'));
  write('a.txt', 'weak\n');
  track.track(root);
  write('.relay/交接/第2棒-0925-1010-codex.md', handoff('Codex · gpt-6-astra', 'Codex', 'gpt-6-astra'));
  write('b.txt', 'strong\n');
  track.track(root);
  assert.equal(stint(1).review, 'needed');
  assert.equal(stint(2).review, 'skip');

  // 反例：几分钟后没有哪一棒在做，弱模型（在自己的工具里）写了一份「没问题」——以前会记成第 2 棒（Codex）复核过
  const later = Date.now() + 5 * 60_000;
  write('.relay/复核/第1棒.md', review(1, 'DeepSeek Harness · deepseek-flash', '没问题'));
  touchAt(path.join(root, '.relay/复核/第1棒.md'), later);
  track.track(root, { now: new Date(later + 60_000) });
  assert.equal(stint(1).review, 'needed', '认不出是谁写的复核不算数');
  assert.equal(stint(1).reviews?.at(-1)?.anon, true);
  assert.equal(stint(1).reviews?.at(-1)?.by, 0);
  assert.match(acceptance({ ledger: ledger.loadLedger(root), task: notes.readTask(root), gateCommand: '', finalRequired: false }).items.map((i) => i.text).join('；'), /认不出复核是谁写的/);

  // 强模型在自己那一棒里复核（先建交接再写结论）：算数
  write('.relay/交接/第3棒-0925-1030-codex.md', handoff('Codex · gpt-6-astra', 'Codex', 'gpt-6-astra', '进行中'));
  track.track(root);
  sleepMs(40);
  write('.relay/复核/第1棒.md', review(1, 'Codex · gpt-6-astra', '有问题，还没修'));
  track.track(root);
  write('.relay/交接/第3棒-0925-1030-codex.md', handoff('Codex · gpt-6-astra', 'Codex', 'gpt-6-astra'));
  track.track(root);
  assert.equal(stint(1).review, 'needed');
  const strong = stint(1).reviews?.find((m) => m.by === 3);
  assert.equal(strong?.verdict, 'problem');
  assert.ok(strong && !strong.weak, 'Codex 写的复核算数');

  // 反例：几分钟后没人在做时，有人把结论改成「没问题」——以前会记成第 3 棒（Codex）复核通过
  const later2 = Date.now() + 5 * 60_000;
  write('.relay/复核/第1棒.md', review(1, 'Codex · gpt-6-astra', '没问题'));
  touchAt(path.join(root, '.relay/复核/第1棒.md'), later2);
  track.track(root, { now: new Date(later2 + 60_000) });
  assert.equal(stint(1).review, 'needed', 'Codex 的「有问题，还没修」还在');
  assert.ok(stint(1).reviews?.some((m) => m.by === 3 && m.verdict === 'problem'), '原来强模型的结论没被替换');

  // 反例：复核写在强模型那一棒的时间里，但复核文件里写的复核人是弱模型：不算数
  write('.relay/交接/第4棒-0925-1050-codex.md', handoff('Codex · gpt-6-astra', 'Codex', 'gpt-6-astra', '进行中'));
  track.track(root);
  write('.relay/复核/第1棒.md', review(1, 'DeepSeek Harness · deepseek-flash', '有问题，已修好'));
  track.track(root);
  assert.equal(stint(1).review, 'needed');
  assert.equal(stint(1).reviews?.at(-1)?.weak, true);
  assert.match(stint(1).reviews?.at(-1)?.byLabel ?? '', /复核人是「DeepSeek Harness/);
});

test('先写复核、过一会儿才建交接（照旧版规矩的顺序）：交接建在复核之后 30 秒内，复核算这一棒的；隔得更久还是认不出是谁', () => {
  registry([CODEX, DSH]);
  const setup = (name: string, reviewAgoMs: number) => {
    const { root, write } = project(name);
    const now = Date.now();
    // 第 1 棒：弱模型一分钟前做完
    write('.relay/交接/第1棒-0925-1000-dsh.md', handoff('DeepSeek Harness · deepseek-flash', 'DeepSeek Harness', 'deepseek-flash'));
    write('a.txt', 'weak\n');
    track.track(root, { now: new Date(now - 60_000) });
    // Codex 在自己的工具里先写了复核（那时还没建交接，没有哪一棒在做）
    write('.relay/复核/第1棒.md', review(1, 'Codex · gpt-6-astra', '没问题'));
    touchAt(path.join(root, '.relay/复核/第1棒.md'), now - reviewAgoMs);
    track.track(root);
    const s1 = () => ledger.loadLedger(root).stints.find((x) => x.id === 1)!;
    assert.equal(s1().reviews?.at(-1)?.anon, true, '写复核那一刻认不出是谁');
    // 然后才建交接
    write('.relay/交接/第2棒-0925-1002-codex.md', handoff('Codex · gpt-6-astra', 'Codex', 'gpt-6-astra', '进行中'));
    track.track(root);
    return s1();
  };
  const soon = setup('review-then-handoff', 20_000);
  assert.equal(soon.review, 'done', '以前一直是「认不出是谁写的」，要再复核一遍');
  assert.equal(soon.reviews?.at(-1)?.by, 2);
  assert.ok(!soon.reviews?.at(-1)?.anon);

  const late = setup('review-long-before-handoff', 45_000);
  assert.equal(late.review, 'needed', '隔了 30 秒以上：不知道这中间是谁写的');
  assert.equal(late.reviews?.at(-1)?.anon, true);
});

test('检查命令往哪写：只认写的位置（> 文件、tee、-o、--junitxml= 这类），命令里读的文件不算', () => {
  const yes: [string, string][] = [
    ['python3 -m unittest -q test_wc && mkdir -p reports && date > reports/last-test-run.txt', 'reports/last-test-run.txt'],
    ['npm test 2>&1 | tee -a logs/test.log', 'logs/test.log'],
    ['pytest --junitxml=junit-report.xml', 'junit-report.xml'],
    ['gcc -o build/app main.c', 'build/app'],
    ['echo ok >> ./out/r.txt', 'out/r.txt'],
  ];
  const no: [string, string][] = [
    ['pytest tests/test_api.py', 'tests/test_api.py'],
    ['python3 wc.py < in.txt', 'in.txt'],
    ['python3 -O wc.py', 'wc.py'],
    ['cat a.txt > b.txt', 'a.txt'],
    ['date > reports/last-test-run.txt.bak', 'reports/last-test-run.txt'],
  ];
  for (const [c, f] of yes) assert.equal(track.gateWrites(c, f), true, `${c} 写了 ${f}`);
  for (const [c, f] of no) assert.equal(track.gateWrites(c, f), false, `${c} 没写 ${f}`);
});

test('一句话摘要跟着交接文件：挑法改进之后，旧记录在网页和接力本里也换成新的；接力台代写的不动', () => {
  registry([CODEX, DSH]);
  const { root, write } = project('live-summary');
  write(
    '.relay/交接/第1棒-0925-1000-dsh.md',
    '# 交接：DeepSeek Harness · deepseek-flash\n\n- 工具：DeepSeek Harness\n- 模型：deepseek-flash\n- 状态：已交接\n\n## 做了什么\n\n- 读了接力本。\n- 改 `a.txt`：原来是空的；现在改成\n  写了一行 hello。\n'
  );
  write('a.txt', 'hello\n');
  track.track(root);
  const s1 = ledger.loadLedger(root).stints[0];
  // 旧代码当时存下的摘要（2026-09-25 的真实例子：停在「现在改成」）
  ledger.saveStint(root, { ...s1, summary: '改 `a.txt`：原来是空的；现在改成' });
  const live = '改 `a.txt`：原来是空的；现在改成 写了一行 hello。';
  assert.equal(view.projectView(root).stints.find((x) => x.id === 1)?.summary, live, '网页');
  assert.equal(view.stintDetail(root, 1)?.stint.summary, live, '展开的那一棒');
  track.refreshBrief(root);
  assert.match(fs.readFileSync(path.join(root, '.relay/接力本.md'), 'utf8'), /现在改成 写了一行 hello/, '接力本');

  // 没留交接、接力台代写的：还是记下的那句
  write('b.txt', 'x\n');
  track.track(root);
  track.track(root, { now: new Date(Date.now() + 2 * track.QUIET_MS_DEFAULT) });
  const ghost = ledger.loadLedger(root).stints.find((x) => x.ghost);
  assert.ok(ghost, '接力台替它代写了交接');
  assert.equal(view.projectView(root).stints.find((x) => x.id === ghost!.id)?.summary, ghost!.summary);
});

test('只在清单里打勾、一个文件都没改的弱模型，也要复核（关了终审也不会「验收通过」）；强模型只打勾照旧不用复核', () => {
  registry([CODEX, DSH]);
  const { root, write } = project('tick-only', '给 README 加用法说明', ['写用法', '写示例']);
  const tickAll = () => write('.relay/任务.md', fs.readFileSync(path.join(root, '.relay/任务.md'), 'utf8').replace(/- \[ \]/g, '- [x]'));
  tickAll();
  write('.relay/交接/第1棒-0925-1000-dsh.md', handoff('DeepSeek Harness · deepseek-flash', 'DeepSeek Harness', 'deepseek-flash', '全部完成'));
  track.track(root);
  const s = ledger.loadLedger(root).stints[0];
  assert.equal(s.facts?.files, 0);
  assert.deepEqual(s.ticked, ['写用法', '写示例']);
  assert.equal(s.review, 'needed', '以前是「没改文件，不用复核」');
  const a = acceptance({ ledger: ledger.loadLedger(root), task: notes.readTask(root), gateCommand: '', finalRequired: false });
  assert.equal(a.state, 'blocked', '以前关了终审就「验收通过：清单 2/2 全部打勾」');
  assert.match(a.headline, /没改文件，只打了勾/);
  assert.match(fs.readFileSync(path.join(root, '.relay/接力本.md'), 'utf8'), /只在任务清单里打了勾：写用法、写示例/);

  const b = project('tick-only-strong', '改一句话', ['改']);
  b.write('.relay/任务.md', fs.readFileSync(path.join(b.root, '.relay/任务.md'), 'utf8').replace(/- \[ \]/g, '- [x]'));
  b.write('.relay/交接/第1棒-0925-1000-codex.md', handoff('Codex · gpt-6-astra', 'Codex', 'gpt-6-astra', '全部完成'));
  track.track(b.root);
  assert.equal(ledger.loadLedger(b.root).stints[0].review, 'skip');
});

test('账本坏了一行：不悄悄跳过，验收说「没法验收」、写明第几行；写到一半断掉的最后一行不会把下一条也带坏', () => {
  const root = tmpDir('bad-ledger');
  const at = (m: number) => new Date(Date.UTC(2026, 8, 25, 1, m)).toISOString();
  const st = { id: 1, kind: 'work' as const, who: { label: '弱', tier: 'weak' as const }, via: 'native' as const, startedAt: at(1), from: 'a', to: 'b', status: 'handed' as const, review: 'needed' as const, facts: { files: 1, added: 1, removed: 0, paths: ['x'] } };
  const lines = [JSON.stringify({ type: 'init', ts: at(0), snap: 'a' }), JSON.stringify({ type: 'stint', ts: at(1), stint: st }), JSON.stringify({ type: 'rollback', ts: at(2), to: 'a', label: '第 1 棒之前', safety: 's', after: 'a', dropped: [1] })];
  fs.mkdirSync(path.join(root, '.relay'), { recursive: true });
  const task = notes.parseTask('# 任务\n\n做\n\n## 进度\n\n- [x] 一\n');
  fs.writeFileSync(ledger.ledgerPath(root), `${lines.join('\n')}\n`);
  assert.equal(acceptance({ ledger: ledger.loadLedger(root), task, gateCommand: '', finalRequired: false }).state, 'accepted');
  // 退回那一行被截断：以前悄悄跳过，第 1 棒又算回来、没人知道
  fs.writeFileSync(ledger.ledgerPath(root), `${lines[0]}\n${lines[1]}\n${lines[2].slice(0, 40)}\n`);
  const a = acceptance({ ledger: ledger.loadLedger(root), task, gateCommand: '', finalRequired: false });
  assert.equal(a.state, 'unknown');
  assert.match(a.headline, /账本 \.relay\/journal\.jsonl 第 3 行读不出来/);
  // 最后一行写到一半断了（没有换行）：接着记的下一条自己单独一行
  fs.writeFileSync(ledger.ledgerPath(root), `${lines[0]}\n${lines[1]}\n${lines[2].slice(0, 40)}`);
  ledger.appendLedger(root, { type: 'base', ts: at(3), snap: 'c', why: '测试' });
  const full = ledger.readLedgerFull(root);
  assert.deepEqual(full.bad.map((b) => b.line), [3]);
  assert.equal(full.events.at(-1)?.type, 'base');
});

test('检查命令自己写的文件（缓存、报告、命令里写明的文件）：盯文件夹时记成接力台的改动，不开一棒「不知道是谁」；改到了别的代码就照常记账', async () => {
  registry([CODEX]);
  const { root, write } = project('gate-writes');
  config.saveRelayConfig(root, { gate: { command: 'mkdir -p reports && date +%s%N > coverage.xml' }, protectedPaths: [] });
  write('.relay/交接/第1棒-0925-1000-codex.md', handoff('Codex · gpt-6-astra', 'Codex', 'gpt-6-astra'));
  write('a.txt', '1\n');
  await track.trackAndGate(root);
  let v = ledger.loadLedger(root);
  assert.equal(v.stints.length, 1);
  assert.equal(v.stints[0].gate?.status, 'pass');
  assert.match(v.stints[0].note ?? '', /检查命令跑完改了 1 个文件（coverage\.xml）/);
  assert.ok(v.events.some((e) => e.type === 'base' && /检查命令写的文件：coverage\.xml/.test(e.why)));
  track.track(root);
  v = ledger.loadLedger(root);
  assert.equal(v.stints.length, 1, '以前这里会开出第 2 棒「不知道是谁」');
  assert.equal(v.open, null);

  // 检查命令里写明的文件（2026-09-25 真实冒烟测试：`date > reports/last-test-run.txt`）：一样记成接力台的改动
  config.saveRelayConfig(root, { gate: { command: 'mkdir -p reports && date > reports/last-test-run.txt' }, protectedPaths: [] });
  write('.relay/交接/第2棒-0925-1005-codex.md', handoff('Codex · gpt-6-astra', 'Codex', 'gpt-6-astra'));
  write('c.txt', '3\n');
  await track.trackAndGate(root);
  track.track(root);
  v = ledger.loadLedger(root);
  assert.equal(v.stints.length, 2, '以前这里会开出一棒「不知道是谁」（2026-09-25 真实冒烟测试里就出现过）');
  assert.match(v.stints[1].note ?? '', /reports\/last-test-run\.txt/);

  // 检查命令改到了命令里没写的代码：不替它记，照常算到下一棒（盯文件夹时可能是别的 AI 已经开工了）
  write('touch.sh', 'echo x >> src.txt\n');
  config.saveRelayConfig(root, { gate: { command: 'sh touch.sh' }, protectedPaths: [] });
  write('.relay/交接/第3棒-0925-1010-codex.md', handoff('Codex · gpt-6-astra', 'Codex', 'gpt-6-astra'));
  write('b.txt', '2\n');
  await track.trackAndGate(root);
  track.track(root);
  v = ledger.loadLedger(root);
  assert.equal(v.stints.length, 4);
  assert.deepEqual(v.stints[3].facts?.paths, ['src.txt']);
});

test('投票：AI 还在投的时候你投的那一票不会被后面的结果盖掉；记下的强弱按实际模型算', async () => {
  registry([
    { name: 'a1', label: 'A1', kind: 'api', tier: 'strong', api: { baseUrl: 'http://127.0.0.1:9', model: 'claude-opus-5-5', apiKeyEnv: '' } },
    { name: 'a2', label: 'A2', kind: 'api', tier: 'strong', api: { baseUrl: 'http://127.0.0.1:9', model: 'deepseek-flash', apiKeyEnv: '' } },
  ]);
  const root = tmpDir('vote-race');
  const real = talkMod.askAgent;
  talkMod.askAgent = async (agent: { name: string }) => {
    if (agent.name === 'a2') await new Promise((r) => setTimeout(r, 400));
    return agent.name === 'a1' ? '投票：A\n理由：简单' : '投票：B\n理由：稳妥';
  };
  try {
    const { vote: v, done } = vote.startVote(root, { question: '用哪个方案？', voters: ['a1', 'a2'], options: ['方案一', '方案二'] });
    await new Promise((r) => setTimeout(r, 150));
    vote.castHumanVote(root, v.id, 'B', '我也选 B');
    const final = await done;
    assert.deepEqual(final.counts, { A: 1, B: 2 }, '以前你那一票会丢，变成 1 比 1');
    assert.deepEqual(vote.readVotes(talk.talkPath(root)).find((x) => x.id === v.id)!.ballots.map((b) => b.voter).sort(), ['a1', 'a2', 'human']);
    assert.deepEqual(Object.fromEntries(final.ballots.filter((b) => b.voter !== 'human').map((b) => [b.voter, b.tier])), { a1: 'strong', a2: 'weak' }, 'a2 名单里记的是强，实际模型是 DeepSeek，算弱');
  } finally {
    talkMod.askAgent = real;
  }
});

test('讨论命令和编程工具一样：接力台在某个 AI 工具里启动时，它注入的会话变量不传给讨论命令', async () => {
  const keep = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID, ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL };
  Object.assign(process.env, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'fake-session', ANTHROPIC_BASE_URL: 'http://host-injected.invalid' });
  try {
    const reply = await talk.askAgent({ name: 'mine', kind: 'cli', cmd: 'x', tier: 'weak', ask: 'env' }, 'hi', tmpDir('ask-env'));
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'ANTHROPIC_BASE_URL']) assert.doesNotMatch(reply, new RegExp(`^${k}=`, 'm'), k);
    assert.match(reply, /^NO_COLOR=1$/m);
  } finally {
    for (const [k, v] of Object.entries(keep)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('工具的输出里，一个汉字被切在两次读取之间也不会变成乱码（日志和最后一句话都一样）', async () => {
  const dir = tmpDir('utf8-split');
  const tool = `const b=Buffer.from(JSON.stringify({result:'全部完成，测试通过'})+'\\n');process.stdout.write(b.subarray(0,13));setTimeout(()=>process.stdout.write(b.subarray(13)),150);`;
  const r = await runner.startRun({ invocation: { argv: [process.execPath, '-e', tool], format: 'lines' }, cwd: dir, timeoutMs: 10_000, logPath: path.join(dir, 'run.log'), title: '测试' }).done;
  assert.equal(r.finalText, '全部完成，测试通过');
  assert.match(fs.readFileSync(path.join(dir, 'run.log'), 'utf8'), /说：全部完成，测试通过/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'run.log'), 'utf8'), /�/);
});

test('网页要成员时：识别结果里有的工具不在请求里再运行一遍（不然每 5 分钟卡住整个接力台几秒）；识别结果里没有的才现找', () => {
  const bin = tmpDir('slow-tools');
  for (const t of ['codex']) {
    fs.writeFileSync(path.join(bin, t), '#!/bin/sh\n[ "$1" = --version ] && { sleep 2; echo 9.9.9; exit 0; }\nexit 0\n');
    fs.chmodSync(path.join(bin, t), 0o755);
  }
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  try {
    registry([CODEX, { name: 'opencode', kind: 'cli', cmd: 'opencode', tier: 'strong', harness: 'opencode', detected: true }]);
    const report = { at: new Date().toISOString(), harnesses: [{ id: 'codex', label: 'Codex', vendor: 'OpenAI', version: '9.9.9', where: path.join(bin, 'codex'), login: { state: 'ok', detail: '' }, model: {}, workLevels: ['safe', 'full'], canReview: true, tested: 'yes', loginHint: '' }], providers: [], apps: [], unknownKeys: [] };
    harness.clearLocateCache();
    const t0 = Date.now();
    const list = members.allMembers('safe', report as never);
    assert.ok(Date.now() - t0 < 1000, `用了 ${Date.now() - t0} 毫秒`);
    assert.equal(list.find((m) => m.name === 'codex')?.canWork, true);
    assert.equal(list.find((m) => m.name === 'opencode')?.why, '这台电脑上没找到', '识别结果里没有、现找也没装');
  } finally {
    process.env.PATH = PATH;
  }
});

test('上次接力台被关掉时留下的工具：进程号对得上、命令也对得上才结束它（进程号可能已经被别的程序用了）', async () => {
  const root = tmpDir('reap');
  const gone = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => gone.on('exit', r));
  const state = (toolPid: number, toolExe: string) => {
    fs.mkdirSync(path.join(root, '.relay', 'runs'), { recursive: true });
    fs.writeFileSync(go.goStatePath(root), JSON.stringify({ id: 'x', root, pid: gone.pid, mode: 'auto', status: 'running', phase: '', stints: [], startedAt: '', updatedAt: '', level: 'safe', current: { stint: 1, member: 'codex', label: 'Codex', kind: 'work', since: '', log: '', toolPid, toolExe } }));
  };
  const other = spawn('sleep', ['30'], { detached: true });
  const tool = spawn('sleep', ['31'], { detached: true });
  try {
    await new Promise((r) => setTimeout(r, 100));
    state(other.pid!, '/some/where/codex');
    assert.equal(go.reapLeftover(root), false, '命令对不上：不是当时的工具，不动');
    state(tool.pid!, 'sleep');
    assert.equal(go.reapLeftover(root), true);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(tool.exitCode !== null || tool.signalCode !== null, true, '留下的工具结束了');
    assert.equal(other.exitCode, null, '别的程序还在');
  } finally {
    other.kill('SIGKILL');
    tool.kill('SIGKILL');
  }
});

test('小问题：写任务时说明里的 $$、$& 原样；Fable 算强、自动识别到又看不出模型的工具按弱；「已交接（没做完的写在下一步）」算交接了；.GIT 这种写法也看不了；没登录只认成句的说法；Copilot 只读时不许改文件、跑命令', () => {
  const root = tmpDir('small');
  notes.setTask(root, '改部署脚本\n把 echo $$ 改成 echo "$PPID"，价格写成 $&9.99');
  const raw = fs.readFileSync(path.join(root, '.relay/任务.md'), 'utf8');
  assert.match(raw, /把 echo \$\$ 改成 echo "\$PPID"，价格写成 \$&9\.99/);
  assert.equal(notes.parseTask(raw).title, '改部署脚本');

  assert.equal(tier.tierForModel('fable'), 'strong');
  assert.equal(tier.tierForModel('claude-fable-5-1'), 'strong');
  assert.equal(tier.memberTier({ tier: 'strong', detected: true, kind: 'cli' }, undefined), 'weak', '自动识别的、看不出模型：按弱');
  assert.equal(tier.memberTier({ tier: 'strong', detected: true, kind: 'cli', tierSet: true }, undefined), 'strong', '你设过的以你为准');
  assert.equal(tier.memberTier({ tier: 'strong' }, undefined), 'strong', '你自己加的用名单里记的');
  registry([]);
  const changes = detect.syncRegistry({ at: '', harnesses: [{ id: 'opencode', label: 'OpenCode', vendor: 'SST', version: '1', where: '/x', login: { state: 'unknown', detail: '' }, model: {}, workLevels: ['full'], canReview: true, tested: 'no', loginHint: '' }], providers: [], apps: [], unknownKeys: [] });
  assert.match(changes.join(''), /OpenCode/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.RELAY_HOME!, 'agents.json'), 'utf8')).agents[0].tier, 'weak');

  const state = (s: string) => notes.parseHandoff(`# 交接：X\n\n- 状态：${s}\n\n## 做了什么\n\n- 做了一半\n`).state;
  assert.equal(state('已交接（没做完的写在下一步）'), 'handed');
  assert.equal(state('已交接，未完成部分见下一步'), 'handed');
  assert.equal(state('进行中'), 'working');
  assert.equal(state('未完成'), 'working');
  assert.equal(state('快交接了，还在做'), 'working');
  assert.equal(state('全部完成'), 'finished');
  assert.equal(state('卡住了'), 'stuck');

  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'config'), '[remote]\n');
  assert.throws(() => files.readProjectFile(root, '.git/config'), /不能看/);
  if (fs.existsSync(path.join(root, '.GIT'))) assert.throws(() => files.readProjectFile(root, '.GIT/config'), /不能看/, '不分大小写的磁盘上 .GIT 就是 .git');

  assert.equal(harness.explainFailure('claude-official', 'Error: tests failed in src/login.ts'), null);
  assert.equal(harness.explainFailure('codex', 'AssertionError at app.test.js:401'), null);
  assert.match(harness.explainFailure('claude-official', 'Error: Not logged in · Please run /login') ?? '', /官方账号没登录/);
  assert.match(harness.explainFailure('codex', 'unexpected status 401 Unauthorized') ?? '', /没登录/);

  const loc = { exec: ['/x/copilot'], version: '1', where: '/x' };
  const ro = harness.findHarness('copilot')!.invoke(loc, { cwd: '/p', prompt: '只回答', level: 'safe', readOnly: true, outFile: '/o' });
  assert.deepEqual(ro.argv.slice(-4), ['--deny-tool', 'write', '--deny-tool', 'shell']);
  const rw = harness.findHarness('copilot')!.invoke(loc, { cwd: '/p', prompt: '干活', level: 'full', readOnly: false, outFile: '/o' });
  assert.ok(!rw.argv.includes('--deny-tool'));
});

test('认额度用完只看工具自己报的话：AI 说的话、调用工具的参数里有 rate limit、quota，不算', () => {
  const log = ['10:01:02 工具 Grep：rate limit|usage limit', '10:01:30 说：检查了 429 和 quota exceeded 的错误处理，没问题。', '10:02:00 结束（success，12 轮，58 秒）', '10:02:00 （工具自己的输出）ERROR: You have hit your usage limit.', '10:02:01 退出（代码 1，用时 58 秒）'].join('\n');
  const only = runner.toolLines(log);
  assert.doesNotMatch(only, /Grep|说：/);
  assert.match(only, /hit your usage limit/);
  assert.match(only, /结束（success/);
});

test('接力本只在内容变了时才重写：过几分钟再刷新（接力台开着时每分钟刷一次）不动文件；交接格式里的时间留给 AI 自己填', () => {
  registry([CODEX, DSH]);
  const { root, write } = project('brief-still');
  const brief = path.join(root, '.relay/接力本.md');
  const t0 = new Date('2026-09-27T00:10:00+08:00');
  track.refreshBrief(root, t0);
  const before = fs.readFileSync(brief, 'utf8');
  assert.match(before, /- 时间：YYYY-MM-DD HH:MM（开工的时间）/);
  assert.equal(track.refreshBrief(root, new Date(t0.getTime() + 7 * 60_000)), false, '只过了几分钟、别的都没变：不写');
  assert.equal(fs.readFileSync(brief, 'utf8'), before);
  write('.relay/任务.md', '# 任务\n\n换一个标题\n\n## 进度\n\n- [ ] 第一步\n');
  assert.equal(track.refreshBrief(root, new Date(t0.getTime() + 9 * 60_000)), true, '任务变了：照写');
  assert.match(fs.readFileSync(brief, 'utf8'), /换一个标题/);
});

test('群聊：一直出声的不按时间掐；一点动静都没有的到点就停，说清楚是没动静；回的是调用工具的原文不算回答', async () => {
  const dir = tmpDir('idle');
  const run = (tool: string) =>
    runner.startRun({ invocation: { argv: [process.execPath, '-e', tool], format: 'lines' }, cwd: dir, timeoutMs: 20_000, idleMs: 1000, logPath: path.join(dir, 'run.log'), title: '测试' }).done;
  const busy = await run(`let i=0;const t=setInterval(()=>{console.log('第'+ ++i +'句');if(i===6)clearInterval(t)},250)`);
  assert.equal(busy.timedOut, false, '说了 1.5 秒，比「没动静」的上限长，但一直在出声');
  assert.match(busy.finalText, /第6句$/);
  const stuck = await run(`console.log('开个头');setTimeout(()=>console.log('太晚了'),8000)`);
  assert.ok(stuck.timedOut && stuck.late === '1 秒没有输出，已停止', JSON.stringify(stuck));
  assert.ok(stuck.durationMs < 4000, `${stuck.durationMs} 毫秒`);
  assert.match(fs.readFileSync(path.join(dir, 'run.log'), 'utf8'), /1 秒没有输出，已停止/);

  const ask = (cmd: string) => talk.askAgent({ name: 'mine', kind: 'cli', cmd: 'x', tier: 'weak', ask: cmd }, 'hi', dir, 20_000, 1000);
  await assert.rejects(ask('sleep 5'), /: 1 秒没有输出，已停止$/);
  await assert.rejects(ask(`printf '<tool_call><function=bash><parameter=command>ls</parameter></function></tool_call>'`), /调用工具的原文/);
  // 没说话就退出：额度用完（和干活时同一套认法）、别的报错都带原话，说法同一套
  await assert.rejects(ask(`echo 'Error: insufficient balance, please recharge' >&2; exit 1`), /: 额度用完，原话：Error: insufficient balance, please recharge$/);
  await assert.rejects(ask(`echo 'Error: bad flag' >&2; exit 2`), /: 退出码 2，原话：Error: bad flag$/);
  await assert.rejects(ask('exit 0'), /: 没有输出（退出码 0）$/);
});

test('群聊里的 Gemini 带沙箱；要跑的命令被拒、一句话没说就结束时，说清楚拒的是哪条', async () => {
  const dir = tmpDir('fake-agy');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const args = path.join(dir, 'args.txt');
  const params = { CommandLine: 'textutil -convert txt -stdout a.rtf' };
  const ev = (o: unknown) => `echo '${JSON.stringify(o)}'`;
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > '${args}'`,
    ev({ event: 'step_update', step_update: { state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: params } } }),
    ev({ event: 'step_update', step_update: { state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: params, error: { type: 'TOOL_ERROR', message: 'permission check failed for unsandboxed command: user denied permission' } } } }),
    ev({ event: 'result', result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } }),
  ];
  fs.writeFileSync(path.join(bin, 'agy'), `${script.join('\n')}\n`, { mode: 0o755 });
  const keep = process.env.PATH;
  process.env.PATH = `${bin}:${keep}`;
  harness.clearLocateCache();
  try {
    await assert.rejects(talk.askAgent({ name: 'agy', kind: 'cli', cmd: 'agy', tier: 'weak', harness: 'agy' }, 'hi', dir), /「textutil -convert txt -stdout a\.rtf」没获准运行/);
    const argv = fs.readFileSync(args, 'utf8').split('\n');
    assert.ok(argv.includes('plan') && argv.includes('--sandbox'), argv.join(' '));
  } finally {
    process.env.PATH = keep;
    harness.clearLocateCache();
  }
});

test('群聊里的接口成员：能看项目里的文件、不能改，照看到的回答', async () => {
  const dir = tmpDir('api-talk');
  fs.writeFileSync(path.join(dir, 'README.md'), 'demo\n');
  const mock = await mockLlm();
  try {
    const reply = await talk.askAgent({ name: 'mimo', kind: 'api', tier: 'weak', api: { baseUrl: mock.url, model: 'mock-coder', apiKeyEnv: '' } }, '大家看看 README', dir);
    assert.match(reply, /^接口读到：\s*1\s+demo/);
    assert.match(mock.toolResults[0], /只能看文件，不能改/);
    assert.equal(fs.existsSync(path.join(dir, 'hack.txt')), false);
  } finally {
    mock.close();
  }
});

test('群聊说到一半点「新群聊」：没说完的接着写回原来那段，新群聊里没有它们；存档那段标着还在说。接着一段还在说的群聊，说的人跟过去', async () => {
  registry([{ name: 'slow', label: 'Slow', kind: 'cli', cmd: 'x', tier: 'weak', ask: 'sleep 0.3; echo 慢慢说完了' }]);
  const root = tmpDir('talk-move');
  {
    const first = talk.say(root, '第一段的问题', ['slow']);
    const id = talk.archiveTalk(root)!;
    assert.ok(id, '有内容：存档了');
    assert.deepEqual(talk.talkSessions(root).map((s) => [s.id, !!s.busy]), [[id, true]], '存档那段还在说');
    assert.equal(talk.talkStatus(talk.talkPath(root)).speaking.length, 0, '新的一段没人在说');
    talk.say(root, '新群聊的问题', []);
    await first.done;
    assert.deepEqual(talk.readTalk(root, 10, talk.talkFile(root, id)).map((r) => r.text), ['第一段的问题', '慢慢说完了']);
    assert.deepEqual(talk.readTalk(root).map((r) => r.text), ['新群聊的问题'], '回答没串进新群聊');
    assert.equal(talk.talkSessions(root)[0].busy, undefined, '说完就不标');

    const again = talk.say(root, '再问一次', ['slow']);
    const id2 = talk.archiveTalk(root)!;
    talk.resumeTalk(root, id2);
    assert.equal(talk.talkStatus(talk.talkPath(root)).speaking[0]?.agent, 'slow', '接着的那段：还在说的跟过来');
    await again.done;
    assert.deepEqual(talk.readTalk(root).map((r) => r.text), ['新群聊的问题', '再问一次', '慢慢说完了']);
    assert.equal(talk.anyTalkBusy(), false);
  }
});

test('投票只列了一个选项：AI 照样各出一个方案，你列的那个一起参加（去掉名字）；投票途中点了「新群聊」，结果写回原来那段', async () => {
  registry([
    { name: 'a1', label: 'A1', kind: 'api', tier: 'strong', api: { baseUrl: 'http://127.0.0.1:9', model: 'claude-opus-5-5', apiKeyEnv: '' } },
    { name: 'a2', label: 'A2', kind: 'api', tier: 'strong', api: { baseUrl: 'http://127.0.0.1:9', model: 'gpt-6-sol', apiKeyEnv: '' } },
  ]);
  const root = tmpDir('vote-one');
  const real = talkMod.askAgent;
  talkMod.askAgent = async (agent: { name: string }, prompt: string) => {
    await new Promise((r) => setTimeout(r, 100));
    if (/各自独立出一个方案/.test(prompt)) return `${agent.name} 的方案\n理由写在这里`;
    const key = prompt.match(/【方案 ([A-L])】\n我的方案/)![1];
    return `投票：${key}\n理由：人列的这个最稳`;
  };
  try {
    const { vote: v, done } = vote.startVote(root, { question: '用哪个方案？', voters: ['a1', 'a2'], options: ['我的方案'] });
    assert.equal(v.status, 'proposing', '一个选项：先请 AI 出方案');
    const id = talk.archiveTalk(root)!;
    const final = await done;
    assert.equal(final.options.length, 3);
    const mine = final.options.find((o) => o.author === 'human')!;
    assert.equal(mine.authorLabel, '我');
    assert.equal(final.counts![mine.key], 2);
    assert.equal(vote.readVotes(talk.talkFile(root, id)).find((x) => x.id === v.id)!.status, 'done', '结果写回原来那段');
    assert.deepEqual(vote.readVotes(talk.talkPath(root)), [], '新群聊里没有这次投票');
  } finally {
    talkMod.askAgent = real;
  }
});

test('没成的原因：连接类的错说「连不上服务器」；原话取工具最后报的那条（先看日志里的「出错」，再看标准错误里最后一句）', async () => {
  assert.equal(
    runner.lastError('2026 ERROR codex_models_manager::manager: failed to refresh available models: request timed out', '10:00:00 出错：Reconnecting... 5/5 (workspace routing discovery failed)'),
    'Reconnecting... 5/5 (workspace routing discovery failed)'
  );
  assert.equal(runner.lastError('WARN 开头\nERROR 第一条\nError: 最后一条\n  at x.js:1'), 'Error: 最后一条');
  assert.equal(runner.lastError('zsh: killed'), 'zsh: killed', '没有像报错的就用最后一行');
  const ask = (cmd: string) => talk.askAgent({ name: 'mine', kind: 'cli', cmd: 'x', tier: 'weak', ask: cmd }, 'hi', tmpDir('offline'), 20_000, 5000);
  await assert.rejects(ask(`echo 'ERROR models: request timed out' >&2; echo 'Error: error sending request for url (https://chatgpt.com/backend-api/codex/responses)' >&2; exit 1`), /: 连不上服务器，原话：Error: error sending request for url \(https:\/\/chatgpt\.com\/backend-api\/codex\/responses\)$/);
  assert.ok(runner.looksLikeNetworkBlip('Reconnecting... 2/5 (workspace routing discovery failed)'), '干活时也算网络抖了一下，原地再试一次');
  // 自定义命令和编程工具走同一套执行：回答原样，空行留着，回答里举的 JSON 例子不当成回答本身
  assert.equal(await ask(`printf '第一段\\n\\n{"text": "只是例子"}\\n第二段\\n'`), '第一段\n\n{"text": "只是例子"}\n第二段');
});

test('DeepSeek Harness 的 token 用量从它自己记的会话里读：这个项目、这一棒开始之后的会话加起来，输入含读缓存', () => {
  const zlib = require('node:zlib') as { zstdCompressSync?: (b: Buffer) => Buffer };
  if (!zlib.zstdCompressSync) return;
  const dsh = tmpDir('dsh-home');
  const root = '/Users/某人/项目 a';
  const dir = path.join(dsh, 'sessions', '-' + '-Users-~67D0~4EBA-~9879~76EE a' + '--');
  const write = (name: string, lines: unknown[], mtime?: number) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    const f = path.join(dir, name, 'session.v4.jsonl.zstd');
    // 和真的一样：每条记录单独压成一块，一块接一块写（以前只解得出第一块，一条用量都读不到）
    fs.writeFileSync(f, Buffer.concat(lines.map((l) => zlib.zstdCompressSync!(Buffer.from(JSON.stringify(l) + '\n')))));
    if (mtime) fs.utimesSync(f, mtime / 1000, mtime / 1000);
  };
  const call = (i: number, o: number, c: number) => ({ data: { usage: { inputTokens: i, outputTokens: o, cacheReadTokens: c, cacheWriteTokens: 0 }, stream: [{ chunk: { usage: { inputTokens: 999 } } }] } });
  write('session-new', [{ data: { header: {} } }, call(100, 10, 1000), call(50, 5, 2000)]);
  write('session-old', [call(7, 7, 7)], Date.now() - 3_600_000);
  const keep = process.env.DSH_HOME;
  process.env.DSH_HOME = dsh;
  try {
    assert.deepEqual(harness.dshUsage(root, Date.now() - 60_000), { input: 3150, output: 15, cached: 3000 }, '只算这一棒开始之后的；流里的片段不重复算；其中读缓存的单记');
    assert.equal(harness.dshUsage('/别的/项目', 0), null);
  } finally {
    if (keep === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = keep;
  }
});

test('内置小代理读到的文件发给模型前抹掉密钥；抹掉的内容不许原样写回文件', async () => {
  const dir = tmpDir('api-redact');
  const key = 'sk-' + 'abcdefghijklmnopqrstuvwx';
  fs.writeFileSync(path.join(dir, 'README.md'), `demo\nOPENAI_API_KEY=${key}\n`);
  const mock = await mockLlm();
  try {
    const reply = await talk.askAgent({ name: 'mimo', kind: 'api', tier: 'weak', api: { baseUrl: mock.url, model: 'mock-coder', apiKeyEnv: '' } }, '大家看看 README', dir);
    assert.ok(!mock.toolResults.join('\n').includes(key), '密钥没出网');
    assert.ok(!reply.includes(key));
    assert.match(mock.toolResults[1], /\[REDACTED\]/);
  } finally {
    mock.close();
  }
});

test('检查命令拿不到密钥：名字像密钥、值像密钥的环境变量都去掉，别的照常', async () => {
  const { runGate } = require('../src/core/gate') as typeof import('../src/core/gate');
  const keep = { ...process.env };
  Object.assign(process.env, { ZHIPU_CODING_KEY: 'x1', MY_SERVICE_TOKEN: 'x2', PLAIN_THING: 'sk-' + 'abcdefghijklmnopqrstuvwx', RELAY_TEST_NORMAL: 'hello' });
  try {
    const r = await runGate(tmpDir('gate-env'), { gate: { command: 'echo "n=$RELAY_TEST_NORMAL k=$ZHIPU_CODING_KEY t=$MY_SERVICE_TOKEN p=$PLAIN_THING"' }, protectedPaths: [] } as never);
    assert.equal(r.status, 'pass');
    assert.equal(r.detail, 'n=hello k= t= p=');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
});

test('验收对指纹：文件夹和账本最后记下的不一样（在接力台之外改了），不算通过；生成出来的缓存不算改动', () => {
  const snap = require('../src/core/snap') as typeof import('../src/core/snap');
  const dir = tmpDir('print');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
  const sha = snap.takeSnapshot(dir, '测试').sha;
  assert.equal(snap.changedSince(dir, sha), false);
  fs.mkdirSync(path.join(dir, '.pytest_cache'));
  fs.writeFileSync(path.join(dir, '.pytest_cache', 'x'), 'cache');
  assert.equal(snap.changedSince(dir, sha), false, '缓存不算');
  fs.writeFileSync(path.join(dir, 'a.txt'), '2\n');
  assert.equal(snap.changedSince(dir, sha), true);
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'n\n');
  assert.equal(snap.changedSince(dir, sha), true, '新文件也算');
  const later = snap.takeSnapshot(dir, '又一张').sha;
  assert.equal(snap.changedSince(dir, sha), true, '快照往前走了、账本还停在旧的：也算');
  assert.equal(snap.changedSince(dir, later), false);

  const input = { ledger: ledger.viewLedger([]), task: notes.parseTask('# 任务\n\n做\n\n## 进度\n\n- [x] 一步\n'), gateCommand: '', finalRequired: false };
  assert.equal(acceptance(input).state, 'accepted');
  const acc = acceptance({ ...input, unrecorded: true });
  assert.equal(acc.state, 'working');
  assert.deepEqual(acc.items.map((i) => i.text), ['文件夹里有还没记上账的改动']);
});

test('投票：出方案没出上的照样投票、只算一张票，「没出方案」单独记（以前记成一张弃权票，同一位看着像投了两次）；旧记录读的时候也挪开', async () => {
  const api = (name: string) => ({ name, label: name, kind: 'api', tier: 'weak', api: { baseUrl: 'http://127.0.0.1:9', model: `${name}-model`, apiKeyEnv: '' } });
  registry([api('a1'), api('a2'), api('a3')]);
  const root = tmpDir('vote-noopt');
  const real = talkMod.askAgent;
  talkMod.askAgent = async (agent: { name: string }, prompt: string) => {
    const ballot = /投票：<方案字母>/.test(prompt);
    if (!ballot && agent.name === 'a3') throw new Error('没有输出');
    return ballot ? '投票：A\n理由：简单' : `${agent.name} 的方案`;
  };
  try {
    const final = await vote.startVote(root, { question: '怎么查这个脚本？', voters: ['a1', 'a2', 'a3'] }).done;
    assert.equal(final.options.length, 2);
    assert.deepEqual(final.ballots.map((b) => b.voter).sort(), ['a1', 'a2', 'a3'], '一位一张票');
    assert.deepEqual(final.noOption?.map((x) => [x.voter, x.why]), [['a3', '没有输出']]);
    assert.equal(final.ballots.find((b) => b.voter === 'a3')?.choice, 'A', 'a3 没出方案，投别人的照样算数');
  } finally {
    talkMod.askAgent = real;
  }
  const file = talk.talkPath(tmpDir('vote-old'));
  const opt = { key: 'A', text: '先跑体检', author: 'a1', authorLabel: 'A1' };
  talk.appendTalkRaw(file, {
    kind: 'vote', id: 'vote-old', ts: '2026-09-29T08:00:00.000Z', question: '怎么查？', status: 'done', options: [opt], voters: ['glm-api'],
    ballots: [
      { voter: 'glm-api', voterLabel: 'GLM-5.3', choice: null, reason: '', void: '没出方案，没有输出' },
      { voter: 'glm-api', voterLabel: 'GLM-5.3', choice: 'A', reason: '对得上' },
    ],
  });
  const old = vote.readVotes(file)[0];
  assert.deepEqual(old.ballots.map((b) => b.choice), ['A']);
  assert.deepEqual(old.noOption, [{ voter: 'glm-api', voterLabel: 'GLM-5.3', why: '没有输出' }]);
});

test('群聊里的接口成员一直在看文件、看到步数用完也没回答：请它不再看文件，照看到的直接回答（以前记成「没有输出」）', async () => {
  const root = tmpDir('ask-steps');
  fs.writeFileSync(path.join(root, 'README.md'), 'demo\n');
  const calls: number[] = [];
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body) as { messages: { role: string; content?: unknown }[] };
      calls.push(j.messages.length);
      const last = j.messages.at(-1)!;
      const nudged = last.role === 'user' && /不要再调用工具/.test(String(last.content));
      const msg = nudged ? { role: 'assistant', content: '方案：先跑体检，再只看改过的地方' } : { role: 'assistant', content: '', tool_calls: [{ id: `c${calls.length}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: msg }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const reply = await talk.askAgent({ name: 'reader', kind: 'api', tier: 'weak', api: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'glm-5.3', apiKeyEnv: '' } }, '请给出你的方案', root);
    assert.equal(reply, '方案：先跑体检，再只看改过的地方');
    assert.equal(calls.length, 31, '30 步看文件，再问一次');
  } finally {
    server.close();
  }
  // Claude 协议：「工具结果」和这句话是同一轮（一问一答要交替）
  const llm = require('../src/core/llm') as typeof import('../src/core/llm');
  const chat = new llm.ToolChat({ baseUrl: 'http://127.0.0.1:9', model: 'm', apiKeyEnv: '', format: 'anthropic' }, 'sys', []);
  chat.user('问题');
  chat.results([{ id: 't1', content: '文件内容' }]);
  chat.user('直接回答');
  const msgs = (chat as unknown as { msgs: { role: string; content: { type: string }[] }[] }).msgs;
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'user']);
  assert.deepEqual(msgs[1].content.map((b) => b.type), ['tool_result', 'text']);
});

test('Cursor 一时拿不到模型列表（「Cannot use this model: …. Available models:」后面是空的）算临时出错：群聊里等几秒再问一次', async () => {
  assert.equal(runner.looksLikeNetworkBlip('Cannot use this model: grok-4.7-high-fast. Available models:'), true);
  assert.equal(runner.looksLikeNetworkBlip('Cannot use this model: grok-9. Available models: auto, grok-4.7-high'), false, '列表不是空的：真没有这个模型，不重试');
  const dir = tmpDir('ask-blip');
  const script = path.join(dir, 'flaky.js');
  fs.writeFileSync(script, `const fs=require('fs');const m=${JSON.stringify(path.join(dir, 'once'))};if(!fs.existsSync(m)){fs.writeFileSync(m,'');console.error('Cannot use this model: grok-4.7-high-fast. Available models:');process.exit(1)}console.log('第二次就好了')`);
  const was = process.env.RELAY_RETRY_MS;
  process.env.RELAY_RETRY_MS = '20';
  try {
    const reply = await talk.askAgent({ name: 'flaky', kind: 'cli', cmd: 'x', tier: 'weak', ask: `"${process.execPath}" "${script}"` }, 'hi', dir);
    assert.equal(reply, '第二次就好了');
  } finally {
    if (was === undefined) delete process.env.RELAY_RETRY_MS;
    else process.env.RELAY_RETRY_MS = was;
  }
});

test('删掉的对话里待复核的棒不再算待复核：项目红点、「第 N 棒待复核」、全自动先复核、验收、接力本都不算；撤销删除就回来', () => {
  registry([CODEX, DSH]);
  const { root, write } = project('del-pending', '评估一件事', ['一']);
  write('.relay/交接/第1棒-0925-1000-dsh.md', handoff('DeepSeek Harness · deepseek-flash', 'DeepSeek Harness', 'deepseek-flash'));
  write('a.txt', '1\n');
  track.track(root);
  const pending = () => ({
    ledger: ledger.pendingReviews(ledger.loadLedger(root)).map((s) => s.id),
    view: view.projectView(root).pending.map((s) => s.id),
    accept: view.projectView(root).acceptance.pending,
    brief: /## 先复核/.test(fs.readFileSync(path.join(root, '.relay', '接力本.md'), 'utf8')),
  });
  assert.deepEqual(pending(), { ledger: [1], view: [1], accept: [1], brief: true }, '弱模型干的一棒待复核');
  // 删掉正在做的任务（截图里的情形：删完红点、「第 1 棒待复核（共 3 棒）」都还在）
  const id = init.deleteTask(root);
  assert.deepEqual(pending(), { ledger: [], view: [], accept: [], brief: false });
  init.restoreTask(root, id);
  assert.deepEqual(pending(), { ledger: [1], view: [1], accept: [1], brief: true }, '撤销删除：又算待复核');
  // 换了新任务、把旧的那段从左边删掉：一样不算
  init.newTask(root, '下一件事');
  const old = view.projectView(root).threads[0];
  const hidden = require('../src/ops/hidden') as typeof import('../src/ops/hidden');
  hidden.setThreadHidden(root, old.key, true);
  assert.deepEqual(pending().ledger, []);
  assert.deepEqual(view.projectView(root).pending, []);
  hidden.setThreadHidden(root, old.key, false);
  assert.deepEqual(pending().ledger, [1]);
});

test('右键删除：群聊挪进 .relay/已删除的群聊/、左边不再列出，撤销能找回；还有 AI 在说也删。对话（任务）只是不列出，正在做的那段删了清单清空', () => {
  const { root } = project('ctx-delete', '第一个任务');
  // 群聊：正在用的一段、存档的一段
  talk.appendTalk(root, { kind: 'human', who: '我', text: '旧的问题' });
  const old = talk.archiveTalk(root)!;
  talk.appendTalk(root, { kind: 'human', who: '我', text: '新的问题' });
  assert.equal(talk.deleteTalk(root, old), old);
  assert.ok(fs.existsSync(path.join(root, '.relay', '已删除的群聊', `${old}.jsonl`)), '没真删');
  assert.deepEqual(talk.talkSessions(root).map((x) => x.id), []);
  talk.restoreTalk(root, old);
  assert.deepEqual(talk.talkSessions(root).map((x) => x.id), [old]);
  // 正在用的那段：先存档再挪走，正在用的变成空的
  const cur = talk.deleteTalk(root, null)!;
  assert.ok(cur && cur !== old);
  assert.equal(talk.readTalk(root).length, 0);
  assert.equal(talk.deleteTalk(root, null), null, '空的就什么都不做');
  // 有 AI 在说：也删，在说的跟着记录挪过去（没说完的回答写进删掉的那份），撤销时一起回来
  const th = talk.threadOf(talk.talkFile(root, old));
  th.votes++;
  assert.equal(talk.deleteTalk(root, old), old);
  assert.equal(th.file, path.resolve(root, '.relay', '已删除的群聊', `${old}.jsonl`));
  assert.deepEqual(talk.talkSessions(root).map((x) => x.id), []);
  talk.restoreTalk(root, old);
  assert.equal(th.file, path.resolve(talk.talkFile(root, old)));
  th.votes--;
  talk.releaseThread(th);

  // 对话（任务）
  init.newTask(root, '第二个任务');
  const hidden = require('../src/ops/hidden') as typeof import('../src/ops/hidden');
  let ts = view.projectView(root).threads;
  assert.deepEqual(ts.map((t) => [t.title, t.current]), [['第一个任务', false], ['第二个任务', true]]);
  hidden.setThreadHidden(root, ts[0].key, true);
  hidden.setThreadHidden(root, ts[1].key, true);
  ts = view.projectView(root).threads;
  assert.deepEqual(ts.map((t) => !!t.hidden), [true, false], '正在做的那段删不掉');
  hidden.setThreadHidden(root, ts[0].key, false);
  assert.equal(view.projectView(root).threads[0].hidden, undefined);

  // 删除正在做的任务：清单清空、左边不再列出，账本里每一棒不动；还没写新任务时能撤销，像没删过一样
  const shape = () => view.projectView(root).threads.map((t) => [t.title, t.current, !!t.hidden]);
  const raw = notes.readTask(root).raw;
  const id = init.deleteTask(root);
  assert.ok(notes.readTask(root).empty);
  assert.deepEqual(shape(), [['第一个任务', false, false], ['第二个任务', false, true], ['', true, false]]);
  assert.throws(() => init.deleteTask(root), /还没有任务/);
  init.restoreTask(root, id);
  assert.equal(notes.readTask(root).raw, raw, '清单原样写回（连同打的勾）');
  assert.deepEqual(shape(), [['第一个任务', false, false], ['第二个任务', true, false]]);
  assert.equal(ledger.loadLedger(root).task?.title, '第二个任务');
  assert.throws(() => init.restoreTask(root, id), /撤销不了/, '已经撤销过了');
  // 全自动在跑（调度锁在它手里）：删不了
  const lock = require('../src/ops/lock') as typeof import('../src/ops/lock');
  const release = lock.acquireLock(root);
  assert.throws(() => init.deleteTask(root), /全自动还在跑，先停止再删/);
  release();
  // 删了以后又写了新任务：撤销不了，删掉的那段还是不列出
  const id2 = init.deleteTask(root);
  init.newTask(root, '第三个任务');
  assert.throws(() => init.restoreTask(root, id2), /撤销不了/);
  assert.deepEqual(shape(), [['第一个任务', false, false], ['第二个任务', false, true], ['第三个任务', true, false]]);
});

test('Claude 桌面版自带的 Claude Code 新的目录（<版本>/<编号>/claude.app）也认得，挑最新、装完整的那份', () => {
  const dir = tmpDir('desk-claude');
  const put = (rel: string) => {
    const exe = path.join(dir, rel, 'claude.app', 'Contents', 'MacOS', 'claude');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '#!/bin/sh\n');
    fs.chmodSync(exe, 0o755);
    return exe;
  };
  put('2.1.284');
  put('2.1.288/aaa-half');
  const good = put('2.1.288/48d54124d3c3');
  fs.writeFileSync(path.join(dir, '2.1.288', '48d54124d3c3', '.verified'), '');
  const was = process.env.RELAY_CLAUDE_DESKTOP_DIR;
  process.env.RELAY_CLAUDE_DESKTOP_DIR = dir;
  try {
    assert.deepEqual(harness.desktopClaude(), { bin: good, version: '2.1.288' });
  } finally {
    if (was === undefined) delete process.env.RELAY_CLAUDE_DESKTOP_DIR;
    else process.env.RELAY_CLAUDE_DESKTOP_DIR = was;
  }
});

test('群聊：时限快到了还在看文件，接着同一段对话请它直接回答；还是没答出来就报「没答完」，不把中途那句「接下来去看……」当回答；额度用完的原话也不当回答', async () => {
  const dir = tmpDir('talk-wrap');
  const bin = tmpDir('talk-wrap-bin');
  const mode = path.join(bin, 'mode');
  const script = [
    '#!/bin/sh',
    '[ "$1" = --version ] && { echo "9.9.9 (Claude Code)"; exit 0; }',
    'cat > /dev/null',
    'prev=""; RES=""; for a in "$@"; do [ "$prev" = --resume ] && RES="$a"; prev="$a"; done',
    `M=$(cat '${mode}')`,
    'if [ "$M" = limit ]; then',
    `  echo '{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"You'"'"'ve hit your session limit · resets 6:20pm (Asia/Taipei)"}]}}'`,
    `  echo '{"type":"result","subtype":"success","is_error":true,"result":"You'"'"'ve hit your session limit · resets 6:20pm (Asia/Taipei)"}'`,
    // 退出码是 0 也一样：只看结果里的 is_error
    '  exit 0',
    'fi',
    'if [ -n "$RES" ] && [ "$M" = wrap ]; then',
    `  echo '{"type":"system","subtype":"init","model":"claude-opus-5","session_id":"sess-wrap-1"}'`,
    `  echo '{"type":"result","subtype":"success","is_error":false,"result":"结论：只是复习提纲，不是完整总结。"}'`,
    '  exit 0',
    'fi',
    `echo '{"type":"system","subtype":"init","model":"claude-opus-5","session_id":"sess-wrap-1"}'`,
    `echo '{"type":"assistant","message":{"model":"claude-opus-5","content":[{"type":"text","text":"接下来抽原书目录看看。"}]}}'`,
    'sleep 30',
  ];
  fs.writeFileSync(path.join(bin, 'claude'), `${script.join('\n')}\n`, { mode: 0o755 });
  const keep = { path: process.env.PATH, wrap: process.env.RELAY_ANSWER_RESERVE_MS };
  process.env.PATH = `${bin}:${keep.path}`;
  process.env.RELAY_ANSWER_RESERVE_MS = '1500';
  harness.clearLocateCache();
  const agent = { name: 'slowpoke', kind: 'cli' as const, cmd: 'claude', tier: 'strong' as const, harness: 'claude' };
  try {
    fs.writeFileSync(mode, 'wrap');
    const t0 = Date.now();
    const r = await talk.askAgentRun(agent, '这份总结完整吗？', dir, { timeoutMs: 6000, idleMs: 20_000 });
    assert.equal(r.text, '结论：只是复习提纲，不是完整总结。');
    assert.ok(Date.now() - t0 < 9000, '没等满时限');
    fs.writeFileSync(mode, 'stuck');
    await assert.rejects(talk.askAgentRun(agent, '这份总结完整吗？', dir, { timeoutMs: 6000, idleMs: 20_000 }), /没答完；最后说到：接下来抽原书目录看看/);
    fs.writeFileSync(mode, 'limit');
    await assert.rejects(talk.askAgentRun(agent, '这份总结完整吗？', dir, { timeoutMs: 6000, idleMs: 20_000 }), /额度/);
  } finally {
    process.env.PATH = keep.path;
    if (keep.wrap === undefined) delete process.env.RELAY_ANSWER_RESERVE_MS;
    else process.env.RELAY_ANSWER_RESERVE_MS = keep.wrap;
    harness.clearLocateCache();
  }
});

test('没写任务时文件夹里的改动不算一棒、不要复核（你在工具里做别的事）；有 AI 建了交接才算。旧版记下的那种对话能删，撤销就回来', () => {
  registry([CODEX, DSH]);
  const { root, write } = project('no-task-edits', '第一个任务');
  init.deleteTask(root);
  const shape = () => view.projectView(root).threads.map((t) => [t.title, t.current, !!t.hidden, t.stints.length]);
  const before = shape();
  write('笔记/总结.md', '自己在工具里写的\n');
  track.track(root);
  assert.equal(ledger.loadLedger(root).stints.length, 0, '不开一棒');
  assert.deepEqual(view.projectView(root).pending, []);
  assert.deepEqual(shape(), before, '左边不多出一段对话');
  // 再改也一样；接着有 AI 按规矩建了交接：从这里起算一棒，前面的改动不算到它头上
  write('笔记/总结.md', '又改了\n');
  track.track(root);
  write('.relay/交接/第1棒-1006-0200-dsh.md', handoff('DeepSeek Harness · deepseek-flash', 'DeepSeek Harness', 'deepseek-flash'));
  write('b.txt', '1\n');
  track.track(root);
  const v = ledger.loadLedger(root);
  assert.equal(v.stints.length, 1);
  assert.deepEqual(v.stints[0].facts?.paths, ['b.txt']);

  // 旧版：没写任务的那一段里记了一棒（截图里删除对话是灰的）。删掉：另起一段、这段藏起来、不再算待复核；撤销就回来
  const { root: r2, write: w2 } = project('no-task-legacy', '第一个任务');
  init.deleteTask(r2);
  w2('.relay/交接/第1棒-1006-0200-dsh.md', handoff('DeepSeek Harness · deepseek-flash', 'DeepSeek Harness', 'deepseek-flash'));
  w2('a.txt', '1\n');
  track.track(r2);
  const legacy = () => view.projectView(r2).threads.map((t) => [t.current, !!t.hidden, t.stints.length]);
  assert.deepEqual(legacy(), [[false, true, 0], [true, false, 1]]);
  assert.ok(notes.readTask(r2).empty);
  const id = init.deleteTask(r2);
  assert.ok(notes.readTask(r2).empty);
  assert.deepEqual(legacy(), [[false, true, 0], [false, true, 1], [true, false, 0]]);
  assert.deepEqual(view.projectView(r2).pending, [], '删掉的那段不算待复核');
  assert.throws(() => init.deleteTask(r2), /还没有任务/, '空的那段没什么可删');
  init.restoreTask(r2, id);
  assert.deepEqual(legacy(), [[false, true, 0], [true, false, 1]]);

  // 有一棒还没交接（你在工具里开着）：也能删，那一棒算在删掉的那一段里，交接了也不算待复核
  const { root: r3, write: w3 } = project('delete-open', '做一件事');
  w3('.relay/交接/第1棒-1006-0300-dsh.md', handoff('DeepSeek Harness · deepseek-flash', 'DeepSeek Harness', 'deepseek-flash', '进行中'));
  w3('c.txt', '1\n');
  track.track(r3);
  assert.ok(ledger.loadLedger(r3).open);
  init.deleteTask(r3);
  w3('.relay/交接/第1棒-1006-0300-dsh.md', handoff('DeepSeek Harness · deepseek-flash', 'DeepSeek Harness', 'deepseek-flash'));
  track.track(r3);
  assert.equal(ledger.loadLedger(r3).open, null);
  assert.deepEqual(view.projectView(r3).pending, []);
  assert.deepEqual(view.projectView(r3).threads.map((t) => [t.current, !!t.hidden, t.stints.length]), [[false, true, 1], [true, false, 0]]);
});

test('换了新任务：旧任务那一段还带着换掉那一刻的清单（打没打勾）和验收；旧版账本没记的，从「做完的任务」存档里对回清单', () => {
  const { root } = project('past-task', '做导出', ['写导出函数', '写测试']);
  notes.editTask(root, { op: 'toggle', index: 0, done: true });
  init.newTask(root, '做导入', ['读文件']);
  init.newTask(root, '做筛选');
  const past = () => view.projectView(root).threads.map((t) => [t.title, t.current, t.items ?? null, t.accept?.state ?? null]);
  const want = [
    ['做导出', false, [{ text: '写导出函数', done: true }, { text: '写测试', done: false }], 'working'],
    ['做导入', false, [{ text: '读文件', done: false }], 'working'],
    ['做筛选', true, null, null],
  ];
  assert.deepEqual(past(), want);
  assert.match(view.projectView(root).threads[0].accept!.headline, /清单 1\/2/);
  // 旧版账本：换任务那一笔没有 prevCopy、prevAccept，清单照样从存档里对回来（验收那时没记，就没有）
  const file = path.join(root, '.relay', 'journal.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  fs.writeFileSync(file, lines.map((e) => JSON.stringify({ ...e, prevCopy: undefined, prevAccept: undefined })).join('\n') + '\n');
  assert.deepEqual(past(), want.map(([title, cur, items]) => [title, cur, items, null]));
  // 存档对不上（有人手改了存档）：不乱配，那几段就没有清单
  fs.writeFileSync(path.join(root, '.relay', '做完的任务.md'), '# 做完的任务\n\n---\n\n# 任务\n\n别的任务\n\n## 进度\n\n- [x] 别的一步\n');
  assert.deepEqual(past().map((t) => t[2]), [null, null, null]);
});
