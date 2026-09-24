import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAutoSettings, normalizeAutoSettings, type AutoSettings } from '../core/auto-settings';
import { errorMessage, RelayError } from '../core/errors';
import { explainFailure, findHarness, locateCached, type Invocation } from '../core/harness';
import { loadLedger, nextStintId, pendingReviews, requireInit, saveStint, stintTitle, tierWord, type Stint } from '../core/ledger';
import { runLlmAgent } from '../core/llm-agent';
import { pidAlive } from '../core/proc';
import { allMembers, orderMembers, readyMembers, type MemberInfo } from '../core/members';
import { BRIEF_REL, fileStamp, handoffFileFor, listHandoffFiles, readHandoff, readTask, REVIEW_DIR, taskComplete, taskProgress, type HandoffDoc } from '../core/notes';
import { finalPrompt, reviewPrompt, workPrompt } from '../core/prompts';
import { clearQuota, detectQuota, markQuota, untilText } from '../core/quota';
import { clip, logTail, looksLikeNetworkBlip, startRun, type RunHandle, type RunResult } from '../core/runner';
import { takeSnapshot } from '../core/snap';
import { memberTier, sameModel, whoOfMember } from '../core/tier';
import { applyReviews, closeStint, gateStint, projectConfig, refreshBrief, track } from './track';

/**
 * 接力台调度：替你让某个 AI 接着做一棒；或者「全自动」一直接力下去——
 * 额度用完换下一位，有待复核就先派强模型复核，任务清单全部打勾后请强模型终审，都没额度了就等。
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
  current?: { stint: number; member: string; label: string; kind: Stint['kind']; since: string; log: string; toolPid?: number };
  /** 在等谁的额度恢复。 */
  waitingUntil?: string;
  /** 这次跑过的棒。 */
  stints: number[];
  startedAt: string;
  updatedAt: string;
  result?: string;
  level: AutoSettings['level'];
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
}

export interface GoHooks {
  onUpdate?: (s: GoState) => void;
  onLine?: (line: string) => void;
}

function runsDir(root: string): string {
  return path.join(root, '.relay', 'runs');
}

export function goStatePath(root: string): string {
  return path.join(runsDir(root), 'state.json');
}

function stopFlag(root: string): string {
  return path.join(runsDir(root), 'stop');
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

export function goActive(root: string): boolean {
  if (runners.has(path.resolve(root))) return true;
  const s = loadGoState(root);
  return !!s && (s.status === 'running' || s.status === 'waiting');
}

export function stopGo(root: string): boolean {
  const r = runners.get(path.resolve(root));
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

export function stopAllGo(): void {
  for (const r of runners.values()) r.stop();
}

/** 上次接力台被关掉时留下、还在跑的工具进程：结束掉（不然两个 AI 同时改一个文件夹）。 */
function killLeftover(prev: GoState | null): void {
  const pid = prev?.current?.toolPid;
  if (!pid || !prev || pidAlive(prev.pid) || !pidAlive(pid)) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经没了 */
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function tmpOut(): string {
  return path.join(os.tmpdir(), `relay-out-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.txt`);
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

  constructor(
    private readonly root: string,
    private readonly settings: AutoSettings,
    private readonly opts: GoOptions,
    private readonly hooks: GoHooks
  ) {
    const t = nowIso();
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

  /** 跑一次编程工具；像是网络抖了一下（而且还没改文件）就原地再试一次。 */
  private async runTool(logAbs: string, title: string, invoke: () => Invocation, timeoutMs: number, mayRetry: () => boolean): Promise<RunResult> {
    for (let attempt = 0; ; attempt++) {
      const h = startRun({ invocation: invoke(), cwd: this.root, timeoutMs, logPath: logAbs, title, onLine: this.hooks.onLine });
      this.current = h;
      if (h.pid && this.state.current) {
        this.state.current.toolPid = h.pid;
        this.save();
      }
      const r = await h.done;
      this.current = null;
      if (attempt > 0 || r.stopped || r.timedOut || r.code === 0 || this.stopRequested || !mayRetry()) return r;
      const text = `${r.error ?? ''}\n${r.stderrTail}\n${logTail(logAbs)}`;
      if (detectQuota(text).hit || !looksLikeNetworkBlip(text)) return r;
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

  /** 让一位成员跑一棒（干活 / 复核 / 终审）。 */
  async runStint(m: MemberInfo, kind: Stint['kind'], targets: Stint[] = []): Promise<StintOutcome> {
    const root = this.root;
    const cfg = projectConfig(root);
    // 先把文件夹里的事对上账：有人（你自己在别的工具里）改到一半的，算它一棒，结束掉。
    track(root);
    let v = loadLedger(root);
    if (v.open && v.open.via === 'native') {
      const h = v.open.handoff ? readHandoff(root, v.open.handoff) : null;
      closeStint(root, v.open, { status: h ? 'handed' : 'unfinished', to: takeSnapshot(root, '换人接手').sha, handoff: h, note: `接力台派 ${m.label} 接手时，这一棒还没交接。` }, cfg);
      v = loadLedger(root);
    }
    const from = takeSnapshot(root, `第 ${nextStintId(v)} 棒开始前`).sha;
    const id = nextStintId(v);
    const handoff = handoffFileFor(root, id, m.harness ?? m.name);
    const logRel = `.relay/runs/第${id}棒-${fileStamp()}-${m.name}.log`;
    const logAbs = path.join(root, logRel);
    const who = whoOfMember(m);
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
    };
    saveStint(root, stint);
    refreshBrief(root);
    const handoffsBefore = new Set(listHandoffFiles(root).map((f) => f.rel));
    const what = kind === 'review' ? '复核' : kind === 'final' ? '终审' : '干活';
    this.state.current = { stint: id, member: m.name, label: who.label, kind, since: stint.startedAt, log: logRel };
    this.state.stints.push(id);
    this.phase(`第 ${id} 棒：${who.label} 正在${what}…`);
    const log = this.logger(logAbs);
    log(`# ${stintTitle(stint)}（${tierWord(who.tier)}）${what}${targets.length ? `：第 ${targets.map((t) => t.id).join('、')} 棒` : ''}`);

    const gate = cfg.gate.command.trim();
    let prompt: string;
    if (kind === 'review') {
      prompt = reviewPrompt({ id, label: who.label, handoff, gateCommand: gate, targets: targets.map((t) => ({ id: t.id, label: t.who.label, tierWord: tierWord(t.who.tier) })) });
    } else if (kind === 'final') {
      const base = v.task?.snap ?? v.init?.snap ?? from;
      prompt = finalPrompt({ id, label: who.label, handoff, gateCommand: gate, from: base, to: from, reviewFile: `${REVIEW_DIR}/终审-${fileStamp()}.md` });
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
          () => takeSnapshot(root, '看看改了没有').sha === from
        );
        finalText = r.finalText;
        stopped = r.stopped;
        actualModel = r.model;
        quotaText = `${r.error ?? ''}\n${r.stderrTail}\n${logTail(logAbs, 6000)}\n${r.finalText.slice(-2000)}`;
        if (!r.stopped && (r.error || r.timedOut || r.code !== 0)) {
          const said = clip(r.stderrTail.split('\n').filter(Boolean).slice(-2).join(' '), 200);
          const hint = explainFailure(m.harness, `${r.error ?? ''}\n${r.stderrTail}\n${r.finalText}`);
          error = r.error ?? (r.timedOut ? `超过 ${Math.round(timeoutMs / 60000)} 分钟，停掉了` : hint ?? `退出码 ${r.code}${said ? `：${said}` : ''}`);
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
        error = r.error ?? (r.timedOut ? `超过 ${Math.round(timeoutMs / 60000)} 分钟，停掉了` : undefined);
        quotaText = `${r.error ?? ''}`;
        log(`结束（${r.steps} 步${error ? `，${error}` : ''}）`);
      } else {
        throw new RelayError('接力台调度不了它（桌面程序要你自己打开）。', 'cannot-drive');
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
    const quota = error || !finalText || from === to ? detectQuota(quotaText) : { hit: false as const };
    let status: Stint['status'] = 'handed';
    let note: string | undefined;
    let quotaUntil: string | undefined;
    if (stopped || this.stopRequested) {
      status = 'stopped';
      note = '你叫停了。';
    } else if (quota.hit) {
      status = 'quota';
      const e = markQuota(m.name, quota);
      quotaUntil = e.until;
      note = `额度用完了（${untilText(e.until)}）：${clip(quota.line ?? '', 160)}`;
      log(note);
    } else if (error) {
      status = 'failed';
      note = error;
    } else {
      clearQuota(m.name);
    }
    const ran = actualModel && !(who.model && who.model === actualModel) ? { ...who, model: actualModel, label: `${m.label} · ${actualModel}`, tier: who.model && sameModel(who.model, actualModel) ? who.tier : memberTier(m.agent, actualModel) } : who;
    const closed = closeStint(root, { ...stint, who: ran, pid: process.pid }, { status, to, handoff: h, lastWords: finalText, ...(note ? { note } : {}), ...(quotaUntil ? { quotaUntil } : {}) }, cfg);
    if (kind !== 'work' || closed.facts?.files) await gateStint(root, id, cfg).catch(() => undefined);
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
    return orderMembers(allMembers(this.settings.level), this.settings.order);
  }

  /** 挑一位：能调度、没在等额度、这次没出过错。strong = 只要强的。 */
  private pick(strong: boolean, exclude: string[] = []): MemberInfo | null {
    const list = readyMembers(this.members()).filter((m) => !this.failed.has(m.name) && !exclude.includes(m.name));
    return (strong ? list.find((m) => m.tier === 'strong') : list[0]) ?? null;
  }

  /** 最早恢复额度的那一位（只看强的 / 看所有能调度的）。 */
  private earliestCooling(strong: boolean): MemberInfo | null {
    const list = this.members().filter((m) => m.canWork && m.cooling && !this.failed.has(m.name) && (!strong || m.tier === 'strong'));
    return list.sort((a, b) => new Date(a.cooling!).getTime() - new Date(b.cooling!).getTime())[0] ?? null;
  }

  private async waitFor(m: MemberInfo, why: string): Promise<boolean> {
    if (!this.settings.waitForQuota || !m.cooling) return false;
    const ms = Math.max(0, new Date(m.cooling).getTime() - Date.now()) + 30_000;
    this.state.status = 'waiting';
    this.state.waitingUntil = m.cooling;
    this.phase(`${why}等 ${m.label} 的额度恢复（${untilText(m.cooling)}）。`);
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
        if (!m) throw new RelayError(`名单里没有「${this.opts.who}」。`, 'no-agent');
        if (!m.canWork) throw new RelayError(`「${m.label}」接力台调度不了：${m.why ?? '不能用'}。`, 'cannot-drive');
      } else {
        m = this.pick(kind === 'review');
        if (!m) throw new RelayError(kind === 'review' ? '现在没有能复核的强模型（都没额度了，或者没登录）。' : '现在没有能调度的 AI（都没额度了，或者没登录）。', 'nobody');
      }
      if (kind === 'review') {
        if (m.tier !== 'strong') throw new RelayError(`复核要强模型来做：${m.label}${m.model ? `（${m.model}）` : ''}算弱，它写的复核不算数。换一位强模型；你觉得它其实够强，就在「设置」里把它改成强。`, 'weak-reviewer');
        const targets = pendingReviews(v);
        if (!targets.length) return this.finish('done', '没有待复核的棒。');
        const o = await this.runStint(m, 'review', targets);
        return this.finishOnce(o, '复核');
      }
      const o = await this.runStint(m, 'work');
      return this.finishOnce(o, '这一棒');
    } catch (e) {
      return this.finish('failed', errorMessage(e));
    }
  }

  private finishOnce(o: StintOutcome, what: string): GoState {
    const s = o.stint;
    if (s.status === 'stopped') return this.finish('stopped', `已停止。第 ${s.id} 棒改到一半的东西都在文件夹里，账上也记了。`);
    if (s.status === 'quota') return this.finish('needs-human', `${s.who.label} 额度用完了（${s.quotaUntil ? untilText(s.quotaUntil) : '不知道什么时候恢复'}）。换一位接着做吧。`);
    if (s.status === 'failed') return this.finish('failed', `${s.who.label} 出错了：${s.note ?? ''}`);
    const rv = s.review === 'needed' ? '（弱模型的活，等强模型复核）' : '';
    return this.finish('done', `${what}做完了：${s.summary || (o.changed ? '改了文件' : '没改文件')}${rv}`);
  }

  // ---- 全自动 ----

  async auto(): Promise<GoState> {
    let stints = 0;
    let idle = 0;
    try {
      requireInit(this.root);
      for (let guard = 0; guard < this.settings.maxStints * 3 + 10; guard++) {
        if (this.stopRequested) return this.finish('stopped', '已停止。改到一半的东西都在文件夹里，账上也记了；随时可以接着跑。');
        track(this.root);
        const v = loadLedger(this.root);
        const task = readTask(this.root);
        if (task.empty) return this.finish('needs-human', '还没写下要做什么。先写任务，再开全自动。');
        const pending = pendingReviews(v);

        // 1. 有待复核、又有强模型能用：先复核。
        if (pending.length) {
          const stuck = pending.filter((p) => (this.reviewTries.get(p.id) ?? 0) >= 2);
          if (stuck.length) return this.finish('needs-human', `第 ${stuck.map((p) => p.id).join('、')} 棒复核了两次都没写出结论。你看一下复核的日志，或者自己看看它们的改动。`);
          const authors = pending.map((p) => p.who.member).filter(Boolean) as string[];
          const reviewer = this.pick(true, authors) ?? this.pick(true);
          if (reviewer) {
            await this.runStint(reviewer, 'review', pending);
            continue;
          }
        }

        // 2. 清单全部打勾：等复核、终审，然后收工。
        if (taskComplete(task)) {
          if (pending.length) {
            const c = this.earliestCooling(true);
            if (c && (await this.waitFor(c, '活干完了，但还有弱模型的棒要复核；强模型都没额度，'))) continue;
            return this.finish('needs-human', '任务清单都打勾了，但还有弱模型做的棒没人复核（强模型都没额度，或者没有强模型）。等强模型额度恢复后再开全自动，会先复核。');
          }
          const lastLive = [...v.stints].reverse().find((x) => !x.rolledBack && x.status !== 'working');
          if (this.settings.finalReview && lastLive?.kind !== 'final') {
            const fr = this.pick(true);
            if (fr) {
              await this.runStint(fr, 'final');
              continue;
            }
            const c = this.earliestCooling(true);
            if (c && (await this.waitFor(c, '活干完了，要请强模型终审；强模型都没额度，'))) continue;
          }
          const gateFail = [...v.stints].reverse().find((x) => x.gate)?.gate?.status === 'fail';
          if (gateFail) return this.finish('needs-human', '任务清单都打勾了，但最近一次检查没通过。');
          const p = taskProgress(task);
          return this.finish('done', `完成：任务清单 ${p.done}/${p.total} 全部打勾${lastLive?.kind === 'final' ? `，${lastLive.who.label} 终审过了` : ''}。`);
        }

        // 3. 派人干活。
        if (stints >= this.settings.maxStints) return this.finish('needs-human', `已经接力了 ${stints} 棒，任务还没做完。看看进度，想继续就再开一次全自动。`);
        const w = this.pick(false);
        if (!w) {
          const c = this.earliestCooling(false);
          if (c && (await this.waitFor(c, '能干活的都没额度了，'))) continue;
          const failed = [...this.failed].join('、');
          return this.finish('needs-human', `没有能干活的 AI 了${failed ? `（这次出错的：${failed}）` : ''}。额度恢复、或者登录好之后再开全自动。`);
        }
        const before = taskProgress(task).done;
        const o = await this.runStint(w, 'work');
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
            if (w.tier !== 'strong' && this.pick(true, [w.name])) {
              this.failed.add(w.name);
              idle = 0;
              continue;
            }
            return this.finish('needs-human', `${w.label} 说做不下去了${o.handoff?.next ? `：${clip(o.handoff.next, 200)}` : ''}。看看它的交接，给点指示再继续。`);
          }
        } else idle = 0;
      }
      return this.finish('needs-human', '步骤太多了，为防止死循环先停下。');
    } catch (e) {
      return this.finish('failed', errorMessage(e));
    }
  }
}

/**
 * 开始调度（只跑一棒 / 全自动）。准备工作同步做完、出错直接抛；真正的活在后台跑，done 在结束时兑现。
 */
export function startGo(root: string, opts: GoOptions, hooks: GoHooks = {}): { state: GoState; done: Promise<GoState> } {
  const abs = path.resolve(root);
  requireInit(abs);
  const prev = loadGoState(abs);
  if (runners.has(abs) || (prev && (prev.status === 'running' || prev.status === 'waiting'))) {
    throw new RelayError('接力台已经在调度这个项目了。先停下，再换人。', 'busy');
  }
  killLeftover(prev);
  const settings = normalizeAutoSettings({ ...loadAutoSettings(), ...(opts.settings ?? {}) });
  const runner = new GoRunner(abs, settings, opts, hooks);
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
  });
  return { state: runner.state, done };
}

export function runGo(root: string, opts: GoOptions, hooks: GoHooks = {}): Promise<GoState> {
  return startGo(root, opts, hooks).done;
}
