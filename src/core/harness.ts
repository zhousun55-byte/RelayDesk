import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { recentOfficialModel } from './claude-log';
import { agentEnv, envValue, scanApps, which } from './env';
import { relayHome } from './paths';
import { codexLimits, type Limit } from './quota';

/**
 * 认得的 AI 编程工具（harness）：怎么找到它、怎么看登录、默认用什么模型、怎么无人值守地调用。
 * 全自动流水线只通过这里调用工具；新增一个工具 = 在 HARNESSES 里加一项。
 */

/** 权限。safe（只在项目里）：只能改项目文件夹里的文件，命令在工具自己的沙箱里跑；full（不限制）：工具不再拦任何操作。 */
export type Level = 'safe' | 'full';

/** 工具标准输出的格式（决定怎么解析进度和最后一句话）。 */
export type StreamFormat = 'claude' | 'codex' | 'cursor' | 'agy' | 'dsh' | 'lines' | 'text';

export interface Located {
  /** 调用前缀：可执行文件（+ 固定参数），如 ['/…/codex'] 或 ['/…/node', '/…/index.js']。 */
  exec: string[];
  version: string;
  /** 给人看的位置。 */
  where: string;
  /** 找的过程中发现的问题（比如快捷命令装坏了、已绕过）。 */
  note?: string;
  /** 调用时要带的环境变量（比如用桌面程序自带的运行时跑命令行）。 */
  env?: Record<string, string>;
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
  /** 要你知道的事（比如命令行太旧、用不上最新的模型）。 */
  note?: string;
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
  /** 要去掉的环境变量（比如用 Claude Code 官方账号时，去掉把它接到别家模型的那些）。 */
  dropEnv?: RegExp;
}

export interface HarnessSpec {
  id: string;
  label: string;
  vendor: string;
  /** 默认排序：数字小的优先当主力。 */
  rank: number;
  /** 哪些档位下能无人值守地干活（有的工具在安全档一碰命令就整段停下）。 */
  workLevels: Level[];
  /** 你给它的设置让安全档守不住时（比如允许改项目外的文件）说为什么，守得住返回 undefined。 */
  unsafe?(): string | undefined;
  canReview: boolean;
  /** 实测程度：yes = 实测过改文件和跑命令；partial = 实测过一部分；no = 按官方参数写的，没实测。 */
  tested: 'yes' | 'partial' | 'no';
  loginHint: string;
  /** 你自己在终端里用它时要加的参数（比如 Claude Code 官方账号要跳过你的用户设置）。 */
  manualArgs?: string[];
  locate(): Located | null;
  login(loc: Located): LoginInfo;
  model(loc: Located): ModelInfo;
  invoke(loc: Located, input: InvokeInput): Invocation;
  /** 输出里不带 token 用量的工具：从它自己记的会话里读（sinceMs 之后这个项目的会话加起来）；读不到就是 null。 */
  usage?(root: string, sinceMs: number): { input: number; output: number } | null;
  /** 输出里不带额度的工具：从它自己记的会话里读（sinceMs 之后这个项目最新的一份）；读不到就是 null。 */
  limits?(root: string, sinceMs: number): Limit[] | null;
}

// ---- 小工具 ----

function home(): string {
  return os.homedir();
}

function run(argv: string[], timeoutMs = 15_000, dropEnv?: RegExp, extraEnv: Record<string, string> = {}): { code: number; out: string; err: string } {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: timeoutMs, env: agentEnv(extraEnv, dropEnv), cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
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

/** 把 Claude Code 接到别家模型、或者改掉它用的模型的环境变量：用官方账号时一律去掉。 */
export const CLAUDE_PROVIDER_ENV = /^(ANTHROPIC_|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$|CLAUDE_CODE_SUBAGENT_MODEL$)/;

/** 跳过 ~/.claude/settings.json（别家模型的接口和密钥一般配在这里），只读项目里的设置。 */
const OFFICIAL_ARGS = ['--setting-sources', 'project,local'];

/** Claude Code 默认是不是被接到了别家模型（DeepSeek、Kimi、智谱……）：返回那家的地址，没有返回 null。 */
export function claudeThirdParty(): string | null {
  const host = claudeSettings().baseHost ?? hostOf(envValue('ANTHROPIC_BASE_URL'));
  return host && !/(^|\.)anthropic\.com$/i.test(host) ? host : null;
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
 * Cursor 用的模型：以桌面版对话框里选的为准（你平时在 Cursor 里用的就是它），没有再看命令行自己的 ~/.cursor/cli-config.json。
 * 命令行 --model 认的是「旧名」（grok-4.7-high-fast、cursor-grok-4.6-high-fast）：桌面版记的是模型加参数（grok-4.7、高思考、快），
 * 按参数在它的模型表里找到对应的旧名。
 */
export function cursorSettings(): { model?: string; label?: string } {
  const desk = cursorDesktopModel(cursorState());
  if (desk) return desk;
  const j = readJson(path.join(home(), '.cursor', 'cli-config.json')) ?? {};
  const m = obj(j.model);
  const display = strOf(m.displayName);
  const id = strOf(m.displayModelId) ?? strOf(m.modelId) ?? strOf(obj(j.selectedModel).modelId);
  // 旧版配置里 modelId 只是模型本身（grok-4.6，命令行不认），命令行要的名字藏在显示名里（「Cursor Grok 4.6 High Fast」）
  const bare = !id || /^[a-z]+-\d+(\.\d+)?$/i.test(id);
  const model = bare && display ? display.toLowerCase().replace(/\s+/g, '-') : id;
  return { model, label: display?.replace(/^Cursor\s+/, '') ?? model };
}

/** 桌面版的设置（Cursor 的 SQLite 库里的一条 JSON）：模型表和对话框里选的。读不到就是 null。 */
let cursorCache: { key: string; value: unknown } | null = null;
function cursorState(): unknown {
  const base = process.platform === 'darwin' ? path.join(home(), 'Library', 'Application Support') : process.platform === 'win32' ? process.env.APPDATA ?? '' : path.join(home(), '.config');
  const db = path.join(base, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  let key = '';
  try {
    key = [db, `${db}-wal`].map((f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0)).join('/');
  } catch {
    return null;
  }
  if (key.startsWith('0/')) return null;
  if (cursorCache?.key === key) return cursorCache.value;
  const sqlite = which('sqlite3');
  let value: unknown = null;
  if (sqlite) {
    const r = spawnSync(sqlite, ['-readonly', db, "select value from ItemTable where key = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'"], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
    try {
      value = r.status === 0 && r.stdout.trim() ? JSON.parse(r.stdout) : null;
    } catch {
      value = null;
    }
  }
  cursorCache = { key, value };
  return value;
}

/** 从桌面版的设置里找出对话框选的模型，换成命令行认的名字。没选（默认 / 自动）或者对不上就是 null。 */
export function cursorDesktopModel(state: unknown): { model: string; label: string } | null {
  const s = obj(state);
  const list = (v: unknown) => (Array.isArray(v) ? v.map(obj) : []);
  const sel = list(obj(obj(obj(s.aiSettings).modelConfig).composer).selectedModels)[0];
  const id = strOf(sel?.modelId);
  if (!sel || !id || id === 'default') return null;
  const want = new Map(list(sel.parameters).map((p) => [strOf(p.id), strOf(p.value)]));
  const def = list(s.availableDefaultModels2).find((m) => m.name === id);
  const v = def && list(def.variants).find((x) => list(x.parameterValues).every((p) => want.get(strOf(p.id)) === strOf(p.value)));
  const slug = strOf(v?.legacySlug);
  return slug && def ? { model: slug, label: strOf(def.clientDisplayName) ?? id } : null;
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
  invoke: (loc, i) => claudeInvoke(loc, i),
};

/** 接力台调用 Claude Code 时一律关掉它的自动更新：升不升级、升到哪一版由你决定。 */
const CLAUDE_ENV = { DISABLE_AUTOUPDATER: '1' };

function claudeInvoke(loc: Located, i: InvokeInput, extra: string[] = []): Invocation {
  const a = [...loc.exec, ...extra, '-p', '--output-format', 'stream-json', '--verbose'];
  if (i.readOnly) a.push('--tools', 'Read,Grep,Glob');
  else if (i.level === 'full') a.push('--dangerously-skip-permissions');
  // 安全档：自动接受改文件；命令放进 Claude Code 自己的沙箱（只能写当前文件夹），沙箱里的命令自动放行。
  else a.push('--permission-mode', 'acceptEdits', '--settings', JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } }));
  if (i.model) a.push('--model', i.model);
  if (i.effort) a.push('--effort', i.effort);
  return { argv: a, stdin: i.prompt, format: 'claude', env: { ...CLAUDE_ENV } };
}

/**
 * Claude Code 用你的官方账号（claude.ai 登录）。你把 Claude Code 默认接到了别家模型（比如 DeepSeek）时，
 * 同一个 claude 命令其实是两位：默认的（别家模型，多半算弱）和官方账号（Opus，算强）。
 * 官方账号：跳过你的用户设置、去掉 ANTHROPIC_* 这些变量，就走 claude.ai 登录；默认用最新的 Opus。
 * 没接别家模型时它和「Claude Code」是同一位，不单列。
 */
// ---- 旧版命令行用不了的新模型 ----

/** 「Claude Code 2.1.263 does not support this model; version 2.1.280 or newer is required」 */
const NEEDS_NEWER = /does not support this model\b[\s\S]{0,120}?\bversion\s+(\d+(?:\.\d+)+)\s+or\s+newer/i;

/** 输出里说「这个版本的命令行用不了这个模型」：返回要求的最低版本。 */
export function cliTooOld(text: string): string | null {
  return text.match(NEEDS_NEWER)?.[1] ?? null;
}

function needsPath(): string {
  return path.join(relayHome(), 'cli-models.json');
}

function loadNeeds(): Record<string, string> {
  try {
    const j = JSON.parse(fs.readFileSync(needsPath(), 'utf8')) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** 记下：这个模型要这么新的命令行（~/.relay/cli-models.json）。升级之后版本够了，自动又用它。 */
export function noteModelNeeds(model: string, version: string): void {
  const all = loadNeeds();
  if (all[model] === version) return;
  all[model] = version;
  fs.mkdirSync(path.dirname(needsPath()), { recursive: true });
  fs.writeFileSync(needsPath(), JSON.stringify(all, null, 2) + '\n');
}

function olderThan(a: string, b: string): boolean {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0;
  }
  return false;
}

/** 官方账号用哪个模型：这台电脑上最近用过的最新 Opus；命令行太旧用不了它，就先用简称 opus。 */
export function officialModel(cliVersion: string): { model: string; blocked?: { model: string; needs: string } } {
  const latest = recentOfficialModel();
  if (!latest) return { model: 'opus' };
  const needs = loadNeeds()[latest];
  if (needs && /^\d/.test(cliVersion) && olderThan(cliVersion, needs)) return { model: 'opus', blocked: { model: latest, needs } };
  return { model: latest };
}

/** 调用参数里的 --model。 */
export function modelArg(argv: string[]): string | undefined {
  const i = argv.indexOf('--model');
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Claude 桌面版自己带着一份 Claude Code（~/Library/Application Support/Claude/claude-code/<版本>/，跟着桌面版更新），
 * 通常比终端里的新：用它就能用上最新的 Opus，走的还是同一个 claude.ai 账号的额度，终端里的 claude 一点不动。
 * RELAY_CLAUDE_DESKTOP_DIR 可以指定别的位置（测试用）。
 */
export function desktopClaude(): { bin: string; version: string } | null {
  const custom = process.env.RELAY_CLAUDE_DESKTOP_DIR;
  if (!custom && (process.platform !== 'darwin' || !scanApps())) return null;
  const dir = custom || path.join(home(), 'Library', 'Application Support', 'Claude', 'claude-code');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const versions = names.filter((n) => /^\d+(\.\d+)+$/.test(n)).sort((a, b) => (olderThan(a, b) ? 1 : olderThan(b, a) ? -1 : 0));
  for (const v of versions) {
    for (const bin of [path.join(dir, v, 'claude.app', 'Contents', 'MacOS', 'claude'), path.join(dir, v, 'claude')]) {
      try {
        fs.accessSync(bin, fs.constants.X_OK);
        if (fs.statSync(bin).isFile()) return { bin, version: v };
      } catch {
        /* 这一版不完整 */
      }
    }
  }
  return null;
}

/**
 * 官方账号用哪个 claude：有桌面版自带的就用它（通常更新，能用最新的 Opus）；
 * 没有的话，只有终端里的 Claude Code 被接到了别家模型时才单列（没接别家时它和「Claude Code」是同一位）。
 */
function locateOfficial(): Located | null {
  const desk = desktopClaude();
  if (desk) {
    const v = run([desk.bin, '--version'], 20_000, undefined, CLAUDE_ENV);
    if (v.code === 0 || v.out) {
      const version = firstVersion(v.out || v.err) || desk.version;
      const term = which('claude');
      const tv = term ? firstVersion(run([term, '--version'], 15_000, undefined, CLAUDE_ENV).out) : '';
      return {
        exec: [desk.bin],
        version,
        where: desk.bin,
        note: `用的是 Claude 桌面版自带的 Claude Code ${version}（跟着桌面版更新，走你的 claude.ai 账号额度）${tv ? `；终端里的 claude ${tv} 没动` : ''}。`,
      };
    }
  }
  return claudeThirdParty() ? locateBin('claude') : null;
}

const claudeOfficial: HarnessSpec = {
  id: 'claude-official',
  label: 'Claude Code 官方账号',
  vendor: 'Anthropic',
  rank: 9,
  workLevels: ['safe', 'full'],
  canReview: true,
  tested: 'partial',
  loginHint: '在终端运行 claude auth login，用 claude.ai 账号登录（Claude 桌面版登录的是同一个账号）。',
  manualArgs: OFFICIAL_ARGS,
  locate: locateOfficial,
  login(loc) {
    const r = run([...loc.exec, ...OFFICIAL_ARGS, 'auth', 'status'], 20_000, CLAUDE_PROVIDER_ENV);
    try {
      const j = JSON.parse(r.out) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
      if (j.loggedIn) return { state: 'ok', detail: `已登录（${j.authMethod ?? 'claude.ai'}${j.subscriptionType ? ` · ${j.subscriptionType}` : ''}）` };
      return { state: 'no', detail: '官方账号没登录' };
    } catch {
      return { state: 'unknown', detail: '看不出官方账号的登录状态' };
    }
  },
  model(loc) {
    const o = officialModel(loc.version);
    return {
      model: o.model,
      label: o.model,
      ...(o.blocked
        ? {
            note: loc.where.includes(`${path.sep}claude-code${path.sep}`)
              ? `这份 Claude Code（${loc.version}）用不了 ${o.blocked.model}（要 ${o.blocked.needs} 或更新），先用 opus；Claude 桌面版更新后它自带的 Claude Code 会跟着变新，到时自动换成 ${o.blocked.model}。`
              : `命令行 ${loc.version} 用不了 ${o.blocked.model}（要 ${o.blocked.needs} 或更新），先用 opus。想用上它：在终端运行 claude update，或者装 Claude 桌面版（接力台会用它自带的新版 Claude Code，终端里的不用动）。`,
          }
        : {}),
    };
  },
  invoke(loc, i) {
    // 没在名单里指定模型：用这台电脑上最近用过的最新 Opus（和桌面版一样）；命令行太旧用不了它、或者看不出来，就用简称 opus。
    return { ...claudeInvoke(loc, { ...i, model: i.model || officialModel(loc.version).model }, OFFICIAL_ARGS), dropEnv: CLAUDE_PROVIDER_ENV };
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
  limits: (root, sinceMs) => codexSessionLimits(root, sinceMs),
};

/**
 * Codex 每次运行在 ~/.codex/sessions/年/月/日/ 下留一份 rollout-时间-编号.jsonl（群聊用的 --ephemeral 不留）：
 * 第一行 session_meta 写着在哪个文件夹跑的，之后每轮一条 token_count，带着 rate_limits。
 * 取 sinceMs 之后在这个项目里跑的最新一份，读它最后一条 rate_limits。
 */
export function codexSessionLimits(root: string, sinceMs: number, now = Date.now()): Limit[] | null {
  const base = path.join(envValue('CODEX_HOME') || path.join(home(), '.codex'), 'sessions');
  const same = new Set([root]);
  try {
    same.add(fs.realpathSync(root));
  } catch {
    /* 文件夹没了 */
  }
  const p2 = (n: number) => String(n).padStart(2, '0');
  let best: { file: string; mtime: number } | null = null;
  for (let d = new Date(sinceMs); d.getTime() <= now; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const dir = path.join(base, String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      try {
        const mtime = fs.statSync(file).mtimeMs;
        if (mtime < sinceMs || (best && mtime <= best.mtime)) continue;
        // 第一行很长（带着整段说明），cwd 在开头几百字节里
        const cwd = readSlice(file, 0, 8192).match(/"cwd":("(?:[^"\\]|\\.)*")/)?.[1];
        if (cwd && same.has(JSON.parse(cwd) as string)) best = { file, mtime };
      } catch {
        /* 读不了的跳过 */
      }
    }
  }
  if (!best) return null;
  const size = fs.statSync(best.file).size;
  const lines = readSlice(best.file, Math.max(0, size - 256 * 1024), 256 * 1024).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    try {
      const l = codexLimits(obj(obj(JSON.parse(lines[i])).payload).rate_limits);
      if (l.length) return l;
    } catch {
      /* 切在半行上的跳过 */
    }
  }
  return null;
}

function readSlice(file: string, start: number, len: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    return buf.subarray(0, fs.readSync(fd, buf, 0, len, start)).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

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
    // 名单里没指定：用你在 Cursor 里选的（命令行自己的默认可能还停在旧模型上）
    const model = i.model ?? cursorSettings().model;
    if (model) a.push('--model', model);
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

// ---- DeepSeek Harness（DeepSeek 官方的桌面编程助手） ----

/** DeepSeek Harness 的数据目录（桌面版和命令行共用：登录、会话、配置都在这里）。 */
export function dshHome(): string {
  return envValue('DSH_HOME') || path.join(home(), '.dsh');
}

/**
 * DeepSeek Harness 的无界面输出不带 token 用量，它自己的会话记录里有：~/.dsh/sessions/<项目>/session-<编号>/session.v4.jsonl.zstd，
 * 每调一次模型一行 data.usage。<项目> 是路径的写法：/ 换成 -，非 ASCII 的字写成 ~四位十六进制，前面加 -，后面加 --。
 * 输入把读缓存、写缓存的也算上（和别的工具日志里的一样）。
 */
/**
 * 一个文件里接连写的好几个 zstd 块（DeepSeek Harness 每写一条记录接一块）：Node 的 zstd 一次只解第一块，
 * 按块头（RFC 8878）切开再逐块解。写到一半的最后一块不要。
 */
function unzstdAll(buf: Buffer, unzstd: (b: Buffer) => Buffer): string {
  const parts: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const magic = buf.readUInt32LE(i);
    // 可以跳过的块：4 字节标记 + 4 字节长度
    if (magic >>> 4 === 0x184d2a5) {
      i += 8 + buf.readUInt32LE(i + 4);
      continue;
    }
    if (magic !== 0xfd2fb528) break;
    const fhd = buf[i + 4];
    const single = (fhd >> 5) & 1;
    let p = i + 5 + (single ? 0 : 1) + [0, 1, 2, 4][fhd & 3] + [single, 2, 4, 8][fhd >> 6];
    let last = 0;
    while (!last && p + 3 <= buf.length) {
      const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      last = h & 1;
      p += 3 + (((h >> 1) & 3) === 1 ? 1 : h >>> 3);
    }
    p += (fhd >> 2) & 1 ? 4 : 0;
    if (!last || p > buf.length) break;
    parts.push(unzstd(buf.subarray(i, p)));
    i = p;
  }
  return Buffer.concat(parts).toString('utf8');
}

export function dshUsage(root: string, sinceMs: number): { input: number; output: number } | null {
  const unzstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
  if (!unzstd) return null;
  const name = `-${root
    .split('')
    .map((ch) => (ch === '/' ? '-' : ch.charCodeAt(0) > 127 ? `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}` : ch))
    .join('')}--`;
  const dir = path.join(dshHome(), 'sessions', name);
  let subs: string[] = [];
  try {
    subs = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let input = 0;
  let output = 0;
  let seen = false;
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  for (const d of subs) {
    const f = path.join(dir, d, 'session.v4.jsonl.zstd');
    let text = '';
    try {
      if (fs.statSync(f).mtimeMs < sinceMs) continue;
      text = unzstdAll(fs.readFileSync(f), unzstd);
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue;
      try {
        const u = (JSON.parse(line) as { data?: { usage?: Record<string, unknown> } }).data?.usage;
        if (!u || typeof u !== 'object') continue;
        input += n(u.inputTokens) + n(u.cacheReadTokens) + n(u.cacheWriteTokens);
        output += n(u.outputTokens);
        seen = true;
      } catch {
        /* 坏行跳过 */
      }
    }
  }
  return seen ? { input, output } : null;
}

/**
 * 桌面版选的账号和模型（~/.dsh/profiles/desktop/cordis.patch.yml 里 agent-default-model 那一段）。
 * 无界面模式默认走接口密钥；接力台调度时带上这一段，让它和桌面版用同一个账号、同一个模型。
 */
export function dshSettings(): { provider?: string; model?: string; effort?: string } {
  for (const prof of ['desktop', 'headless']) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(dshHome(), 'profiles', prof, 'cordis.patch.yml'), 'utf8');
    } catch {
      continue;
    }
    const block = text.split(/\n(?=-\s)/).find((b) => /^-?\s*id:\s*["']?agent-default-model["']?\s*$/m.test(b));
    if (!block) continue;
    const get = (k: string) => block.match(new RegExp(`^\\s+${k}:\\s*["']?([^"'\\n#]+?)["']?\\s*$`, 'm'))?.[1]?.trim();
    const out = { provider: get('provider'), model: get('model'), effort: get('reasoningEffort') };
    if (out.provider || out.model) return out;
  }
  return {};
}

function dshPatch(sel: { provider?: string; model?: string; effort?: string }): string | null {
  if (!sel.provider && !sel.model) return null;
  const lines = ['# 接力台写的：让无界面模式用和 DeepSeek Harness 桌面版一样的账号和模型。', '- id: agent-default-model', "  name: '@deepseek-ai/dsh-agent-default-model'", '  config:'];
  if (sel.provider) lines.push(`    provider: ${sel.provider}`);
  if (sel.model) lines.push(`    model: ${sel.model}`);
  if (sel.effort) lines.push(`    reasoningEffort: ${sel.effort}`);
  const file = path.join(relayHome(), 'dsh', 'headless-patch.yml');
  const text = `${lines.join('\n')}\n`;
  try {
    if (fs.readFileSync(file, 'utf8') === text) return file;
  } catch {
    /* 还没有 */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const DSH_APP_NAME = 'DeepSeek Harness';

/**
 * 找 dsh：npm 装的 dsh 命令优先；没有的话用桌面版自带的——它的命令行在 app.asar 里，
 * 用桌面程序本身当 Node 运行（ELECTRON_RUN_AS_NODE=1），和桌面版共用 ~/.dsh 里的登录。
 */
function locateDsh(): Located | null {
  const bin = which('dsh');
  if (bin) {
    const v = run([bin, '--version'], 30_000);
    if (v.code === 0 && v.out) return { exec: [bin], version: firstVersion(v.out), where: bin };
  }
  if (process.platform !== 'darwin' || !scanApps()) return null;
  for (const app of [`/Applications/${DSH_APP_NAME}.app`, path.join(home(), 'Applications', `${DSH_APP_NAME}.app`)]) {
    const exe = path.join(app, 'Contents', 'MacOS', DSH_APP_NAME);
    const asar = path.join(app, 'Contents', 'Resources', 'app.asar');
    if (!fs.existsSync(exe) || !fs.existsSync(asar)) continue;
    const js = path.join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    const env = { ELECTRON_RUN_AS_NODE: '1' };
    const v = run([exe, js, '--version'], 30_000, undefined, env);
    if (v.code === 0 && v.out) return { exec: [exe, js], version: firstVersion(v.out), where: app, env, note: '用的是 DeepSeek Harness 桌面版自带的 dsh（无界面模式），和桌面版共用登录和额度。' };
  }
  return null;
}

const dsh: HarnessSpec = {
  id: 'dsh',
  label: 'DeepSeek Harness',
  usage: (root, sinceMs) => dshUsage(root, sinceMs),
  vendor: 'DeepSeek',
  rank: 35,
  workLevels: ['safe', 'full'],
  canReview: true,
  tested: 'partial',
  loginHint: '打开 DeepSeek Harness 桌面版，登录 DeepSeek 账号（接力台用的是同一个登录）。',
  locate: locateDsh,
  login() {
    const sel = dshSettings();
    if (fs.existsSync(path.join(dshHome(), '.credentials.yaml'))) return { state: 'ok', detail: sel.provider === 'deepseek-account' ? '用 DeepSeek Harness 桌面版登录的 DeepSeek 账号' : '找到 DeepSeek Harness 的登录凭据' };
    if (envValue('DEEPSEEK_API_KEY')) return { state: 'ok', detail: '用环境变量 DEEPSEEK_API_KEY' };
    return { state: 'no', detail: '没登录' };
  },
  model() {
    const sel = dshSettings();
    const model = sel.model ?? 'deepseek-flash';
    return { model, label: model, ...(sel.effort ? { effort: sel.effort } : {}), via: sel.provider === 'deepseek-account' ? 'DeepSeek 账号（和桌面版同一个）' : sel.provider === 'deepseek-official' ? 'DeepSeek 接口密钥' : sel.provider };
  },
  invoke(loc, i) {
    const sel = dshSettings();
    const patch = dshPatch({ ...sel, ...(i.model ? { model: i.model } : {}), ...(i.effort ? { effort: i.effort } : {}) });
    // 没人应答的审批一律拒绝（它自己的规矩）：安全档 = 只能写工作目录；完全放开 = 不设限。
    const mode = i.readOnly ? 'read-only' : i.level === 'full' ? 'danger-full-access' : 'workspace-write';
    return {
      argv: [...loc.exec, '--profile', 'headless', ...(patch ? ['--patch', patch] : []), '--json', '-'],
      stdin: i.prompt,
      format: 'dsh',
      env: { ...(loc.env ?? {}), DSH_PERMISSION_MODE: mode },
    };
  },
};

const agySettings = () => readJson(path.join(home(), '.gemini', 'antigravity-cli', 'settings.json'));

const antigravity: HarnessSpec = {
  id: 'agy',
  label: 'Antigravity',
  vendor: 'Google',
  rank: 50,
  // 安全档：改文件自动接受，命令放进它自己的沙箱（只能写项目文件夹和临时目录，不能联网）。要人点头的
  // （出沙箱、写项目外、工具执行不是 proceed-in-sandbox 时没放行过的命令）无界面模式下直接拒绝，这一棒停在那儿。1.1.12 起 -p 才认 --mode。
  workLevels: ['safe', 'full'],
  // 写文件的工具不经过沙箱：它设置里允许读写项目外的文件时，项目外也照写不误（1.2.11 实测）
  unsafe: () => (agySettings()?.allowNonWorkspaceAccess === true ? '设置允许读写项目外的文件，权限「只在项目里」时不派活' : undefined),
  canReview: true,
  tested: 'partial',
  loginHint: '在终端运行 agy，按提示用 Google 账号登录。',
  locate: () => locateBin('agy'),
  login() {
    if (fs.existsSync(path.join(home(), '.gemini', 'oauth_creds.json'))) return { state: 'ok', detail: '找到 Google 登录凭据' };
    return { state: 'no', detail: '没找到登录凭据' };
  },
  model() {
    const m = strOf(agySettings()?.model);
    return m ? { model: m, label: m } : {};
  },
  invoke(loc, i) {
    const a = [...loc.exec, '-p', i.prompt, '--output-format', 'stream-json'];
    // 群聊也要带 --sandbox：不带的话读文件的命令（textutil 转 rtf）也要人点头，无界面模式下直接被拒、这一轮什么都不说就结束了。
    a.push(...(i.readOnly ? ['--mode', 'plan'] : i.level === 'full' ? ['--dangerously-skip-permissions'] : ['--mode', 'accept-edits']), '--sandbox');
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
  model() {
    // 配置里写的是「接口/模型」（deepseek/deepseek-flash）
    const m = strOf(readJson(path.join(home(), '.config', 'opencode', 'opencode.json'))?.model);
    if (!m) return {};
    const cut = m.indexOf('/');
    return { model: m, label: m.slice(cut + 1), ...(cut > 0 ? { via: m.slice(0, cut) } : {}) };
  },
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
    // 只读（群聊、投票）：不许改文件、不许跑命令（按官方参数写的，没实测）。
    if (i.readOnly) a.push('--deny-tool', 'write', '--deny-tool', 'shell');
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

export const HARNESSES: HarnessSpec[] = [claude, claudeOfficial, codex, cursorAgent, dsh, zcode, antigravity, gemini, qwen, opencode, droid, copilot, grok];

/** 认得的工具报错：翻成一句说明（只写是什么情况，怎么处理写在 README「常见问题」；认不出返回 null）。 */
export function explainFailure(harnessId: string | undefined, text: string): string | null {
  if (harnessId === 'zcode' && /Select a model before continuing|Model creation failed/i.test(text)) {
    return 'ZCode 命令行没有默认模型';
  }
  if (harnessId === 'dsh' && /ACCOUNT_SIGN_IN_REQUIRED|ACCOUNT_TOKEN_INVALID|sign.?in required/i.test(text)) {
    return 'DeepSeek Harness 没登录或登录过期';
  }
  if (harnessId === 'claude-official' && (NOT_LOGGED_IN.test(text) || /invalid api key/i.test(text))) {
    return 'Claude Code 官方账号没登录或登录过期';
  }
  if (NOT_LOGGED_IN.test(text)) return '没登录或登录过期';
  return null;
}

/** 没登录、登录过期的说法。只认成句的，不认单独的 login、401（文件名 login.ts、行号 401 也会有）。 */
const NOT_LOGGED_IN = /not logged in|please (?:log ?in|sign ?in|run \/login)|(?:log ?in|sign ?in|authentication) (?:is )?required|\bunauthori[sz]ed\b|(?:http|status|error|code)[ :=]*401\b|\b401 unauthori|(?:token|session|credentials?) (?:has )?expired/i;

export function findHarness(id: string | undefined): HarnessSpec | null {
  if (!id) return null;
  return HARNESSES.find((h) => h.id === id) ?? null;
}

/** 命令行的第一个词对应哪个工具（把旧名单里的 cmd: "claude" 认出来）。 */
export function harnessForCommand(cmd: string | undefined): HarnessSpec | null {
  const first = (cmd ?? '').trim().split(/\s+/)[0] ?? '';
  const base = path.basename(first);
  const map: Record<string, string> = { claude: 'claude', codex: 'codex', 'cursor-agent': 'cursor-agent', dsh: 'dsh', zcode: 'zcode', agy: 'agy', gemini: 'gemini', qwen: 'qwen', opencode: 'opencode', droid: 'droid', copilot: 'copilot', grok: 'grok' };
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
