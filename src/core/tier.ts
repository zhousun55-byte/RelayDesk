import type { Tier3, Who } from './ledger';
import type { AgentConfig, Tier } from './types';

/**
 * 强和弱：看的是模型，不是工具（Claude Code 接的是 DeepSeek，它就是弱）。
 * 默认按模型名猜；你在设置里改过的以你为准（工人名单里 tierSet = true）。
 */

/** 名字里带这些的是同一家的小号、快速版，按弱算。 */
const SMALL = /(^|[-_\s.])(mini|flash|lite|nano|haiku|small|tiny|air|instant)([-_\s.]|$)/i;
/** 默认算强的：Claude 大号、GPT-5 及以上、o3/o4、Gemini Pro / 3 及以上、Grok 4 及以上。 */
const STRONG = /claude|opus|sonnet|gpt-?([5-9]|\d{2})|(^|[^a-z])o[34]([^a-z0-9]|$)|gemini.*pro|gemini-?([3-9])|grok-?([4-9])/i;

export function tierForModel(model: string | undefined | null): Tier3 {
  const m = (model ?? '').trim();
  if (!m) return 'unknown';
  if (SMALL.test(m)) return 'weak';
  if (STRONG.test(m)) return 'strong';
  return 'weak';
}

/** 名单里一位的强弱：你设过的优先；知道模型就按模型猜；不知道模型（桌面程序）用名单里记的。 */
export function memberTier(a: Pick<AgentConfig, 'tier' | 'tierSet'>, model: string | undefined): Tier {
  if (a.tierSet) return a.tier;
  const t = tierForModel(model);
  if (t === 'unknown') return a.tier;
  return t;
}

/** 认得的工具名（交接里写的「工具」和工人名单对上）。 */
const TOOL_WORDS: { id: string; re: RegExp; label: string }[] = [
  { id: 'claude', re: /claude[\s-]*code|\bcc\b/i, label: 'Claude Code' },
  { id: 'codex', re: /codex/i, label: 'Codex' },
  { id: 'cursor-agent', re: /cursor/i, label: 'Cursor' },
  { id: 'zcode', re: /z\s*code|智谱/i, label: 'ZCode' },
  { id: 'mimo', re: /mimo|小米/i, label: 'MiMo' },
  { id: 'gemini', re: /gemini[\s-]*cli/i, label: 'Gemini CLI' },
  { id: 'qwen', re: /qwen[\s-]*code/i, label: 'Qwen Code' },
  { id: 'opencode', re: /opencode/i, label: 'OpenCode' },
  { id: 'agy', re: /antigravity|\bagy\b/i, label: 'Antigravity' },
  { id: 'copilot', re: /copilot/i, label: 'Copilot' },
  { id: 'trae', re: /trae/i, label: 'Trae' },
  { id: 'windsurf', re: /windsurf/i, label: 'Windsurf' },
  { id: 'kiro', re: /kiro/i, label: 'Kiro' },
  { id: 'claude-app', re: /^claude$|claude\s*(desktop|桌面|app)/i, label: 'Claude' },
  { id: 'chatgpt', re: /chatgpt/i, label: 'ChatGPT' },
];

/** 从「Codex · gpt-6」这种写法里拆出模型名（「·」「/」「(」后面那段）。 */
export function modelFromLabel(text: string): string | undefined {
  const m = text.match(/[·•|/（(]\s*([A-Za-z][\w.\-:[\]]*)/);
  return m?.[1];
}

export interface MemberLike {
  name: string;
  label: string;
  model?: string;
  tier: Tier;
  harness?: string;
  /** 强弱是你在设置里定的。 */
  tierSet?: boolean;
}

/**
 * 从交接里它自己写的身份认出是谁：先对上工具，再看模型。
 * 写了模型就按模型定强弱（同一个工具可能换了模型）；没写模型就用名单里这个工具的模型。
 */
export function resolveWho(claim: { who?: string; tool?: string; model?: string }, members: MemberLike[]): Who {
  const text = [claim.who, claim.tool, claim.model].filter(Boolean).join(' ');
  const claimed = [claim.who, claim.tool && !claim.who?.includes(claim.tool) ? claim.tool : '', claim.model && !claim.who?.includes(claim.model) ? claim.model : '']
    .filter(Boolean)
    .join(' · ')
    .trim();
  if (!text.trim()) return { label: '不知道是谁', tier: 'unknown' };
  const model = claim.model?.trim() || modelFromLabel(claim.who ?? '');
  const tool = TOOL_WORDS.find((t) => t.re.test(claim.tool ?? '') || t.re.test(claim.who ?? ''));
  const byTool = tool ? members.filter((m) => m.harness === tool.id || m.name === tool.id || new RegExp(tool.re.source, 'i').test(m.label)) : [];
  const byModel = model ? members.filter((m) => m.model && norm(m.model) === norm(model)) : [];
  const hit = byTool.find((m) => byModel.includes(m)) ?? (model ? byModel[0] ?? (byTool.length === 1 && !byTool[0].model ? byTool[0] : undefined) : byTool[0]);
  // 你在设置里给这个工具定过强弱：以你为准（不管它这次用的什么模型）。
  const decided = [hit, ...byTool].find((m) => m?.tierSet);
  const tier: Tier3 = decided
    ? decided.tier
    : model
      ? hit && hit.model && norm(hit.model) === norm(model)
        ? hit.tier
        : tierForModel(model)
      : hit
        ? hit.tier
        : 'unknown';
  const label = hit ? `${hit.label}${model ?? hit.model ? ` · ${model ?? hit.model}` : ''}` : claimed || text.trim();
  return {
    ...(hit ? { member: hit.name } : {}),
    label,
    ...(tool ? { tool: tool.id } : hit?.harness ? { tool: hit.harness } : {}),
    ...(model ?? hit?.model ? { model: model ?? hit?.model } : {}),
    tier,
    ...(claimed && claimed !== label ? { claimed } : {}),
  };
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/[\s_]/g, '-');
}

/** 接力台调度的成员：身份是确定的。 */
export function whoOfMember(m: MemberLike): Who {
  return { member: m.name, label: `${m.label}${m.model ? ` · ${m.model}` : ''}`, ...(m.harness ? { tool: m.harness } : {}), ...(m.model ? { model: m.model } : {}), tier: m.tier };
}

export const UNKNOWN_WHO: Who = { label: '不知道是谁', tier: 'unknown' };

/** 这一棒要不要复核：强模型自己交接的不用；弱的、不知道是谁的、没留交接的都要。 */
export function needsReview(who: Who, hasHandoff: boolean): boolean {
  return who.tier !== 'strong' || !hasHandoff;
}
