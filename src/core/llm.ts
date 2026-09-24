import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envValue } from './env';
import { RelayError } from './errors';
import type { ApiSpec } from './types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ---- 密钥 ----

/** 去掉 JSONC 里的注释（字符串里的 // 不动）。 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function readJsonc(p: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(stripJsonComments(fs.readFileSync(p, 'utf8'))) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 小米 MiMo 桌面版（mimocode）的配置文件。 */
export function mimocodeConfigPath(): string {
  const dir = path.join(os.homedir(), '.config', 'mimocode');
  for (const f of ['mimocode.jsonc', 'mimocode.json', 'config.json']) {
    if (fs.existsSync(path.join(dir, f))) return path.join(dir, f);
  }
  return path.join(dir, 'mimocode.jsonc');
}

/**
 * 从别的工具的配置里读密钥。只有用户在接力台里点了「同意使用」的接口才会配 keyFrom。
 * 密钥只在调用时读进内存，不写进接力台的任何文件、日志。
 */
export function readKeyFrom(ref: string): string | null {
  const i = ref.indexOf(':');
  const src = i > 0 ? ref.slice(0, i) : ref;
  const id = i > 0 ? ref.slice(i + 1) : '';
  if (src === 'mimocode' && id) {
    const j = readJsonc(mimocodeConfigPath());
    const p = (j?.provider as Record<string, { options?: { apiKey?: unknown } }> | undefined)?.[id];
    const k = p?.options?.apiKey;
    return typeof k === 'string' && k.trim() ? k.trim() : null;
  }
  return null;
}

function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);
}

export function apiKeyOf(spec: ApiSpec): string {
  if (spec.keyFrom) return readKeyFrom(spec.keyFrom) ?? '';
  return spec.apiKeyEnv ? envValue(spec.apiKeyEnv) ?? '' : '';
}

/** 能不能调（有密钥，或者是本机服务）。 */
export function apiUsable(spec: ApiSpec): boolean {
  return !!apiKeyOf(spec) || isLocalUrl(spec.baseUrl);
}

export function keyWhere(spec: ApiSpec): string {
  if (spec.keyFrom) return `${spec.keyFrom.split(':')[0]} 配置里的密钥`;
  return spec.apiKeyEnv ? `环境变量 ${spec.apiKeyEnv}` : '（不需要密钥）';
}

// ---- 请求 ----

function base(spec: ApiSpec): string {
  return spec.baseUrl.replace(/\/+$/, '');
}

function endpoint(spec: ApiSpec, what: 'chat' | 'models'): string {
  const b = base(spec);
  if (spec.format === 'anthropic') {
    const v1 = /\/v1$/.test(b) ? b : `${b}/v1`;
    return what === 'chat' ? `${v1}/messages` : `${v1}/models`;
  }
  return what === 'chat' ? `${b}/chat/completions` : `${b}/models`;
}

function headers(spec: ApiSpec, key: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (spec.format === 'anthropic') {
    h['anthropic-version'] = '2023-06-01';
    if (key) {
      h['x-api-key'] = key;
      h.authorization = `Bearer ${key}`;
    }
  } else if (key) {
    h.authorization = `Bearer ${key}`;
  }
  return h;
}

/** 网络抖一下、服务器临时忙（429 / 5xx）：隔几秒再试，最多再试两次。密钥错、请求错、超时都不重试。 */
const RETRY_DELAYS_MS = [2000, 6000];

function retryable(e: unknown): boolean {
  if (!(e instanceof RelayError)) return false;
  if (e.code === 'llm-net') return !/（超时）/.test(e.message);
  return e.code === 'llm-busy';
}

async function request(spec: ApiSpec, what: 'chat' | 'models', body: unknown, timeoutMs: number): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce(spec, what, body, timeoutMs);
    } catch (e) {
      if (attempt >= RETRY_DELAYS_MS.length || !retryable(e)) throw e;
      await new Promise((r) => setTimeout(r, Number(process.env.RELAY_RETRY_MS ?? RETRY_DELAYS_MS[attempt])));
    }
  }
}

async function requestOnce(spec: ApiSpec, what: 'chat' | 'models', body: unknown, timeoutMs: number): Promise<unknown> {
  const key = apiKeyOf(spec);
  if (!key && !isLocalUrl(spec.baseUrl)) throw new RelayError(`没有密钥（${keyWhere(spec)}）。`, 'no-key');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(endpoint(spec, what), {
        method: body === undefined ? 'GET' : 'POST',
        headers: headers(spec, key),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: ctrl.signal,
      });
    } catch (e) {
      const why = ctrl.signal.aborted ? '超时' : e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
      throw new RelayError(`连不上 ${spec.baseUrl}（${why}）。`, 'llm-net');
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      const code = res.status === 401 || res.status === 403 ? 'llm-auth' : res.status === 429 || res.status >= 500 ? 'llm-busy' : 'llm-http';
      throw new RelayError(`${spec.baseUrl} 返回 HTTP ${res.status}：${text}`, code);
    }
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** 一问一答（审计、审查、讨论用）。 */
export async function chat(spec: ApiSpec, messages: ChatMessage[], opts: { timeoutMs?: number; temperature?: number } = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  let content = '';
  if (spec.format === 'anthropic') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const rest = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
    const data = o(await request(spec, 'chat', { model: spec.model, max_tokens: 8192, ...(system ? { system } : {}), messages: rest, temperature: opts.temperature ?? 0.3 }, timeoutMs));
    content = arr(data.content)
      .map((b) => (o(b).type === 'text' ? String(o(b).text ?? '') : ''))
      .join('');
  } else {
    const data = o(await request(spec, 'chat', { model: spec.model, messages, temperature: opts.temperature ?? 0.3 }, timeoutMs));
    content = String(o(o(arr(data.choices)[0]).message).content ?? '');
  }
  if (!content.trim()) throw new RelayError('模型没有返回内容。', 'llm-empty');
  return content;
}

/** 列出接口上能用的模型（不花钱）。 */
export async function listModels(spec: ApiSpec, timeoutMs = 8000): Promise<string[]> {
  const data = o(await request(spec, 'models', undefined, timeoutMs));
  const list = arr(data.data).length ? arr(data.data) : arr(data.models);
  return list.map((m) => String(o(m).id ?? o(m).name ?? '')).filter(Boolean);
}

// ---- 带工具的多轮对话（内置小代理用） ----

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema。 */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** 参数不是合法 JSON 时的原文。 */
  badArgs?: string;
}

export class ToolChat {
  private msgs: J[] = [];
  /**
   * 模型回的思考内容（reasoning_content）要不要原样传回去。DeepSeek 等思考模型在连续调用工具时要求传回，
   * 缺了会报 400；个别接口不收这个字段，那就去掉再试一次，之后都不带。
   */
  private sendReasoning = true;

  constructor(
    private readonly spec: ApiSpec,
    private readonly system: string,
    private readonly tools: ToolDef[]
  ) {}

  user(text: string): void {
    this.msgs.push(this.spec.format === 'anthropic' ? { role: 'user', content: [{ type: 'text', text }] } : { role: 'user', content: text });
  }

  async next(timeoutMs = 180_000): Promise<{ text: string; calls: ToolCall[] }> {
    if (this.spec.format === 'anthropic') {
      const data = o(
        await request(
          this.spec,
          'chat',
          {
            model: this.spec.model,
            max_tokens: 8192,
            system: this.system,
            messages: this.msgs,
            tools: this.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
          },
          timeoutMs
        )
      );
      const content = arr(data.content);
      this.msgs.push({ role: 'assistant', content });
      const text = content.map((b) => (o(b).type === 'text' ? String(o(b).text ?? '') : '')).join('');
      const calls = content
        .filter((b) => o(b).type === 'tool_use')
        .map((b) => ({ id: String(o(b).id), name: String(o(b).name), args: o(o(b).input) }));
      return { text, calls };
    }
    const body = (withReasoning: boolean) => ({
      model: this.spec.model,
      messages: [{ role: 'system', content: this.system }, ...(withReasoning ? this.msgs : this.msgs.map(({ reasoning_content: _r, ...m }) => m))],
      tools: this.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      temperature: 0.2,
    });
    let raw: unknown;
    try {
      raw = await request(this.spec, 'chat', body(this.sendReasoning), timeoutMs);
    } catch (e) {
      const carried = this.msgs.some((m) => 'reasoning_content' in m);
      if (!(this.sendReasoning && carried && e instanceof RelayError && e.code === 'llm-http' && /reasoning/i.test(e.message))) throw e;
      this.sendReasoning = false;
      raw = await request(this.spec, 'chat', body(false), timeoutMs);
    }
    const data = o(raw);
    const msg = o(o(arr(data.choices)[0]).message);
    const rawCalls = arr(msg.tool_calls);
    const text = typeof msg.content === 'string' ? msg.content : '';
    const reasoning = typeof msg.reasoning_content === 'string' && msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {};
    this.msgs.push({ role: 'assistant', content: msg.content ?? null, ...reasoning, ...(rawCalls.length ? { tool_calls: rawCalls } : {}) });
    const calls: ToolCall[] = rawCalls.map((c, i) => {
      const f = o(o(c).function);
      const raw = String(f.arguments ?? '{}');
      try {
        return { id: String(o(c).id ?? `call_${i}`), name: String(f.name ?? ''), args: o(JSON.parse(raw || '{}')) };
      } catch {
        return { id: String(o(c).id ?? `call_${i}`), name: String(f.name ?? ''), args: {}, badArgs: raw.slice(0, 500) };
      }
    });
    return { text, calls };
  }

  results(rs: { id: string; content: string }[]): void {
    if (!rs.length) return;
    if (this.spec.format === 'anthropic') {
      this.msgs.push({ role: 'user', content: rs.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })) });
    } else {
      for (const r of rs) this.msgs.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    }
  }

  size(): number {
    return JSON.stringify(this.msgs).length;
  }

  /** 对话太长时丢掉最早的几轮（整轮丢：一条助手消息连同它的工具结果），第一条任务说明一直保留。 */
  prune(maxChars: number): number {
    let dropped = 0;
    while (this.size() > maxChars && this.msgs.length > 3) {
      let end = 2;
      while (end < this.msgs.length && this.msgs[end].role !== 'assistant') end++;
      if (end >= this.msgs.length) break;
      this.msgs.splice(1, end - 1);
      dropped++;
    }
    return dropped;
  }
}
