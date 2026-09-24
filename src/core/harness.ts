import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentEnv, envValue, scanApps, which } from './env';

/**
 * 认得的 AI 编程工具（harness）：怎么找到它、怎么看登录、默认用什么模型、怎么无人值守地调用。
 * 全自动流水线只通过这里调用工具；新增一个工具 = 在 HARNESSES 里加一项。
 */

/** safe：改文件只限隔离副本，命令在工具自己的沙箱里跑；full：完全放开（工具不再拦任何操作）。 */
export type Level = 'safe' | 'full';

/** 工具标准输出的格式（决定怎么解析进度和最后一句话）。 */
export type StreamFormat = 'claude' | 'codex' | 'cursor' | 'agy' | 'lines';

export interface Located {
  /** 调用前缀：可执行文件（+ 固定参数），如 ['/…/codex'] 或 ['/…/node', '/…/index.js']。 */
  exec: string[];
  version: string;
  /** 给人看的位置。 */
  where: string;
  /** 找的过程中发现的问题（比如快捷命令装坏了、已绕过）。 */
  note?: string;
}

export interface LoginInfo {
  state: 'ok' | 'no' | 'unknown';
  detail: string;
}

export interface ModelInfo {
  /** 工具默认用的模型 id。 */
  model?: string;
  /** 给人看的模型名。 */
  label?: string;
  /** 默认思考强度。 */
  effort?: string;
  /** 支持的思考强度（从低到高）。 */
  efforts?: string[];
  /** 模型从哪来（如 经 api.deepseek.com）。 */
  via?: string;
}

export interface InvokeInput {
  cwd: string;
  prompt: string;
  level: Level;
  /** true：只读（审查 / 讨论），不许改文件。 */
  readOnly: boolean;
  model?: string;
  effort?: string;
  /** 支持的工具会把最后一句话写进这个文件。 */
  outFile: string;
}

export interface Invocation {
  argv: string[];
  stdin?: string;
  format: StreamFormat;
  outFile?: string;
  /** 额外的环境变量（比如告诉 ZCode 命令行内核它的配置在哪）。 */
  env?: Record<string, string>;
}

export interface HarnessSpec {
  id: string;
  label: string;
  vendor: string;
  /** 默认排序：数字小的优先当主力。 */
  rank: number;
  /** 哪些档位下能无人值守地干活（有的工具在安全档一碰命令就整段停下）。 */
  workLevels: Level[];
  canReview: boolean;
  /** 实测程度：yes = 实测过改文件和跑命令；partial = 实测过一部分；no = 按官方参数写的，没实测。 */
  tested: 'yes' | 'partial' | 'no';
  loginHint: string;
  locate(): Located | null;
  login(loc: Located): LoginInfo;
  model(loc: Located): ModelInfo;
  invoke(loc: Located, input: InvokeInput): Invocation;
}

// ---- 小工具 ----

function home(): string {
  return os.homedir();
}

function run(argv: string[], timeoutMs = 15_000): { code: number; out: string; err: string } {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: timeoutMs, env: agentEnv(), cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

export function firstVersion(text: string): string {
  const m = text.match(/\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z]+)*/);
  return m ? m[0] : text.split('\n')[0].slice(0, 40);
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function strOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function locateBin(name: string, versionArgs = ['--version']): Located | null {
  const bin = which(name);
  if (!bin) return null;
  const v = run([bin, ...versionArgs]);
  if (v.code !== 0 && !v.out) return null;
  return { exec: [bin], version: firstVersion(v.out || v.err), where: bin };
}

/** TOML 顶层（第一个 [段] 之前）的 key = "value"。只读简单字符串。 */
export function tomlTop(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) break;
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// ---- 各家的配置（只读模型相关的字段，密钥一律不碰） ----

/** Claude Code 的 ~/.claude/settings.json：用的模型、走哪个接口、有没有配密钥（只看有没有）。 */
export function claudeSettings(): { model?: string; baseHost?: string; hasToken: boolean } {
  const j = readJson(path.join(home(), '.claude', 'settings.json')) ?? {};
  const env = obj(j.env);
  return {
    model: strOf(env.ANTHROPIC_MODEL) ?? strOf(j.model),
    baseHost: hostOf(strOf(env.ANTHROPIC_BASE_URL)),
    hasToken: !!(strOf(env.ANTHROPIC_AUTH_TOKEN) || strOf(env.ANTHROPIC_API_KEY)),
  };
}

/** Codex 的 ~/.codex/config.toml 顶层：模型、思考强度、接口；models_cache.json 里这个模型支持的思考强度。 */
export function codexSettings(): { model?: string; effort?: string; provider?: string; efforts: string[] } {
  let top: Record<string, string> = {};
  try {
    top = tomlTop(fs.readFileSync(path.join(home(), '.codex', 'config.toml'), 'utf8'));
  } catch {
    /* 没配置 */
  }
  const model = top.model;
  let efforts: string[] = [];
  const cache = readJson(path.join(home(), '.codex', 'models_cache.json'));
  const list = Array.isArray(cache?.models) ? (cache?.models as unknown[]) : [];
  for (const m of list) {
    const o = obj(m);
    if (model && (o.slug === model || o.id === model)) {
      const lv = Array.isArray(o.supported_reasoning_levels) ? o.supported_reasoning_levels : [];
      efforts = lv.map((x) => strOf(obj(x).effort)).filter((x): x is string => !!x);
    }
  }
  return { model, effort: top.model_reasoning_effort, provider: top.model_provider, efforts };
}

/**
 * Cursor Agent 的 ~/.cursor/cli-config.json：当前选的模型。
 * 命令行 --model 要的名字是显示名转出来的（「Cursor Grok 4.6 High Fast」→ cursor-grok-4.6-high-fast），
 * 配置里的 modelId（grok-4.6）命令行不认。
 */
export function cursorSettings(): { model?: string; label?: string } {
  const j = readJson(path.join(home(), '.cursor', 'cli-config.json')) ?? {};
  const m = obj(j.model);
  const sel = obj(j.selectedModel);
  const display = strOf(m.displayName);
  const id = display ? display.toLowerCase().replace(/\s+/g, '-') : strOf(sel.modelId) ?? strOf(m.modelId);
  return { model: id, label: display?.replace(/^Cursor\s+/, '') ?? id };
}

/** ZCode 的 ~/.zcode/v2/config.json：启用的接口里的模型（不带 Flash 的优先）。 */
export function zcodeSettings(): { model?: string; via?: string } {
  const j = readJson(path.join(home(), '.zcode', 'v2', 'config.json')) ?? {};
  const providers = obj(j.provider);
  const found: { model: string; prio: number; via?: string }[] = [];
  for (const [pid, pv] of Object.entries(providers)) {
    const p = obj(pv);
    if (p.enabled === false) continue;
    for (const [mid, mv] of Object.entries(obj(p.models))) {
      const prio = Number(obj(obj(mv).zcode).priority);
      found.push({ model: mid, prio: Number.isFinite(prio) ? prio : 999, via: hostOf(strOf(obj(p.options).baseURL)) ?? pid });
    }
  }
  found.sort((a, b) => Number(/flash/i.test(a.model)) - Number(/flash/i.test(b.model)) || a.prio - b.prio);
  return found[0] ? { model: found[0].model, via: found[0].via } : {};
}

// ---- 各家工具 ----

const claude: HarnessSpec = {
  id: 'claude',
  label: 'Claude Code',
  vendor: 'Anthropic',
  rank: 10,
  workLevels: ['safe', 'full'],
  canReview: true,
  tested: 'yes',
  loginHint: '在终端运行 claude，按提示登录（或在 ~/.claude/settings.json 里配接口密钥）。',
  locate: () => locateBin('claude'),
  login(loc) {
    const s = claudeSettings();
    if (s.hasToken) return { state: 'ok', detail: `用 ${s.baseHost ?? '自配接口'} 的密钥` };
    if (envValue('ANTHROPIC_API_KEY') || envValue('ANTHROPIC_AUTH_TOKEN')) return { state: 'ok', detail: '用环境变量里的密钥' };
    const r = run([...loc.exec, 'auth', 'status'], 20_000);
    try {
      const j = JSON.parse(r.out) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
      if (j.loggedIn) return { state: 'ok', detail: `已登录（${j.authMethod ?? 'claude.ai'}${j.subscriptionType ? ` · ${j.subscriptionType}` : ''}）` };
      return { state: 'no', detail: '没登录' };
    } catch {
      return { state: 'unknown', detail: '看不出登录状态' };
    }
  },
  model() {
    const s = claudeSettings();
    return { model: s.model, label: s.model?.replace(/\[[^\]]*\]$/, ''), via: s.baseHost };
  },
  invoke(loc, i) {
    const a = [...loc.exec, '-p', '--output-format', 'stream-json', '--verbose'];
    if (i.readOnly) a.push('--tools', 'Read,Grep,Glob');
    else if (i.level === 'full') a.push('--dangerously-skip-permissions');
    // 安全档：自动接受改文件；命令放进 Claude Code 自己的沙箱（只能写当前文件夹），沙箱里的命令自动放行。
    else a.push('--permission-mode', 'acceptEdits', '--settings', JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } }));
    if (i.model) a.push('--model', i.model);
    if (i.effort) a.push('--effort', i.effort);
    return { argv: a, stdin: i.prompt, format: 'claude' };
  },
};

const codex: HarnessSpec = {
  id: 'codex',
  label: 'Codex',
  vendor: 'OpenAI',
  rank: 20,
  workLevels: ['safe', 'full'],
  canReview: true,
  tested: 'yes',
  loginHint: '在终端运行 codex login。',
  locate: () => locateBin('codex'),
  login(loc) {
    if (envValue('OPENAI_API_KEY')) return { state: 'ok', detail: '用环境变量 OPENAI_API_KEY' };
    const r = run([...loc.exec, 'login', 'status'], 20_000);
    const text = `${r.out}\n${r.err}`;
    if (/logged in/i.test(text) && !/not logged in/i.test(text)) return { state: 'ok', detail: (text.match(/Logged in[^\n]*/i)?.[0] ?? '已登录').replace(/^Logged in using /i, '已登录：') };
    if (/not logged in/i.test(text) || r.code !== 0) return { state: 'no', detail: '没登录' };
    return { state: 'unknown', detail: '看不出登录状态' };
  },
  model() {
    const s = codexSettings();
    return { model: s.model, label: s.model, effort: s.effort, efforts: s.efforts, via: s.provider };
  },
  invoke(loc, i) {
    const a = [...loc.exec, 'exec', '--skip-git-repo-check', '--color', 'never', '-C', i.cwd, '--json', '-o', i.outFile];
    if (i.readOnly) a.push('-s', 'read-only', '--ephemeral');
    else if (i.level === 'full') a.push('--dangerously-bypass-approvals-and-sandbox');
    // 安全档：Codex 自己的沙箱，只能写工作目录，默认不联网。
    else a.push('-s', 'workspace-write');
    if (i.model) a.push('-m', i.model);
    if (i.effort) a.push('-c', `model_reasoning_effort="${i.effort}"`);
    a.push('-');
    return { argv: a, stdin: i.prompt, format: 'codex', outFile: i.outFile };
  },
};

/** Cursor Agent：正常安装时 cursor-agent / agent 就能用；快捷命令被 Cursor 编辑器的启动脚本顶替时，直接调程序本体。 */
function locateCursor(): Located | null {
  let broken = false;
  for (const name of ['cursor-agent', 'agent']) {
    const bin = which(name);
    if (!bin) continue;
    const v = run([bin, '--version']);
    if (v.code === 0 && /^\d{4}\.\d{1,2}\.\d{1,2}/.test(v.out)) return { exec: [bin], version: v.out.split('\n')[0], where: bin };
    broken = true;
  }
  const root = path.join(home(), '.local', 'share', 'cursor-agent', 'versions');
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root).sort().reverse();
  } catch {
    return null;
  }
  for (const d of dirs) {
    const dir = path.join(root, d);
    const node = path.join(dir, 'node');
    const idx = path.join(dir, 'index.js');
    if (fs.existsSync(idx) && fs.existsSync(node)) {
      return {
        exec: [node, idx],
        version: d,
        where: dir,
        ...(broken ? { note: 'cursor-agent 命令被 Cursor 编辑器的启动脚本顶替了（直接运行会报「找不到 Cursor」），接力台已改为直接调用程序本体。' } : {}),
      };
    }
  }
  return null;
}

const cursorAgent: HarnessSpec = {
  id: 'cursor-agent',
  label: 'Cursor Agent',
  vendor: 'Cursor',
  rank: 30,
  workLevels: ['safe', 'full'],
  canReview: true,
  tested: 'yes',
  loginHint: '在终端运行 cursor-agent login（或 agent login）。',
  locate: locateCursor,
  login(loc) {
    if (envValue('CURSOR_API_KEY')) return { state: 'ok', detail: '用环境变量 CURSOR_API_KEY' };
    const r = run([...loc.exec, 'status'], 25_000);
    const text = `${r.out}\n${r.err}`;
    if (/logged in as/i.test(text)) return { state: 'ok', detail: '已登录' };
    if (/not logged in|not authenticated|login required/i.test(text)) return { state: 'no', detail: '没登录' };
    return { state: 'unknown', detail: '看不出登录状态' };
  },
  model() {
    const s = cursorSettings();
    return { model: s.model, label: s.label };
  },
  invoke(loc, i) {
    const a = [...loc.exec, '-p', '--trust', '--output-format', 'stream-json', '--workspace', i.cwd];
    if (i.readOnly) a.push('--mode', 'ask');
    // --force：不再逐个确认；安全档同时打开 Cursor 自己的沙箱（命令只能写工作目录）。
    else a.push('--force', '--sandbox', i.level === 'full' ? 'disabled' : 'enabled');
    if (i.model) a.push('--model', i.model);
    a.push(i.prompt);
    return { argv: a, format: 'cursor' };
  },
};

/**
 * ZCode 桌面版自带的命令行内核按「自己所在位置」找内置接口配置，直接调 zcode.cjs 时找不到
 * （报「无法定位 CLI ZCode Built-in Provider Config」）。用它认的环境变量告诉它在哪。
 */
export function zcodeBuiltinConfig(loc: Located): string | null {
  const cjs = loc.exec.find((x) => x.endsWith('zcode.cjs'));
  if (!cjs) return null;
  const resources = path.dirname(path.dirname(cjs));
  for (const p of [path.join(path.dirname(cjs), 'provider', 'zcode-builtin.json'), path.join(resources, 'config', 'provider', 'zcode-builtin.json')]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function locateZcode(): Located | null {
  const bin = locateBin('zcode');
  if (bin || !scanApps()) return bin;
  for (const app of ['/Applications/ZCode.app', path.join(home(), 'Applications', 'ZCode.app')]) {
    const cjs = path.join(app, 'Contents', 'Resources', 'glm', 'zcode.cjs');
    if (!fs.existsSync(cjs)) continue;
    const v = run([process.execPath, cjs, '--version'], 20_000);
    if (v.code === 0 || v.out) return { exec: [process.execPath, cjs], version: firstVersion(v.out || v.err), where: cjs, note: '用的是 ZCode 桌面版自带的命令行内核。' };
  }
  return null;
}

const zcode: HarnessSpec = {
  id: 'zcode',
  label: 'ZCode',
  vendor: '智谱',
  rank: 40,
  workLevels: ['safe', 'full'],
  canReview: true,
  tested: 'no',
  loginHint: '打开 ZCode 桌面版登录，或在终端运行 zcode login。',
  locate: locateZcode,
  login() {
    if (fs.existsSync(path.join(home(), '.zcode', 'v2', 'credentials.json'))) return { state: 'ok', detail: '找到 ZCode 的登录凭据' };
    if (envValue('ZAI_API_KEY') || envValue('ZHIPUAI_API_KEY')) return { state: 'ok', detail: '用环境变量里的密钥' };
    return { state: 'no', detail: '没找到登录凭据' };
  },
  model() {
    const s = zcodeSettings();
    return { model: s.model, label: s.model, via: s.via };
  },
  invoke(loc, i) {
    // --prompt 默认是 yolo（全放开）；安全档用 edit（自动改文件），只读用 plan。
    const mode = i.readOnly ? 'plan' : i.level === 'full' ? 'yolo' : 'edit';
    const cfg = zcodeBuiltinConfig(loc);
    return { argv: [...loc.exec, '-p', i.prompt, '--cwd', i.cwd, '--mode', mode, '--no-color'], format: 'lines', ...(cfg ? { env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: cfg } } : {}) };
  },
};

const antigravity: HarnessSpec = {
  id: 'agy',
  label: 'Antigravity',
  vendor: 'Google',
  rank: 50,
  // 它的「接受改动」模式一遇到要确认的命令就整段停下，只有完全放开才能无人值守地干活。
  workLevels: ['full'],
  canReview: true,
  tested: 'partial',
  loginHint: '在终端运行 agy，按提示用 Google 账号登录。',
  locate: () => locateBin('agy'),
  login() {
    if (fs.existsSync(path.join(home(), '.gemini', 'oauth_creds.json'))) return { state: 'ok', detail: '找到 Google 登录凭据' };
    return { state: 'no', detail: '没找到登录凭据' };
  },
  model: () => ({}),
  invoke(loc, i) {
    const a = [...loc.exec, '-p', i.prompt, '--output-format', 'stream-json'];
    if (i.readOnly) a.push('--mode', 'plan');
    else if (i.level === 'full') a.push('--dangerously-skip-permissions', '--sandbox');
    else a.push('--mode', 'accept-edits');
    if (i.model) a.push('--model', i.model);
    if (i.effort) a.push('--effort', i.effort);
    return { argv: a, format: 'agy' };
  },
};

const gemini: HarnessSpec = {
  id: 'gemini',
  label: 'Gemini CLI',
  vendor: 'Google',
  rank: 55,
  workLevels: ['safe', 'full'],
  canReview: true,
  tested: 'no',
  loginHint: '在终端运行 gemini，按提示登录。',
  locate() {
    const loc = locateBin('gemini');
    if (!loc) return null;
    try {
      if (path.basename(fs.realpathSync(loc.where)) === 'agy') return null;
    } catch {
      /* 保持原样 */
    }
    return loc;
  },
  login() {
    if (envValue('GEMINI_API_KEY') || envValue('GOOGLE_API_KEY')) return { state: 'ok', detail: '用环境变量里的密钥' };
    if (fs.existsSync(path.join(home(), '.gemini', 'oauth_creds.json'))) return { state: 'ok', detail: '找到 Google 登录凭据' };
    return { state: 'no', detail: '没登录' };
  },
  model: () => ({}),
  invoke(loc, i) {
    const a = [...loc.exec, '-p', i.prompt, '--approval-mode', i.readOnly ? 'default' : i.level === 'full' ? 'yolo' : 'auto_edit'];
    if (i.model) a.push('-m', i.model);
    return { argv: a, format: 'lines' };
  },
};

const qwen: HarnessSpec = {
  id: 'qwen',
  label: 'Qwen Code',
  vendor: '阿里',
  rank: 56,
  workLevels: ['safe', 'full'],
  canReview: true,
  tested: 'no',
  loginHint: '在终端运行 qwen，按提示登录。',
  locate: () => locateBin('qwen'),
  login() {
    if (envValue('DASHSCOPE_API_KEY') || envValue('OPENAI_API_KEY')) return { state: 'ok', detail: '用环境变量里的密钥' };
    if (fs.existsSync(path.join(home(), '.qwen', 'oauth_creds.json'))) return { state: 'ok', detail: '找到登录凭据' };
    return { state: 'unknown', detail: '看不出登录状态' };
  },
  model: () => ({}),
  invoke(loc, i) {
    const a = [...loc.exec, '-p', i.prompt, '--approval-mode', i.readOnly ? 'plan' : i.level === 'full' ? 'yolo' : 'auto-edit'];
    if (i.model) a.push('-m', i.model);
    return { argv: a, format: 'lines' };
  },
};

const opencode: HarnessSpec = {
  id: 'opencode',
  label: 'OpenCode',
  vendor: 'SST',
  rank: 60,
  workLevels: ['full'],
  canReview: true,
  tested: 'no',
  loginHint: '在终端运行 opencode auth login。',
  locate: () => locateBin('opencode'),
  login: () => ({ state: 'unknown', detail: '看不出登录状态' }),
  model: () => ({}),
  invoke(loc, i) {
    const a = [...loc.exec, 'run'];
    if (i.readOnly) a.push('--agent', 'plan');
    if (i.model) a.push('-m', i.model);
    a.push(i.prompt);
    return { argv: a, format: 'lines' };
  },
};

const droid: HarnessSpec = {
  id: 'droid',
  label: 'Factory Droid',
  vendor: 'Factory',
  rank: 65,
  workLevels: ['safe', 'full'],
  canReview: true,
  tested: 'no',
  loginHint: '在终端运行 droid，按提示登录。',
  locate: () => locateBin('droid'),
  login: () => ({ state: envValue('FACTORY_API_KEY') ? 'ok' : 'unknown', detail: envValue('FACTORY_API_KEY') ? '用环境变量 FACTORY_API_KEY' : '看不出登录状态' }),
  model: () => ({}),
  invoke(loc, i) {
    const a = [...loc.exec, 'exec'];
    if (!i.readOnly) a.push('--auto', i.level === 'full' ? 'high' : 'medium');
    if (i.model) a.push('-m', i.model);
    a.push(i.prompt);
    return { argv: a, format: 'lines' };
  },
};

const copilot: HarnessSpec = {
  id: 'copilot',
  label: 'GitHub Copilot CLI',
  vendor: 'GitHub',
  rank: 70,
  workLevels: ['full'],
  canReview: false,
  tested: 'no',
  loginHint: '在终端运行 copilot，按提示登录。',
  locate: () => locateBin('copilot'),
  login: () => ({ state: 'unknown', detail: '看不出登录状态' }),
  model: () => ({}),
  invoke(loc, i) {
    const a = [...loc.exec, '-p', i.prompt, '--allow-all-tools'];
    if (i.model) a.push('--model', i.model);
    return { argv: a, format: 'lines' };
  },
};

const grok: HarnessSpec = {
  id: 'grok',
  label: 'Grok CLI',
  vendor: 'xAI',
  rank: 90,
  workLevels: ['safe', 'full'],
  canReview: true,
  tested: 'no',
  loginHint: '没登录。如果你是在 Cursor 里用 Grok，就不用管它；要单独用，在终端运行 grok login。',
  locate: () => locateBin('grok'),
  login() {
    if (envValue('XAI_API_KEY')) return { state: 'ok', detail: '用环境变量 XAI_API_KEY' };
    if (fs.existsSync(path.join(home(), '.grok', 'auth.json'))) return { state: 'ok', detail: '找到登录凭据' };
    return { state: 'no', detail: '没登录' };
  },
  model: () => ({}),
  invoke(loc, i) {
    const mode = i.readOnly ? 'plan' : i.level === 'full' ? 'bypassPermissions' : 'acceptEdits';
    const a = [...loc.exec, '-p', i.prompt, '--cwd', i.cwd, '--output-format', 'plain', '--permission-mode', mode];
    if (i.model) a.push('-m', i.model);
    return { argv: a, format: 'lines' };
  },
};

export const HARNESSES: HarnessSpec[] = [claude, codex, cursorAgent, zcode, antigravity, gemini, qwen, opencode, droid, copilot, grok];

/** 认得的工具报错：翻成能照着做的一句话（认不出返回 null）。 */
export function explainFailure(harnessId: string | undefined, text: string): string | null {
  if (harnessId === 'zcode' && /Select a model before continuing|Model creation failed/i.test(text)) {
    return 'ZCode 命令行还没选默认模型（桌面版里选的它不认）。在终端里运行一次 ZCode 的命令行，输入 /model 选好模型，之后接力台就能调度它。';
  }
  if (/not logged in|please log ?in|unauthorized|401/i.test(text)) return '看起来没登录（或者登录过期了）：在终端里打开这个工具重新登录一下。';
  return null;
}

export function findHarness(id: string | undefined): HarnessSpec | null {
  if (!id) return null;
  return HARNESSES.find((h) => h.id === id) ?? null;
}

/** 命令行的第一个词对应哪个工具（把旧名单里的 cmd: "claude" 认出来）。 */
export function harnessForCommand(cmd: string | undefined): HarnessSpec | null {
  const first = (cmd ?? '').trim().split(/\s+/)[0] ?? '';
  const base = path.basename(first);
  const map: Record<string, string> = { claude: 'claude', codex: 'codex', 'cursor-agent': 'cursor-agent', zcode: 'zcode', agy: 'agy', gemini: 'gemini', qwen: 'qwen', opencode: 'opencode', droid: 'droid', copilot: 'copilot', grok: 'grok' };
  return findHarness(map[base]);
}

// ---- 找到的位置缓存一会儿（每次派活都要重新找，别每次都起进程） ----

const locCache = new Map<string, { at: number; loc: Located | null }>();

export function locateCached(spec: HarnessSpec, maxAgeMs = 5 * 60_000): Located | null {
  const hit = locCache.get(spec.id);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.loc;
  const loc = spec.locate();
  locCache.set(spec.id, { at: Date.now(), loc });
  return loc;
}

export function clearLocateCache(): void {
  locCache.clear();
}
