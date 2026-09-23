import fs from 'node:fs';
import { loadRelayConfig } from '../core/config';
import { RelayError } from '../core/errors';
import { requireRepoRoot } from '../core/git';
import { lastCheckpoint, readEvents } from '../core/journal';
import { requireSession, type SessionState } from '../core/session';
import { businessEntries, diffFiles, type FileChange, type StatusEntry } from '../core/status';
import type { JournalEvent, RelayConfig } from '../core/types';

export interface TaskContext {
  root: string;
  session: SessionState;
  wt: string;
  cfg: RelayConfig;
  events: JournalEvent[];
}

/** 进行中任务的全部上下文。工作副本不见了就报错（只能放弃）。 */
export function openTask(dir: string): TaskContext {
  const root = requireRepoRoot(dir);
  const cfg = loadRelayConfig(root);
  const session = requireSession(root);
  const wt = session.worktree;
  if (!fs.existsSync(wt)) {
    throw new RelayError(`这个任务的隔离副本不见了（${wt}）。只能放弃这个任务（接力分支还在，东西不会丢）。`, 'no-worktree');
  }
  return { root, session, wt, cfg, events: readEvents(wt) };
}

export interface Pending {
  /** 这一段的起点（上次交接的检查点等）。 */
  anchor: string;
  /** 还没提交的业务改动。 */
  uncommitted: StatusEntry[];
  /** 工人自己提交了、但还没交接的业务改动。 */
  committed: FileChange[];
  /** 涉及的文件（去重）。 */
  files: string[];
}

/** 上次交接之后还没交接的业务改动（工人可能自己 commit 过，所以两边都要看）。 */
export function pendingChanges(wt: string, events: JournalEvent[], baseCommit: string): Pending {
  const anchor = lastCheckpoint(events) ?? baseCommit;
  const uncommitted = businessEntries(wt);
  const committed = diffFiles(wt, anchor, 'HEAD');
  const files = [...new Set([...committed.map((f) => f.path), ...uncommitted.map((e) => e.path)])];
  return { anchor, uncommitted, committed, files };
}
