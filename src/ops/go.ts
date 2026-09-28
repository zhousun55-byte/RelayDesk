import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptance } from '../core/acceptance';
import { loadAutoSettings, normalizeAutoSettings, type AutoSettings } from '../core/auto-settings';
import { errorMessage, RelayError } from '../core/errors';
import { refreshHarnessModel } from '../core/detect';
import { cliTooOld, explainFailure, findHarness, locateCached, modelArg, noteModelNeeds, type Invocation } from '../core/harness';
import { countedReviews, KIND_WORD, loadLedger, nextStintId, pendingReviews, requireInit, saveStint, statusWord, stintTitle, taskMode, tierWord, verdictWord, type LedgerView, type Stint } from '../core/ledger';
import { runLlmAgent } from '../core/llm-agent';
import { pidAlive } from '../core/proc';
import { allMembers, orderMembers, readyMembers, spareFirst, type MemberInfo } from '../core/members';
import { llmName, whoName } from '../core/names';
import { BRIEF_REL, fileStamp, handoffFileFor, listHandoffFiles, readHandoff, readReview, readTask, REVIEW_DIR, saveTaskCopy, taskComplete, taskProgress, type HandoffDoc, type TaskDoc } from '../core/notes';
import { finalPrompt, planPrompt, reviewPrompt, stepPrompt, workPrompt } from '../core/prompts';
import { detectQuota, fullUntil, markOk, markQuota, noteError, noteLimits, recentErrors, untilText, type Limit } from '../core/quota';
import { clip, lastError, logTail, looksLikeNetworkBlip, startRun, toolLines, usageTotal, type RunHandle, type RunResult } from '../core/runner';
import { cause, plain } from '../core/cause';
import { takeSnapshot } from '../core/snap';
import { memberTier, sameModel, whoOfMember } from '../core/tier';
import { acquireLock, runsDir } from './lock';
import { applyReviews, closeStint, gateStint, projectConfig, projectConfigSafe, refreshBrief, track } from './track';

/**
 * 接力台调度：替你让某个 AI 接着做一棒；或者「全自动」一直接力下去——
 * 额度用完换下一位，有待复核就先派强模型复核，任务清单全部打勾后请强模型终审，都没额度了就等。
 * 派活（任务是在「派活」页写的）：强模型先把任务拆成小步，干活只派弱模型、一棒一步；中途不复核，
 * 清单做完后终审的强模型一起复核所有弱模型的棒（实测每次复核都接近直接做一遍，中途复核最费强模型）。
 * 弱模型都用不了时不换强模型干活，等额度或停下。
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

/** 这个进程是不是当时派出去的那个工具（进程号可能已经被别的程序用了：命令对不上就不动它）。 */
/**
 * 工具那一组里还活着的进程（工具是 detached 起的，自成一组，组号就是它的进程号）。
 * 只看组长不够：Codex 记下的是外层的 node 启动器，干活的是它起的子进程，启动器没了子进程还在接着改文件（2026-09-28 实测）。
 * 组里得有这个工具的命令（完整路径，或者可执行文件同名），防止组号被别的程序重用。
 */
function toolGroup(pgid: number, exe: string | undefined): number[] {
  if (!exe) return [];
  const r = spawnSync('ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  const group = (r.stdout ?? '').split('\n').flatMap((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return m && Number(m[2]) === pgid ? [{ pid: Number(m[1]), cmd: m[3] }] : [];
  });
  const name = `/${path.basename(exe)}`;
  return group.some((x) => x.cmd.includes(exe) || (x.cmd.split(/\s+/)[0] ?? '').endsWith(name)) ? group.map((x) => x.pid) : [];
}

/** 上次接力台被关掉时留下、还在跑的工具（连同它起的子进程）：结束掉（不然两个 AI 同时改一个文件夹）。返回结束了没有。 */
function killLeftover(prev: GoState | null): boolean {
  const pid = prev?.current?.toolPid;
  if (!pid || !prev || pidAlive(prev.pid)) return false;
  const group = toolGroup(pid, prev.current?.toolExe);
  if (!group.length) return false;
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

/** 清单里的一步（第几步从 1 数）。 */
interface Step {
  index: number;
  text: string;
}

/** 清单里下一步还没做的。步骤自己写了「第 3 步：」的去掉（不然提示和卡片上都是「第 3 步：第 3 步：……」）。 */
function nextStep(task: TaskDoc): Step | undefined {
  const i = task.items.findIndex((x) => !x.done);
  return i < 0 ? undefined : { index: i + 1, text: task.items[i].text.replace(/^第\s*[\d一二三四五六七八九十百]+\s*步\s*[：:.、，,]?\s*/, '') || task.items[i].text };
}

/** 这个任务是什么时候写下的（没有就是接入的时候）。 */
function taskSince(v: LedgerView): number {
  return Date.parse([...v.events].reverse().find((e) => e.type === 'task')?.ts ?? v.init?.ts ?? '');
}

/** 这个任务派活时拆过没有：任务写下之后有一棒拆解交接了。 */
function planned(v: LedgerView): boolean {
  const since = taskSince(v);
  return v.stints.some((s) => s.kind === 'plan' && s.status === 'handed' && !s.rolledBack && !(Date.parse(s.startedAt) < since));
}

interface StintOutcome {
  stint: Stint;
  /** 这一棒改了文件没有。 */
  changed: boolean;
  handoff: HandoffDoc | null;
  finalText: string;
  error?: string;
}

class GoRunner {
  readonly state: GoState;
  private stopRequested = false;
  private current: RunHandle | null = null;
  /** 这次出过错的人（不再派给他）。 */
  private readonly failed = new Set<string>();
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
  private async runTool(logAbs: string, title: string, invoke: () => Invocation, timeoutMs: number, mayRetry: () => boolean, harness?: string): Promise<RunResult> {
    let blips = 0;
    for (let attempt = 0; ; attempt++) {
      const inv = invoke();
      const h = startRun({ invocation: inv, cwd: this.root, timeoutMs, logPath: logAbs, title, onLine: this.hooks.onLine });
      this.current = h;
      if (h.pid && this.state.current) {
        this.state.current.toolPid = h.pid;
        this.state.current.toolExe = inv.argv[0];
        this.save();
      }
      const r = await h.done;
      this.current = null;
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

  /** 让一位成员跑一棒（干活 / 复核 / 终审 / 拆解）。step：派活时这一棒只做清单里的哪一步。 */
  async runStint(m: MemberInfo, kind: Stint['kind'], targets: Stint[] = [], step?: Step): Promise<StintOutcome> {
    const root = this.root;
    const cfg = projectConfig(root);
    // 先把文件夹里的事对上账：有人（你自己在别的工具里）改到一半的，算它一棒，结束掉。
    track(root);
    let v = loadLedger(root);
    if (v.open && v.open.via === 'native') {
      // 它刚才还在改文件：没你确认它停了，就不换人（换了就是两个 AI 同时改一个文件夹）。
      const active = nativeActive(v);
      if (active && !this.opts.force) throw nativeActiveError(active);
      const h = v.open.handoff ? readHandoff(root, v.open.handoff) : null;
      const idle = Math.round((Date.now() - Date.parse(v.open.activeAt ?? v.open.startedAt)) / 60_000);
      const note = active
        ? `${nameOf(m)} 接手时这一棒没交接，已确认它停下`
        : `${nameOf(m)} 接手时这一棒没交接：${idle} 分钟没改文件，账面上结束`;
      closeStint(root, { ...v.open, ...(active ? { stopConfirmed: true } : {}) }, { status: h ? 'handed' : 'unfinished', to: takeSnapshot(root, '换人接手').sha, handoff: h, note }, cfg);
      v = loadLedger(root);
    }
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
    log(`# ${stintTitle(stint)}（${tierWord(who.tier)}）${what}${targets.length ? `：第 ${targets.map((t) => t.id).join('、')} 棒` : ''}${step ? `：清单第 ${step.index} 步` : ''}`);

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
    const timeoutMs = (kind === 'work' ? this.settings.stintTimeoutMin : this.settings.reviewTimeoutMin) * 60_000;

    let finalText = '';
    let error: string | undefined;
    let stopped = false;
    let quotaText = '';
    /** 工具自己报出来的实际模型（比如 --model opus 实际是 claude-opus-5-5）。 */
    let actualModel: string | undefined;
    /** 工具自己报的额度窗口：Claude Code 在输出里报，Codex 记在它自己的会话里。 */
    let limits: Limit[] | undefined;
    try {
      if (m.kind === 'harness') {
        const spec = findHarness(m.harness);
        const loc = spec ? locateCached(spec) : null;
        if (!spec || !loc) throw new RelayError('找不到这个工具了。', 'no-tool');
        const r = await this.runTool(
          logAbs,
          stintTitle(stint),
          () => spec.invoke(loc, { cwd: root, prompt, level: this.settings.level, readOnly: false, model: m.agent.model?.trim() || undefined, effort: m.agent.effort, outFile: tmpOut() }),
          timeoutMs,
          () => takeSnapshot(root, '看看改了没有').sha === from,
          spec.id
        );
        finalText = r.finalText;
        stopped = r.stopped;
        actualModel = r.model;
        limits = r.limits ?? spec.limits?.(root, Date.parse(stint.startedAt)) ?? undefined;
        // 认额度只看工具自己报的话（出错信息、标准错误、日志里的「出错」「提示」）和最后一句话，不看 AI 说的话、搜的词：
        // 任务本身讲限流、额度时，那些话里全是 rate limit、quota。
        const failed = !r.stopped && (!!r.error || r.timedOut || r.code !== 0);
        const own = toolLines(logTail(logAbs, 6000));
        quotaText = `${r.error ?? ''}\n${r.stderrTail}\n${own}\n${r.finalText.slice(-2000)}`;
        if (failed) {
          const hint = explainFailure(m.harness, `${r.error ?? ''}\n${r.stderrTail}\n${r.finalText}`);
          error = r.error ?? (r.timedOut ? (r.late ?? cause.overtime(timeoutMs)) : hint ?? cause.exit(r.code, clip(lastError(r.stderrTail, own), 200)));
        }
      } else if (m.kind === 'api' && m.agent.api) {
        log(`（接力台内置小代理：${m.agent.api.baseUrl} · ${m.agent.api.model}）`);
        let brief = '';
        try {
          brief = fs.readFileSync(path.join(root, BRIEF_REL), 'utf8');
        } catch {
          /* 没有接力本 */
        }
        const r = await runLlmAgent({
          spec: m.agent.api,
          cwd: root,
          brief: `${prompt}\n\n---\n下面是接力本（${BRIEF_REL}）全文：\n\n${brief}`,
          level: this.settings.level,
          gateCommand: gate,
          protectedPaths: cfg.protectedPaths,
          log,
          shouldStop: () => this.stopRequested,
          deadline: Date.now() + timeoutMs,
          maxSteps: kind === 'work' ? 80 : 60,
        });
        finalText = r.finalText;
        stopped = r.stopped;
        error = r.error ? plain(r.error) : r.timedOut ? cause.overtime(timeoutMs) : undefined;
        quotaText = `${r.error ?? ''}`;
        log(`结束（${r.steps} 步${error ? `，${error}` : ''}）`);
      } else {
        throw new RelayError('桌面程序不能派活', 'cannot-drive');
      }
    } catch (e) {
      error = errorMessage(e);
      log(`出错：${error}`);
    }

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
      noteError(m.name);
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
    const tokens = usageTotal(logText) ?? findHarness(m.harness)?.usage?.(root, Date.parse(stint.startedAt)) ?? null;
    const closed = closeStint(root, { ...stint, who: ran, pid: process.pid, ...(tokens ? { tokens } : {}) }, { status, to, handoff: h, lastWords: finalText, ...(note ? { note } : {}), ...(quotaUntil ? { quotaUntil } : {}) }, cfg);
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

  /** 挑一位：能调度、没在等额度、这次没出过错。tier = 只要强的 / 只要弱的 / 都行。 */
  private pick(tier: Tier, exclude: string[] = []): MemberInfo | null {
    return readyMembers(this.members()).find((m) => !this.failed.has(m.name) && !exclude.includes(m.name) && (tier === 'any' || m.tier === tier)) ?? null;
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

  // ---- 只跑一棒 ----

  async once(): Promise<GoState> {
    try {
      const v = requireInit(this.root);
      const kind = this.opts.kind ?? 'work';
      const all = this.members();
      let m: MemberInfo | null = null;
      if (this.opts.who) {
        m = all.find((x) => x.name === this.opts.who) ?? null;
        if (!m) throw new RelayError(`名单里没有「${this.opts.who}」`, 'no-agent');
        if (!m.canWork) throw new RelayError(`${nameOf(m)} 不能派活：${plain(m.why ?? '不能用')}`, 'cannot-drive');
      } else {
        m = this.pick(kind === 'review' ? 'strong' : 'any');
        if (!m) throw new RelayError(kind === 'review' ? '没有能复核的强模型：都没额度或没登录' : '没有能派活的成员：都没额度或没登录', 'nobody');
      }
      if (kind === 'review') {
        if (m.tier !== 'strong') throw new RelayError(`${nameOf(m)} 不能复核：它算弱模型，复核要强模型`, 'weak-reviewer');
        const targets = pendingReviews(v);
        if (!targets.length) return this.finish('done', '没有待复核的棒');
        const o = await this.runStint(m, 'review', targets);
        return this.finishOnce(o);
      }
      // 派活时指定一位弱模型：它只做清单里下一步（强模型拆好的）。
      const o = await this.runStint(m, 'work', [], this.dispatch && m.tier === 'weak' ? nextStep(readTask(this.root)) : undefined);
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
        if (this.stopRequested) return this.finish('stopped', '全自动已停止：改到一半的内容还在文件夹里');
        track(this.root);
        const v = loadLedger(this.root);
        const task = readTask(this.root);
        if (task.empty) return this.finish('needs-human', '全自动停止：还没写任务');
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
            if (weakOnly) return this.finish('needs-human', `全自动停止：第 ${ids} 棒复核两次都不算数，${anon ? '认不出复核是谁写的' : '写复核的都是弱模型'}`);
            const dropped = new Set(v.stints.filter((x) => x.rolledBack).map((x) => x.id));
            const why = stuck.map((p) => {
              const last = countedReviews(p, dropped).at(-1);
              return last ? `第 ${p.id} 棒复核结论「${verdictWord(last.verdict)}」（${last.byLabel}，${last.file}）` : `第 ${p.id} 棒两次都没写结论`;
            });
            return this.finish('needs-human', `全自动停止：复核两次没过，${why.join('；')}`);
          }
          const authors = pending.map((p) => p.who.member).filter(Boolean) as string[];
          const reviewer = this.pick('strong', authors) ?? this.pick('strong');
          if (reviewer) {
            await this.runStint(reviewer, 'review', pending);
            continue;
          }
        }

        // 2. 清单全部打勾：按验收来——复核、终审、检查都过了才收工（只有验收说通过才算完成）。
        if (taskComplete(task)) {
          if (pending.length && !merge) {
            const c = this.earliestCooling('strong');
            if (c && (await this.waitFor(c, '清单都打勾了，还有棒待复核，强模型都没额度'))) continue;
            return this.finish('needs-human', `全自动停止：清单都打勾了，第 ${pending.map((p) => p.id).join('、')} 棒待复核，没有能用的强模型`);
          }
          const conf = projectConfigSafe(this.root);
          const acc = acceptance({ ledger: v, task, gateCommand: conf.cfg.gate.command.trim(), ...(conf.error ? { configError: conf.error } : {}), finalRequired: this.settings.finalReview });
          if (acc.state === 'accepted') return this.finish('done', acc.headline);
          if (acc.state === 'unknown') return this.finish('needs-human', acc.headline);
          if (!acc.final.ok) {
            const live = v.stints.filter((x) => !x.rolledBack && x.status !== 'working');
            const lastWork = [...live].reverse().find((x) => x.kind === 'work');
            const finals = live.filter((x) => x.kind === 'final' && x.id > (lastWork?.id ?? 0));
            if (finals.length >= 2) return this.finish('needs-human', `全自动停止：终审两次没过，${acc.final.text}`);
            // 终审换一双眼睛：有别的强模型，就不请这个任务里干过活的来审；实际跑成弱模型的不再请。
            const since = taskSince(v);
            const doers = v.stints.filter((x) => x.kind === 'work' && !x.rolledBack && !(Date.parse(x.startedAt) < since)).map((x) => x.who.member).filter((x): x is string => !!x);
            const weak = [...this.weakFinals];
            const fr = this.pick('strong', [...doers, ...weak]) ?? this.pick('strong', weak);
            if (fr) {
              const o = await this.runStint(fr, 'final', merge ? pending : []);
              if (merge) this.merged = true;
              if (o.stint.status === 'failed') this.failed.add(fr.name);
              if (o.stint.who.tier !== 'strong') this.weakFinals.add(fr.name);
              continue;
            }
            const c = this.earliestCooling('strong');
            if (c && (await this.waitFor(c, '清单都打勾了，要终审，强模型都没额度'))) continue;
            return this.finish('needs-human', `全自动停止：清单都打勾了，${acc.final.text}，没有能用的强模型`);
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
          return this.finish('needs-human', acc.headline);
        }

        // 3. 派活：这个任务还没拆过，先请强模型拆成小步。
        if (dispatch && !planned(v)) {
          const planner = this.pick('strong');
          if (!planner) {
            const c = this.earliestCooling('strong');
            if (c && (await this.waitFor(c, '派活要先请强模型拆解，强模型都没额度'))) continue;
            return this.finish('needs-human', '全自动停止：派活要先请强模型拆解，没有能用的强模型');
          }
          const o = await this.runStint(planner, 'plan');
          // 没拆成（出错、没交接）：这次不再请它拆，换一位强模型；额度用完的自己会被跳过。
          if (o.stint.status !== 'handed') {
            if (o.stint.status !== 'quota' && o.stint.status !== 'stopped') this.failed.add(planner.name);
            continue;
          }
          if (!taskProgress(readTask(this.root)).total) return this.finish('needs-human', `全自动停止：第 ${o.stint.id} 棒（${whoName(o.stint.who)}）拆解之后清单还是空的`);
          continue;
        }

        // 4. 派人干活（派活时只派弱模型，一棒做清单里的一步）。
        // 派活一棒只做一步：上限至少是步数的两倍（每步留一次重做），不然清单一长就停在半路
        const cap = dispatch ? Math.max(this.settings.maxStints, task.items.length * 2) : this.settings.maxStints;
        if (stints >= cap) return this.finish('needs-human', `全自动停止：接力到上限 ${stints} 棒，任务还没做完`);
        const w = this.pick(dispatch ? 'weak' : 'any');
        if (!w && dispatch) {
          // 弱模型都用不了：按「等额度」等最早恢复的弱模型，或者停下。不换强模型干活，也不复核（做到哪写在页面上，复核你来点）。
          const c = this.earliestCooling('weak');
          if (c && (await this.waitFor(c, '派活的弱模型都没额度'))) continue;
          return this.finish('needs-human', `全自动停止：没有能用的弱模型${this.weakWhy()}`);
        }
        if (!w) {
          const c = this.earliestCooling('any');
          if (c && (await this.waitFor(c, '能派活的都没额度'))) continue;
          const failed = [...this.failed].join('、');
          return this.finish('needs-human', `全自动停止：没有能派活的成员，都没额度或没登录${failed ? `；这次出错的：${failed}` : ''}`);
        }
        const before = taskProgress(task).done;
        const o = await this.runStint(w, 'work', [], dispatch ? nextStep(task) : undefined);
        stints++;
        if (o.stint.status === 'stopped') continue;
        if (o.stint.status === 'quota') continue;
        if (o.stint.status === 'failed' && !o.changed) {
          this.failed.add(w.name);
          continue;
        }
        const after = taskProgress(readTask(this.root)).done;
        if (!o.changed && after <= before) {
          idle++;
          if (o.handoff?.state === 'stuck' || idle >= 2) {
            if (dispatch) {
              // 派活：这位弱模型这次不再派，换别的弱模型。
              this.failed.add(w.name);
              idle = 0;
              continue;
            }
            if (w.tier !== 'strong' && this.pick('strong', [w.name])) {
              this.failed.add(w.name);
              idle = 0;
              continue;
            }
            return this.finish('needs-human', `全自动停止：${nameOf(w)} 做不下去了${o.handoff?.next ? `，原话：${clip(plain(o.handoff.next), 200)}` : ''}`);
          }
        } else idle = 0;
      }
      return this.finish('needs-human', '全自动停止：步骤超过上限');
    } catch (e) {
      return this.finish(e instanceof RelayError && e.code === 'native-active' ? 'needs-human' : 'failed', errorMessage(e));
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
