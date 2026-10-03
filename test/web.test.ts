import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/** 网页的函数在沙箱里跑：先放进 i18n.js（界面上的字 T`…`、后台的字 tr(…)，默认中文）。 */
const I18N = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'i18n.js'), 'utf8').replace("'use strict';", '');
const runWeb = (code: string, ctx: vm.Context) => vm.runInNewContext(`${I18N}\n${code}`, ctx);

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
  runWeb(`${code}\nresult = { GLYPHS, SHAPES, TOOL_OWN, MODEL_MAKER, TOOL_MAKER, brandOf, toolText };`, ctx);
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
  const code = ['msOf', 'rangeOf', 'inRange', 'pageThreads', 'accepted', 'streamItems'].map(pick).join('\n\n');
  const ctx: Record<string, unknown> = {};
  runWeb(
    `
const t0 = { id: 't0', title: '给 wc.py 加 --json', from: '2026-09-25T13:30:00Z', to: '2026-09-25T14:07:00Z', stints: [] };
const t1 = { id: 't1', title: '让 wc.py 读标准输入', from: '2026-09-25T14:07:00Z', to: null, stints: [], current: true };
const S = {
  st: { project: { task: { title: '让 wc.py 读标准输入', body: '', items: [] }, threads: [t0, t1], lastRollback: null, protocol: 'ok',
    go: { id: 'g1', mode: 'auto', status: 'done', startedAt: '2026-09-25T13:42:00Z', updatedAt: '2026-09-25T13:49:36Z', result: '验收通过：清单 2/2 全部打勾' } } },
  talk: { status: { speaking: [], queue: [] } },
  dismissed: '',
};
const threads = () => S.st.project.threads;
const threadStints = () => [];
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
  const code = ['settingsPane', 'settingsBody', 'setRow', 'setField', 'setSec', 'gateResult', 'LEVEL_DESC'].map(pick).join('\n\n');
  const run = (protocol: string) => {
    const ctx: Record<string, unknown> = {};
    runWeb(
      `
const node = (tag) => ({ tag, kids: [], replaceChildren(...k) { this.kids = k; }, append(...k) { this.kids.push(...k); }, addEventListener() {} });
const h = (tag, props, ...kids) => { const n = node(tag); n.kids = kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false); return n; };
const icon = () => 'i';
const savedMark = () => ({ el: 'mark', flash() {} });
const S = { st: { project: { init: true, protocol: '${protocol}', config: { gate: 'npm test', protectedPaths: [] }, acceptance: { gate: { status: 'pass', stint: 3, text: '检查通过' } } } } };
${code}
const kids = settingsPane('project', () => {});
result = { tags: kids.map((k) => (k === null ? 'null' : typeof k === 'string' ? k : k.tag)), gate: JSON.stringify(kids[1].kids) };`,
      ctx
    );
    return JSON.parse(JSON.stringify(ctx.result)) as { tags: string[]; gate: string };
  };
  assert.ok(!run('ok').tags.includes('null'), '接力规矩是最新的：不留空位');
  assert.equal(run('ok').tags.length, 3, '标题、检查命令、不许改的文件');
  assert.equal(run('old').tags.length, 4, '接力规矩有新版本：多一行「更新」');
  assert.match(run('ok').gate, /上次通过 · 第 3 棒之后/, '检查命令底下写上次的结果');
});

test('网页 ▾ 菜单：「只做一棒」列能派活的（叫模型的名字）；「打开」列有桌面程序的，命令行工具不弹终端窗口', () => {
  const code = ['splitLabel', 'LLM_WORD', 'LLM_VARIANT', 'llmName', 'nameOf', 'memberName', 'whoMenu', 'SUB'].map(pick).join('\n\n');
  const ctx: Record<string, unknown> = {};
  runWeb(
    `
const list = [
  { name: 'codex', label: 'Codex', llm: 'GPT-6 Sol', tool: 'Codex', app: 'ChatGPT', kind: 'harness', agent: { cmd: 'codex' }, canWork: true, tier: 'strong', model: 'gpt-6-sol' },
  { name: 'trae', label: 'Trae', llm: 'Trae', tool: 'Trae', app: 'Trae', kind: 'app', canWork: false },
  { name: 'claude', label: 'Claude Code', kind: 'harness', agent: { cmd: 'claude' }, canWork: true, tier: 'weak', model: 'deepseek-flash' },
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
  assert.deepEqual(r.work, ['GPT-6 Sol', 'Claude Code'], '能派活的在「只做一棒」里；老接力台没给名字时按记下的叫');
  assert.deepEqual(r.open, ['GPT-6 Sol', 'Trae'], '「打开」里是有桌面程序的（记在命令行名下的也算）');
});

test('网页定时刷新：和上次拿到的一字不差就不解析、不重画；换了项目从头来；操作之后一定按最新状态重画', async () => {
  const code = ['api'].map(pick).join('\n\n');
  const ctx: Record<string, unknown> = {};
  const out: unknown[] = [];
  await new Promise<void>((resolve) => {
    runWeb(
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
  const code = ['msOf', 'rangeOf', 'inRange', 'pageThreads', 'accepted', 'streamItems'].map(pick).join('\n\n');
  const run = (acceptance: unknown, go: unknown) => {
    const ctx: Record<string, unknown> = {};
    runWeb(
      `
const t0 = { id: 't0', title: '旧任务', from: '2026-09-25T13:30:00Z', to: '2026-09-25T14:07:00Z', stints: [] };
const t1 = { id: 't1', title: '新任务', from: '2026-09-25T14:07:00Z', to: null, stints: [], current: true };
const S = { st: { project: { task: { title: '新任务', body: '', items: [] }, threads: [t0, t1], lastRollback: null, protocol: 'ok', go: ${JSON.stringify(go)}, acceptance: ${JSON.stringify(acceptance)} } }, talk: { status: { speaking: [], queue: [] } }, dismissed: '' };
const threads = () => S.st.project.threads;
const threadStints = () => [];
const looks = { key: '' };
${code}
const ends = (t) => streamItems(t).filter((it) => it.stop).map((it) => String(it.key).split(':')[0]);
result = [ends(t0), ends(t1)];`,
      ctx
    );
    return JSON.parse(JSON.stringify(ctx.result)) as string[][];
  };
  const oldGo = { id: 'g1', mode: 'auto', status: 'done', startedAt: '2026-09-25T13:42:00Z', updatedAt: '2026-09-25T13:49:00Z', result: '验收通过：清单 2/2' };
  assert.deepEqual(run({ state: 'blocked', headline: '', items: [{ text: '第 9 棒待复核' }] }, oldGo), [['res'], ['acc']], '旧任务：全自动的结果；新任务：验收没过');
  assert.deepEqual(run({ state: 'working', headline: '', items: [] }, oldGo), [['res'], []], '新任务还在做：没有终点');
  // 新任务全自动做完、验收通过，之后又退回了（或加了一步）：验收回到「还在做」，终点不能还写着当时的「验收通过」
  const newGo = { id: 'g2', mode: 'auto', status: 'done', startedAt: '2026-09-25T14:20:00Z', updatedAt: '2026-09-25T14:30:00Z', result: '验收通过：清单 2/2' };
  assert.deepEqual(run({ state: 'accepted', headline: '清单 2/2 全部打勾', items: [] }, newGo), [[], ['res']], '做完了：新任务的终点是这次全自动');
  assert.deepEqual(run({ state: 'working', headline: '', items: [] }, newGo), [[], []], '退回之后：没有终点');
  assert.deepEqual(run({ state: 'working', headline: '', items: [] }, { ...newGo, status: 'stopped', result: '全自动已停止' }), [[], ['res']], '停下来的那次照样画（它确实停了）');
  assert.deepEqual(run(null, null), [[], []]);
  assert.deepEqual(run(null, { ...oldGo, mode: 'single', status: 'stopped', result: '已停止。' }), [[], []], '只做一棒停了：那一棒的小条上写了，不画终点');
});

test('网页：换掉的任务有换掉那一刻的验收，终点画它（不再挂当时全自动的结果）；换掉时还没做完的不画终点，清单只能看', () => {
  const code = ['msOf', 'rangeOf', 'inRange', 'pageThreads', 'accepted', 'streamItems'].map(pick).join('\n\n');
  const run = (accept: unknown) => {
    const ctx: Record<string, unknown> = {};
    runWeb(
      `
const t0 = { id: 't0', title: '旧任务', from: '2026-09-25T13:30:00Z', to: '2026-09-25T14:07:00Z', stints: [], items: [{ text: '一', done: true }], accept: ${JSON.stringify(accept)} };
const t1 = { id: 't1', title: '新任务', from: '2026-09-25T14:07:00Z', to: null, stints: [], current: true };
const go = { id: 'g1', mode: 'auto', status: 'done', startedAt: '2026-09-25T13:42:00Z', updatedAt: '2026-09-25T13:49:00Z', result: '验收通过：清单 1/1' };
const S = { st: { project: { task: { title: '新任务', body: '', items: [] }, threads: [t0, t1], lastRollback: null, protocol: 'ok', go, acceptance: { state: 'working', headline: '', items: [] } } }, talk: { status: { speaking: [], queue: [] } }, dismissed: '' };
const threads = () => S.st.project.threads;
const threadStints = () => [];
const looks = { key: '' };
${code}
result = streamItems(t0).filter((it) => it.stop).map((it) => String(it.key).split(':')[0]);`,
      ctx
    );
    return JSON.parse(JSON.stringify(ctx.result)) as string[];
  };
  assert.deepEqual(run({ state: 'accepted', headline: '验收通过：清单 1/1 全部打勾', items: [] }), ['acc'], '换掉那一刻的验收');
  assert.deepEqual(run({ state: 'working', headline: '清单 0/1', items: [] }), [], '换掉时还没做完：不画终点');
  assert.deepEqual(run(null), ['res'], '旧版账本没记：还看当时全自动的结果');
  assert.match(pick('pastChecklist'), /class: 'checks past'/);
  assert.doesNotMatch(pick('pastChecklist'), /onclick/, '旧清单只能看，不能勾');
  assert.match(pick('verdictEl'), /a && !past \? h\('button'/, '旧任务的终点不能点开现在的验收');
});

test('网页交接单：交接的每一节是一行（做了、没做完、拿不准、验证），「状态」写在右上角；没按格式写的整篇放一行', () => {
  const code = ['SECTION', 'handoffForm'].map(pick).join('\n\n');
  const run = (text: string) => {
    const ctx: Record<string, unknown> = {};
    runWeb(
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

test('网页：人带上的文件——最后一段全是反引号括起来的路径才算附件；传上来的图片画缩略图，名字去掉前面加的时间', () => {
  const code = ['basename', 'UPLOADS', 'isShot', 'fileLabel', 'splitFiles'].map(pick).join('\n');
  const ctx: Record<string, unknown> = {};
  runWeb(`${code}\nresult = { isShot, fileLabel, splitFiles };`, ctx);
  const { isShot, fileLabel, splitFiles } = ctx.result as { isShot: (p: string) => boolean; fileLabel: (p: string) => string; splitFiles: (t: string) => { body: string; files: string[] } };
  const up = '.relay/uploads/0926-2310-截屏 2026-09-26 22.39.31.png';
  assert.deepEqual(JSON.parse(JSON.stringify(splitFiles(`图里是什么？\n\n\`${up}\` \`src/a.py\``))), { body: '图里是什么？', files: [up, 'src/a.py'] });
  assert.deepEqual(JSON.parse(JSON.stringify(splitFiles(`\`${up}\``))), { body: '', files: [up] }, '只传了图没写字');
  assert.deepEqual(JSON.parse(JSON.stringify(splitFiles('跑一下 `npm test`'))).files, [], '句子里的代码不是附件');
  assert.deepEqual(JSON.parse(JSON.stringify(splitFiles('第一段\n\n`npm test`'))).files, [], '不像路径的不算');
  assert.equal(isShot(up), true);
  assert.equal(isShot('src/logo.png'), false, '项目里本来的图片不画缩略图（点开是文件）');
  assert.equal(isShot('.relay/uploads/0926-2310-说明.pdf'), false);
  assert.equal(fileLabel(up), '截屏 2026-09-26 22.39.31.png');
  assert.equal(fileLabel('docs/0926-2310-x.md'), '0926-2310-x.md', '只去掉传上来的文件前面加的时间');
});

test('网页的一棒：没成的（出错、额度用完、中途停了）卡片上那一句写原因，不写「交接里没写做了什么」', () => {
  const ctx: Record<string, unknown> = {};
  runWeb(`${['FAILED', 'summaryOf'].map(pick).join('\n\n')}\nresult = summaryOf;`, ctx);
  const summaryOf = ctx.result as (s: Record<string, unknown>) => { text: string; faint?: boolean };
  assert.equal(summaryOf({ status: 'failed', note: '退出码 1，原话：Cannot use this model', handoff: 'a.md' }).text, '退出码 1，原话：Cannot use this model');
  assert.equal(summaryOf({ status: 'quota', note: '额度用完，15:00 恢复', handoff: 'a.md' }).text, '额度用完，15:00 恢复');
  assert.equal(summaryOf({ status: 'handed', note: '你标记过不用复核', handoff: 'a.md' }).text, '交接里没写做了什么', '交了的一棒：说明不顶替摘要');
});

test('网页的三页：派活页只列在派活页写的任务，接力页列别的；收尾写强、弱模型各用了多少 token', () => {
  const ctx: Record<string, unknown> = {};
  runWeb(
    `${['threads', 'pageThreads', 'pageOf', 'tokenText', 'tokenSplit'].map(pick).join('\n\n')}
const S = { view: 'dispatch', st: { project: { threads: [{ id: 't0' }, { id: 't1', mode: 'dispatch' }, { id: 't2' }] } } };
const stints = { 1: { who: { tier: 'strong' }, tokens: { input: 30000, output: 2000 } }, 2: { who: { tier: 'weak' }, tokens: { input: 150000, output: 9000 } }, 3: { who: { tier: 'strong' } } };
const stintById = (id) => stints[id];
const dispatch = pageThreads().map((t) => t.id);
S.view = 'relay';
result = { dispatch, relay: pageThreads().map((t) => t.id), page: pageOf({ mode: 'dispatch' }), split: tokenSplit([1, 2, 3]), small: tokenText(860) };`,
    ctx
  );
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.result)), { dispatch: ['t1'], relay: ['t0', 't2'], page: 'dispatch', split: '强模型 3.2 万，弱模型 15.9 万 token（1 棒没报用量）', small: '860' });
});

test('网页切页：接力、派活页打开最近一个没做完的任务（有待复核的算没做完），都做完了开空白新任务；群聊接还在说的那段，都静了回到正在用的那段', () => {
  const ctx: Record<string, unknown> = {};
  runWeb(
    `${['threads', 'pageThreads', 'blank', 'accepted', 'threadDone', 'pickUnfinished'].map(pick).join('\n\n')}
const loaded = [];
const loadArchive = (id) => loaded.push(id);
const S = { view: 'relay', draft: false, thread: null, st: { project: { acceptance: null, threads: [
  { id: 't0', title: '旧的', stints: [1], accept: { state: 'accepted' } },
  { id: 't1', title: '换掉时没做完', stints: [2] },
  { id: 't2', title: '派活的', stints: [3], mode: 'dispatch' },
  { id: 't3', title: '正在做', stints: [4], current: true, pending: 1 },
] } } };
const out = {};
pickUnfinished(); out.current = [S.draft, S.thread];
S.st.project.threads[3].pending = 0; S.st.project.acceptance = { state: 'accepted' };
pickUnfinished(); out.older = [S.draft, S.thread];
S.st.project.threads[1].accept = { state: 'accepted' };
pickUnfinished(); out.allDone = [S.draft, S.thread];
S.view = 'dispatch'; pickUnfinished(); out.dispatch = [S.draft, S.thread];
S.view = 'chat'; S.chat = 'old'; S.talk = { status: { speaking: [], queue: [] }, sessions: [{ id: 'old' }, { id: 'live-1', busy: true }] };
pickUnfinished(); out.busy = [S.chat, loaded.join()];
S.talk.sessions[1].busy = false; pickUnfinished(); out.quiet = S.chat;
S.chat = 'old'; S.talk.status.speaking = [{ agent: 'codex' }]; pickUnfinished(); out.speaking = S.chat;
result = out;`,
    ctx
  );
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.result)), {
    current: [false, null],
    older: [false, 't1'],
    allDone: [true, null],
    dispatch: [false, 't2'],
    busy: ['live-1', 'live-1'],
    quiet: null,
    speaking: 'old',
  });
});

test('成员名单的额度：第二行写「5 小时 5% · 一周 72%」，悬停写几点恢复；没报过额度就什么都不写', () => {
  const code = ['pad', 'clock', 'aheadClock', 'LIMIT_WORD', 'limitsText', 'limitsTip'].map(pick).join('\n\n');
  const ctx: Record<string, unknown> = {};
  runWeb(`${code}\nresult = { limitsText, limitsTip };`, ctx);
  const { limitsText, limitsTip } = ctx.result as { limitsText: (m: object) => string; limitsTip: (m: object) => string | null };
  const soon = new Date();
  soon.setMinutes(soon.getMinutes() + 30, 0, 0);
  const at = `${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}`;
  const m = { limits: [{ kind: '5h', used: 5.4, resetsAt: soon.toISOString() }, { kind: '7d', used: 72 }] };
  assert.equal(limitsText(m), '5 小时 5% · 一周 72%');
  assert.ok(limitsTip(m)!.startsWith('5 小时 '), limitsTip(m)!);
  assert.ok(limitsTip(m)!.includes(`${at} 恢复`), limitsTip(m)!);
  assert.ok(!limitsTip(m)!.includes('一周'), '没给恢复时间的窗口不写');
  const tmr = new Date();
  tmr.setDate(tmr.getDate() + 1);
  tmr.setHours(0, 30, 0, 0);
  assert.equal(limitsTip({ limits: [{ kind: '5h', used: 1, resetsAt: tmr.toISOString() }] }), '5 小时 明天 00:30 恢复');
  assert.equal(limitsText({ limits: [{ kind: '7d-opus', used: 40 }] }), 'Opus 40%');
  assert.equal(limitsText({}), '');
  assert.equal(limitsTip({}), null);
});
