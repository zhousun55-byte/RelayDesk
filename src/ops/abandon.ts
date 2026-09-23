import fs from 'node:fs';
import { RelayError, errorMessage } from '../core/errors';
import { commitAll, git, requireRepoRoot } from '../core/git';
import { appendEvent } from '../core/journal';
import { clearStaleLock, describeLock, lockActive, lockKind, readLock, releaseLock } from '../core/lock';
import { clearSession, requireSession } from '../core/session';
import { removeWorktree } from './merge';

export interface AbandonResult {
  branch: string;
  notes: string[];
}

/**
 * 放弃任务：把隔离副本里剩下的东西存进接力分支（留底），删掉隔离副本，清掉任务指针。
 * 正式文件夹不动。交接记录坏了也能放弃（--force）。
 */
export function abandon(dir: string, opts: { force?: boolean } = {}): AbandonResult {
  const root = requireRepoRoot(dir);
  const session = requireSession(root);
  const wt = session.worktree;
  const notes: string[] = [];

  if (fs.existsSync(wt)) {
    clearStaleLock(wt);
    const lock = readLock(wt);
    if (lock && lockActive(lock)) {
      if (lockKind(lock) !== 'app') throw new RelayError(`${describeLock(lock)}，等它结束再放弃。`, 'locked');
      if (!opts.force) {
        throw new RelayError(`${describeLock(lock)}。确定不要了，用强制放弃（它手上的改动会先存进接力分支留底）。`, 'locked-app');
      }
      notes.push(`强行放弃：${describeLock(lock)}。`);
    }
    try {
      appendEvent(wt, { ts: new Date().toISOString(), type: 'abandon', branch: session.branch, worktree: wt });
      const sha = commitAll(wt, 'relay: abandon');
      if (sha) notes.push('隔离副本里剩下的改动已存进接力分支留底。');
    } catch (e) {
      if (!opts.force) throw e;
      notes.push(`留底没存成（${errorMessage(e)}），照样放弃。`);
    }
    releaseLock(wt);
    removeWorktree(root, wt);
  } else {
    git(root, ['worktree', 'prune']);
    notes.push('隔离副本本来就不在了。');
  }
  clearSession(root);
  return { branch: session.branch, notes };
}
