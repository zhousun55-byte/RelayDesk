import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { agentEnv, checkEnv } from './env';
import { redactSecrets } from './redact';
import { errorMessage } from './errors';
import { git } from './git';
import type { Level } from './harness';
import { ToolChat, type ToolCall, type ToolDef } from './llm';
import { matchProtected } from './protected';
import { clip } from './runner';
import type { ApiSpec } from './types';

/**
 * 内置小代理：让只有接口的模型（DeepSeek、MiMo……）也能自己读写文件干活。
 * 它只能通过下面这几个工具碰项目文件夹里的文件；安全档不能跑任意命令，只能跑项目配置的检查命令。
 */

export interface LlmAgentInput {
  spec: ApiSpec;
  cwd: string;
  /** 这一棒的说明 + 接力本全文。 */
  brief: string;
  level: Level;
  gateCommand: string;
  protectedPaths: string[];
  log: (line: string) => void;
  shouldStop: () => boolean;
  /** 截止时间（毫秒时间戳）。 */
  deadline: number;
  maxSteps?: number;
  /** 群聊、投票：只给读的工具，最后说的话就是回答，不用 finish。 */
  readOnly?: boolean;
}

export interface LlmAgentResult {
  finalText: string;
  steps: number;
  stopped: boolean;
  timedOut: boolean;
  error?: string;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.DS_Store']);

/** 多半放着密钥的文件（.env、私钥、各家包管理器的登录信息）：内置代理不读、不搜；.env.example 这类模板照常。 */
const SECRET_FILE = /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(rsa|ed25519|ecdsa|dsa)|[^/]+\.(pem|key|p12|pfx|jks|keystore)|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;
const SECRET_GLOBS = ['.env', '.env.*', '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore', 'credentials', 'credentials.json', 'secret.*', 'secrets.*'];
const NO_SECRET_FILE = '这个文件多半放着密钥（.env、私钥这一类），内置代理不读。要用里面的配置，请人把需要的部分写进任务的约定。';

const SYSTEM = [
  '你是一个在本地代码仓库里干活的编程助手，由「接力台」全自动调度：没有人会回答你的问题，也不用等人确认。',
  '你只能通过提供的工具读写当前项目文件夹里的文件。',
  '做法：',
  '- 先用 list_files / read_file / search 弄清楚现状，再动手；改动要小而准，不要重写无关的内容。',
  '- 改已有文件优先用 edit_file（精确替换一段）；新文件或整体重写用 write_file。',
  '- .relay/ 里只能写：交接（.relay/交接/）、复核结论（.relay/复核/*.md）、任务清单（.relay/任务.md）；别的不要碰，也不要碰 .git。',
  '- 有检查命令时，改完用 run_check 验证；失败就修到通过。',
  '- 做完后必须调用 finish，summary 写三行：做了什么 / 下一步 / 不确定的地方。',
  '- 说明文字用中文。',
].join('\n');

const TALK_SYSTEM = '你在「接力台」的多 AI 讨论里发言。可以用 list_files / read_file / search 看当前项目文件夹里的文件，不能改任何东西。看够了就直接回答。';
const READ_TOOLS = new Set(['list_files', 'read_file', 'search']);

function tools(level: Level, hasGate: boolean): ToolDef[] {
  const t: ToolDef[] = [
    {
      name: 'list_files',
      description: '列出目录里的文件（递归，相对项目根目录的路径；目录以 / 结尾）。',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '目录，默认 .' } } },
    },
    {
      name: 'read_file',
      description: '读文本文件，带行号。大文件用 offset / limit 分段读。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, offset: { type: 'integer', description: '从第几行开始（1 起）' }, limit: { type: 'integer', description: '最多读几行，默认 400' } },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: '新建或整体覆盖一个文件（目录会自动建）。',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
    {
      name: 'edit_file',
      description: '把文件里的一段原文精确替换成新内容。old_string 必须在文件里恰好出现一次（除非 replace_all=true）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    {
      name: 'search',
      description: '在项目文件里搜正则（git grep），返回 文件:行号:内容。',
      parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: '只搜这个目录 / 文件' } }, required: ['pattern'] },
    },
  ];
  if (hasGate) t.push({ name: 'run_check', description: '跑项目配置的检查命令（测试 / 构建），返回结果。', parameters: { type: 'object', properties: {} } });
  if (level === 'full') {
    t.push({
      name: 'run_command',
      description: '在项目文件夹里执行一条 shell 命令（最多 5 分钟），返回输出。',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    });
  }
  t.push({
    name: 'finish',
    description: '做完了（或确实做不下去了）时调用，结束这一段。',
    parameters: { type: 'object', properties: { summary: { type: 'string', description: '三行：做到哪了 / 下一步 / 没验证的假设' } }, required: ['summary'] },
  });
  return t;
}

class ToolError extends Error {}

/** .relay/ 里 AI 可以写的：交接、复核结论、任务清单。 */
const RELAY_WRITABLE = /^\.relay\/(交接\/[^/]+\.md|复核\/[^/]+\.md|任务\.md)$/;

/** 真实位置：解开链接；macOS 上顺便把大小写换成磁盘上的写法（.GIT → .git）。 */
function realOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  }
}

function inside(root: string, p: string): boolean {
  const r = path.relative(root, p);
  return r === '' || (r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r));
}

/**
 * 把 AI 给的路径落到项目里。只看字符串不够：
 * - 项目里的链接可能指到外面（比如指向家目录），要按真实路径判断——最近一层已经存在的目录的真实位置必须在项目里；
 * - 写文件时目标本身是链接也不行（写进去就改到链接指的地方了）。
 * 返回的 rel 是按真实位置算的（「.Relay/x」在不分大小写的磁盘上就是「.relay/x」）。
 */
function resolveIn(root: string, rel: unknown, forWrite = false): { abs: string; rel: string } {
  if (typeof rel !== 'string' || !rel.trim()) throw new ToolError('缺少 path。');
  const abs = path.resolve(root, rel.trim());
  if (!inside(root, abs)) throw new ToolError('只能访问项目文件夹里面的文件。');
  const realRoot = realOrSelf(root);
  let probe = abs;
  while (!fs.existsSync(probe) && inside(root, path.dirname(probe)) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  const realProbe = realOrSelf(probe);
  if (!inside(realRoot, realProbe)) throw new ToolError('这个路径经过链接指到了项目外面，不能访问。');
  if (forWrite) {
    try {
      if (fs.lstatSync(abs).isSymbolicLink()) throw new ToolError('这个文件是个链接，不能通过它写文件（会改到链接指的地方）。');
    } catch (e) {
      if (e instanceof ToolError) throw e;
      /* 还不存在：新建 */
    }
  }
  // 真实位置 + 还不存在的那几层，算出相对项目的路径（磁盘不分大小写时，大小写以磁盘上已有的为准）。
  const rest = path.relative(probe, abs);
  const realRel = path.relative(realRoot, path.join(realProbe, rest));
  return { abs, rel: realRel.split(path.sep).join('/') || '.' };
}

/** 比较规则用：统一成小写、Unicode 规范化（macOS 默认的磁盘不分大小写，.GIT 就是 .git）。 */
function fold(p: string): string {
  return p.normalize('NFC').toLowerCase();
}

function assertWritable(rel: string, protectedPaths: string[]): void {
  const low = fold(rel);
  if (low === '.git' || low.startsWith('.git/')) throw new ToolError('不能改 .git。');
  if ((low === '.relay' || low.startsWith('.relay/')) && !RELAY_WRITABLE.test(`.relay${rel.slice(6).normalize('NFC')}`)) {
    throw new ToolError('.relay/ 里只能写交接（.relay/交接/）、复核结论（.relay/复核/ 里的 .md）和任务清单（.relay/任务.md）。');
  }
  if (matchProtected([rel, low], [...protectedPaths, ...protectedPaths.map(fold)]).length) throw new ToolError(`${rel} 是不许改的文件。`);
}

function listFiles(root: string, relDir: string): string {
  const { abs } = resolveIn(root, relDir || '.');
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= 400 || depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= 400) return;
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const r = path.relative(root, full).split(path.sep).join('/');
      if (r === '.relay/snapshots' || r === '.relay/runs') continue;
      if (e.isDirectory()) {
        out.push(`${r}/`);
        walk(full, depth + 1);
      } else out.push(r);
    }
  };
  walk(abs, 0);
  return out.length ? out.join('\n') + (out.length >= 400 ? '\n…（太多了，只列前 400 个）' : '') : '（空）';
}

function readFile(root: string, args: Record<string, unknown>): string {
  const { abs, rel } = resolveIn(root, args.path);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new ToolError(`没有这个文件：${rel}`);
  if (SECRET_FILE.test(rel)) throw new ToolError(NO_SECRET_FILE);
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) return `${rel} 是二进制文件（${buf.length} 字节）。`;
  const lines = buf.toString('utf8').split('\n');
  const offset = Math.max(1, Number(args.offset) || 1);
  const limit = Math.min(2000, Math.max(1, Number(args.limit) || 400));
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const body = slice.map((l, i) => `${String(offset + i).padStart(5)}  ${l.length > 2000 ? `${l.slice(0, 2000)}…` : l}`).join('\n');
  const more = offset - 1 + limit < lines.length ? `\n…（共 ${lines.length} 行，后面还有；用 offset=${offset + limit} 接着读）` : '';
  return body + more;
}

/** 读给模型的内容里，密钥换成了这个。 */
const REDACTED = '[REDACTED]';
const KEEP_SECRET = `内容里有 ${REDACTED}：那是读给你看时抹掉的密钥，原文不能这样写回去。用 edit_file 只改别的行，带密钥的行不要动。`;

function writeFile(root: string, args: Record<string, unknown>, protectedPaths: string[]): string {
  const { abs, rel } = resolveIn(root, args.path, true);
  assertWritable(rel, protectedPaths);
  if (typeof args.content !== 'string') throw new ToolError('缺少 content。');
  if (args.content.includes(REDACTED) && fs.existsSync(abs) && !fs.readFileSync(abs, 'utf8').includes(REDACTED)) throw new ToolError(KEEP_SECRET);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const existed = fs.existsSync(abs);
  fs.writeFileSync(abs, args.content);
  return `${existed ? '覆盖了' : '新建了'} ${rel}（${args.content.split('\n').length} 行）。`;
}

function editFile(root: string, args: Record<string, unknown>, protectedPaths: string[]): string {
  const { abs, rel } = resolveIn(root, args.path, true);
  assertWritable(rel, protectedPaths);
  if (!fs.existsSync(abs)) throw new ToolError(`没有这个文件：${rel}（新文件用 write_file）`);
  const oldS = args.old_string;
  const newS = args.new_string;
  if (typeof oldS !== 'string' || !oldS) throw new ToolError('缺少 old_string。');
  if (typeof newS !== 'string') throw new ToolError('缺少 new_string。');
  if (newS.includes(REDACTED) && !oldS.includes(REDACTED)) throw new ToolError(KEEP_SECRET);
  const text = fs.readFileSync(abs, 'utf8');
  const count = text.split(oldS).length - 1;
  if (count === 0) throw new ToolError(oldS.includes(REDACTED) ? KEEP_SECRET : '文件里找不到 old_string（要和原文一字不差，包括空格和换行）。先 read_file 看准再改。');
  if (count > 1 && args.replace_all !== true) throw new ToolError(`old_string 出现了 ${count} 次。多带几行上下文让它唯一，或者 replace_all=true。`);
  fs.writeFileSync(abs, args.replace_all === true ? text.split(oldS).join(newS) : text.replace(oldS, () => newS));
  return `改好了 ${rel}${count > 1 ? `（替换了 ${count} 处）` : ''}。`;
}

function search(root: string, args: Record<string, unknown>): string {
  if (typeof args.pattern !== 'string' || !args.pattern) throw new ToolError('缺少 pattern。');
  const where = typeof args.path === 'string' && args.path.trim() ? resolveIn(root, args.path).rel : '.';
  // 项目不是 git 仓库也要能搜：用 --no-index（照样认 .gitignore），大目录手动跳过。
  const inRepo = git(root, ['rev-parse', '--is-inside-work-tree']).stdout === 'true';
  const mode = inRepo ? ['--untracked'] : ['--no-index', '--exclude-standard'];
  const skip = inRepo ? [] : [...SKIP_DIRS].map((d) => `:(exclude,glob)**/${d}/**`);
  const secrets = SECRET_GLOBS.map((g) => `:(exclude,glob)**/${g}`);
  const r = git(root, ['grep', '-n', '-I', '-E', ...mode, '--no-color', '-e', args.pattern, '--', where, ':(exclude).relay', ...skip, ...secrets]);
  if (r.code === 1) return '（没找到）';
  if (r.code !== 0) throw new ToolError(`搜索出错：${r.stderr || r.code}`);
  const lines = r.stdout.split('\n');
  return lines.slice(0, 200).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l)).join('\n') + (lines.length > 200 ? `\n…（共 ${lines.length} 条，只列前 200）` : '');
}

function shell(root: string, cmd: string, timeoutMs: number, shouldStop: () => boolean, env = agentEnv()): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (c: string) => {
      out = (out + c).slice(-12_000);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* 已结束 */
      }
    };
    const timer = setTimeout(kill, timeoutMs);
    const poll = setInterval(() => shouldStop() && kill(), 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      clearInterval(poll);
      resolve(`起不来：${e.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      resolve(`退出码 ${code}\n${out.trim() || '（没有输出）'}`);
    });
  });
}

export async function runLlmAgent(input: LlmAgentInput): Promise<LlmAgentResult> {
  const root = input.cwd;
  const hasGate = !!input.gateCommand.trim();
  const ro = !!input.readOnly;
  const chat = new ToolChat(input.spec, ro ? TALK_SYSTEM : SYSTEM, tools(input.level, hasGate).filter((t) => !ro || READ_TOOLS.has(t.name)));
  chat.user(redactSecrets(ro ? input.brief : `${input.brief}\n\n---\n现在开始工作。记住：做完调用 finish。`));
  const maxSteps = input.maxSteps ?? 60;
  let finalText = '';
  let steps = 0;
  let finished = false;

  const exec = async (c: ToolCall): Promise<string> => {
    if (c.badArgs !== undefined) throw new ToolError(`参数不是合法的 JSON：${c.badArgs}`);
    if (ro && !READ_TOOLS.has(c.name)) throw new ToolError('这里只能看文件，不能改。');
    switch (c.name) {
      case 'list_files':
        return listFiles(root, typeof c.args.path === 'string' ? c.args.path : '.');
      case 'read_file':
        return readFile(root, c.args);
      case 'write_file':
        return writeFile(root, c.args, input.protectedPaths);
      case 'edit_file':
        return editFile(root, c.args, input.protectedPaths);
      case 'search':
        return search(root, c.args);
      case 'run_check':
        if (!hasGate) throw new ToolError('这个项目没有配置检查命令。');
        return shell(root, input.gateCommand, 10 * 60_000, input.shouldStop, checkEnv());
      case 'run_command':
        if (input.level !== 'full') throw new ToolError('安全档不能执行任意命令。');
        if (typeof c.args.command !== 'string' || !c.args.command.trim()) throw new ToolError('缺少 command。');
        return shell(root, c.args.command, 5 * 60_000, input.shouldStop);
      default:
        throw new ToolError(`没有这个工具：${c.name}`);
    }
  };

  try {
    while (steps < maxSteps) {
      if (input.shouldStop()) return { finalText, steps, stopped: true, timedOut: false };
      const left = input.deadline - Date.now();
      if (left <= 0) return { finalText, steps, stopped: false, timedOut: true };
      steps++;
      const r = await chat.next(Math.min(180_000, Math.max(10_000, left)));
      if (r.text.trim()) {
        finalText = r.text;
        input.log(`说：${clip(r.text)}`);
      }
      if (!r.calls.length) break;
      const results: { id: string; content: string }[] = [];
      for (const c of r.calls) {
        if (c.name === 'finish') {
          finished = true;
          finalText = typeof c.args.summary === 'string' && c.args.summary.trim() ? c.args.summary : finalText;
          results.push({ id: c.id, content: '好的，这一段结束。' });
          input.log('结束：它说做完了。');
          continue;
        }
        input.log(`工具 ${c.name}：${clip(String(c.args.path ?? c.args.command ?? c.args.pattern ?? ''), 160)}`);
        let content: string;
        try {
          content = await exec(c);
        } catch (e) {
          content = `出错：${errorMessage(e)}`;
          input.log(`工具出错：${clip(errorMessage(e), 200)}`);
        }
        // 读到的文件、命令输出都要发给模型：密钥先抹掉。
        content = redactSecrets(content);
        results.push({ id: c.id, content: content.length > 12_000 ? `${content.slice(0, 12_000)}\n…（太长，截断了）` : content });
      }
      chat.results(results);
      if (finished) break;
      if (chat.size() > 400_000) {
        const n = chat.prune(250_000);
        if (n) input.log(`对话太长，丢掉了最早的 ${n} 轮。`);
      }
    }
    if (!finished && steps >= maxSteps) input.log(`到了 ${maxSteps} 步上限，停下。`);
  } catch (e) {
    return { finalText, steps, stopped: false, timedOut: false, error: errorMessage(e) };
  } finally {
    // 和编程工具日志里的用量同一个说法（runner.ts 的 usageLine）
    if (chat.used.input || chat.used.output) input.log(`本轮用了 ${chat.used.input} 输入 / ${chat.used.output} 输出 token`);
  }
  return { finalText, steps, stopped: false, timedOut: false };
}
