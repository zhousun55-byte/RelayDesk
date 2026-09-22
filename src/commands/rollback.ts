import fs from 'node:fs';
import { Command } from 'commander';
import { commitAll, gitOk, repoRootAt } from '../core/git';
import { appendEvent, checkpoints, readEvents } from '../core/journal';
import { assertNoAppSoftLock, assertNoLiveLock } from '../core/lock';
import { requireSession } from '../core/session';

export function rollbackCommand(): Command {
  const cmd = new Command('rollback');
  cmd.description('回滚 worktree 到某个检查点（只动 worktree 分支，永不碰主线；reset --hard + clean -fd）');
  cmd.argument('[sha]', '检查点 SHA（缺省则列出可选检查点）');
  cmd.action((sha: string | undefined) => {
    const root = repoRootAt(process.cwd());
    const s = requireSession(root);
    const wt = s.worktree;
    if (!fs.existsSync(wt)) throw new Error(`worktree 不存在：${wt}`);
    // 单写者：agent 还在跑就不许回滚（与 handoff 同语义）
    assertNoLiveLock(wt, 'rollback');
    // App 软锁：App 可能还开着，reset 会毁掉它手上未交接的活——一律拒绝（无 --force）
    assertNoAppSoftLock(wt, '回滚');

    const events = readEvents(wt);
    const cps = checkpoints(events, s.startCommit);

    if (sha === undefined) {
      if (cps.length === 0) {
        console.log('尚无检查点。');
      } else {
        console.log('可选检查点（旧→新）：');
        for (const c of cps) console.log(`  ${c.sha.slice(0, 9)}  ${c.agent}  ${c.ts}`);
      }
      console.log('用法：relay rollback <sha>');
      return;
    }

    const target = cps.find((c) => c.sha === sha || c.sha.startsWith(sha));
    if (!target) {
      throw new Error(`${sha} 不是有效检查点。relay rollback 查看可选列表。`);
    }

    gitOk(wt, ['reset', '--hard', target.sha]);
    gitOk(wt, ['clean', '-fd']);
    appendEvent(wt, {
      ts: new Date().toISOString(),
      type: 'rollback',
      to: target.sha,
      worktree: wt,
    });
    commitAll(wt, `relay: rollback ${target.sha.slice(0, 9)}`);

    console.log(`已回滚到 ${target.sha.slice(0, 9)}（${target.agent}，${target.ts}）。`);
    console.log('worktree 已 reset --hard + clean -fd；主线未受影响。');
    console.log('继续：relay run <agent>；查看：relay status。');
  });
  return cmd;
}
