/**
 * 给人看的名字：成员一律叫它用的模型（GPT-6 Sol、Claude Opus 5.5、Grok 4.7），工具（Codex、Cursor……）只是它在哪儿跑。
 * 网页 app.js 里的 llmName 和这里是同一套规则（没有构建步骤，只能各写一份），test/web.test.ts 拿同一张表对照两边。
 */

const WORD: Record<string, string> = { gpt: 'GPT', glm: 'GLM', mimo: 'MiMo', deepseek: 'DeepSeek', qwq: 'QwQ' };
/** 模型名后面跟的思考强度、快慢、日期：不算名字的一部分。 */
const VARIANT = /^(none|low|medium|high|xhigh|extra|max|ultra|minimal|fast|thinking|preview|latest|\d{8})$/i;

/** gpt-6-sol → GPT-6 Sol；claude-opus-5-5、opus → Claude Opus 5.5、Claude Opus；cursor-grok-4.6-high-fast → Grok 4.6；deepseek/deepseek-flash → DeepSeek Flash。 */
export function llmName(model: string | null | undefined): string {
  const w = String(model ?? '')
    .trim()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/\s*\([^)]*\)$/, '')
    .replace(/^.*\//, '')
    .replace(/^cursor-/i, '')
    .split(/[-_\s]+/)
    .filter(Boolean);
  while (w.length > 1 && VARIANT.test(w[w.length - 1])) w.pop();
  if (!w.length) return '';
  if (/^(opus|sonnet|haiku|fable)$/i.test(w[0])) w.unshift('claude');
  // Claude 的版本号用 - 隔开写（opus-5-5、3-5-sonnet）：接回 5.5、3.5
  if (/^claude$/i.test(w[0])) for (let i = w.length - 1; i >= 2; i--) if (/^\d+$/.test(w[i]) && /^\d+$/.test(w[i - 1])) w.splice(i - 1, 2, `${w[i - 1]}.${w[i]}`);
  const word = (x: string) => WORD[x.toLowerCase()] ?? (/^[vk]\d/i.test(x) ? x.toUpperCase() : /^\d/.test(x) ? x : x[0].toUpperCase() + x.slice(1));
  let head = word(w[0]);
  let i = 1;
  // GPT-6、GLM-5.3：牌子和版本号连着写
  if (/^(gpt|glm)$/i.test(w[0]) && /^\d/.test(w[1] ?? '')) {
    head += `-${w[1]}`;
    i = 2;
  }
  return [head, ...w.slice(i).map(word)].join(' ');
}

/** 接口列出来的不是对话模型的：语音、转写、向量、画图、审核。 */
const NOT_CHAT = /(^|[-_./])(tts|asr|voice\w*|speech|audio|whisper|transcribe|realtime|embed\w*|rerank\w*|moderation|image|dall-e)([-_.]|$)/i;

/** 同一个模型的几档里挑哪个：不带「快」（贵）的先，档位 不写 > high > medium > xhigh > extra-high > max > low > minimal > none。 */
const EFFORT_PREF = ['high', 'medium', 'xhigh', 'extra', 'max', 'low', 'minimal', 'none'];
function variantRank(id: string): number {
  const w = id.toLowerCase().split(/[-_\s]+/);
  return (w.includes('fast') ? 20 : 0) + Math.max(-1, ...EFFORT_PREF.map((x, i) => (w.includes(x) ? i : -1))) + 1;
}

/**
 * 工具列出来的模型并成给人挑的几项：同一个模型的几档（思考强度、快慢）只留一个，名字按 llmName。
 * shown：给人看时换成哪个名字（Claude Code 的简称 → 最近实际用的那个），调用时还用原来的 id。
 */
export function modelChoices(ids: string[], shown: (id: string) => string = (id) => id): { id: string; name: string; shown: string }[] {
  const best = new Map<string, { id: string; name: string; shown: string }>();
  for (const id of ids) {
    const s = shown(id);
    const name = llmName(s);
    if (!name || /^(auto|default)$/i.test(id) || NOT_CHAT.test(id)) continue;
    const had = best.get(name);
    if (!had || variantRank(id) < variantRank(had.id)) best.set(name, { id, name, shown: s });
  }
  return [...best.values()];
}

/** 牌子（GPT-6 Sol → gpt，Claude Opus 5.5 → claude）和版本号（6、5.5）：挑「同一家最新的几个」用。 */
const vendorOf = (name: string) => (name.split(' ')[0] ?? '').replace(/-[\d.]+$/, '').toLowerCase();
const versionOf = (name: string) => (name.match(/\d+(?:\.\d+)*/)?.[0] ?? '0').split('.').map(Number);
function newer(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0);
  return 0;
}

/**
 * 换模型时平时露出来的几个：现在用的，加上同一家版本最新的几个（一共 n 个），别的打字搜。
 * 不知道现在用的是哪个：按工具列出来的先后取前 n 个。
 */
export function topModels(names: string[], current: string | undefined, n = 5): string[] {
  if (!current || !names.includes(current)) return names.slice(0, n);
  const v = vendorOf(current);
  const same = names.filter((x) => x !== current && vendorOf(x) === v).sort((a, b) => newer(versionOf(a), versionOf(b)));
  return [current, ...same.slice(0, n - 1)];
}

/** 同一条线：牌子加上版本号以外的字（GPT-6 Sol → gpt|sol，MiMo V2.6 Pro → mimo|pro，Grok 4.7 → grok）。 */
const lineOf = (name: string) => [vendorOf(name), ...name.split(' ').slice(1).filter((w) => !/\d/.test(w)).map((w) => w.toLowerCase())].join('|');

/**
 * 同一条线上比现在用的新的那一个（GPT-6 Sol → GPT-6.1 Sol，GLM-5.3 Flash → GLM-5.4 Flash），没有就是 null。
 * 没写版本号的简称（Claude Opus）本来就跟着最新的走，不提。
 */
export function newerInLine(current: string, names: string[]): string | null {
  if (!/\d/.test(current)) return null;
  const line = lineOf(current);
  let best: string | null = null;
  for (const n of names) {
    if (n === current || lineOf(n) !== line || newer(versionOf(current), versionOf(n)) <= 0) continue;
    if (!best || newer(versionOf(best), versionOf(n)) > 0) best = n;
  }
  return best;
}

/** 一棒是谁做的（记下的是「Codex · gpt-6-sol」）给人看的名字：GPT-6 Sol；看不出模型的写工具名。 */
export function whoName(who: { label: string; model?: string }): string {
  const [tool, ...rest] = who.label.split(' · ');
  return llmName(who.model ?? rest.join(' · ')) || tool;
}

/** 工具的名字（成员名字底下那一行）：同一个工具的不同用法写成一个名字。 */
const TOOLS: Record<string, string> = {
  claude: 'Claude Code',
  'claude-official': 'Claude Code',
  codex: 'Codex',
  'cursor-agent': 'Cursor',
  dsh: 'DeepSeek Harness',
  zcode: 'ZCode',
  agy: 'Antigravity',
  gemini: 'Gemini CLI',
  qwen: 'Qwen Code',
  opencode: 'OpenCode',
  droid: 'Droid',
  copilot: 'Copilot',
  grok: 'Grok CLI',
};

export function toolName(harness: string | undefined): string | undefined {
  return harness ? TOOLS[harness] ?? harness : undefined;
}

/** 桌面程序的名字：open -a "Xiaomi MiMo" {{dir}} → Xiaomi MiMo。 */
export function appNameOf(cmd: string | undefined): string | undefined {
  const m = (cmd ?? '').match(/-a\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return m ? m[1] ?? m[2] ?? m[3] : undefined;
}
