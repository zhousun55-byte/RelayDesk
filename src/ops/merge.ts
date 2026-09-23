import fs from 'node:fs';
import path from 'node:path';
import { relayConfigPath } from '../core/config';
import { RelayError } from '../core/errors';
import { commitAll, currentBranch, git, gitOk, headSha, mergeBase, mergeInProgress, relayCommit, shortSha } from '../core/git';
import { buildMergeMessage } from '../core/handoff-doc';
import { appendEvent, lastGate, lastHandoff } from '../core/journal';
import { clearStaleLock, describeLock, lockActive, lockKind, readLock, releaseLock } from '../core/lock';
import { ensureRelayGitignore } from '../core/project';
import { matchProtected } from '../core/protected';
import { clearSession } from '../core/session';
import { businessEntries, diffFiles, isRelayPath, statusEntries } from '../core/status';
import { openTask, pendingChanges } from './context';

export interface MergeOptions {
  /** 跳过「检查没过 / 改了保护文件 / 还有没交接的改动 / 桌面工人没交接」这些拦截。 */
  force?: boolean;
  /** 把审计报告也留进正式文件夹（默认不留，只在接力分支里）。 */
  keepAudits?: boolean;
}

export interface MergeResult {
  /** 正式文件夹里的新提交；没有业务改动时为 null。 */
  commit: string | null;
  branch: string;
  files: string[];
  notes: string[];
}

/**
 * 合回：把接力分支压成一个提交放进正式文件夹。接力台自己的文件（交接记录、审计……）不进去，
 * 接力分支保留备查，隔离副本删除。正式文件夹后来有了新提交也能合（三方合并）；冲突就原样撤回，提示先同步。
 */
export function merge(dir: string, opts: MergeOptions = {}): MergeResult {
  const ctx = openTask(dir);
  const { wt, root, session, events, cfg } = ctx;
  const notes: string[] = [];
  const force = !!opts.force;

  clearStaleLock(wt);
  const lock = readLock(wt);
  if (lock && lockActive(lock)) {
    if (lockKind(lock) !== 'app') throw new RelayError(`${describeLock(lock)}，等它结束再合回。`, 'locked');
    if (!force) throw new RelayError(`${describeLock(lock)}。先交接（这样它的改动才会被存下来），再合回。`, 'locked-app');
    notes.push(`强行合回：${describeLock(lock)}，它没交接的改动不会带上。`);
  }
  if (mergeInProgress(wt)) throw new RelayError('同步主线的冲突还没解决。先让工人解决冲突并交接。', 'conflict');

  const pending = pendingChanges(wt, events, session.baseCommit);
  if (pending.files.length) {
    if (!force) throw new RelayError(`还有 ${pending.files.length} 个改动没交接（${pending.files.slice(0, 5).join('、')}）。先交接，再合回。`, 'pending');
    notes.push(`强行合回：${pending.files.length} 个没交接的改动不会带上。`);
  }

  const mainBranch = session.mainBranch ?? currentBranch(root);
  const branchNow = currentBranch(root);
  if (!mainBranch || branchNow !== mainBranch) {
    throw new RelayError(`正式文件夹现在在「${branchNow ?? '分离状态'}」，任务是从「${mainBranch ?? '?'}」开始的。先切回去再合回。`, 'wrong-branch');
  }

  // 合回的是「接力分支已提交的内容」：以最后一次交接后的 HEAD 为准。
  const tip = gitOk(wt, ['rev-parse', 'HEAD']);
  const mb = mergeBase(root, mainBranch, tip) ?? session.baseCommit;
  const changes = diffFiles(root, mb, tip);
  const files = changes.map((f) => f.path);

  if (!force) {
    if (files.length === 0) throw new RelayError('这个任务没有要合回的改动。不需要的话可以放弃它。', 'nothing');
    const gate = lastGate(events);
    if (!gate || !lastHandoff(events, { nonEmpty: true })) throw new RelayError('还没有交接过。先交接（会存检查点、跑检查），再合回。', 'no-handoff');
    if (gate.status === 'fail') throw new RelayError(`检查没通过（${gate.command}），不能合回。让工人修好再交接；确定要合，用强制合回。`, 'gate');
    const hits = matchProtected(files, cfg.protectedPaths);
    if (hits.length) throw new RelayError(`改到了不许改的文件：${hits.join('、')}。确定要合，用强制合回。`, 'protected');
  }

  const dirtyMain = businessEntries(root);
  if (dirtyMain.length) {
    throw new RelayError(
      `正式文件夹里有没提交的改动：${dirtyMain.slice(0, 8).map((e) => e.path).join('、')}${dirtyMain.length > 8 ? ' …' : ''}。` +
        '先处理掉（提交、撤销，或者如果是 AI 开错了文件夹，用「收进任务」），再合回。',
      'main-dirty'
    );
  }
  const mainHead = headSha(root);
  if (mainHead && mainHead !== session.baseCommit) notes.push('正式文件夹在任务期间有了新提交，已经一起合并。');

  const sq = git(root, ['merge', '--squash', '--no-commit', tip]);
  if (sq.code !== 0) {
    const conflicts = git(root, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
    git(root, ['reset', '--merge']);
    if (conflicts.length) {
      throw new RelayError(
        `正式文件夹后来的改动和这个任务冲突：${conflicts.join('、')}。先「同步主线」，让工人在隔离副本里解决冲突、交接，再合回。`,
        'merge-conflict'
      );
    }
    throw new RelayError(`合回失败：${sq.stderr || sq.stdout}`, 'git');
  }

  // 接力台自己的文件不进正式文件夹（配置除外，而且配置只认正式文件夹里的那份）。
  const keepAudit = (p: string) => !!opts.keepAudits && p.startsWith('.relay/audits/');
  const staged = git(root, ['diff', '--cached', '--name-status', '-z', '--no-renames'], { raw: true }).stdout.split('\0');
  for (let i = 0; i + 1 < staged.length; i += 2) {
    const status = staged[i];
    const p = staged[i + 1];
    if (!p || !isRelayPath(p) || keepAudit(p)) continue;
    if (status === 'A') {
      git(root, ['rm', '--cached', '-q', '--', p]);
      fs.rmSync(path.join(root, p), { force: true });
    } else {
      git(root, ['checkout', 'HEAD', '--', p]);
    }
  }
  // 旧版留下的问题：正式文件夹里的配置从没提交过。借这次一起补上。
  const cfgRel = path.relative(root, relayConfigPath(root));
  if (fs.existsSync(relayConfigPath(root))) {
    const cfgDirty = statusEntries(root).some((e) => e.path === cfgRel);
    if (cfgDirty) {
      git(root, ['add', '--', cfgRel]);
      notes.push('接力配置之前没提交过，这次一起提交了。');
    }
  }
  if (ensureRelayGitignore(root)) git(root, ['add', '--', '.gitignore']);

  const hasStaged = git(root, ['diff', '--cached', '--quiet']).code !== 0;
  let commit: string | null = null;
  if (hasStaged) {
    const msg = buildMergeMessage({ taskTitle: session.taskTitle, branch: session.branch, baseCommit: session.baseCommit, events });
    const c = relayCommit(root, msg);
    if (c.code !== 0) {
      git(root, ['reset', '--merge']);
      throw new RelayError(`合回的提交没能生成：${c.stderr || c.stdout}`, 'git');
    }
    commit = headSha(root);
  } else {
    notes.push('没有业务改动，正式文件夹没有新提交。');
  }

  appendEvent(wt, { ts: new Date().toISOString(), type: 'merge', ...(commit ? { commit } : {}), squashCommit: commit ?? '(无改动)', worktree: wt });
  commitAll(wt, `接力：合回完成 ${commit ? shortSha(commit) : '（没有提交）'}`);
  releaseLock(wt);
  removeWorktree(root, wt);
  clearSession(root);
  return { commit, branch: session.branch, files, notes };
}

/** 删掉隔离副本（分支保留）。 */
export function removeWorktree(root: string, wt: string): void {
  let rm = git(root, ['worktree', 'remove', '--force', wt]);
  if (rm.code !== 0) rm = git(root, ['worktree', 'remove', '--force', '--force', wt]);
  if (rm.code !== 0 && fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true });
  git(root, ['worktree', 'prune']);
}
