import { langNote } from './auto-settings';
import { skillNote } from './skills';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayError, errorMessage } from './errors';
import { loadDetected, memberModel, refreshHarnessModel } from './detect';
import { cliTooOld, explainFailure, findHarness, locateCached, modelArg, noteModelNeeds, type Invocation } from './harness';
import { fillTemplate } from './launch';
import { runLlmAgent } from './llm-agent';
import { llmName, toolName } from './names';
import { shellArgv } from './proc';
import { redactSecrets } from './redact';
import { sessionFile, sessionToolOf } from './sessions';
import { blockMember, detectQuota, failureKind, noteLimits } from './quota';
import { clip, lastError, logTail, looksLikeNetworkBlip, startRun, toolLines, type RunResult } from './runner';
import { cause, plain } from './cause';
import { agentKind, agentLabel, canTalk, findAgent, loadRegistry, OUT_PLACEHOLDER } from './registry';
import type { AgentConfig } from './types';

/**
 * 讨论：人问一句，选中的几个 AI 依次发言，每个都看得到前面的全部内容。
 * 讨论只说话、不改文件，记录存在项目的 .relay/talk.jsonl（不进 git）。
 */
export interface TalkRow {
  ts: string;
  kind: 'human' | 'ai' | 'system';
  who: string;
  agent?: string;
  model?: string;
  text: string;
  /** 这条是「没回上来」的说明。 */
  error?: boolean;
  /** 「对比」：同一轮的几条（互相看不到）。 */
  round?: string;
  /** 这句话后面是怎么请 AI 回答的：turn 讨论（轮流说）/ solo 对比（同时答）。 */
  mode?: TalkMode;
  /** 这一条是总结：把最后一问的几份回答并成一份（学 llm-council 的主持人收尾）。 */
  summary?: boolean;
  /** 这一条说的是「采纳了哪条总结」（那条总结的时间）。 */
  adopt?: string;
  /** 这句回答在它自己工具里的那段对话（工具、对话编号）：同一段群聊里它下一次接着这段说，人也能回到工具里接着说。 */
  session?: { tool: string; id: string };
}

/** turn = 讨论：轮流说（后面的看得到前面的）；solo = 对比：同时问，互相看不到，回答并排放。 */
export type TalkMode = 'turn' | 'solo';

export function talkPath(root: string): string {
  return path.join(root, '.relay', 'talk.jsonl');
}

/** 存档的群聊（点「新群聊」时旧的改名存下）：.relay/talk-年月日-时分秒.jsonl，id 就是去掉 .jsonl 的文件名。 */
const ARCHIVE = /^talk-\d{8}-\d{6}(?:-\d+)?$/;

/** 群聊记录的文件：不给 id 是正在用的那一个。 */
export function talkFile(root: string, id?: string | null): string {
  if (!id) return talkPath(root);
  if (!ARCHIVE.test(id)) throw new RelayError('没有这个群聊。', 'no-talk');
  return path.join(root, '.relay', `${id}.jsonl`);
}

/** 读讨论记录。兼容旧版格式（person/system + windowId），跳过旧版残留的「正在说」占位行。 */
export function readTalk(root: string, limit = 400, p = talkPath(root)): TalkRow[] {
  if (!fs.existsSync(p)) return [];
  const out: TalkRow[] = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (r.pending || r.kind === 'vote') continue;
    const text = typeof r.text === 'string' ? r.text : '';
    if (!text.trim()) continue;
    const ts = typeof r.ts === 'string' ? r.ts : new Date(0).toISOString();
    const kindIn = r.kind;
    const windowId = typeof r.windowId === 'string' ? r.windowId : undefined;
    let kind: TalkRow['kind'];
    if (kindIn === 'human' || kindIn === 'ai' || kindIn === 'system') kind = kindIn;
    else if (r.mine || windowId === 'human') kind = 'human';
    else if (kindIn === 'system') kind = 'system';
    else kind = 'ai';
    const agent = typeof r.agent === 'string' ? r.agent : windowId && windowId !== 'human' ? windowId : undefined;
    const model = typeof r.model === 'string' ? r.model : typeof r.llm === 'string' ? r.llm : undefined;
    out.push({
      ts,
      kind,
      who: typeof r.who === 'string' && r.who ? r.who : kind === 'human' ? '我' : agentLabel(agent ?? '?'),
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      text,
      ...(r.error ? { error: true } : {}),
      ...(typeof r.round === 'string' ? { round: r.round } : {}),
      ...(r.mode === 'turn' || r.mode === 'solo' ? { mode: r.mode } : {}),
      ...(r.summary === true ? { summary: true } : {}),
      ...(typeof r.adopt === 'string' ? { adopt: r.adopt } : {}),
      ...(r.session && typeof r.session === 'object' && typeof (r.session as { tool?: unknown }).tool === 'string' && typeof (r.session as { id?: unknown }).id === 'string'
        ? { session: { tool: (r.session as { tool: string }).tool, id: (r.session as { id: string }).id } }
        : {}),
    });
  }
  return out.slice(-limit);
}

/** 往一段群聊的记录里追加任意一行（投票也存在这里）。 */
export function appendTalkRaw(file: string, row: object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

export function appendTalk(root: string, row: Omit<TalkRow, 'ts'> & { ts?: string }, file = talkPath(root)): TalkRow {
  const full: TalkRow = { ts: row.ts ?? new Date().toISOString(), ...row } as TalkRow;
  appendTalkRaw(file, full);
  return full;
}

// ---- 一段群聊 = 一个记录文件。正在说的一轮、在跑的投票都拿着它：存档、接着聊时文件改了名，它们接着往原来那段里写 ----

interface Round {
  queue: string[];
  /** 正在说的（对比时好几个同时说）。 */
  current: Set<string>;
  since: string | null;
  running: Promise<void> | null;
  /** 排队的「对比」轮：同一轮的人一起问。 */
  soloQueue: { id: string; names: string[] }[];
  /** 排队总结的人：前面的回答都说完了才总结。 */
  summaryQueue: string[];
  /** 正在总结的那一位。 */
  summing: string | null;
}

export interface Thread {
  file: string;
  round: Round | null;
  /** 在跑的投票有几个。 */
  votes: number;
}

const threads = new Map<string, Thread>();

/** 这个记录文件的群聊：说话、投票时拿着，说完、投完就不再记着（releaseThread）。 */
export function threadOf(file: string): Thread {
  const k = path.resolve(file);
  let t = threads.get(k);
  if (!t) threads.set(k, (t = { file: k, round: null, votes: 0 }));
  return t;
}

export function releaseThread(t: Thread): void {
  if (!t.round && t.votes === 0 && threads.get(t.file) === t) threads.delete(t.file);
}

/** 记录文件改名（存档、接着聊）：在说的、在投的跟着过去。 */
function moveTalk(from: string, to: string): void {
  fs.renameSync(from, to);
  const t = threads.get(path.resolve(from));
  if (!t) return;
  threads.delete(t.file);
  t.file = path.resolve(to);
  threads.set(t.file, t);
}

/** 新群聊：正在用的记录改名存档（talk-时间.jsonl），不删；是空的就不存。返回存档的 id。 */
export function archiveTalk(root: string): string | null {
  const p = talkPath(root);
  let text = '';
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
  if (!text.trim()) {
    fs.rmSync(p, { force: true });
    return null;
  }
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = `talk-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  let id = base;
  for (let i = 2; fs.existsSync(talkFile(root, id)); i++) id = `${base}-${i}`;
  moveTalk(p, talkFile(root, id));
  return id;
}

/** 删掉的群聊挪到这里（不真删，右键「删除群聊」之后点「撤销」能找回来）。 */
const DELETED_DIR = '已删除的群聊';

/** 这段群聊还有人在说、在投。 */
function talkBusy(file: string): boolean {
  const t = threads.get(path.resolve(file));
  return !!t && (!!t.round || t.votes > 0);
}

/**
 * 删除一段群聊（id 为空是正在用的那段）：挪进 .relay/已删除的群聊/，左边不再列出。还有人在说、在投的不删。
 * 返回删掉的那段的 id（找回用）；正在用的那段是空的就什么都不做，返回 null。
 */
export function deleteTalk(root: string, id: string | null): string | null {
  const file = talkFile(root, id);
  if (talkBusy(file)) throw new RelayError('这段群聊还有 AI 在说或在投票，等说完再删', 'talk-busy');
  const archived = id || archiveTalk(root);
  if (!archived) return null;
  const from = talkFile(root, archived);
  if (!fs.existsSync(from)) throw new RelayError('没有这个群聊。', 'no-talk');
  const dir = path.join(root, '.relay', DELETED_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(from, path.join(dir, `${archived}.jsonl`));
  sessionCache.delete(from);
  return archived;
}

/** 找回删掉的群聊：挪回去，还是一段存档的群聊。 */
export function restoreTalk(root: string, id: string): void {
  const to = talkFile(root, id); // 顺便核对 id 的写法
  const from = path.join(root, '.relay', DELETED_DIR, `${id}.jsonl`);
  if (!fs.existsSync(from) || fs.existsSync(to)) throw new RelayError('没有这个群聊。', 'no-talk');
  fs.renameSync(from, to);
}

/** 接着一个存档的群聊：正在用的先存档，再把它换回来。 */
export function resumeTalk(root: string, id: string): void {
  const from = talkFile(root, id);
  if (!fs.existsSync(from)) throw new RelayError('没有这个群聊。', 'no-talk');
  archiveTalk(root);
  moveTalk(from, talkPath(root));
  sessionCache.delete(from);
}

export interface TalkSession {
  id: string;
  /** 第一句问话（没有就是第一个投票的问题）。 */
  title: string;
  /** 最后一条的时间。 */
  at: string;
  /** 还有人在说、在投（点「新群聊」时这段还没说完，接着往这里写）。 */
  busy?: boolean;
}

const sessionCache = new Map<string, { size: number; mtimeMs: number; s: TalkSession }>();

/** 存档的群聊，最近的在前。存档不会再变：按文件大小和修改时间记住，不每次重读。 */
export function talkSessions(root: string, limit = 40): TalkSession[] {
  const dir = path.join(root, '.relay');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl') && ARCHIVE.test(n.slice(0, -6)));
  } catch {
    return [];
  }
  const out: TalkSession[] = [];
  for (const n of names) {
    const file = path.join(dir, n);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const hit = sessionCache.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
      out.push(hit.s);
      continue;
    }
    let title = '';
    let at = '';
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof r.ts === 'string' && r.ts > at) at = r.ts;
      if (!title && r.kind === 'human' && typeof r.text === 'string') title = r.text;
      if (!title && r.kind === 'vote' && typeof r.question === 'string') title = r.question;
    }
    const s: TalkSession = { id: n.slice(0, -6), title: title.trim().split('\n')[0].slice(0, 60) || '群聊', at: at || st.mtime.toISOString() };
    sessionCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, s });
    out.push(s);
  }
  return out
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
    .map((s) => {
      const t = threads.get(path.resolve(dir, `${s.id}.jsonl`));
      return t && (t.round || t.votes) ? { ...s, busy: true } : s;
    });
}

export interface TalkContext {
  task?: { title: string; phaseText: string; changes: string[] } | null;
}

/**
 * 群聊、投票、总结里给的项目背景。写明不是这次的题目：2026-10-04 群聊里问的是一份课程总结，
 * DeepSeek Flash 把提示末尾的「当前任务：给 notes.py 加 clear 命令」当成了题目，去核那个早就做完的任务。
 */
export function taskBackground(ctx?: TalkContext): string {
  const t = ctx?.task;
  if (!t) return '项目背景：现在没有进行中的接力任务。';
  const changes = t.changes.length ? `已改动的文件：${t.changes.slice(0, 30).join('、')}。` : '';
  return `项目背景（只供参考，不是这次要讨论的题目）：这个项目里的接力任务是「${t.title}」，${t.phaseText}。${changes}`;
}

/** 这是讨论，不是接力的一棒（有的工具开工会自己读 AGENTS.md 里的接力规矩，读了就以为自己是来干活的）。 */
const NOT_A_LEG = '- 这是讨论，不是接力的一棒：项目里 AGENTS.md、CLAUDE.md 的「接力规矩」（读接力本、建交接、复核、跑测试）这次都不用做。要回答的是讨论记录里人最后问的那个问题。';

/** 轮到谁，再把人最后问的那句重复一遍（放在最后，模型最看得到）。 */
function yourTurn(speaker: string, ask?: TalkRow): string {
  const q = ask?.text.trim();
  return `现在轮到你（${speaker}）发言。${q ? `\n要回答的是 [${hhmm(ask!.ts)}] 人问的：「${q.length > 300 ? `${q.slice(0, 300)}…` : q}」` : ''}`;
}

function hhmm(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 群聊里一次最多带多少字的讨论记录；更早的写明在哪个文件，要看自己打开。 */
export const TALK_HISTORY_CHARS = 40_000;
/** 放进来的记录从第几句开始：按这么多句一档往后挪，挪一次管好几轮（开头不变，接口的缓存才接得上）。 */
const TALK_STEP = 12;

/**
 * 拼给某个 AI 的发言提示。纯函数。solo = 对比（这一轮别人的回答不给它看）。file = 这段群聊的完整记录（相对项目）。
 * 顺序按「不变的在前、变的在后」：规则 → 讨论记录（只往后接）→ 任务状态、轮到谁。
 * 各家接口按开头相同的部分算缓存：开头一变，后面整段都要按全价重读。
 */
export function buildTalkPrompt(input: { speaker: string; root: string; rows: TalkRow[]; context?: TalkContext; maxChars?: number; solo?: boolean; file?: string; since?: boolean; ask?: TalkRow }): string {
  if (input.since) return followUpPrompt(input);
  const max = input.maxChars ?? TALK_HISTORY_CHARS;
  const lines = input.rows
    .filter((r) => !r.error)
    .map((r) => `[${hhmm(r.ts)}] ${r.kind === 'system' ? '（接力台）' : r.who}：${r.text.trim()}`);
  // 最少要从哪一句开始才放得下；再往后取整到一档（最后一句总要在）
  let need = lines.length;
  for (let size = 0; need > 0 && size + lines[need - 1].length + 2 <= max; need--) size += lines[need - 1].length + 2;
  if (need === lines.length && need > 0) need--;
  let from = Math.ceil(need / TALK_STEP) * TALK_STEP;
  if (from >= lines.length) from = need;
  const kept = lines.slice(from);
  const ask = input.ask ?? [...input.rows].reverse().find((r) => r.kind === 'human');
  const where = input.file ? `完整记录在 \`${input.file}\`` : '';
  const head = from > 0 ? `较早的 ${from} 句没放进来${where ? `，${where}，需要时自己打开看` : ''}` : where;
  const parts = [
    '你在参加「接力台」里的一场多 AI 讨论。',
    `项目文件夹：${input.root}（可以读里面的文件做参考，但不要修改任何文件，也不要执行会改变东西的命令）。`,
    [
      '怎么发言：',
      '- 直接给出你的判断和理由，不客套，不复述别人已经说过的话。',
      '- 可以点名回应别人的观点：同意还是不同意，为什么。你有不同的想法就直说，不要因为对方是更强的模型就附和。',
      '- 说清楚为止：简单的问题几句话，复杂的问题写完整（结论在前，依据、做法在后），不为凑短删掉该说的。',
      '- 消息里用反引号括起来的路径是提到的文件；.relay/uploads/ 下的是人传上来的附件（图片、文档……），需要就自己打开看，图片用你能看图的工具打开。',
      NOT_A_LEG,
      // 例子里不写真实的模型名：2026-10-04 写了「比如你是 GLM-5.3 Flash」，GLM-5.3 就自称 GLM-5.3 Flash
      '- 记录里署名和你不一样的话都不是你说的，同一家的另一个型号也不是你（名字只差 Flash、Pro、Mini 这类后缀的，是另一位）。你是谁，只看最后一句「你是」。',
      '- 用中文。只输出你要说的话本身。',
    ].join('\n'),
    `讨论记录（${head ? `${head}；` : ''}最新的在最后）：\n${kept.join('\n\n') || '（还没有人说话）'}`,
    taskBackground(input.context),
    `你是「${input.speaker}」。` +
      (input.solo
        ? `这一轮是「对比」：几个 AI 同时回答最后那个问题，互相看不到，回答会并排放在一起给人对比。请给出你自己独立的判断，不用顾及别人会怎么说。${yourTurn(input.speaker, ask)}`
        : yourTurn(input.speaker, ask)),
  ];
  return redactSecrets(parts.join('\n\n'));
}

/**
 * 接着它工具里那段对话说：前面的讨论、规矩它都看过了，只给它上次说完之后的新消息、现在的任务状态、轮到它。
 * 新消息太多放不下时，和第一次一样只留最后那些，告诉它完整记录在哪。
 */
function followUpPrompt(input: { speaker: string; rows: TalkRow[]; context?: TalkContext; maxChars?: number; solo?: boolean; file?: string; ask?: TalkRow }): string {
  const max = input.maxChars ?? TALK_HISTORY_CHARS;
  const lines = input.rows.filter((r) => !r.error).map((r) => `[${hhmm(r.ts)}] ${r.kind === 'system' ? '（接力台）' : r.who}：${r.text.trim()}`);
  let from = lines.length;
  for (let size = 0; from > 0 && size + lines[from - 1].length + 2 <= max; from--) size += lines[from - 1].length + 2;
  if (from === lines.length && from > 0) from--;
  const kept = lines.slice(from);
  const ask = input.ask ?? [...input.rows].reverse().find((r) => r.kind === 'human');
  const parts = [
    `还是「接力台」里的这场多 AI 讨论，规矩和上面一样（只说话，不改文件；这是讨论，不是接力的一棒）。`,
    `你上次说完之后的新消息（${from > 0 ? `较早的 ${from} 句没放进来${input.file ? `，完整记录在 \`${input.file}\`` : ''}；` : ''}最新的在最后）：\n${kept.join('\n\n') || '（没有新消息）'}`,
    taskBackground(input.context),
    input.solo
      ? `这一轮是「对比」：几个 AI 同时回答最后那个问题，互相看不到。请给出你自己独立的判断。${yourTurn(input.speaker, ask)}`
      : yourTurn(input.speaker, ask),
  ];
  return redactSecrets(parts.join('\n\n'));
}

function cleanReply(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '')
    .trim()
    .slice(0, 40_000);
}

/** 群聊里一个 AI 最多说多久；中途这么久一点动静都没有就当它卡住了（Codex 干活时最长 49 秒不出声）。 */
export const TALK_MAX_MS = 15 * 60_000;
export const TALK_IDLE_MS = 3 * 60_000;

/** 回的是「调用工具」的原文（没给它工具、或者接口没接住）：不是回答。 */
const RAW_TOOL_CALL = /^<(?:tool_call|function_calls?)>/;

/** 额度用完、余额不足（和干活时认的是同一套），带上它的原话。 */
function quotaWhy(text: string): string | null {
  const q = detectQuota(text);
  return q.hit ? `${cause.quota(q.until)}${q.line ? `，原话：${clip(plain(q.line), 160)}` : ''}` : null;
}

/** 工具一句话没说就结束了：从日志里找原因——被拒绝的操作、额度、认得的报错、它自己最后报的错。 */
function silentWhy(harness: string | undefined, log: string, r: RunResult): string {
  const denied = log.match(/被拒绝：(.+)/)?.[1];
  if (denied) return cause.denied(denied);
  const quota = quotaWhy(`${r.stderrTail}\n${toolLines(log)}`);
  if (quota) return quota;
  const hint = explainFailure(harness, `${r.stderrTail}\n${log}`);
  if (hint) return hint;
  const said = lastError(r.stderrTail, log);
  return said ? cause.exit(r.code, clip(said, 200)) : cause.silent(r.code);
}

function replyOf(raw: string): string {
  const text = cleanReply(raw);
  if (RAW_TOOL_CALL.test(text)) throw new RelayError(cause.rawToolCall, 'ask-empty');
  return text;
}

/**
 * 没答出来时把过程留在项目的 .relay/runs/讨论-<名字>.log（同一位只留最近一次；答出来了就不留），下次查得到卡在哪。
 * 2026-10-04 群聊里 GLM-5.3 Flash 跑满 15 分钟一个字没交，接口型的过程当时没记，查不到原因。返回相对项目的路径。
 */
function keepFailLog(cwd: string, name: string, text: string): string {
  try {
    if (!text.trim() || !fs.existsSync(path.join(cwd, '.relay'))) return '';
    const rel = `.relay/runs/讨论-${name.replace(/[\\/:*?"<>|\s]+/g, '-')}.log`;
    fs.mkdirSync(path.join(cwd, '.relay', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), redactSecrets(text));
    return rel;
  } catch {
    return '';
  }
}
const logNote = (rel: string) => (rel ? `（过程记在 \`${rel}\`）` : '');

/** 让一个 AI 回答。接口型用内置小代理，只给读文件的工具；编程工具、自定义命令见下面。 */
export async function askAgent(agent: AgentConfig, prompt: string, cwd: string, timeoutMs = TALK_MAX_MS, idleMs = TALK_IDLE_MS): Promise<string> {
  return (await askAgentRun(agent, prompt, cwd, { timeoutMs, idleMs })).text;
}

/**
 * askAgent，另外带回这次回答在它工具里的对话（工具、编号）；给了 resume 就接着那段对话说
 * （工具自己记下来的对话一直是同一段：群聊里的话同步进了工具的历史，人在工具里也接得上）。
 */
export async function askAgentRun(agent: AgentConfig, prompt: string, cwd: string, opts: { timeoutMs?: number; idleMs?: number; resume?: string } = {}): Promise<{ text: string; session?: { tool: string; id: string } }> {
  const timeoutMs = opts.timeoutMs ?? TALK_MAX_MS;
  const idleMs = opts.idleMs ?? TALK_IDLE_MS;
  prompt += langNote();
  if (agentKind(agent) === 'api') {
    if (!agent.api) throw new RelayError('没有配置接口', 'no-api');
    const t0 = Date.now();
    const lines: string[] = [];
    // 和编程工具一样能看项目里的文件：不给工具的话，它会把「调用工具」的原文当成回答说出来。
    const r = await runLlmAgent({
      spec: agent.api,
      cwd,
      brief: prompt,
      level: 'safe',
      readOnly: true,
      gateCommand: '',
      protectedPaths: [],
      log: (s) => lines.push(`[${Math.round((Date.now() - t0) / 1000)} 秒] ${s}`),
      shouldStop: () => false,
      deadline: Date.now() + timeoutMs,
      maxSteps: 30,
    });
    const text = replyOf(r.finalText);
    if (!text) {
      const kind = r.error ? failureKind(r.error) : null;
      if (kind) blockMember(agent.name, kind, r.error ?? '', agent.api.model);
      const rel = keepFailLog(cwd, agent.name, [`${agent.api.model} · ${new Date(t0).toISOString()}`, ...lines, r.error ? `出错：${r.error}` : r.timedOut ? '到了时限' : '没有回答'].join('\n'));
      throw new RelayError((r.error ? (quotaWhy(r.error) ?? plain(r.error)) : r.timedOut ? cause.overtime(timeoutMs) : cause.silent()) + logNote(rel), 'ask-empty');
    }
    return { text };
  }
  // 编程工具用它的只读模式回答；自定义命令把提示从标准输入喂进去，回答是它的标准输出（或 {{out}} 文件）。
  // 两种都交给 startRun：计时、太久没动静就停、不传宿主的会话变量（agentEnv）、认没成的原因都是同一套。
  const stamp = `${process.pid}-${Date.now()}`;
  const outFile = path.join(os.tmpdir(), `relay-talk-${stamp}.txt`);
  const logPath = path.join(os.tmpdir(), `relay-talk-${stamp}.log`);
  const tpl = agent.ask?.trim();
  let harness: string | undefined;
  let make: () => Invocation;
  if (tpl) {
    const out = tpl.includes(OUT_PLACEHOLDER) ? outFile : undefined;
    const argv = shellArgv(fillTemplate(tpl, out ? { out } : {}));
    make = () => ({ argv, stdin: prompt, format: 'text', env: { NO_COLOR: '1' }, ...(out ? { outFile: out } : {}) });
  } else {
    const spec = findHarness(agent.harness);
    const loc = spec ? locateCached(spec) : null;
    if (!spec || !loc) throw new RelayError('没有配置讨论命令', 'no-ask');
    harness = spec.id;
    make = () => spec.invoke(loc, { cwd, prompt, level: 'safe', readOnly: true, model: agent.model?.trim() || undefined, effort: agent.effort, outFile, ...(opts.resume ? { resume: opts.resume } : {}) });
  }
  const inv = make();
  let r = await startRun({ invocation: inv, cwd, timeoutMs, idleMs, logPath, title: '讨论' }).done;
  // 命令行太旧、用不了这个模型：记下来，换成它用得了的再问一次。
  const needs = harness && r.code !== 0 ? cliTooOld(`${r.finalText}\n${r.error ?? ''}\n${r.stderrTail}`) : null;
  const used = modelArg(inv.argv);
  if (harness && needs && used) {
    noteModelNeeds(used, needs);
    refreshHarnessModel(harness);
    const again = make();
    if (modelArg(again.argv) !== used) r = await startRun({ invocation: again, cwd, timeoutMs, idleMs, logPath, title: '讨论' }).done;
  }
  // 像是临时出错（网络抖了、服务器忙、Cursor 一时拿不到模型列表），又一句话没说：等几秒原地再问一次
  const said = `${r.error ?? ''}\n${r.stderrTail}\n${toolLines(logTail(logPath, 6000))}`;
  if (r.code !== 0 && !r.stopped && !r.timedOut && !r.finalText.trim() && !detectQuota(said).hit && looksLikeNetworkBlip(said)) {
    await new Promise((res) => setTimeout(res, Number(process.env.RELAY_RETRY_MS ?? 5000)));
    r = await startRun({ invocation: make(), cwd, timeoutMs, idleMs, logPath, title: '讨论' }).done;
  }
  noteLimits(agent.name, r.limits);
  const log = logTail(logPath, 6000);
  fs.rmSync(logPath, { force: true });
  const text = replyOf(r.finalText);
  if (!text) {
    // 模型用不了、没登录：和派活一样先停用这一位（换了模型、重新登录、过一阵再算）
    const toolSaid = `${r.error ?? ''}\n${r.stderrTail}\n${toolLines(log)}`;
    const kind = harness ? failureKind(toolSaid) : null;
    if (kind) blockMember(agent.name, kind, toolSaid, memberModel(agent, loadDetected()));
    const rel = keepFailLog(cwd, agent.name, `${log}\n${r.stderrTail}`);
    throw new RelayError((r.error ? plain(r.error) : r.timedOut ? (r.late ?? cause.overtime(timeoutMs)) : silentWhy(harness, log, r)) + logNote(rel), 'ask-empty');
  }
  return { text, ...(harness && r.session ? { session: { tool: harness, id: r.session } } : {}) };
}

/** 一段群聊里谁在说、谁在排队。 */
export function talkStatus(file: string): { current: { agent: string; label: string; since: string } | null; speaking: { agent: string; label: string }[]; queue: { agent: string; label: string }[]; summing?: string } {
  const r = threads.get(path.resolve(file))?.round;
  const lab = (n: string) => {
    const a = findAgent(n);
    return a ? speakerName(a) : n;
  };
  const speaking = [...(r?.current ?? [])].map((n) => ({ agent: n, label: lab(n) }));
  const first = speaking[0];
  return {
    current: first ? { ...first, since: r?.since ?? '' } : null,
    speaking,
    queue: [...(r?.queue ?? []), ...(r?.soloQueue ?? []).flatMap((q) => q.names), ...(r?.summaryQueue ?? [])].map((n) => ({ agent: n, label: lab(n) })),
    ...(r?.summing ? { summing: r.summing } : {}),
  };
}

/**
 * 群聊里的名字：它实际用的模型（GPT-6 Sol；Claude Code 接的是 DeepSeek 就叫 DeepSeek Flash），认不出模型的写工具名。
 * 名单里还有一位也是这个模型：后面带上工具，免得大家分不清在跟谁说话。
 */
export function speakerName(agent: AgentConfig): string {
  const report = loadDetected();
  const nameOf = (a: AgentConfig) => llmName(memberModel(a, report)) || agentLabel(a);
  const mine = nameOf(agent);
  let twin = false;
  try {
    twin = loadRegistry().agents.some((a) => a.name !== agent.name && canTalk(a) && nameOf(a) === mine);
  } catch {
    /* 名单读不了：不带工具 */
  }
  const tool = toolName(agent.harness) ?? (agentKind(agent) === 'api' ? '接口' : undefined);
  return twin && tool ? `${mine}（${tool}）` : mine;
}

function safeContext(context: () => TalkContext): TalkContext {
  try {
    return context();
  } catch {
    return {};
  }
}

/** 工具说接不上那段对话（被删了、过期了）的说法。 */
const LOST_THREAD = /no (?:conversation|session|rollout|thread)s? found|(?:session|conversation|thread|rollout).{0,40}(?:not found|does ?n[o']t exist)|could not (?:find|resume)|找不到(?:这段)?(?:对话|会话)/i;

/** 这几家能按编号接着一段对话说（只读也行）。 */
const RESUMABLE = new Set(['claude', 'claude-official', 'codex', 'cursor-agent', 'agy']);

/**
 * 它在这段群聊里上一次回答留下的工具对话：同一个工具、同一个模型、对话记录还在（读得到的两家先核实文件在不在），
 * 返回编号和从第几行起是它没看过的新消息。换了工具、换了模型、从没答过的返回 null（另开一段，带上整段记录）。
 */
function ownThread(root: string, agent: AgentConfig, rows: TalkRow[]): { id: string; after: number } | null {
  if (!agent.harness || !RESUMABLE.has(agent.harness) || agent.ask?.trim()) return null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.kind !== 'ai' || r.agent !== agent.name || r.error) continue;
    if (!r.session || r.session.tool !== agent.harness) return null;
    const now = memberModel(agent, loadDetected());
    if (r.model && now && r.model !== now) return null;
    const tool = sessionToolOf(r.session.tool);
    if (tool && !sessionFile(root, tool, r.session.id)) return null;
    return { id: r.session.id, after: i + 1 };
  }
  return null;
}

async function speakOne(root: string, th: Thread, name: string, rows: TalkRow[], context: () => TalkContext, solo?: string): Promise<void> {
  const agent = findAgent(name);
  try {
    if (!agent) throw new RelayError('名单里没有它', 'no-agent');
    const who = speakerName(agent);
    // 问话里写了 /技能名：附上这个技能的做法
    const asked = [...rows].reverse().find((r) => r.kind === 'human');
    const file = path.relative(root, th.file).split(path.sep).join('/');
    const note = skillNote(root, asked?.text ?? '');
    const full = () => buildTalkPrompt({ speaker: who, root, rows, context: safeContext(context), file, ask: asked, ...(solo ? { solo: true } : {}) }) + note;
    // 它在这段群聊里说过话、工具里那段对话还在：接着那段说，只带它上次说完之后的新消息
    const own = ownThread(root, agent, rows);
    let r: { text: string; session?: { tool: string; id: string } };
    if (own) {
      try {
        r = await askAgentRun(agent, buildTalkPrompt({ speaker: who, root, rows: rows.slice(own.after), context: safeContext(context), file, since: true, ask: asked, ...(solo ? { solo: true } : {}) }) + note, root, { resume: own.id });
      } catch (e) {
        // 工具里那段对话接不上了（被删、过期）：另开一段，带上整段记录
        if (!LOST_THREAD.test(errorMessage(e))) throw e;
        r = await askAgentRun(agent, full(), root);
      }
    } else r = await askAgentRun(agent, full(), root);
    // 问的过程中可能换了模型（比如命令行太旧、换成了它用得了的）：署名按答完之后的算。
    const m = memberModel(agent, loadDetected());
    appendTalk(root, { kind: 'ai', who: speakerName(agent), agent: agent.name, ...(m ? { model: m } : {}), text: r.text, ...(solo ? { round: solo } : {}), ...(r.session ? { session: r.session } : {}) }, th.file);
  } catch (e) {
    appendTalk(root, { kind: 'system', who: '接力台', agent: name, text: `${agent ? speakerName(agent) : name} 没有回答：${plain(errorMessage(e))}`, error: true, ...(solo ? { round: solo } : {}) }, th.file);
  }
}

/** 同时跑一批，最多 limit 个一起。 */
export async function inParallel<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  const q = [...items];
  const workers = Array.from({ length: Math.min(limit, q.length) }, async () => {
    for (;;) {
      const x = q.shift();
      if (x === undefined) return;
      await fn(x);
    }
  });
  await Promise.all(workers);
}

/** 一段群聊里排着的人一个个说完（对比那一轮一起说）。读、写都按 th.file：中途存档了也写回原来那段。 */
async function runRound(root: string, th: Thread, r: Round, context: () => TalkContext): Promise<void> {
  for (;;) {
    const solo = r.soloQueue.shift();
    if (solo) {
      // 对比：大家看到的记录都停在这一刻，互相看不到这一轮别人的回答。
      const rows = readTalk(root, Infinity, th.file);
      r.since = new Date().toISOString();
      for (const n of solo.names) r.current.add(n);
      await inParallel(solo.names, 4, async (n) => {
        await speakOne(root, th, n, rows, context, solo.id);
        r.current.delete(n);
      });
      continue;
    }
    const name = r.queue.shift();
    if (name) {
      r.current.add(name);
      r.since = new Date().toISOString();
      await speakOne(root, th, name, readTalk(root, Infinity, th.file), context);
      r.current.delete(name);
      continue;
    }
    // 回答都说完了：再总结
    const sum = r.summaryQueue.shift();
    if (!sum) break;
    r.current.add(sum);
    r.summing = sum;
    r.since = new Date().toISOString();
    await summarizeOne(root, th, sum, context);
    r.summing = null;
    r.current.delete(sum);
  }
}

export function checkSpeakers(ask: string[]): string[] {
  const names: string[] = [];
  for (const n of ask) {
    const a = findAgent(n);
    if (!a) throw new RelayError(`名单里没有「${n}」`, 'no-agent');
    if (!canTalk(a)) throw new RelayError(`「${speakerName(a)}」还不能参加群聊。`, 'cannot-talk');
    if (!names.includes(n)) names.push(n);
  }
  return names;
}

/**
 * 人说一句（写进正在用的那段群聊），并请几位 AI 回应。立即返回；回答在后台陆续写进这段的记录。
 * turn：一个接一个，后面的看得到前面的；solo：同时问，互相看不到（对比）。
 * 已经有一轮在跑时，新请的人排到后面（他们发言时会看到这句话）。
 */
export function say(root: string, text: string, ask: string[], context: () => TalkContext = () => ({}), mode: TalkMode = 'turn'): { row: TalkRow; queued: string[]; done: Promise<void> } {
  const t = text.trim();
  if (!t) throw new RelayError('消息是空的', 'empty');
  const names = checkSpeakers(ask);
  const th = threadOf(talkPath(root));
  const row = appendTalk(root, { kind: 'human', who: '我', text: t, mode }, th.file);
  if (!names.length) {
    releaseThread(th);
    return { row, queued: [], done: th.round?.running ?? Promise.resolve() };
  }
  const r = (th.round ??= newRound());
  if (mode === 'solo') r.soloQueue.push({ id: `solo-${Date.now().toString(36)}`, names });
  else for (const n of names) if (!r.queue.includes(n) && !r.current.has(n)) r.queue.push(n);
  r.running ??= runRound(root, th, r, context).finally(() => {
    th.round = null;
    releaseThread(th);
  });
  return { row, queued: names, done: r.running };
}

function newRound(): Round {
  return { queue: [], current: new Set(), since: null, running: null, soloQueue: [], summaryQueue: [], summing: null };
}

/** 最后一问（人说的最后一句）和它之后的回答（没回上来的、总结不算）。 */
export function lastAsk(rows: TalkRow[]): { ask: TalkRow; answers: TalkRow[]; summed: boolean } | null {
  const at = rows.map((r) => r.kind).lastIndexOf('human');
  if (at < 0) return null;
  const after = rows.slice(at + 1);
  return { ask: rows[at], answers: after.filter((r) => r.kind === 'ai' && !r.error && !r.summary), summed: after.some((r) => r.summary) };
}

/** 一份回答最多带多少字进总结（全文在记录文件里）。 */
const SUMMARY_ANSWER_CHARS = 12_000;

/**
 * 请一位做总结的提示（纯函数）。学 llm-council：回答去掉名字、按 A、B、C 标，免得偏向谁；
 * 学 council-of-high-intelligence：分歧和少数意见要留着，最后写一件马上能做的事。
 * 顺序也按「不变的在前」：规矩 → 问题 → 回答 → 任务状态、你是谁。
 */
export function buildSummaryPrompt(input: { speaker: string; root: string; ask: string; answers: string[]; context?: TalkContext }): string {
  const mark = (i: number) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : '');
  const clipA = (a: string) => (a.length > SUMMARY_ANSWER_CHARS ? `${a.slice(0, SUMMARY_ANSWER_CHARS)}\n…（后面还有，全文在这段群聊的记录里）` : a);
  const parts = [
    '你在「接力台」的一场多 AI 讨论里做总结。',
    `项目文件夹：${input.root}（可以读里面的文件核对，但不要修改任何文件，也不要执行会改变东西的命令）。`,
    [
      '怎么总结：',
      '- 下面几份回答去掉了名字，按 A、B、C 标。不要猜是谁写的，也不要因为谁的模型更强就偏向谁：按道理和证据判断，拿不准的打开项目里的文件核对。',
      '- 只写下面五节，每节简短，节名照写：',
      '结论：一句话。定不下来就写定不下来，以及还差什么才能定。',
      '一致的：几份回答都同意的，每条一行。',
      '分歧：每条写清各方的说法和理由（用 A、B 这样的标号）；有道理的少数意见要留着，不要为了一致抹掉。',
      '建议：怎么做、为什么。',
      '下一步：一件马上能做的事。',
      '- 用中文。只根据这些回答和项目里的文件，不要编。',
    ].join('\n'),
    `人问的是：\n${input.ask.trim()}`,
    input.answers.map((a, i) => `【${mark(i)}】\n${clipA(a.trim())}`).join('\n\n'),
    taskBackground(input.context),
    `你是「${input.speaker}」，现在写总结。`,
  ];
  return redactSecrets(parts.join('\n\n'));
}

async function summarizeOne(root: string, th: Thread, name: string, context: () => TalkContext): Promise<void> {
  const agent = findAgent(name);
  try {
    if (!agent) throw new RelayError('名单里没有它', 'no-agent');
    const last = lastAsk(readTalk(root, Infinity, th.file));
    if (!last || last.answers.length < 2) throw new RelayError('最后一问不到两份回答', 'no-round');
    const prompt = buildSummaryPrompt({ speaker: speakerName(agent), root, ask: last.ask.text, answers: last.answers.map((a) => a.text), context: safeContext(context) }) + skillNote(root, last.ask.text);
    const text = await askAgent(agent, prompt, root);
    const m = memberModel(agent, loadDetected());
    appendTalk(root, { kind: 'ai', who: speakerName(agent), agent: agent.name, ...(m ? { model: m } : {}), text, summary: true }, th.file);
  } catch (e) {
    appendTalk(root, { kind: 'system', who: '接力台', agent: name, text: `${agent ? speakerName(agent) : name} 没有总结出来：${plain(errorMessage(e))}`, error: true }, th.file);
  }
}

/**
 * 请一位把最后一问的几份回答并成一份总结（写进正在用的那段群聊，标 summary）。
 * 回答还在说的，等它们说完再总结；加上还在说的不到两份就不用总结。
 */
export function summarize(root: string, who: string, context: () => TalkContext = () => ({})): { queued: string; done: Promise<void> } {
  const [name] = checkSpeakers([who]);
  if (!name) throw new RelayError('没说请谁总结', 'no-agent');
  const th = threadOf(talkPath(root));
  const last = lastAsk(readTalk(root, Infinity, th.file));
  const r0 = th.round;
  const pending = r0 ? r0.queue.length + r0.current.size + r0.soloQueue.reduce((n, q) => n + q.names.length, 0) : 0;
  if (!last || last.answers.length + pending < 2) {
    releaseThread(th);
    throw new RelayError('最后一问还没有两份回答，用不着总结', 'no-round');
  }
  const r = (th.round ??= newRound());
  if (!r.summaryQueue.includes(name) && r.summing !== name) r.summaryQueue.push(name);
  r.running ??= runRound(root, th, r, context).finally(() => {
    th.round = null;
    releaseThread(th);
  });
  return { queued: name, done: r.running };
}

/** 采纳一条总结：把它的「结论」写进任务的约定（和投票采纳一样），群聊里记一句。 */
export function adoptSummary(root: string, ts: string, appendRuleFn: (line: string) => void): TalkRow {
  const file = talkPath(root);
  const rows = readTalk(root, Infinity, file);
  const s = rows.find((r) => r.ts === ts && r.summary);
  if (!s) throw new RelayError('没有这条总结', 'no-summary');
  if (rows.some((r) => r.adopt === ts)) throw new RelayError('这条总结已经采纳过了', 'adopted');
  const line = s.text.match(/^\s*[#*\-\s]*结论\s*[：:]\s*(.+)$/m)?.[1]?.replace(/\*+/g, '').trim();
  if (!line) throw new RelayError('这条总结没写「结论」', 'no-conclusion');
  appendRuleFn(line);
  return appendTalk(root, { kind: 'system', who: '接力台', text: `采纳了 ${s.who} 的总结，写进了任务的约定：${line}`, adopt: ts }, file);
}

/** 这个接力台进程里有没有哪段群聊在说话、在排队。 */
export function anyTalkBusy(): boolean {
  return [...threads.values()].some((t) => !!t.round);
}
