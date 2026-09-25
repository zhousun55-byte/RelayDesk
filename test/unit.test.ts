import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBrief } from '../src/core/brief';
import { claudeWorkIn } from '../src/core/claude-log';
import { normalizeConfig } from '../src/core/config';
import { fillTemplate, shellWords, shq } from '../src/core/launch';
import { pendingReviews, viewLedger, type LedgerEvent, type Stint } from '../src/core/ledger';
import { editTask, handoffFilled, parseHandoff, parseReview, parseTask, taskComplete, taskTemplate, verdictOf } from '../src/core/notes';
import { PRESETS } from '../src/core/presets';
import { globToRegExp, matchProtected } from '../src/core/protected';
import { installProtocol, protocolBlock, protocolState, removeProtocol } from '../src/core/protocol';
import { detectQuota } from '../src/core/quota';
import { redactSecrets } from '../src/core/redact';
import { makeParser } from '../src/core/runner';
import { cliTooOld } from '../src/core/harness';
import { normalizeAgent } from '../src/core/registry';
import { restoreFile, restoreSnapshot, snapChanges, snapFile, takeSnapshot } from '../src/core/snap';
import { parseNameStatusZ, parseNumstatZ } from '../src/core/status';
import { buildTalkPrompt, readTalk, type TalkRow } from '../src/core/talk';
import { memberTier, modelFromLabel, resolveWho, sameModel, tierForModel, type MemberLike } from '../src/core/tier';
import { appendRule, parseBallot, tally } from '../src/core/vote';
import { threadsOf } from '../src/ops/view';
import { ignoredPath } from '../src/ops/watch';

const T = '2026-01-01T00:00:00.000Z';
const pad2 = (n: number) => String(n).padStart(2, '0');

function tmp(name: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-${name}-`)));
}

test('保护路径通配：** 跨目录、* 不跨目录、目录写法', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b.ts'));
  assert.ok(globToRegExp('**/*.env').test('.env'));
  assert.ok(globToRegExp('**/*.env').test('app/prod.env'));
  assert.ok(globToRegExp('*.md').test('README.md'));
  assert.ok(!globToRegExp('*.md').test('docs/a.md'));
  assert.ok(globToRegExp('config/').test('config/prod.json'));
  assert.deepEqual(matchProtected(['a.txt', 'config/x.json'], ['config/']), ['config/x.json']);
  assert.deepEqual(matchProtected(['a.txt'], []), []);
});

test('diff -z 解析：name-status 与 numstat（含改名、二进制、中文）', () => {
  const ns = parseNameStatusZ('M\0a.txt\0R100\0old.md\0new.md\0A\0图.png\0');
  assert.deepEqual(ns, [
    { status: 'M', path: 'a.txt' },
    { status: 'R', orig: 'old.md', path: 'new.md' },
    { status: 'A', path: '图.png' },
  ]);
  const num = parseNumstatZ('3\t1\ta.txt\0' + '0\t0\t\0old.md\0new.md\0' + '-\t-\t图.png\0');
  assert.deepEqual(num.get('a.txt'), { added: 3, removed: 1 });
  assert.deepEqual(num.get('new.md'), { added: 0, removed: 0 });
  assert.deepEqual(num.get('图.png'), { added: null, removed: null });
});

test('命令模板：路径转义、带引号的占位符也对、分词认引号', () => {
  assert.equal(shq("it's"), `'it'\\''s'`);
  assert.equal(fillTemplate('open -a Cursor {{dir}}', { dir: '/a b/c' }), "open -a Cursor '/a b/c'");
  assert.equal(fillTemplate('code "{{dir}}"', { dir: '/x' }), "code '/x'");
  assert.equal(fillTemplate('x {{unknown}}', {}), 'x {{unknown}}');
  assert.deepEqual(shellWords('open -a "Xiaomi MiMo" {{dir}}'), ['open', '-a', 'Xiaomi MiMo', '{{dir}}']);
  assert.deepEqual(shellWords("a 'b c' d\\ e"), ['a', 'b c', 'd e']);
});

test('脱敏：密钥换成 [REDACTED]，普通内容不动', () => {
  const out = redactSecrets('key=sk-abcdefghijklmnopqrstuv\nghp_abcdefghijklmnopqrstuvwxyz\nhello world');
  assert.ok(!out.includes('sk-abcdefghijklmnop'));
  assert.ok(!out.includes('ghp_abcdef'));
  assert.ok(out.includes('hello world'));
  assert.equal(redactSecrets('+ const x = 1;'), '+ const x = 1;');
});

test('项目配置：缺字段补默认、类型不对说人话', () => {
  const d = normalizeConfig({});
  assert.equal(d.gate.command, '');
  assert.throws(() => normalizeConfig({ protectedPaths: 'nope' }), /protectedPaths/);
  assert.throws(() => normalizeConfig({ gate: null }), /gate/);
  assert.deepEqual(normalizeConfig({ protectedPaths: [' a ', ''] }).protectedPaths, ['a']);
});

test('成员配置校验：桌面程序要有 {{dir}}（旧的 {{worktree}} 也认），接口要地址和变量名', () => {
  assert.throws(() => normalizeAgent({ name: '中文', cmd: 'x' }), /名字/);
  assert.throws(() => normalizeAgent({ name: 'cur', kind: 'app', cmd: 'open -a Cursor' }), /\{\{dir\}\}/);
  assert.doesNotThrow(() => normalizeAgent({ name: 'cur', kind: 'app', cmd: 'open -a Cursor {{worktree}}' }));
  assert.throws(() => normalizeAgent({ name: 'ds', kind: 'api', api: { baseUrl: 'x', model: 'm', apiKeyEnv: 'K' } }), /http/);
  assert.throws(() => normalizeAgent({ name: 'ds', kind: 'api', api: { baseUrl: 'https://a', model: 'm', apiKeyEnv: 'sk-xx yy' } }), /环境变量/);
  assert.equal(normalizeAgent({ name: 'claude', cmd: 'claude', tier: 'strong' }).kind, 'cli');
  assert.equal(normalizeAgent({ name: 'c', cmd: 'c', tier: 'weak', tierSet: true }).tierSet, true);
  const api = normalizeAgent({ name: 'ds', kind: 'api', model: '旧模型', api: { baseUrl: 'https://api.deepseek.com/', model: '新模型', apiKeyEnv: 'DEEPSEEK_API_KEY' } });
  assert.equal(api.api?.baseUrl, 'https://api.deepseek.com');
  assert.equal(api.model, '新模型');
  for (const p of PRESETS.filter((x) => !['api', 'cli'].includes(x.id))) assert.doesNotThrow(() => normalizeAgent(p.agent), p.id);
});

test('强弱：看模型不看工具；小号算弱；不知道模型的用名单里记的；你设过的以你为准', () => {
  assert.equal(tierForModel('claude-opus-5-5'), 'strong');
  // 工具报的是给人看的名字（2026-09-25 Cursor Agent 真实报的「Grok 4.6 Fast」被当成了弱）。
  assert.equal(tierForModel('Grok 4.6 Fast'), 'strong');
  assert.equal(tierForModel('GPT 6'), 'strong');
  assert.equal(tierForModel('Gemini 3 Pro'), 'strong');
  assert.equal(tierForModel('DeepSeek V4 Flash'), 'weak');
  assert.equal(tierForModel('gpt-6'), 'strong');
  assert.equal(tierForModel('gpt-6-mini'), 'weak');
  assert.equal(tierForModel('deepseek-v4-flash'), 'weak');
  assert.equal(tierForModel('deepseek-v4-pro'), 'weak');
  assert.equal(tierForModel('glm-5.3'), 'weak');
  assert.equal(tierForModel('cursor-grok-4.6-high-fast'), 'strong');
  assert.equal(tierForModel('claude-haiku-4-5'), 'weak');
  assert.equal(tierForModel(''), 'unknown');
  assert.equal(memberTier({ tier: 'strong' }, 'deepseek-v4-flash'), 'weak', 'Claude Code 接 DeepSeek 就是弱');
  assert.equal(memberTier({ tier: 'strong' }, undefined), 'strong', '桌面程序看不出模型，用记下的');
  assert.equal(memberTier({ tier: 'strong', tierSet: true }, 'deepseek-v4-flash'), 'strong', '你设过的优先');
});

test('认出交接里写的身份：对上工具和模型；自称和实际对不上时按模型定强弱', () => {
  const members: MemberLike[] = [
    { name: 'claude', label: 'Claude Code', model: 'deepseek-v4-flash', tier: 'weak', harness: 'claude' },
    { name: 'codex', label: 'Codex', model: 'gpt-6', tier: 'strong', harness: 'codex' },
    { name: 'cursor', label: 'Cursor', tier: 'weak' },
  ];
  const a = resolveWho({ who: 'Claude Code · deepseek-v4-flash' }, members);
  assert.equal(a.member, 'claude');
  assert.equal(a.tier, 'weak');
  const b = resolveWho({ who: 'Codex', model: 'gpt-6' }, members);
  assert.equal(b.member, 'codex');
  assert.equal(b.tier, 'strong');
  const c = resolveWho({ who: 'Claude Code' }, members);
  assert.equal(c.member, 'claude', '没写模型：用名单里这个工具的');
  assert.equal(c.tier, 'weak');
  const d = resolveWho({ who: 'Claude · claude-opus-5-5' }, members);
  assert.equal(d.tier, 'strong', '桌面版 Claude 用的是 Opus');
  assert.equal(resolveWho({}, members).tier, 'unknown');
});

test('两个 Claude：接了 DeepSeek 的和官方账号的按模型分开；没写模型按弱的算；你给一位定的强弱不影响另一位', () => {
  assert.ok(sameModel('opus', 'claude-opus-5-5'));
  assert.ok(sameModel('Opus 5.5', 'claude-opus-5-5'));
  assert.ok(sameModel('DeepSeek V4 Flash', 'deepseek-v4-flash'));
  assert.ok(!sameModel('opus', 'deepseek-flash'));
  assert.ok(!sameModel('gpt-6', 'gpt-6-astra'));
  assert.equal(modelFromLabel('Claude Code · Opus 5.5'), 'Opus 5.5');
  assert.equal(modelFromLabel('Codex · gpt-6'), 'gpt-6');
  const members: MemberLike[] = [
    { name: 'claude', label: 'Claude Code', model: 'deepseek-flash', tier: 'weak', harness: 'claude' },
    { name: 'claude-official', label: 'Claude Code 官方账号', model: 'claude-opus-5-5', tier: 'strong', harness: 'claude-official' },
    { name: 'claude-app', label: 'Claude', model: 'claude-opus-5-5', tier: 'strong' },
    { name: 'codex', label: 'Codex', model: 'gpt-6', tier: 'strong', harness: 'codex' },
  ];
  const opus = resolveWho({ who: 'Claude Code · Opus 5.5' }, members);
  assert.equal(opus.member, 'claude-official');
  assert.equal(opus.tier, 'strong');
  assert.equal(resolveWho({ tool: 'Claude Code', model: 'claude-opus-5-5' }, members).member, 'claude-official');
  const ds = resolveWho({ who: 'Claude Code · deepseek-flash' }, members);
  assert.equal(ds.member, 'claude');
  assert.equal(ds.tier, 'weak');
  const bare = resolveWho({ who: 'Claude Code' }, members);
  assert.equal(bare.member, 'claude', '只写了 Claude Code：两位里按弱的算');
  assert.equal(bare.tier, 'weak');
  const set = members.map((m) => (m.name === 'claude' ? { ...m, tierSet: true } : m));
  assert.equal(resolveWho({ who: 'Claude Code · Opus 5.5' }, set).tier, 'strong', '你给 DeepSeek 那位定的强弱不影响官方账号');
  // 版本对不上、但同一家（2026-09-24 真实跑出来的：名单记 claude-opus-5-5，命令行 --model opus 实际是 claude-opus-5）。
  const older = resolveWho({ tool: 'Claude Code', model: 'claude-opus-5' }, members);
  assert.equal(older.member, 'claude-official');
  assert.equal(older.label, 'Claude Code 官方账号 · claude-opus-5', '记实际的模型');
  assert.equal(older.tier, 'strong');
  const pro = resolveWho({ tool: 'Claude Code', model: 'deepseek-v4-pro' }, members);
  assert.equal(pro.member, 'claude', 'DeepSeek 换了个型号也还是那一位');
  assert.equal(pro.tier, 'weak');
});

test('Claude Code 的会话记录：只认这段时间里改项目文件的回复（.relay/、只读、子代理、别的文件夹都不算）；中文路径跨读块也认得', () => {
  const home = tmp('cclog');
  const root = path.join(home, '滤镜项目');
  fs.mkdirSync(root);
  const dir = path.join(home, '.claude', 'projects', '-x-');
  fs.mkdirSync(dir, { recursive: true });
  const from = new Date(Date.now() - 10 * 60_000).toISOString();
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
  const row = (o: { model: string; ts: string; tool?: string; file?: string; side?: boolean; entry?: string }) =>
    JSON.stringify({
      type: 'assistant',
      isSidechain: !!o.side,
      entrypoint: o.entry ?? 'cli',
      message: { model: o.model, content: [{ type: 'tool_use', name: o.tool ?? 'Write', input: { file_path: o.file ?? path.join(root, 'app.js'), content: 'x' } }] },
      timestamp: o.ts,
    });
  const lines = [
    row({ model: 'deepseek-flash', ts: at(60) }), // 太早
    row({ model: 'deepseek-flash', ts: at(5) }), // 算
    row({ model: 'claude-opus-5-5', ts: at(4), file: path.join(root, '.relay', '交接', '第1棒.md') }), // 写交接不算
    row({ model: 'claude-opus-5-5', ts: at(4), tool: 'Read' }), // 只读不算
    row({ model: 'claude-haiku-4-5', ts: at(4), side: true }), // 子代理不算
    row({ model: 'kimi-k3', ts: at(4), file: path.join(home, '别的项目', 'a.js') }), // 别的文件夹不算
    JSON.stringify({ type: 'user', message: { content: '改一下' }, timestamp: at(3) }),
  ];
  // 最后一条要找的记录正好在项目路径的中文字中间被 1MB 的读块切开：往回读时要按字节拼上，不然认不出是这个项目。
  const target = row({ model: 'claude-opus-5-5', ts: at(2), entry: 'claude-desktop', file: path.join(root, '界面.js') });
  const head = Buffer.from(lines.join('\n') + '\n');
  const t = Buffer.from(target + '\n');
  const cut = head.length + t.indexOf(Buffer.from('滤镜项目')) + 1;
  const fillerSize = cut + 1024 * 1024 - head.length - t.length;
  const stamp = at(1);
  const empty = JSON.stringify({ type: 'user', timestamp: stamp, pad: '' }).length + 1;
  const n = Math.ceil(fillerSize / 50_000);
  const sizes = Array.from({ length: n }, (_, i) => Math.floor(fillerSize / n) + (i === n - 1 ? fillerSize % n : 0));
  const fill = sizes.map((size) => JSON.stringify({ type: 'user', timestamp: stamp, pad: 'x'.repeat(size - empty) }) + '\n').join('');
  assert.equal(Buffer.byteLength(fill), fillerSize);
  fs.writeFileSync(path.join(dir, 's.jsonl'), Buffer.concat([head, t, Buffer.from(fill)]));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const got = claudeWorkIn(root, from, new Date().toISOString());
    assert.deepEqual(
      got.map((w) => [w.model, w.count, w.entry]).sort(),
      [
        ['claude-opus-5-5', 1, 'claude-desktop'],
        ['deepseek-flash', 1, 'cli'],
      ]
    );
    assert.deepEqual(claudeWorkIn(root, at(1), new Date().toISOString()), [], '这段时间没人改');
  } finally {
    process.env.HOME = oldHome;
  }
});

test('任务清单：读出标题、进度、约定；模板里的占位不算步骤', () => {
  const empty = parseTask(taskTemplate());
  assert.equal(empty.empty, true);
  assert.equal(empty.items.length, 0);
  const t = parseTask('# 任务\n\n做一个滤镜\n\n细节…\n\n## 进度\n\n- [x] 调色\n- [ ] 导出\n\n## 约定\n\n- 用 XMP\n');
  assert.equal(t.title, '做一个滤镜');
  assert.deepEqual(t.items, [
    { done: true, text: '调色' },
    { done: false, text: '导出' },
  ]);
  assert.equal(t.rules, '- 用 XMP');
  assert.equal(taskComplete(t), false);
  assert.equal(taskComplete(parseTask('# 任务\n\n做\n\n## 进度\n\n- [x] a\n- [X] b\n')), true);
});

test('网页上改任务：改标题、打勾、加一步、删一步；模板里的占位换成第一步，别的内容不动', () => {
  const root = tmp('task-edit');
  const file = path.join(root, '.relay', '任务.md');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, taskTemplate());
  let t = editTask(root, { op: 'title', text: '做滤镜' });
  assert.equal(t.title, '做滤镜');
  t = editTask(root, { op: 'add', text: '读代码' });
  assert.deepEqual(t.items, [{ done: false, text: '读代码' }], '模板里的占位换成了第一步');
  editTask(root, { op: 'add', text: '写导出' });
  t = editTask(root, { op: 'toggle', index: 0 });
  assert.deepEqual(
    t.items.map((i) => i.done),
    [true, false]
  );
  t = editTask(root, { op: 'toggle', index: 0, done: true });
  assert.equal(t.items[0].done, true, '给了 done 就按它来，不是来回切');
  t = editTask(root, { op: 'remove', index: 1 });
  assert.deepEqual(
    t.items.map((i) => i.text),
    ['读代码']
  );
  assert.match(t.raw, /## 约定/);
  assert.throws(() => editTask(root, { op: 'toggle', index: 5 }), /没有这一步/);
  assert.throws(() => editTask(root, { op: 'add', text: '  ' }), /先写这一步/);
  // 自己写的任务没有「进度」一节：加在「约定」前面，约定原样留着。
  fs.writeFileSync(file, '# 任务\n\n自己写的任务\n\n## 约定\n\n- 别动 config\n');
  t = editTask(root, { op: 'add', text: '第一步' });
  assert.deepEqual(
    t.items.map((i) => i.text),
    ['第一步']
  );
  assert.equal(t.title, '自己写的任务');
  assert.equal(t.rules, '- 别动 config');
  assert.ok(t.raw.indexOf('## 进度') < t.raw.indexOf('## 约定'));
});

test('对话历史：按换任务切成一段一段，棒归到它开始时的那段；空的第一段并进下一段；旧版账本从存档里对标题', () => {
  const at = (h: number, m = 0) => `2026-01-01T${pad2(h)}:${pad2(m)}:00.000Z`;
  const ev: LedgerEvent[] = [
    { type: 'init', ts: at(0), snap: 'S0' },
    { type: 'task', ts: at(1), title: 'A', prev: '' },
    { type: 'stint', ts: at(1, 30), stint: stint(1, { startedAt: at(1, 10), review: 'done' }) },
    { type: 'task', ts: at(2), title: 'B', prev: 'A' },
    { type: 'stint', ts: at(2, 30), stint: stint(2, { startedAt: at(2, 10) }) },
  ];
  const root = tmp('threads');
  let th = threadsOf(root, viewLedger(ev), parseTask(taskTemplate('B（后来改过）')));
  assert.deepEqual(
    th.map((t) => [t.title, t.stints, t.current, t.pending]),
    [
      ['A', [1], false, 0],
      ['B（后来改过）', [2], true, 1],
    ],
    '最新一段用任务文件里现在的标题'
  );
  assert.equal(th[0].from, at(0), '接入到写下第一个任务之间是空的，并进了第一段');
  assert.equal(th[0].to, at(2));
  // 旧版账本：换任务时没记旧任务。存档比换任务的次数少，说明接入时的任务是空的。
  const old = ev.map((e) => (e.type === 'task' ? { ...e, prev: undefined } : e));
  fs.mkdirSync(path.join(root, '.relay'));
  fs.writeFileSync(path.join(root, '.relay', '做完的任务.md'), `# 做完的任务\n\n---\n\n> 存档于 x\n\n${taskTemplate('A')}`);
  th = threadsOf(root, viewLedger(old), parseTask(taskTemplate('B')));
  assert.deepEqual(
    th.map((t) => t.title),
    ['A', 'B']
  );
  // 接入时就写了任务 X：存档里有 X 和 A，第一段就是 X。
  fs.writeFileSync(path.join(root, '.relay', '做完的任务.md'), `# 做完的任务\n\n---\n\n> 存档于 x\n\n${taskTemplate('X')}\n---\n\n> 存档于 y\n\n${taskTemplate('A')}`);
  th = threadsOf(root, viewLedger(old), parseTask(taskTemplate('B')));
  assert.deepEqual(
    th.map((t) => t.title),
    ['X', 'A', 'B']
  );
});

test('交接：认出身份、状态、各节；只建了空模板的不算写过', () => {
  const h = parseHandoff('# 交接：Codex · gpt-6\n\n- 工具：\n- 模型：gpt-6\n- 状态：已交接\n\n## 做了什么\n\n- 加了导出按钮\n- 修了 bug\n\n## 没做完 / 下一步\n\n- 写测试\n');
  assert.equal(h.who, 'Codex · gpt-6');
  assert.equal(h.tool, undefined, '空的「工具：」不会把下一行吃进去');
  assert.equal(h.model, 'gpt-6');
  assert.equal(h.state, 'handed');
  assert.equal(h.summary, '加了导出按钮');
  assert.match(h.next, /写测试/);
  assert.equal(handoffFilled(h), true);
  assert.equal(parseHandoff('# 交接：x\n\n- 状态：全部完成\n').state, 'finished');
  assert.equal(parseHandoff('# 交接：x\n\n- 状态：卡住了，缺密钥\n').state, 'stuck');
  const blank = parseHandoff('# 交接：x\n\n- 状态：进行中\n\n## 做了什么\n\n- \n\n## 没做完 / 下一步\n\n- \n');
  assert.equal(blank.state, 'working');
  assert.equal(handoffFilled(blank), false);
  // 真实跑出来的交接：第一条是「读了接力本……」，一句话摘要要挑真干了活的那条。
  const real = parseHandoff('# 交接：Claude Code · deepseek-flash\n\n## 做了什么\n\n- 读了 `.relay/接力本.md`、`.relay/任务.md`：这是第 1 棒\n- 新建 `wc.py`：输出行数、字数、字符数\n');
  assert.equal(real.summary, '新建 `wc.py`：输出行数、字数、字符数');
  assert.equal(parseHandoff('# 交接：x\n\n## 做了什么\n\n- 读了代码，没发现要改的\n').summary, '读了代码，没发现要改的', '只有这一条时还是用它');
});

test('复核结论：认出复核的是第几棒、结论是哪一种', () => {
  const r = parseReview('# 复核：第 7 棒（Claude Code · deepseek）\n\n- 复核人：Codex · gpt-6\n- 结论：有问题，已修好\n\n## 发现的问题和怎么处理的\n\n- 少了空值判断，补上了\n', '.relay/复核/第7棒.md');
  assert.deepEqual(r.targets, [7]);
  assert.equal(r.verdict, 'fixed');
  assert.equal(r.by, 'Codex · gpt-6');
  assert.equal(verdictOf('没问题'), 'ok');
  assert.equal(verdictOf('改坏了，已退回'), 'reverted');
  assert.equal(verdictOf('有问题，还没修'), 'problem');
  assert.equal(verdictOf('检查没通过'), 'problem');
  assert.equal(verdictOf('（没问题 / 有问题，已修好）'), 'unknown', '模板里的占位不算');
});

test('额度用完：认得各家的提示，算出恢复时间；普通报错和正常说明不算', () => {
  const now = new Date('2026-09-24T10:00:00');
  const a = detectQuota("ERROR: You've hit your usage limit. Upgrade to Pro or try again in 2 hours 5 minutes.", now);
  assert.equal(a.hit, true);
  assert.equal(new Date(a.until!).getTime(), now.getTime() + (2 * 60 + 5) * 60_000);
  const b = detectQuota('Claude AI usage limit reached. Your limit will reset at 3pm.', now);
  assert.equal(b.hit, true);
  assert.equal(new Date(b.until!).getHours(), 15);
  const c = detectQuota('Claude AI usage limit reached|1790400000', now);
  assert.equal(c.hit, true);
  assert.equal(c.until, new Date(1790400000 * 1000).toISOString());
  assert.equal(detectQuota('API 返回 HTTP 402：Insufficient Balance', now).hit, true);
  assert.equal(detectQuota('错误：余额不足或无可用资源包', now).hit, true);
  assert.equal(detectQuota('TypeError: undefined is not a function', now).hit, false);
  assert.equal(detectQuota('我给页面加了一个显示额度的小组件。', now).hit, false);

  // 新版 Claude Code 的原话（2026-09-24 真实跑出来的）：按后面写的时区算，跟这台电脑在哪个时区无关。
  const at = new Date('2026-09-24T15:53:58Z'); // 上海 23:53
  const s1 = detectQuota("23:53:58 说：You've hit your session limit · resets 3:50am (Asia/Shanghai)", at);
  assert.equal(s1.hit, true, '认得 session limit');
  assert.equal(s1.until, '2026-09-24T19:50:00.000Z', '上海第二天 3:50');
  assert.equal(detectQuota("You've hit your session limit · resets 3:50am (America/New_York)", at).until, '2026-09-25T07:50:00.000Z', '纽约 3:50（夏令时）');
  const w = detectQuota('Weekly limit reached ∙ resets Oct 9, 10am (Asia/Shanghai)', at);
  assert.equal(w.hit, true);
  assert.equal(w.until, '2026-10-09T02:00:00.000Z', '带日期的恢复时间');
  assert.equal(detectQuota("You've hit your Opus limit · resets Sep 26 at 9:30pm (Asia/Shanghai)", at).until, '2026-09-26T13:30:00.000Z');
  assert.equal(detectQuota("You've hit your weekly limit · resets Jan 2 (UTC)", at).until, '2027-01-02T00:00:00.000Z', '过了今年的就是明年');
  // 命令行太旧不是额度用完。
  const old = "API Error: 400 Claude Code 2.1.263 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";
  assert.equal(detectQuota(old, at).hit, false);
  assert.equal(cliTooOld(old), '2.1.280');
  assert.equal(cliTooOld('我改了 wc.py 的版本号'), null);
});

test('Claude Code 输出里的模型：以回复里记的为准，去掉 [1m] 这种上下文档位；<synthetic>（工具自己拼的话）不算', () => {
  const run = (lines: unknown[]) => {
    const p = makeParser('claude');
    const shown = lines.flatMap((l) => p.line(JSON.stringify(l)));
    return { model: p.model(), shown };
  };
  const init = (model: string) => ({ type: 'system', subtype: 'init', model });
  const reply = (model: string) => ({ type: 'assistant', message: { model, content: [{ type: 'text', text: '好' }] } });
  let r = run([init('claude-opus-5'), reply('claude-opus-5-5'), reply('claude-opus-5-5')]);
  assert.equal(r.model, 'claude-opus-5-5');
  assert.deepEqual(
    r.shown.filter((x) => x.startsWith('模型：')),
    ['模型：claude-opus-5', '模型：claude-opus-5-5'],
    '日志里看得到实际用的是哪个'
  );
  r = run([init('deepseek-flash[1m]'), reply('<synthetic>')]);
  assert.equal(r.model, 'deepseek-flash', '只有 init：去掉方括号');
  assert.equal(run([init('deepseek-flash[1m]'), reply('deepseek-flash')]).shown.filter((x) => x.startsWith('模型：')).length, 1, '去掉方括号后一样，不重复显示');
});

test('接力规矩：写进 AGENTS.md / CLAUDE.md 不碰你自己写的；重复执行不重复；CLAUDE.md 引用了 AGENTS.md 就不写', () => {
  const dir = tmp('proto');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# 我的规矩\n\n用两个空格缩进。\n');
  assert.deepEqual(installProtocol(dir), ['AGENTS.md', 'CLAUDE.md']);
  const a = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(a.startsWith('# 我的规矩\n\n用两个空格缩进。\n'));
  assert.ok(a.includes(protocolBlock()));
  assert.deepEqual(installProtocol(dir), [], '第二次什么都不改');
  assert.equal(protocolState(dir), 'ok');
  // 旧版的规矩：更新
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').replace('开工先读', '开工先看'));
  assert.equal(protocolState(dir), 'old');
  assert.deepEqual(installProtocol(dir), ['CLAUDE.md']);
  // 去掉：只剩规矩的文件整个删掉，你的内容留着
  assert.deepEqual(removeProtocol(dir).sort(), ['AGENTS.md', 'CLAUDE.md']);
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), '# 我的规矩\n\n用两个空格缩进。\n');
  assert.ok(!fs.existsSync(path.join(dir, 'CLAUDE.md')));
  const d2 = tmp('proto2');
  fs.writeFileSync(path.join(d2, 'CLAUDE.md'), '@AGENTS.md\n');
  assert.deepEqual(installProtocol(d2), ['AGENTS.md']);
  assert.equal(fs.readFileSync(path.join(d2, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
});

test('快照：不碰你自己的 git；改过的改回去、删掉的找回来、新加的删掉；单个文件也能恢复', () => {
  const dir = tmp('snap');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'big.js'), 'dep\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'secret.env\n');
  fs.writeFileSync(path.join(dir, 'secret.env'), 'K=1\n');
  const s1 = takeSnapshot(dir, '一');
  assert.equal(s1.changed, true);
  assert.equal(takeSnapshot(dir, '再存').changed, false, '没变化不新存');
  assert.equal(snapFile(dir, s1.sha, 'node_modules/x/big.js'), null, 'node_modules 不进快照');
  assert.equal(snapFile(dir, s1.sha, 'secret.env'), null, '.gitignore 照样生效');
  assert.ok(!fs.existsSync(path.join(dir, '.git')), '没有给你建 git');

  fs.writeFileSync(path.join(dir, 'a.txt'), '2\n');
  fs.mkdirSync(path.join(dir, 'new'));
  fs.writeFileSync(path.join(dir, 'new', 'b.txt'), 'b\n');
  const s2 = takeSnapshot(dir, '二');
  assert.deepEqual(
    snapChanges(dir, s1.sha, s2.sha).map((f) => [f.status, f.path]),
    [
      ['M', 'a.txt'],
      ['A', 'new/b.txt'],
    ]
  );
  const r = restoreSnapshot(dir, s1.sha);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), '1\n');
  assert.ok(!fs.existsSync(path.join(dir, 'new')), '新加的文件和空文件夹都删掉');
  assert.equal(fs.readFileSync(path.join(dir, 'node_modules', 'x', 'big.js'), 'utf8'), 'dep\n', '不在快照里的不动');
  assert.equal(fs.readFileSync(path.join(dir, 'secret.env'), 'utf8'), 'K=1\n');
  restoreSnapshot(dir, r.safety);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), '2\n', '退回也能撤销');
  assert.equal(fs.readFileSync(path.join(dir, 'new', 'b.txt'), 'utf8'), 'b\n');
  restoreFile(dir, s1.sha, 'a.txt');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), '1\n');
  restoreFile(dir, s1.sha, 'new/b.txt');
  assert.ok(!fs.existsSync(path.join(dir, 'new', 'b.txt')));
});

test('快照：在你的 git 仓库里也不留痕迹（不改索引、不提交）', () => {
  const dir = tmp('snap-git');
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const g = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  g(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
  g(['add', 'a.txt']);
  g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  fs.mkdirSync(path.join(dir, '.relay'));
  fs.writeFileSync(path.join(dir, '.relay', '.gitignore'), 'snapshots/\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), '2\n');
  const before = g(['status', '--porcelain']);
  takeSnapshot(dir, '一');
  assert.equal(g(['status', '--porcelain']), before);
  assert.equal(g(['rev-list', '--count', 'HEAD']), '1');
});

function stint(id: number, extra: Partial<Stint> = {}): Stint {
  return { id, kind: 'work', who: { label: 'X', tier: 'weak' }, via: 'native', startedAt: T, endedAt: T, from: `S${id - 1}`, to: `S${id}`, status: 'handed', review: 'needed', ...extra };
}

test('账本：同一棒记好几次取最后一条；退回作废之后的棒，撤销退回又回来；下一棒从哪算', () => {
  const ev: LedgerEvent[] = [
    { type: 'init', ts: T, snap: 'S0' },
    { type: 'stint', ts: T, stint: stint(1, { status: 'working', to: undefined }) },
    { type: 'stint', ts: T, stint: stint(1) },
    { type: 'stint', ts: T, stint: stint(2) },
    { type: 'stint', ts: T, stint: stint(3) },
  ];
  let v = viewLedger(ev);
  assert.equal(v.stints.length, 3);
  assert.equal(v.stints[0].status, 'handed');
  assert.equal(v.base, 'S3');
  assert.equal(v.open, null);
  ev.push({ type: 'rollback', ts: T, to: 'S1', label: '第 2 棒之前', safety: 'X', after: 'S1b', dropped: [2, 3] });
  v = viewLedger(ev);
  assert.deepEqual(
    v.stints.map((s) => !!s.rolledBack),
    [false, true, true]
  );
  assert.equal(v.base, 'S1b');
  ev.push({ type: 'rollback', ts: T, to: 'X', label: '退回之前', safety: 'Y', after: 'S3b', dropped: [], restored: [2, 3] });
  v = viewLedger(ev);
  assert.deepEqual(
    v.stints.map((s) => !!s.rolledBack),
    [false, false, false]
  );
  ev.push({ type: 'base', ts: T, snap: 'S4', why: '更新规矩' });
  assert.equal(viewLedger(ev).base, 'S4');
  // 终审、复核的棒不用复核：旧账上记成了「待复核」也按不用复核算。
  ev.push({ type: 'stint', ts: T, stint: stint(4, { kind: 'final', review: 'needed' }) });
  ev.push({ type: 'stint', ts: T, stint: stint(5, { kind: 'review', review: 'needed' }) });
  const w = viewLedger(ev);
  assert.deepEqual(
    w.stints.filter((x) => x.id >= 4).map((x) => x.review),
    ['skip', 'skip']
  );
  assert.ok(!pendingReviews(w).some((x) => x.id >= 4));
});

test('账本：给旧棒补记复核、标记不用复核，下一棒还是从最后一棒结束的地方算', () => {
  const ev: LedgerEvent[] = [
    { type: 'init', ts: T, snap: 'S0' },
    { type: 'stint', ts: T, stint: stint(1, { status: 'working', to: undefined }) },
    { type: 'stint', ts: T, stint: stint(1) },
    { type: 'stint', ts: T, stint: stint(2, { status: 'working', to: undefined }) },
    { type: 'stint', ts: T, stint: stint(2) },
    // 第 2 棒复核了第 1 棒：第 1 棒原样重存一遍，带上复核结论。
    { type: 'stint', ts: T, stint: stint(1, { review: 'done' }) },
  ];
  assert.equal(viewLedger(ev).base, 'S2', '补记复核不能把起点拉回第 1 棒结束的地方');
  ev.push({ type: 'stint', ts: T, stint: stint(2, { review: 'skip' }) });
  assert.equal(viewLedger(ev).base, 'S2');
  // 同一棒结束的快照真的变了（比如后来补上了交接、重新对了账），起点跟着走。
  ev.push({ type: 'stint', ts: T, stint: stint(2, { to: 'S2b' }) });
  assert.equal(viewLedger(ev).base, 'S2b');
});

test('接力本：有待复核时先写复核（给出改动文件、看文件原样的命令、结论写哪）；列出强弱名单和交接格式', () => {
  const events: LedgerEvent[] = [
    { type: 'init', ts: T, snap: 'S0' },
    { type: 'stint', ts: T, stint: stint(1, { who: { label: 'Codex · gpt-6', tier: 'strong', member: 'codex' }, review: 'skip', handoff: '.relay/交接/第1棒.md', summary: '搭好了架子' }) },
    { type: 'stint', ts: T, stint: stint(2, { who: { label: 'Claude Code · deepseek-v4-flash', tier: 'weak' }, handoff: '.relay/交接/第2棒.md', facts: { files: 2, added: 10, removed: 1, paths: ['a', 'b'] } }) },
  ];
  const handoffs = new Map([
    ['.relay/交接/第1棒.md', parseHandoff('# 交接：Codex\n\n- 状态：已交接\n\n## 做了什么\n\n- 搭好了架子\n', '.relay/交接/第1棒.md')],
    ['.relay/交接/第2棒.md', parseHandoff('# 交接：Claude Code\n\n- 状态：已交接\n\n## 做了什么\n\n- 加了按钮\n\n## 没做完 / 下一步\n\n- 写导出\n', '.relay/交接/第2棒.md')],
  ]);
  const text = buildBrief({
    task: parseTask('# 任务\n\n做滤镜\n\n## 进度\n\n- [x] 调色\n- [ ] 导出\n'),
    ledger: viewLedger(events),
    handoffs,
    members: [
      { label: 'Codex', model: 'gpt-6', tier: 'strong' },
      { label: 'Claude Code', model: 'deepseek-v4-flash', tier: 'weak' },
    ],
    gateCommand: 'npm test',
    protectedPaths: ['.env'],
    nextId: 3,
    now: new Date(T),
  });
  assert.match(text, /## 先复核（1 棒待复核）/);
  assert.match(text, /第 2 棒 · Claude Code · deepseek-v4-flash（弱）/);
  assert.match(text, /\.relay\/复核\/第2棒\.diff/);
  assert.match(text, /git --git-dir=\.relay\/snapshots --work-tree=\. show S1:文件路径/);
  assert.match(text, /结论写到：`\.relay\/复核\/第2棒\.md`/);
  assert.match(text, /进度（1\/2）/);
  assert.match(text, /- 强：Codex（gpt-6）/);
  assert.match(text, /- 弱：Claude Code（deepseek-v4-flash）/);
  assert.match(text, /第3棒-月日-时分-你的工具名\.md/);
  assert.match(text, /写导出/, '上一棒的下一步');
  assert.match(text, /npm test/);
  assert.match(text, /不许改：`\.env`/);
  const clean = buildBrief({ task: parseTask(taskTemplate()), ledger: viewLedger([{ type: 'init', ts: T, snap: 'S0' }]), handoffs: new Map(), members: [], gateCommand: '', protectedPaths: [], nextId: 1, now: new Date(T) });
  assert.doesNotMatch(clean, /先复核/);
  assert.match(clean, /还没有写下任务/);
});

test('盯文件夹：git、依赖、接力台自己写的都不管；任务、交接、复核结论要管', () => {
  assert.equal(ignoredPath('.git/index'), true);
  assert.equal(ignoredPath('node_modules/a/b.js'), true);
  assert.equal(ignoredPath('.relay/snapshots/objects/ab'), true);
  assert.equal(ignoredPath('.relay/接力本.md'), true);
  assert.equal(ignoredPath('.relay/复核/第2棒.diff'), true);
  assert.equal(ignoredPath('.relay/任务.md'), false);
  assert.equal(ignoredPath('.relay/交接/第2棒.md'), false);
  assert.equal(ignoredPath('.relay/复核/第2棒.md'), false);
  assert.equal(ignoredPath('src/app.ts'), false);
});

test('投票：认出投给谁（各种写法），投了没有的方案算弃权；计票不分强弱，平票都算领先', () => {
  assert.deepEqual(parseBallot('投票：B\n理由：更稳', ['A', 'B']), { choice: 'B', reason: '更稳' });
  assert.equal(parseBallot('**投票：** 方案 a\n理由：x', ['A', 'B']).choice, 'A');
  assert.equal(parseBallot('我选 B，因为它简单', ['A', 'B']).choice, 'B');
  assert.equal(parseBallot('投票：D', ['A', 'B']).choice, null);
  const opts = ['A', 'B', 'C'].map((key) => ({ key, text: key, author: key, authorLabel: key }));
  const t = tally(opts, [
    { voter: 'x', voterLabel: 'x', choice: 'A', reason: '', tier: 'strong' },
    { voter: 'y', voterLabel: 'y', choice: 'B', reason: '', tier: 'weak' },
    { voter: 'z', voterLabel: 'z', choice: null, reason: '', void: '没按格式' },
  ]);
  assert.deepEqual(t.counts, { A: 1, B: 1, C: 0 });
  assert.deepEqual(t.leaders, ['A', 'B']);
});

test('采纳方案：写进任务的「约定」，模板里的占位去掉；没有这一节就加上', () => {
  const dir = tmp('rule');
  fs.mkdirSync(path.join(dir, '.relay'));
  fs.writeFileSync(path.join(dir, '.relay', '任务.md'), taskTemplate('做滤镜'));
  appendRule(dir, '用什么格式 → 采用方案 B：XMP');
  const t = parseTask(fs.readFileSync(path.join(dir, '.relay', '任务.md'), 'utf8'));
  assert.match(t.rules, /^- 用什么格式 → 采用方案 B：XMP（.*群聊投票定下）$/);
  const d2 = tmp('rule2');
  fs.mkdirSync(path.join(d2, '.relay'));
  fs.writeFileSync(path.join(d2, '.relay', '任务.md'), '# 任务\n\n做\n');
  appendRule(d2, '规则一');
  assert.match(parseTask(fs.readFileSync(path.join(d2, '.relay', '任务.md'), 'utf8')).rules, /规则一/);
});

test('群聊提示：带规则、任务背景和记录；太长时丢掉最早的；各自先想时说明互相看不到', () => {
  const rows: TalkRow[] = Array.from({ length: 50 }, (_, i) => ({ ts: T, kind: i % 2 ? 'ai' : 'human', who: i % 2 ? 'Claude' : '我', text: `第${i}句 ` + 'x'.repeat(200) }));
  const p = buildTalkPrompt({ speaker: 'DeepSeek', root: '/p', rows, context: { task: { title: '做滤镜', phaseText: '在干活', changes: ['a.xmp'] } }, maxChars: 3000 });
  assert.ok(p.includes('你是「DeepSeek」'));
  assert.ok(p.includes('当前任务：做滤镜'));
  assert.ok(p.includes('第49句'));
  assert.ok(!p.includes('第0句'));
  assert.ok(p.includes('不要因为对方是更强的模型就附和'));
  assert.ok(p.endsWith('现在轮到你（DeepSeek）发言。'));
  const solo = buildTalkPrompt({ speaker: 'DeepSeek', root: '/p', rows: rows.slice(0, 2), solo: true });
  assert.match(solo, /各自先想/);
});

test('群聊记录：兼容旧格式，跳过旧版残留的「正在说」和投票行', () => {
  const dir = tmp('talk');
  fs.mkdirSync(path.join(dir, '.relay'));
  const lines = [
    { ts: T, kind: 'person', who: '我', windowId: 'human', text: '你好', mine: true },
    { ts: T, kind: 'person', who: 'Claude', windowId: 'claude', llm: 'opus', text: '正在说', pending: true },
    { ts: T, kind: 'person', who: 'Claude', windowId: 'claude', llm: 'opus', text: '我在' },
    { ts: T, kind: 'vote', id: 'v1', question: '投什么', text: '不该出现' },
    'not json',
  ];
  fs.writeFileSync(path.join(dir, '.relay', 'talk.jsonl'), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  const rows = readTalk(dir);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.who, r.text]),
    [
      ['human', '我', '你好'],
      ['ai', 'Claude', '我在'],
    ]
  );
  assert.equal(rows[1].model, 'opus');
});
