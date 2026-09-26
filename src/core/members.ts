import { listMembers, loadDetected, memberModel, siblingOf, type DetectReport } from './detect';
import type { Level } from './harness';
import { coolingUntil, loadQuota } from './quota';
import { agentKind, agentLabel, canTalk, loadRegistry } from './registry';
import { memberTier, type MemberLike } from './tier';
import type { AgentConfig } from './types';

/**
 * 成员：工人名单里的每一位，加上现在能不能用。
 * - harness：认得的编程工具（接力台能替你调度它干活、复核、群聊）；
 * - api：模型接口（接力台用内置小代理让它干活）；
 * - app：桌面程序（只能你自己打开它接着做；接力台负责记账）。
 */
export interface MemberInfo extends MemberLike {
  kind: 'harness' | 'api' | 'app';
  agent: AgentConfig;
  /** 接力台能不能调度它干活。 */
  canWork: boolean;
  canTalk: boolean;
  /** 不能用的原因。 */
  why?: string;
  /** 额度用完、在等恢复（ISO 时间）。 */
  cooling?: string;
  /** 强弱是你定的。 */
  tierSet: boolean;
}

export function allMembers(level: Level = 'safe', report: DetectReport | null = loadDetected(), now = new Date()): MemberInfo[] {
  const quota = loadQuota();
  const auto = new Map(listMembers(level, report).map((m) => [m.name, m]));
  const out: MemberInfo[] = [];
  for (const a of loadRegistry().agents) {
    const kind = agentKind(a);
    const model = memberModel(a, report);
    const tier = memberTier(a, model);
    const cooling = coolingUntil(a.name, now, quota) ?? undefined;
    const m = auto.get(a.name);
    const base = { name: a.name, label: agentLabel(a), ...(model ? { model } : {}), tier, agent: a, canTalk: canTalk(a), tierSet: !!a.tierSet, ...(cooling ? { cooling } : {}) };
    if (m) {
      out.push({ ...base, kind: m.kind, ...(m.harness ? { harness: m.harness } : {}), canWork: m.canWork, ...(m.why ? { why: m.why } : {}) });
    } else if (kind === 'app') {
      out.push({ ...base, kind: 'app', canWork: false, why: '桌面程序：你自己打开它接着做，接力台负责记账。' });
    } else if (kind === 'api') {
      out.push({ ...base, kind: 'api', canWork: false, why: '接口没配好' });
    } else {
      out.push({ ...base, kind: 'harness', canWork: false, why: a.harness ? '这台电脑上找不到它' : '不认得这个命令，只能你自己在终端里用' });
    }
  }
  // 还没并进同一家的桌面程序（刚加进来、还没识别过）：借那一位的模型来判断强弱（ZCode 桌面版和 ZCode 命令行用的是同一个 GLM）。
  for (const m of out) {
    if (m.kind !== 'app' || m.tierSet || m.model) continue;
    const sib = siblingOf(
      m.agent,
      out.map((x) => x.agent),
      report
    );
    const sm = sib && memberModel(sib, report);
    if (!sm) continue;
    m.model = sm;
    m.tier = memberTier(m.agent, sm);
  }
  return out;
}

/** 现在能派活的：能调度、不在等额度。 */
export function readyMembers(list: MemberInfo[]): MemberInfo[] {
  return list.filter((m) => m.canWork && !m.cooling);
}

/** 按「强的在前、再按工具的默认顺序」排。 */
export function byStrength(list: MemberInfo[]): MemberInfo[] {
  const rank = (m: MemberInfo) => (m.tier === 'strong' ? 0 : 1000) + (m.kind === 'api' ? 500 : 0);
  return [...list].sort((a, b) => rank(a) - rank(b));
}

/** 按设置里的顺序排（没写到的按强弱排在后面）。 */
export function orderMembers(list: MemberInfo[], order: string[]): MemberInfo[] {
  const named = order.map((n) => list.find((m) => m.name === n)).filter((m): m is MemberInfo => !!m);
  const rest = byStrength(list.filter((m) => !order.includes(m.name)));
  return [...named, ...rest];
}
