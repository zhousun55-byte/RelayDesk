import fs from 'node:fs';
import path from 'node:path';
import type { AuditEvent, GateEvent, JournalEvent, Tier } from './types';

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
      throw new Error(
        `${p} 第 ${i + 1} 行不是合法 JSON（${why}）。` +
          `不要手工改 journal。收尾可用 relay abandon --force。`
      );
    }
  }
  return out;
}

/**
 * 审计/门禁/段内 diffstat 的基准（「新工作从哪开始」）：最近一次回滚后的落点、
 * 或最近一次 handoff 检查点；没有过 handoff 则退回 start 事件记录的主线基准。
 */
export function lastCheckpoint(events: JournalEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'rollback') return ev.to;
    if (ev.type === 'handoff') return ev.checkpoint;
    if (ev.type === 'start') return ev.commit ?? null;
  }
  return null;
}

/**
 * 自审基准（「上一段的起点」）：ONBOARD 里的 git diff <基准>..HEAD 必须能看到
 * 前任的业务改动——所以它不是最近的检查点，而是最近 handoff 之前那个检查点。
 * 最近结构事件是 rollback 时用其落点；从未 handoff 时用 start 记录的主线基准。
 */
export function reviewBaseFor(events: JournalEvent[]): string | null {
  let i = events.length - 1;
  for (; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'rollback') return ev.to;
    if (ev.type === 'start') return ev.commit ?? null;
    if (ev.type === 'handoff') {
      i--; // 越过最近的 handoff，继续找上一段的起点
      break;
    }
  }
  for (; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'rollback') return ev.to;
    if (ev.type === 'handoff') return ev.checkpoint;
    if (ev.type === 'start') return ev.commit ?? null;
  }
  return null;
}

/** 上一位干活的 agent（自审强制条款的判断依据）。run 与 open 都是上岗，取最近者。 */
export function lastRun(
  events: JournalEvent[]
): { agent: string; tier: Tier | undefined; llm?: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'run' || ev.type === 'open') {
      return { agent: ev.agent ?? '?', tier: ev.tier, ...(ev.llm ? { llm: ev.llm } : {}) };
    }
  }
  return null;
}

/**
 * 本段谁在干活（handoff / 审计 / 门禁归因）：只看最近一次 handoff 或 rollback 之后的 run/open。
 * 连续两次 handoff 中间没人上岗 → 归到 framework，不把上一段的人再记一次。
 * ONBOARD 的「前任」仍用 lastRun（整本 journal 最近一次上岗）。
 */
export function lastSegmentRun(
  events: JournalEvent[]
): { agent: string; tier: Tier | undefined; llm?: string } | null {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'handoff' || ev.type === 'rollback') {
      start = i + 1;
      break;
    }
  }
  for (let i = events.length - 1; i >= start; i--) {
    const ev = events[i];
    if (ev.type === 'run' || ev.type === 'open') {
      return { agent: ev.agent ?? '?', tier: ev.tier, ...(ev.llm ? { llm: ev.llm } : {}) };
    }
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

/** rollback 可选目标：relay 首提交（优先取会话指针里的 startCommit，start 事件里存的是主线基准）
 *  + 每个 handoff 检查点。 */
export function checkpoints(
  events: JournalEvent[],
  startCommit?: string
): { sha: string; agent: string; ts: string }[] {
  const list: { sha: string; agent: string; ts: string }[] = [];
  let startSeen = false;
  for (const ev of events) {
    if (ev.type === 'start') {
      const sha = startCommit ?? ev.commit;
      if (sha) {
        list.push({ sha, agent: '(start)', ts: ev.ts });
        startSeen = true;
      }
    } else if (ev.type === 'handoff') {
      list.push({ sha: ev.checkpoint, agent: ev.agent ?? '?', ts: ev.ts });
    }
  }
  if (!startSeen && startCommit) {
    list.unshift({ sha: startCommit, agent: '(start)', ts: '?' });
  }
  return list;
}
