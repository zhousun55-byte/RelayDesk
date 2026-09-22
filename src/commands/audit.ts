import fs from 'node:fs';
import { Command } from 'commander';
import { gitOk, repoRootAt } from '../core/git';
import { runAudit } from '../core/audit';
import { loadRelayConfig } from '../core/config';
import { appendEvent, lastCheckpoint, lastSegmentRun, readEvents } from '../core/journal';
import { requireSession } from '../core/session';

/** 调试入口：单独跑审计（正常流程由 relay handoff 内部执行，勿依赖此命令）。 */
export function auditCommand(): Command {
  const cmd = new Command('audit');
  cmd.description('单独运行两段式审计（调试用；正常流程走 relay handoff）');
  cmd.action(async () => {
    const root = repoRootAt(process.cwd());
    const cfg = loadRelayConfig(root);
    const s = requireSession(root);
    const wt = s.worktree;
    if (!fs.existsSync(wt)) throw new Error(`worktree 不存在：${wt}`);

    const events = readEvents(wt);
    const prevRun = lastSegmentRun(events);
    const agent = prevRun?.agent ?? 'framework';
    const base = lastCheckpoint(events) ?? s.baseCommit;

    // 调试入口没有检查点：比 base..HEAD 的已提交范围；脏工作区会在报告「工作区状态」节如实显示
    const audit = await runAudit(wt, cfg, agent, base, gitOk(wt, ['rev-parse', 'HEAD']));
    appendEvent(wt, {
      ts: new Date().toISOString(),
      type: 'audit',
      agent,
      report: audit.reportPath,
      status: audit.status,
      worktree: wt,
    });
    console.log(`审计完成：${audit.reportPath}（${audit.status === 'ok' ? '含阅读面' : '仅事实报告'}）`);
  });
  return cmd;
}
