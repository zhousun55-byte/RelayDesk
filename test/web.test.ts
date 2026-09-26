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
const syncSegs = () => {};
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

test('网页定时刷新：和上次拿到的一字不差就不解析、不重画；换了项目从头来；操作之后一定按最新状态重画', async () => {
  const code = ['api'].map(pick).join('\n\n');
  const ctx: Record<string, unknown> = {};
  const out: unknown[] = [];
  await new Promise<void>((resolve) => {
    vm.runInNewContext(
      `
let body = '{"ok":true,"n":1}';
let fetches = 0;
const fetch = async () => { fetches++; return { status: 200, text: async () => body }; };
const S = { dir: 'A', raw: {} };
${code}
(async () => {
  const a = await api('/api/state', undefined, 'state');
  const b = await api('/api/state', undefined, 'state');
  const c = await api('/api/state');
  body = '{"ok":true,"n":2}';
  const d = await api('/api/state', undefined, 'state');
  S.raw = {};
  const e = await api('/api/state', undefined, 'state');
  out([a && a.n, b, c && c.n, d && d.n, e && e.n, fetches]);
  done();
})();`,
      Object.assign(ctx, { out: (x: unknown) => out.push(x), done: resolve })
    );
  });
  assert.deepEqual(JSON.parse(JSON.stringify(out[0])), [1, null, 1, 2, 2, 5], '没变：null；不带记号的请求照常解析；变了、换了项目：照常解析');
});

test('网页线路的终点：最新的任务看验收（做着的时候没有终点）；更早的任务看当时全自动的结果', () => {
  const code = ['msOf', 'rangeOf', 'inRange', 'streamItems'].map(pick).join('\n\n');
  const run = (acceptance: unknown, go: unknown) => {
    const ctx: Record<string, unknown> = {};
    vm.runInNewContext(
      `
const t0 = { id: 't0', title: '旧任务', from: '2026-09-25T13:30:00Z', to: '2026-09-25T14:07:00Z', stints: [] };
const t1 = { id: 't1', title: '新任务', from: '2026-09-25T14:07:00Z', to: null, stints: [], current: true };
const S = { st: { project: { task: { title: '新任务', body: '', items: [] }, threads: [t0, t1], lastRollback: null, protocol: 'ok', go: ${JSON.stringify(go)}, acceptance: ${JSON.stringify(acceptance)} } }, talk: { status: { speaking: [], queue: [] } }, dismissed: '' };
const threads = () => S.st.project.threads;
const threadStints = () => [];
const threadTalk = () => ({ rows: [], votes: [] });
const looks = { key: '' };
${code}
const ends = (t) => streamItems(t).filter((it) => it.stop).map((it) => String(it.key).split(':')[0]);
result = [ends(t0), ends(t1)];`,
      ctx
    );
    return JSON.parse(JSON.stringify(ctx.result)) as string[][];
  };
  const oldGo = { id: 'g1', status: 'done', startedAt: '2026-09-25T13:42:00Z', updatedAt: '2026-09-25T13:49:00Z', result: '验收通过：清单 2/2' };
  assert.deepEqual(run({ state: 'blocked', headline: '', items: [{ text: '第 9 棒待复核' }] }, oldGo), [['res'], ['acc']], '旧任务：全自动的结果；新任务：验收没过');
  assert.deepEqual(run({ state: 'working', headline: '', items: [] }, oldGo), [['res'], []], '新任务还在做：没有终点');
  assert.deepEqual(run(null, null), [[], []]);
});

test('网页交接单：交接的每一节是一行（做了、没做完、拿不准、验证），「状态」写在右上角；没按格式写的整篇放一行', () => {
  const code = ['SECTION', 'handoffForm'].map(pick).join('\n\n');
  const run = (text: string) => {
    const ctx: Record<string, unknown> = {};
    vm.runInNewContext(
      `
const h = (tag, props, ...kids) => ({ tag, props, kids: kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false) });
const md = (t) => t;
const openDiff = () => {}, lightPaths = () => {}, lightStint = () => {};
${code}
const f = handoffForm({ id: 5, ghost: false, facts: { files: 2, added: 55, removed: 7, paths: ['wc.py', 'test_wc.py'] } }, ${JSON.stringify(text)});
const dl = f.kids[1];
result = { status: f.kids[0].kids[1] ? f.kids[0].kids[1].kids[0] : '', rows: dl.kids.filter((k) => k.tag === 'dt').map((k) => k.kids[0]) };`,
      ctx
    );
    return JSON.parse(JSON.stringify(ctx.result)) as { status: string; rows: string[] };
  };
  const handoff = ['# 交接：Codex · gpt-6-astra', '', '- 工具：Codex', '- 状态：全部完成', '', '## 做了什么', '', '- 已实现 --json', '', '## 没做完 / 下一步', '', '- 无', '', '## 不确定、可能有错的地方', '', '- 第 4 棒没有交接', '', '## 怎么验证', '', '- 跑了检查命令'].join('\n');
  assert.deepEqual(run(handoff), { status: '全部完成', rows: ['做了', '没做完', '拿不准', '验证', '改了'] });
  assert.deepEqual(run('随手写的一段话，没按格式'), { status: '', rows: ['交接', '改了'] });
});
