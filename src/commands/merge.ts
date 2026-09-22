import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { RELAY_IDENTITY, commitAll, git, gitOk, repoRootAt } from '../core/git';
import { blockingMainStatus, SIDE_PATHS } from '../core/side';
import { loadRelayConfig } from '../core/config';
import { appendEvent, lastGate, readEvents } from '../core/journal';
import { assertNoLiveLock, isAppLock, readLock, releaseLock } from '../core/lock';
import { globToRegExp } from '../core/protected';
import { buildMergeMessage } from '../core/handoff';
import { clearSession, requireSession } from '../core/session';

/** 简易 glob 的正则构造见 core/protected.ts；merge 自身的 diff 语义不变。 */
export function mergeCommand(): Command {
  const cmd = new Command('merge');
  cmd.description('把接力分支 squash 进主线：剥离会话文件、提交信息由 journal 生成、分支保留备查');
  cmd.option('-f, --force', 'App 软锁未交接 / 门禁红 / 保护路径命中 / 主线已前进时仍强行合并（软锁下未交接的未提交改动可能丢失）');
  cmd.option('--keep-audits', '把 .relay/audits/ 一并保留进主线（默认剥离）');
  cmd.action((opts: { force?: boolean; keepAudits?: boolean }) => {
    const root = repoRootAt(process.cwd());
    const cfg = loadRelayConfig(root);
    const s = requireSession(root);
    const wt = s.worktree;
    if (!fs.existsSync(wt)) throw new Error(`worktree 不存在：${wt}`);
    // 单写者：agent 还在跑就不许收尾（与 handoff 同语义）
    assertNoLiveLock(wt, 'merge');
    // App 软锁：App 段未 handoff，改动可能还没 commit，默认拒绝（App 段唯一正常收尾是 handoff）
    const lock = readLock(wt);
    if (lock && isAppLock(lock)) {
      if (!opts.force) {
        throw new Error(
          `「${lock.agent}」的 App 会话尚未交接（软锁，不看 pid）。` +
            `先回主仓库执行 relay handoff（会 checkpoint + 审计，改动入档），再 relay merge。` +
            `确要跳过交接可 relay merge --force（未交接的未提交改动可能丢失）。`
        );
      }
      console.warn(`⚠ --force：在「${lock.agent}」的 App 软锁下合并——未交接的未提交改动可能丢失。`);
    }
    const events = readEvents(wt);

    // 门禁：红或未跑 → 拒绝（除非 --force）
    const g = lastGate(events);
    if ((!g || g.status === 'fail') && !opts.force) {
      const why = !g ? 'journal 中没有门禁记录（未执行过 handoff？）' : `门禁未通过（${g.command}）`;
      throw new Error(`${why}。确认接受后可用 relay merge --force。`);
    }

    // 保护路径：命中 → 拒绝（除非 --force）
    const changed = gitOk(root, [
      'diff',
      '--name-only',
      `${s.baseCommit}..${s.branch}`,
      '--',
      '.',
      ':(exclude).relay',
    ])
      .split('\n')
      .filter((l) => l.trim() !== '');
    const hits = changed.filter((f) => cfg.protectedPaths.some((p) => globToRegExp(p).test(f)));
    if (hits.length > 0 && !opts.force) {
      throw new Error(`保护路径被改动：${hits.join('、')}。确认接受后可用 relay merge --force。`);
    }

    // 主线状态：干净 + 未漂移（除非 --force）
    const mainDirty = blockingMainStatus(git(root, ['status', '--porcelain']).stdout);
    if (mainDirty !== '') throw new Error('主仓库工作区不干净。先提交/暂存主线自己的改动，再 relay merge。');
    const mainHead = gitOk(root, ['rev-parse', 'HEAD']);
    if (mainHead !== s.baseCommit && !opts.force) {
      throw new Error(
        `主线在任务开始后已有新提交（基准 ${s.baseCommit.slice(0, 9)} → 当前 ${mainHead.slice(0, 9)}）。` +
          '先把两边手工对齐，或 relay merge --force 尝试三方合并（冲突需自行处理）。'
      );
    }

    // squash 业务 diff
    const m = git(root, ['merge', '--squash', s.branch]);
    if (m.code !== 0) {
      throw new Error(
        `merge --squash 失败（冲突请用 git reset --merge 清掉暂存，不要 git merge --abort）：\n${m.stdout}\n${m.stderr}`
      );
    }

    // 剥离会话文件（协议三）：只允许 config.json 进主线
    const strip = ['.relay/task.md', '.relay/handoff.md', '.relay/journal.jsonl', '.relay/ONBOARD.md', ...SIDE_PATHS];
    if (!opts.keepAudits) strip.push('.relay/audits');
    for (const p of strip) {
      git(root, ['reset', '-q', 'HEAD', '--', p]);
      const abs = path.join(root, p);
      if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
    }

    const staged = git(root, ['diff', '--cached', '--name-only']).stdout;
    let squashSha: string | null = null;
    if (staged !== '') {
      const msg = buildMergeMessage({
        taskTitle: s.taskTitle,
        branch: s.branch,
        baseCommit: s.baseCommit,
        events,
      });
      const c = git(root, [...RELAY_IDENTITY, 'commit', '-m', msg]);
      if (c.code !== 0) throw new Error(`主线提交失败：${c.stderr}`);
      squashSha = gitOk(root, ['rev-parse', 'HEAD']);
    } else {
      console.log('无业务改动可进主线，跳过主线提交。');
    }

    // merge-close：journal 记录随 relay 分支保留
    appendEvent(wt, {
      ts: new Date().toISOString(),
      type: 'merge',
      ...(squashSha ? { commit: squashSha } : {}),
      squashCommit: squashSha ?? '(无业务改动)',
      worktree: wt,
    });
    commitAll(wt, `relay: merge-close ${squashSha ? squashSha.slice(0, 9) : 'none'}`);

    // 清理 worktree + 会话指针（分支保留备查；App 软锁随 worktree 删除一并清除）
    releaseLock(wt);
    let rm = git(root, ['worktree', 'remove', wt]);
    if (rm.code !== 0) {
      rm = git(root, ['worktree', 'remove', '--force', wt]);
    }
    if (rm.code !== 0) {
      fs.rmSync(wt, { recursive: true, force: true });
      git(root, ['worktree', 'prune']);
      console.warn(`worktree 已手工移除：${wt}`);
    }
    clearSession(root);

    console.log('合并完成：');
    console.log(`  主线提交：${squashSha ?? '（无业务改动）'}`);
    console.log(`  接力分支：${s.branch}（保留备查；彻底删除：git branch -D ${s.branch}）`);
    console.log(`  业务文件：${changed.length} 个`);
  });
  return cmd;
}
