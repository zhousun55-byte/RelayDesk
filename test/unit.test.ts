import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../src/core/config';
import { buildHandoffDoc, buildMergeMessage } from '../src/core/handoff-doc';
import { checkpoints, lastCheckpoint, lastReviewTarget, lastSegmentRun, pendingSyncConflicts } from '../src/core/journal';
import { fillTemplate, shellWords, shq } from '../src/core/launch';
import { buildOnboard, type OnboardInput } from '../src/core/prompts';
import { globToRegExp, matchProtected } from '../src/core/protected';
import { redactSecrets } from '../src/core/redact';
import { normalizeAgent } from '../src/core/registry';
import { PRESETS } from '../src/core/presets';
import { branchNameFor, slugify } from '../src/core/slug';
import { parseNameStatusZ, parseNumstatZ, parsePorcelainZ } from '../src/core/status';
import { buildTalkPrompt, readTalk, type TalkRow } from '../src/core/talk';
import type { JournalEvent } from '../src/core/types';
import { buildTimeline } from '../src/ops/view';

const T = '2026-01-01T00:00:00.000Z';
const start: JournalEvent = { ts: T, type: 'start', task: 't', branch: 'relay/t-0000', commit: 'BASE' };
const open = (agent: string, tier: 'strong' | 'weak' = 'strong'): JournalEvent => ({ ts: T, type: 'open', agent, tier });
const hand = (agent: string, cp: string, extra: Partial<JournalEvent> = {}): JournalEvent =>
  ({ ts: T, type: 'handoff', agent, checkpoint: cp, ...extra }) as JournalEvent;

test('slug：英文词做分支名，全中文退化成 task，带 4 位编号', () => {
  assert.equal(slugify('Add greeting feature!'), 'add-greeting-feature');
  assert.equal(slugify('帮我做一份滤镜'), 'task');
  assert.equal(slugify('a'.repeat(40)).length, 24);
  assert.match(branchNameFor('做 iPhone5s 的 XMP').branch, /^relay\/iphone5s-xmp-[0-9a-f]{4}$/);
});

test('保护路径通配：** 跨目录、* 不跨目录、目录写法', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b.ts'));
  assert.ok(globToRegExp('**/*.env').test('.env'));
  assert.ok(globToRegExp('**/*.env').test('app/prod.env'));
  assert.ok(globToRegExp('**/secret.txt').test('secret.txt'));
  assert.ok(globToRegExp('**/secret.txt').test('a/b/secret.txt'));
  assert.ok(globToRegExp('*.md').test('README.md'));
  assert.ok(!globToRegExp('*.md').test('docs/a.md'));
  assert.ok(globToRegExp('config/').test('config/prod.json'));
  assert.deepEqual(matchProtected(['a.txt', 'config/x.json'], ['config/']), ['config/x.json']);
  assert.deepEqual(matchProtected(['a.txt'], []), []);
});

test('git status -z 解析：行首空格不丢、中文和空格原样、改名带原路径', () => {
  const raw = ' M .relay/journal.jsonl\0?? 新 文件.txt\0R  new.txt\0old.txt\0 D gone.md\0';
  const e = parsePorcelainZ(raw);
  assert.deepEqual(e, [
    { code: ' M', path: '.relay/journal.jsonl' },
    { code: '??', path: '新 文件.txt' },
    { code: 'R ', path: 'new.txt', orig: 'old.txt' },
    { code: ' D', path: 'gone.md' },
  ]);
});

test('diff -z 解析：name-status 与 numstat（含改名、二进制）', () => {
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
  assert.equal(fillTemplate('open -a Cursor {{worktree}}', { worktree: '/a b/c' }), "open -a Cursor '/a b/c'");
  assert.equal(fillTemplate('code "{{worktree}}"', { worktree: '/x' }), "code '/x'");
  assert.equal(fillTemplate('x {{unknown}}', {}), 'x {{unknown}}');
  assert.deepEqual(shellWords('open -a "Xiaomi MiMo" {{worktree}}'), ['open', '-a', 'Xiaomi MiMo', '{{worktree}}']);
  assert.deepEqual(shellWords("a 'b c' d\\ e"), ['a', 'b c', 'd e']);
});

test('脱敏：密钥换成 [REDACTED]，普通内容不动', () => {
  const out = redactSecrets('key=sk-abcdefghijklmnopqrstuv\nghp_abcdefghijklmnopqrstuvwxyz\nhello world');
  assert.ok(!out.includes('sk-abcdefghijklmnop'));
  assert.ok(!out.includes('ghp_abcdef'));
  assert.ok(out.includes('hello world'));
  assert.equal(redactSecrets('+ const x = 1;'), '+ const x = 1;');
});

test('项目配置：缺字段补默认、类型不对说人话、密钥变量名要像变量名', () => {
  const d = normalizeConfig({});
  assert.equal(d.gate.command, '');
  assert.equal(d.audit.apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.throws(() => normalizeConfig({ protectedPaths: 'nope' }), /protectedPaths/);
  assert.throws(() => normalizeConfig({ gate: null }), /gate/);
  assert.throws(() => normalizeConfig({ audit: { apiKeyEnv: 'sk-123 456' } }), /环境变量的名字/);
  assert.deepEqual(normalizeConfig({ protectedPaths: [' a ', ''] }).protectedPaths, ['a']);
});

test('工人配置校验：桌面要有 {{worktree}}，API 要地址和变量名，旧名单没有 kind 当终端', () => {
  assert.throws(() => normalizeAgent({ name: '中文', cmd: 'x' }), /名字/);
  assert.throws(() => normalizeAgent({ name: 'cur', kind: 'app', cmd: 'open -a Cursor' }), /\{\{worktree\}\}/);
  assert.throws(() => normalizeAgent({ name: 'ds', kind: 'api', api: { baseUrl: 'x', model: 'm', apiKeyEnv: 'K' } }), /http/);
  assert.throws(() => normalizeAgent({ name: 'ds', kind: 'api', api: { baseUrl: 'https://a', model: 'm', apiKeyEnv: 'sk-xx yy' } }), /环境变量/);
  const old = normalizeAgent({ name: 'claude', cmd: 'claude', tier: 'strong', prompt: { mode: 'file' } });
  assert.equal(old.kind, 'cli');
  const api = normalizeAgent({ name: 'ds', kind: 'api', api: { baseUrl: 'https://api.deepseek.com/', model: 'deepseek-chat', apiKeyEnv: 'DEEPSEEK_API_KEY' } });
  assert.equal(api.api?.baseUrl, 'https://api.deepseek.com');
  assert.equal(api.cmd, undefined);
  // 现成配置里除了要用户自己填的占位项，都能直接通过校验
  for (const p of PRESETS.filter((x) => !['api', 'cli'].includes(x.id))) assert.doesNotThrow(() => normalizeAgent(p.agent), p.id);
});

test('这一段的起点：交接检查点 / 退回落点 / 同步点 / 开始基准', () => {
  assert.equal(lastCheckpoint([start]), 'BASE');
  assert.equal(lastCheckpoint([start, open('a'), hand('a', 'C1')]), 'C1');
  assert.equal(lastCheckpoint([start, hand('a', 'C1'), { ts: T, type: 'rollback', to: 'BASE' }]), 'BASE');
  assert.equal(lastCheckpoint([start, hand('a', 'C1'), { ts: T, type: 'sync', main: 'M', commit: 'S1' }]), 'S1');
  // 有冲突的同步不算落点
  assert.equal(lastCheckpoint([start, hand('a', 'C1'), { ts: T, type: 'sync', main: 'M', conflicts: ['x'] }]), 'C1');
});

test('要审的上一段：最近一次有改动的交接；空交接透明跳过；退回后没东西可审', () => {
  assert.equal(lastReviewTarget([start, open('a')]), null);
  const one = lastReviewTarget([start, open('w', 'weak'), hand('w', 'C1', { tier: 'weak' })]);
  assert.deepEqual(one, { agent: 'w', tier: 'weak', from: 'BASE', to: 'C1' });
  // 弱模型干活 → 强模型什么都没干就交班 → 第三位审的仍然是弱模型那段
  const skip = lastReviewTarget([
    start,
    open('w', 'weak'),
    hand('w', 'C1', { tier: 'weak' }),
    open('s'),
    hand('s', 'C2', { tier: 'strong', empty: true }),
  ]);
  assert.deepEqual(skip, { agent: 'w', tier: 'weak', from: 'BASE', to: 'C1' });
  // 两段有改动：审最近那段
  const two = lastReviewTarget([start, hand('a', 'C1'), hand('b', 'C2')]);
  assert.equal(two?.agent, 'b');
  assert.equal(two?.from, 'C1');
  assert.equal(lastReviewTarget([start, hand('a', 'C1'), { ts: T, type: 'rollback', to: 'BASE' }]), null);
});

test('这一段谁在岗：交接 / 退回之后清零', () => {
  assert.equal(lastSegmentRun([start, open('a')])?.agent, 'a');
  assert.equal(lastSegmentRun([start, open('a'), hand('a', 'C1')]), null);
  assert.equal(lastSegmentRun([start, open('a'), hand('a', 'C1'), { ts: T, type: 'run', agent: 'b' }])?.agent, 'b');
  assert.equal(lastSegmentRun([start, open('a'), { ts: T, type: 'rollback', to: 'BASE' }]), null);
});

test('同步冲突：交接或退回之后就不算悬着了', () => {
  const s = { ts: T, type: 'sync', main: 'M', conflicts: ['a.txt'] } as JournalEvent;
  assert.deepEqual(pendingSyncConflicts([start, s]), ['a.txt']);
  assert.deepEqual(pendingSyncConflicts([start, s, hand('a', 'C1')]), []);
  assert.deepEqual(pendingSyncConflicts([start, s, { ts: T, type: 'sync', main: 'M', aborted: true }]), []);
});

test('可退回的点：开始 + 有改动的交接，重复的检查点只列一次', () => {
  const cps = checkpoints([start, hand('a', 'C1'), hand('b', 'C1', { empty: true }), hand('c', 'C2')], 'START');
  assert.deepEqual(
    cps.map((c) => c.sha),
    ['START', 'C1', 'C2']
  );
});

function onboardInput(over: Partial<OnboardInput> = {}): OnboardInput {
  return {
    taskTitle: '做滤镜',
    taskBody: '# 任务\n\n做滤镜',
    branch: 'relay/task-1234',
    worktree: '/tmp/wt',
    you: { agent: 'claude', label: 'Claude Code', tier: 'strong' },
    review: null,
    handoffDoc: null,
    latestAudit: null,
    protectedPaths: [],
    gateCommand: '',
    conflicts: [],
    generatedAt: T,
    ...over,
  };
}

test('上岗说明：第一位没有自审段；前任弱 → 必须先审，给出范围和按文件退回的命令', () => {
  const first = buildOnboard(onboardInput());
  assert.ok(first.includes('做滤镜'));
  assert.ok(!first.includes('审查上一位'));
  assert.ok(first.includes('.relay/NOTE.md'));
  const weak = buildOnboard(onboardInput({ review: { agent: 'ds', label: 'DeepSeek', tier: 'weak', from: 'AAA', to: 'BBB' } }));
  assert.ok(weak.includes('审查上一位的改动（必须）'));
  assert.ok(weak.includes('git diff AAA..BBB'));
  assert.ok(weak.includes('git checkout AAA -- <文件>'));
  assert.ok(weak.includes('不要整体回档'));
  const strong = buildOnboard(onboardInput({ review: { agent: 'cursor', tier: 'strong', from: 'A', to: 'B' } }));
  assert.ok(!strong.includes('（必须）'));
  assert.ok(strong.includes('git diff A..B'));
});

test('上岗说明：保护路径、检查命令、冲突都写进去', () => {
  const s = buildOnboard(onboardInput({ protectedPaths: ['config/'], gateCommand: 'npm test', conflicts: ['a.txt'] }));
  assert.ok(s.includes('`config/`'));
  assert.ok(s.includes('npm test'));
  assert.ok(s.includes('先解决合并冲突'));
  assert.ok(s.includes('`a.txt`'));
});

test('交接文档：事实在前；留言、自述、模型建议都标明不是事实', () => {
  const doc = buildHandoffDoc({
    taskTitle: '做滤镜',
    branch: 'relay/x',
    agent: 'cursor',
    tier: 'weak',
    llm: 'grok-4.6',
    base: 'aaaaaaaaaaaa',
    checkpoint: 'bbbbbbbbbbbb',
    empty: false,
    diffstat: ' a.txt | 2 +-',
    gate: { status: 'fail', command: 'npm test', detail: 'boom' },
    auditPath: '.relay/audits/x.md',
    auditStatus: 'failed',
    modelNote: '没有设置 DEEPSEEK_API_KEY',
    protectedHits: ['config/a.json'],
    note: '人的留言',
    selfNote: '做到哪了：一半',
    modelNext: '补测试',
    ts: T,
  });
  assert.ok(doc.includes('Cursor · grok-4.6（弱）'));
  assert.ok(doc.includes('❌ 没通过'));
  assert.ok(doc.includes('boom'));
  assert.ok(doc.includes('config/a.json'));
  assert.ok(doc.includes('交接留言（人写的）'));
  assert.ok(doc.includes('上一位的自述（它自己写的，不是事实）'));
  assert.ok(doc.includes('建议的下一步（模型生成，非事实）'));
  assert.ok(doc.includes('补测试'));
});

test('合回提交说明：按 journal 列出谁什么时候干了什么', () => {
  const msg = buildMergeMessage({
    taskTitle: '做滤镜\n细节',
    branch: 'relay/x',
    baseCommit: 'abcdef1234',
    events: [start, open('cursor'), hand('cursor', 'C1', { files: 2 }), { ts: T, type: 'take', files: ['a'] }],
  });
  assert.ok(msg.startsWith('接力：做滤镜\n'));
  assert.ok(msg.includes('Cursor'));
  assert.ok(msg.includes('2 个文件'));
  assert.ok(msg.includes('收进 1 个文件'));
});

test('时间线：检查和审计并进它们所属的交接', () => {
  const items = buildTimeline([
    start,
    open('cursor'),
    { ts: T, type: 'audit', agent: 'cursor', report: '.relay/audits/a.md', status: 'failed' },
    { ts: T, type: 'gate', agent: 'cursor', status: 'pass', command: 'npm test' },
    hand('cursor', 'C1', { files: 1, added: 2, removed: 0, note: '看看 a' }),
  ]);
  assert.equal(items.length, 3);
  assert.match(items[2].text, /Cursor 交接：1 个文件 \+2 −0，检查通过/);
  assert.equal(items[2].report, '.relay/audits/a.md');
  assert.equal(items[2].detail, '留言：看看 a');
});

test('讨论提示：带规则、任务背景和记录；太长时丢掉最早的', () => {
  const rows: TalkRow[] = Array.from({ length: 50 }, (_, i) => ({ ts: T, kind: i % 2 ? 'ai' : 'human', who: i % 2 ? 'Claude' : '我', text: `第${i}句 ` + 'x'.repeat(200) }));
  const p = buildTalkPrompt({ speaker: 'DeepSeek', root: '/p', rows, context: { task: { title: '做滤镜', phaseText: '在干活', changes: ['a.xmp'] } }, maxChars: 3000 });
  assert.ok(p.includes('你是「DeepSeek」'));
  assert.ok(p.includes('当前任务：做滤镜'));
  assert.ok(p.includes('a.xmp'));
  assert.ok(p.includes('第49句'));
  assert.ok(!p.includes('第0句'));
  assert.ok(p.includes('较早的已省略'));
  assert.ok(p.endsWith('现在轮到你（DeepSeek）发言。'));
});

test('讨论记录：兼容旧格式，跳过旧版残留的「正在说」', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-talk-'));
  fs.mkdirSync(path.join(dir, '.relay'));
  const lines = [
    { ts: T, kind: 'person', who: '我', windowId: 'human', text: '你好', mine: true },
    { ts: T, kind: 'person', who: 'Claude', windowId: 'claude', llm: 'opus', text: '正在说', pending: true },
    { ts: T, kind: 'person', who: 'Claude', windowId: 'claude', llm: 'opus', text: '我在' },
    { ts: T, kind: 'system', who: '接力', windowId: 'zcode', text: 'ZCode 进了群' },
    'not json',
  ];
  fs.writeFileSync(path.join(dir, '.relay', 'talk.jsonl'), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  const rows = readTalk(dir);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.who, r.text]),
    [
      ['human', '我', '你好'],
      ['ai', 'Claude', '我在'],
      ['system', '接力', 'ZCode 进了群'],
    ]
  );
  assert.equal(rows[1].model, 'opus');
  assert.equal(rows[1].agent, 'claude');
});

test('没配置检查命令：交接文档、合回说明、时间线都不说成「通过」', () => {
  const none = { ts: T, type: 'gate', agent: 'cursor', status: 'pass', command: '(未配置)' } as JournalEvent;
  const doc = buildHandoffDoc({
    taskTitle: '做滤镜',
    branch: 'relay/x',
    agent: 'cursor',
    tier: 'strong',
    base: 'aaaaaaaaaaaa',
    checkpoint: 'bbbbbbbbbbbb',
    empty: false,
    diffstat: ' a.txt | 2 +-',
    gate: { status: 'pass', command: '(未配置)', detail: '' },
    auditPath: '.relay/audits/x.md',
    auditStatus: 'ok',
    modelNote: null,
    protectedHits: [],
    modelNext: null,
    ts: T,
  });
  assert.ok(doc.includes('没配置检查命令'));
  assert.ok(!doc.includes('✅ 通过'));
  const msg = buildMergeMessage({ taskTitle: '做滤镜', branch: 'relay/x', baseCommit: 'abcdef1234', events: [start, open('cursor'), none, hand('cursor', 'C1', { files: 1 })] });
  assert.ok(!msg.includes('未配置'));
  assert.ok(!msg.includes('检查 通过'));
  const items = buildTimeline([start, open('cursor'), none, hand('cursor', 'C1', { files: 1, added: 1, removed: 0 })]);
  assert.doesNotMatch(items[2].text, /检查/);
  assert.equal(items[2].ok, undefined, '没配置检查就不挂「检查通过」的标签');
});

test('合回说明：写上审查结论，能力用「强 / 弱」，时间用本地时间', () => {
  const review = { ts: T, type: 'review', agent: 'codex', verdict: 'fix', summary: '色温太冷', issues: ['调暖'], checkpoint: 'C1', round: 1 } as JournalEvent;
  const msg = buildMergeMessage({ taskTitle: '做滤镜', branch: 'relay/x', baseCommit: 'abcdef1234', events: [start, open('cursor', 'weak'), hand('cursor', 'C1', { files: 1 }), review] });
  assert.match(msg, /Codex 审查：要修改（1 条），色温太冷/);
  assert.ok(msg.includes('（弱）'));
  assert.ok(!msg.includes('weak') && !msg.includes('strong'));
  assert.ok(!msg.includes('T00:00:00.000Z'), '不写世界标准时间的原始格式');
});

test('时间线：退回写成「退回到 某某 交接后」，而不是一串编号', () => {
  const items = buildTimeline([start, open('cursor'), hand('cursor', 'C1', { files: 1 }), { ts: T, type: 'rollback', to: 'C1' } as JournalEvent]);
  assert.equal(items[items.length - 1].text, '退回到「Cursor 交接后」');
});

test('接口工人：模型只认接口里填的那个，改了接口模型不会留下旧名字', () => {
  const a = normalizeAgent({ name: 'ds', kind: 'api', model: '旧模型', api: { baseUrl: 'https://api.example.com', model: '新模型', apiKeyEnv: 'K' } });
  assert.equal(a.model, '新模型');
  assert.equal(a.api?.model, '新模型');
});
