import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/**
 * 网页（纯内存，不开浏览器）：每家 AI 的图标。
 * 从 app.js 里把用到的函数和表原样取出来，在沙箱里跑。
 */

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'app.js'), 'utf8').split('\n');

/** 取一个顶层函数或常量：从声明那一行到顶格的收尾（`}` / `];` / `};`）。 */
function pick(name: string): string {
  const i = src.findIndex((l) => new RegExp(`^((async )?function ${name}\\(|const ${name} = )`).test(l));
  assert.ok(i >= 0, `app.js 里没有 ${name}`);
  if (/;\s*$/.test(src[i]) && !/[[{(]\s*$/.test(src[i])) return src[i];
  let j = i;
  while (!/^(\}|\];|\};|\}\)\(\);)$/.test(src[j])) j++;
  return src.slice(i, j + 1).join('\n');
}

function icons() {
  const code = ['splitLabel', 'hashStr', 'line', 'solid', 'knot', 'GLYPHS', 'SHAPES', 'TOOL_OWN', 'MODEL_MAKER', 'TOOL_MAKER', 'brandOf', 'toolText'].map(pick).join('\n\n');
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(`${code}\nresult = { GLYPHS, SHAPES, TOOL_OWN, MODEL_MAKER, TOOL_MAKER, brandOf, toolText };`, ctx);
  return ctx.result as {
    GLYPHS: Record<string, string>;
    SHAPES: string[];
    TOOL_OWN: [RegExp, string][];
    MODEL_MAKER: [RegExp, string][];
    TOOL_MAKER: [RegExp, string][];
    brandOf: (tool: string, model: string | null) => string | null;
    toolText: (name: string, label: string, agent?: { harness?: string }) => string;
  };
}

test('网页的图标：跟着在干活的那家模型走（Claude Code 接 DeepSeek 是鲸鱼），能换模型的工具用自己的，认不出来的给几何图形', () => {
  const { brandOf, toolText } = icons();
  const of = (name: string, label: string, model: string | null, harness?: string) => brandOf(toolText(name, label, harness ? { harness } : undefined), model);
  // 用户真实名单里的每一位（2026-09-25）
  const cases: [string, string, string | null, string | undefined, string | null][] = [
    ['codex', 'Codex', 'gpt-6-astra', 'codex', 'openai'],
    ['gpt', 'ChatGPT', 'gpt-6-astra', undefined, 'openai'],
    ['claude-official', 'Claude Code 官方账号', 'claude-opus-5-5', 'claude-official', 'anthropic'],
    ['claude-app', 'Claude', 'claude-opus-5-5', undefined, 'anthropic'],
    ['claude', 'Claude Code', 'deepseek-flash', 'claude', 'deepseek'],
    ['deepseek-harness', 'DeepSeek Harness', 'deepseek-flash', 'dsh', 'deepseek'],
    ['deepseek-harness-app', 'DeepSeek Harness 桌面版', 'deepseek-flash', undefined, 'deepseek'],
    ['deepseek', 'DeepSeek', 'deepseek-v4-pro', undefined, 'deepseek'],
    ['cursor-agent', 'Cursor Agent', 'cursor-grok-4.6-high-fast', 'cursor-agent', 'cursor'],
    ['cursor', 'Cursor', 'cursor-grok-4.6-high-fast', undefined, 'cursor'],
    ['agy', 'Antigravity', null, 'agy', 'antigravity'],
    ['opencode', 'OpenCode', null, 'opencode', 'opencode'],
    ['zcode-cli', 'ZCode 命令行', 'GLM-5.3', 'zcode', 'zhipu'],
    ['zcode', 'ZCode', 'GLM-5.3', undefined, 'zhipu'],
    ['mimo-api', 'MiMo 接口', 'mimo-v2.6-pro', undefined, 'xiaomi'],
    ['mimo', 'MiMo', 'mimo-v2.6-pro', undefined, 'xiaomi'],
    // 没写模型：按工具是哪家的
    ['gemini', 'Gemini CLI', null, 'gemini', 'google'],
    ['grok', 'Grok CLI', null, 'grok', 'xai'],
    ['qwen', 'Qwen Code', null, 'qwen', 'qwen'],
    ['deepseek-harness', 'DeepSeek Harness', null, 'dsh', 'deepseek'],
    ['claude-official', 'Claude Code 官方账号', null, 'claude-official', 'anthropic'],
    ['zcode-cli', 'ZCode 命令行', null, 'zcode', 'zhipu'],
    ['mimo-api', 'MiMo 接口', null, undefined, 'xiaomi'],
    // 同一个工具换了模型：图标跟模型走
    ['claude', 'Claude Code', 'glm-5.3', 'claude', 'zhipu'],
    ['claude', 'Claude Code', 'kimi-k3', 'claude', 'moonshot'],
    ['codex', 'Codex', 'o4-mini', 'codex', 'openai'],
    // 认不出来
    ['my-api', '我的接口', 'some-model-x', undefined, null],
    ['droid', 'Droid', null, 'droid', null],
  ];
  for (const [name, label, model, harness, want] of cases) assert.equal(of(name, label, model, harness), want, `${label}（${model ?? '没写模型'}）`);
});

test('网页的图标：规则里用到的每家都画了，几何图形也都在；每个图形都是能放进 svg 的片段', () => {
  const { GLYPHS, SHAPES, TOOL_OWN, MODEL_MAKER, TOOL_MAKER } = icons();
  const used = new Set([...TOOL_OWN, ...MODEL_MAKER, ...TOOL_MAKER].map(([, b]) => b));
  for (const b of [...used, ...SHAPES, 'unknown']) {
    assert.ok(GLYPHS[b], `没画 ${b}`);
    assert.match(GLYPHS[b], /^<(path|g|rect|circle)\b[\s\S]*>$/, `${b} 不是 svg 片段`);
    assert.doesNotMatch(GLYPHS[b], /<script|on\w+=|href=/i, `${b} 里不该有脚本或链接`);
  }
  assert.equal(new Set(SHAPES).size, SHAPES.length, '几何图形不重样');
  assert.equal(new Set(Object.values(GLYPHS)).size, Object.keys(GLYPHS).length, '每个图形都不一样');
});

test('网页：全自动的结果只出现在它开始时的那段对话里（换了任务，上一个任务的「验收通过」不跑到新任务里）', () => {
  const code = ['msOf', 'rangeOf', 'inRange', 'streamItems'].map(pick).join('\n\n');
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(
    `
const t0 = { id: 't0', title: '给 wc.py 加 --json', from: '2026-09-25T13:30:00Z', to: '2026-09-25T14:07:00Z', stints: [] };
const t1 = { id: 't1', title: '让 wc.py 读标准输入', from: '2026-09-25T14:07:00Z', to: null, stints: [], current: true };
const S = {
  st: { project: { task: { title: '让 wc.py 读标准输入', body: '', items: [] }, threads: [t0, t1], lastRollback: null, protocol: 'ok',
    go: { id: 'g1', status: 'done', startedAt: '2026-09-25T13:42:00Z', updatedAt: '2026-09-25T13:49:36Z', result: '验收通过：清单 2/2 全部打勾' } } },
  talk: { status: { speaking: [], queue: [] } },
  dismissed: '',
};
const threads = () => S.st.project.threads;
const threadStints = () => [];
const threadTalk = () => ({ rows: [], votes: [] });
const looks = { key: '' };
${code}
const has = (t) => streamItems(t).some((it) => String(it.key).startsWith('res:'));
result = [has(t0), has(t1)];
S.st.project.go = { ...S.st.project.go, id: 'g2', startedAt: '2026-09-25T14:20:00Z', updatedAt: '2026-09-25T14:30:00Z' };
result.push(has(t0), has(t1));`,
    ctx
  );
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.result)), [true, false, false, true], '上一个任务的全自动结果在上一段；新任务里跑的在新的一段');
});

test('网页设置：各页返回的空位不进页面（以前「项目」页在接力规矩是最新时会显示一个「null」）', () => {
  const code = ['openSettings', 'settingsBody'].map(pick).join('\n\n');
  const run = (protocol: string) => {
    const ctx: Record<string, unknown> = {};
    vm.runInNewContext(
      `
const node = (tag) => ({ tag, kids: [], replaceChildren(...k) { this.kids = k; }, append(...k) { this.kids.push(...k); }, addEventListener() {} });
const h = (tag, props, ...kids) => { const n = node(tag); n.kids = kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false); return n; };
const icon = () => 'i';
let settingsTab = 'members', settingsRender = null;
let pane = null;
const sheet = ({ body }) => { pane = body.kids[1]; return () => {}; };
const savedMark = () => ({ el: 'mark', flash() {} });
const S = { st: { project: { init: true, protocol: '${protocol}', config: { gate: 'npm test', protectedPaths: [] } } } };
${code}
openSettings('project');
result = pane.kids.map((k) => (k === null ? 'null' : typeof k === 'string' ? k : k.tag));`,
      ctx
    );
    return JSON.parse(JSON.stringify(ctx.result)) as string[];
  };
  assert.ok(!run('ok').includes('null'), '接力规矩是最新的：不留空位');
  assert.equal(run('ok').length, 4, '关闭按钮、标题、检查命令、保护的文件');
  assert.equal(run('old').length, 5, '接力规矩有新版本：多一行「更新」');
});

test('网页 ▾ 菜单的「打开」：只列桌面程序，命令行工具不弹终端窗口（在「只做一棒」里由接力台派活）', () => {
  const code = ['whoMenu'].map(pick).join('\n\n');
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(
    `
const list = [
  { name: 'codex', label: 'Codex', kind: 'harness', agent: { cmd: 'codex' }, canWork: true, tier: 'strong', model: 'gpt-6-sol' },
  { name: 'cursor', label: 'Cursor', kind: 'app', canWork: false },
  { name: 'claude', label: 'Claude Code', kind: 'harness', agent: { cmd: 'claude' }, canWork: true, tier: 'weak', model: 'deepseek-flash' },
  { name: 'gpt', label: 'ChatGPT', kind: 'app', canWork: false },
];
const members = () => list;
const tile = () => null, goWith = () => {}, openIn = () => {}, copyHint = () => {};
let items = null;
const openMenu = (_a, it) => { items = it; };
${code}
whoMenu(null);
const at = items.findIndex((x) => x && x.head === '打开');
result = { work: items.slice(1, at - 1).map((x) => x.label), open: items.slice(at + 1).filter((x) => x && x.label && x.run && x.label !== '复制开场白').map((x) => x.label) };`,
    ctx
  );
  const r = JSON.parse(JSON.stringify(ctx.result)) as { work: string[]; open: string[] };
  assert.deepEqual(r.work, ['Codex', 'Claude Code'], '命令行工具在「只做一棒」里');
  assert.deepEqual(r.open, ['Cursor', 'ChatGPT'], '「打开」里只有桌面程序');
});
