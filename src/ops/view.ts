import fs from 'node:fs';
import path from 'node:path';
import { acceptance, pendingWhy, type Acceptance } from '../core/acceptance';
import { loadAutoSettings } from '../core/auto-settings';
import { countedReviews, loadLedger, statusWord, stintTitle, tierWord, verdictWord, type LedgerView, type Stint, type TaskEvent } from '../core/ledger';
import { archivedTaskTitles, handoffFilled, readHandoff, readReview, readTask, taskComplete, taskProgress, type TaskDoc, type TaskItem } from '../core/notes';
import { whoName } from '../core/names';
import { protocolState } from '../core/protocol';
import { untilText } from '../core/quota';
import { goLogTail, loadGoState, type GoState } from './go';
import { projectConfigSafe, relayBusy } from './track';

/**
 * 给网页和命令行看的「这个项目现在怎么样」。只读，不改任何东西。
 */

export interface StintView {
  id: number;
  title: string;
  kind: Stint['kind'];
  who: Stint['who'];
  tierWord: string;
  via: Stint['via'];
  status: Stint['status'];
  statusWord: string;
  startedAt: string;
  endedAt?: string;
  summary: string;
  facts?: Stint['facts'];
  factsError?: string;
  gate?: Stint['gate'];
  protectedHits?: string[];
  review: Stint['review'];
  /** 给人看的复核情况：「待复核」「复核：没问题（Codex）」「不用复核」。 */
  reviewText: string;
  /** 复核结论要人注意（有问题、证据不足、没写清楚）。 */
  reviewWarn?: boolean;
  reviews: { by: number; byLabel: string; file: string; verdict: string; verdictWord: string; weak?: boolean; void?: boolean }[];
  /** 终审棒：结论。 */
  verdict?: string;
  verdictWord?: string;
  reviewFile?: string;
  stopConfirmed?: boolean;
  handoff?: string;
  ghost?: boolean;
  note?: string;
  rolledBack?: boolean;
  targets?: number[];
  log?: string;
  quotaUntil?: string;
}

/** 一段对话 = 一个任务：从写下它（或接入）开始，到换下一个任务为止。 */
export interface ThreadView {
  id: string;
  title: string;
  from: string;
  /** 下一个任务开始的时间；最新的这个没有。 */
  to: string | null;
  /** 这段时间里开始的棒。 */
  stints: number[];
  pending: number;
  current: boolean;
}

export interface ProjectView {
  root: string;
  name: string;
  init: boolean;
  protocol: 'ok' | 'old' | 'missing';
  task: { title: string; body: string; items: TaskItem[]; rules: string; empty: boolean; done: number; total: number; complete: boolean };
  /** 现在：空闲 / 有人在自己的工具里做 / 接力台在调度 / 在等额度。 */
  now: { kind: 'idle' | 'native' | 'relay' | 'waiting'; text: string; stint?: number; since?: string };
  go: (GoState & { logTail: string }) | null;
  pending: StintView[];
  stints: StintView[];
  lastRollback: { ts: string; label: string; dropped: number[]; undone: boolean; task?: { unchecked: string[]; missing?: boolean } } | null;
  /** error = 配置文件坏了（这时检查和不许改的文件都没法核对）。 */
  config: { gate: string; protectedPaths: string[]; error?: string };
  /** 验收：能不能算做完了（网页顶部、命令行都看它）。 */
  acceptance: Acceptance;
  /** 按任务分的对话（旧的在前）。 */
  threads: ThreadView[];
}

/**
 * 一句话摘要：从交接文件现挑（挑法改进过，旧记录也跟着换）；接力台代写的、读不到的、没写内容的，用账本里记下的。
 * 按文件和修改时间缓存：网页每隔几秒刷一次，不用每次都读交接文件。
 */
const summaryCache = new Map<string, { mtimeMs: number; summary: string }>();
function liveSummary(root: string, s: Stint): string {
  const kept = s.summary ?? '';
  if (!s.handoff || s.ghost) return kept;
  const file = path.join(root, s.handoff);
  try {
    const mtimeMs = fs.statSync(file).mtimeMs;
    let hit = summaryCache.get(file);
    if (!hit || hit.mtimeMs !== mtimeMs) {
      const h = readHandoff(root, s.handoff);
      hit = { mtimeMs, summary: h && handoffFilled(h) ? h.summary : '' };
      summaryCache.set(file, hit);
    }
    return hit.summary || kept;
  } catch {
    return kept;
  }
}

function toView(s: Stint, rolledBack: ReadonlySet<number>, summary = s.summary ?? ''): StintView {
  const counted = countedReviews(s, rolledBack).at(-1);
  const warn = s.review === 'needed' && s.status !== 'working' && !s.rolledBack && (!!counted || !!s.factsError);
  const reviewText = s.rolledBack
    ? '已退回（作废）'
    : s.review === 'needed'
      ? s.status === 'working'
        ? '进行中'
        : `待复核${pendingWhy(s, rolledBack) ? ` · ${pendingWhy(s, rolledBack)}` : ''}`
      : s.review === 'done' && counted
        ? `复核：${verdictWord(counted.verdict)}（${counted.byLabel}）`
        : s.kind === 'final'
          ? s.verdict
            ? `终审：${verdictWord(s.verdict)}`
            : ''
          : s.kind === 'work'
            ? s.factsError
              ? '读不到改动'
              : s.facts?.files
                ? '强模型交接，不用复核'
                : '没改文件'
            : '';
  return {
    id: s.id,
    title: stintTitle(s),
    kind: s.kind,
    who: s.who,
    tierWord: tierWord(s.who.tier),
    via: s.via,
    status: s.status,
    statusWord: statusWord(s.status),
    startedAt: s.startedAt,
    ...(s.endedAt ? { endedAt: s.endedAt } : {}),
    summary,
    ...(s.facts ? { facts: s.facts } : {}),
    ...(s.factsError ? { factsError: s.factsError } : {}),
    ...(s.gate ? { gate: s.gate } : {}),
    ...(s.protectedHits?.length ? { protectedHits: s.protectedHits } : {}),
    review: s.review,
    reviewText,
    ...(warn ? { reviewWarn: true } : {}),
    reviews: (s.reviews ?? []).map((r) => ({ ...r, verdictWord: verdictWord(r.verdict), ...(r.by && rolledBack.has(r.by) ? { void: true } : {}) })),
    ...(s.verdict ? { verdict: s.verdict, verdictWord: verdictWord(s.verdict) } : {}),
    ...(s.reviewFile ? { reviewFile: s.reviewFile } : {}),
    ...(s.stopConfirmed ? { stopConfirmed: true } : {}),
    ...(s.handoff ? { handoff: s.handoff } : {}),
    ...(s.ghost ? { ghost: true } : {}),
    ...(s.note ? { note: s.note } : {}),
    ...(s.rolledBack ? { rolledBack: true } : {}),
    ...(s.targets ? { targets: s.targets } : {}),
    ...(s.log ? { log: s.log } : {}),
    ...(s.quotaUntil ? { quotaUntil: s.quotaUntil } : {}),
  };
}

/** 按「换任务」把账本切成一段一段；没标题、没棒的空段并进下一段。 */
export function threadsOf(root: string, v: LedgerView, task: TaskDoc): ThreadView[] {
  if (!v.init) return [];
  const changes = v.events.filter((e): e is TaskEvent => e.type === 'task');
  const last = changes.length;
  // 第一段的标题：换任务时记下的旧任务；旧版账本没记，就从存档里对（存档按换任务的先后追加，从后往前对齐；
  // 存档比换任务的次数少，说明第一段是空任务，换的时候没存档）。
  let first = task.title;
  if (last) {
    first = changes[0].prev ?? '';
    if (changes[0].prev === undefined) {
      const archived = archivedTaskTitles(root);
      if (archived.length >= last) first = archived[archived.length - last];
    }
  }
  // 之后每一段：被换掉时记下的标题（中途改过标题的，以最后的为准）；最新一段用任务文件里现在的。
  const spans = [
    { from: v.init.ts, title: first },
    ...changes.map((e, i) => ({ from: e.ts, title: i === last - 1 ? task.title || e.title : changes[i + 1].prev || e.title })),
  ];
  const out: ThreadView[] = [];
  let carry: string | null = null;
  spans.forEach((sp, i) => {
    const from = carry ?? sp.from;
    const to = spans[i + 1]?.from ?? null;
    const lo = i === 0 ? -Infinity : Date.parse(sp.from);
    const hi = to ? Date.parse(to) : Infinity;
    const mine = v.stints.filter((s) => {
      const at = Date.parse(s.startedAt);
      return at >= lo && at < hi;
    });
    const current = i === spans.length - 1;
    if (!sp.title && !mine.length && !current) {
      carry = from;
      return;
    }
    carry = null;
    out.push({
      id: `t${i}`,
      title: sp.title,
      from: out.length ? from : v.init!.ts,
      to,
      stints: mine.map((s) => s.id),
      pending: mine.filter((s) => s.review === 'needed' && s.status !== 'working' && !s.rolledBack).length,
      current,
    });
  });
  return out;
}

export function projectView(root: string): ProjectView {
  const v = loadLedger(root);
  const t = readTask(root);
  const p = taskProgress(t);
  const { cfg, error: configError } = projectConfigSafe(root);
  const go = loadGoState(root);
  const busy = relayBusy(v);
  let now: ProjectView['now'] = { kind: 'idle', text: '空闲：在任何 AI 工具里打开这个文件夹说「接着做」，或者在这里派人。' };
  if (go && go.status === 'waiting') {
    now = { kind: 'waiting', text: go.phase };
  } else if (busy) {
    now = { kind: 'relay', text: `${whoName(busy.who)} 正在${busy.kind === 'review' ? '复核' : busy.kind === 'final' ? '终审' : '干活'}（第 ${busy.id} 棒，接力台调度）`, stint: busy.id, since: busy.startedAt };
  } else if (v.open) {
    now = { kind: 'native', text: `第 ${v.open.id} 棒进行中：${v.open.who.label === '不知道是谁' ? '有 AI 在改文件（还没写交接，不知道是谁）' : `${whoName(v.open.who)} 在做`}`, stint: v.open.id, since: v.open.startedAt };
  }
  const dropped = new Set(v.stints.filter((x) => x.rolledBack).map((x) => x.id));
  const views = v.stints.map((x) => toView(x, dropped, liveSummary(root, x)));
  const lr = v.lastRollback;
  let finalRequired = true;
  try {
    finalRequired = loadAutoSettings().finalReview;
  } catch {
    /* 全自动的设置坏了：按要终审算 */
  }
  const undone = !!lr && v.events.some((e) => e.type === 'rollback' && e.restored?.length && new Date(e.ts).getTime() > new Date(lr.ts).getTime());
  return {
    root,
    name: path.basename(root),
    init: !!v.init,
    protocol: v.init ? protocolState(root) : 'missing',
    task: { title: t.title, body: t.body, items: t.items, rules: t.rules, empty: t.empty, done: p.done, total: p.total, complete: taskComplete(t) },
    now,
    go: go ? { ...go, logTail: goLogTail(root, go) } : null,
    pending: views.filter((s) => s.review === 'needed' && s.status !== 'working' && !s.rolledBack),
    stints: [...views].reverse(),
    lastRollback: lr && !lr.restored ? { ts: lr.ts, label: lr.label, dropped: lr.dropped, undone, ...(lr.task ? { task: { unchecked: lr.task.unchecked, ...(lr.task.missing ? { missing: true } : {}) } } : {}) } : null,
    config: { gate: cfg.gate.command, protectedPaths: cfg.protectedPaths, ...(configError ? { error: configError } : {}) },
    acceptance: acceptance({ ledger: v, task: t, gateCommand: cfg.gate.command.trim(), ...(configError ? { configError } : {}), finalRequired }),
    threads: threadsOf(root, v, t),
  };
}

/** 一棒的详情：交接全文、复核全文。 */
export function stintDetail(root: string, id: number): { stint: StintView; handoff: string | null; reviews: { file: string; text: string; by: string; weak?: boolean }[] } | null {
  const v = loadLedger(root);
  const s = v.stints.find((x) => x.id === id);
  if (!s) return null;
  const h = s.handoff ? readHandoff(root, s.handoff) : null;
  const dropped = new Set(v.stints.filter((x) => x.rolledBack).map((x) => x.id));
  const reviews = (s.reviews ?? []).map((r) => ({ file: r.file, text: readReview(root, r.file)?.raw ?? '', by: r.byLabel, ...(r.weak ? { weak: true } : {}) }));
  // 终审：它写的结论也给出来。
  if (s.kind === 'final' && s.reviewFile) {
    const r = readReview(root, s.reviewFile);
    if (r) reviews.push({ file: s.reviewFile, text: r.raw, by: s.who.label });
  }
  return { stint: toView(s, dropped, liveSummary(root, s)), handoff: h?.raw ?? null, reviews };
}

/** 调度日志（相对项目根目录的 .relay/runs/…）。 */
export function readRunLog(root: string, rel: string, maxBytes = 200_000): string {
  if (!/^\.relay\/runs\/[^/]+\.log$/.test(rel)) return '';
  try {
    const buf = fs.readFileSync(path.join(root, rel));
    return buf.subarray(Math.max(0, buf.length - maxBytes)).toString('utf8');
  } catch {
    return '';
  }
}

/** 一句话的现在（命令行 relay status 用）。 */
export function statusLines(root: string): string[] {
  const pv = projectView(root);
  if (!pv.init) return ['这个文件夹还没接入接力台。执行 relay init，或者在网页里点「接入」。'];
  const out: string[] = [];
  out.push(`任务：${pv.task.empty ? '（还没写）' : pv.task.title}${pv.task.total ? `（${pv.task.done}/${pv.task.total}${pv.task.complete ? '，全部打勾' : ''}）` : ''}`);
  out.push(/^(验收|没法验收)/.test(pv.acceptance.headline) ? pv.acceptance.headline : `验收：${pv.acceptance.headline}`);
  if (pv.config.error) out.push(`配置文件坏了：${pv.config.error}`);
  out.push(`现在：${pv.now.text}`);
  if (pv.go?.waitingUntil) out.push(`等额度：${untilText(pv.go.waitingUntil)}`);
  if (pv.pending.length) out.push(`待复核：${pv.pending.map((s) => `第 ${s.id} 棒（${whoName(s.who)}）`).join('、')}`);
  for (const s of pv.stints.slice(0, 8)) {
    out.push(`  ${s.title}（${s.tierWord}）· ${s.statusWord}${s.reviewText ? ` · ${s.reviewText}` : ''}${s.summary ? ` · ${s.summary}` : ''}`);
  }
  if (pv.protocol !== 'ok') out.push(pv.protocol === 'old' ? '提示：AGENTS.md / CLAUDE.md 里的接力规矩是旧版的，relay init 可以更新。' : '提示：AGENTS.md / CLAUDE.md 里没有接力规矩了，relay init 可以补上。');
  return out;
}
