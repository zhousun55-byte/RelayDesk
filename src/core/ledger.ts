import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from './errors';

/**
 * 账本 .relay/journal.jsonl：每一棒、每次退回、每次换任务，只追加不改写。
 * 一棒的信息会更新好几次（开始、有了交接、结束、被复核），每次追加一整条，读的时候按编号取最后一条。
 */

export type Tier3 = 'strong' | 'weak' | 'unknown';

export interface Who {
  /** 工人名单里的名字；认不出来就没有。 */
  member?: string;
  /** 给人看的：Codex · gpt-6 */
  label: string;
  /** 编程工具（harness id）或桌面程序名。 */
  tool?: string;
  model?: string;
  tier: Tier3;
  /** 交接里它自己写的身份（和认出来的不一样时留着原话）。 */
  claimed?: string;
}

export interface Facts {
  files: number;
  added: number;
  removed: number;
  /** 改到的文件（最多 200 个）。 */
  paths: string[];
}

export interface GateInfo {
  status: 'pass' | 'fail';
  command: string;
  detail?: string;
}

/**
 * working 进行中 / handed 交接了 / unfinished 没留交接就停了（多半是额度用完被打断）/
 * quota 接力台调度时碰到额度用完 / failed 出错 / stopped 被叫停
 */
export type StintStatus = 'working' | 'handed' | 'unfinished' | 'quota' | 'failed' | 'stopped';

/** needed 待复核 / done 复核过了 / skip 不用复核（强模型做的，或你标记过） */
export type ReviewState = 'needed' | 'done' | 'skip';

/** 复核结论：ok 没问题 / fixed 有问题已修好 / reverted 改坏了已退回 / problem 有问题还没修 / unknown 没写清楚 */
export type Verdict = 'ok' | 'fixed' | 'reverted' | 'problem' | 'unknown';

export interface ReviewMark {
  /** 哪一棒复核的。 */
  by: number;
  byLabel: string;
  file: string;
  verdict: Verdict;
  at: string;
  /** 写复核的是弱模型（或者是它自己复核自己）：不算数，还要强模型再核。 */
  weak?: boolean;
  /** 是谁写的由 Claude Code 的会话记录认定（以后不用再核）。 */
  byLog?: boolean;
}

export interface Stint {
  /** 第几棒。 */
  id: number;
  /** work 干活 / review 复核 / final 终审 */
  kind: 'work' | 'review' | 'final';
  who: Who;
  /** relay = 接力台调度的；native = 你自己在工具里干的，接力台看到了。 */
  via: 'relay' | 'native';
  startedAt: string;
  endedAt?: string;
  /** 开始时的快照。 */
  from: string;
  /** 结束时的快照。 */
  to?: string;
  status: StintStatus;
  /** 交接文件（相对项目根目录）。 */
  handoff?: string;
  /** 交接是接力台代写的（它自己没写）。 */
  ghost?: boolean;
  /** 一句话：做了什么。 */
  summary?: string;
  facts?: Facts;
  gate?: GateInfo;
  protectedHits?: string[];
  review: ReviewState;
  reviews?: ReviewMark[];
  /** 复核棒：复核的是哪几棒。 */
  targets?: number[];
  /** 接力台调度时的日志（相对项目根目录）。 */
  log?: string;
  /** 接力台的说明（额度用完、出错的原因、你标记过……）。 */
  note?: string;
  /** 额度什么时候恢复（碰到额度用完时）。 */
  quotaUntil?: string;
  /** 这一棒之后被退回到了更早的地方：它的改动已经不在了。 */
  rolledBack?: boolean;
  /** 最近一次看到它改文件的时间（自己干的棒：多久没动静算停了）。 */
  activeAt?: string;
  /** 接力台调度的棒：跑它的接力台进程（进程没了还显示进行中，就是接力台中途被关了）。 */
  pid?: number;
}

export interface InitEvent {
  type: 'init';
  ts: string;
  /** 接入时的快照：第 1 棒从这里开始算。 */
  snap: string;
  version?: string;
}

export interface StintEvent {
  type: 'stint';
  ts: string;
  stint: Stint;
}

export interface RollbackEvent {
  type: 'rollback';
  ts: string;
  /** 退回到的快照。 */
  to: string;
  /** 给人看的：「第 7 棒之前」。 */
  label: string;
  /** 退回前存的一张（撤销退回用）。 */
  safety: string;
  /** 退回后的一张：之后的棒从这里开始算。 */
  after: string;
  /** 这次退回作废了哪几棒。 */
  dropped: number[];
  /** 撤销退回：这几棒的改动又回来了。 */
  restored?: number[];
}

export interface TaskEvent {
  type: 'task';
  ts: string;
  title: string;
  /** 换任务时的快照。 */
  snap?: string;
}

/** 接力台自己改了项目里的文件（比如更新 AGENTS.md 里的规矩）：从这里重新算，不算到哪一棒头上。 */
export interface BaseEvent {
  type: 'base';
  ts: string;
  snap: string;
  why: string;
}

export type LedgerEvent = InitEvent | StintEvent | RollbackEvent | TaskEvent | BaseEvent;

export function ledgerPath(root: string): string {
  return path.join(root, '.relay', 'journal.jsonl');
}

export function appendLedger(root: string, ev: LedgerEvent): void {
  fs.mkdirSync(path.dirname(ledgerPath(root)), { recursive: true });
  fs.appendFileSync(ledgerPath(root), JSON.stringify(ev) + '\n');
}

/** 读账本。坏掉的行跳过（AI 不小心改坏了一行，不能让整个接力台打不开）。 */
export function readLedger(root: string): LedgerEvent[] {
  let text: string;
  try {
    text = fs.readFileSync(ledgerPath(root), 'utf8');
  } catch {
    return [];
  }
  const out: LedgerEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as LedgerEvent;
      if (ev && typeof ev === 'object' && typeof ev.type === 'string') out.push(ev);
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

export function isInitialized(root: string): boolean {
  return readLedger(root).some((e) => e.type === 'init');
}

export interface LedgerView {
  events: LedgerEvent[];
  init: InitEvent | null;
  /** 所有棒，按编号。 */
  stints: Stint[];
  /** 正在进行的那一棒。 */
  open: Stint | null;
  /** 下一棒从哪张快照开始算（上一棒结束 / 退回之后 / 接入时）。 */
  base: string | null;
  /** 最近一次退回。 */
  lastRollback: RollbackEvent | null;
  task: TaskEvent | null;
}

/** 把账本折成现在的样子。 */
export function viewLedger(events: LedgerEvent[]): LedgerView {
  const byId = new Map<number, Stint>();
  let init: InitEvent | null = null;
  let base: string | null = null;
  let lastRollback: RollbackEvent | null = null;
  let task: TaskEvent | null = null;
  for (const ev of events) {
    if (ev.type === 'init') {
      if (!init) init = ev;
      if (!base) base = ev.snap;
    } else if (ev.type === 'stint') {
      const prev = byId.get(ev.stint.id);
      const s = { ...ev.stint };
      if (prev?.rolledBack) s.rolledBack = true;
      byId.set(s.id, s);
      if (s.status !== 'working' && s.to) base = s.to;
    } else if (ev.type === 'rollback') {
      lastRollback = ev;
      base = ev.after;
      for (const id of ev.dropped ?? []) {
        const s = byId.get(id);
        if (s) s.rolledBack = true;
      }
      for (const id of ev.restored ?? []) {
        const s = byId.get(id);
        if (s) delete s.rolledBack;
      }
    } else if (ev.type === 'task') {
      task = ev;
    } else if (ev.type === 'base') {
      base = ev.snap;
    }
  }
  const stints = [...byId.values()].sort((a, b) => a.id - b.id);
  const open = [...stints].reverse().find((s) => s.status === 'working') ?? null;
  return { events, init, stints, open, base, lastRollback, task };
}

export function loadLedger(root: string): LedgerView {
  return viewLedger(readLedger(root));
}

export function requireInit(root: string): LedgerView {
  const v = loadLedger(root);
  if (!v.init) throw new RelayError('这个文件夹还没接入接力台。先在接力台里点「接入」，或执行 relay init。', 'not-init');
  return v;
}

export function nextStintId(v: LedgerView): number {
  return (v.stints.at(-1)?.id ?? 0) + 1;
}

/** 待复核的棒（没作废、已经结束的）。 */
export function pendingReviews(v: LedgerView): Stint[] {
  return v.stints.filter((s) => s.review === 'needed' && s.status !== 'working' && !s.rolledBack);
}

export function findStint(v: LedgerView, id: number): Stint | null {
  return v.stints.find((s) => s.id === id) ?? null;
}

export function saveStint(root: string, s: Stint): void {
  appendLedger(root, { type: 'stint', ts: new Date().toISOString(), stint: s });
}

/** 给人看的「第 7 棒 · Codex · gpt-6」。 */
export function stintTitle(s: Pick<Stint, 'id' | 'who' | 'kind'>): string {
  const k = s.kind === 'review' ? '（复核）' : s.kind === 'final' ? '（终审）' : '';
  return `第 ${s.id} 棒${k} · ${s.who.label}`;
}

export function tierWord(t: Tier3): string {
  return t === 'strong' ? '强' : t === 'weak' ? '弱' : '不知道是谁';
}

export function statusWord(s: StintStatus): string {
  switch (s) {
    case 'working':
      return '进行中';
    case 'handed':
      return '交接了';
    case 'unfinished':
      return '没留交接就停了';
    case 'quota':
      return '额度用完';
    case 'failed':
      return '出错了';
    case 'stopped':
      return '叫停了';
  }
}

export function verdictWord(v: Verdict): string {
  switch (v) {
    case 'ok':
      return '没问题';
    case 'fixed':
      return '有问题，已修好';
    case 'reverted':
      return '改坏了，已退回';
    case 'problem':
      return '有问题，还没修';
    default:
      return '看过了（结论没写清楚）';
  }
}
