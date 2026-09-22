import fs from 'node:fs';
import path from 'node:path';
import type { RelayConfig } from '../core/types';
import type { SessionState } from '../core/session';
import { lastAudit, lastRun, readEvents, reviewBaseFor } from '../core/journal';
import { buildOnboard } from '../core/prompts';

export function readTextSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 为即将上岗的 agent 写 worktree 的 .relay/ONBOARD.md（relay run 与 relay open 共用同一套上岗词）。
 * 自审基准恒用 reviewBaseFor（上一段的起点），保证 diff 能看到前任的业务改动。
 */
export function writeOnboardFor(wt: string, s: SessionState, cfg: RelayConfig): string {
  const events = readEvents(wt);
  const prevRun = lastRun(events);
  const predecessor = prevRun?.tier ? { agent: prevRun.agent, tier: prevRun.tier } : null;
  const reviewBase = reviewBaseFor(events) ?? s.baseCommit;
  const handoffDoc = readTextSafe(path.join(wt, '.relay', 'handoff.md'));
  const lastAuditEv = lastAudit(events);
  const latestAudit =
    lastAuditEv !== null
      ? {
          path: lastAuditEv.report,
          content: readTextSafe(path.join(wt, lastAuditEv.report)) ?? '（报告文件缺失）',
        }
      : null;

  const onboard = buildOnboard({
    taskTitle: s.taskTitle,
    taskBody: readTextSafe(path.join(wt, '.relay', 'task.md')) ?? s.taskTitle,
    branch: s.branch,
    worktree: wt,
    reviewBase,
    predecessor,
    handoffDoc,
    latestAudit,
    protectedPaths: cfg.protectedPaths,
    generatedAt: new Date().toISOString(),
  });
  const p = path.join(wt, '.relay', 'ONBOARD.md');
  fs.writeFileSync(p, onboard);
  return p;
}
