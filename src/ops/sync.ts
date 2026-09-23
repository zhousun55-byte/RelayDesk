import { RelayError } from '../core/errors';
import { RELAY_IDENTITY, commitAll, currentBranch, git, gitOk, mergeInProgress, shortSha } from '../core/git';
import { appendEvent } from '../core/journal';
import { assertFree } from '../core/lock';
import { unmergedFiles } from '../core/status';
import { openTask, pendingChanges } from './context';

export interface SyncResult {
  status: 'up-to-date' | 'merged' | 'conflict';
  main: string;
  conflicts: string[];
}

/** 正式文件夹上比任务新的提交数（只算业务文件）。 */
export function mainAhead(wt: string, mainRef: string): number {
  const r = git(wt, ['rev-list', '--count', `HEAD..${mainRef}`, '--', '.', ':(exclude).relay']);
  return r.code === 0 ? Number(r.stdout) || 0 : 0;
}

/**
 * 同步主线：把正式文件夹后来的提交合并进任务。没冲突就直接合好；
 * 有冲突就把冲突留在隔离副本里，交给下一位工人解决（上岗说明会写清楚），解决后交接即可。
 */
export function syncMain(dir: string): SyncResult {
  const ctx = openTask(dir);
  const { wt, root, session, events } = ctx;
  assertFree(wt, '同步主线');
  if (mergeInProgress(wt)) throw new RelayError('上一次同步的冲突还没解决。解决后交接，或者撤销同步。', 'conflict');
  const pending = pendingChanges(wt, events, session.baseCommit);
  if (pending.files.length) throw new RelayError(`还有 ${pending.files.length} 个改动没交接。先交接，再同步。`, 'pending');

  const mainRef = session.mainBranch ?? currentBranch(root);
  if (!mainRef) throw new RelayError('不知道正式文件夹用的是哪个分支。', 'no-main');
  const main = gitOk(wt, ['rev-parse', mainRef]);
  if (git(wt, ['merge-base', '--is-ancestor', main, 'HEAD']).code === 0) {
    return { status: 'up-to-date', main, conflicts: [] };
  }
  const r = git(wt, [...RELAY_IDENTITY, 'merge', '--no-ff', '--no-verify', '--no-edit', '-m', `接力：同步主线 ${shortSha(main)}`, main]);
  if (r.code === 0) {
    const commit = gitOk(wt, ['rev-parse', 'HEAD']);
    appendEvent(wt, { ts: new Date().toISOString(), type: 'sync', main, commit, worktree: wt });
    commitAll(wt, '接力：记下同步');
    return { status: 'merged', main, conflicts: [] };
  }
  const conflicts = unmergedFiles(wt);
  if (conflicts.length === 0) {
    git(wt, ['merge', '--abort']);
    throw new RelayError(`同步失败：${r.stderr || r.stdout}`, 'git');
  }
  appendEvent(wt, { ts: new Date().toISOString(), type: 'sync', main, conflicts, worktree: wt });
  return { status: 'conflict', main, conflicts };
}

/** 撤销还没解决完的同步：隔离副本回到同步之前。 */
export function abortSync(dir: string): void {
  const ctx = openTask(dir);
  const { wt, events } = ctx;
  assertFree(wt, '撤销同步');
  if (!mergeInProgress(wt)) throw new RelayError('现在没有进行中的同步。', 'no-sync');
  const r = git(wt, ['merge', '--abort']);
  if (r.code !== 0) throw new RelayError(`撤销失败：${r.stderr || r.stdout}`, 'git');
  const last = [...events].reverse().find((e) => e.type === 'sync');
  appendEvent(wt, { ts: new Date().toISOString(), type: 'sync', main: last?.type === 'sync' ? last.main : '', aborted: true, worktree: wt });
  commitAll(wt, '接力：撤销同步');
}
