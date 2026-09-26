/**
 * 给人看的名字：成员一律叫它用的模型（GPT-6 Sol、Claude Opus 5.5、Grok 4.7），工具（Codex、Cursor……）只是它在哪儿跑。
 * 网页 app.js 里的 llmName 和这里是同一套规则（没有构建步骤，只能各写一份），test/web.test.ts 拿同一张表对照两边。
 */

const WORD: Record<string, string> = { gpt: 'GPT', glm: 'GLM', mimo: 'MiMo', deepseek: 'DeepSeek', qwq: 'QwQ' };
/** 模型名后面跟的思考强度、快慢、日期：不算名字的一部分。 */
const VARIANT = /^(low|medium|high|xhigh|max|ultra|minimal|fast|thinking|preview|latest|\d{8})$/i;

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
