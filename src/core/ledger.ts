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
  /** error = 检查根本没跑成（比如配置文件坏了），不等于通过。 */
  status: 'pass' | 'fail' | 'error';
  command: string;
  detail?: string;
  /** 什么时候跑完的（检查命令自己改了源码的话，这之后要再跑一次才算数）。 */
  at?: string;
}

/**
 * working 进行中 / handed 交接了 / unfinished 没留交接就停了（多半是额度用完被打断）/
 * quota 接力台调度时碰到额度用完 / failed 出错 / stopped 被叫停
 */
export type StintStatus = 'working' | 'handed' | 'unfinished' | 'quota' | 'failed' | 'stopped';

/** needed 待复核 / done 复核过了 / skip 不用复核（强模型做的，或你标记过） */
export type ReviewState = 'needed' | 'done' | 'skip';

/**
 * 复核结论：ok 没问题 / fixed 有问题已修好 / reverted 改坏了已退回 / problem 有问题还没修 /
 * insufficient 证据不足（没跑测试、「应该没问题」这种）/ unknown 没写清楚
 */
export type Verdict = 'ok' | 'fixed' | 'reverted' | 'problem' | 'insufficient' | 'unknown';

/** 算「复核过了」的结论：只有这三种。有问题、证据不足、没写清楚都还要再核。 */
export const PASSING: ReadonlySet<Verdict> = new Set<Verdict>(['ok', 'fixed', 'reverted']);

export interface ReviewMark {
  /** 哪一棒复核的（0 = 认不出是哪一棒）。 */
  by: number;
  byLabel: string;
  file: string;
  verdict: Verdict;
  at: string;
  /** 写复核的是弱模型（或者是它自己复核自己、认不出是谁）：不算数，还要强模型再核。 */
  weak?: boolean;
  /** 认不出是谁写的：复核文件改动的时候没有哪一棒在做（不能记到前后哪一棒头上）。 */
  anon?: boolean;
  /** 是谁写的由 Claude Code 的会话记录认定（以后不用再核）。 */
  byLog?: boolean;
}

export interface Stint {
  /** 第几棒。 */
  id: number;
  /** work 干活 / review 复核 / final 终审 / plan 拆解（派活时强模型把任务拆成小步） */
  kind: 'work' | 'review' | 'final' | 'plan';
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
  /** 读不到这一棒的改动（快照仓库出错）：改没改、改了什么都不知道，按要复核算。 */
  factsError?: string;
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
  /** 派活：这一棒做的是清单里的哪一步（第几步从 1 数）。 */
  step?: { index: number; text: string };
  /** 工具自己报的 token 用量（日志里「本轮用了 X 输入 / Y 输出 token」加起来；没报就没有）。 */
  tokens?: { input: number; output: number };
  /** 终审棒：结论写在哪（.relay/复核/终审-….md）、写的是什么。 */
  reviewFile?: string;
  verdict?: Verdict;
  verdictText?: string;
  /** 这一棒开始前 / 结束时的任务清单（.relay/runs/tasks/ 里的副本编号）：退回时按它恢复打勾。 */
  taskBefore?: string;
  taskAfter?: string;
  /** 终审：结束时任务的版本（notes.ts 的 taskVersion）。任务后来改过，这次终审就不算现在的任务。 */
  taskVer?: string;
  /** 自己在工具里干的棒被接力台换人时：你确认过它已经停下（没确认就只是账面上结束）。 */
  stopConfirmed?: boolean;
  /** 这一棒在任务清单里新打的勾（没改文件、只打勾的弱模型也要复核：要确认这几步真做完了）。 */
  ticked?: string[];
}

export interface InitEvent {
  type: 'init';
  ts: string;
  /** 接入时的快照：第 1 棒从这里开始算。 */
  snap: string;
  version?: string;
  /** 接入时的任务清单（副本编号）：第 1 棒打了哪些勾，和它比。 */
  taskCopy?: string;
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
  /** 恢复完和目标快照对不上的文件（删不掉、写不回去）。 */
  left?: string[];
  /** 退回做到一半进程没了：下次打开时按当时的样子补记的（文件可能只退回了一部分，可以撤销）。 */
  interrupted?: boolean;
  /**
   * 任务清单跟着退回：按「第 N 棒开始前」的清单改回打勾（unchecked 取消的勾、checked 重新勾上的）；
   * before = 退回前清单的副本（撤销退回时恢复）；after = 退回后清单的副本（下一棒打了哪些勾，和它比）；
   * missing = 找不到那时的清单（旧账本），清单没动。
   */
  task?: { from?: string; before?: string; after?: string; unchecked: string[]; checked: string[]; missing?: boolean };
}

export interface TaskEvent {
  type: 'task';
  ts: string;
  title: string;
  /** 换任务时的快照。 */
  snap?: string;
  /** 被换掉的旧任务（网页上的历史列表用它当上一段的标题）；空字符串 = 旧任务是空的。旧版账本没有这一项。 */
  prev?: string;
  /** 换任务时的任务清单（副本编号）：下一棒打了哪些勾，和它比。 */
  taskCopy?: string;
  /** 在「派活」页写的任务：全自动用派活（强模型拆、弱模型做）。 */
  mode?: 'dispatch';
  /** 删除正在做的任务（清单清空）：删掉的那份清单的副本编号，撤销时写回去。 */
  deleted?: string;
  /** 撤销删除任务：撤销的是哪一笔（那一笔的时间）。这一删一撤两笔都不算换任务。 */
  undo?: string;
}

/** 账上算数的换任务：删除任务又撤销了的，那两笔都不算（像没删过一样）。 */
export function taskChanges(events: LedgerEvent[]): TaskEvent[] {
  const undone = new Set(events.flatMap((e) => (e.type === 'task' && e.undo ? [e.undo] : [])));
  return events.filter((e): e is TaskEvent => e.type === 'task' && !e.undo && !undone.has(e.ts));
}

/** 接力台自己改了项目里的文件（比如更新 AGENTS.md 里的规矩）：从这里重新算，不算到哪一棒头上。 */
export interface BaseEvent {
  type: 'base';
  ts: string;
  snap: string;
  why: string;
  /** 检查命令跑完改的：跟在第几棒后面跑的。 */
  after?: number;
  /** 检查命令改了的源码（不是生成的文件、命令里也没写明往里写）：之前的终审、这次检查的结果都不算现在的代码。 */
  files?: string[];
}

export type LedgerEvent = InitEvent | StintEvent | RollbackEvent | TaskEvent | BaseEvent;

export function ledgerPath(root: string): string {
  return path.join(root, '.relay', 'journal.jsonl');
}

/** 文件是不是以换行结尾（上次写到一半断了的话不是：先补一个换行，免得下一条粘在坏的那行上一起读不出来）。 */
function endsWithNewline(p: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(p, 'r');
  } catch {
    return true;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return true;
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, size - 1);
    return b[0] === 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

export function appendLedger(root: string, ev: LedgerEvent): void {
  const p = ledgerPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, `${endsWithNewline(p) ? '' : '\n'}${JSON.stringify(ev)}\n`);
}

/** 账本里读不出来的一行（第几行，从 1 数）。 */
export interface BadLine {
  line: number;
  text: string;
}

/**
 * 读账本。坏掉的行不让整个接力台打不开，但也不悄悄跳过：记下是第几行，验收会说「没法验收」
 * （坏的可能正好是一次退回、一份复核，跳过了结论就不对了）。
 */
export function readLedgerFull(root: string): { events: LedgerEvent[]; bad: BadLine[] } {
  let text: string;
  try {
    text = fs.readFileSync(ledgerPath(root), 'utf8');
  } catch {
    return { events: [], bad: [] };
  }
  const events: LedgerEvent[] = [];
  const bad: BadLine[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const ev = JSON.parse(line) as LedgerEvent;
      if (ev && typeof ev === 'object' && typeof ev.type === 'string') events.push(ev);
      else bad.push({ line: i + 1, text: line.slice(0, 120) });
    } catch {
      bad.push({ line: i + 1, text: line.slice(0, 120) });
    }
  });
  return { events, bad };
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
  /** 读不出来的行（有就没法验收）。 */
  bad?: BadLine[];
}

/** 把账本折成现在的样子。 */
export function viewLedger(events: LedgerEvent[], bad: BadLine[] = []): LedgerView {
  const byId = new Map<number, Stint>();
  let init: InitEvent | null = null;
  let base: string | null = null;
  let lastRollback: RollbackEvent | null = null;
  for (const ev of events) {
    if (ev.type === 'init') {
      if (!init) init = ev;
      if (!base) base = ev.snap;
    } else if (ev.type === 'stint') {
      const prev = byId.get(ev.stint.id);
      const s = { ...ev.stint };
      if (prev?.rolledBack) s.rolledBack = true;
      byId.set(s.id, s);
      // 只在这一棒结束（或结束的快照变了）时往前推。后来给旧棒补记复核、标记不用复核，是把旧棒原样重存一遍，
      // 不能把起点拉回到它结束的地方——不然下一棒会把中间别人的改动再算一遍。
      if (s.status !== 'working' && s.to && (!prev || prev.status === 'working' || prev.to !== s.to)) base = s.to;
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
    } else if (ev.type === 'base') {
      base = ev.snap;
    }
  }
  const stints = [...byId.values()].sort((a, b) => a.id - b.id);
  const dropped = new Set(stints.filter((s) => s.rolledBack).map((s) => s.id));
  for (const s of stints) s.review = reviewStateOf(s, dropped);
  const open = [...stints].reverse().find((s) => s.status === 'working') ?? null;
  const task = taskChanges(events).at(-1) ?? null;
  return { events, init, stints, open, base, lastRollback, task, bad };
}

/**
 * 一棒现在算不算复核过。账上存的只当起点：你标记过「不用复核」（skip）就不用；
 * 否则看最近一次算数的复核——强模型写的、不是自己复核自己、写复核的那一棒没被退回——
 * 结论是没问题 / 已修好 / 已退回才算复核过。结论写了「有问题」「证据不足」、或者算数的复核作废了，都回到待复核。
 * 复核、终审的棒本身不用复核（2.0 早期把终审结论里的「第 N 棒」当成了复核自己，账上可能记成了待复核）。
 */
export function reviewStateOf(s: Stint, rolledBack: ReadonlySet<number> = new Set()): ReviewState {
  if (s.kind !== 'work') return s.review === 'needed' ? 'skip' : s.review;
  if (s.review === 'skip') return 'skip';
  // 没有任何复核记录：按账上记的（旧账本、你直接标的）。
  if (!(s.reviews ?? []).length) return s.review;
  const last = countedReviews(s, rolledBack).at(-1);
  return last && PASSING.has(last.verdict) ? 'done' : 'needed';
}

/** 算数的复核（按时间先后）：强模型写的、写复核的那一棒没被退回。 */
export function countedReviews(s: Pick<Stint, 'reviews'>, rolledBack: ReadonlySet<number> = new Set()): ReviewMark[] {
  return (s.reviews ?? []).filter((m) => !m.weak && !(m.by && rolledBack.has(m.by)));
}

export function loadLedger(root: string): LedgerView {
  const { events, bad } = readLedgerFull(root);
  return viewLedger(events, bad);
}

export function requireInit(root: string): LedgerView {
  const v = loadLedger(root);
  if (!v.init) throw new RelayError('这个文件夹还没接入接力台', 'not-init');
  return v;
}

/**
 * 下一棒开始前的任务清单（副本编号）：最近一次记下的——上一棒结束时、换任务时、退回后、接入时。
 * 你自己在工具里干的棒，接力台看到它的时候它可能已经打过勾了：不能拿那时的清单当「开始前」。
 */
export function taskBaseline(v: LedgerView): string | undefined {
  let id: string | undefined;
  for (const e of v.events) {
    if ((e.type === 'init' || e.type === 'task') && e.taskCopy) id = e.taskCopy;
    else if (e.type === 'rollback' && e.task?.after) id = e.task.after;
    else if (e.type === 'stint' && e.stint.status !== 'working' && e.stint.taskAfter && !v.stints.find((s) => s.id === e.stint.id)?.rolledBack) id = e.stint.taskAfter;
  }
  return id;
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

/** 你说第 id 棒不用复核（比如其实是你自己改的）；needed = 撤销，改回待复核。网页和命令行共用。 */
export function markReview(root: string, id: number, review: 'skip' | 'needed', note?: string): void {
  const s = loadLedger(root).stints.find((x) => x.id === id);
  if (!s) throw new RelayError('没有这一棒。', 'no-stint');
  if (s.status === 'working') throw new RelayError('这一棒还在进行中。', 'working');
  if (review === 'needed') {
    if (s.kind !== 'work') throw new RelayError('只有干活的棒要复核。', 'not-work');
    // 撤销：去掉跳过时记的那句说明，改回待复核。
    const next: Stint = { ...s, review: 'needed' };
    const rest = (s.note ?? '').replace(/\s*你标记为不用复核。\s*$/, '');
    if (rest) next.note = rest;
    else delete next.note;
    saveStint(root, next);
  } else {
    saveStint(root, { ...s, review: 'skip', note: [s.note, note?.trim() || '你标记为不用复核。'].filter(Boolean).join(' ') });
  }
}

/** 当前任务是在哪一页写的：派活页写的用派活，别的都是接力。 */
export function taskMode(v: LedgerView): 'dispatch' | 'relay' {
  return taskChanges(v.events).at(-1)?.mode === 'dispatch' ? 'dispatch' : 'relay';
}

/** 一棒在做什么：干活、复核、终审、拆解。 */
export const KIND_WORD: Record<Stint['kind'], string> = { work: '干活', review: '复核', final: '终审', plan: '拆解' };

/** 给人看的「第 7 棒 · Codex · gpt-6」。 */
export function stintTitle(s: Pick<Stint, 'id' | 'who' | 'kind'>): string {
  const k = s.kind === 'review' ? '（复核）' : s.kind === 'final' ? '（终审）' : s.kind === 'plan' ? '（拆解）' : '';
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
      return '已交接';
    case 'unfinished':
      return '没交接';
    case 'quota':
      return '额度用完';
    case 'failed':
      return '出错';
    case 'stopped':
      return '已停止';
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
    case 'insufficient':
      return '证据不足';
    default:
      return '结论没写清楚';
  }
}
