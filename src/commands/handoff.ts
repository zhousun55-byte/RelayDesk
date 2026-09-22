import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { commitAll, git, gitOk, repoRootAt } from '../core/git';
import { loadRelayConfig } from '../core/config';
import { runAudit } from '../core/audit';
import { runGate } from '../core/gate';
import { buildHandoffDoc } from '../core/handoff';
import { appendEvent, lastCheckpoint, lastSegmentRun, readEvents } from '../core/journal';
import { assertNoLiveLock, holdForHandoff, releaseLockIfOwner } from '../core/lock';
import { protectedHits } from '../core/protected';
import { requireSession, type SessionState } from '../core/session';
import type { JournalEvent, RelayConfig, Tier } from '../core/types';

export function handoffCommand(): Command {
  const cmd = new Command('handoff');
  cmd.description('一键交接：audit + gate + checkpoint 提交 + 重写 handoff.md（审计失败不阻塞交接）');
  cmd.action(async () => {
    const root = repoRootAt(process.cwd());
    const cfg = loadRelayConfig(root);
    const s = requireSession(root);
    const wt = s.worktree;
    if (!fs.existsSync(wt)) throw new Error(`worktree 不存在：${wt}`);

    // 单写者：agent 还在跑就不交接，防止检查点打到半截工作上
    assertNoLiveLock(wt, 'handoff');

    const events = readEvents(wt);
    const prevRun = lastSegmentRun(events);
    const agent = prevRun?.agent ?? 'framework';
    const tier = prevRun?.tier ?? null;
    const base = lastCheckpoint(events) ?? s.baseCommit;
    holdForHandoff(wt, agent);
    try {
      await finishHandoff(cfg, s, wt, events, agent, tier, base, prevRun?.llm);
    } finally {
      releaseLockIfOwner(wt);
    }
  });
  return cmd;
}

async function finishHandoff(
  cfg: RelayConfig,
  s: SessionState,
  wt: string,
  events: JournalEvent[],
  agent: string,
  tier: Tier | null,
  base: string,
  llm?: string
): Promise<void> {
  // 1. 检查点先行：尊重 .gitignore 后 add -A（协议二）。agent 新建的未跟踪文件先入库，
  //    之后审计 / 事实段 / 保护路径一律比 base..checkpointSha 两份提交——
  //    不再有「未跟踪文件只有文件名、没有内容」的盲区，两份事实不会不一致。
  const iso = new Date().toISOString();
  const committed = commitAll(wt, `relay: checkpoint ${agent} ${iso}`);
  const checkpointSha = committed ?? gitOk(wt, ['rev-parse', 'HEAD']);

  // 2. 审计：事实段必落盘；阅读面失败也继续（F6）
  const audit = await runAudit(wt, cfg, agent, base, checkpointSha);
  appendEvent(wt, {
    ts: new Date().toISOString(),
    type: 'audit',
    agent,
    ...(tier ? { tier } : {}),
    report: audit.reportPath,
    status: audit.status,
    worktree: wt,
  });

  // 3. 门禁
  const gate = runGate(wt, cfg);
  appendEvent(wt, {
    ts: new Date().toISOString(),
    type: 'gate',
    agent,
    status: gate.status,
    command: gate.command,
    ...(gate.status === 'fail' && gate.detail ? { detail: gate.detail.slice(0, 2000) } : {}),
    worktree: wt,
  });
  if (gate.status === 'fail') {
    console.warn(`⚠ 门禁未通过（${gate.command}）。改动仍被检查点保护，但 relay merge 会拒绝（除非 --force）。`);
  }

  // 保护路径命中标红（merge 语义不变：仍由 merge 拒绝）。比已提交范围 base..checkpointSha。
  const hits = protectedHits(wt, cfg, base, checkpointSha);
  if (hits.length > 0) {
    console.warn(`⚠ 保护路径被改动：${hits.join('、')}（relay merge 将拒绝，除非 --force）`);
  }

  // 4. handoff 事件：checkpoint 仍是第一次 commit 的 SHA（rollback 目标不变）
  appendEvent(wt, {
    ts: new Date().toISOString(),
    type: 'handoff',
    agent,
    ...(tier ? { tier } : {}),
    checkpoint: checkpointSha,
    commit: checkpointSha,
    worktree: wt,
  });

  // 5. 重写 handoff.md：框架填事实，模型只写「建议的下一步」一节
  const diffstat =
    git(wt, ['diff', '--stat', `${base}..${checkpointSha}`, '--', '.', ':(exclude).relay']).stdout || '（无业务改动）';
  const doc = buildHandoffDoc(
    {
      taskTitle: s.taskTitle,
      branch: s.branch,
      checkpoint: checkpointSha,
      prevCheckpoint: lastCheckpoint(events),
      diffstat,
      gate,
      auditPath: audit.reportPath,
      auditStatus: audit.status,
      agent,
      tier,
      ...(llm ? { llm } : {}),
      protectedHits: hits,
      ts: new Date().toISOString(),
    },
    audit.modelNext
  );
  fs.writeFileSync(path.join(wt, '.relay', 'handoff.md'), doc);

  // 6. 收尾提交（audit/gate/handoff 事件 + 审计报告 + 新 handoff.md 一并入库）
  commitAll(wt, `relay: handoff ${checkpointSha.slice(0, 9)}`);

  console.log('交接完成：');
  console.log(`  检查点：${checkpointSha.slice(0, 9)}（rollback 目标）`);
  console.log(`  门禁：${gate.status === 'pass' ? '通过' : '未通过'}（${gate.command}）`);
  console.log(`  审计：${audit.reportPath}（${audit.status === 'ok' ? '含阅读面' : '仅事实报告'}）`);
  console.log(`  交接文档：${path.join(wt, '.relay', 'handoff.md')}`);
  console.log('');
  console.log('下一步：relay run <下一位 agent> 继续接力（App 客人用 relay open）；relay status 查看全貌。');
}
