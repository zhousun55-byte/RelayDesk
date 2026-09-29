import { countedReviews, statusWord, verdictWord, type BaseEvent, type LedgerView, type Stint, type Verdict } from './ledger';
import { whoName } from './names';
import { taskProgress, taskVersion, type TaskDoc } from './notes';
import { plain } from './cause';

/**
 * 验收：这件事能不能算「做完了」。只有这里说了算——全自动收工、网页顶部、接力本、命令行都用它，不各算各的。
 *
 * 清单打勾只说明「AI 说做完了」。能收工还要：
 * - 每一棒弱模型的活都有强模型复核过，而且结论是没问题 / 已修好 / 已退回（有问题、证据不足、没写清楚都不算）；
 * - 开着终审时，最后一棒干活之后有一次终审：交接成功、实际是强模型、结论通过、终审之后没人再改文件（检查命令改了源码也算）、任务也没改过，而且之后没有算数的终审否决它；
 * - 配了检查命令时，最后一次改动之后按现在配的命令跑过检查，而且通过了；检查命令自己改了源码的，要再跑一次；
 * - 证据都读得到（配置文件没坏、每一棒的改动都读得到）。读不到就是「没法判断」，不能当成通过；
 * - 文件夹和账本最后记下的样子一致（在接力台之外改过，要等对完账、算进一棒）。
 */

export type AcceptState = 'accepted' | 'working' | 'blocked' | 'unknown';

/** 终审只认这两种：没问题、有问题已修好（「改坏了，已退回」说明整件事还没做对）。 */
const FINAL_PASS: ReadonlySet<Verdict> = new Set<Verdict>(['ok', 'fixed']);

export interface AcceptItem {
  kind: 'task' | 'open' | 'review' | 'final' | 'gate' | 'evidence' | 'config';
  text: string;
  stint?: number;
}

export interface Acceptance {
  /** accepted 验收通过 / working 还在做（清单没打完、有棒进行中）/ blocked 清单打完了但验收没过 / unknown 证据读不到，没法判断 */
  state: AcceptState;
  /** 一句话给人看。 */
  headline: string;
  progress: { done: number; total: number };
  /** 还差什么（验收通过时为空）。 */
  items: AcceptItem[];
  /** 待复核的棒。 */
  pending: number[];
  final: { required: boolean; ok: boolean; stint?: number; text: string };
  gate: { command: string; status: 'pass' | 'fail' | 'error' | 'none' | 'stale' | 'off'; stint?: number; text: string };
}

export interface AcceptInput {
  ledger: LedgerView;
  task: TaskDoc;
  gateCommand: string;
  /** 配置文件坏了的原因（读得到就不给）。 */
  configError?: string;
  /** 全自动设置里开着终审。 */
  finalRequired: boolean;
  /** 文件夹里有账本还没记上的改动（在接力台之外改的，对一次账才知道是谁改的）：之前的检查、终审都不算现在的代码。 */
  unrecorded?: boolean;
}

function changed(s: Stint): boolean {
  return !!s.factsError || (s.facts?.files ?? 0) > 0;
}

/** 检查命令改到的源码：「a.js、b.js」，多了写「等 N 个」。 */
function fileList(files: string[]): string {
  return `${files.slice(0, 3).join('、')}${files.length > 3 ? ` 等 ${files.length} 个` : ''}`;
}

/** 一棒为什么还在待复核（不带「第 N 棒」；普通的待复核返回空）。 */
export function pendingWhy(s: Stint, rolledBack: ReadonlySet<number> = new Set()): string {
  if (s.factsError) return '读不到改动';
  const last = countedReviews(s, rolledBack).at(-1);
  if (last) return `复核结论「${verdictWord(last.verdict)}」（${last.byLabel}）`;
  const marks = s.reviews ?? [];
  if (marks.some((m) => m.weak && !m.anon)) return '只有弱模型复核过，不算数';
  if (marks.some((m) => m.anon)) return '认不出复核是谁写的，不算数';
  if (marks.some((m) => m.by && rolledBack.has(m.by))) return '复核它的那一棒被退回了';
  if (!s.facts?.files && s.ticked?.length) return `没改文件，只打了勾（${s.ticked.slice(0, 3).join('、')}${s.ticked.length > 3 ? '……' : ''}）`;
  return '';
}

/** 一棒为什么还在待复核（给人看）。 */
export function pendingReason(s: Stint, rolledBack: ReadonlySet<number> = new Set()): string {
  const why = pendingWhy(s, rolledBack);
  return `第 ${s.id} 棒${why ? why : '待复核'}`;
}

export function acceptance(input: AcceptInput): Acceptance {
  const v = input.ledger;
  const p = taskProgress(input.task);
  const items: AcceptItem[] = [];
  const dropped = new Set(v.stints.filter((s) => s.rolledBack).map((s) => s.id));
  const live = v.stints.filter((s) => !s.rolledBack);
  const closed = live.filter((s) => s.status !== 'working');

  // 证据
  if (input.configError) items.push({ kind: 'config', text: `配置文件坏了：${input.configError}` });
  // 账本坏了几行：坏的可能正好是一次退回、一份复核，跳过它们算出来的结论不可信。
  if (v.bad?.length) {
    const lines = v.bad.map((b) => b.line);
    items.push({ kind: 'evidence', text: `账本 .relay/journal.jsonl 第 ${lines.slice(0, 5).join('、')}${lines.length > 5 ? ' 等' : ''} 行读不出来` });
  }
  // 强模型的棒不用复核，但读不到它改了什么（改没改不许改的文件都不知道）：没法判断。弱模型的这种棒已经算待复核了，下面会列。
  for (const s of closed.filter((x) => x.kind === 'work' && x.factsError && x.review === 'skip')) items.push({ kind: 'evidence', text: `第 ${s.id} 棒读不到改动`, stint: s.id });

  // 清单和进行中的棒
  if (input.task.empty) items.push({ kind: 'task', text: '还没写任务' });
  else if (!p.total) items.push({ kind: 'task', text: '任务还没拆成步骤' });
  else if (p.done < p.total) items.push({ kind: 'task', text: `清单 ${p.done}/${p.total}` });
  if (v.open) items.push({ kind: 'open', text: `第 ${v.open.id} 棒还在进行中`, stint: v.open.id });
  else if (input.unrecorded) items.push({ kind: 'open', text: '文件夹里有还没记上账的改动' });

  // 复核
  // 删掉的对话里的棒不算（见 ledger.ts 的 deletedStintIds）
  const pending = closed.filter((s) => s.review === 'needed' && !v.deleted?.has(s.id));
  for (const s of pending) items.push({ kind: 'review', text: pendingReason(s, dropped), stint: s.id });

  // 终审
  const lastWork = [...live].reverse().find((s) => s.kind === 'work');
  const finals = closed.filter((s) => s.kind === 'final' && s.id > (lastWork?.id ?? 0));
  // 检查命令跑完改了源码（格式化、自动修复……）：跟在哪一棒后面跑的就记在哪一棒之后。退回掉的棒后面跑的不算（改动跟着退掉了）。
  const gateEdits = v.events.filter((e): e is BaseEvent & { after: number; files: string[] } => e.type === 'base' && typeof e.after === 'number' && !!e.files?.length && !dropped.has(e.after));
  const gateEditAfter = (f: Stint) => gateEdits.find((e) => e.after >= f.id);
  const changedAfter = (f: Stint) => live.some((x) => x.id > f.id && changed(x)) || !!gateEditAfter(f);
  // 终审之后任务改过（加了步骤、改了要求、勾变了）：它审的不是现在的任务。旧账本没记版本的不比。
  const tv = taskVersion(input.task);
  const taskMoved = (f: Stint) => !!f.taskVer && f.taskVer !== tv;
  // 最近一次算数的终审（交接成功、实际强模型、留了结论）说了算：它没通过，更早的通过也不作数。
  const latest = [...finals].reverse().find((f) => f.status === 'handed' && f.who.tier === 'strong' && !!f.verdict);
  const good = latest && FINAL_PASS.has(latest.verdict!) && !changedAfter(latest) && !taskMoved(latest) ? latest : undefined;
  let final: Acceptance['final'] = { required: input.finalRequired, ok: !input.finalRequired, text: input.finalRequired ? '还没终审' : '没开终审' };
  if (input.finalRequired) {
    if (good) final = { required: true, ok: true, stint: good.id, text: `${whoName(good.who)} 终审过了` };
    else {
      const f = latest && !FINAL_PASS.has(latest.verdict!) ? latest : finals.at(-1);
      const text = !f
        ? '还没终审'
        : f.status !== 'handed'
          ? `终审${statusWord(f.status)}（${whoName(f.who)}${f.note ? `，${plain(f.note).slice(0, 80)}` : ''}）`
          : f.who.tier !== 'strong'
            ? `终审实际是弱模型做的（${whoName(f.who)}），不算数`
            : !f.verdict
              ? `终审没留下结论（${whoName(f.who)}）`
              : !FINAL_PASS.has(f.verdict)
                ? `终审结论「${verdictWord(f.verdict)}」（${whoName(f.who)}）`
                : live.some((x) => x.id > f.id && changed(x))
                  ? '终审之后文件又改过'
                  : gateEditAfter(f)
                    ? `终审之后检查命令改了 ${fileList(gateEditAfter(f)!.files)}`
                    : '终审之后任务改过';
      final = { required: true, ok: false, ...(f ? { stint: f.id } : {}), text };
      items.push({ kind: 'final', text, ...(f ? { stint: f.id } : {}) });
    }
  }

  // 检查
  let gate: Acceptance['gate'] = { command: input.gateCommand, status: 'off', text: '没配检查命令' };
  if (input.gateCommand) {
    const lastChange = [...closed].reverse().find(changed);
    const gated = [...closed].reverse().find((s) => s.gate);
    if (!gated) gate = { command: input.gateCommand, status: 'none', text: '还没跑过检查' };
    // 检查命令改过：以前按旧命令跑的结果不算现在的检查。
    else if (gated.gate!.status !== 'error' && gated.gate!.command.trim() !== input.gateCommand.trim()) gate = { command: input.gateCommand, status: 'stale', stint: gated.id, text: '检查命令改过之后还没跑检查' };
    else if (lastChange && gated.id < lastChange.id) gate = { command: input.gateCommand, status: 'stale', stint: gated.id, text: `第 ${lastChange.id} 棒改了文件之后还没跑检查` };
    // 检查命令自己改了源码：这次的结果不一定是改过之后的代码的，要按改过的再跑一次（再跑时没再改，就算数）。
    else if (gated.gate!.status !== 'error' && gateEdits.some((e) => e.after >= gated.id && (!gated.gate!.at || Date.parse(e.ts) >= Date.parse(gated.gate!.at)))) {
      const e = [...gateEdits].reverse().find((x) => x.after >= gated.id)!;
      gate = { command: input.gateCommand, status: 'stale', stint: gated.id, text: `检查命令改了 ${fileList(e.files)}，还没按改过的再跑检查` };
    }
    else if (gated.gate!.status === 'pass') gate = { command: input.gateCommand, status: 'pass', stint: gated.id, text: '检查通过' };
    else if (gated.gate!.status === 'fail') gate = { command: input.gateCommand, status: 'fail', stint: gated.id, text: `检查没过（第 ${gated.id} 棒之后）` };
    else gate = { command: input.gateCommand, status: 'error', stint: gated.id, text: gated.gate!.detail ?? '检查没跑成' };
    if (gate.status !== 'pass') items.push({ kind: 'gate', text: gate.text, ...(gate.stint ? { stint: gate.stint } : {}) });
  }

  const unknown = items.some((i) => i.kind === 'config' || i.kind === 'evidence');
  const working = items.some((i) => i.kind === 'task' || i.kind === 'open');
  const state: AcceptState = unknown ? 'unknown' : working ? 'working' : items.length ? 'blocked' : 'accepted';
  const list = (xs: AcceptItem[]) => xs.map((i) => i.text).slice(0, 3).join('；') + (xs.length > 3 ? `；还有 ${xs.length - 3} 项` : '');
  const progress = p.total ? `清单 ${p.done}/${p.total}` : '';
  const headline =
    state === 'accepted'
      ? `验收通过：${[progress && `${progress} 全部打勾`, final.required ? final.text : '', gate.status === 'pass' ? '检查通过' : ''].filter(Boolean).join('，')}`
      : state === 'unknown'
        ? `没法验收：${list(items.filter((i) => i.kind === 'config' || i.kind === 'evidence'))}`
        : state === 'working'
          ? [items.find((i) => i.kind === 'open')?.text, input.task.empty ? '还没写任务' : progress || '任务还没拆成步骤', pending.length ? `待复核 ${pending.length} 棒` : ''].filter(Boolean).join('，')
          : `验收没过：${list(items)}`;
  return { state, headline, progress: p, items, pending: pending.map((s) => s.id), final, gate };
}
