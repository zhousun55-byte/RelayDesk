import fs from 'node:fs';
import path from 'node:path';
import { loadLedger, statusWord, stintTitle, tierWord, verdictWord, type Stint } from '../core/ledger';
import { readHandoff, readReview, readTask, taskComplete, taskProgress, type TaskItem } from '../core/notes';
import { protocolState } from '../core/protocol';
import { untilText } from '../core/quota';
import { goLogTail, loadGoState, type GoState } from './go';
import { projectConfig, relayBusy } from './track';

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
  gate?: Stint['gate'];
  protectedHits?: string[];
  review: Stint['review'];
  /** 给人看的复核情况：「待复核」「复核：没问题（Codex）」「不用复核」。 */
  reviewText: string;
  reviews: { by: number; byLabel: string; file: string; verdict: string; verdictWord: string }[];
  handoff?: string;
  ghost?: boolean;
  note?: string;
  rolledBack?: boolean;
  targets?: number[];
  log?: string;
  quotaUntil?: string;
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
  lastRollback: { ts: string; label: string; dropped: number[]; undone: boolean } | null;
  config: { gate: string; protectedPaths: string[] };
}

function toView(s: Stint): StintView {
  const last = s.reviews?.at(-1);
  const reviewText = s.rolledBack
    ? '已退回（作废）'
    : s.review === 'needed'
      ? s.status === 'working'
        ? '进行中'
        : '待复核'
      : s.review === 'done' && last
        ? `复核：${verdictWord(last.verdict)}（${last.byLabel}）`
        : s.kind === 'work'
          ? s.facts?.files
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
    summary: s.summary ?? '',
    ...(s.facts ? { facts: s.facts } : {}),
    ...(s.gate ? { gate: s.gate } : {}),
    ...(s.protectedHits?.length ? { protectedHits: s.protectedHits } : {}),
    review: s.review,
    reviewText,
    reviews: (s.reviews ?? []).map((r) => ({ ...r, verdictWord: verdictWord(r.verdict) })),
    ...(s.handoff ? { handoff: s.handoff } : {}),
    ...(s.ghost ? { ghost: true } : {}),
    ...(s.note ? { note: s.note } : {}),
    ...(s.rolledBack ? { rolledBack: true } : {}),
    ...(s.targets ? { targets: s.targets } : {}),
    ...(s.log ? { log: s.log } : {}),
    ...(s.quotaUntil ? { quotaUntil: s.quotaUntil } : {}),
  };
}

export function projectView(root: string): ProjectView {
  const v = loadLedger(root);
  const t = readTask(root);
  const p = taskProgress(t);
  const cfg = projectConfig(root);
  const go = loadGoState(root);
  const busy = relayBusy(v);
  let now: ProjectView['now'] = { kind: 'idle', text: '空闲：在任何 AI 工具里打开这个文件夹说「接着做」，或者在这里派人。' };
  if (go && go.status === 'waiting') {
    now = { kind: 'waiting', text: go.phase };
  } else if (busy) {
    now = { kind: 'relay', text: `${busy.who.label} 正在${busy.kind === 'review' ? '复核' : busy.kind === 'final' ? '终审' : '干活'}（第 ${busy.id} 棒，接力台调度）`, stint: busy.id, since: busy.startedAt };
  } else if (v.open) {
    now = { kind: 'native', text: `第 ${v.open.id} 棒进行中：${v.open.who.label === '不知道是谁' ? '有 AI 在改文件（还没写交接，不知道是谁）' : `${v.open.who.label} 在做`}`, stint: v.open.id, since: v.open.startedAt };
  }
  const views = v.stints.map(toView);
  const lr = v.lastRollback;
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
    lastRollback: lr && !lr.restored ? { ts: lr.ts, label: lr.label, dropped: lr.dropped, undone } : null,
    config: { gate: cfg.gate.command, protectedPaths: cfg.protectedPaths },
  };
}

/** 一棒的详情：交接全文、复核全文。 */
export function stintDetail(root: string, id: number): { stint: StintView; handoff: string | null; reviews: { file: string; text: string }[] } | null {
  const v = loadLedger(root);
  const s = v.stints.find((x) => x.id === id);
  if (!s) return null;
  const h = s.handoff ? readHandoff(root, s.handoff) : null;
  const reviews = (s.reviews ?? []).map((r) => ({ file: r.file, text: readReview(root, r.file)?.raw ?? '' }));
  return { stint: toView(s), handoff: h?.raw ?? null, reviews };
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
  out.push(`现在：${pv.now.text}`);
  if (pv.go?.waitingUntil) out.push(`等额度：${untilText(pv.go.waitingUntil)}`);
  if (pv.pending.length) out.push(`待复核：${pv.pending.map((s) => `第 ${s.id} 棒（${s.who.label}）`).join('、')}`);
  for (const s of pv.stints.slice(0, 8)) {
    out.push(`  ${s.title}（${s.tierWord}）· ${s.statusWord}${s.reviewText ? ` · ${s.reviewText}` : ''}${s.summary ? ` · ${s.summary}` : ''}`);
  }
  if (pv.protocol !== 'ok') out.push(pv.protocol === 'old' ? '提示：AGENTS.md / CLAUDE.md 里的接力规矩是旧版的，relay init 可以更新。' : '提示：AGENTS.md / CLAUDE.md 里没有接力规矩了，relay init 可以补上。');
  return out;
}
