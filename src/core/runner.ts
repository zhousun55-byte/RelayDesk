import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { agentEnv } from './env';
import type { Invocation, StreamFormat } from './harness';
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
  return {
    line(raw) {
      const j = tryJson(raw);
      if (!j) return raw.trim() ? [clip(raw)] : [];
      const type = s(j.type);
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
        return [`${bits.join('，')}）`];
      }
      return [];
    },
    final: () => final || last,
    model: () => replyModel ?? initModel,
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
      if (type === 'turn.completed') {
        const u = o(j.usage);
        return [`本轮用了 ${u.input_tokens ?? '?'} 输入 / ${u.output_tokens ?? '?'} 输出 token`];
      }
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
        return [`结束（${s(j.subtype) || '完成'}${typeof j.duration_ms === 'number' ? `，${Math.round(j.duration_ms / 1000)} 秒` : ''}${j.is_error ? '，出错' : ''}）`];
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
        return [`结束（${s(r.status) || '完成'}${denied ? `，${denied} 个操作被拒绝` : ''}）`];
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
        return [...out, `结束（${firstStr(j, ['reason']) || '完成'}）`];
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

/** 工具自己打的、和干活无关的提示（登录方式、模型列表刷新失败之类），不进日志。 */
export const NOISE = /connectors are disabled|unrecognized_model|codex_models_manager|responses_websocket|Skill descriptions were shortened|failed to refresh available models|Reading prompt from stdin/i;

export function makeParser(format: StreamFormat): StreamParser {
  switch (format) {
    case 'claude':
      return claudeParser();
    case 'codex':
      return codexParser();
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

/** 工具出错的样子像不像网络抖了一下（连接被断开、服务器临时忙）：像的话值得隔几秒原地再试一次。 */
export function looksLikeNetworkBlip(text: string): boolean {
  return /socket disconnected|socket hang up|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|fetch failed|TLS connection|network error|stream disconnected|connection (?:reset|closed|error)|\b50[234]\b|\b429\b|rate.?limit|overloaded|temporarily unavailable|service unavailable|bad gateway/i.test(
    text
  );
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
  /** 是因为太久没有动静才停的（timedOut 也是 true）。 */
  idle?: boolean;
  stopped: boolean;
  /** 起不来的原因。 */
  error?: string;
  stderrTail: string;
  model?: string;
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

function killGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* 已经结束 */
    }
  }
}

/** 「3 分钟」「40 秒」。 */
export function span(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

export function startRun(req: RunRequest): RunHandle {
  const inv = req.invocation;
  fs.mkdirSync(path.dirname(req.logPath), { recursive: true });
  const prefix = req.cwd.endsWith('/') ? req.cwd : `${req.cwd}/`;
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

  const child = spawn(inv.argv[0], inv.argv.slice(1), {
    cwd: req.cwd,
    env: agentEnv(inv.env ?? {}, inv.dropEnv),
    detached: true,
    stdio: [inv.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });

  const terminate = () => {
    killGroup(child.pid, 'SIGTERM');
    if (!killTimer) killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 5000);
  };
  let idle = false;
  const quiet = req.idleMs
    ? setTimeout(() => {
        timedOut = idle = true;
        write(`${span(req.idleMs!)}没有动静，停掉它。`);
        terminate();
      }, req.idleMs)
    : null;

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
      for (const l of parser.line(line)) write(l);
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
      if (line && stderrLines < 60 && !NOISE.test(line)) {
        stderrLines++;
        write(`（工具自己的输出）${clip(line, 200)}`);
      }
    }
  });

  const timer = setTimeout(() => {
    timedOut = true;
    write(`超过 ${span(req.timeoutMs)}还没结束，停掉它。`);
    terminate();
  }, req.timeoutMs);

  const done = new Promise<RunResult>((resolve) => {
    let settled = false;
    const finish = (code: number, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      resolve({ code, finalText: finalText.trim(), timedOut, ...(idle ? { idle } : {}), stopped, ...(error ? { error } : {}), stderrTail: stderrTail.trim(), model: parser.model(), durationMs });
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
