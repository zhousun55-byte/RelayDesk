import { spawnSync } from 'node:child_process';
import { skillNote } from '../core/skills';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptance } from '../core/acceptance';
import { loadAutoSettings, normalizeAutoSettings, type AutoSettings, langNote } from '../core/auto-settings';
import { errorMessage, RelayError } from '../core/errors';
import { refreshHarnessModel } from '../core/detect';
import { cliTooOld, explainFailure, findHarness, locateCached, modelArg, noteModelNeeds, type Invocation } from '../core/harness';
import { countedReviews, KIND_WORD, loadLedger, nextStintId, pendingReviews, requireInit, saveStint, statusWord, stintTitle, taskChanges, taskMode, tierWord, verdictWord, type LedgerView, type Stint, type Who } from '../core/ledger';
import { runLlmAgent } from '../core/llm-agent';
import { killTree, pidAlive } from '../core/proc';
import { allMembers, orderMembers, readyMembers, spareFirst, type MemberInfo } from '../core/members';
import { llmName, whoName } from '../core/names';
import { BRIEF_REL, editTask, fileStamp, HANDOFF_DIR, handoffFileFor, listHandoffFiles, parseReview, readHandoff, readReview, readTask, REVIEW_DIR, reviewFileFor, saveTaskCopy, TASK_REL, taskComplete, taskProgress, type HandoffDoc, type TaskDoc } from '../core/notes';
import { finalPrompt, planPrompt, reviewPrompt, sideReviewPrompt, splitSideReview, stepPrompt, workPrompt } from '../core/prompts';
import { sessionFile, sessionToolOf } from '../core/sessions';
import { blockMember, detectQuota, failureKind, fullUntil, markOk, markQuota, noteError, noteLimits, noteLiveLimits, recentErrors, untilText, type Limit } from '../core/quota';
import { clip, lastError, logTail, looksLikeNetworkBlip, startRun, toolLines, usageTotal, type RunHandle, type RunResult } from '../core/runner';
import { cause, plain } from '../core/cause';
import { copyChanges, snapChanges, takeSnapshot } from '../core/snap';
import type { RelayConfig } from '../core/types';
import { memberTier, sameModel, whoOfMember } from '../core/tier';
import { acquireLock, runsDir } from './lock';
import { applyFiles, cloneProject, dropClone, isParallel, stepOf, type Step } from './parallel';
import { applyReviews, closeStint, gateStint, projectConfig, projectConfigSafe, refreshBrief, track } from './track';

/**
 * 接力台调度：替你让某个 AI 接着做一棒；或者「全自动」一直接力下去——
 * 额度用完换下一位，有待复核就先派强模型复核，任务清单全部打勾后请强模型终审，都没额度了就等。
 * 派活（任务是在「派活」页写的）：强模型先把任务拆成小步，干活只派弱模型、一棒一步。中途不停下来复核：
 * 「边做边复核」打开时，弱模型做下一步的同时，指挥的强模型只看不改地复核做完的那几步（结论接力台代写，
 * 有问题就在清单里插一步去改），不占干活的时间；关掉时和以前一样，清单做完后终审的强模型一起复核。
 * 弱模型都用不了时不换强模型干活，等额度或停下；只有某一步弱模型确实做不下去（卡住了、连着两棒没推进），
 * 才请指挥的强模型做这一步，做完接着交给弱模型（「卡住的那一步交给指挥」，默认开）。
 * 一棒一棒都记在账本里，所以随时能停、能接着跑。
 */


export type GoStatus = 'running' | 'waiting' | 'done' | 'stopped' | 'needs-human' | 'failed';

export interface GoState {
  id: string;
  root: string;
  pid: number;
  /** once = 只跑一棒；auto = 全自动。 */
  mode: 'once' | 'auto';
  status: GoStatus;
  /** 现在在干什么（给人看）。 */
  phase: string;
  current?: { stint: number; member: string; label: string; kind: Stint['kind']; since: string; log: string; toolPid?: number; toolExe?: string };
  /** 派活时边做边复核：谁在复核哪几棒（和 current 同时在跑，只看不改）。 */
  side?: { member: string; label: string; targets: number[]; since: string; log: string };
  /** 在等谁的额度恢复。 */
  waitingUntil?: string;
  /** 这次跑过的棒。 */
  stints: number[];
  startedAt: string;
  updatedAt: string;
  result?: string;
  level: AutoSettings['level'];
  /** 这次是派活（强模型拆、弱模型做）。 */
  dispatch?: boolean;
  /** 上次跑到一半接力台被关了。 */
  interrupted?: boolean;
}

export interface GoOptions {
  mode: 'once' | 'auto';
  /** 只跑一棒时：指定谁（不指定就按顺序挑第一个能用的）。 */
  who?: string;
  /** 只跑一棒时：做复核（复核所有待复核的棒）。 */
  kind?: 'work' | 'review';
  settings?: Partial<AutoSettings>;
  /** 派活：强模型拆、弱模型做。不写就看当前任务是在哪一页写的。 */
  dispatch?: boolean;
  /** 你确认过：在别的工具里干到一半的那一位已经停下了（额度用完、关掉了），可以换人。 */
  force?: boolean;
}

export interface GoHooks {
  onUpdate?: (s: GoState) => void;
  onLine?: (line: string) => void;
}

/** 挑人时要强的、弱的，还是都行。 */
type Tier = 'strong' | 'weak' | 'any';

/** 给人看的名字：它用的模型（GPT-6 Sol），认不出模型写工具名。 */
const nameOf = (m: MemberInfo) => llmName(m.model) || m.label;

export function goStatePath(root: string): string {
  return path.join(runsDir(root), 'state.json');
}

function stopFlag(root: string): string {
  return path.join(runsDir(root), 'stop');
}

/** 同一个项目换个写法（带链接、大小写不同）也要认成同一个。 */
function canonRoot(root: string): string {
  const abs = path.resolve(root);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    return abs;
  }
}


// ---- 你自己在别的工具里干到一半的那一棒 ----

/** 多久没动静算它停了（换人前不用再问你）。 */
export function nativeQuietMs(): number {
  const v = Number(process.env.RELAY_NATIVE_QUIET_MS);
  return Number.isFinite(v) && v >= 0 ? v : 3 * 60_000;
}

/** 有没有「你自己在别的工具里干、还在改文件」的一棒：有就返回它和多久前还在改。 */
export function nativeActive(v: LedgerView, now = Date.now()): { stint: Stint; idleMs: number } | null {
  const o = v.open;
  if (!o || o.via !== 'native') return null;
  const idleMs = Math.max(0, now - Date.parse(o.activeAt ?? o.startedAt));
  return idleMs < nativeQuietMs() ? { stint: o, idleMs } : null;
}

function agoText(ms: number): string {
  const min = Math.floor(ms / 60_000);
  return min < 1 ? '不到一分钟前' : `${min} 分钟前`;
}

function nativeActiveError(a: { stint: Stint; idleMs: number }): RelayError {
  return new RelayError(`第 ${a.stint.id} 棒（${whoName(a.stint.who)}）${agoText(a.idleMs)}还在改这个文件夹；现在换人，两边会同时改文件`, 'native-active');
}

export function loadGoState(root: string): GoState | null {
  try {
    const s = JSON.parse(fs.readFileSync(goStatePath(root), 'utf8')) as GoState;
    if (!s || typeof s.id !== 'string') return null;
    if ((s.status === 'running' || s.status === 'waiting') && !pidAlive(s.pid)) {
      return { ...s, status: 'stopped', interrupted: true, phase: '上次跑到一半，接力台被关掉了。' };
    }
    return s;
  } catch {
    return null;
  }
}

/** 这一棒的日志末尾（网页看实时进度）。 */
export function goLogTail(root: string, s: GoState | null, maxLines = 60): string {
  const log = s?.current?.log;
  if (!log) return '';
  try {
    const text = fs.readFileSync(path.join(root, log), 'utf8');
    return text.split('\n').slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

const runners = new Map<string, GoRunner>();
/** 每个调度收完尾（这一棒记好账）时兑现。 */
const finishing = new Map<string, Promise<unknown>>();

/** 这个接力台进程里有没有调度在跑（或者在收尾）。 */
export function goBusy(): boolean {
  return runners.size > 0 || finishing.size > 0;
}

export function goActive(root: string): boolean {
  if (runners.has(canonRoot(root))) return true;
  const s = loadGoState(root);
  return !!s && (s.status === 'running' || s.status === 'waiting');
}

export function stopGo(root: string): boolean {
  const r = runners.get(canonRoot(root));
  if (r) {
    r.stop();
    return true;
  }
  const s = loadGoState(root);
  if (s && (s.status === 'running' || s.status === 'waiting') && pidAlive(s.pid)) {
    fs.mkdirSync(runsDir(root), { recursive: true });
    fs.writeFileSync(stopFlag(root), String(Date.now()));
    return true;
  }
  return false;
}

/** 叫停这个项目的调度，等它把正在跑的工具结束、这一棒记好账（最多等 timeoutMs）。删除正在做的任务时用。 */
export async function stopGoAndWait(root: string, timeoutMs = 20_000): Promise<void> {
  if (!stopGo(root)) return;
  const end = Date.now() + timeoutMs;
  const mine = finishing.get(canonRoot(root));
  if (mine) await Promise.race([mine.catch(() => undefined), new Promise((res) => setTimeout(res, timeoutMs))]);
  // 别的进程里的调度（命令行起的）：看它的状态，停下来为止
  while (goActive(root) && Date.now() < end) await new Promise((res) => setTimeout(res, 300));
  // 状态写成停了之后，它还要过一会儿才放掉调度锁（GitHub 上 Linux 偶尔就差这一下，删的时候报「全自动还在跑」）
  while (Date.now() < end) {
    try {
      acquireLock(root)();
      return;
    } catch {
      await new Promise((res) => setTimeout(res, 200));
    }
  }
}

/**
 * 叫停所有调度，等它们把正在跑的工具结束、把这一棒记好账（最多等 timeoutMs）。
 * 接力台要退出时用：不等的话，工具会在接力台退出之后接着改文件，没人记账。
 */
export async function stopAllGo(timeoutMs = 10_000): Promise<void> {
  for (const r of runners.values()) r.stop();
  const all = [...finishing.values()];
  if (!all.length) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([Promise.allSettled(all), new Promise<void>((res) => (timer = setTimeout(res, timeoutMs)))]);
  if (timer) clearTimeout(timer);
}

/**
 * 工具那一组里还活着的进程（工具是 detached 起的，自成一组，组号就是它的进程号）。
 * 只看组长不够：Codex 记下的是外层的 node 启动器，干活的是它起的子进程，启动器没了子进程还在接着改文件（2026-09-28 实测）。
 * 组里得有这个工具的命令（完整路径，或者可执行文件同名），防止组号被别的程序重用。
 */
function toolGroup(pgid: number, exe: string | undefined): number[] {
  if (!exe) return [];
  if (process.platform === 'win32') return winToolAlive(pgid, exe) ? [pgid] : [];
  const r = spawnSync('ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  const group = (r.stdout ?? '').split('\n').flatMap((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return m && Number(m[2]) === pgid ? [{ pid: Number(m[1]), cmd: m[3] }] : [];
  });
  const name = `/${path.basename(exe)}`;
  return group.some((x) => x.cmd.includes(exe) || (x.cmd.split(/\s+/)[0] ?? '').endsWith(name)) ? group.map((x) => x.pid) : [];
}

/** Windows 没有进程组：看这个进程号现在的命令行里有没有这个工具的名字（npm 装的工具是 node 在跑它的 .js，名字在路径里）。 */
function winToolAlive(pid: number, exe: string): boolean {
  if (!pidAlive(pid)) return false;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  const name = path.basename(exe).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  return !!name && (r.stdout ?? '').toLowerCase().includes(name);
}

/** 上次接力台被关掉时留下、还在跑的工具（连同它起的子进程）：结束掉（不然两个 AI 同时改一个文件夹）。返回结束了没有。 */
function killLeftover(prev: GoState | null): boolean {
  const pid = prev?.current?.toolPid;
  if (!pid || !prev || pidAlive(prev.pid)) return false;
  const group = toolGroup(pid, prev.current?.toolExe);
  if (!group.length) return false;
  if (process.platform === 'win32') {
    killTree(pid, 'SIGKILL');
    return true;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    for (const p of group) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        /* 已经结束 */
      }
    }
  }
  return true;
}

/** 接力台启动时：上次被关掉时还在跑的工具，结束掉。返回结束了没有。 */
export function reapLeftover(root: string): boolean {
  return killLeftover(loadGoState(root));
}

function nowIso(): string {
  return new Date().toISOString();
}

function tmpOut(): string {
  return path.join(os.tmpdir(), `relay-out-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.txt`);
}

/** 清单里下一步还没做的。 */
function nextStep(task: TaskDoc): Step | undefined {
  const i = task.items.findIndex((x) => !x.done);
  return i < 0 ? undefined : stepOf(task, i);
}

/** 这个任务是什么时候写下的（没有就是接入的时候）。 */
function taskSince(v: LedgerView): number {
  return Date.parse(taskChanges(v.events).at(-1)?.ts ?? v.init?.ts ?? '');
}

/** 这个任务派活时拆过没有：任务写下之后有一棒拆解交接了。 */
function planned(v: LedgerView): boolean {
  const since = taskSince(v);
  return v.stints.some((s) => s.kind === 'plan' && s.status === 'handed' && !s.rolledBack && !(Date.parse(s.startedAt) < since));
}

interface StintOutcome {
  stint: Stint;
  /** 同时做几步时，这一份和先并回去的改了同一个文件、没有并回项目（不算这位做不下去）。 */
  clash?: boolean;
  /** 这一棒改了文件没有。 */
  changed: boolean;
  handoff: HandoffDoc | null;
  finalText: string;
  error?: string;
}

/** 边做边复核跑完的结果（等两棒之间的空档再记账）。 */
interface SideOutcome {
  finalText: string;
  error?: string;
  stopped: boolean;
  model?: string;
  tokens?: Stint['tokens'];
  session?: Stint['session'];
  limits?: Limit[];
  quotaText: string;
  /** 没成时工具自己说的话（不含 AI 说的话）。 */
  toolSaid?: string;
}

interface SideJob {
  member: MemberInfo;
  targets: Stint[];
  startedAt: string;
  log: string;
  done: Promise<SideOutcome>;
  result?: SideOutcome;
}

/** 边做边复核查出问题后插进清单的那一步的开头。 */
const FIX_STEP = '按复核改好';

/** 同时做几步时：一步做了这么久、又有更快的人闲着，才请他也做一份。 */
const HELP_AFTER_MS = Number(process.env.RELAY_HELP_AFTER_MS ?? 60_000);
/** 多久看一眼该不该帮。 */
const HELP_CHECK_MS = Number(process.env.RELAY_HELP_CHECK_MS ?? 15_000);

/** 看起来是临时的出错：连不上、超时、一直没回音、服务器忙。同一位原地再来一次多半就好了。 */
const TRANSIENT = /连不上|超时|没有回音|网络|HTTP (?:429|5\d\d)|timed? ?out|ECONNRESET|ETIMEDOUT|socket hang up|overloaded|rate limit/i;

/** 单独叫停一位（同时做几步时，同一步别人先做完了）。 */
interface Cancel {
  requested: boolean;
  stop?: () => void;
}

/** 跑一次的结果（execute 返回，closeRun 用）。 */
interface RunMid {
  finalText: string;
  error?: string;
  stopped: boolean;
  quotaText: string;
  toolSaid: string;
  actualModel?: string;
  limits?: Limit[];
  session?: Stint['session'];
}

/** 一棒跑完时手上的东西（closeRun 用）。 */
interface RunEnd {
  cfg: RelayConfig;
  from: string;
  id: number;
  handoff: string;
  handoffsBefore: Set<string>;
  logAbs: string;
  stint: Stint;
  who: Who;
  m: MemberInfo;
  kind: Stint['kind'];
  targets: Stint[];
  reviewFile?: string;
  log: (line: string) => void;
  finalText: string;
  error?: string;
  stopped: boolean;
  quotaText: string;
  toolSaid: string;
  actualModel?: string;
  limits?: Limit[];
  session?: Stint['session'];
  /** 工具在哪个文件夹里干的活（从它自己记的会话里读用量用）。 */
  usageDir: string;
  /** 真正做完的时间（同时做几步时，并回项目要晚一些）。 */
  endedAt?: Date;
  /** 叫停时写在这一棒上的原因（同一步别人先做完了）。 */
  note?: string;
}

class GoRunner {
  readonly state: GoState;
  private stopRequested = false;
  private current: RunHandle | null = null;
  /** 正在跑的工具（同时做几步时有几个）：叫停时都结束。 */
  private readonly handles = new Set<RunHandle>();
  /** 这次出过错的人（不再派给他）。 */
  private readonly failed = new Set<string>();
  /** 干活连着出错几次（做成一棒就清零）：临时的错先原地再派一次，连着两次才换人。 */
  private readonly strikes = new Map<string, number>();
  /** 换人的原因：写进下一棒日志的开头。 */
  private handover = '';
  /** 上一棒临时出错、下一棒点名再派的那位。 */
  private retryNext: string | null = null;
  /** 派活：每一步（按原话）弱模型没做下去的次数；谁卡在哪一步上（那一步做成了，它就能接着干后面的）。 */
  private readonly stepFails = new Map<string, number>();
  private readonly stuckOn = new Map<string, string>();
  /** 派活时正在边做边复核的那一件（同时只有一件）。 */
  private side: SideJob | null = null;
  private sideHandle: RunHandle | null = null;
  /** 边做边复核过的棒（不论结论，不再边做边复核第二次；没过的留给终审）。 */
  private readonly sideSeen = new Set<number>();
  /** 复核没写结论的次数（按被复核的棒）。 */
  private readonly reviewTries = new Map<number, number>();
  /** 这次终审实际跑成了弱模型的人（不再请他终审）。 */
  private readonly weakFinals = new Set<string>();
  /** 收工前补跑检查的次数。 */
  private gateRuns = 0;
  /** 这次是不是派活（开始时定下，跑到一半换了任务也不变）。 */
  private readonly dispatch: boolean;
  /** 派活：最后一批待复核的已经并进过一次终审（没复核上的再单独复核）。 */
  private merged = false;
  /** 项目副本建不起来：这次不再同时做几步。 */
  private noBatch = false;

  constructor(
    private readonly root: string,
    private readonly settings: AutoSettings,
    private readonly opts: GoOptions,
    private readonly hooks: GoHooks
  ) {
    const t = nowIso();
    this.dispatch = opts.dispatch ?? taskMode(loadLedger(root)) === 'dispatch';
    this.state = {
      id: `${t.replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomBytes(2).toString('hex')}`,
      root,
      pid: process.pid,
      mode: opts.mode,
      status: 'running',
      phase: '准备中…',
      stints: [],
      startedAt: t,
      updatedAt: t,
      level: settings.level,
      ...(this.dispatch ? { dispatch: true } : {}),
    };
    fs.rmSync(stopFlag(root), { force: true });
    this.save();
  }

  stop(): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.state.phase = '正在停止…';
    this.save();
    this.current?.stop();
    for (const h of this.handles) h.stop();
    this.sideHandle?.stop();
  }

  private save(): void {
    this.state.updatedAt = nowIso();
    try {
      fs.mkdirSync(runsDir(this.root), { recursive: true });
      const p = goStatePath(this.root);
      fs.writeFileSync(`${p}.tmp`, JSON.stringify(this.state, null, 2) + '\n');
      fs.renameSync(`${p}.tmp`, p);
    } catch {
      /* 写不了不影响干活 */
    }
    this.hooks.onUpdate?.(this.state);
  }

  private phase(text: string): void {
    this.state.phase = text;
    this.save();
  }

  private finish(status: GoStatus, text: string): GoState {
    this.state.status = status;
    this.state.result = text;
    this.state.phase = text;
    delete this.state.current;
    delete this.state.side;
    delete this.state.waitingUntil;
    this.save();
    try {
      refreshBrief(this.root);
    } catch {
      /* 不影响结果 */
    }
    return this.state;
  }

  private logger(logAbs: string): (line: string) => void {
    return (line: string) => {
      const d = new Date();
      const p = (x: number) => String(x).padStart(2, '0');
      const full = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${line}`;
      try {
        fs.mkdirSync(path.dirname(logAbs), { recursive: true });
        fs.appendFileSync(logAbs, full + '\n');
      } catch {
        /* 日志写不了不影响干活 */
      }
      this.hooks.onLine?.(full);
    };
  }

  /**
   * 跑一次编程工具（还没改文件时才原地再试）：
   * - 命令行太旧、用不了这个模型：记下来，换成它用得了的马上再试（升级之后自动换回来）；
   * - 像是网络抖了一下：等几秒再试一次。
   */
  private async runTool(logAbs: string, title: string, invoke: () => Invocation, timeoutMs: number, mayRetry: () => boolean, harness?: string, cwd = this.root, onHandle?: (h: RunHandle) => void): Promise<RunResult> {
    let blips = 0;
    for (let attempt = 0; ; attempt++) {
      const inv = invoke();
      const h = startRun({ invocation: inv, cwd, timeoutMs, logPath: logAbs, title, onLine: this.hooks.onLine });
      this.current = h;
      this.handles.add(h);
      onHandle?.(h);
      if (h.pid && this.state.current) {
        this.state.current.toolPid = h.pid;
        this.state.current.toolExe = inv.argv[0];
        this.save();
      }
      const r = await h.done;
      this.handles.delete(h);
      if (this.current === h) this.current = null;
      // 没等到回复（额度用完）时只有开头报的简写（claude-opus-5）：用调用时给的完整名字（claude-opus-5-5）。
      const asked = modelArg(inv.argv);
      if (r.model && asked?.startsWith(`${r.model}-`)) r.model = asked;
      if (attempt > 3 || r.stopped || r.timedOut || r.code === 0 || this.stopRequested || !mayRetry()) return r;
      const text = `${r.error ?? ''}\n${r.stderrTail}\n${r.finalText}\n${toolLines(logTail(logAbs))}`;
      const needs = cliTooOld(text);
      const used = modelArg(inv.argv);
      if (needs && used) {
        noteModelNeeds(used, needs);
        if (harness) refreshHarnessModel(harness);
        const next = modelArg(invoke().argv);
        if (!next || next === used) return r;
        this.logger(logAbs)(`这个版本的命令行用不了 ${used}（要 ${needs} 或更新）：先换成 ${next} 再试；升级命令行之后会自动换回来。`);
        continue;
      }
      if (blips > 0 || detectQuota(text).hit || !looksLikeNetworkBlip(text)) return r;
      blips++;
      const waitMs = Number(process.env.RELAY_RETRY_MS ?? 5000);
      this.logger(logAbs)(`看起来是网络抖了一下，${Math.max(1, Math.round(waitMs / 1000))} 秒后原地再试一次。`);
      await this.sleep(waitMs);
      if (this.stopRequested) return r;
    }
  }

  private async sleep(ms: number): Promise<void> {
    for (let t = 0; t < ms && !this.stopRequested; t += 250) {
      if (fs.existsSync(stopFlag(this.root))) {
        fs.rmSync(stopFlag(this.root), { force: true });
        this.stop();
        return;
      }
      await new Promise((res) => setTimeout(res, Math.min(250, ms - t)));
    }
  }

  /**
   * 先把文件夹里的事对上账：有人（你自己在别的工具里）改到一半、账上还开着的那一棒，算它一棒，结束掉。
   * 它刚才还在改文件：没你确认它停了，就不换人（换了就是两个 AI 同时改一个文件夹）。
   * 全自动每一轮先做这一步再算待复核：不然这一棒要等下一棒开工才结账，复核名单里没有它，又得单独派一次强模型复核。
   * taker：接手的那一位（全自动算名单时还不知道是谁，写「全自动」）。
   */
  private settleNative(taker?: MemberInfo): LedgerView {
    const root = this.root;
    track(root);
    const v = loadLedger(root);
    if (!v.open || v.open.via !== 'native') return v;
    const active = nativeActive(v);
    if (active && !this.opts.force) throw nativeActiveError(active);
    const h = v.open.handoff ? readHandoff(root, v.open.handoff) : null;
    const idle = Math.round((Date.now() - Date.parse(v.open.activeAt ?? v.open.startedAt)) / 60_000);
    const who = taker ? nameOf(taker) : '全自动';
    const note = active ? `${who} 接手时这一棒没交接，已确认它停下` : `${who} 接手时这一棒没交接：${idle} 分钟没改文件，账面上结束`;
    closeStint(root, { ...v.open, ...(active ? { stopConfirmed: true } : {}) }, { status: h ? 'handed' : 'unfinished', to: takeSnapshot(root, '换人接手').sha, handoff: h, note }, projectConfig(root));
    return loadLedger(root);
  }

  /** 让一位成员跑一棒（干活 / 复核 / 终审 / 拆解）。step：派活时这一棒只做清单里的哪一步。 */
  async runStint(m: MemberInfo, kind: Stint['kind'], targets: Stint[] = [], step?: Step): Promise<StintOutcome> {
    const root = this.root;
    const cfg = projectConfig(root);
    const v = this.settleNative(m);
    const from = takeSnapshot(root, `第 ${nextStintId(v)} 棒开始前`).sha;
    const id = nextStintId(v);
    const handoff = handoffFileFor(root, id, m.harness ?? m.name);
    const logRel = `.relay/runs/第${id}棒-${fileStamp()}-${m.name}.log`;
    const logAbs = path.join(root, logRel);
    const who = whoOfMember(m);
    // 终审的结论写在哪（收工时按它判断终审过没过）。
    const reviewFile = kind === 'final' ? `${REVIEW_DIR}/终审-第${id}棒-${fileStamp()}.md` : undefined;
    const taskBefore = saveTaskCopy(root);
    const stint: Stint = {
      id,
      kind,
      who,
      via: 'relay',
      startedAt: nowIso(),
      activeAt: nowIso(),
      from,
      status: 'working',
      review: kind === 'work' ? 'needed' : 'skip',
      handoff,
      log: logRel,
      pid: process.pid,
      ...(targets.length ? { targets: targets.map((t) => t.id) } : {}),
      ...(step ? { step } : {}),
      ...(reviewFile ? { reviewFile } : {}),
      ...(taskBefore ? { taskBefore } : {}),
    };
    saveStint(root, stint);
    refreshBrief(root);
    const handoffsBefore = new Set(listHandoffFiles(root).map((f) => f.rel));
    const what = KIND_WORD[kind];
    this.state.current = { stint: id, member: m.name, label: who.label, kind, since: stint.startedAt, log: logRel };
    this.state.stints.push(id);
    this.phase(`第 ${id} 棒（${whoName(who)}）正在${what}`);
    const log = this.logger(logAbs);
    log(`# ${stintTitle(stint)}${targets.length ? `：第 ${targets.map((t) => t.id).join('、')} 棒` : ''}${step ? `：清单第 ${step.index} 步` : ''}`);
    if (this.handover) {
      log(this.handover);
      this.handover = '';
    }

    const gate = cfg.gate.command.trim();
    let prompt: string;
    if (kind === 'review') {
      prompt = reviewPrompt({ id, label: who.label, handoff, gateCommand: gate, targets: targets.map((t) => ({ id: t.id, label: t.who.label, tierWord: tierWord(t.who.tier) })) });
    } else if (kind === 'final') {
      const base = v.task?.snap ?? v.init?.snap ?? from;
      prompt = finalPrompt({
        id,
        label: who.label,
        handoff,
        gateCommand: gate,
        from: base,
        to: from,
        reviewFile: reviewFile!,
        targets: targets.map((t) => t.id),
      });
    } else if (kind === 'plan') {
      prompt = planPrompt({ id, label: who.label, handoff, gateCommand: gate });
    } else if (step) {
      prompt = stepPrompt({ id, label: who.label, handoff, gateCommand: gate, step });
    } else {
      prompt = workPrompt({ id, label: who.label, handoff, gateCommand: gate });
    }
    prompt += langNote(this.settings.lang);
    // 任务里写了 /技能名：附上这个技能的做法（派给谁都照着做）
    try {
      prompt += skillNote(root, fs.readFileSync(path.join(root, TASK_REL), 'utf8'));
    } catch {
      /* 还没有任务文件 */
    }
    const timeoutMs = (kind === 'work' ? this.settings.stintTimeoutMin : this.settings.reviewTimeoutMin) * 60_000;

    const ex = await this.execute({ m, kind, prompt, cwd: root, logAbs, title: stintTitle(stint), timeoutMs, unchanged: () => takeSnapshot(root, '看看改了没有').sha === from, resume: this.resumeFor(m, id), startedAt: stint.startedAt, log, cfg });
    return this.closeRun({ cfg, from, id, handoff, handoffsBefore, logAbs, stint, who, m, kind, targets, reviewFile, log, ...ex, usageDir: root });
  }

  /** 让一位成员在 cwd 里跑一次（编程工具或接口小代理），返回它说的话、出的错、用的模型。 */
  private async execute(x: { m: MemberInfo; kind: Stint['kind']; prompt: string; cwd: string; logAbs: string; title: string; timeoutMs: number; unchanged: () => boolean; resume?: string; startedAt: string; log: (line: string) => void; cfg: RelayConfig; cancel?: Cancel }): Promise<RunMid> {
    const { m, log } = x;
    let finalText = '';
    let error: string | undefined;
    let stopped = false;
    let quotaText = '';
    /** 没成时工具自己说的话（出错信息、标准错误、日志里的出错行），不含 AI 说的话：认「模型用不了」「没登录」用。 */
    let toolSaid = '';
    /** 工具自己报出来的实际模型（比如 --model opus 实际是 claude-opus-5-5）。 */
    let actualModel: string | undefined;
    /** 工具自己报的额度窗口：Claude Code 在输出里报，Codex 记在它自己的会话里。 */
    let limits: Limit[] | undefined;
    /** 这一棒在工具里的对话。 */
    let session: Stint['session'];
    try {
      if (m.kind === 'harness') {
        const spec = findHarness(m.harness);
        const loc = spec ? locateCached(spec) : null;
        if (!spec || !loc) throw new RelayError('找不到这个工具了。', 'no-tool');
        const r = await this.runTool(
          x.logAbs,
          x.title,
          () => spec.invoke(loc, { cwd: x.cwd, prompt: x.prompt, level: this.settings.level, readOnly: false, model: m.agent.model?.trim() || undefined, effort: m.agent.effort, outFile: tmpOut(), resume: x.resume }),
          x.timeoutMs,
          x.unchanged,
          spec.id,
          x.cwd,
          (h) => {
            if (!x.cancel) return;
            x.cancel.stop = () => h.stop();
            if (x.cancel.requested) h.stop();
          }
        );
        finalText = r.finalText;
        stopped = r.stopped;
        actualModel = r.model;
        if (r.session) session = { tool: spec.id, id: r.session };
        limits = r.limits ?? spec.limits?.(x.cwd, Date.parse(x.startedAt)) ?? undefined;
        // 认额度只看工具自己报的话（出错信息、标准错误、日志里的「出错」「提示」）和最后一句话，不看 AI 说的话、搜的词：
        // 任务本身讲限流、额度时，那些话里全是 rate limit、quota。
        const failed = !r.stopped && (!!r.error || r.timedOut || r.code !== 0);
        const own = toolLines(logTail(x.logAbs, 6000));
        quotaText = `${r.error ?? ''}\n${r.stderrTail}\n${own}\n${r.finalText.slice(-2000)}`;
        if (failed) {
          toolSaid = `${r.error ?? ''}\n${r.stderrTail}\n${own}`;
          const hint = explainFailure(m.harness, `${r.error ?? ''}\n${r.stderrTail}\n${r.finalText}`);
          error = r.error ?? (r.timedOut ? (r.late ?? cause.overtime(x.timeoutMs)) : hint ?? cause.exit(r.code, clip(lastError(r.stderrTail, own), 200)));
        }
      } else if (m.kind === 'api' && m.agent.api) {
        log(`（接力台内置小代理：${m.agent.api.baseUrl} · ${m.agent.api.model}）`);
        let brief = '';
        try {
          brief = fs.readFileSync(path.join(x.cwd, BRIEF_REL), 'utf8');
        } catch {
          /* 没有接力本 */
        }
        const r = await runLlmAgent({
          spec: m.agent.api,
          cwd: x.cwd,
          brief: `${x.prompt}\n\n---\n下面是接力本（${BRIEF_REL}）全文：\n\n${brief}`,
          level: this.settings.level,
          gateCommand: x.cfg.gate.command.trim(),
          protectedPaths: x.cfg.protectedPaths,
          log,
          shouldStop: () => this.stopRequested || !!x.cancel?.requested,
          deadline: Date.now() + x.timeoutMs,
          maxSteps: x.kind === 'work' ? 80 : 60,
        });
        finalText = r.finalText;
        stopped = r.stopped;
        error = r.error ? plain(r.error) : r.timedOut ? cause.overtime(x.timeoutMs) : undefined;
        quotaText = `${r.error ?? ''}`;
        toolSaid = r.error ?? '';
        log(`结束（${r.steps} 步${error ? `，${error}` : ''}）`);
      } else {
        throw new RelayError('桌面程序不能派活', 'cannot-drive');
      }
    } catch (e) {
      error = errorMessage(e);
      log(`出错：${error}`);
    }

    return { finalText, error, stopped, quotaText, toolSaid, actualModel, limits, session };
  }

  /** 一棒跑完之后记账：收工的快照、交接、额度、用量、检查、终审结论（一棒一棒地跑和同时做几步共用）。 */
  private async closeRun(c: RunEnd): Promise<StintOutcome> {
    const root = this.root;
    const { cfg, from, id, handoff, handoffsBefore, logAbs, stint, who, m, kind, targets, reviewFile, log, finalText, error, stopped, quotaText, toolSaid, actualModel, limits, session } = c;
    // 结束这一棒。
    const to = takeSnapshot(root, `第 ${id} 棒结束`).sha;
    let h = readHandoff(root, handoff);
    if (!h) {
      // 它把交接写在了别的文件名里。
      const extra = listHandoffFiles(root).find((f) => !handoffsBefore.has(f.rel));
      if (extra) h = readHandoff(root, extra.rel);
    }
    // 出错退出、或者什么都没说就结束了，才去认是不是额度用完（各家额度用完都是这样结束的）。
    // 正常做完、交了话的一棒——哪怕没改文件（复核棒多半只写结论）——不算额度用完。
    const quota = error || !finalText ? detectQuota(quotaText) : { hit: false as const };
    let status: Stint['status'] = 'handed';
    let note: string | undefined;
    let quotaUntil: string | undefined;
    noteLimits(m.name, limits);
    if (stopped || this.stopRequested) {
      status = 'stopped';
      if (c.note) note = c.note;
    } else if (quota.hit) {
      status = 'quota';
      // 恢复时间先看工具报的用满了的窗口（精确到秒），没有再看提示里的话
      const e = markQuota(m.name, { ...quota, until: fullUntil(limits) ?? quota.until });
      quotaUntil = e.until;
      note = `${cause.quota(e.until)}${quota.line ? `，原话：${clip(plain(quota.line), 160)}` : ''}`;
      log(note);
    } else if (error) {
      status = 'failed';
      note = error;
      // 模型用不了、没登录：换个时间再试也一样，先停用这一位（换了模型、重新登录、过一阵再算）
      const kind = failureKind(toolSaid);
      if (kind) log(`先停用这一位：${blockMember(m.name, kind, toolSaid, m.model).note}`);
      else noteError(m.name);
    } else {
      markOk(m.name);
    }
    const ran = actualModel && !(who.model && who.model === actualModel) ? { ...who, model: actualModel, label: `${m.label} · ${actualModel}`, tier: who.model && sameModel(who.model, actualModel) ? who.tier : memberTier(m.agent, actualModel) } : who;
    let logText = '';
    try {
      logText = fs.readFileSync(logAbs, 'utf8');
    } catch {
      /* 没有日志 */
    }
    // 工具自己在输出里报的用量；不报的（DeepSeek Harness）从它自己记的会话里读
    // 从这一棒开始算：上一棒的会话在它结束前最后写入，差几百毫秒，不能往前放宽
    const tokens = usageTotal(logText) ?? findHarness(m.harness)?.usage?.(c.usageDir, Date.parse(stint.startedAt)) ?? null;
    const closed = closeStint(root, { ...stint, who: ran, pid: process.pid, ...(tokens ? { tokens } : {}), ...(session ? { session } : {}) }, { status, to, handoff: h, lastWords: finalText, ...(note ? { note } : {}), ...(quotaUntil ? { quotaUntil } : {}), ...(c.endedAt ? { now: c.endedAt } : {}) }, cfg);
    // 调度拿着锁，这时只有检查命令在跑：它自己写的缓存、报告算接力台的改动，不算到哪一棒头上（不然下一轮会以为有别的 AI 在改文件）。
    if (kind === 'review' || kind === 'final' || closed.facts?.files || closed.factsError) await gateStint(root, id, cfg, { absorb: 'all' }).catch(() => undefined);
    // 终审的结论：收工时要看它（交接成功不等于终审通过）。
    if (kind === 'final' && reviewFile) {
      const r = readReview(root, reviewFile);
      const cur = loadLedger(root).stints.find((x) => x.id === id);
      if (cur) saveStint(root, { ...cur, verdict: r?.verdict ?? 'unknown', ...(r?.verdictText ? { verdictText: r.verdictText } : {}) });
      log(r ? `终审结论：${verdictWord(r.verdict)}${r.verdictText ? `，原话：${clip(r.verdictText, 80)}` : ''}` : `终审没写结论（${reviewFile}），不算数`);
    }
    // 强模型干活时也会先复核（接力本里这么要求的）：它写的复核结论一样算数。
    applyReviews(root, closed);
    for (const t of targets) this.reviewTries.set(t.id, (this.reviewTries.get(t.id) ?? 0) + 1);
    refreshBrief(root);
    delete this.state.current;
    this.save();
    const after = loadLedger(root).stints.find((x) => x.id === id) ?? closed;
    return { stint: after, changed: from !== to, handoff: h, finalText, ...(error ? { error } : {}) };
  }

  private members(): MemberInfo[] {
    return spareFirst(orderMembers(allMembers(this.settings.level), this.settings.order), recentErrors());
  }

  /**
   * 派活前不花额度地问一次额度（借 CodexBar：Codex 用它自己的 app-server 问，接力台不读登录凭据）。
   * 同一个工具的几位共用一个账号，问一次记到每一位身上；一分钟内读到过（刚跑完一棒的会话记录里也有）就不问。
   * 有窗口用满了：先记成额度用完、什么时候恢复，挑人时跳过它，不用等它跑一棒失败才知道。
   * 记着额度用完的也照样问（问不花额度）：没用满了就是额度又有了（比如你在 Codex 里用了重置卡），马上能派。
   */
  private async refreshLiveLimits(): Promise<void> {
    if (process.env.RELAY_LIVE_LIMITS === 'off') return;
    const groups = new Map<string, MemberInfo[]>();
    for (const m of this.members()) {
      if (m.kind !== 'harness' || !m.harness || !m.canWork || !findHarness(m.harness)?.liveLimits) continue;
      groups.set(m.harness, [...(groups.get(m.harness) ?? []), m]);
    }
    for (const [h, ms] of groups) {
      if (ms.some((m) => m.limitsAt && Date.now() - Date.parse(m.limitsAt) < 60_000)) continue;
      const spec = findHarness(h);
      const loc = spec ? locateCached(spec) : null;
      if (!spec?.liveLimits || !loc) continue;
      const w = await spec.liveLimits(loc).catch(() => null);
      if (!w?.length) continue;
      const full = fullUntil(w);
      for (const m of ms) {
        noteLiveLimits(m.name, w);
        if (full) markQuota(m.name, { hit: true, line: `${nameOf(m)} 报的额度窗口用满了`, until: full });
      }
    }
  }

  /** 挑一位：能调度、没在等额度、这次没出过错。tier = 只要强的 / 只要弱的 / 都行。 */
  private pick(tier: Tier, exclude: string[] = []): MemberInfo | null {
    return readyMembers(this.members()).find((m) => !this.failed.has(m.name) && !exclude.includes(m.name) && (tier === 'any' || m.tier === tier)) ?? null;
  }

  /** 派活这个任务谁指挥：设置里指定的；没指定就是拆这个任务的那一位。 */
  private leadName(v: LedgerView): string | undefined {
    if (this.settings.lead) return this.settings.lead;
    const since = taskSince(v);
    return [...v.stints].reverse().find((s) => s.kind === 'plan' && s.status === 'handed' && !s.rolledBack && !(Date.parse(s.startedAt) < since))?.who.member ?? undefined;
  }

  /** 派活时指挥的那一位配的干活的人。 */
  private crewName(v: LedgerView): string | undefined {
    const lead = this.leadName(v);
    return lead ? this.members().find((m) => m.name === lead)?.agent.crew : undefined;
  }

  /**
   * 「接着同一段对话」打开时：这位成员在这个任务里上一棒的对话编号（同一个工具、没被退回）。
   * Claude Code、Codex 的还要看记录文件还在不在（被清掉了就新开一段）。
   */
  private resumeFor(m: MemberInfo, current: number): string | undefined {
    if (!this.settings.sameThread) return undefined;
    const v = loadLedger(this.root);
    const since = taskSince(v);
    const prev = [...v.stints].reverse().find((s) => s.id !== current && s.who.member === m.name && s.session?.tool === m.harness && !s.rolledBack && s.via === 'relay' && !(Date.parse(s.startedAt) < since));
    if (!prev?.session) return undefined;
    const tool = sessionToolOf(prev.session.tool);
    return !tool || sessionFile(this.root, tool, prev.session.id) ? prev.session.id : undefined;
  }

  /** 能用的那一位（能调度、没在等额度、这次没出过错）。 */
  private ready(name: string | undefined): MemberInfo | null {
    return name ? readyMembers(this.members()).find((m) => m.name === name && !this.failed.has(m.name)) ?? null : null;
  }

  /** 最早恢复额度的那一位。 */
  private earliestCooling(tier: Tier): MemberInfo | null {
    const list = this.members().filter((m) => m.canWork && m.cooling && !this.failed.has(m.name) && (tier === 'any' || m.tier === tier));
    return list.sort((a, b) => new Date(a.cooling!).getTime() - new Date(b.cooling!).getTime())[0] ?? null;
  }

  /** 派活时弱模型为什么都用不了（每一位一句）。 */
  private weakWhy(): string {
    const weak = this.members().filter((m) => m.tier === 'weak');
    if (!weak.length) return '：名单里没有弱模型';
    return `：${weak.map((m) => `${nameOf(m)}${this.failed.has(m.name) ? '这次出错或做不下去' : m.cooling ? cause.quota(m.cooling) : `不能派活（${plain(m.why ?? '不能用')}）`}`).join('；')}`;
  }

  private async waitFor(m: MemberInfo, why: string): Promise<boolean> {
    if (!this.settings.waitForQuota || !m.cooling) return false;
    const ms = Math.max(0, new Date(m.cooling).getTime() - Date.now()) + 30_000;
    this.state.status = 'waiting';
    this.state.waitingUntil = m.cooling;
    this.phase(`${why}：等 ${nameOf(m)} ${untilText(m.cooling)}`);
    await this.sleep(Math.min(ms, 6 * 3600_000));
    delete this.state.waitingUntil;
    this.state.status = 'running';
    this.save();
    return !this.stopRequested;
  }

  // ---- 派活：边做边复核 ----

  /**
   * 弱模型做下一步的同时，请指挥的强模型只看不改地复核已经做完、还没复核过的几棒。
   * 只看不改：它和干活的人在同一个文件夹里，改文件会撞车；结论写在回答里，接力台代写成复核文件。
   * 账等两棒之间的空档再记（recordSide），账本里不会同时开着两棒。
   */
  private startSide(v: LedgerView): void {
    if (!this.dispatch || !this.settings.sideReview || this.side || this.stopRequested) return;
    const targets = pendingReviews(v).filter((p) => !this.sideSeen.has(p.id) && !(p.reviews ?? []).length);
    if (!targets.length) return;
    const authors = targets.map((p) => p.who.member).filter(Boolean) as string[];
    const lead = this.ready(this.leadName(v));
    const m = (lead?.tier === 'strong' && !authors.includes(lead.name) ? lead : null) ?? this.pick('strong', authors);
    if (!m) return;
    for (const t of targets) this.sideSeen.add(t.id);
    const root = this.root;
    const ids = targets.map((t) => t.id);
    const startedAt = nowIso();
    const logRel = `.relay/runs/复核第${ids.join('、')}棒-${fileStamp()}-${m.name}.log`;
    const logAbs = path.join(root, logRel);
    // 只写进它自己的日志，不混进正在干活那一棒的实时输出
    const log = (line: string) => {
      const d = new Date();
      const p2 = (x: number) => String(x).padStart(2, '0');
      try {
        fs.mkdirSync(path.dirname(logAbs), { recursive: true });
        fs.appendFileSync(logAbs, `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${line}\n`);
      } catch {
        /* 日志写不了不影响复核 */
      }
    };
    const who = whoOfMember(m);
    log(`# 边做边复核 · ${who.label}：第 ${ids.join('、')} 棒（只看不改）`);
    let prompt = sideReviewPrompt({ label: who.label, targets: targets.map((t) => ({ id: t.id, label: t.who.label, ...(t.handoff ? { handoff: t.handoff } : {}), ...(t.step ? { step: t.step } : {}) })) }) + langNote(this.settings.lang);
    try {
      prompt += skillNote(root, fs.readFileSync(path.join(root, TASK_REL), 'utf8'));
    } catch {
      /* 还没有任务文件 */
    }
    const timeoutMs = this.settings.reviewTimeoutMin * 60_000;
    const run = async (): Promise<SideOutcome> => {
      try {
        if (m.kind === 'harness') {
          const spec = findHarness(m.harness);
          const loc = spec ? locateCached(spec) : null;
          if (!spec || !loc) throw new RelayError('找不到这个工具了。', 'no-tool');
          const inv = spec.invoke(loc, { cwd: root, prompt, level: this.settings.level, readOnly: true, model: m.agent.model?.trim() || undefined, effort: m.agent.effort, outFile: tmpOut() });
          const h = startRun({ invocation: inv, cwd: root, timeoutMs, logPath: logAbs, title: '边做边复核' });
          this.sideHandle = h;
          const r = await h.done;
          this.sideHandle = null;
          const asked = modelArg(inv.argv);
          const model = r.model && asked?.startsWith(`${r.model}-`) ? asked : r.model;
          const own = toolLines(logTail(logAbs, 6000));
          const failed = !r.stopped && (!!r.error || r.timedOut || r.code !== 0);
          let logText = '';
          try {
            logText = fs.readFileSync(logAbs, 'utf8');
          } catch {
            /* 没有日志 */
          }
          const tokens = usageTotal(logText) ?? spec.usage?.(root, Date.parse(startedAt)) ?? undefined;
          return {
            finalText: r.finalText,
            stopped: r.stopped,
            ...(failed ? { error: r.error ?? (r.timedOut ? (r.late ?? cause.overtime(timeoutMs)) : explainFailure(m.harness, `${r.error ?? ''}\n${r.stderrTail}\n${r.finalText}`) ?? cause.exit(r.code, clip(lastError(r.stderrTail, own), 200))) } : {}),
            ...(model ? { model } : {}),
            ...(tokens ? { tokens } : {}),
            ...(r.session ? { session: { tool: spec.id, id: r.session } } : {}),
            limits: r.limits ?? spec.limits?.(root, Date.parse(startedAt)) ?? undefined,
            quotaText: `${r.error ?? ''}\n${r.stderrTail}\n${own}\n${r.finalText.slice(-2000)}`,
            ...(failed ? { toolSaid: `${r.error ?? ''}\n${r.stderrTail}\n${own}` } : {}),
          };
        }
        if (m.kind === 'api' && m.agent.api) {
          log(`（接力台内置小代理：${m.agent.api.baseUrl} · ${m.agent.api.model}，只看不改）`);
          const r = await runLlmAgent({
            spec: m.agent.api,
            cwd: root,
            brief: prompt,
            level: this.settings.level,
            readOnly: true,
            gateCommand: '',
            protectedPaths: [],
            log,
            shouldStop: () => this.stopRequested,
            deadline: Date.now() + timeoutMs,
            maxSteps: 40,
          });
          let logText = '';
          try {
            logText = fs.readFileSync(logAbs, 'utf8');
          } catch {
            /* 没有日志 */
          }
          const tokens = usageTotal(logText) ?? undefined;
          const error = r.error ? plain(r.error) : r.timedOut ? cause.overtime(timeoutMs) : undefined;
          return { finalText: r.finalText, stopped: r.stopped, ...(error ? { error } : {}), ...(tokens ? { tokens } : {}), quotaText: r.error ?? '', ...(r.error ? { toolSaid: r.error } : {}) };
        }
        throw new RelayError('桌面程序不能派活', 'cannot-drive');
      } catch (e) {
        log(`出错：${errorMessage(e)}`);
        return { finalText: '', stopped: false, error: errorMessage(e), quotaText: errorMessage(e) };
      }
    };
    const job: SideJob = { member: m, targets, startedAt, log: logRel, done: Promise.resolve(null as never) };
    job.done = run().then((r) => (job.result = r));
    this.side = job;
    this.state.side = { member: m.name, label: who.label, targets: ids, since: startedAt, log: logRel };
    this.save();
  }

  /**
   * 边做边复核跑完了：记一棒复核（只看不改，快照不动），把结论按棒存成复核文件、记到那几棒上。
   * 结论是「有问题，还没修」的：在清单里下一步前面插一步去改（改完那一棒照样会被复核）；「证据不足」留给终审。
   * wait：还没跑完就等它（清单做完、要收工时）。只在没有别的棒开着的时候调用。
   */
  private async recordSide(wait: boolean): Promise<void> {
    const job = this.side;
    if (!job || (!wait && !job.result)) return;
    const r = job.result ?? (await job.done);
    this.side = null;
    delete this.state.side;
    const root = this.root;
    const m = job.member;
    const cfg = projectConfig(root);
    const v = loadLedger(root);
    const id = nextStintId(v);
    const base = v.base ?? takeSnapshot(root, '边做边复核').sha;
    const who0 = whoOfMember(m);
    const who = r.model && !(who0.model && who0.model === r.model) ? { ...who0, model: r.model, label: `${m.label} · ${r.model}`, tier: who0.model && sameModel(who0.model, r.model) ? who0.tier : memberTier(m.agent, r.model) } : who0;
    const ids = job.targets.map((t) => t.id);
    const parts = r.error || r.stopped ? new Map<number, string>() : splitSideReview(r.finalText, ids);
    for (const [tid, body0] of parts) {
      const t = job.targets.find((x) => x.id === tid)!;
      let text = `# 复核：第 ${tid} 棒（${t.who.label}）\n\n- 复核人：${who.label}\n${body0}\n`;
      // 只看不改的人写「已修好」「已退回」不可能是真的：按「有问题，还没修」记
      const v0 = parseReview(text).verdict;
      if (v0 === 'fixed' || v0 === 'reverted') text = text.replace(/^(\s*[-*]?\s*结论\s*[:：]).*$/m, '$1有问题，还没修（只看不改，没有动文件）');
      try {
        fs.mkdirSync(path.join(root, REVIEW_DIR), { recursive: true });
        fs.writeFileSync(path.join(root, reviewFileFor(tid)), text);
      } catch {
        /* 写不了：这一棒还是待复核，终审会看 */
      }
    }
    const quota = r.error || !r.finalText ? detectQuota(r.quotaText) : { hit: false as const };
    noteLimits(m.name, r.limits);
    let status: Stint['status'] = 'handed';
    let note: string | undefined;
    let quotaUntil: string | undefined;
    if (r.stopped || this.stopRequested) status = 'stopped';
    else if (quota.hit) {
      status = 'quota';
      const e = markQuota(m.name, { ...quota, until: fullUntil(r.limits) ?? quota.until });
      quotaUntil = e.until;
      note = cause.quota(e.until);
    } else if (r.error) {
      status = 'failed';
      note = r.error;
      const kind = failureKind(r.toolSaid ?? '');
      if (kind) blockMember(m.name, kind, r.toolSaid ?? '', m.model);
      else noteError(m.name);
    } else {
      markOk(m.name);
      if (parts.size < ids.length) note = `边做边复核：第 ${ids.filter((x) => !parts.has(x)).join('、')} 棒没写出结论，留给终审`;
    }
    const stint: Stint = {
      id,
      kind: 'review',
      who,
      via: 'relay',
      startedAt: job.startedAt,
      activeAt: job.startedAt,
      from: base,
      status: 'working',
      review: 'skip',
      handoff: handoffFileFor(root, id, m.harness ?? m.name),
      log: job.log,
      targets: ids,
      ...(r.tokens ? { tokens: r.tokens } : {}),
      ...(r.session ? { session: r.session } : {}),
    };
    const closed = closeStint(root, stint, { status, to: base, handoff: null, lastWords: r.finalText, ...(note ? { note } : {}), ...(quotaUntil ? { quotaUntil } : {}) }, cfg);
    // 这次跑过的棒里也有它：收尾那一行的棒数、强模型 token 才算得全
    this.state.stints.push(id);
    applyReviews(root, closed);
    const after = loadLedger(root);
    const verdicts = ids.map((tid) => {
      const mark = (after.stints.find((x) => x.id === tid)?.reviews ?? []).filter((x) => x.by === id).at(-1);
      return { tid, verdict: mark?.verdict, weak: mark?.weak };
    });
    saveStint(root, { ...(after.stints.find((x) => x.id === id) ?? closed), summary: `边做边复核：${verdicts.map((x) => `第 ${x.tid} 棒${x.verdict ? verdictWord(x.verdict) : '没写结论'}`).join('；')}` });
    // 查出问题、还没修：下一棒先改（改的那一棒照样边做边复核）。改问题的那一步自己又没过的，不再插，留给终审。
    for (const x of verdicts) {
      if (x.weak || x.verdict !== 'problem') continue;
      const t = job.targets.find((y) => y.id === x.tid);
      if (t?.step?.text.startsWith(FIX_STEP)) continue;
      try {
        editTask(root, { op: 'add', next: true, text: `${FIX_STEP}第 ${x.tid} 棒复核里指出的问题（\`${reviewFileFor(x.tid)}\`）`, note: '只改复核里写的问题，改完在这一步打勾。' });
      } catch {
        /* 清单写不了：终审会看到这一棒没过 */
      }
    }
    refreshBrief(root);
    this.save();
  }

  /** 收工前：边做边复核还在跑就等它跑完记上（叫停了就先停下它）。 */
  private async settleSide(): Promise<void> {
    if (!this.side) return;
    if (this.stopRequested) this.sideHandle?.stop();
    else if (!this.side.result) this.phase(`等 ${nameOf(this.side.member)} 复核完第 ${this.side.targets.map((t) => t.id).join('、')} 棒`);
    await this.recordSide(true);
  }

  private async end(status: GoStatus, text: string): Promise<GoState> {
    try {
      await this.settleSide();
    } catch {
      /* 记不上：那几棒还是待复核 */
    }
    return this.finish(status, text);
  }

  /**
   * 派活：清单里标了「可以同时做」的几步同时做（最多 parallel 位）。每一位在自己的项目副本里做（互相看不到、不会撞车），
   * 谁先做完谁先并回项目、记成一棒（和一棒一步时一样记账、复核），空出来的人接着领下一步——不等最慢的那位。
   * 并的时候它改的文件、在它开工之后项目里已经被别人并进来改过：不并，这一步留着之后再做。
   * 返回记了几棒；凑不出两位、两步就返回 0（照常一步一步做）；副本建不起来返回 -1。
   */
  private async runPool(v: LedgerView): Promise<number> {
    const root = this.root;
    const cfg = projectConfig(root);
    const gate = cfg.gate.command.trim();
    const max = this.settings.parallel;
    interface Job {
      m: MemberInfo;
      step: Step;
      from: string;
      dir: string;
      handoffTmp: string;
      logRel: string;
      logAbs: string;
      who: Who;
      startedAt: string;
      cancel: Cancel;
      /** 同一步的另一份（快的人闲下来，帮慢的人做同一步）。 */
      twin?: Job;
      /** 同一步别人先做完了：这一份不要了。 */
      dropped?: string;
      done: Promise<{ job: Job; ex: RunMid; at: Date }>;
    }
    /** 按步骤的原话认（边做边复核可能在清单里插一步，第几步会变）；帮做的那份 key 后面加「#帮」。 */
    const running = new Map<string, Job>();
    /** 这一轮每位做成一步用了多久（毫秒）：看谁快、该不该帮慢的人。 */
    const took = new Map<string, number>();
    /** 这一轮领过的步骤（做没做成都不再领：没做成的回到外面照常处理）。 */
    const taken = new Set<string>();
    const crew = this.ready(this.crewName(v));
    const workers = (): MemberInfo[] => {
      const weak = readyMembers(this.members()).filter((m) => m.tier === 'weak' && !this.failed.has(m.name) && m.name !== crew?.name);
      return [...(crew && !this.failed.has(crew.name) ? [crew] : []), ...weak];
    };
    /** 一位同时只做一步；走接口的可以同时开几个。 */
    const freeWorker = (): MemberInfo | null => {
      const busy = new Set([...running.values()].map((j) => j.m.name));
      const pool = workers();
      return pool.find((x) => !busy.has(x.name)) ?? pool.find((x) => x.kind === 'api') ?? null;
    };
    /** 能领的步骤：从第一个没做的往下，标了「可以同时做」的；碰到没标的就停（它要等前面的做完）。 */
    const open = (): Step[] => {
      const task = readTask(root);
      const out: Step[] = [];
      for (let i = 0; i < task.items.length; i++) {
        const it = task.items[i];
        if (it.done) continue;
        if (!isParallel(it)) break;
        const st = stepOf(task, i);
        if (![...running.values()].some((j) => j.step.text === st.text) && !taken.has(st.text) && !this.stepFails.has(st.text)) out.push(st);
      }
      return out;
    };
    // 起码两步、两位才值得同时做
    const first = open();
    const pool0 = workers();
    if (first.length < 2 || !(pool0.length >= 2 || pool0.some((x) => x.kind === 'api'))) return 0;
    this.settleNative();
    const timeoutMs = this.settings.stintTimeoutMin * 60_000;
    const showPhase = () => {
      const steps = [...running.values()].map((j) => j.step.index).sort((a, b) => a - b);
      if (steps.length) this.phase(`同时在做清单第 ${steps.join('、')} 步（${[...running.values()].map((j) => whoName(j.who)).join('、')}）`);
    };
    const start = (m: MemberInfo, step: Step, helping?: Job): void => {
      taken.add(step.text);
      const from = takeSnapshot(root, `同时做第 ${step.index} 步之前`).sha;
      const dir = cloneProject(root, `第${step.index}步-${fileStamp()}`);
      const who = whoOfMember(m);
      const tool = m.harness ?? m.name;
      const handoffTmp = `${HANDOFF_DIR}/同时做-第${step.index}步-${fileStamp()}-${tool}.md`;
      const logRel = `.relay/runs/同时做-第${step.index}步-${fileStamp()}-${m.name}.log`;
      const logAbs = path.join(root, logRel);
      const startedAt = nowIso();
      const job = { m, step, from, dir, handoffTmp, logRel, logAbs, who, startedAt, cancel: { requested: false } } as Job;
      if (helping) {
        job.twin = helping;
        helping.twin = job;
      }
      const log = this.logger(logAbs);
      const others = [...running.values()].map((x) => x.step.index).filter((k) => k !== step.index);
      log(`# ${whoName(who)} 做清单第 ${step.index} 步（在项目副本里做，做完并回项目）${others.length ? `；同时在做第 ${others.join('、')} 步` : ''}`);
      if (helping) log(`${whoName(helping.who)} 做这一步已经 ${Math.round((Date.now() - Date.parse(helping.startedAt)) / 1000)} 秒了，${whoName(who)} 闲着，也来做这一步：谁先做完用谁的，另一份停掉。`);
      let prompt = stepPrompt({ id: nextStintId(loadLedger(root)) + running.size, label: who.label, handoff: handoffTmp, gateCommand: gate, step, together: open().map((x) => x.index).concat(others).filter((k) => k !== step.index).sort((a, b) => a - b) }) + langNote(this.settings.lang);
      try {
        prompt += skillNote(root, fs.readFileSync(path.join(root, TASK_REL), 'utf8'));
      } catch {
        /* 还没有任务文件 */
      }
      job.done = this.execute({ m, kind: 'work', prompt, cwd: dir, logAbs, title: `清单第 ${step.index} 步`, timeoutMs, unchanged: () => copyChanges(root, from, dir).length === 0, startedAt, log, cfg, cancel: job.cancel }).then((ex) => ({ job, ex, at: new Date() }));
      running.set(helping ? `${step.text}#帮` : step.text, job);
      if (!this.state.current) this.state.current = { stint: nextStintId(loadLedger(root)), member: m.name, label: who.label, kind: 'work', since: startedAt, log: logRel };
      showPhase();
    };
    const fill = (): void => {
      if (this.stopRequested) return;
      for (const step of open()) {
        if (running.size >= max) return;
        const m = freeWorker();
        if (!m) return;
        start(m, step);
      }
      // 没有能领的步骤了、有人闲着：做得慢的那一步，请闲着的快的人也做一份（谁先做完用谁的）
      if (open().length) return;
      const busy = new Set([...running.values()].map((j) => j.m.name));
      for (const j of [...running.values()].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))) {
        if (running.size >= max) return;
        if (j.twin) continue;
        const elapsed = Date.now() - Date.parse(j.startedAt);
        const m = workers().find((x) => !busy.has(x.name) && x.name !== j.m.name && took.has(x.name) && took.get(x.name)! * 2 < elapsed);
        if (!m || elapsed < HELP_AFTER_MS) continue;
        busy.add(m.name);
        start(m, j.step, j);
      }
    };
    try {
      fill();
    } catch (e) {
      for (const j of running.values()) dropClone(j.dir);
      this.logger(path.join(root, '.relay', 'runs', 'go.log'))(`建不了项目副本（${errorMessage(e)}），这次一步一步做。`);
      if (running.size) await Promise.all([...running.values()].map((j) => j.done));
      return -1;
    }
    let recorded = 0;
    while (running.size) {
      // 每隔一会儿看一眼：有没有该帮慢的人做的
      let tick: NodeJS.Timeout | undefined;
      const got = await Promise.race([...[...running.values()].map((x) => x.done), new Promise<null>((res) => (tick = setTimeout(() => res(null), HELP_CHECK_MS)))]);
      clearTimeout(tick);
      if (!got) {
        try {
          fill();
        } catch {
          /* 建不了副本就不帮了 */
        }
        showPhase();
        continue;
      }
      const { job: j, ex, at } = got;
      for (const [k, x] of running) if (x === j) running.delete(k);
      const o = await this.mergeJob(j, ex, at, cfg, j.dropped);
      recorded++;
      const won = !j.dropped && !o.clash && o.stint.status === 'handed';
      if (won) took.set(j.m.name, at.getTime() - Date.parse(j.startedAt));
      // 同一步的另一份还在做：这份成了就停掉那份（它的账照记，写明没用上）
      if (won && j.twin && [...running.values()].includes(j.twin)) {
        j.twin.dropped = `同一步 ${whoName(j.who)} 先做完了（第 ${o.stint.id} 棒），这一份停掉、没有并回项目`;
        j.twin.cancel.requested = true;
        j.twin.cancel.stop?.();
      }
      if (j.dropped || (j.twin && [...running.values()].includes(j.twin))) {
        /* 没用上的那份、或者另一份还在做：这一步不算谁做不下去 */
      } else if (o.clash || o.stint.status === 'stopped' || o.stint.status === 'quota') {
        /* 撞车、叫停、额度用完：这一步留着，外面照常处理 */
      } else if (o.stint.status === 'failed' && !o.changed) {
        this.stepFails.set(j.step.text, (this.stepFails.get(j.step.text) ?? 0) + 1);
        this.stuckOn.set(j.m.name, j.step.text);
        if (!TRANSIENT.test(o.error ?? '')) this.failed.add(j.m.name);
      } else this.strikes.delete(j.m.name);
      // 并进来一棒：趁别人还在做，请指挥的只看不改地复核它（上一回复核完了先记账，好接着复核新并进来的）
      await this.recordSide(false);
      this.startSide(loadLedger(root));
      try {
        fill();
      } catch (e) {
        this.noBatch = true;
        this.logger(j.logAbs)(`建不了项目副本（${errorMessage(e)}），剩下的一步一步做。`);
      }
      showPhase();
    }
    delete this.state.current;
    this.save();
    return recorded;
  }

  /** 同时做的一步做完了：并回项目，记成一棒。 */
  private async mergeJob(
    j: { m: MemberInfo; step: Step; from: string; dir: string; handoffTmp: string; logRel: string; logAbs: string; who: Who; startedAt: string },
    ex: RunMid,
    at: Date,
    cfg: RelayConfig,
    dropped?: string
  ): Promise<StintOutcome> {
    const root = this.root;
    const log = this.logger(j.logAbs);
    const id = nextStintId(loadLedger(root));
    const handoff = handoffFileFor(root, id, j.m.harness ?? j.m.name);
    let note: string | undefined = dropped;
    let files: { path: string; deleted: boolean }[] = [];
    const now = takeSnapshot(root, `第 ${id} 棒并回项目前`).sha;
    if (!note) try {
      files = copyChanges(root, j.from, j.dir).filter((f) => !f.path.startsWith('.relay/'));
      // 它开工之后，项目里已经并进来的别人的改动
      const theirs = new Map(
        loadLedger(root)
          .stints.filter((s) => s.step && s.step.index !== j.step.index && s.endedAt && Date.parse(s.endedAt) >= Date.parse(j.startedAt))
          .flatMap((s) => (s.facts?.paths ?? []).map((p) => [p, s.step!.index] as const))
      );
      const changed = new Set(snapChanges(root, j.from, now).map((f) => f.path));
      const clash = files.find((f) => changed.has(f.path));
      if (clash) note = `和同时做的${theirs.has(clash.path) ? `第 ${theirs.get(clash.path)} 步` : '别人'}都改了 ${clash.path}，这一份没有并回项目（这一步之后再做一次），副本留在 ${j.dir}`;
    } catch (e) {
      note = `读不到副本里的改动（${errorMessage(e)}），没有并回项目，副本留在 ${j.dir}`;
    }
    // 清单以并之前为准：先并的那几步打的勾不算到这一棒头上
    const before = saveTaskCopy(root);
    const stint: Stint = { id, kind: 'work', who: j.who, via: 'relay', startedAt: j.startedAt, activeAt: at.toISOString(), from: now, status: 'working', review: 'needed', handoff, log: j.logRel, step: j.step, ...(before ? { taskBefore: before } : {}) };
    saveStint(root, { ...stint, pid: process.pid });
    this.state.stints.push(id);
    const handoffsBefore = new Set(listHandoffFiles(root).map((f) => f.rel));
    if (!note) {
      applyFiles(root, j.dir, files);
      // 交接带回来（换成这一棒的文件名）；清单只把这一步的勾带回来
      const h = path.join(j.dir, j.handoffTmp);
      if (fs.existsSync(h)) {
        fs.mkdirSync(path.dirname(path.join(root, handoff)), { recursive: true });
        fs.copyFileSync(h, path.join(root, handoff));
      }
      // 按原话找这一步（边做边复核可能在清单里插了一步，第几步会变）
      const mine = readTask(j.dir).items[j.step.index - 1];
      const row = mine?.done ? readTask(root).items.findIndex((x) => !x.done && x.text === mine.text) : -1;
      if (row >= 0) editTask(root, { op: 'toggle', index: row, done: true });
      log(`并回项目，记成第 ${id} 棒：${files.length} 个文件${files.length ? `（${clip(files.map((f) => f.path).join('、'), 300)}）` : ''}`);
    } else log(note);
    const o = await this.closeRun({ cfg, from: now, id, handoff, handoffsBefore, logAbs: j.logAbs, stint, who: j.who, m: j.m, kind: 'work', targets: [], log, ...ex, ...(note && !dropped ? { error: ex.error ?? note } : {}), ...(dropped ? { stopped: true, note: dropped } : {}), usageDir: j.dir, endedAt: at });
    if (!note || dropped) dropClone(j.dir);
    return { ...o, ...(note ? { clash: true } : {}) };
  }

  // ---- 只跑一棒 ----

  async once(): Promise<GoState> {
    try {
      const v = requireInit(this.root);
      const kind = this.opts.kind ?? 'work';
      if (!this.opts.who) await this.refreshLiveLimits();
      const all = this.members();
      let m: MemberInfo | null = null;
      if (this.opts.who) {
        m = all.find((x) => x.name === this.opts.who) ?? null;
        if (!m) throw new RelayError(`名单里没有「${this.opts.who}」`, 'no-agent');
        // 先停用着的（模型用不了、没登录）：点名派给它就是要再试一次，照派
        if (!m.canWork && !m.blocked) throw new RelayError(`${nameOf(m)} 不能派活：${plain(m.why ?? '不能用')}`, 'cannot-drive');
        // 网页上在等额度的点不了；命令行指名也一样先拦下（它其实已经恢复了就加 --force）
        if (m.cooling && !this.opts.force) throw new RelayError(`${nameOf(m)} ${cause.quota(m.cooling)}；确定已经恢复了就加 --force`, 'cooling');
      } else {
        m = this.pick(kind === 'review' ? 'strong' : 'any');
        if (!m) throw new RelayError(kind === 'review' ? '没有能复核的强模型：都没额度或没登录' : '没有能派活的成员：都没额度或没登录', 'nobody');
      }
      if (kind === 'review') {
        if (m.tier !== 'strong') throw new RelayError(`${nameOf(m)} 不能复核：它算弱模型，复核要强模型`, 'weak-reviewer');
        const targets = pendingReviews(this.settleNative(m));
        if (!targets.length) return this.finish('done', '没有待复核的棒');
        const o = await this.runStint(m, 'review', targets);
        return this.finishOnce(o);
      }
      // 派活时指定一位弱模型：它只做清单里下一步（强模型拆好的）。
      const o = await this.runStint(m, 'work', [], this.dispatch && (m.tier === 'weak' || m.name === this.crewName(v)) ? nextStep(readTask(this.root)) : undefined);
      return this.finishOnce(o);
    } catch (e) {
      return this.finish(e instanceof RelayError && e.code === 'native-active' ? 'needs-human' : 'failed', errorMessage(e));
    }
  }

  private finishOnce(o: StintOutcome): GoState {
    const s = o.stint;
    const head = `第 ${s.id} 棒（${whoName(s.who)}）`;
    if (s.status === 'stopped') return this.finish('stopped', `${head}已停止：改到一半的内容还在文件夹里`);
    if (s.status === 'quota') return this.finish('needs-human', `${head}${cause.quota(s.quotaUntil)}`);
    if (s.status === 'failed') return this.finish('failed', `${head}出错${s.note ? `：${plain(s.note)}` : ''}`);
    return this.finish('done', `${head}${statusWord(s.status)}：${s.summary || (o.changed ? '改了文件' : '没改文件')}${s.review === 'needed' ? '；待复核' : ''}`);
  }

  // ---- 全自动 ----

  async auto(): Promise<GoState> {
    let stints = 0;
    let idle = 0;
    try {
      requireInit(this.root);
      // 防止没完没了的保险：派活一棒一步，步数多时棒数也多
      for (let guard = 0; guard < Math.max(this.settings.maxStints, 50) * 3 + 10; guard++) {
        if (this.stopRequested) return this.end('stopped', '全自动已停止：改到一半的内容还在文件夹里');
        // 对账：别人改到一半、已经停了的那一棒先结账，这一轮的待复核里就有它
        this.settleNative();
        // 边做边复核跑完了：趁两棒之间的空档记账（清单里可能多了一步去改）
        await this.recordSide(false);
        await this.refreshLiveLimits();
        const v = loadLedger(this.root);
        const task = readTask(this.root);
        if (task.empty) return this.end('needs-human', '全自动停止：还没写任务');
        const pending = pendingReviews(v);
        const dispatch = this.dispatch;
        // 派活：清单做完了还有待复核的，不单独复核，并进终审（终审的人顺手写这几棒的复核，省一棒强模型）。
        const merge = dispatch && taskComplete(task) && pending.length > 0 && !this.merged;

        // 1. 有待复核、又有强模型能用：先复核。派活时中途不复核（并进终审；并过还没复核上的才单独复核）。
        if (pending.length && (!dispatch || this.merged)) {
          const stuck = pending.filter((p) => (this.reviewTries.get(p.id) ?? 0) >= 2);
          if (stuck.length) {
            const ids = stuck.map((p) => p.id).join('、');
            // 写了复核、但写的人算弱（或者是自己复核自己）：结论不算数，和「没写出来」「写了有问题」是三回事。
            const weakOnly = stuck.every((p) => (p.reviews ?? []).length > 0 && (p.reviews ?? []).every((m) => m.weak));
            const anon = stuck.some((p) => (p.reviews ?? []).some((m) => m.anon));
            if (weakOnly) return this.end('needs-human', `全自动停止：第 ${ids} 棒复核两次都不算数，${anon ? '认不出复核是谁写的' : '写复核的都是弱模型'}`);
            const dropped = new Set(v.stints.filter((x) => x.rolledBack).map((x) => x.id));
            const why = stuck.map((p) => {
              const last = countedReviews(p, dropped).at(-1);
              return last ? `第 ${p.id} 棒复核结论「${verdictWord(last.verdict)}」（${last.byLabel}，${last.file}）` : `第 ${p.id} 棒两次都没写结论`;
            });
            return this.end('needs-human', `全自动停止：复核两次没过，${why.join('；')}`);
          }
          const authors = pending.map((p) => p.who.member).filter(Boolean) as string[];
          // 派活：指挥的那位（算强的话）来复核它派出去的活
          const lead = dispatch ? this.ready(this.leadName(v)) : null;
          const reviewer = (lead?.tier === 'strong' && !authors.includes(lead.name) ? lead : null) ?? this.pick('strong', authors) ?? this.pick('strong');
          if (reviewer) {
            await this.runStint(reviewer, 'review', pending);
            continue;
          }
        }

        // 2. 清单全部打勾：按验收来——复核、终审、检查都过了才收工（只有验收说通过才算完成）。
        if (taskComplete(task)) {
          // 还在边做边复核：等它记完再看（它可能查出问题、在清单里补一步）
          if (this.side) {
            await this.settleSide();
            continue;
          }
          if (pending.length && !merge) {
            const c = this.earliestCooling('strong');
            if (c && (await this.waitFor(c, '清单都打勾了，还有棒待复核，强模型都没额度'))) continue;
            return this.end('needs-human', `全自动停止：清单都打勾了，第 ${pending.map((p) => p.id).join('、')} 棒待复核，没有能用的强模型`);
          }
          const conf = projectConfigSafe(this.root);
          const acc = acceptance({ ledger: v, task, gateCommand: conf.cfg.gate.command.trim(), ...(conf.error ? { configError: conf.error } : {}), finalRequired: this.settings.finalReview });
          if (acc.state === 'accepted') return this.end('done', acc.headline);
          if (acc.state === 'unknown') return this.end('needs-human', acc.headline);
          if (!acc.final.ok) {
            const live = v.stints.filter((x) => !x.rolledBack && x.status !== 'working');
            const lastWork = [...live].reverse().find((x) => x.kind === 'work');
            const finals = live.filter((x) => x.kind === 'final' && x.id > (lastWork?.id ?? 0));
            if (finals.length >= 2) return this.end('needs-human', `全自动停止：终审两次没过，${acc.final.text}`);
            // 终审换一双眼睛：有别的强模型，就不请这个任务里干过活的来审；实际跑成弱模型的不再请。
            const since = taskSince(v);
            const doers = v.stints.filter((x) => x.kind === 'work' && !x.rolledBack && !(Date.parse(x.startedAt) < since)).map((x) => x.who.member).filter((x): x is string => !!x);
            const weak = [...this.weakFinals];
            // 派活：指挥的那位（算强的话）来终审
            const lead = dispatch ? this.ready(this.leadName(v)) : null;
            const fr = (lead?.tier === 'strong' && !weak.includes(lead.name) ? lead : null) ?? this.pick('strong', [...doers, ...weak]) ?? this.pick('strong', weak);
            if (fr) {
              const o = await this.runStint(fr, 'final', merge ? pending : []);
              if (merge) this.merged = true;
              if (o.stint.status === 'failed') this.failed.add(fr.name);
              if (o.stint.who.tier !== 'strong') this.weakFinals.add(fr.name);
              continue;
            }
            const c = this.earliestCooling('strong');
            if (c && (await this.waitFor(c, '清单都打勾了，要终审，强模型都没额度'))) continue;
            return this.end('needs-human', `全自动停止：清单都打勾了，${acc.final.text}，没有能用的强模型`);
          }
          // 终审已经过了、还有待复核的（派活并进终审没轮上）：照常单独复核。
          if (merge) {
            this.merged = true;
            continue;
          }
          // 最后一次改动之后还没跑检查：现在跑一次（记在最后一棒上），再看验收。
          if ((acc.gate.status === 'stale' || acc.gate.status === 'none') && this.gateRuns < 1) {
            const last = [...v.stints].reverse().find((x) => !x.rolledBack && x.status !== 'working');
            if (last) {
              this.gateRuns++;
              this.phase('清单都打勾了，正在跑检查');
              await gateStint(this.root, last.id, undefined, { absorb: 'all' });
              continue;
            }
          }
          return this.end('needs-human', acc.headline);
        }

        // 3. 派活：这个任务还没拆过，先请强模型拆成小步。
        if (dispatch && !planned(v)) {
          // 指定了谁指挥就请它（它用不了就换强模型按顺序，不断档）
          const planner = this.ready(this.settings.lead) ?? this.pick('strong');
          if (!planner) {
            const c = this.earliestCooling('strong');
            if (c && (await this.waitFor(c, '派活要先请强模型拆解，强模型都没额度'))) continue;
            return this.end('needs-human', '全自动停止：派活要先请强模型拆解，没有能用的强模型');
          }
          const o = await this.runStint(planner, 'plan');
          // 没拆成（出错、没交接）：这次不再请它拆，换一位强模型；额度用完的自己会被跳过。
          if (o.stint.status !== 'handed') {
            if (o.stint.status !== 'quota' && o.stint.status !== 'stopped') this.failed.add(planner.name);
            continue;
          }
          if (!taskProgress(readTask(this.root)).total) return this.end('needs-human', `全自动停止：第 ${o.stint.id} 棒（${whoName(o.stint.who)}）拆解之后清单还是空的`);
          continue;
        }

        // 4. 派人干活（派活时派指挥的那位配的干活的人，没配就派弱模型；一棒做清单里的一步）。
        // 派活一棒只做一步：上限至少是步数的两倍（每步留一次重做），不然清单一长就停在半路
        const cap = dispatch ? Math.max(this.settings.maxStints, task.items.length * 2) : this.settings.maxStints;
        if (stints >= cap) return this.end('needs-human', `全自动停止：接力到上限 ${stints} 棒，任务还没做完`);
        // 派活：指挥的那位配了干活的人就先派它（它用不了再按顺序派弱模型）
        // 上一棒临时出错的那位：点名再派它一次（按顺序挑会把刚出过错的排到后面）
        const again = this.retryNext ? this.ready(this.retryNext) : null;
        this.retryNext = null;
        let w = again ?? (dispatch ? this.ready(this.crewName(v)) ?? this.pick('weak') : this.pick('any'));
        const step = dispatch ? nextStep(task) : undefined;
        // 派活：同一步弱模型没做下去——两次，或者一次而且没有别的弱模型可换——请指挥的做这一步（学 smartplan：失败了才升级，不凭感觉）
        const fails = step ? (this.stepFails.get(step.text) ?? 0) : 0;
        let escalated = false;
        if (dispatch && step && this.settings.escalate && (fails >= 2 || (fails >= 1 && !w))) {
          const lead = this.ready(this.leadName(v)) ?? this.pick('strong');
          if (lead) {
            w = lead;
            escalated = true;
            this.handover = `接手原因：清单第 ${step.index} 步弱模型${fails >= 2 ? `做了 ${fails} 次` : ''}没做下去，请指挥的 ${nameOf(lead)} 做这一步；做完接着交给弱模型。`;
          }
        }
        if (!w && dispatch) {
          // 弱模型都用不了：按「等额度」等最早恢复的弱模型，或者停下。不换强模型干活，也不复核（做到哪写在页面上，复核你来点）。
          const c = this.earliestCooling('weak');
          if (c && (await this.waitFor(c, '派活的弱模型都没额度'))) continue;
          return this.end('needs-human', `全自动停止：没有能用的弱模型${this.weakWhy()}`);
        }
        if (!w) {
          const c = this.earliestCooling('any');
          if (c && (await this.waitFor(c, '能派活的都没额度'))) continue;
          const failed = [...this.failed].join('、');
          return this.end('needs-human', `全自动停止：没有能派活的成员，都没额度或没登录${failed ? `；这次出错的：${failed}` : ''}`);
        }
        // 派活：清单里标了「可以同时做」的几步，请几位同时做（各在一份项目副本里），谁先做完谁先并回来、接着领下一步
        if (dispatch && !escalated && !again && this.settings.parallel > 1 && !this.noBatch) {
          this.startSide(v);
          const n = await this.runPool(v);
          if (n < 0) this.noBatch = true;
          if (n > 0) {
            stints += n;
            continue;
          }
        }
        const before = taskProgress(task).done;
        // 派活：做完、还没复核的几棒，趁这一棒干活的时候请指挥的只看不改地复核（指挥的自己在做这一步时不同时复核）
        if (!escalated) this.startSide(v);
        const o = await this.runStint(w, 'work', [], step);
        stints++;
        if (o.stint.status === 'stopped') continue;
        if (o.stint.status === 'quota') continue;
        if (escalated && step) {
          const moved = o.changed || taskProgress(readTask(this.root)).done > before;
          if (o.stint.status !== 'failed' && moved) {
            // 这一步做成了：卡在这一步上的弱模型接着干后面的
            this.stepFails.delete(step.text);
            for (const [name, at] of [...this.stuckOn]) {
              if (at !== step.text) continue;
              this.stuckOn.delete(name);
              this.failed.delete(name);
              this.strikes.delete(name);
            }
            continue;
          }
          if (o.stint.status === 'failed' && TRANSIENT.test(o.error ?? '')) continue;
          const said = o.error ? `：${clip(plain(o.error), 160)}` : o.handoff?.next ? `，原话：${clip(plain(o.handoff.next), 200)}` : '';
          return this.end('needs-human', `全自动停止：清单第 ${step.index} 步弱模型没做下去，指挥的 ${nameOf(w)} 也没做成${said}`);
        }
        if (o.stint.status === 'failed' && !o.changed) {
          // 临时的错（连不上、超时、服务器忙）先原地再派它一次；连着两次、或者不是临时的，这次不再派它，按设置里的顺序换下一位
          const n = (this.strikes.get(w.name) ?? 0) + 1;
          this.strikes.set(w.name, n);
          // 工具自己已经重连了几分钟的（「N 秒都在重连」）不算临时的：再等一次多半还是白等
          if (n >= 2 || !TRANSIENT.test(o.error ?? '') || /都在重连/.test(o.error ?? '')) {
            this.failed.add(w.name);
            this.handover = `接手原因：${nameOf(w)} ${n >= 2 ? `连着 ${n} 次出错` : '出错'}（${clip(plain(o.error ?? ''), 120)}），这次不再派它，按设置里的顺序换人。`;
          } else {
            this.retryNext = w.name;
            this.handover = `接手原因：上一棒出错（${clip(plain(o.error ?? ''), 120)}），像是临时的，原地再来一次。`;
          }
          continue;
        }
        this.strikes.delete(w.name);
        const after = taskProgress(readTask(this.root)).done;
        if (!o.changed && after <= before) {
          idle++;
          if (o.handoff?.state === 'stuck' || idle >= 2) {
            if (dispatch) {
              // 派活：这位弱模型这次不再派，换别的弱模型；记下卡在哪一步（这一步没人做得下去就请指挥的做）。
              if (step) {
                this.stepFails.set(step.text, (this.stepFails.get(step.text) ?? 0) + 1);
                this.stuckOn.set(w.name, step.text);
              }
              this.failed.add(w.name);
              this.handover = `接手原因：${nameOf(w)} ${o.handoff?.state === 'stuck' ? '说做不下去了' : '连着两棒没推进'}，按设置里的顺序换人。`;
              idle = 0;
              continue;
            }
            if (w.tier !== 'strong' && this.pick('strong', [w.name])) {
              this.failed.add(w.name);
              idle = 0;
              continue;
            }
            return this.end('needs-human', `全自动停止：${nameOf(w)} 做不下去了${o.handoff?.next ? `，原话：${clip(plain(o.handoff.next), 200)}` : ''}`);
          }
        } else idle = 0;
      }
      return this.end('needs-human', '全自动停止：步骤超过上限');
    } catch (e) {
      return this.end(e instanceof RelayError && e.code === 'native-active' ? 'needs-human' : 'failed', errorMessage(e));
    }
  }
}

/**
 * 开始调度（只跑一棒 / 全自动）。准备工作同步做完、出错直接抛；真正的活在后台跑，done 在结束时兑现。
 */
export function startGo(root: string, opts: GoOptions, hooks: GoHooks = {}): { state: GoState; done: Promise<GoState> } {
  const abs = canonRoot(root);
  requireInit(abs);
  const prev = loadGoState(abs);
  if (runners.has(abs) || (prev && (prev.status === 'running' || prev.status === 'waiting'))) {
    throw new RelayError('接力台已经在调度这个项目', 'busy');
  }
  // 配置文件坏了：先说出来，不能带着「没有检查、没有不许改的文件」开工。
  projectConfig(abs);
  const release = acquireLock(abs);
  let runner: GoRunner;
  try {
    // 你自己在别的工具里干到一半、刚才还在改文件：先问你它停了没有。
    track(abs);
    const active = nativeActive(loadLedger(abs));
    if (active && !opts.force) throw nativeActiveError(active);
    killLeftover(prev);
    const settings = normalizeAutoSettings({ ...loadAutoSettings(), ...(opts.settings ?? {}) });
    runner = new GoRunner(abs, settings, opts, hooks);
  } catch (e) {
    release();
    throw e;
  }
  runners.set(abs, runner);
  // 别的进程（命令行 relay stop）要叫停时，会在 .relay/runs/stop 放一个标记。
  const poll = setInterval(() => {
    if (fs.existsSync(stopFlag(abs))) {
      fs.rmSync(stopFlag(abs), { force: true });
      runner.stop();
    }
  }, 1500);
  const done = (opts.mode === 'auto' ? runner.auto() : runner.once()).finally(() => {
    clearInterval(poll);
    runners.delete(abs);
    finishing.delete(abs);
    release();
  });
  finishing.set(abs, done);
  return { state: runner.state, done };
}
