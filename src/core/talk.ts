import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayError, errorMessage } from './errors';
import { loadDetected, memberModel, refreshHarnessModel } from './detect';
import { agentEnv } from './env';
import { cliTooOld, explainFailure, findHarness, locateCached, modelArg, noteModelNeeds } from './harness';
import { fillTemplate } from './launch';
import { runLlmAgent } from './llm-agent';
import { llmName, toolName } from './names';
import { redactSecrets } from './redact';
import { clip, logTail, span, startRun, type RunResult } from './runner';
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
    });
  }
  return out.slice(-limit);
}

/** 往群聊记录里追加任意一行（投票也存在这里）。 */
export function appendTalkRaw(root: string, row: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(talkPath(root)), { recursive: true });
  fs.appendFileSync(talkPath(root), JSON.stringify(row) + '\n');
}

export function appendTalk(root: string, row: Omit<TalkRow, 'ts'> & { ts?: string }): TalkRow {
  const full: TalkRow = { ts: row.ts ?? new Date().toISOString(), ...row } as TalkRow;
  fs.mkdirSync(path.dirname(talkPath(root)), { recursive: true });
  fs.appendFileSync(talkPath(root), JSON.stringify(full) + '\n');
  return full;
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
  fs.renameSync(p, talkFile(root, id));
  return id;
}

/** 接着一个存档的群聊：正在用的先存档，再把它换回来。 */
export function resumeTalk(root: string, id: string): void {
  const from = talkFile(root, id);
  if (!fs.existsSync(from)) throw new RelayError('没有这个群聊。', 'no-talk');
  archiveTalk(root);
  fs.renameSync(from, talkPath(root));
  sessionCache.delete(from);
}

export interface TalkSession {
  id: string;
  /** 第一句问话（没有就是第一个投票的问题）。 */
  title: string;
  /** 最后一条的时间。 */
  at: string;
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
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

export interface TalkContext {
  task?: { title: string; phaseText: string; changes: string[] } | null;
}

function hhmm(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 拼给某个 AI 的发言提示：规则 + 项目背景 + 最近的讨论记录。纯函数。solo = 对比（这一轮别人的回答不给它看）。 */
export function buildTalkPrompt(input: { speaker: string; root: string; rows: TalkRow[]; context?: TalkContext; maxChars?: number; solo?: boolean }): string {
  const max = input.maxChars ?? 24_000;
  const lines = input.rows
    .filter((r) => !r.error)
    .map((r) => `[${hhmm(r.ts)}] ${r.kind === 'system' ? '（接力台）' : r.who}：${r.text.trim()}`);
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    size += lines[i].length + 2;
    if (size > max && kept.length > 0) break;
    kept.unshift(lines[i]);
  }
  const t = input.context?.task;
  const parts = [
    `你在参加「接力台」里的一场多 AI 讨论。你是「${input.speaker}」。`,
    `项目文件夹：${input.root}（可以读里面的文件做参考，但不要修改任何文件，也不要执行会改变东西的命令）。`,
    t
      ? `当前任务：${t.title}\n任务状态：${t.phaseText}${t.changes.length ? `\n已改动的文件：${t.changes.slice(0, 30).join('、')}` : ''}`
      : '现在没有进行中的任务。',
    [
      '怎么发言：',
      '- 直接给出你的判断和理由，不客套，不复述别人已经说过的话。',
      '- 可以点名回应别人的观点：同意还是不同意，为什么。你有不同的想法就直说，不要因为对方是更强的模型就附和。',
      '- 一般控制在 300 字以内；被要求详细时再展开。',
      '- 消息里用反引号括起来的路径是提到的文件；.relay/uploads/ 下的是人传上来的附件（图片、文档……），需要就自己打开看，图片用你能看图的工具打开。',
      '- 用中文。只输出你要说的话本身。',
    ].join('\n'),
    `讨论记录（${kept.length < lines.length ? '较早的已省略，' : ''}最新的在最后）：\n${kept.join('\n\n') || '（还没有人说话）'}`,
    input.solo
      ? `这一轮是「对比」：几个 AI 同时回答最后那个问题，互相看不到，回答会并排放在一起给人对比。请给出你自己独立的判断，不用顾及别人会怎么说。现在请你（${input.speaker}）回答。`
      : `现在轮到你（${input.speaker}）发言。`,
  ];
  return redactSecrets(parts.join('\n\n'));
}

function cleanReply(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '')
    .trim()
    .slice(0, 8000);
}

/** 群聊里一个 AI 最多说多久；中途这么久一点动静都没有就当它卡住了（Codex 干活时最长 49 秒不出声）。 */
export const TALK_MAX_MS = 15 * 60_000;
export const TALK_IDLE_MS = 3 * 60_000;

/** 回的是「调用工具」的原文（没给它工具、或者接口没接住）：不是回答。 */
const RAW_TOOL_CALL = /^<(?:tool_call|function_calls?)>/;

/** 工具一句话没说就结束了：从日志里找原因——被拒绝的操作、认得的报错、它自己最后报的错。 */
function silentWhy(harness: string | undefined, log: string, r: RunResult): string {
  const denied = log.match(/被拒绝：(.+)/)?.[1];
  if (denied) return `「${denied}」没被放行，它就停了。`;
  const hint = explainFailure(harness, `${r.stderrTail}\n${log}`);
  if (hint) return hint;
  const said = r.stderrTail.split('\n').find((l) => /error|错误|失败|failed/i.test(l));
  return `什么都没说（退出码 ${r.code}）${said ? `：${clip(said.trim(), 200)}` : '。'}`;
}

function replyOf(raw: string): string {
  const text = cleanReply(raw);
  if (RAW_TOOL_CALL.test(text)) throw new RelayError('回的是一段调用工具的原文，不是回答。', 'ask-empty');
  return text;
}

/**
 * 让一个 AI 回答。接口型用内置小代理，只给读文件的工具；编程工具用它的只读模式；
 * 自定义命令把提示从标准输入喂进去，读标准输出（或 {{out}} 文件）。
 */
export async function askAgent(agent: AgentConfig, prompt: string, cwd: string, timeoutMs = TALK_MAX_MS, idleMs = TALK_IDLE_MS): Promise<string> {
  const late = (idle: boolean | undefined) => (idle ? `${span(idleMs)}没有动静，停掉了。` : `${span(timeoutMs)}还没说完，停掉了。`);
  if (agentKind(agent) === 'api') {
    if (!agent.api) throw new RelayError('这个工人没有配置接口。', 'no-api');
    // 和编程工具一样能看项目里的文件：不给工具的话，它会把「调用工具」的原文当成回答说出来。
    const r = await runLlmAgent({
      spec: agent.api,
      cwd,
      brief: prompt,
      level: 'safe',
      readOnly: true,
      gateCommand: '',
      protectedPaths: [],
      log: () => {},
      shouldStop: () => false,
      deadline: Date.now() + timeoutMs,
      maxSteps: 30,
    });
    const text = replyOf(r.finalText);
    if (!text) throw new RelayError(r.error ?? (r.timedOut ? late(false) : '什么都没说。'), 'ask-empty');
    return text;
  }
  const tpl = agent.ask?.trim();
  if (!tpl) {
    // 绑定了认得的编程工具：用它的只读模式回答。
    const spec = findHarness(agent.harness);
    const loc = spec ? locateCached(spec) : null;
    if (!spec || !loc) throw new RelayError(`「${speakerName(agent)}」没有配置讨论命令。`, 'no-ask');
    const stamp = `${process.pid}-${Date.now()}`;
    const make = () =>
      spec.invoke(loc, {
        cwd,
        prompt,
        level: 'safe',
        readOnly: true,
        model: agent.model?.trim() || undefined,
        effort: agent.effort,
        outFile: path.join(os.tmpdir(), `relay-talk-${stamp}.txt`),
      });
    const logPath = path.join(os.tmpdir(), `relay-talk-${stamp}.log`);
    const inv = make();
    let r = await startRun({ invocation: inv, cwd, timeoutMs, idleMs, logPath, title: '讨论' }).done;
    // 命令行太旧、用不了这个模型：记下来，换成它用得了的再问一次。
    const needs = r.code !== 0 ? cliTooOld(`${r.finalText}\n${r.error ?? ''}\n${r.stderrTail}`) : null;
    const used = modelArg(inv.argv);
    if (needs && used) {
      noteModelNeeds(used, needs);
      refreshHarnessModel(spec.id);
      const again = make();
      if (modelArg(again.argv) !== used) r = await startRun({ invocation: again, cwd, timeoutMs, idleMs, logPath, title: '讨论' }).done;
    }
    const log = logTail(logPath, 6000);
    fs.rmSync(logPath, { force: true });
    const text = replyOf(r.finalText);
    if (!text) throw new RelayError(r.error ?? (r.timedOut ? late(r.idle) : silentWhy(spec.id, log, r)), 'ask-empty');
    return text;
  }
  const outFile = tpl.includes(OUT_PLACEHOLDER) ? path.join(os.tmpdir(), `relay-talk-${process.pid}-${Date.now()}.txt`) : null;
  const cmd = fillTemplate(tpl, outFile ? { out: outFile } : {});
  return new Promise((resolve, reject) => {
    // 和编程工具一样用 agentEnv：接力台是从某个 AI 工具里启动的时候，它注入的会话变量（CLAUDE_*、ANTHROPIC_*）不传过去。
    const child = spawn('sh', ['-c', cmd], { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: agentEnv({ NO_COLOR: '1' }) });
    let out = '';
    let err = '';
    let timedOut = false;
    let idle = false;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* 已结束 */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const quiet = setTimeout(() => {
      timedOut = idle = true;
      kill();
    }, idleMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      quiet.refresh();
      out += c;
      if (out.length > 200_000) out = out.slice(-200_000);
    });
    child.stderr?.on('data', (c: string) => {
      quiet.refresh();
      err = (err + c).slice(-4000);
    });
    child.stdin?.on('error', () => {
      /* 有的命令不读标准输入 */
    });
    child.stdin?.end(prompt);
    child.on('error', (e) => {
      clearTimeout(timer);
      clearTimeout(quiet);
      reject(new RelayError(`启动不了：${e.message}`, 'ask-spawn'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(quiet);
      let reply = out;
      if (outFile) {
        try {
          reply = fs.readFileSync(outFile, 'utf8');
        } catch {
          /* 没写文件就用标准输出 */
        }
        fs.rmSync(outFile, { force: true });
      }
      if (timedOut) return reject(new RelayError(late(idle), 'ask-timeout'));
      let text: string;
      try {
        text = replyOf(reply);
      } catch (e) {
        return reject(e);
      }
      if (code !== 0 && !text) return reject(new RelayError(`命令出错（退出码 ${code}）：${cleanReply(err).slice(-600) || '没有输出'}`, 'ask-failed'));
      if (!text) return reject(new RelayError(`什么都没说。${cleanReply(err).slice(-300)}`, 'ask-empty'));
      resolve(text);
    });
  });
}

// ---- 一轮发言（按项目排队，同一个项目同一时间只有一轮在跑） ----

interface Round {
  queue: string[];
  /** 正在说的（对比时好几个同时说）。 */
  current: Set<string>;
  since: string | null;
  running: Promise<void> | null;
  /** 排队的「对比」轮：同一轮的人一起问。 */
  soloQueue: { id: string; names: string[] }[];
}

const rounds = new Map<string, Round>();

function roundOf(root: string): Round {
  const key = path.resolve(root);
  let r = rounds.get(key);
  if (!r) {
    r = { queue: [], current: new Set(), since: null, running: null, soloQueue: [] };
    rounds.set(key, r);
  }
  return r;
}

export function talkStatus(root: string): { current: { agent: string; label: string; since: string } | null; speaking: { agent: string; label: string }[]; queue: { agent: string; label: string }[] } {
  const r = rounds.get(path.resolve(root));
  const lab = (n: string) => {
    const a = findAgent(n);
    return a ? speakerName(a) : n;
  };
  const speaking = [...(r?.current ?? [])].map((n) => ({ agent: n, label: lab(n) }));
  const first = speaking[0];
  return {
    current: first ? { ...first, since: r?.since ?? '' } : null,
    speaking,
    queue: [...(r?.queue ?? []), ...(r?.soloQueue ?? []).flatMap((q) => q.names)].map((n) => ({ agent: n, label: lab(n) })),
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

async function speakOne(root: string, name: string, rows: TalkRow[], context: () => TalkContext, solo?: string): Promise<void> {
  const agent = findAgent(name);
  try {
    if (!agent) throw new RelayError('工人名单里已经没有它了。', 'no-agent');
    const who = speakerName(agent);
    const prompt = buildTalkPrompt({ speaker: who, root, rows, context: safeContext(context), ...(solo ? { solo: true } : {}) });
    const text = await askAgent(agent, prompt, root);
    // 问的过程中可能换了模型（比如命令行太旧、换成了它用得了的）：署名按答完之后的算。
    const m = memberModel(agent, loadDetected());
    appendTalk(root, { kind: 'ai', who: speakerName(agent), agent: agent.name, ...(m ? { model: m } : {}), text, ...(solo ? { round: solo } : {}) });
  } catch (e) {
    appendTalk(root, { kind: 'system', who: '接力台', agent: name, text: `${agent ? speakerName(agent) : name} 没回上来：${errorMessage(e)}`, error: true, ...(solo ? { round: solo } : {}) });
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

async function runRound(root: string, context: () => TalkContext): Promise<void> {
  const r = roundOf(root);
  for (;;) {
    const solo = r.soloQueue.shift();
    if (solo) {
      // 对比：大家看到的记录都停在这一刻，互相看不到这一轮别人的回答。
      const rows = readTalk(root, 80);
      r.since = new Date().toISOString();
      for (const n of solo.names) r.current.add(n);
      await inParallel(solo.names, 4, async (n) => {
        await speakOne(root, n, rows, context, solo.id);
        r.current.delete(n);
      });
      continue;
    }
    const name = r.queue.shift();
    if (!name) break;
    r.current.add(name);
    r.since = new Date().toISOString();
    await speakOne(root, name, readTalk(root, 80), context);
    r.current.delete(name);
  }
  r.current.clear();
  r.since = null;
}

export function checkSpeakers(ask: string[]): string[] {
  const names: string[] = [];
  for (const n of ask) {
    const a = findAgent(n);
    if (!a) throw new RelayError(`工人名单里没有「${n}」。`, 'no-agent');
    if (!canTalk(a)) throw new RelayError(`「${speakerName(a)}」还不能参加群聊。`, 'cannot-talk');
    if (!names.includes(n)) names.push(n);
  }
  return names;
}

/**
 * 人说一句，并请几位 AI 回应。立即返回；回答在后台陆续写进记录。
 * turn：一个接一个，后面的看得到前面的；solo：同时问，互相看不到（对比）。
 * 已经有一轮在跑时，新请的人排到后面（他们发言时会看到这句话）。
 */
export function say(root: string, text: string, ask: string[], context: () => TalkContext = () => ({}), mode: TalkMode = 'turn'): { row: TalkRow; queued: string[]; done: Promise<void> } {
  const t = text.trim();
  if (!t) throw new RelayError('先写一句话。', 'empty');
  const names = checkSpeakers(ask);
  const row = appendTalk(root, { kind: 'human', who: '我', text: t, mode });
  const r = roundOf(root);
  if (mode === 'solo' && names.length) {
    r.soloQueue.push({ id: `solo-${Date.now().toString(36)}`, names });
  } else {
    for (const n of names) if (!r.queue.includes(n) && !r.current.has(n)) r.queue.push(n);
  }
  if (!r.running && (r.queue.length || r.soloQueue.length)) {
    r.running = runRound(root, context).finally(() => {
      r.running = null;
    });
  }
  return { row, queued: names, done: r.running ?? Promise.resolve() };
}

/** 群聊现在有没有人在说话（清空记录、投票前要等）。 */
/** 这个接力台进程里有没有哪个项目的群聊在说话、在排队。 */
export function anyTalkBusy(): boolean {
  return [...rounds.values()].some((r) => !!r.running || r.current.size > 0 || r.queue.length > 0 || r.soloQueue.length > 0);
}

export function talkBusy(root: string): boolean {
  const r = rounds.get(path.resolve(root));
  return !!r && (!!r.running || r.current.size > 0);
}
