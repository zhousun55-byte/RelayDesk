import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildBrief } from '../core/brief';
import { loadAutoSettings } from '../core/auto-settings';
import { claudeWorkIn, claudeWriterOf } from '../core/claude-log';
import { defaultRelayConfig, loadRelayConfig } from '../core/config';
import { errorMessage, RelayError } from '../core/errors';
import { runGate } from '../core/gate';
import { appendLedger, countedReviews, loadLedger, nextStintId, reviewStateOf, saveStint, taskBaseline, type Facts, type LedgerView, type ReviewMark, type RollbackEvent, type Stint, type Who } from '../core/ledger';
import { pidAlive } from '../core/proc';
import { runsDir } from './lock';
import { allMembers, type MemberInfo } from '../core/members';
import {
  BRIEF_REL,
  HANDOFF_DIR,
  handoffFileFor,
  handoffFilled,
  listHandoffFiles,
  listReviewFiles,
  newlyChecked,
  readHandoff,
  readReview,
  readTask,
  readTaskCopy,
  reviewDiffFileFor,
  reviewFileFor,
  reviewFilled,
  saveTaskCopy,
  taskVersion,
  type HandoffDoc,
  type ReviewDoc,
} from '../core/notes';
import { matchProtected } from '../core/protected';
import { changeLine, generatedPath, headSnap, snapChanges, snapDiff, sumChanges, takeSnapshot } from '../core/snap';
import { stampLocal } from '../core/time';
import { needsReview, resolveWho, sameModel, UNKNOWN_WHO } from '../core/tier';
import type { RelayConfig } from '../core/types';

/**
 * 记账：把项目文件夹里发生的事对上账本。
 * - 文件有变化 → 存快照；没有进行中的棒就开一棒（先记成「不知道是谁」）；
 * - 交接文件出现 → 认出是谁；交接写了「已交接 / 全部完成 / 卡住了」→ 这一棒结束；
 * - 一段时间没动静又没交接 → 当它被打断了，替它记一笔（要复核）；
 * - 复核文件写好了 → 被复核的那一棒标成「复核过了」；
 * - 最后重新生成接力本。
 * 可以随便重复调用（盯文件夹、打开网页、命令行都会调），结果只取决于文件和账本。
 */

export const QUIET_MS_DEFAULT = 20 * 60_000;

export function quietMs(): number {
  const v = Number(process.env.RELAY_QUIET_MS);
  return Number.isFinite(v) && v > 0 ? v : QUIET_MS_DEFAULT;
}

/**
 * 项目配置。还没有配置文件（没接入）才用默认；配置文件坏了直接报错——
 * 不能悄悄当成「没配检查、没有不许改的文件」，那等于把约束全去掉了。
 */
export function projectConfig(root: string): RelayConfig {
  try {
    return loadRelayConfig(root);
  } catch (e) {
    if (e instanceof RelayError && e.code === 'no-config') return defaultRelayConfig();
    throw e;
  }
}

/** 读配置，坏了不抛：记账、接力本、网页用它（配置坏了也要能看，但要把原因说出来）。 */
export function projectConfigSafe(root: string): { cfg: RelayConfig; error?: string } {
  try {
    return { cfg: projectConfig(root) };
  } catch (e) {
    return { cfg: defaultRelayConfig(), error: errorMessage(e) };
  }
}

/** 算一棒的改动；快照仓库出错时不抛，返回原因（这时改没改都不知道，不能当成没改）。 */
export function factsSafe(root: string, from: string, to: string): { facts?: Facts; error?: string } {
  try {
    return { facts: factsOf(root, from, to) };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

function joinNote(...parts: (string | undefined)[]): string | undefined {
  const t = parts.filter(Boolean).join(' ');
  return t || undefined;
}

export function factsOf(root: string, from: string, to: string): Facts {
  const files = snapChanges(root, from, to);
  return { ...sumChanges(files), paths: files.slice(0, 200).map((f) => f.path) };
}

function nowIso(d = new Date()): string {
  return d.toISOString();
}

/** 交接里写的身份 → 认出是谁。 */
export function whoFromHandoff(h: HandoffDoc | null, members: MemberInfo[]): Who {
  if (!h) return UNKNOWN_WHO;
  return resolveWho({ who: h.who, tool: h.tool, model: h.model }, members);
}

/** 同一个 claude 命令可能是官方账号，也可能被接到了别家模型：自称是这些工具的，要拿记录核对。 */
const CLAUDE_TOOLS = new Set(['claude', 'claude-official', 'claude-app']);
const ENTRY_WORDS: Record<string, string> = { 'claude-desktop': '桌面版', cli: '终端', 'sdk-cli': '程序调用' };

function entryWord(entry: string | undefined): string {
  return entry ? ENTRY_WORDS[entry] ?? entry : '';
}

export interface CrossCheck {
  who?: Who;
  note?: string;
  /** 身份不改，但要复核（改动里混进了弱模型的）。 */
  review?: boolean;
}

/** 一棒的改动是哪段时间攒下的：上一棒结束（没有就是接入时）到 until。 */
function windowStart(v: LedgerView, s: Stint, until: string): string {
  const prev = v.stints
    .filter((x) => x.id !== s.id && x.endedAt && x.endedAt < until)
    .map((x) => x.endedAt!)
    .sort()
    .at(-1);
  return prev ?? v.init?.ts ?? s.startedAt;
}

/**
 * 用 Claude Code 自己的会话记录核对一棒是谁做的（只核对你在各家工具里自己做的棒）：
 * 1. 交接文件是 Claude Code 写的：以记录里的模型为准（接了 DeepSeek 的 Claude Code 自称 Opus 也认得出来）；
 * 2. 认不出是谁（没交接、只写了 Claude Code）：看这段时间谁在项目里改文件，按其中最弱的算；
 * 3. 算下来是强模型，但这段时间有弱模型也在改项目文件：改动混在一起了，要复核。
 */
export function crossCheckClaude(root: string, s: Stint, members: MemberInfo[], until: string): CrossCheck | null {
  const since = windowStart(loadLedger(root), s, until);
  const claimed = s.who.claimed ?? (s.who.tier === 'unknown' ? undefined : s.who.label);
  const keepClaim = (w: Who): Who => ({ ...w, ...(claimed && claimed !== w.label ? { claimed } : {}) });
  const asClaude = (model: string) => resolveWho({ tool: 'Claude Code', model }, members);
  const notes: string[] = [];
  let who = s.who;
  let byLog = false;

  const writer = s.handoff && !s.ghost ? claudeWriterOf(path.join(root, s.handoff), since, until) : null;
  if (writer) {
    byLog = true;
    const actual = asClaude(writer.model);
    const where = entryWord(writer.entry);
    if (actual.member !== who.member || actual.tier !== who.tier) {
      who = keepClaim(actual);
      notes.push(claimed ? `交接里写的是「${claimed}」，但 Claude Code 的记录显示交接是 ${writer.model}${where ? `（${where}）` : ''}写的，以记录为准。` : `从 Claude Code 的记录认出来：交接是 ${writer.model}${where ? `（${where}）` : ''}写的。`);
    } else if (who.model !== writer.model) {
      who = { ...who, model: writer.model, label: actual.label };
    }
  }

  const work = claudeWorkIn(root, since, until);
  if (work.length) {
    const found = work.map((w) => ({ w, who: asClaude(w.model) }));
    const weak = found.find((f) => f.who.tier !== 'strong');
    const list = work.map((w) => `${w.model}（${[entryWord(w.entry), `改了 ${w.count} 次`].filter(Boolean).join('，')}）`).join('、');
    const aboutClaude = who.tier === 'unknown' || !who.tool || CLAUDE_TOOLS.has(who.tool);
    if (!byLog && (who.tier === 'unknown' || (aboutClaude && !who.model))) {
      who = keepClaim((weak ?? found[0]).who);
      notes.push(`从 Claude Code 的记录认出来的：这段时间在这个文件夹里改文件的是 ${list}。`);
    } else if (!byLog && aboutClaude && weak && who.tier === 'strong') {
      who = keepClaim(weak.who);
      notes.push(`交接里写的是「${claimed}」，但 Claude Code 的记录显示这段时间在这个文件夹里改文件的有 ${list}，按弱的算。`);
    } else if (weak && who.tier === 'strong') {
      return { who, note: [...notes, `这段时间 ${weak.w.model}（弱）也在这个文件夹里改过文件：${list}。改动可能混在一起，要复核。`].join(' '), review: true };
    } else if (!byLog && who.model && found.length === 1 && found[0].who.member === who.member && who.model !== work[0].model && sameModel(who.model, work[0].model)) {
      // 对得上：把模型名换成记录里的准确写法（Opus 5.5 → claude-opus-5-5）。
      who = { ...who, model: work[0].model, label: found[0].who.label };
    }
  }
  if (who === s.who && !notes.length) return null;
  return { who, ...(notes.length ? { note: notes.join(' ') } : {}) };
}

/** 给复核准备的改动文件（.relay/复核/第N棒.diff）。太大就截断，并写上看完整的命令。 */
export function writeReviewDiff(root: string, s: Stint): void {
  if (!s.to) return;
  const rel = reviewDiffFileFor(s.id);
  const abs = path.join(root, rel);
  const MAX = 400_000;
  let diff = '';
  let line: string;
  try {
    diff = snapDiff(root, s.from, s.to);
    line = changeLine(snapChanges(root, s.from, s.to));
  } catch (e) {
    // 读不到改动：写明原因，复核的人自己用命令看（或者先修快照仓库）。
    line = `读不到改动：${errorMessage(e)}`;
  }
  const cut = diff.length > MAX;
  if (cut) diff = diff.slice(0, MAX);
  const head = [
    `# 第 ${s.id} 棒（${s.who.label}）的真实改动`,
    `# ${line}`,
    `# 快照 ${s.from.slice(0, 10)} → ${s.to.slice(0, 10)}`,
    cut ? `# 太长了，只放了前面一部分。完整的：git --git-dir=.relay/snapshots --work-tree=. diff ${s.from.slice(0, 10)} ${s.to.slice(0, 10)}` : '',
    '',
  ]
    .filter((l, i) => l || i === 4)
    .join('\n');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${head}\n${diff}`);
}

/** 它没留交接：接力台替它记一份（只有事实）。 */
export function writeGhostHandoff(root: string, s: Stint, lastWords?: string): string {
  const rel = handoffFileFor(root, s.id, `${s.who.tool ?? 'ai'}-接力台代写`);
  const facts = s.facts;
  const lines = [
    `# 交接：${s.who.label}（接力台代写）`,
    '',
    `- 时间：${stampLocal(s.endedAt ?? new Date())}`,
    '- 状态：已交接',
    '',
    '> 这一棒没留交接（多半是额度用完被打断了），下面是接力台看到的事实。它到底做对没有，要等强模型复核。',
    '',
    '## 做了什么',
    '',
    facts && facts.files ? `- 改了 ${facts.files} 个文件（+${facts.added} −${facts.removed}）：${facts.paths.slice(0, 20).join('、')}${facts.paths.length > 20 ? ' ……' : ''}` : '- 没有改文件。',
    '',
  ];
  if (lastWords?.trim()) lines.push('## 它最后说的话', '', lastWords.trim().slice(0, 3000), '');
  lines.push('## 没做完 / 下一步', '', '- 不知道。先复核它改的东西，再对照任务清单看还差什么。', '');
  fs.mkdirSync(path.join(root, HANDOFF_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, rel), lines.join('\n'));
  return rel;
}

export interface CloseInput {
  status: Stint['status'];
  to: string;
  handoff?: HandoffDoc | null;
  lastWords?: string;
  note?: string;
  quotaUntil?: string;
  now?: Date;
  /** 成员名单（核对身份用；不给就现读）。 */
  members?: MemberInfo[];
  /** 不看这一棒打了哪些勾（好几棒的改动混在一起、记在最后一棒里时，前面几棒用）。 */
  noTicks?: boolean;
}

/**
 * 结束一棒：算事实、没交接就代写、定要不要复核、准备复核材料。返回结束后的样子（已记账）。
 * cfg 不给就现读；配置文件坏了照样结束这一棒，但记下「没法核对不许改的文件」。
 */
export function closeStint(root: string, s: Stint, input: CloseInput, cfg?: RelayConfig): Stint {
  const conf = cfg ? { cfg } : projectConfigSafe(root);
  const now = input.now ?? new Date();
  const out: Stint = { ...s, to: input.to, endedAt: nowIso(now), status: input.status };
  delete out.pid;
  let forceReview = false;
  if (out.via === 'native' && out.kind === 'work') {
    const cc = crossCheckClaude(root, out, input.members ?? allMembers(), out.endedAt!);
    if (cc?.who) out.who = cc.who;
    if (cc?.note) out.note = joinNote(out.note, cc.note);
    forceReview = !!cc?.review;
  }
  const fr = factsSafe(root, s.from, input.to);
  if (fr.facts) {
    out.facts = fr.facts;
    delete out.factsError;
  } else {
    // 读不到改动：不能当成「没改文件」（那样弱模型的活就不用复核了）。
    delete out.facts;
    out.factsError = fr.error;
  }
  const hits = out.facts ? matchProtected(out.facts.paths, conf.cfg.protectedPaths) : [];
  if (hits.length) out.protectedHits = hits;
  else delete out.protectedHits;
  if (input.note) out.note = input.note;
  if (input.quotaUntil) out.quotaUntil = input.quotaUntil;
  if (out.factsError) out.note = joinNote(out.note, `读不到这一棒的改动（${out.factsError}），按要复核算。`);
  if (conf.error) out.note = joinNote(out.note, `配置文件坏了，没法核对不许改的文件：${conf.error}`);
  const h = input.handoff ?? (out.handoff && !out.ghost ? readHandoff(root, out.handoff) : null);
  const real = !!h && !out.ghost && handoffFilled(h);
  const changed = out.facts ? out.facts.files > 0 : true;
  if (real && h) {
    out.handoff = h.file;
    out.summary = h.summary || out.summary;
  } else if (!out.ghost && (changed || input.lastWords?.trim())) {
    if (h) out.note = joinNote(out.note, `它建了交接文件但没写内容：${h.file}`);
    out.handoff = writeGhostHandoff(root, out, input.lastWords);
    out.ghost = true;
    out.summary = !out.facts ? '没留交接，改动也读不到' : out.facts.files ? `没留交接：${out.facts.files} 个文件，+${out.facts.added} −${out.facts.removed}` : '没留交接，也没改文件';
  }
  const task = saveTaskCopy(root);
  if (task) out.taskAfter = task;
  if (out.kind === 'final') out.taskVer = taskVersion(readTask(root));
  // 任务清单不进快照：只在清单里打勾、一个文件都没改的弱模型，看起来是「没改文件」，其实是在说「这几步做完了」——也要复核。
  const ticked = out.kind === 'work' && !input.noTicks ? newlyChecked(readTaskCopy(root, out.taskBefore), readTaskCopy(root, out.taskAfter)) : [];
  if (ticked.length) out.ticked = ticked;
  else delete out.ticked;
  if (out.kind !== 'work') out.review = 'skip';
  else if (out.facts && out.facts.files === 0 && !ticked.length) out.review = 'skip';
  else out.review = forceReview || needsReview(out.who, real) ? 'needed' : 'skip';
  if (out.review === 'needed') writeReviewDiff(root, out);
  saveStint(root, out);
  return out;
}

export interface GateOptions {
  /**
   * 检查命令自己在项目里写了文件（pytest 的 .pytest_cache、覆盖率报告……）怎么记。不记的话，下一次对账会把它们当成
   * 「有人在改文件」，开出一棒「不知道是谁」——全自动会以为有别的 AI 在干活而停下。
   * - all：都算接力台自己的改动，从检查跑完那张快照重新算（调度时用：调度拿着锁，这段时间只有检查命令在改）；
   * - generated：只有改的全是缓存、报告这类生成出来的文件、或者检查命令里写明往里写的文件才这样记（盯文件夹时用：这时可能已经有别的 AI 开工了）。
   */
  absorb?: 'all' | 'generated';
}

let gatesRunning = 0;

/** 这个接力台进程里有没有检查命令在跑。 */
export function gateBusy(): boolean {
  return gatesRunning > 0;
}

/**
 * 跑检查命令，把结果记到这一棒上（没配检查命令就什么都不做）。
 * 配置文件坏了、检查根本跑不起来：记成「没跑成」，不能当成没配检查。
 */
export async function gateStint(root: string, id: number, cfg?: RelayConfig, opts: GateOptions = {}): Promise<void> {
  const record = (gate: Stint['gate'], note?: string) => {
    const s = loadLedger(root).stints.find((x) => x.id === id);
    if (s) saveStint(root, { ...s, ...(gate ? { gate } : {}), ...(note ? { note: joinNote(s.note, note) } : {}) });
  };
  let conf: RelayConfig;
  try {
    conf = cfg ?? projectConfig(root);
  } catch (e) {
    record({ status: 'error', command: '', detail: `配置文件坏了，检查没法跑：${errorMessage(e)}` });
    return;
  }
  if (!conf.gate.command.trim()) return;
  const before = opts.absorb ? takeSnapshot(root, '跑检查之前').sha : null;
  gatesRunning++;
  try {
    const r = await runGate(root, conf);
    record({ status: r.status, command: r.command, ...(r.status === 'fail' ? { detail: r.detail.slice(-1500) } : {}), at: nowIso() });
  } catch (e) {
    record({ status: 'error', command: conf.gate.command, detail: `检查没跑起来：${errorMessage(e)}` });
  } finally {
    gatesRunning--;
  }
  if (before && opts.absorb) {
    const note = absorbGateWrites(root, before, opts.absorb, conf.gate.command, id);
    if (note) record(undefined, note);
  }
}

/**
 * 检查命令里明写着往这个文件写（`date > reports/last-run.txt`、`| tee out.log`、`--junitxml=r.xml`、`-o out.txt`）：
 * 一定是检查命令自己写的。只认写的位置、按完整路径认：`pytest tests/test_a.py`、`python3 wc.py < in.txt` 里的文件
 * 是读的，这时别的 AI 可能正好在改它们，不能替它记掉。
 */
export function gateWrites(command: string, file: string): boolean {
  const esc = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lead = [
    '(?:^|[^<>-])[0-9&]?>>?\\|?\\s*', // > f、>> f、2> f、&> f
    '\\btee(?:\\s+-[a-z]+)*\\s+', // | tee f、tee -a f
    '(?:^|\\s)-o\\s*', // -o f
    '(?:^|\\s)--[\\w-]*(?:[Oo]ut|[Rr]eport|[Jj]unit|[Ll]og|[Rr]esult)[\\w-]*(?:=|\\s+)', // --outFile=f、--junitxml=f、--output f
  ];
  // 分大小写：`python3 -O wc.py`、`curl -O` 里的 -O 不是往文件里写。
  return new RegExp(`(?:${lead.join('|')})['"]?(?:\\./)?${esc}(?=$|['"\\s;&|)<>])`).test(command);
}

/**
 * 检查命令跑完、它自己改了项目里的文件：从跑完的那张快照重新算，记一笔「检查命令写的」，不算到哪一棒头上。
 * 只在跑检查之前和账上的起点一样、现在也没人在做的时候这样记（不然会把别人的改动一起吞掉）。
 * generated（盯文件夹时）：改的全是生成的文件、或者检查命令里写明往里写的文件才记。返回给那一棒的说明。
 * 改到了源码（格式化、自动修复……）：账上记下是哪几个，验收时之前的终审、这次检查都不算现在的代码，要再来一次。
 */
function absorbGateWrites(root: string, before: string, mode: 'all' | 'generated', command: string, after: number): string | undefined {
  const v = loadLedger(root);
  if (v.open || v.base !== before) return undefined;
  const sha = takeSnapshot(root, '检查命令跑完').sha;
  if (sha === before) return undefined;
  let paths: string[];
  try {
    paths = snapChanges(root, before, sha).map((f) => f.path);
  } catch {
    return undefined;
  }
  if (!paths.length || (mode === 'generated' && !paths.every((p) => generatedPath(p) || gateWrites(command, p)))) return undefined;
  const list = `${paths.slice(0, 8).join('、')}${paths.length > 8 ? ` 等 ${paths.length} 个` : ''}`;
  const source = paths.filter((p) => !generatedPath(p) && !gateWrites(command, p));
  appendLedger(root, { type: 'base', ts: nowIso(), snap: sha, why: `检查命令写的文件：${list}`, after, ...(source.length ? { files: source.slice(0, 50) } : {}) });
  return `检查命令跑完改了 ${paths.length} 个文件（${list}），算接力台自己的改动，不算到哪一棒头上。${source.length ? '改到了源码：终审、检查要按改过的再来一次。' : ''}`;
}

/**
 * 复核文件改动的时间和一棒的时间对得上的余量：开工前留 30 秒（先写复核、紧跟着才建交接，也算这一棒的；
 * 写复核那一刻还没人开工、记成了「认不出是谁」的，这一棒开工后会再认一次）。
 * 收工后不留：接力台调度的棒在工具退出之后才记收工，自己在工具里做的棒在对账那一刻记收工，它写的复核都在这之前；
 * 收工以后才改的，可能是别人改的，不能算到这一棒头上。
 */
const REVIEW_BEFORE_MS = 30_000;

/**
 * 复核文件是哪一棒写的：改动时间落在哪一棒从开工到收工的时间里。by（正在做的、刚做完的那一棒）对得上就是它；
 * 落不进任何一棒——没有哪一棒在做的时候改的——就认不出来。不能随手记到最后一棒头上：那一棒早收工了，
 * 后来改这份文件的可能是弱模型、可能是你，记成它的，弱模型写的「没问题」就被当成强模型复核过了。
 */
function writerOf(v: LedgerView, by: Stint | null, mtimeMs: number, now: number): Stint | null {
  const end = (s: Stint) => (s.status === 'working' || !s.endedAt ? now : Date.parse(s.endedAt));
  // 修改时间比毫秒精细：取整到毫秒再比（收工时间是在写完之后才记的，取整后不会比它晚）。
  const within = (s: Stint) => mtimeMs >= Date.parse(s.startedAt) - REVIEW_BEFORE_MS && Math.floor(mtimeMs) <= end(s);
  if (by && within(by)) return by;
  return [...v.stints].reverse().find(within) ?? null;
}

/**
 * 看复核文件：写好了的，记到它复核的那几棒上。by = 正在做（或刚做完）的那一棒。
 * 算不算「复核过了」看结论：强模型写的没问题 / 已修好 / 已退回才算；有问题、证据不足、没写清楚都还是待复核。
 * 认不出是谁写的、弱模型写的都不算数；弱模型、认不出的人后来改了强模型写的复核，原来强模型的结论还在。
 */
export function applyReviews(root: string, by: Stint | null, members: MemberInfo[] = allMembers(), now = new Date()): number[] {
  const v = loadLedger(root);
  const dropped = new Set(v.stints.filter((x) => x.rolledBack).map((x) => x.id));
  const files = listReviewFiles(root);
  // 派活的终审一起复核了前面几棒，只写一份结论：也记到这几棒上。它开工后又单独给某一棒写了复核的，以那一份为准。
  const written = new Map(files.map((f) => [f.rel, f.mtimeMs]));
  // 边做边复核的结论是接力台在终审开工前几秒代写的：按修改时间会被当成「终审开工后写的」，要看是哪一棒写的、那一棒是不是在终审开工前就结束了。
  const doneBefore = (id: number, final: Stint) => {
    const mark = (v.stints.find((y) => y.id === id)?.reviews ?? []).filter((m) => m.file === reviewFileFor(id)).at(-1);
    const by = mark ? v.stints.find((y) => y.id === mark.by) : undefined;
    return !!by?.endedAt && by.id < final.id && Date.parse(by.endedAt) <= Date.parse(final.startedAt);
  };
  const merged = new Map(
    v.stints
      .filter((x) => x.kind === 'final' && x.reviewFile && x.targets?.length)
      .map((x) => [x.reviewFile!, x.targets!.filter((id) => (written.get(reviewFileFor(id)) ?? 0) < Date.parse(x.startedAt) - REVIEW_BEFORE_MS || doneBefore(id, x))])
  );
  const marked: number[] = [];
  for (const f of files) {
    const r = readReview(root, f.rel);
    if (!r || !reviewFilled(r)) continue;
    for (const id of new Set([...r.targets, ...(merged.get(r.file) ?? [])])) {
      const s = v.stints.find((x) => x.id === id);
      // 只有干活的棒要复核。复核、终审的棒不算（终审的结论里常写「复核：第 5 棒终审」，5 是它自己）。
      if (!s || s.status === 'working' || s.kind !== 'work') continue;
      const prev = [...(s.reviews ?? [])].reverse().find((m) => m.file === r.file);
      const fresh = !prev || prev.verdict !== r.verdict || r.mtimeMs > Date.parse(prev.at);
      if (!fresh && prev?.byLog) continue;
      // 复核文件改过了就是新写的：按改动时间找是哪一棒写的。没改过就还是原来那一棒——它的身份后来可能认得更清楚了（交接写好了、对过了记录），再判一次。
      // 当时认不出是谁的，也再找一次：先写复核、过一会儿才建交接，这一棒开工前 30 秒内写的也算它的。
      const reviewer = fresh || prev?.anon ? writerOf(v, by, r.mtimeMs, now.getTime()) : (v.stints.find((x) => x.id === prev!.by) ?? null);
      if (!fresh && !reviewer) continue;
      const judged = judgeReviewer(root, r, reviewer, s, members, fresh);
      if (!fresh && prev && !!prev.weak === judged.weak) continue;
      const mark: ReviewMark = {
        by: reviewer?.id ?? 0,
        // 显示认出来的身份（强弱也是按它定的），不用复核文件里自己写的「复核人」：两个 Claude Code 自称时常常分不出来。
        byLabel: judged.label,
        file: r.file,
        verdict: r.verdict,
        at: nowIso(now),
        ...(judged.weak ? { weak: true } : {}),
        ...(judged.anon ? { anon: true } : {}),
        ...(judged.byLog ? { byLog: true } : {}),
      };
      // 同一份复核文件：算数的复核只被算数的复核替换（不算数的那一份记在后面，原来强模型写的结论还算）。
      const reviews = [...(s.reviews ?? []).filter((m) => m.file !== r.file || (mark.weak && !m.weak)), mark];
      // 原来不用复核（强模型做的）又没有算数的复核：还是不用；有算数的复核就按结论算。
      const review = s.review === 'skip' && !countedReviews({ reviews }, dropped).length ? 'skip' : reviewStateOf({ ...s, review: 'needed', reviews }, dropped);
      saveStint(root, { ...s, review, reviews });
      marked.push(id);
    }
  }
  return marked;
}

/**
 * 这份复核算不算数：写它的得是强模型，而且不能是它自己复核自己。
 * 复核文件是 Claude Code 写的：以记录里的模型为准；否则看写它的那一棒是谁（还没认出是谁的不算）。
 * 复核文件里自己写的「复核人」只用来往下核：写的是弱模型，就不算数。
 */
function judgeReviewer(root: string, r: ReviewDoc, reviewer: Stint | null, target: Stint, members: MemberInfo[], look: boolean): { weak: boolean; anon?: boolean; label: string; byLog: boolean } {
  const claim = r.by ? `（复核文件里写的复核人是「${r.by.slice(0, 60)}」）` : '';
  if (look) {
    const w = claudeWriterOf(path.join(root, r.file), new Date(r.mtimeMs - 10 * 60_000).toISOString(), new Date(r.mtimeMs).toISOString());
    if (w) {
      const who = resolveWho({ tool: 'Claude Code', model: w.model }, members);
      return { weak: who.tier !== 'strong', label: who.label, byLog: true };
    }
  }
  if (!reviewer) return { weak: true, anon: true, label: `认不出是谁${claim}`, byLog: false };
  if (reviewer.id === target.id) return { weak: true, label: reviewer.who.label, byLog: false };
  const who = reviewer.who;
  if (who.tier === 'unknown') return { weak: true, label: `${who.label}${claim}`, byLog: false };
  if (who.tier !== 'strong') return { weak: true, label: who.label, byLog: false };
  if (r.by && resolveWho({ who: r.by }, members).tier === 'weak') return { weak: true, label: `${who.label}${claim}`, byLog: false };
  return { weak: false, label: who.label, byLog: false };
}

// ---- 接力本 ----

function relayRunning(v: LedgerView): { label: string; since: string } | null {
  const o = v.open;
  if (!o || o.via !== 'relay' || !o.pid || !pidAlive(o.pid)) return null;
  return { label: o.who.label, since: o.startedAt };
}

/** 重新生成接力本。内容没变（除了时间）就不写，免得来回改文件。 */
export function refreshBrief(root: string, now = new Date()): boolean {
  const v = loadLedger(root);
  if (!v.init) return false;
  const { cfg, error: configError } = projectConfigSafe(root);
  let finalRequired = true;
  try {
    finalRequired = loadAutoSettings().finalReview;
  } catch {
    /* 全自动的设置坏了：按要终审算 */
  }
  const handoffs = new Map<string, HandoffDoc>();
  for (const s of v.stints) {
    if (s.handoff && !handoffs.has(s.handoff)) {
      const h = readHandoff(root, s.handoff);
      if (h) handoffs.set(s.handoff, h);
    }
  }
  const members = allMembers().map((m) => ({ label: m.label, ...(m.model ? { model: m.model } : {}), tier: m.tier }));
  const text = buildBrief({
    task: readTask(root),
    ledger: v,
    handoffs,
    members,
    gateCommand: cfg.gate.command.trim(),
    protectedPaths: cfg.protectedPaths,
    ...(configError ? { configError } : {}),
    finalRequired,
    nextId: v.open?.id ?? nextStintId(v),
    now,
    running: relayRunning(v),
  });
  const p = path.join(root, BRIEF_REL);
  const strip = (t: string) => t.replace(/^> 接力台生成于[^\n]*\n/m, '');
  let cur = '';
  try {
    cur = fs.readFileSync(p, 'utf8');
  } catch {
    /* 还没有 */
  }
  if (strip(cur) === strip(text)) return false;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(`${p}.tmp`, text);
  fs.renameSync(`${p}.tmp`, p);
  return true;
}

// ---- 盯着文件夹时的记账 ----

export interface TrackOptions {
  /** 先存一张快照（默认存）。 */
  snapshot?: boolean;
  now?: Date;
}

export interface TrackResult {
  changed: boolean;
  /** 这次结束的棒（要跑检查的）。 */
  closed: number[];
  opened: number[];
  reviewed: number[];
}

/** 接力台调度的那一棒还在跑吗。 */
export function relayBusy(v: LedgerView): Stint | null {
  const o = v.open;
  return o && o.via === 'relay' && o.pid && pidAlive(o.pid) ? o : null;
}

// ---- 退回做到一半：文件已经在动了、账本还没记上 ----

/** 退回动文件前记下的：账本里那一笔除了「退回后」那张快照以外的部分。 */
export type RollbackStart = Omit<RollbackEvent, 'type' | 'after'>;

const rollbackMarkPath = (root: string) => path.join(runsDir(root), 'rollback.json');
/** 本进程正在做的退回（它们的记号不能当成「做到一半停了」）。 */
const rollbacksNow = new Set<string>();

/** 退回开始动文件前记一笔；返回的函数在账本记好后调用，记号删掉。 */
export function markRollback(root: string, ev: RollbackStart): { done: () => void; drop: () => void } {
  const token = crypto.randomBytes(6).toString('hex');
  const p = rollbackMarkPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ pid: process.pid, token, ev }));
  rollbacksNow.add(token);
  const drop = () => rollbacksNow.delete(token);
  return { drop, done: () => (drop(), fs.rmSync(p, { force: true })) };
}

/**
 * 上次退回做到一半就停了（进程没了、或者恢复时出错）：按文件夹现在的样子存一张，补记进账本。
 * 之后的棒照样算作废，「撤销」照样能回到退回前；清单的勾没跟着改，留给人看。
 */
export function recoverRollback(root: string): boolean {
  const p = rollbackMarkPath(root);
  let m: { pid?: number; token?: string; ev?: RollbackStart };
  try {
    m = JSON.parse(fs.readFileSync(p, 'utf8')) as typeof m;
  } catch {
    return false;
  }
  if (m.pid === process.pid ? rollbacksNow.has(m.token ?? '') : pidAlive(m.pid)) return false;
  const ev = m.ev;
  if (ev?.safety && !loadLedger(root).events.some((e) => e.type === 'rollback' && e.safety === ev.safety)) {
    const after = takeSnapshot(root, `退回到${ev.label}（中途停了）`).sha;
    appendLedger(root, { ...ev, type: 'rollback', after, interrupted: true, task: { ...(ev.task?.before ? { before: ev.task.before } : {}), unchecked: [], checked: [] } });
  }
  fs.rmSync(p, { force: true });
  return true;
}

/**
 * 对一次账。先补记上次做到一半的退回；接力台自己在调度的时候什么都不做（那一棒由调度负责记）；
 * 调度中途接力台被关掉了，就把那一棒记成「叫停了」。
 */
export function track(root: string, opts: TrackOptions = {}): TrackResult {
  const res: TrackResult = { changed: false, closed: [], opened: [], reviewed: [] };
  let v = loadLedger(root);
  if (!v.init) return res;
  if (recoverRollback(root)) {
    v = loadLedger(root);
    res.changed = true;
  }
  if (relayBusy(v)) return res;
  const now = opts.now ?? new Date();
  const snap = opts.snapshot === false ? headSnap(root) : takeSnapshot(root, '接力台看到了改动').sha;
  if (!snap) return res;
  const members = allMembers();

  // 以前读不到改动的棒（快照仓库一时出错）：再读一次，读到了就补上。
  for (const s of v.stints.filter((x) => x.factsError && x.to && x.status !== 'working')) {
    const fr = factsSafe(root, s.from, s.to!);
    if (!fr.facts) continue;
    const fixed: Stint = { ...s, facts: fr.facts };
    delete fixed.factsError;
    saveStint(root, fixed);
    res.changed = true;
  }
  // 旧版本没把终审结论记进账本：按时间找它写的结论文件（.relay/复核/终审-*.md，
  // 改动时间在这一棒开始到结束后一分钟内、只有一份）补上。找不到就不补，验收照样算「终审没留下结论」。
  const reviewFiles = listReviewFiles(root);
  for (const s of v.stints.filter((x) => x.kind === 'final' && x.status !== 'working' && !x.verdict && !x.reviewFile)) {
    const from = Date.parse(s.startedAt);
    const to = Date.parse(s.endedAt ?? s.startedAt) + 60_000;
    const hits = reviewFiles.filter((f) => /\/终审[^/]*\.md$/.test(f.rel) && f.mtimeMs >= from && f.mtimeMs <= to);
    if (hits.length !== 1) continue;
    const r = readReview(root, hits[0].rel);
    if (!r) continue;
    saveStint(root, { ...s, reviewFile: r.file, verdict: r.verdict, ...(r.verdictText ? { verdictText: r.verdictText } : {}) });
    res.changed = true;
  }
  if (res.changed) v = loadLedger(root);

  // 接力台调度到一半被关了。
  if (v.open && v.open.via === 'relay') {
    closeStint(root, v.open, { status: 'stopped', to: snap, note: '接力台中途被关掉了，这一棒没跑完。', now });
    res.closed.push(v.open.id);
    res.changed = true;
    v = loadLedger(root);
  }

  const linked = new Set(v.stints.map((s) => s.handoff).filter(Boolean) as string[]);
  const unlinked = listHandoffFiles(root).filter((f) => !linked.has(f.rel));
  let open = v.open;

  const shouldClose = (s: Stint, h: HandoffDoc | null): 'handed' | 'unfinished' | null => {
    if (h && (h.state === 'handed' || h.state === 'finished' || h.state === 'stuck')) return 'handed';
    const last = Math.max(new Date(s.activeAt ?? s.startedAt).getTime(), h?.mtimeMs ?? 0);
    if (now.getTime() - last > quietMs()) return h ? 'handed' : 'unfinished';
    return null;
  };

  if (open) {
    let cur: Stint = open;
    let dirty = false;
    if (cur.to !== snap) {
      const fr = factsSafe(root, cur.from, snap);
      cur = { ...cur, to: snap, activeAt: nowIso(now), ...(fr.facts ? { facts: fr.facts } : {}), ...(fr.error ? { factsError: fr.error } : {}) };
      if (fr.facts) delete cur.factsError;
      dirty = true;
    }
    if (!cur.handoff && unlinked.length) {
      const f = unlinked.shift()!;
      const h = readHandoff(root, f.rel);
      cur = { ...cur, handoff: f.rel, who: whoFromHandoff(h, members), ...(h?.summary ? { summary: h.summary } : {}) };
      dirty = true;
    } else if (cur.handoff && unlinked.length) {
      // 另一个 AI 开始写它的交接了：前一棒到此为止。
      const h = readHandoff(root, cur.handoff);
      closeStint(root, cur, { status: h ? 'handed' : 'unfinished', to: snap, handoff: h, now, members });
      res.closed.push(cur.id);
      res.changed = true;
      open = null;
      dirty = false;
    }
    if (open) {
      if (dirty) {
        saveStint(root, cur);
        res.changed = true;
      }
      const h = cur.handoff ? readHandoff(root, cur.handoff) : null;
      if (h && h.summary && h.summary !== cur.summary) {
        cur = { ...cur, summary: h.summary, who: whoFromHandoff(h, members) };
        saveStint(root, cur);
        res.changed = true;
      }
      const end = shouldClose(cur, h);
      if (end) {
        closeStint(root, cur, { status: end, to: snap, handoff: h, now, members });
        res.closed.push(cur.id);
        res.changed = true;
        open = null;
      }
    }
    v = loadLedger(root);
  }

  // 没有进行中的棒：有新改动、或者有新交接，就开一棒。
  if (!open) {
    const base = v.base ?? snap;
    // 这一棒开始前的任务清单：最近一次记下的（上一棒结束时、换任务时、退回后、接入时），都没有才现存一份。
    // 退回时按它恢复打勾；收工时和它比，看这一棒新打了哪些勾。
    const taskBefore = taskBaseline(v) ?? saveTaskCopy(root);
    if (unlinked.length > 1) {
      // 接力台没开着的时候，好几个 AI 先后写了交接：改动分不清是谁的，都记在最后一棒里，按其中最弱的算。
      const docs = unlinked.map((f) => readHandoff(root, f.rel));
      const whos = docs.map((h) => whoFromHandoff(h, members));
      const lastId = nextStintId(v) + unlinked.length - 1;
      const weakest = whos.some((w) => w.tier === 'unknown') ? 'unknown' : whos.some((w) => w.tier === 'weak') ? 'weak' : 'strong';
      unlinked.forEach((f, i) => {
        const last = i === unlinked.length - 1;
        const h = docs[i];
        const s: Stint = {
          id: nextStintId(loadLedger(root)),
          kind: 'work',
          who: last ? { ...whos[i], tier: weakest } : whos[i],
          via: 'native',
          startedAt: nowIso(h ? new Date(Math.min(h.bornMs ?? h.mtimeMs, now.getTime())) : now),
          activeAt: nowIso(now),
          from: base,
          to: last ? snap : base,
          status: 'working',
          review: 'needed',
          handoff: f.rel,
          ...(taskBefore ? { taskBefore } : {}),
          note: last
            ? `接力台没开着的时候，第 ${nextStintId(v)}–${lastId} 棒的改动混在一起了，都记在这一棒里（按其中最弱的算）。`
            : `接力台没开着，这一棒的改动和后面几棒混在一起，记在第 ${lastId} 棒里。`,
          ...(h?.summary ? { summary: h.summary } : {}),
        };
        saveStint(root, s);
        res.opened.push(s.id);
        closeStint(root, s, { status: h && h.state !== 'working' ? 'handed' : last ? 'unfinished' : 'handed', to: s.to!, handoff: h, now, members, noTicks: !last });
        res.closed.push(s.id);
      });
      unlinked.length = 0;
      res.changed = true;
    } else if (base !== snap || unlinked.length) {
      const f = unlinked.shift();
      const h = f ? readHandoff(root, f.rel) : null;
      const s: Stint = {
        id: nextStintId(v),
        kind: 'work',
        who: whoFromHandoff(h, members),
        via: 'native',
        // 开工时间：它建交接文件的时候（接力台没开着时也对得上），没有交接就是现在。
        startedAt: nowIso(h ? new Date(Math.min(h.bornMs ?? h.mtimeMs, now.getTime())) : now),
        activeAt: nowIso(now),
        from: base,
        to: snap,
        status: 'working',
        review: 'needed',
        ...(() => {
          const fr = factsSafe(root, base, snap);
          return fr.facts ? { facts: fr.facts } : { factsError: fr.error };
        })(),
        ...(taskBefore ? { taskBefore } : {}),
        ...(f ? { handoff: f.rel } : {}),
        ...(h?.summary ? { summary: h.summary } : {}),
      };
      saveStint(root, s);
      res.opened.push(s.id);
      res.changed = true;
      // 接力台没开着的时候就写好的交接：已经写完了就直接结束。
      if (h && (h.state === 'handed' || h.state === 'finished' || h.state === 'stuck')) {
        closeStint(root, s, { status: 'handed', to: snap, handoff: h, now, members });
        res.closed.push(s.id);
      }
    }
  }

  const reviewer = loadLedger(root).open;
  const marked = applyReviews(root, reviewer, members, now);
  if (marked.length) {
    res.reviewed.push(...marked);
    res.changed = true;
  }
  if (refreshBrief(root, now)) res.changed = true;
  return res;
}

/** 对账，再给刚结束的棒跑检查命令（异步）。盯文件夹、网页用这个。 */
export async function trackAndGate(root: string, opts: TrackOptions = {}): Promise<TrackResult> {
  const r = track(root, opts);
  for (const id of r.closed) {
    try {
      await gateStint(root, id, undefined, { absorb: 'generated' });
    } catch {
      /* 检查跑不了不影响记账 */
    }
  }
  if (r.closed.length) refreshBrief(root);
  return r;
}

/** 接力台自己改了项目文件（更新规矩之类）：存一张快照当新的起点，不算到哪一棒头上。 */
export function markBase(root: string, why: string): void {
  const v = loadLedger(root);
  if (!v.init || v.open) return;
  const r = takeSnapshot(root, why);
  if (r.sha !== v.base) appendLedger(root, { type: 'base', ts: nowIso(), snap: r.sha, why });
}
