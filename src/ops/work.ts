import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from '../core/errors';
import { mergeInProgress } from '../core/git';
import { lastAudit, lastReviewTarget, lastSegmentRun, pendingSyncConflicts } from '../core/journal';
import { copyToClipboard, fillTemplate, openTerminal, runOpener, shq } from '../core/launch';
import { clearStaleLock, describeLock, lockActive, lockKind, readLock, releaseLock, restoreLock, writeLock, type SessionLock } from '../core/lock';
import { buildOnboard, ONBOARD_HINT, type AutoBrief } from '../core/prompts';
import { agentKind, agentLabel, findAgent, requireAgent } from '../core/registry';
import type { AgentConfig } from '../core/types';
import { appendEvent } from '../core/journal';
import { openTask, pendingChanges, type TaskContext } from './context';

export interface ShiftOptions {
  /** 这一段用的模型（不填就用工人设置里的）。 */
  model?: string;
  /** 强行接替：别的桌面工人没交接、或上一位的改动没交接时也上岗（会记进交接记录）。 */
  force?: boolean;
}

interface ShiftPrep {
  ctx: TaskContext;
  agent: AgentConfig;
  llm?: string;
  /** 同一个桌面工人再点一次「打开」：只重新打开窗口，不算新的一段。 */
  reopen: boolean;
  /** 被强行接替的人。 */
  overrode?: string;
  prevLock: SessionLock | null;
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** 上岗前的检查：锁、没交接的改动、工人类型。 */
function prepareShift(dir: string, name: string, opts: ShiftOptions, want: 'cli' | 'app'): ShiftPrep {
  const ctx = openTask(dir);
  const agent = requireAgent(name);
  const kind = agentKind(agent);
  if (kind === 'api') throw new RelayError(`「${agentLabel(agent)}」是模型接口，不能手动上岗；它能在全自动里干活，也能审查、讨论。`, 'api-agent');
  if (kind !== want) {
    throw new RelayError(
      want === 'app' ? `「${agentLabel(agent)}」是终端工人，要用 relay run ${agent.name}。` : `「${agentLabel(agent)}」是桌面工人，要用 relay open ${agent.name}。`,
      'wrong-kind'
    );
  }
  clearStaleLock(ctx.wt);
  const lock = readLock(ctx.wt);
  let reopen = false;
  let overrode: string | undefined;
  if (lock && lockActive(lock)) {
    const lk = lockKind(lock);
    if (lk === 'app' && lock.agent === agent.name && want === 'app') {
      reopen = true;
    } else if (lk === 'app' && opts.force) {
      overrode = lock.agent;
    } else if (lk === 'app') {
      throw new RelayError(`${describeLock(lock)}。先交接，再换人。`, 'locked-app');
    } else {
      throw new RelayError(`${describeLock(lock)}。等它结束再说。`, lk === 'op' ? 'locked-op' : 'locked-cli');
    }
  }
  // 同步主线有冲突时，隔离副本里的「改动」就是没合完的冲突，正要派人来解决，不拦。
  if (!reopen && !overrode && !mergeInProgress(ctx.wt)) {
    const pending = pendingChanges(ctx.wt, ctx.events, ctx.session.baseCommit);
    const seg = lastSegmentRun(ctx.events);
    if (pending.files.length > 0 && seg?.agent !== agent.name) {
      if (!opts.force) {
        const who = seg ? `上一位（${agentLabel(findAgent(seg.agent) ?? seg.agent)}）` : '隔离副本里';
        throw new RelayError(`${who}有 ${pending.files.length} 个改动还没交接。先交接，再换人。`, 'pending');
      }
      overrode = seg?.agent ?? '（没登记的改动）';
    }
  }
  const llm = (opts.model ?? agent.model ?? '').trim() || undefined;
  return { ctx, agent, llm, reopen, overrode, prevLock: lock };
}

/** 写上岗说明 .relay/ONBOARD.md。终端和桌面工人用同一份。 */
export function writeOnboard(ctx: TaskContext, agent: AgentConfig, llm?: string, auto?: AutoBrief): string {
  const { wt, session, cfg, events } = ctx;
  const review = lastReviewTarget(events);
  const auditEv = lastAudit(events);
  const text = buildOnboard({
    taskTitle: session.taskTitle,
    taskBody: readText(path.join(wt, '.relay', 'task.md')) ?? session.taskTitle,
    branch: session.branch,
    worktree: wt,
    you: { agent: agent.name, label: agentLabel(agent), tier: agent.tier, ...(llm ? { llm } : {}) },
    review: review ? { ...review, label: agentLabel(findAgent(review.agent) ?? review.agent) } : null,
    handoffDoc: readText(path.join(wt, '.relay', 'handoff.md')),
    latestAudit: auditEv ? { path: auditEv.report, content: readText(path.join(wt, auditEv.report)) ?? '（报告文件不见了）' } : null,
    protectedPaths: cfg.protectedPaths,
    gateCommand: cfg.gate.command,
    conflicts: pendingSyncConflicts(events),
    generatedAt: new Date().toISOString(),
    ...(auto ? { auto } : {}),
  });
  const p = path.join(wt, '.relay', 'ONBOARD.md');
  fs.writeFileSync(p, text);
  return p;
}

export interface OpenResult {
  agent: string;
  label: string;
  worktree: string;
  reopened: boolean;
  /** 上岗那句话已经复制到剪贴板。 */
  copied: boolean;
  hint: string;
  notes: string[];
}

/** 桌面工人上岗：写上岗说明 → 挂软锁 → 用它的 App 打开隔离副本 → 立即返回。只有交接才结束这一段。 */
export async function openApp(dir: string, name: string, opts: ShiftOptions = {}): Promise<OpenResult> {
  const prep = prepareShift(dir, name, opts, 'app');
  const { ctx, agent, llm } = prep;
  const notes: string[] = [];
  if (!prep.reopen) writeLock(ctx.wt, { agent: agent.name, kind: 'app', ...(llm ? { llm } : {}) });
  try {
    if (!prep.reopen || !fs.existsSync(path.join(ctx.wt, '.relay', 'ONBOARD.md'))) writeOnboard(ctx, agent, llm);
    const cmd = fillTemplate(agent.cmd ?? '', { worktree: ctx.wt });
    const r = await runOpener(cmd, ctx.wt);
    if (!r.lingering && r.code !== 0) {
      throw new RelayError(`没能打开「${agentLabel(agent)}」（命令：${cmd}）：${r.output || `退出码 ${r.code}`}`, 'open-failed');
    }
  } catch (e) {
    if (!prep.reopen) {
      if (prep.prevLock && lockKind(prep.prevLock) === 'app') restoreLock(ctx.wt, prep.prevLock);
      else releaseLock(ctx.wt);
    }
    throw e;
  }
  if (!prep.reopen) {
    appendEvent(ctx.wt, {
      ts: new Date().toISOString(),
      type: 'open',
      agent: agent.name,
      tier: agent.tier,
      ...(llm ? { llm } : {}),
      worktree: ctx.wt,
      ...(prep.overrode ? { overrode: prep.overrode } : {}),
    });
    if (prep.overrode) notes.push(`强行接替了 ${agentLabel(prep.overrode)}，已记进交接记录。`);
  }
  const copied = copyToClipboard(ONBOARD_HINT);
  return { agent: agent.name, label: agentLabel(agent), worktree: ctx.wt, reopened: prep.reopen, copied, hint: ONBOARD_HINT, notes };
}

export interface TerminalLaunch {
  agent: string;
  label: string;
  /** 已经在「终端」里开了窗口。false 时让人自己把 command 粘到终端里。 */
  opened: boolean;
  command: string;
  error?: string;
}

/** 接力台上点终端工人：先做同样的检查，然后开一个终端窗口跑 relay run（锁由那个进程自己拿）。 */
export function launchInTerminal(dir: string, name: string, opts: ShiftOptions = {}): TerminalLaunch {
  const prep = prepareShift(dir, name, opts, 'cli');
  const cli = path.join(__dirname, '..', 'cli.js');
  const parts = [shq(process.execPath), shq(cli), 'run', shq(prep.agent.name)];
  if (opts.model?.trim()) parts.push('--model', shq(opts.model.trim()));
  if (opts.force) parts.push('--force');
  const command = `cd ${shq(prep.ctx.root)} && ${parts.join(' ')}`;
  const r = openTerminal(command);
  return { agent: prep.agent.name, label: agentLabel(prep.agent), opened: r.ok, command, ...(r.error ? { error: r.error } : {}) };
}

/** 杀掉整组进程（工人可能又开了子进程，只杀直接子进程会留下孤儿继续写盘）。 */
export function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals = 'SIGKILL'): boolean {
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function waitExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.on('error', (err) => {
      console.error(`启动失败：${err.message}`);
      resolve(-1);
    });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : -1)));
  });
}

/**
 * 终端工人上岗：在隔离副本里启动它，一直等到它退出（只在命令行里用）。
 * Ctrl-C：第一次转给工人、继续等；第二次强杀整组进程，记下退出码 130，释放锁再退出。
 */
export async function runCli(dir: string, name: string, opts: ShiftOptions = {}): Promise<number> {
  const prep = prepareShift(dir, name, opts, 'cli');
  const { ctx, agent, llm } = prep;
  const wt = ctx.wt;
  // 先拿锁再写任何东西：锁被拒时，交接记录里不能留下一条没有结尾的「上岗」。
  writeLock(wt, { agent: agent.name, kind: 'cli', ...(llm ? { llm } : {}) });
  let child: ChildProcess | null = null;
  let interrupts = 0;
  const exitEvent = (code: number) =>
    appendEvent(wt, { ts: new Date().toISOString(), type: 'exit', agent: agent.name, tier: agent.tier, worktree: wt, code, quotaHint: false });
  const onSignal = (sig: NodeJS.Signals): void => {
    interrupts += 1;
    if (interrupts === 1) {
      const sent = killProcessGroup(child?.pid, sig);
      console.error(`\n收到 ${sig}：${sent ? '已转给工人，' : ''}等待工人自己结束（再按一次会强制结束）…`);
      return;
    }
    killProcessGroup(child?.pid, 'SIGKILL');
    exitEvent(130);
    releaseLock(wt);
    process.exit(130);
  };
  try {
    const onboard = writeOnboard(ctx, agent, llm);
    appendEvent(wt, {
      ts: new Date().toISOString(),
      type: 'run',
      agent: agent.name,
      tier: agent.tier,
      ...(llm ? { llm } : {}),
      worktree: wt,
      ...(prep.overrode ? { overrode: prep.overrode } : {}),
    });
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    const mode = agent.prompt?.mode ?? 'file';
    console.log(`上岗说明：${onboard}`);
    console.log(`启动 ${agentLabel(agent)}（${agent.cmd}），工作目录：${wt}`);
    if (mode === 'file') console.log(`如果它没有自己去读，把这句话发给它：${ONBOARD_HINT}`);
    console.log('');
    const cmd = agent.cmd ?? '';
    if (mode === 'arg') {
      child = spawn('sh', ['-c', `${cmd} ${shq(ONBOARD_HINT)}`], { cwd: wt, stdio: 'inherit', detached: true });
    } else if (mode === 'stdin') {
      child = spawn('sh', ['-c', cmd], { cwd: wt, stdio: ['pipe', 'inherit', 'inherit'], detached: true });
      child.stdin?.on('error', () => {
        /* 工人可能不读标准输入，以退出码为准 */
      });
      child.stdin?.end(ONBOARD_HINT + '\n');
    } else {
      child = spawn('sh', ['-c', cmd], { cwd: wt, stdio: 'inherit', detached: true });
    }
    const code = await waitExit(child);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    exitEvent(code);
    return code;
  } finally {
    const cur = readLock(wt);
    if (cur && cur.pid === process.pid) releaseLock(wt);
  }
}
