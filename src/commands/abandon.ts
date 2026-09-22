import fs from 'node:fs';
import { Command } from 'commander';
import { commitAll, git, repoRootAt } from '../core/git';
import { appendEvent } from '../core/journal';
import { assertNoLiveLock, isAppLock, readLock, releaseLock } from '../core/lock';
import { clearSession, requireSession } from '../core/session';

export function abandonCommand(): Command {
  const cmd = new Command('abandon');
  cmd.description('放弃当前任务：删 worktree、清会话指针、保留 relay/* 分支备查');
  cmd.option('-f, --force', 'App 软锁未交接 / journal 损坏时仍放弃（未交接的未提交改动可能丢失）');
  cmd.action((opts: { force?: boolean }) => {
    const root = repoRootAt(process.cwd());
    const s = requireSession(root);
    const wt = s.worktree;

    if (fs.existsSync(wt)) {
      assertNoLiveLock(wt, 'abandon');
      const lock = readLock(wt);
      if (lock && isAppLock(lock)) {
        if (!opts.force) {
          throw new Error(
            `「${lock.agent}」的 App 会话尚未交接（软锁，不看 pid）。` +
              `先执行 relay handoff 完成交接，或明确放弃：relay abandon --force（未交接的未提交改动可能丢失）。`
          );
        }
        console.warn(`⚠ --force：在「${lock.agent}」的 App 软锁下放弃——未交接的未提交改动可能丢失。`);
      }
      try {
        appendEvent(wt, {
          ts: new Date().toISOString(),
          type: 'abandon',
          branch: s.branch,
          worktree: wt,
        });
        commitAll(wt, 'relay: abandon');
      } catch (e) {
        if (!opts.force) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`⚠ journal/提交失败，仍继续清理：${msg}`);
      }
      try {
        releaseLock(wt);
      } catch {
        /* worktree 马上要删 */
      }
    }

    let rm = git(root, ['worktree', 'remove', '--force', wt]);
    if (rm.code !== 0 && fs.existsSync(wt)) {
      fs.rmSync(wt, { recursive: true, force: true });
      git(root, ['worktree', 'prune']);
    }
    clearSession(root);

    console.log('已放弃任务：');
    console.log(`  分支保留备查：${s.branch}（彻底删除：git branch -D ${s.branch}）`);
    console.log('现在可以 relay start 开始新任务。');
  });
  return cmd;
}
