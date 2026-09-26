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
    assert.deepEqual(vote.readVotes(root).find((x) => x.id === v.id)!.ballots.map((b) => b.voter).sort(), ['a1', 'a2', 'human']);
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
  assert.ok(stuck.timedOut && stuck.idle, JSON.stringify(stuck));
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
