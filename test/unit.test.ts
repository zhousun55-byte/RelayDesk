import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBrief } from '../src/core/brief';
import { normalizeConfig } from '../src/core/config';
import { fillTemplate, shellWords, shq } from '../src/core/launch';
import { viewLedger, type LedgerEvent, type Stint } from '../src/core/ledger';
import { handoffFilled, parseHandoff, parseReview, parseTask, taskComplete, taskTemplate, verdictOf } from '../src/core/notes';
import { PRESETS } from '../src/core/presets';
import { globToRegExp, matchProtected } from '../src/core/protected';
import { installProtocol, protocolBlock, protocolState, removeProtocol } from '../src/core/protocol';
import { detectQuota } from '../src/core/quota';
import { redactSecrets } from '../src/core/redact';
import { normalizeAgent } from '../src/core/registry';
import { restoreFile, restoreSnapshot, snapChanges, snapFile, takeSnapshot } from '../src/core/snap';
import { parseNameStatusZ, parseNumstatZ } from '../src/core/status';
import { buildTalkPrompt, readTalk, type TalkRow } from '../src/core/talk';
import { memberTier, resolveWho, tierForModel, type MemberLike } from '../src/core/tier';
import { appendRule, parseBallot, tally } from '../src/core/vote';
import { ignoredPath } from '../src/ops/watch';

const T = '2026-01-01T00:00:00.000Z';

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
