import fs from 'node:fs';
import path from 'node:path';
import { agentEnv } from './env';
import { killTree, spawnTool } from './proc';
import type { Invocation, StreamFormat } from './harness';
import { cause, looksOffline } from './cause';
import { claudeLimits, type Limit } from './quota';
import { stampLocal } from './time';

/**
 * 无人值守地跑一个 AI 工具：在项目文件夹里启动、把它吐出来的事件翻译成一行行中文日志、
 * 超时或被叫停时整组结束进程。日志落盘（接力台页面实时读），最后一句话交给调用方。
 */

// ---- 解析各家的输出 ----

export interface StreamParser {
  /** 喂一行原始输出，返回要写进日志的中文行（可能为空）。 */
  line(raw: string): string[];
  /** 最后一句话（工具的最终回答）。 */
  final(): string;
  /** 解析时看到的模型名。 */
  model(): string | undefined;
  /** 工具自己报的额度窗口（只有 Claude Code 在输出里报）。 */
  limits?(): Limit[];
}

type J = Record<string, unknown>;

function tryJson(raw: string): J | null {
  const t = raw.trim();
  if (!t.startsWith('{')) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : null;
  } catch {
    return null;
  }
}

function o(v: unknown): J {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {};
}

/**
 * 工具自己报的 token 用量（各家字段名不一样：usage、tokenUsage、usageMetadata……），统一成一行记进日志：
 * 输入把读缓存、写缓存的也算上。没报就没有这一行。
 */
export function usageLine(j: J): string | null {
  const u = [j.usage, o(j.result).usage, o(j.data).usage, j.tokenUsage, j.usageMetadata].map(o).find((x) => Object.keys(x).length);
  if (!u) return null;
  const n = (...keys: string[]) => keys.reduce((sum, k) => sum + (typeof u[k] === 'number' ? (u[k] as number) : 0), 0);
  const input = n('input_tokens', 'prompt_tokens', 'inputTokens', 'promptTokens', 'promptTokenCount', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cacheReadTokens', 'cacheWriteTokens');
  const output = n('output_tokens', 'completion_tokens', 'outputTokens', 'completionTokens', 'candidatesTokenCount');
  return input || output ? `本轮用了 ${input} 输入 / ${output} 输出 token` : null;
}

function s(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function clip(text: string, max = 240): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 工具调用参数里最能说明「在干什么」的那个。 */
export function toolSummary(input: unknown): string {
  const i = o(input);
  for (const k of ['file_path', 'path', 'filePath', 'target_file', 'command', 'cmd', 'CommandLine', 'pattern', 'query', 'url', 'description']) {
    const v = i[k];
    if (typeof v === 'string' && v.trim()) return clip(v, 160);
    if (Array.isArray(v) && v.length) return clip(v.map(String).join(' '), 160);
  }
  const keys = Object.keys(i);
  return keys.length ? clip(JSON.stringify(i), 160) : '';
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => s(o(c).text)).join(' ');
  return '';
}

/** 「deepseek-flash[1m]」：方括号里是上下文长度的档位，不是另一个模型。 */
function modelName(m: string): string {
  return m.trim().replace(/\[[^\]]*\]$/, '');
}

function claudeParser(): StreamParser {
  let final = '';
  let last = '';
  /** 开头 init 报的模型（可能是「claude-opus-5」这种简写）。 */
  let initModel: string | undefined;
  /** 回复里记的实际模型（更准）；<synthetic> 是工具自己拼的话（比如额度提示），不算。 */
  let replyModel: string | undefined;
  /** 额度窗口：rate_limit_event 在用量或恢复时间变了时发一条，同一个窗口留最新的。 */
  const limits = new Map<string, Limit>();
  return {
    line(raw) {
      const j = tryJson(raw);
      if (!j) return raw.trim() ? [clip(raw)] : [];
      const type = s(j.type);
      if (type === 'rate_limit_event') {
        for (const l of claudeLimits(j.rate_limit_info)) limits.set(l.kind, l);
        return [];
      }
      if (type === 'system') {
        if (j.subtype === 'init') {
          initModel = modelName(s(j.model)) || initModel;
          return [`模型：${initModel ?? '?'}`];
        }
        return [];
      }
      if (type === 'assistant') {
        const out: string[] = [];
        const m = modelName(s(o(j.message).model));
        if (m && !m.startsWith('<') && m !== replyModel) {
          if (!replyModel && m !== initModel) out.push(`模型：${m}`);
          replyModel = m;
        }
        // <synthetic> 是工具自己拼的话（额度用完、出错的提示），不是模型说的：记成「提示」。
        const synthetic = m.startsWith('<');
        for (const b of (o(j.message).content as unknown[]) ?? []) {
          const blk = o(b);
          if (blk.type === 'text' && s(blk.text).trim()) {
            last = s(blk.text);
            out.push(`${synthetic ? '提示' : '说'}：${clip(last)}`);
          } else if (blk.type === 'tool_use') {
            out.push(`工具 ${s(blk.name)}：${toolSummary(blk.input)}`);
          }
        }
        return out;
      }
      if (type === 'user') {
        const out: string[] = [];
        const content = o(j.message).content;
        if (Array.isArray(content)) {
          for (const b of content) {
            const blk = o(b);
            if (blk.type === 'tool_result' && blk.is_error) out.push(`工具出错：${clip(textOf(blk.content), 200)}`);
          }
        }
        return out;
      }
      if (type === 'result') {
        final = s(j.result) || last;
        const bits = [`结束（${s(j.subtype) || '完成'}`];
        if (typeof j.num_turns === 'number') bits.push(`${j.num_turns} 轮`);
        if (typeof j.duration_ms === 'number') bits.push(`${Math.round(j.duration_ms / 1000)} 秒`);
        if (j.is_error) bits.push('出错');
        return [`${bits.join('，')}）`, ...[usageLine(j)].filter((x): x is string => !!x)];
      }
      return [];
    },
    final: () => final || last,
    model: () => replyModel ?? initModel,
    limits: () => [...limits.values()],
  };
}

function codexParser(): StreamParser {
  let last = '';
  return {
    line(raw) {
      const j = tryJson(raw);
      if (!j) return raw.trim() ? [clip(raw)] : [];
      const type = s(j.type);
      const it = o(j.item);
      if (type === 'item.started' && it.type === 'command_execution') return [`命令：${clip(s(it.command), 200)}`];
      if (type === 'item.completed') {
        if (it.type === 'agent_message') {
          last = s(it.text);
          return last.trim() ? [`说：${clip(last)}`] : [];
        }
        if (it.type === 'command_execution' && typeof it.exit_code === 'number' && it.exit_code !== 0) return [`命令失败（退出码 ${it.exit_code}）：${clip(s(it.command), 160)}`];
        if (it.type === 'file_change') {
          const files = Array.isArray(it.changes) ? it.changes.map((c) => s(o(c).path)).filter(Boolean) : [];
          return [`改文件：${files.map((f) => path.basename(f)).join('、') || '（未知）'}`];
        }
        if (it.type === 'error') return NOISE.test(s(it.message)) ? [] : [`提示：${clip(s(it.message), 200)}`];
        return [];
      }
      if (type === 'turn.completed') return [usageLine(j) ?? '本轮用量没报'];
      if (type === 'turn.failed' || type === 'error') return [`出错：${clip(s(o(j.error).message) || s(j.message) || JSON.stringify(j), 300)}`];
      return [];
    },
    final: () => last,
    model: () => undefined,
  };
}

function cursorParser(): StreamParser {
  let last = '';
  let final = '';
  let model: string | undefined;
  return {
    line(raw) {
      const j = tryJson(raw);
      if (!j) return raw.trim() ? [clip(raw)] : [];
      const type = s(j.type);
      if (type === 'system' && j.subtype === 'init') {
        model = s(j.model) || model;
        return [`模型：${model ?? '?'}`];
      }
      if (type === 'assistant') {
        const t = textOf(o(j.message).content);
        if (t.trim()) {
          last = t;
          return [`说：${clip(t)}`];
        }
        return [];
      }
      if (type === 'tool_call') {
        const tc = o(j.tool_call);
        const key = Object.keys(tc)[0] ?? '工具';
        const name = key.replace(/ToolCall$/, '');
        const body = o(tc[key]);
        if (j.subtype === 'started') return [`工具 ${name}：${toolSummary(body.args)}`];
        const err = o(o(body.result).error);
        if (j.subtype === 'completed' && Object.keys(err).length) return [`工具出错：${name} ${clip(s(err.error) || JSON.stringify(err), 160)}`];
        return [];
      }
      if (type === 'result') {
        final = last || s(j.result);
        return [`结束（${s(j.subtype) || '完成'}${typeof j.duration_ms === 'number' ? `，${Math.round(j.duration_ms / 1000)} 秒` : ''}${j.is_error ? '，出错' : ''}）`, ...[usageLine(j)].filter((x): x is string => !!x)];
      }
      return [];
    },
    final: () => final || last,
    model: () => model,
  };
}

function agyParser(): StreamParser {
  let final = '';
  return {
    line(raw) {
      const j = tryJson(raw);
      if (!j) return raw.trim() ? [clip(raw)] : [];
      if (j.event === 'step_update') {
        const st = o(j.step_update);
        if (st.step_type === 'tool') {
          const info = o(st.tool_info);
          if (st.state === 'ACTIVE') return [`工具 ${s(st.tool_name)}：${toolSummary(info.parameters)}`];
          // 要人点头的操作在无界面模式下直接被拒，这一轮随即结束、没有回答：记下拒的是什么。
          if (st.state === 'ERROR' && /permission check failed/i.test(s(o(info.error).message))) return [`被拒绝：${toolSummary(info.parameters) || s(st.tool_name)}`];
          if (st.state === 'ERROR') return [`工具出错：${s(st.tool_name)} ${clip(JSON.stringify(info.error ?? ''), 200)}`];
        }
        return [];
      }
      if (j.event === 'result') {
        const r = o(j.result);
        final = s(r.response);
        const denied = Array.isArray(r.denied_actions) ? r.denied_actions.length : 0;
        return [`结束（${s(r.status) || '完成'}${denied ? `，${denied} 个操作被拒绝` : ''}）`, ...[usageLine(j)].filter((x): x is string => !!x)];
      }
      return [];
    },
    final: () => final,
    model: () => undefined,
  };
}

/**
 * DeepSeek Harness 无界面模式（dsh --profile headless --json）：一行一个事件，
 * session 开头、final 结尾，中间 status / text / thinking / tool_call / tool_result；出错时是 error 事件。
 * 字段名按说明书写得宽一点（text / answer / content 都认）。
 */
function dshParser(): StreamParser {
  let last = '';
  let final = '';
  let model: string | undefined;
  const firstStr = (j: J, keys: string[]) => {
    for (const k of keys) {
      const v = j[k];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return '';
  };
  return {
    line(raw) {
      const j = tryJson(raw);
      if (!j) return raw.trim() ? [clip(raw)] : [];
      const type = s(j.type);
      const m = firstStr(j, ['model']) || firstStr(o(j.data), ['model']);
      const out: string[] = [];
      if (m && m !== model) {
        model = m;
        out.push(`模型：${m}`);
      }
      if (type === 'session') return [...out, `会话：${firstStr(j, ['id', 'sessionId', 'session'])}`];
      if (type === 'text') {
        const t = firstStr(j, ['text', 'content', 'delta']);
        if (t.trim()) {
          last = t;
          out.push(`说：${clip(t)}`);
        }
        return out;
      }
      if (type === 'tool_call') return [...out, `工具 ${firstStr(j, ['name', 'tool', 'toolName']) || '工具'}：${toolSummary(j.args ?? j.input ?? j.arguments ?? j.params)}`];
      if (type === 'tool_result') {
        const err = j.isError === true || j.is_error === true || j.error !== undefined;
        return err ? [...out, `工具出错：${clip(firstStr(j, ['error', 'content', 'text', 'result']) || JSON.stringify(j.error ?? ''), 200)}`] : out;
      }
      if (type === 'final') {
        final = firstStr(j, ['text', 'answer', 'content', 'result', 'final']) || last;
        return [...out, `结束（${firstStr(j, ['reason']) || '完成'}）`, ...[usageLine(j)].filter((x): x is string => !!x)];
      }
      if (type === 'error') return [...out, `出错：${clip([firstStr(j, ['code']), firstStr(j, ['message', 'error'])].filter(Boolean).join(' '), 300)}`];
      if (type === 'status' || type === 'turn_end') {
        const t = firstStr(j, ['message', 'status', 'reason', 'state']);
        return t ? [...out, `状态：${clip(t, 160)}`] : out;
      }
      return out;
    },
    final: () => final || last,
    model: () => model,
  };
}

/** 不认识格式的工具：能解析成 JSON 就挑文字字段，否则原样记下。 */
function linesParser(): StreamParser {
  let last = '';
  const tail: string[] = [];
  return {
    line(raw) {
      const t = raw.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trimEnd();
      if (!t.trim()) return [];
      tail.push(t);
      if (tail.length > 400) tail.shift();
      const j = tryJson(t);
      if (j) {
        for (const k of ['result', 'response', 'text', 'content', 'message', 'output']) {
          const v = j[k];
          if (typeof v === 'string' && v.trim()) {
            last = v;
            return [`说：${clip(v)}`];
          }
        }
        return [clip(t)];
      }
      return [clip(t)];
    },
    final: () => last || tail.join('\n'),
    model: () => undefined,
  };
}

/** 群聊的自定义命令：标准输出整段就是回答（空行也留着，不猜 JSON：回答里举的 JSON 例子不能当成回答本身）。 */
function textParser(): StreamParser {
  const all: string[] = [];
  return {
    line(raw) {
      const t = raw.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trimEnd();
      all.push(t);
      if (all.length > 4000) all.shift();
      return t.trim() ? [clip(t)] : [];
    },
    final: () => all.join('\n'),
    model: () => undefined,
  };
}

/** 工具自己打的、和干活无关的提示（登录方式、模型列表刷新失败之类），不进日志。 */
export const NOISE = /connectors are disabled|unrecognized_model|codex_models_manager|responses_websocket|Skill descriptions were shortened|failed to refresh available models|Reading prompt from stdin/i;

export function makeParser(format: StreamFormat): StreamParser {
  switch (format) {
    case 'claude':
      return claudeParser();
    case 'codex':
      return codexParser();
    case 'text':
      return textParser();
    case 'cursor':
      return cursorParser();
    case 'agy':
      return agyParser();
    case 'dsh':
      return dshParser();
    default:
      return linesParser();
  }
}

// ---- 跑 ----

export interface RunRequest {
  invocation: Invocation;
  cwd: string;
  timeoutMs: number;
  logPath: string;
  title: string;
  /** 每写一行日志就通知一次（命令行实时显示用）。 */
  onLine?: (line: string) => void;
  /** 这么久一点输出都没有就停掉：还在干活的工具隔几十秒总会吐一行，卡住的才一直不出声。 */
  idleMs?: number;
}

/**
 * 连着这么久工具说的都是连不上服务器（Codex 断网时每分钟报一次「Reconnecting... waiting for network」，永远等下去）就停掉。
 * 网络抖一下不到这么久；RELAY_OFFLINE_MS 可以改（测试用）。
 */
function offlineMs(): number {
  const v = Number(process.env.RELAY_OFFLINE_MS);
  return Number.isFinite(v) && v > 0 ? v : 3 * 60_000;
}

/** 工具出错的样子像不像网络抖了一下（连接被断开、服务器临时忙）：像的话值得隔几秒原地再试一次。 */
export function looksLikeNetworkBlip(text: string): boolean {
  return looksOffline(text) || /\b50[234]\b|\b429\b|rate.?limit|overloaded|temporarily unavailable|service unavailable|bad gateway/i.test(text);
}

/** 一棒的日志里记的 token 用量加起来（每家工具每轮一行「本轮用了 X 输入 / Y 输出 token」）；一行都没有就是没报。 */
export function usageTotal(log: string): { input: number; output: number } | null {
  let input = 0;
  let output = 0;
  let seen = false;
  for (const m of log.matchAll(/本轮用了 (\d+) 输入 \/ (\d+) 输出 token/g)) {
    input += Number(m[1]);
    output += Number(m[2]);
    seen = true;
  }
  return seen ? { input, output } : null;
}

/** 工具自己最后报的错：日志里最后一条「出错：」；没有就是标准错误里最后一句像报错的话，再没有就是标准错误的最后一行。 */
export function lastError(stderrTail: string, log = ''): string {
  const own = toolLines(log)
    .split('\n')
    .map((l) => l.match(/出错：(.+)/)?.[1]?.trim())
    .filter(Boolean)
    .pop();
  if (own) return own;
  const lines = stderrTail.split('\n').map((l) => l.trim()).filter(Boolean);
  const errs = lines.filter((l) => /error|错误|失败|failed|refused|denied|timed out/i.test(l));
  return errs.filter((l) => !NOISE.test(l)).pop() ?? errs.pop() ?? lines.pop() ?? '';
}

/**
 * 日志里工具自己报的话：出错、提示、结束、退出、状态、工具自己打到标准错误的输出。
 * 不含 AI 说的话、它调用的工具和命令、改了哪些文件——认「额度用完」「网络抖了一下」只看这些：
 * 任务本身讲限流、额度时，AI 说的话、搜的词里全是 rate limit、quota，不能当成它自己没额度了。
 */
export function toolLines(log: string): string {
  return log
    .split('\n')
    .filter((l) => /^(?:\d\d:\d\d:\d\d )?(?:出错：|提示：|（工具自己的输出）|结束（|退出（|状态：|超过 \d+ 分钟)/.test(l))
    .join('\n');
}

/** 这一步日志的最后一段（不含开头的命令行，免得把任务原文当成出错原因）。 */
export function logTail(logPath: string, bytes = 4000): string {
  try {
    const fd = fs.openSync(logPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, bytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf
        .toString('utf8')
        .split('\n')
        .filter((l) => !l.startsWith('$ ') && !l.startsWith('# '))
        .join('\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

export interface RunResult {
  /** 退出码；被叫停 / 超时 / 起不来时为负数或信号码。 */
  code: number;
  finalText: string;
  timedOut: boolean;
  /** 接力台自己停掉它的原因（太久没动静、超时、一直连不上服务器；timedOut 也是 true）。 */
  late?: string;
  stopped: boolean;
  /** 起不来的原因。 */
  error?: string;
  stderrTail: string;
  model?: string;
  /** 工具自己报的额度窗口（没报就没有）。 */
  limits?: Limit[];
  durationMs: number;
}

export interface RunHandle {
  pid: number | undefined;
  stop(): void;
  done: Promise<RunResult>;
}

function hms(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 给人看的命令行：很长的参数（提示词）只写长度。 */
export function describeArgv(argv: string[]): string {
  return argv
    .map((a) => {
      if (a.length > 160) return `<提示词 ${a.length} 字>`;
      return /[\s"'$`\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a;
    })
    .join(' ');
}

export function startRun(req: RunRequest): RunHandle {
  const inv = req.invocation;
  fs.mkdirSync(path.dirname(req.logPath), { recursive: true });
  const prefix = req.cwd.endsWith(path.sep) ? req.cwd : `${req.cwd}${path.sep}`;
  const write = (line: string) => {
    const full = `${hms()} ${line.split(prefix).join('')}`;
    try {
      fs.appendFileSync(req.logPath, full + '\n');
    } catch {
      /* 日志写不了不影响干活 */
    }
    req.onLine?.(full);
  };
  fs.appendFileSync(req.logPath, `# ${req.title} · ${stampLocal(new Date())}\n$ ${describeArgv(inv.argv)}\n`);

  const parser = makeParser(inv.format);
  const started = Date.now();
  let timedOut = false;
  let stopped = false;
  let stderrTail = '';
  let stderrLines = 0;
  let killTimer: NodeJS.Timeout | null = null;

  const child = spawnTool(inv.argv, {
    cwd: req.cwd,
    env: agentEnv(inv.env ?? {}, inv.dropEnv),
    stdio: [inv.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });

  const terminate = () => {
    killTree(child.pid, 'SIGTERM');
    if (!killTimer) killTimer = setTimeout(() => killTree(child.pid, 'SIGKILL'), 5000);
  };
  let late: string | undefined;
  const giveUp = (why: string) => {
    if (timedOut) return;
    timedOut = true;
    late = why;
    write(why);
    terminate();
  };
  const quiet = req.idleMs ? setTimeout(() => giveUp(cause.idle(req.idleMs!)), req.idleMs) : null;
  // 从什么时候起工具说的只剩连不上服务器；说了别的就重新算
  const offMs = offlineMs();
  let offlineSince = 0;
  const saw = (line: string) => {
    if (!looksOffline(line)) offlineSince = 0;
    else if (!offlineSince) offlineSince = Date.now();
  };
  const offline = setInterval(() => offlineSince && Date.now() - offlineSince >= offMs && giveUp(cause.offline(offMs)), Math.min(5000, offMs / 4));

  if (inv.stdin !== undefined && child.stdin) {
    child.stdin.on('error', () => {
      /* 工具可能不读标准输入 */
    });
    child.stdin.end(inv.stdin);
  }

  // 按字符读（setEncoding）：一个汉字被切在两次读取之间也不会变成乱码。
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  let buf = '';
  child.stdout?.on('data', (c: string) => {
    quiet?.refresh();
    buf += c;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      for (const l of parser.line(line)) {
        saw(l);
        write(l);
      }
    }
    if (buf.length > 4_000_000) buf = buf.slice(-1_000_000);
  });
  let ebuf = '';
  child.stderr?.on('data', (t: string) => {
    quiet?.refresh();
    stderrTail = (stderrTail + t).slice(-6000);
    ebuf += t;
    let i: number;
    while ((i = ebuf.indexOf('\n')) >= 0) {
      const line = ebuf.slice(0, i).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trim();
      ebuf = ebuf.slice(i + 1);
      if (line && !NOISE.test(line)) saw(line);
      if (line && stderrLines < 60 && !NOISE.test(line)) {
        stderrLines++;
        write(`（工具自己的输出）${clip(line, 200)}`);
      }
    }
  });

  const timer = setTimeout(() => giveUp(cause.overtime(req.timeoutMs)), req.timeoutMs);

  const done = new Promise<RunResult>((resolve) => {
    let settled = false;
    const finish = (code: number, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(offline);
      if (quiet) clearTimeout(quiet);
      if (killTimer) clearTimeout(killTimer);
      if (buf.trim()) for (const l of parser.line(buf)) write(l);
      let finalText = parser.final();
      if (inv.outFile) {
        try {
          const t = fs.readFileSync(inv.outFile, 'utf8');
          if (t.trim()) finalText = t;
        } catch {
          /* 没写文件就用解析到的 */
        }
        fs.rmSync(inv.outFile, { force: true });
      }
      const durationMs = Date.now() - started;
      write(`退出（${error ? error : `代码 ${code}`}，用时 ${Math.round(durationMs / 1000)} 秒）`);
      const limits = parser.limits?.() ?? [];
      resolve({ code, finalText: finalText.trim(), timedOut, ...(late ? { late } : {}), stopped, ...(error ? { error } : {}), stderrTail: stderrTail.trim(), model: parser.model(), ...(limits.length ? { limits } : {}), durationMs });
    };
    child.on('error', (e) => finish(-1, `起不来：${e.message}`));
    child.on('close', (code, signal) => finish(code ?? (signal ? 128 : -1)));
  });

  return {
    pid: child.pid,
    stop() {
      if (stopped) return;
      stopped = true;
      write('收到停止请求，结束它。');
      terminate();
    },
    done,
  };
}
