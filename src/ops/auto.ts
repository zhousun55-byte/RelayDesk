import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { truncatedDiff } from '../core/audit';
import { loadAutoSettings, normalizeAutoSettings, type AutoSettings } from '../core/auto-settings';
import { listMembers, loadDetected, resolveTeam, type Member } from '../core/detect';
import { errorMessage, RelayError } from '../core/errors';
import { git, mergeBase, mergeInProgress, shortSha } from '../core/git';
import { gateConfigured } from '../core/gate';
import { findHarness, locateCached } from '../core/harness';
import { appendEvent, lastFixReview, lastGate, lastHandoff, lastReview, pendingSyncConflicts, reviewsSinceAuto } from '../core/journal';
import { chat } from '../core/llm';
import { runLlmAgent } from '../core/llm-agent';
import { clearStaleLock, describeLock, lockActive, lockKind, pidAlive, readLock, releaseLock, writeLock } from '../core/lock';
import { relayHome, repoKey } from '../core/paths';
import { inspectProject } from '../core/project';
import { matchProtected } from '../core/protected';
import { agentLabel } from '../core/registry';
import { buildReviewRequest, parseVerdict, REVIEW_PROMPT, WORK_PROMPT, type Verdict } from '../core/review';
import { clip, startRun, type RunHandle } from '../core/runner';
import { loadSession } from '../core/session';
import { diffFiles, hasConflictMarkers } from '../core/status';
import { openTask, pendingChanges, type TaskContext } from './context';
import { handoff } from './handoff';
import { merge } from './merge';
import { startTask } from './start';
import { syncMain } from './sync';
import { writeOnboard } from './work';

/**
 * 全自动流水线：开始任务 → 主力干活 → 交接（检查点 + 检查）→ 另一个 AI 审查 →
 * 要改就把意见交给下一轮 → 审查通过后自动合回。每一步都记进交接记录，所以随时能停、能接着跑：
 * 「下一步做什么」完全由交接记录推出来，不靠内存里的状态。
 */

export type AutoStatus = 'running' | 'done' | 'ready' | 'needs-human' | 'failed' | 'stopped';

export interface AutoStep {
  n: number;
  kind: 'start' | 'work' | 'handoff' | 'review' | 'sync' | 'merge';
  agent?: string;
  label: string;
  status: 'running' | 'ok' | 'fail' | 'skip';
  startedAt: string;
  endedAt?: string;
  /** 这一步的日志文件。 */
  log?: string;
  detail?: string;
  /** 这一步启动的工具进程（接力台被关掉后再继续时，先把残留的结束掉）。 */
  pid?: number;
}

export interface TeamView {
  name: string;
  label: string;
  model?: string;
}

export interface AutoState {
  id: string;
  root: string;
  pid: number;
  goal: string;
  status: AutoStatus;
  /** 现在在干什么（给人看）。 */
  phase: string;
  round: number;
  maxRounds: number;
  level: AutoSettings['level'];
  autoMerge: boolean;
  team: { workers: TeamView[]; reviewers: TeamView[] };
  startedAt: string;
  updatedAt: string;
  steps: AutoStep[];
  result?: string;
  mergedCommit?: string;
  /** 上次跑到一半接力台被关了。 */
  interrupted?: boolean;
}

export interface AutoOptions {
  /** 要做什么（没有进行中的任务时必填；有任务时不填 = 接着跑）。 */
  goal?: string;
  acceptance?: string;
  workers?: string[];
  reviewers?: string[];
  maxRounds?: number;
  autoMerge?: boolean;
  level?: AutoSettings['level'];
  workTimeoutMin?: number;
  reviewTimeoutMin?: number;
}

export interface AutoHooks {
  onUpdate?: (s: AutoState) => void;
  /** 工具的实时日志行。 */
  onLine?: (line: string) => void;
}

// ---- 状态文件 ----

function projDir(root: string): string {
  return path.join(relayHome(), 'projects', repoKey(root));
}

export function autoStatePath(root: string): string {
  return path.join(projDir(root), 'auto.json');
}

function stopFlagPath(root: string): string {
  return path.join(projDir(root), 'auto.stop');
}

export function loadAutoState(root: string): AutoState | null {
  try {
    const s = JSON.parse(fs.readFileSync(autoStatePath(root), 'utf8')) as AutoState;
    if (!s || typeof s.id !== 'string' || !Array.isArray(s.steps)) return null;
    if (s.status === 'running' && !pidAlive(s.pid)) {
      return { ...s, status: 'stopped', interrupted: true, phase: '上次跑到一半，接力台被关掉了。可以「继续全自动」。' };
    }
    return s;
  } catch {
    return null;
  }
}

/** 当前（或最近一步）的日志末尾。 */
export function autoLogTail(s: AutoState | null, maxLines = 80): { step: number; label: string; text: string } | null {
  if (!s) return null;
  for (let i = s.steps.length - 1; i >= 0; i--) {
    const st = s.steps[i];
    if (!st.log) continue;
    try {
      const fd = fs.openSync(st.log, 'r');
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 96 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n');
      if (size > len) lines.shift();
      return { step: st.n, label: st.label, text: lines.slice(-maxLines).join('\n').trimEnd() };
    } catch {
      return { step: st.n, label: st.label, text: '（日志还没有内容）' };
    }
  }
  return null;
}

// ---- 同一个项目同一时间只跑一条流水线 ----

const runners = new Map<string, AutoRunner>();

export function autoRunningHere(root: string): boolean {
  return runners.has(path.resolve(root));
}

/** 这个项目有没有正在跑的全自动（本进程或别的进程）。 */
export function autoActive(root: string): boolean {
  return autoRunningHere(root) || loadAutoState(root)?.status === 'running';
}

/** 叫停。别的进程跑的（比如终端里的 relay auto）通过停止标记通知它。 */
/** 接力台退出前：叫停本进程里所有在跑的全自动（连同它们启动的工具）。 */
export function stopAllAuto(): void {
  for (const r of runners.values()) r.stop();
}

/** 上次被关掉时留下的工具进程（还活着的）：先结束掉，免得两个 AI 同时改一个文件夹。 */
function killLeftovers(prev: AutoState | null): number {
  if (!prev) return 0;
  let n = 0;
  for (const st of prev.steps) {
    if (st.status !== 'running' || !st.pid || !pidAlive(st.pid)) continue;
    try {
      process.kill(-st.pid, 'SIGTERM');
    } catch {
      try {
        process.kill(st.pid, 'SIGTERM');
      } catch {
        continue;
      }
    }
    n++;
  }
  return n;
}

export function stopAuto(root: string): boolean {
  const r = runners.get(path.resolve(root));
  if (r) {
    r.stop();
    return true;
  }
  const s = loadAutoState(root);
  if (s?.status === 'running') {
    fs.mkdirSync(projDir(root), { recursive: true });
    fs.writeFileSync(stopFlagPath(root), new Date().toISOString());
    return true;
  }
  return false;
}

function tmpOut(): string {
  return path.join(os.tmpdir(), `relay-out-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.txt`);
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

type Decision =
  | { kind: 'work'; round: number }
  | { kind: 'handoff'; round: number }
  | { kind: 'review'; round: number }
  | { kind: 'merge'; round: number }
  | { kind: 'exhausted'; why: string }
  | { kind: 'blocked'; why: string };

interface ShiftOutcome {
  code: number;
  finalText: string;
  error?: string;
}

class AutoRunner {
  readonly state: AutoState;
  private stopRequested = false;
  private current: RunHandle | null = null;
  private readonly failedWorkers = new Set<string>();
  private readonly failedReviewers = new Set<string>();
  private syncTries = 0;

  constructor(
    private readonly root: string,
    private readonly settings: AutoSettings,
    private readonly team: { workers: Member[]; reviewers: Member[] },
    private readonly hooks: AutoHooks,
    goal: string
  ) {
    const view = (m: Member): TeamView => ({ name: m.name, label: m.label, ...(m.model ? { model: m.model } : {}) });
    const t = nowIso();
    this.state = {
      id: `${t.replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomBytes(2).toString('hex')}`,
      root,
      pid: process.pid,
      goal,
      status: 'running',
      phase: '准备中…',
      round: 1,
      maxRounds: settings.maxRounds,
      level: settings.level,
      autoMerge: settings.autoMerge,
      team: { workers: team.workers.map(view), reviewers: team.reviewers.map(view) },
      startedAt: t,
      updatedAt: t,
      steps: [],
    };
    fs.rmSync(stopFlagPath(root), { force: true });
    this.save();
  }

  stop(): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.state.phase = '正在停止…';
    this.save();
    this.current?.stop();
  }

  // ---- 记录 ----

  private save(): void {
    this.state.updatedAt = nowIso();
    try {
      fs.mkdirSync(projDir(this.root), { recursive: true });
      const p = autoStatePath(this.root);
      fs.writeFileSync(`${p}.tmp`, JSON.stringify(this.state, null, 2) + '\n');
      fs.renameSync(`${p}.tmp`, p);
    } catch {
      /* 状态写不了不影响干活 */
    }
    this.hooks.onUpdate?.(this.state);
  }

  step(kind: AutoStep['kind'], label: string, agent?: string, withLog = false): AutoStep {
    const n = this.state.steps.length + 1;
    const st: AutoStep = { n, kind, label, status: 'running', startedAt: nowIso(), ...(agent ? { agent } : {}) };
    if (withLog) st.log = path.join(projDir(this.root), 'auto-logs', this.state.id, `${String(n).padStart(2, '0')}-${kind}${agent ? `-${agent}` : ''}.log`);
    this.state.steps.push(st);
    this.save();
    return st;
  }

  private track(st: AutoStep, h: RunHandle): void {
    this.current = h;
    if (h.pid) {
      st.pid = h.pid;
      this.save();
    }
  }

  private end(st: AutoStep, status: AutoStep['status'], detail?: string): void {
    delete st.pid;
    st.status = status;
    st.endedAt = nowIso();
    if (detail) st.detail = detail;
    this.save();
  }

  private phase(text: string): void {
    this.state.phase = text;
    this.save();
  }

  private logTo(st: AutoStep): (line: string) => void {
    return (line: string) => {
      const d = new Date();
      const p = (x: number) => String(x).padStart(2, '0');
      const full = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${line}`;
      try {
        if (st.log) {
          fs.mkdirSync(path.dirname(st.log), { recursive: true });
          fs.appendFileSync(st.log, full + '\n');
        }
      } catch {
        /* 日志写不了不影响干活 */
      }
      this.hooks.onLine?.(full);
    };
  }

  private finish(status: AutoStatus, text: string): AutoState {
    this.state.status = status;
    this.state.result = text;
    this.state.phase = text;
    try {
      const s = loadSession(this.root);
      if (s && fs.existsSync(s.worktree)) {
        appendEvent(s.worktree, { ts: nowIso(), type: 'auto', phase: 'end', runId: this.state.id, status, detail: text.slice(0, 600) });
      }
    } catch {
      /* 记不上不影响结果 */
    }
    this.releaseOwnLock();
    this.save();
    return this.state;
  }

  private releaseOwnLock(): void {
    try {
      const s = loadSession(this.root);
      if (!s || !fs.existsSync(s.worktree)) return;
      const lk = readLock(s.worktree);
      if (lk && lk.pid === process.pid && lockKind(lk) !== 'app') releaseLock(s.worktree);
    } catch {
      /* 已经没有任务了 */
    }
  }

  // ---- 主循环 ----

  async run(): Promise<AutoState> {
    const poll = setInterval(() => {
      if (fs.existsSync(stopFlagPath(this.root))) {
        fs.rmSync(stopFlagPath(this.root), { force: true });
        this.stop();
      }
    }, 1500);
    try {
      const ctx0 = openTask(this.root);
      const who = (l: TeamView[]) => l.map((m) => `${m.label}${m.model ? `（${m.model}）` : ''}`).join(' → ') || '（没有）';
      appendEvent(ctx0.wt, {
        ts: nowIso(),
        type: 'auto',
        phase: 'begin',
        runId: this.state.id,
        detail: `干活：${who(this.state.team.workers)}；审查：${who(this.state.team.reviewers)}；最多 ${this.settings.maxRounds} 轮；${this.settings.level === 'full' ? '完全放开' : '安全档'}`,
      });
      for (let guard = 0; guard < 60; guard++) {
        if (this.stopRequested) return this.finish('stopped', '已停止。改到一半的东西都在隔离副本里：可以「继续全自动」，也可以手动接着做。');
        const d = this.decide(openTask(this.root));
        if (d.kind === 'blocked' || d.kind === 'exhausted') return this.finish('needs-human', d.why);
        if (d.kind === 'work') this.state.round = d.round;
        if (d.kind === 'handoff') {
          await this.doHandoff(d.round, undefined, undefined, '收尾：先把没交接的改动存下来');
        } else if (d.kind === 'work') {
          if (!(await this.doWork(d.round))) {
            if (this.stopRequested) continue;
            return this.finish('failed', '所有能干活的人都没做出改动（或者都出错了）。看看各步骤的日志；登录过期、额度用完是常见原因。');
          }
        } else if (d.kind === 'review') {
          if (!(await this.doReview(d.round))) {
            if (this.stopRequested) continue;
            return this.finish('needs-human', '没有审查员给出能看懂的结论（都出错了）。看看日志；也可以自己看改动后手动合回。');
          }
        } else {
          const r = await this.doMerge();
          if (r) return r;
        }
      }
      return this.finish('failed', '步骤太多了，为防止死循环先停下。看看步骤记录。');
    } catch (e) {
      return this.finish('failed', errorMessage(e));
    } finally {
      clearInterval(poll);
      this.releaseOwnLock();
    }
  }

  /** 看交接记录决定下一步。 */
  private decide(ctx: TaskContext): Decision {
    const { wt, events, session } = ctx;
    clearStaleLock(wt);
    const lock = readLock(wt);
    if (lock && lockActive(lock) && lock.pid !== process.pid) {
      return { kind: 'blocked', why: `${describeLock(lock)}。先让它交接（或者在接力台里处理掉），再继续全自动。` };
    }
    const reviews = reviewsSinceAuto(events, this.state.id);
    const round = Math.min(reviews.length + 1, this.settings.maxRounds + 1);
    if (mergeInProgress(wt)) {
      const unresolved = pendingSyncConflicts(events).filter((f) => hasConflictMarkers(wt, f));
      return unresolved.length ? { kind: 'work', round } : { kind: 'handoff', round };
    }
    if (pendingChanges(wt, events, session.baseCommit).files.length) return { kind: 'handoff', round };
    const hand = lastHandoff(events, { nonEmpty: true });
    if (!hand) return { kind: 'work', round };
    const rev = lastReview(events);
    if (!rev || rev.checkpoint !== hand.checkpoint) return { kind: 'review', round };
    if (rev.verdict === 'pass') return { kind: 'merge', round };
    if (reviews.length >= this.settings.maxRounds) {
      return {
        kind: 'exhausted',
        why: `已经改了 ${reviews.length} 轮，审查还是要求修改。最后的意见：${rev.issues.slice(0, 4).join('；') || rev.summary}。可以自己看看改动后手动合回，或者「继续全自动」再给几轮。`,
      };
    }
    return { kind: 'work', round };
  }

  // ---- 干活 ----

  private async doWork(round: number): Promise<boolean> {
    for (const w of this.team.workers) {
      if (this.failedWorkers.has(w.name)) continue;
      if (this.stopRequested) return false;
      const out = await this.shift(w, round);
      if (this.stopRequested) return false;
      const ctx = openTask(this.root);
      if (pendingChanges(ctx.wt, ctx.events, ctx.session.baseCommit).files.length || mergeInProgress(ctx.wt)) {
        await this.doHandoff(round, w, out.finalText);
        return true;
      }
      this.failedWorkers.add(w.name);
      const st = this.step('handoff', `${w.label} 没有做出改动，换人`, w.name);
      try {
        await handoff(this.root, { note: `全自动第 ${round} 轮：${w.label} 没有做出改动${out.error ? `（${out.error}）` : ''}` });
        this.end(st, 'skip', out.error ?? clip(out.finalText, 300));
      } catch (e) {
        this.end(st, 'fail', errorMessage(e));
      }
    }
    return false;
  }

  private async shift(w: Member, round: number): Promise<ShiftOutcome> {
    const ctx = openTask(this.root);
    const { wt } = ctx;
    clearStaleLock(wt);
    const lock = readLock(wt);
    if (lock && lockActive(lock) && lock.pid !== process.pid) throw new RelayError(`${describeLock(lock)}。`, 'locked');
    const llm = w.model;
    writeLock(wt, { agent: w.name, kind: 'cli', auto: true, ...(llm ? { llm } : {}) });
    const fix = lastFixReview(ctx.events);
    const hand = lastHandoff(ctx.events, { nonEmpty: true });
    const review =
      fix && hand && fix.checkpoint === hand.checkpoint
        ? { reviewer: `${agentLabel(fix.agent ?? '?')}${fix.llm ? ` · ${fix.llm}` : ''}`, summary: fix.summary, issues: fix.issues }
        : null;
    const onboard = writeOnboard(ctx, w.agent, llm, { round, review });
    appendEvent(wt, { ts: nowIso(), type: 'run', agent: w.name, tier: w.agent.tier, ...(llm ? { llm } : {}), worktree: wt, auto: true, round });
    const st = this.step('work', `第 ${round} 轮 · ${w.label}${llm ? `（${llm}）` : ''} 干活`, w.name, true);
    this.phase(`第 ${round} 轮：${w.label} 正在干活…`);
    const timeoutMs = this.settings.workTimeoutMin * 60_000;
    let out: ShiftOutcome;
    try {
      if (w.kind === 'harness') {
        const spec = findHarness(w.harness);
        const loc = spec ? locateCached(spec) : null;
        if (!spec || !loc) {
          out = { code: -1, finalText: '', error: '找不到这个工具了' };
        } else {
          const inv = spec.invoke(loc, {
            cwd: wt,
            prompt: WORK_PROMPT,
            level: this.settings.level,
            readOnly: false,
            model: w.agent.model?.trim() || undefined,
            effort: w.agent.effort,
            outFile: tmpOut(),
          });
          const h = startRun({ invocation: inv, cwd: wt, timeoutMs, logPath: st.log!, title: st.label, onLine: this.hooks.onLine });
          this.track(st, h);
          const r = await h.done;
          this.current = null;
          const err = r.error ?? (r.stopped ? '被叫停' : r.timedOut ? `超过 ${this.settings.workTimeoutMin} 分钟` : r.code !== 0 ? `退出码 ${r.code}${r.stderrTail ? `：${clip(r.stderrTail.split('\n').slice(-3).join(' '), 200)}` : ''}` : undefined);
          out = { code: r.code, finalText: r.finalText, ...(err ? { error: err } : {}) };
        }
      } else {
        const log = this.logTo(st);
        log(`# ${st.label}（接力台内置小代理，${w.agent.api?.baseUrl} · ${w.agent.api?.model}）`);
        const r = await runLlmAgent({
          spec: w.agent.api!,
          cwd: wt,
          brief: readText(onboard) ?? '',
          level: this.settings.level,
          gateCommand: ctx.cfg.gate.command,
          protectedPaths: ctx.cfg.protectedPaths,
          log,
          shouldStop: () => this.stopRequested,
          deadline: Date.now() + timeoutMs,
        });
        const err = r.error ?? (r.stopped ? '被叫停' : r.timedOut ? `超过 ${this.settings.workTimeoutMin} 分钟` : undefined);
        log(`结束（${r.steps} 步${err ? `，${err}` : ''}）`);
        out = { code: err ? 1 : 0, finalText: r.finalText, ...(err ? { error: err } : {}) };
      }
    } catch (e) {
      out = { code: -1, finalText: '', error: errorMessage(e) };
    }
    appendEvent(wt, { ts: nowIso(), type: 'exit', agent: w.name, tier: w.agent.tier, worktree: wt, code: out.code, quotaHint: false });
    this.end(st, out.error ? 'fail' : 'ok', out.error ?? (clip(out.finalText, 300) || undefined));
    return out;
  }

  private async doHandoff(round: number, w?: Member, finalText?: string, label?: string): Promise<void> {
    const st = this.step('handoff', label ?? `第 ${round} 轮 · 交接（存检查点、跑检查）`, w?.name);
    this.phase('交接：存检查点、跑检查…');
    try {
      const r = await handoff(this.root, {
        note: `全自动第 ${round} 轮`,
        ...(finalText?.trim() ? { selfNoteFallback: `（没写 NOTE.md，这是它最后说的话）${finalText.trim().slice(0, 1500)}` } : {}),
      });
      const gate = r.gate && gateConfigured(r.gate) ? (r.gate.status === 'pass' ? '，检查通过' : '，检查没过') : '';
      this.end(st, 'ok', r.empty ? '没有改动' : `${r.files} 个文件 +${r.added} −${r.removed}${gate}`);
    } catch (e) {
      this.end(st, 'fail', errorMessage(e));
      throw e;
    }
  }

  // ---- 审查 ----

  private async doReview(round: number): Promise<boolean> {
    const ctx = openTask(this.root);
    const { wt, events, session, cfg } = ctx;
    const hand = lastHandoff(events, { nonEmpty: true });
    if (!hand) return false;
    const implementer = hand.agent ?? '?';
    const mb = mergeBase(wt, session.mainBranch ?? 'HEAD', 'HEAD') ?? session.baseCommit;
    const files = diffFiles(wt, mb, 'HEAD');
    const gate = lastGate(events);
    const prev = lastFixReview(events);
    const hits = matchProtected(files.map((f) => f.path), cfg.protectedPaths);
    const request = buildReviewRequest({
      taskText: readText(path.join(wt, '.relay', 'task.md')) ?? session.taskTitle,
      round,
      implementer: `${agentLabel(implementer)}${hand.llm ? `（${hand.llm}）` : ''}`,
      selfNote: hand.selfNote,
      gate: gate ? { status: gate.status, command: gate.command, ...(gate.detail ? { detail: gate.detail } : {}) } : null,
      previous: prev && prev.checkpoint !== hand.checkpoint ? { reviewer: agentLabel(prev.agent ?? '?'), issues: prev.issues } : null,
      protectedHits: hits,
      diffstat: git(wt, ['diff', '--stat', '--find-renames', `${mb}..HEAD`, '--', '.', ':(exclude).relay']).stdout,
      diff: truncatedDiff(wt, mb, 'HEAD'),
    });
    fs.writeFileSync(path.join(wt, '.relay', 'review-request.md'), request);

    const others = this.team.reviewers.filter((r) => r.name !== implementer);
    const selfs = this.team.reviewers.filter((r) => r.name === implementer);
    const timeoutMs = this.settings.reviewTimeoutMin * 60_000;
    for (const rv of [...others, ...selfs]) {
      if (this.failedReviewers.has(rv.name)) continue;
      if (this.stopRequested) return false;
      const st = this.step('review', `第 ${round} 轮 · ${rv.label}${rv.model ? `（${rv.model}）` : ''} 审查${rv.name === implementer ? '（自查）' : ''}`, rv.name, true);
      this.phase(`第 ${round} 轮：${rv.label} 正在审查…`);
      let text = '';
      try {
        if (rv.kind === 'harness') {
          const spec = findHarness(rv.harness);
          const loc = spec ? locateCached(spec) : null;
          if (!spec || !loc) throw new Error('找不到这个工具了');
          const inv = spec.invoke(loc, {
            cwd: wt,
            prompt: REVIEW_PROMPT,
            level: this.settings.level,
            readOnly: true,
            model: rv.agent.model?.trim() || undefined,
            effort: rv.agent.effort,
            outFile: tmpOut(),
          });
          const h = startRun({ invocation: inv, cwd: wt, timeoutMs, logPath: st.log!, title: st.label, onLine: this.hooks.onLine });
          this.track(st, h);
          const r = await h.done;
          this.current = null;
          if (r.stopped) {
            this.end(st, 'fail', '被叫停');
            return false;
          }
          text = r.finalText;
          if (!text) throw new Error(r.error ?? (r.timedOut ? '超时' : `没有给出结论（退出码 ${r.code}）`));
        } else {
          const log = this.logTo(st);
          log(`# ${st.label}（${rv.agent.api?.baseUrl} · ${rv.agent.api?.model}）`);
          text = await chat(
            rv.agent.api!,
            [
              { role: 'system', content: '你是严格但务实的代码审查员。只输出要求的 JSON 对象。' },
              { role: 'user', content: request },
            ],
            { timeoutMs, temperature: 0.1 }
          );
          log(`回答：${clip(text, 2000)}`);
        }
      } catch (e) {
        this.failedReviewers.add(rv.name);
        this.end(st, 'fail', errorMessage(e));
        continue;
      }
      let v: Verdict | null = parseVerdict(text);
      if (!v) {
        this.failedReviewers.add(rv.name);
        this.end(st, 'fail', `看不懂它的结论：${clip(text, 200)}`);
        continue;
      }
      if (v.verdict === 'pass' && gate?.status === 'fail') {
        v = { verdict: 'fix', summary: `${v.summary}（但检查命令没通过，不能算通过）`, issues: [`检查命令 \`${gate.command}\` 没通过，修到通过为止：${clip(gate.detail ?? '', 400)}`, ...v.issues] };
      }
      if (v.verdict === 'pass' && hits.length) {
        v = { verdict: 'fix', summary: `${v.summary}（但改到了不许改的文件）`, issues: [`把这些不许改的文件改回去：${hits.join('、')}`, ...v.issues] };
      }
      appendEvent(wt, {
        ts: nowIso(),
        type: 'review',
        agent: rv.name,
        ...(rv.model ? { llm: rv.model } : {}),
        verdict: v.verdict,
        summary: v.summary,
        issues: v.issues,
        checkpoint: hand.checkpoint,
        round,
        implementer,
      });
      this.end(st, 'ok', v.verdict === 'pass' ? `通过：${v.summary}` : `要修改（${v.issues.length} 条）：${v.summary}`);
      return true;
    }
    return false;
  }

  // ---- 合回 ----

  private async doMerge(): Promise<AutoState | null> {
    if (!this.settings.autoMerge) return this.finish('ready', '审查通过了。设置里关了自动合回：看过改动后，点「合回正式文件夹」。');
    const st = this.step('merge', '审查通过，合回正式文件夹');
    this.phase('审查通过，正在合回正式文件夹…');
    try {
      const r = merge(this.root, {});
      if (r.commit) this.state.mergedCommit = r.commit;
      this.end(st, 'ok', r.commit ? `正式文件夹新提交 ${shortSha(r.commit)}（${r.files.length} 个文件）` : '没有改动');
      return this.finish('done', r.commit ? `完成：已合回正式文件夹（提交 ${shortSha(r.commit)}，${r.files.length} 个文件）。` : '完成：没有需要合回的改动。');
    } catch (e) {
      this.end(st, 'fail', errorMessage(e));
      const code = e instanceof RelayError ? e.code : '';
      if (code === 'merge-conflict' && this.syncTries < 2) {
        this.syncTries++;
        const s2 = this.step('sync', '正式文件夹有了新提交：先同步进任务');
        try {
          const r = syncMain(this.root);
          this.end(s2, 'ok', r.status === 'conflict' ? `有冲突：${r.conflicts.join('、')}，派人解决` : '同步好了');
          return null;
        } catch (e2) {
          this.end(s2, 'fail', errorMessage(e2));
        }
      }
      return this.finish('needs-human', `合回没成功：${errorMessage(e)}`);
    }
  }
}

/**
 * 开始（或接着跑）全自动。准备工作（开始任务、挑人）同步做完，出错直接抛；
 * 真正的流水线在后台跑，done 在结束时兑现。
 */
export function startAuto(dir: string, opts: AutoOptions = {}, hooks: AutoHooks = {}): { state: AutoState; done: Promise<AutoState> } {
  const base = loadAutoSettings();
  const settings = normalizeAutoSettings({
    ...base,
    ...(opts.workers?.length ? { workers: opts.workers } : {}),
    ...(opts.reviewers?.length ? { reviewers: opts.reviewers } : {}),
    ...(opts.maxRounds !== undefined ? { maxRounds: opts.maxRounds } : {}),
    ...(opts.autoMerge !== undefined ? { autoMerge: opts.autoMerge } : {}),
    ...(opts.level ? { level: opts.level } : {}),
    ...(opts.workTimeoutMin !== undefined ? { workTimeoutMin: opts.workTimeoutMin } : {}),
    ...(opts.reviewTimeoutMin !== undefined ? { reviewTimeoutMin: opts.reviewTimeoutMin } : {}),
  });

  const info = inspectProject(dir);
  const rootGuess = info.isGit ? info.root : path.resolve(dir);
  const prev = loadAutoState(rootGuess);
  if (runners.has(path.resolve(rootGuess)) || prev?.status === 'running') {
    throw new RelayError('这个项目的全自动已经在跑了。', 'auto-running');
  }
  killLeftovers(prev);

  const members = listMembers(settings.level, loadDetected());
  const team = resolveTeam(members, settings);
  if (!team.workers.length) {
    throw new RelayError(
      `没有能全自动干活的工人。${team.problems.join('')}先在「设置 → 自动识别」里识别一下这台电脑上的 AI 工具（要登录好）。`,
      'no-workers'
    );
  }
  if (!team.reviewers.length) throw new RelayError(`没有能审查的工人。${team.problems.join('')}`, 'no-reviewers');

  const goal = opts.goal?.trim() ?? '';
  const session = info.isGit ? loadSession(info.root) : null;
  let created: { title: string; notes: string[] } | null = null;
  let root = rootGuess;
  if (session) {
    if (goal) throw new RelayError(`这个项目已经有一个进行中的任务（${session.taskTitle}）。不写目标直接「继续全自动」，或者先合回 / 放弃它。`, 'has-task');
  } else {
    if (!goal) throw new RelayError('先写下要做什么。', 'no-title');
    const r = startTask(dir, { task: goal, acceptance: opts.acceptance });
    root = r.root;
    created = { title: r.title, notes: r.notes };
  }
  if (runners.has(path.resolve(root))) throw new RelayError('这个项目的全自动已经在跑了。', 'auto-running');

  const runner = new AutoRunner(root, settings, team, hooks, created?.title ?? session?.taskTitle ?? goal);
  if (created) {
    const st = runner.step('start', '开始任务：建隔离副本');
    st.status = 'ok';
    st.endedAt = st.startedAt;
    st.detail = created.notes.join(' ') || undefined;
  }
  runners.set(path.resolve(root), runner);
  const done = runner.run().finally(() => runners.delete(path.resolve(root)));
  return { state: runner.state, done };
}

export function runAuto(dir: string, opts: AutoOptions = {}, hooks: AutoHooks = {}): Promise<AutoState> {
  return startAuto(dir, opts, hooks).done;
}
