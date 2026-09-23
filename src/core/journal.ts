import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from './errors';
import type { AuditEvent, AutoEvent, GateEvent, HandoffEvent, JournalEvent, ReviewEvent, Tier } from './types';

export function journalPath(worktree: string): string {
  return path.join(worktree, '.relay', 'journal.jsonl');
}

/** 只追加，不改写历史。 */
export function appendEvent(worktree: string, ev: JournalEvent): void {
  fs.mkdirSync(path.dirname(journalPath(worktree)), { recursive: true });
  fs.appendFileSync(journalPath(worktree), JSON.stringify(ev) + '\n');
}

export function readEvents(worktree: string): JournalEvent[] {
  const p = journalPath(worktree);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const out: JournalEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as JournalEvent);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new RelayError(
        `交接记录 ${p} 第 ${i + 1} 行坏了（${why}）。不要手改这个文件；要收场可以强制放弃任务（relay abandon --force）。`,
        'bad-journal'
      );
    }
  }
  return out;
}

/**
 * 结构事件的落点（「从这里开始算新改动」）。不是结构事件返回 undefined。
 * 同步主线有冲突或被撤销时不算落点：冲突要等下一次交接收尾。
 */
function anchorOf(ev: JournalEvent): string | null | undefined {
  switch (ev.type) {
    case 'start':
      return ev.commit ?? null;
    case 'handoff':
      return ev.checkpoint;
    case 'rollback':
      return ev.to;
    case 'sync':
      return !ev.aborted && !ev.conflicts?.length && ev.commit ? ev.commit : undefined;
    default:
      return undefined;
  }
}

/** 这一段的起点（审计、未交接改动、门禁都从这里算）：最近的交接检查点 / 退回落点 / 同步点 / 开始基准。 */
export function lastCheckpoint(events: JournalEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const a = anchorOf(events[i]);
    if (a !== undefined) return a;
  }
  return null;
}

export interface ReviewTarget {
  /** 上一位干了活的工人（最近一次有改动的交接）。 */
  agent: string;
  tier?: Tier;
  llm?: string;
  /** 他那一段的起点和检查点：git diff from..to 就是他的全部改动。 */
  from: string;
  to: string;
}

/**
 * 下一位上岗时要审的「上一段」：最近一次**有改动**的交接。空交接（没干活就交班）透明跳过，
 * 这样「弱模型干了活 → 强模型什么都没做就交班 → 第三位上岗」时，第三位审的仍是弱模型那段。
 * 中间有退回：之前的活已经被丢掉，没东西可审。
 */
export function lastReviewTarget(events: JournalEvent[]): ReviewTarget | null {
  let i = events.length - 1;
  let hand: HandoffEvent | null = null;
  for (; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'rollback' || ev.type === 'start') return null;
    if (ev.type === 'handoff' && !ev.empty) {
      hand = ev;
      i--;
      break;
    }
  }
  if (!hand) return null;
  for (; i >= 0; i--) {
    const a = anchorOf(events[i]);
    if (a === undefined) continue;
    if (!a) return null;
    return {
      agent: hand.agent ?? '?',
      ...(hand.tier ? { tier: hand.tier } : {}),
      ...(hand.llm ? { llm: hand.llm } : {}),
      from: a,
      to: hand.checkpoint,
    };
  }
  return null;
}

export interface ShiftInfo {
  agent: string;
  tier?: Tier;
  llm?: string;
  type: 'run' | 'open';
  ts: string;
}

/** 这一段（最近一次交接 / 退回 / 同步之后）上岗的工人；没人上岗返回 null。 */
export function lastSegmentRun(events: JournalEvent[]): ShiftInfo | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (anchorOf(ev) !== undefined && ev.type !== 'start') return null;
    if (ev.type === 'run' || ev.type === 'open') {
      return {
        agent: ev.agent ?? '?',
        ...(ev.tier ? { tier: ev.tier } : {}),
        ...(ev.llm ? { llm: ev.llm } : {}),
        type: ev.type,
        ts: ev.ts,
      };
    }
  }
  return null;
}

export function lastHandoff(events: JournalEvent[], opts: { nonEmpty?: boolean } = {}): HandoffEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'handoff' && (!opts.nonEmpty || !ev.empty)) return ev;
  }
  return null;
}

export function lastGate(events: JournalEvent[]): GateEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'gate') return ev;
  }
  return null;
}

export function lastAudit(events: JournalEvent[]): AuditEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'audit') return ev;
  }
  return null;
}

/** 还没收尾的同步冲突（同步主线后有冲突，之后还没交接过）。 */
export function pendingSyncConflicts(events: JournalEvent[]): string[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'handoff' || ev.type === 'rollback') return [];
    if (ev.type === 'sync') return ev.aborted ? [] : ev.conflicts ?? [];
  }
  return [];
}

export interface CheckpointInfo {
  sha: string;
  agent: string;
  ts: string;
  label: string;
}

/** 可以退回的点：任务开始时 + 每次有改动的交接。 */
export function checkpoints(events: JournalEvent[], startCommit?: string): CheckpointInfo[] {
  const list: CheckpointInfo[] = [];
  const seen = new Set<string>();
  const push = (c: CheckpointInfo) => {
    if (seen.has(c.sha)) return;
    seen.add(c.sha);
    list.push(c);
  };
  for (const ev of events) {
    if (ev.type === 'start') {
      const sha = startCommit ?? ev.commit;
      if (sha) push({ sha, agent: '(开始)', ts: ev.ts, label: '任务开始时' });
    } else if (ev.type === 'handoff' && !ev.empty) {
      push({ sha: ev.checkpoint, agent: ev.agent ?? '?', ts: ev.ts, label: '交接' });
    }
  }
  if (startCommit && !seen.has(startCommit)) list.unshift({ sha: startCommit, agent: '(开始)', ts: '', label: '任务开始时' });
  return list;
}

/** 最近一次审查。 */
export function lastReview(events: JournalEvent[]): ReviewEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'review') return ev;
  }
  return null;
}

/** 最近一次「要求修改」的审查。 */
export function lastFixReview(events: JournalEvent[]): ReviewEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'review' && ev.verdict === 'fix') return ev;
  }
  return null;
}

/** 某次全自动开始之后的审查（算轮数用）。 */
export function reviewsSinceAuto(events: JournalEvent[], runId: string): ReviewEvent[] {
  let i = events.length - 1;
  for (; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'auto' && (ev as AutoEvent).phase === 'begin' && (ev as AutoEvent).runId === runId) break;
  }
  return events.slice(Math.max(0, i)).filter((e): e is ReviewEvent => e.type === 'review');
}
