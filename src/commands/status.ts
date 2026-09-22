import fs from 'node:fs';
import { Command } from 'commander';
import { git, repoRootAt } from '../core/git';
import { loadRelayConfig } from '../core/config';
import { checkpoints, lastAudit, lastCheckpoint, lastGate, lastRun, readEvents } from '../core/journal';
import { isAppLock, readLock } from '../core/lock';
import { protectedHits } from '../core/protected';
import { loadSession } from '../core/session';

export function statusCommand(): Command {
  const cmd = new Command('status');
  cmd.description('当前任务 / 分支 / 检查点 / 门禁与审计结论（换人决策面板）');
  cmd.action(() => {
    const root = repoRootAt(process.cwd());
    const s = loadSession(root);
    if (!s) {
      console.log('无活跃任务。用 relay start "任务描述" 开始。');
      return;
    }
    console.log(`任务：${s.taskTitle}`);
    console.log(`分支：${s.branch}`);
    console.log(`worktree：${s.worktree}${fs.existsSync(s.worktree) ? '' : '（目录缺失！可 relay abandon 清理）'}`);
    console.log(`主线基准：${s.baseCommit.slice(0, 9)}（开始于 ${s.startedAt}）`);

    const wt = s.worktree;
    const events = fs.existsSync(wt) ? readEvents(wt) : [];

    const lock = readLock(wt);
    if (lock) {
      if (isAppLock(lock)) {
        console.log(`⚠ App 会话进行中：「${lock.agent}」（软锁，不看 pid；停手后回主仓库执行 relay handoff）。`);
      } else {
        console.log('⚠ 有会话进行中（session.lock 存在）：另一个终端可能正在跑 agent。');
      }
    }

    const cps = checkpoints(events, s.startCommit);
    if (cps.length > 0) {
      console.log('检查点（rollback 目标，旧→新）：');
      for (const c of cps) console.log(`  ${c.sha.slice(0, 9)}  ${c.agent}  ${c.ts}`);
    } else {
      console.log('检查点：尚无');
    }

    const run = lastRun(events);
    if (run) {
      // exit 只与最近一次上岗（run/open）配对展示：App 段没有 exit（它的收尾是 handoff），
      // 更早 cli 段的 exit 不属于当前客人
      let lastWorkType: 'run' | 'open' | null = null;
      let exitAfter: { code: number; quotaHint: boolean } | null = null;
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (ev.type === 'run' || ev.type === 'open') {
          lastWorkType = ev.type;
          break;
        }
        if (ev.type === 'exit' && exitAfter === null) exitAfter = ev;
      }
      if (lastWorkType === 'open') {
        console.log(`最近干活：${run.agent}（tier=${run.tier ?? '?'}；App 客人，本段以 relay handoff 收尾，无进程退出码）`);
      } else {
        const exitInfo =
          exitAfter !== null
            ? `，exit code=${exitAfter.code}${exitAfter.quotaHint ? '（疑似额度耗尽——尽力而为的标记，不保证）' : ''}`
            : '';
        console.log(`最近干活：${run.agent}（tier=${run.tier ?? '?'}${exitInfo}）`);
      }
    } else {
      console.log('最近干活：尚无 agent 上岗');
    }

    const g = lastGate(events);
    console.log(`门禁：${g ? (g.status === 'pass' ? `通过（${g.command}）` : `未通过（${g.command}）`) : '尚未运行'}`);

    const a = lastAudit(events);
    console.log(`审计：${a ? `${a.status === 'ok' ? '含阅读面' : '仅事实报告'} ${a.report}` : '尚未运行'}`);

    // 保护路径命中标红（config 缺失时跳过此项，不影响其余展示）
    try {
      const cfg = loadRelayConfig(root);
      const base = lastCheckpoint(events) ?? s.baseCommit;
      const hits = protectedHits(wt, cfg, base);
      if (hits.length > 0) {
        console.log(`⚠ 保护路径被改动：${hits.join('、')}（relay merge 将拒绝，除非 --force）`);
      }
    } catch {
      /* .relay/config.json 缺失：跳过保护检查 */
    }

    if (fs.existsSync(wt)) {
      const dirty = git(wt, ['status', '--porcelain']).stdout;
      if (dirty !== '') {
        const n = dirty.split('\n').filter((l) => l.trim() !== '').length;
        console.log(`⚠ 有 ${n} 处未交接改动（跑过 agent 后请执行 relay handoff）。`);
      }
    }
  });
  return cmd;
}
