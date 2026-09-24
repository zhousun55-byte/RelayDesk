import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Claude Code 自己的会话记录（~/.claude/projects/<文件夹>/<会话>.jsonl）：每条回复都记着实际用的模型和时间。
 * 同一个 claude 命令可能是官方账号（Opus），也可能被接到了 DeepSeek 这类别家模型，交接里自称的不一定对，
 * 接力台就拿这份记录核对：交接、复核结论是哪个模型写的，这段时间在项目里改文件的是哪个模型。
 * 只读模型名、时间、入口和改了哪个文件的路径；对话内容不读、不存、不外发。
 */

export interface ClaudeWork {
  model: string;
  /** 从哪儿用的：claude-desktop（桌面版）/ cli（终端）/ sdk-cli（被程序调用）。 */
  entry?: string;
  /** 这段时间里它在这个项目里改文件的回复条数。 */
  count: number;
  first: string;
  last: string;
}

export interface ClaudeWrite {
  model: string;
  entry?: string;
  at: string;
}

/** 算「改过东西」的工具（只读的群聊、跑命令看看都不算）。 */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** 每个会话最多往回读多少（记录是按时间追加的，读到比起点还早就停）。 */
const MAX_BYTES_PER_FILE = 16 * 1024 * 1024;
const MAX_FILES = 30;
const CHUNK = 1024 * 1024;
/** 时间比对留的余量（写文件和记日志差几秒）。 */
const SLACK = 60_000;

function projectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** 某个时间之后改过的会话记录（新的在前）。 */
function recentLogs(sinceMs: number): string[] {
  const dir = projectsDir();
  const out: { file: string; mtime: number }[] = [];
  let subs: fs.Dirent[];
  try {
    subs = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const d of subs) {
    if (!d.isDirectory()) continue;
    const sub = path.join(dir, d.name);
    let files: string[];
    try {
      files = fs.readdirSync(sub);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(sub, f);
      try {
        const mtime = fs.statSync(file).mtimeMs;
        if (mtime >= sinceMs) out.push({ file, mtime });
      } catch {
        /* 刚被删掉 */
      }
    }
  }
  return out
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_FILES)
    .map((x) => x.file);
}

/** 从文件末尾往前一行一行地读（新的在前）；visit 返回 false 就停。 */
function eachLineFromEnd(file: string, visit: (line: string) => boolean): void {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return;
  }
  try {
    let pos = fs.fstatSync(fd).size;
    const stopAt = Math.max(0, pos - MAX_BYTES_PER_FILE);
    // 按字节找换行（换行符不会出现在中文的多字节编码里），切开的半行留到下一轮拼上。
    let carry = Buffer.alloc(0);
    while (pos > stopAt) {
      const len = Math.min(CHUNK, pos - stopAt);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      const data = carry.length ? Buffer.concat([buf, carry]) : buf;
      let end = data.length;
      let nl = data.lastIndexOf(0x0a, end - 1);
      while (nl >= 0) {
        const line = data.subarray(nl + 1, end).toString('utf8');
        if (line && !visit(line)) return;
        end = nl;
        nl = end > 0 ? data.lastIndexOf(0x0a, end - 1) : -1;
      }
      carry = data.subarray(0, end);
    }
    if (pos === 0 && carry.length) visit(carry.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

/** 同一个路径的几种写法（/tmp 和 /private/tmp 这种）。 */
function spellings(p: string): string[] {
  const out = [p];
  try {
    const real = fs.realpathSync(p);
    if (real !== p) out.push(real);
  } catch {
    /* 还不存在 */
  }
  return out;
}

/** 一条改了文件的回复：模型、入口、时间、改了哪些文件（绝对路径）。 */
interface Edit {
  model: string;
  entry?: string;
  at: number;
  paths: string[];
}

/**
 * 从新到旧看 fromMs 之后的记录里、提到 needles（路径）的「主对话回复、用了改文件的工具」，逐条交给 visit。
 * visit 返回 false：这个会话不用再往前看了。
 */
function scanEdits(fromMs: number, needles: string[], visit: (e: Edit) => boolean | void): void {
  for (const file of recentLogs(fromMs - SLACK)) {
    eachLineFromEnd(file, (line) => {
      // 一行里最后一个 timestamp 才是这一条的时间（前面的可能在工具参数里）。
      const ts = [...line.matchAll(/"timestamp":"([^"]+)"/g)].at(-1)?.[1];
      const at = ts ? Date.parse(ts) : NaN;
      if (Number.isFinite(at) && at < fromMs - SLACK) return false;
      if (!Number.isFinite(at) || !line.includes('"assistant"') || !needles.some((n) => line.includes(n))) return true;
      let j: { type?: string; isSidechain?: boolean; entrypoint?: string; message?: { model?: unknown; content?: unknown } };
      try {
        j = JSON.parse(line);
      } catch {
        return true;
      }
      const model = j.message?.model;
      if (j.type !== 'assistant' || j.isSidechain || typeof model !== 'string' || !model || model.startsWith('<')) return true;
      const blocks = Array.isArray(j.message?.content) ? (j.message!.content as { type?: string; name?: string; input?: Record<string, unknown> }[]) : [];
      const paths = blocks
        .filter((b) => b?.type === 'tool_use' && EDIT_TOOLS.has(b.name ?? ''))
        .map((b) => b.input?.file_path ?? b.input?.notebook_path)
        .filter((p): p is string => typeof p === 'string' && path.isAbsolute(p));
      if (!paths.length) return true;
      return visit({ model, ...(j.entrypoint ? { entry: j.entrypoint } : {}), at, paths }) !== false;
    });
  }
}

/** 是项目里的文件、又不是 .relay/ 下的（写交接、打勾不算改项目）。 */
function projectFile(roots: string[], p: string): boolean {
  return roots.some((root) => {
    const r = path.relative(root, p);
    return r !== '' && !r.startsWith('..') && !path.isAbsolute(r) && r !== '.relay' && !r.startsWith(`.relay${path.sep}`);
  });
}

/**
 * 这段时间（from–to）里在 root 里改过文件的 Claude Code，按模型分开（条数多的在前）。
 * 「改过文件」= 这条回复用改文件的工具（Edit / Write …）改了项目里的文件（.relay/ 下的不算）。
 */
export function claudeWorkIn(root: string, fromIso: string, toIso: string): ClaudeWork[] {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
  const roots = spellings(root);
  const byModel = new Map<string, ClaudeWork>();
  scanEdits(from, roots, (e) => {
    if (e.at < from || e.at > to + SLACK || !e.paths.some((p) => projectFile(roots, p))) return;
    const when = new Date(e.at).toISOString();
    const cur = byModel.get(e.model);
    if (cur) {
      cur.count++;
      if (when < cur.first) cur.first = when;
      if (when > cur.last) cur.last = when;
    } else {
      byModel.set(e.model, { model: e.model, ...(e.entry ? { entry: e.entry } : {}), count: 1, first: when, last: when });
    }
  });
  return [...byModel.values()].sort((a, b) => b.count - a.count);
}

/** from–to 之间最后一次用 Claude Code 改这个文件（绝对路径）的是哪个模型；Claude Code 没碰过它返回 null。 */
export function claudeWriterOf(file: string, fromIso: string, toIso: string): ClaudeWrite | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const targets = spellings(file);
  let best: Edit | null = null;
  scanEdits(from, targets, (e) => {
    if (e.at < from - SLACK || e.at > to + SLACK || !e.paths.some((p) => targets.includes(p))) return;
    if (!best || e.at > best.at) best = e;
    return false; // 这个会话里最新的一次已经找到了
  });
  const b = best as Edit | null;
  return b ? { model: b.model, ...(b.entry ? { entry: b.entry } : {}), at: new Date(b.at).toISOString() } : null;
}

/** 最近用官方账号的 Claude Code 回复用的是哪个模型（给名单显示用，比如 claude-opus-5-5）；看不出来返回 undefined。 */
export function recentOfficialModel(family = /^claude-opus-/): string | undefined {
  const since = Date.now() - 30 * 86_400_000;
  for (const file of recentLogs(since).slice(0, 8)) {
    let found: string | undefined;
    let seen = 0;
    eachLineFromEnd(file, (line) => {
      if (++seen > 4000) return false;
      const m = line.match(/"model":"(claude-[^"]+)"/)?.[1];
      if (m && family.test(m) && line.includes('"assistant"')) {
        found = m;
        return false;
      }
      return true;
    });
    if (found) return found;
  }
  return undefined;
}
