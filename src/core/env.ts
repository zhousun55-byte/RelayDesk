import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { looksSecret } from './redact';

/**
 * 环境变量的三个来源：
 * - 当前进程：接力台被谁启动就继承谁的；
 * - 登录 shell：用户自己在 ~/.zshrc 等处配的（密钥、PATH）。从一个干净环境起 shell 去读，
 *   读到的只有用户自己配的，不会混进宿主程序注入的东西；
 * - 宿主注入：接力台如果是从某个 AI 工具（如 Claude Code）里启动的，会继承它的会话凭据
 *   （CLAUDE_CODE_*、ANTHROPIC_* …）。这些不是用户的配置，绝不能传给别的 AI 工具，也不能拿来用。
 */

let loginCache: Record<string, string> | null = null;

const MARK = '__RELAY_ENV_BEGIN__';

/** 用户在登录 shell 里配置的环境变量。RELAY_LOGIN_PATH=off 时不读（测试用）。 */
export function loginEnv(): Record<string, string> {
  if (loginCache) return loginCache;
  if (process.env.RELAY_LOGIN_PATH === 'off' || process.platform === 'win32') return (loginCache = {});
  const shell = process.env.SHELL || '/bin/zsh';
  // detached：登录 shell 在自己的会话里跑、没有控制终端。不然交互式的 zsh 会把终端的前台抢过去不还，
  // 之后在终端里读键盘的命令（relay chat）会被系统挂起。Node 支持这个选项，只是类型里没写。
  const opts: SpawnSyncOptionsWithStringEncoding & { detached: boolean } = {
    encoding: 'utf8',
    timeout: 8000,
    detached: true,
    env: {
      HOME: os.homedir(),
      USER: process.env.USER ?? '',
      LOGNAME: process.env.LOGNAME ?? process.env.USER ?? '',
      SHELL: shell,
      TERM: 'dumb',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    },
  };
  const r = spawnSync(shell, ['-ilc', `printf '${MARK}'; env -0`], opts);
  const out: Record<string, string> = {};
  const raw = r.stdout ?? '';
  const at = raw.indexOf(MARK);
  if (at >= 0) {
    for (const item of raw.slice(at + MARK.length).split('\0')) {
      const i = item.indexOf('=');
      if (i <= 0) continue;
      const k = item.slice(0, i);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) out[k] = item.slice(i + 1);
    }
  }
  for (const k of ['PWD', 'OLDPWD', 'SHLVL', '_', 'TERM', 'TERM_SESSION_ID']) delete out[k];
  return (loginCache = out);
}

/** 要不要去「应用程序」里找桌面 App 自带的命令行（测试里关掉）。 */
export function scanApps(): boolean {
  return process.env.RELAY_SCAN_APPS !== 'off';
}

/** 接力台是不是从某个 AI 工具的会话里启动的（那样的话进程里有它的会话凭据）。 */
export function insideAgentHost(): boolean {
  return !!(process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT || process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_SANDBOX || process.env.CURSOR_AGENT);
}

/** 宿主 AI 工具注入的会话变量。 */
export function isHostVar(name: string): boolean {
  return /^(CLAUDECODE$|CLAUDE_|ANTHROPIC_|CODEX_SANDBOX|CODEX_THREAD|CURSOR_AGENT|CURSOR_TRACE|__CF)/.test(name);
}

/** 取一个用户配置的环境变量：优先当前进程，其次登录 shell；宿主注入的会话变量一律不认。 */
export function envValue(name: string): string | undefined {
  const login = loginEnv();
  const v = process.env[name];
  if (v && !(insideAgentHost() && isHostVar(name) && login[name] === undefined)) return v;
  const l = login[name];
  return l ? l : undefined;
}

/** 所有「看起来是用户配置的」变量名（给自动识别扫密钥用）。 */
export function userEnvNames(): string[] {
  const names = new Set<string>(Object.keys(loginEnv()));
  for (const k of Object.keys(process.env)) {
    if (insideAgentHost() && isHostVar(k)) continue;
    names.add(k);
  }
  return [...names];
}

function mergedPath(): string {
  // 测试里只用给定的 PATH，不去找这台电脑上真装着的工具。
  if (process.env.RELAY_LOGIN_PATH === 'off') return process.env.PATH ?? '';
  const home = os.homedir();
  const parts: string[] = [];
  const login = loginEnv().PATH;
  if (login) parts.push(...login.split(path.delimiter));
  parts.push(...(process.env.PATH ?? '').split(path.delimiter));
  if (process.platform === 'win32') parts.push(path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm'), path.join(home, '.local', 'bin'));
  else parts.push(path.join(home, '.local/bin'), path.join(home, '.npm-global/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  const seen = new Set<string>();
  return parts.filter((p) => p && !seen.has(p) && (seen.add(p), true)).join(path.delimiter);
}

/**
 * 从双击启动的接力台里跑命令时，PATH 往往比终端里短（~/.local/bin 之类不在里面），
 * 于是 claude / codex 找不到。启动时把登录 shell 的 PATH 和常见目录并进来。
 */
export function augmentPath(): void {
  process.env.PATH = mergedPath();
}

/**
 * 给 AI 工具子进程用的环境：去掉宿主注入的会话变量，补上用户在登录 shell 里配的变量，PATH 补全。
 * drop：再去掉这些变量（比如用 Claude Code 的官方账号时，去掉把它接到别家模型的 ANTHROPIC_*）。
 */
export function agentEnv(extra: Record<string, string> = {}, drop?: RegExp): NodeJS.ProcessEnv {
  const login = loginEnv();
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (insideAgentHost()) {
    for (const k of Object.keys(env)) {
      if (isHostVar(k) && login[k] === undefined) delete env[k];
    }
  }
  for (const [k, v] of Object.entries(login)) {
    if (env[k] === undefined) env[k] = v;
  }
  if (drop) {
    for (const k of Object.keys(env)) if (drop.test(k)) delete env[k];
  }
  // 接力台自己怎么运行的（由小程序看着、登录时启动），不带给 AI 工具。
  delete env.RELAY_KEEPER;
  delete env.RELAY_AT_LOGIN;
  // Windows 上变量名不分大小写，继承来的常叫 Path：先去掉，免得子进程里有两个 PATH。
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
  env.PATH = mergedPath();
  return { ...env, NO_COLOR: '1', FORCE_COLOR: '0', ...extra };
}

/** 名字像密钥的环境变量：…KEY、…TOKEN、…SECRET、…PASSWORD、各家模型和云的凭据。 */
const SECRET_NAME = /(^|_)(API_?KEY|KEY|KEYS|TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|PASSWD|PASS|CREDENTIALS?|AUTH|COOKIE|SESSION|PRIVATE)(_|$)|^(ANTHROPIC|OPENAI|ZHIPU|DEEPSEEK|MOONSHOT|KIMI|DASHSCOPE|QWEN|GEMINI|GOOGLE|AWS|AZURE|GH|GITHUB|GITLAB|NPM|HF|HUGGINGFACE|OPENROUTER|XAI|GROQ|MISTRAL|CLAUDE|CODEX)_/i;

/**
 * 给项目检查命令用的环境：和 AI 工具一样的底子，再去掉名字或值像密钥的变量。
 * 检查命令是项目里写的，谁都能改；它不该拿到各家模型的密钥。不是隔离：文件和网络照样能碰。
 */
export function checkEnv(): NodeJS.ProcessEnv {
  const env = agentEnv();
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_NAME.test(k) || (v && looksSecret(v))) delete env[k];
  }
  return env;
}

/**
 * 在合并后的 PATH 里找可执行文件（只认真的文件，不认 shell 别名 / 函数）。
 * Windows 上按 PATHEXT 补扩展名（claude → claude.exe / codex.cmd）；npm 在旁边放的无扩展名 sh 脚本不算。
 */
export function which(bin: string, win = process.platform === 'win32'): string | null {
  const exts = win ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [];
  const names = !win || exts.some((e) => bin.toUpperCase().endsWith(e.toUpperCase())) ? [bin] : exts.map((e) => bin + e.toLowerCase());
  const pick = (base: string) => names.map((n) => path.join(base, n)).find((p) => isExec(p, win)) ?? null;
  if (bin.includes('/') || (win && bin.includes('\\'))) return pick('');
  for (const dir of mergedPath().split(path.delimiter)) {
    const p = dir && pick(dir);
    if (p) return p;
  }
  return null;
}

/** 是能执行的文件。Windows 上没有「可执行」这一位，看扩展名（上面按 PATHEXT 补的）就够了。 */
function isExec(p: string, win: boolean): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (!win) fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
