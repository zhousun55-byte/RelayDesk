import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { agentEnv } from './env';
import type { Invocation, StreamFormat } from './harness';

/**
 * 无人值守地跑一个 AI 工具：在隔离副本里启动、把它吐出来的事件翻译成一行行中文日志、
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

function claudeParser(): StreamParser {
  let final = '';
  let last = '';
  let model: string | undefined;
  return {
    line(raw) {
      const j = tryJson(raw);
      if (!j) return raw.trim() ? [clip(raw)] : [];
      const type = s(j.type);
      if (type === 'system') {
        if (j.subtype === 'init') {
          model = s(j.model) || model;
          return [`模型：${model ?? '?'}`];
        }
        return [];
      }
      if (type === 'assistant') {
        const out: string[] = [];
        for (const b of (o(j.message).content as unknown[]) ?? []) {
          const blk = o(b);
          if (blk.type === 'text' && s(blk.text).trim()) {
            last = s(blk.text);
            out.push(`说：${clip(last)}`);
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
    model: () => model,
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
}

export interface RunResult {
  /** 退出码；被叫停 / 超时 / 起不来时为负数或信号码。 */
  code: number;
  finalText: string;
  timedOut: boolean;
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
  fs.appendFileSync(req.logPath, `# ${req.title} · ${new Date().toISOString()}\n$ ${describeArgv(inv.argv)}\n`);

  const parser = makeParser(inv.format);
  const started = Date.now();
  let timedOut = false;
  let stopped = false;
  let stderrTail = '';
  let stderrLines = 0;
  let killTimer: NodeJS.Timeout | null = null;

  const child = spawn(inv.argv[0], inv.argv.slice(1), {
    cwd: req.cwd,
    env: agentEnv(),
    detached: true,
    stdio: [inv.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });

  const terminate = () => {
    killGroup(child.pid, 'SIGTERM');
    if (!killTimer) killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 5000);
  };

  if (inv.stdin !== undefined && child.stdin) {
    child.stdin.on('error', () => {
      /* 工具可能不读标准输入 */
    });
    child.stdin.end(inv.stdin);
  }

  let buf = '';
  child.stdout?.on('data', (c: Buffer) => {
    buf += c.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      for (const l of parser.line(line)) write(l);
    }
    if (buf.length > 4_000_000) buf = buf.slice(-1_000_000);
  });
  let ebuf = '';
  child.stderr?.on('data', (c: Buffer) => {
    const t = c.toString('utf8');
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
    write(`超过 ${Math.round(req.timeoutMs / 60000)} 分钟还没结束，停掉它。`);
    terminate();
  }, req.timeoutMs);

  const done = new Promise<RunResult>((resolve) => {
    let settled = false;
    const finish = (code: number, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      resolve({ code, finalText: finalText.trim(), timedOut, stopped, ...(error ? { error } : {}), stderrTail: stderrTail.trim(), model: parser.model(), durationMs });
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
