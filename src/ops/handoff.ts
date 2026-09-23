import fs from 'node:fs';
import path from 'node:path';
import { runAudit } from '../core/audit';
import { RelayError } from '../core/errors';
import { runGate, type GateResult } from '../core/gate';
import { commitAll, git, gitOk, mergeInProgress, shortSha } from '../core/git';
import { buildHandoffDoc } from '../core/handoff-doc';
import { appendEvent, lastCheckpoint, lastSegmentRun, pendingSyncConflicts } from '../core/journal';
import { assertFree, lockKind, withOpLock } from '../core/lock';
import { NOTE_REL } from '../core/prompts';
import { matchProtected } from '../core/protected';
import { agentLabel, findAgent } from '../core/registry';
import { diffFiles, hasConflictMarkers, listStray, sumChanges, unmergedFiles } from '../core/status';
import type { Tier } from '../core/types';
import { openTask } from './context';

export interface HandoffOptions {
  /** 人写给下一位的留言。 */
  note?: string;
  /** 工人没写 .relay/NOTE.md 时，用这段当它的自述（全自动时是它最后说的话）。 */
  selfNoteFallback?: string;
}

export interface HandoffResult {
  agent: string;
  label: string;
  checkpoint: string;
  empty: boolean;
  files: number;
  added: number;
  removed: number;
  /** null = 这一段没改动，没有重跑检查。 */
  gate: GateResult | null;
  audit: { path: string; status: 'ok' | 'failed'; note: string | null };
  protectedHits: string[];
  notes: string[];
}

/**
 * 交接：先把改动打成检查点，再审计、再跑检查，最后写交接文档。
 * 没有改动也能交接（这时只是让当前工人下岗，好换人）；桌面工人的软锁在这里释放。
 */
export async function handoff(dir: string, opts: HandoffOptions = {}): Promise<HandoffResult> {
  const ctx = openTask(dir);
  const { wt, cfg, session, events, root } = ctx;
  const lock = assertFree(wt, '交接', { allowApp: true });

  // 同步主线留下的冲突必须先解决，不然会把冲突标记当成正常内容存进检查点。
  // git 在 add 之前一直把文件标成「未合并」，所以看的是文件里还有没有冲突标记。
  const suspects = new Set([...unmergedFiles(wt), ...pendingSyncConflicts(events)]);
  const unresolved = [...suspects].filter((f) => hasConflictMarkers(wt, f));
  if (unresolved.length > 0) {
    throw new RelayError(`还有合并冲突没解决：${unresolved.join('、')}。先让工人处理掉冲突标记，再交接。`, 'conflict');
  }

  const seg = lastSegmentRun(events);
  const agent = (lock && lockKind(lock) === 'app' ? lock.agent : null) ?? seg?.agent ?? 'human';
  const reg = findAgent(agent);
  const tier: Tier | null = seg?.agent === agent ? seg.tier ?? reg?.tier ?? null : reg?.tier ?? null;
  const llm = (lock?.agent === agent ? lock?.llm : undefined) ?? (seg?.agent === agent ? seg.llm : undefined);
  const label = agentLabel(reg ?? agent);
  const base = lastCheckpoint(events) ?? session.baseCommit;
  const notes: string[] = [];

  return withOpLock(wt, '交接', agent, async () => {
    // 上一位的自述：读走、写进交接文档，然后删掉，下一位写新的。
    const notePath = path.join(wt, NOTE_REL);
    let selfNote: string | undefined;
    if (fs.existsSync(notePath)) {
      selfNote = fs.readFileSync(notePath, 'utf8').trim().slice(0, 4000) || undefined;
      fs.rmSync(notePath);
    }
    if (!selfNote && opts.selfNoteFallback?.trim()) selfNote = opts.selfNoteFallback.trim().slice(0, 4000);

    // 1. 检查点先行：新建的文件也先入库，之后的审计、统计、保护路径都比两个提交，事实只有一份。
    const iso = new Date().toISOString();
    const committed = commitAll(wt, `接力：检查点 ${agent} ${iso}`);
    const checkpoint = committed ?? gitOk(wt, ['rev-parse', 'HEAD']);
    const files = diffFiles(wt, base, checkpoint);
    const sum = sumChanges(files);
    const empty = files.length === 0;

    // 2. 审计：事实一定有；模型阅读面尽力而为。
    const audit = await runAudit({
      worktree: wt,
      cfg,
      agent,
      agentLabel: label,
      base,
      checkpoint,
      taskTitle: session.taskTitle,
      selfNote,
      empty,
    });
    appendEvent(wt, {
      ts: new Date().toISOString(),
      type: 'audit',
      agent,
      ...(tier ? { tier } : {}),
      report: audit.reportPath,
      status: audit.status,
      worktree: wt,
    });

    // 3. 检查命令：这一段没改动就不重跑，沿用上一次。
    let gate: GateResult | null = null;
    if (!empty) {
      gate = await runGate(wt, cfg);
      appendEvent(wt, {
        ts: new Date().toISOString(),
        type: 'gate',
        agent,
        status: gate.status,
        command: gate.command,
        ...(gate.status === 'fail' ? { detail: gate.detail.slice(-2000) } : {}),
        worktree: wt,
      });
      if (gate.status === 'fail') notes.push(`检查没通过（${gate.command}）。改动已存进检查点，但合回会被拒绝。`);
    }

    const hits = matchProtected(files.map((f) => f.path), cfg.protectedPaths);
    if (hits.length) notes.push(`改到了不许改的文件：${hits.join('、')}。合回会被拒绝。`);

    appendEvent(wt, {
      ts: new Date().toISOString(),
      type: 'handoff',
      agent,
      ...(tier ? { tier } : {}),
      ...(llm ? { llm } : {}),
      checkpoint,
      commit: checkpoint,
      worktree: wt,
      empty,
      files: sum.files,
      added: sum.added,
      removed: sum.removed,
      ...(opts.note?.trim() ? { note: opts.note.trim().slice(0, 4000) } : {}),
      ...(selfNote ? { selfNote } : {}),
    });

    const stat = git(wt, ['diff', '--stat', '--find-renames', `${base}..${checkpoint}`, '--', '.', ':(exclude).relay']).stdout;
    fs.writeFileSync(
      path.join(wt, '.relay', 'handoff.md'),
      buildHandoffDoc({
        taskTitle: session.taskTitle,
        branch: session.branch,
        agent,
        tier,
        ...(llm ? { llm } : {}),
        base,
        checkpoint,
        empty,
        diffstat: stat || '（没有业务改动）',
        gate,
        auditPath: audit.reportPath,
        auditStatus: audit.status,
        modelNote: audit.modelNote,
        protectedHits: hits,
        note: opts.note,
        selfNote,
        modelNext: audit.modelNext,
        ts: new Date().toISOString(),
      })
    );
    commitAll(wt, `接力：交接 ${shortSha(checkpoint)}`);
    if (mergeInProgress(wt)) notes.push('同步主线的合并还没收尾，请检查隔离副本。');

    if (empty) notes.push('这一段没有业务改动，只是让当前工人下岗。');
    const stray = listStray(root, session.mainSnapshot);
    if (stray.length) {
      notes.push(`正式文件夹在任务期间被改了 ${stray.length} 个文件（多半是 AI 开错了文件夹）。可以用「收进任务」把它们挪过来。`);
    }

    return {
      agent,
      label,
      checkpoint,
      empty,
      files: sum.files,
      added: sum.added,
      removed: sum.removed,
      gate,
      audit: { path: audit.reportPath, status: audit.status, note: audit.modelNote },
      protectedHits: hits,
      notes,
    };
  });
}
