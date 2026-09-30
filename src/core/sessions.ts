import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayError } from './errors';

/**
 * 各家工具自己记的对话（只读）：
 * - 接力台派出去的每一棒记下它在工具里的对话编号（账本里 stint.session），网页能看整段对话、回到原工具接着说；
 * - 接进接力台的项目文件夹里，你自己在工具里开的对话也列出来（只列这个文件夹的，别的文件夹一律不读）。
 * 只在网页要看的时候读，不另存、不外发。现在读得懂的是 Claude Code（~/.claude/projects）和 Codex（~/.codex/sessions）；
 * 别家的对话存法不公开（Cursor 是数据库），接力台派出去的那几棒看接力台自己的日志。
 */

export type SessionTool = 'claude' | 'codex';

export interface SessionInfo {
  tool: SessionTool;
  id: string;
  /** 第一句问话（或工具自己起的标题）。 */
  title: string;
  /** 最后一次写入的时间。 */
  at: string;
  /** 从哪儿开的：claude-desktop / cli / vscode（Codex 桌面版）……接力台派的是 sdk-cli / exec，不列。 */
  entry?: string;
}

export interface SessionMessage {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  at?: string;
}

const ID = /^[A-Za-z0-9][\w-]{5,80}$/;
/** 一份记录最多读多少：大的对话记录能有几百 MB，看的时候只读最后这一截。 */
const TAIL = 8 * 1024 * 1024;
const HEAD = 256 * 1024;
/**
 * 回到原工具接着这段对话：Claude Code 的用桌面版打开（和终端里的 /desktop 一样的链接）；
 * 别的给一条在项目文件夹里接着说的命令。不认得的工具是 null。
 */
export function resumeHow(harness: string, id: string, root: string): { url: string } | { command: string } | null {
  if (!ID.test(id)) return null;
  const cd = `cd ${JSON.stringify(root)} && `;
  if (harness === 'claude' || harness === 'claude-official') return { url: `claude://resume?session=${id}` };
  if (harness === 'codex') return { command: `${cd}codex resume ${id}` };
  if (harness === 'cursor-agent') return { command: `${cd}cursor-agent --resume ${id}` };
  if (harness === 'agy') return { command: `${cd}agy --conversation ${id}` };
  return null;
}

/** 这个工具算哪一家的记录。 */
export function sessionToolOf(harness: string | undefined): SessionTool | null {
  if (harness === 'claude' || harness === 'claude-official') return 'claude';
  if (harness === 'codex') return 'codex';
  return null;
}

const home = () => os.homedir();
const claudeRoot = () => path.join(home(), '.claude', 'projects');
const codexRoot = () => path.join(home(), '.codex', 'sessions');

/** Claude Code 放一个文件夹的记录的地方：路径里不是字母数字的都换成 -（/Users/me/K线阅读 → -Users-me-K---）。 */
export function claudeDirOf(root: string): string {
  return path.join(claudeRoot(), root.replace(/[^A-Za-z0-9]/g, '-'));
}

/** 同一个文件夹的两种写法（/var 和 /private/var 这种经过链接的）各放一处：都看。 */
function claudeDirs(root: string): string[] {
  let real = root;
  try {
    real = fs.realpathSync.native(root);
  } catch {
    /* 文件夹没了 */
  }
  return [...new Set([claudeDirOf(root), claudeDirOf(real)])];
}

function readSlice(file: string, from: 'head' | 'tail', max: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from === 'head' ? 0 : size - len);
    const text = buf.toString('utf8');
    // 截在一行中间的那一行不要
    if (from === 'tail' && size > len) return text.slice(text.indexOf('\n') + 1);
    if (from === 'head' && size > len) return text.slice(0, text.lastIndexOf('\n'));
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : '');
function lines(text: string): J[] {
  const out: J[] = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try {
      out.push(o(JSON.parse(l)));
    } catch {
      /* 写到一半的行 */
    }
  }
  return out;
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);
const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim();

/** 工具自己塞进对话里的话（命令、提醒、环境说明），不算人说的。 */
const NOT_SAID = /^\s*<(command-|local-command|system-reminder|environment_context|user_instructions|permissions|user_shell_command)|^\s*# AGENTS\.md|^\s*Caveat:/;

function toolLine(name: string, input: unknown): string {
  const i = o(input);
  for (const k of ['file_path', 'path', 'command', 'cmd', 'pattern', 'query', 'url', 'description']) {
    const v = i[k];
    if (typeof v === 'string' && v.trim()) return `${name}：${clip(oneLine(v), 160)}`;
    if (Array.isArray(v) && v.length) return `${name}：${clip(oneLine(v.map(String).join(' ')), 160)}`;
  }
  return name;
}

// ---- Claude Code ----

function claudeMessages(entries: J[]): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const e of entries) {
    if (e.isMeta || e.isSidechain) continue;
    const at = str(e.timestamp) || undefined;
    const msg = o(e.message);
    if (e.type === 'user') {
      const c = msg.content;
      if (typeof c === 'string') {
        if (c.trim() && !NOT_SAID.test(c)) out.push({ role: 'user', text: c, at });
        continue;
      }
      for (const b of Array.isArray(c) ? c : []) {
        const blk = o(b);
        if (blk.type === 'text' && str(blk.text).trim() && !NOT_SAID.test(str(blk.text))) out.push({ role: 'user', text: str(blk.text), at });
      }
    } else if (e.type === 'assistant') {
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        const blk = o(b);
        if (blk.type === 'text' && str(blk.text).trim()) out.push({ role: 'assistant', text: str(blk.text), at });
        else if (blk.type === 'tool_use') out.push({ role: 'tool', text: toolLine(str(blk.name), blk.input), at });
      }
    }
  }
  return out;
}

function claudeInfo(file: string): (SessionInfo & { cwd?: string }) | null {
  const entries = lines(readSlice(file, 'head', HEAD));
  let cwd: string | undefined;
  let entry: string | undefined;
  for (const e of entries) {
    cwd ??= str(e.cwd) || undefined;
    entry ??= str(e.entrypoint) || undefined;
  }
  // 标题：你改过的名字 > 工具自己起的 > 第一句问话（标题一路在记，读最后一截里最新的）
  const late = [...entries, ...lines(readSlice(file, 'tail', 64 * 1024))];
  const last = (type: string, key: string) => str([...late].reverse().find((e) => e.type === type)?.[key]);
  const title = last('custom-title', 'customTitle') || last('ai-title', 'aiTitle') || last('summary', 'summary') || (claudeMessages(entries).find((m) => m.role === 'user')?.text ?? '');
  if (!cwd && !title) return null;
  return { tool: 'claude', id: path.basename(file, '.jsonl'), title: clip(oneLine(title), 80), at: fs.statSync(file).mtime.toISOString(), ...(entry ? { entry } : {}), ...(cwd ? { cwd } : {}) };
}

// ---- Codex ----

function codexFiles(sinceMs: number): string[] {
  const out: string[] = [];
  const dig = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(dir, n);
      if (depth < 3) dig(p, depth + 1);
      else if (n.startsWith('rollout-') && n.endsWith('.jsonl')) {
        try {
          if (fs.statSync(p).mtimeMs >= sinceMs) out.push(p);
        } catch {
          /* 刚被挪走 */
        }
      }
    }
  };
  dig(codexRoot(), 0);
  return out;
}

/** 行首被转义的列表记号（「1\.」「2\)」「\- 」「\* 」「\+ 」「\# 」「\> 」）还原；别处的反斜杠不动。 */
export function unescapeListMarks(text: string): string {
  return text.replace(/^(\s*\d+)\\([.)])/gm, '$1$2').replace(/^(\s*)\\([-+*#>])/gm, '$1$2');
}

function codexMessages(entries: J[]): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const e of entries) {
    if (e.type !== 'response_item') continue;
    const p = o(e.payload);
    const at = str(e.timestamp) || undefined;
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const joined = (Array.isArray(p.content) ? p.content : []).map((c) => str(o(c).text)).join('\n');
      // Codex 桌面版把人写的行首「1.」「- 」存成「1\.」「\- 」（不让它变成列表），读回来去掉这道转义
      // Codex 回答末尾带的记忆出处（<oai-mem-citation>…</oai-mem-citation>）是给它自己看的，不算说的话
      const text = p.role === 'user' ? unescapeListMarks(joined) : joined.replace(/<oai-mem-citation>[\s\S]*?(<\/oai-mem-citation>|$)/g, '').trimEnd();
      if (text.trim() && !NOT_SAID.test(text)) out.push({ role: p.role, text, at });
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      let args: unknown = p.arguments ?? p.input ?? o(p.action).command;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = { command: args };
        }
      }
      out.push({ role: 'tool', text: toolLine(str(p.name) || 'shell', Array.isArray(args) ? { command: args } : args), at });
    }
  }
  return out;
}

function codexMeta(file: string): { id: string; cwd: string; source: string } | null {
  const first = lines(readSlice(file, 'head', 64 * 1024))[0];
  const p = o(first?.payload);
  if (first?.type !== 'session_meta' || !str(p.id)) return null;
  // 子代理的来源是一个对象（{ subagent: … }），不是字符串
  return { id: str(p.id), cwd: str(p.cwd), source: typeof p.source === 'string' ? p.source : 'subagent' };
}

function codexInfo(file: string): (SessionInfo & { cwd: string }) | null {
  const meta = codexMeta(file);
  if (!meta) return null;
  const title = codexMessages(lines(readSlice(file, 'head', HEAD))).find((m) => m.role === 'user')?.text ?? '';
  return { tool: 'codex', id: meta.id, title: clip(oneLine(title), 80), at: fs.statSync(file).mtime.toISOString(), entry: meta.source, cwd: meta.cwd };
}

// ---- 对外 ----

const same = (a: string, b: string) => {
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
};

/** 这个对话的记录文件（只认在这个项目文件夹里开的）。找不到是 null。 */
export function sessionFile(root: string, tool: SessionTool, id: string): string | null {
  if (!ID.test(id)) return null;
  if (tool === 'claude') return claudeDirs(root).map((d) => path.join(d, `${id}.jsonl`)).find((f) => fs.existsSync(f)) ?? null;
  // Codex 的文件名末尾是编号；按修改时间从新到旧找
  const hit = codexFiles(0)
    .filter((f) => f.endsWith(`-${id}.jsonl`))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!hit) return null;
  const meta = codexMeta(hit);
  return meta && same(meta.cwd, root) ? hit : null;
}

/**
 * 这个项目文件夹里、你自己在工具里开的对话（接力台派的不列：它们挂在每一棒上）。新的在前，最多 limit 条。
 * Claude Code 按文件夹放，只读这个文件夹的；Codex 按日期放，只看最近 60 天里在这个文件夹开的。
 */
export function projectSessions(root: string, limit = 30): SessionInfo[] {
  const out: SessionInfo[] = [];
  const files: string[] = [];
  for (const dir of claudeDirs(root)) {
    try {
      for (const n of fs.readdirSync(dir)) if (n.endsWith('.jsonl')) files.push(path.join(dir, n));
    } catch {
      /* 这个文件夹没用过 Claude Code */
    }
  }
  for (const f of files) {
    const i = claudeInfo(f);
    if (!i || i.entry === 'sdk-cli' || (i.cwd && !same(i.cwd, root))) continue;
    const { cwd: _cwd, ...info } = i;
    out.push(info);
  }
  for (const f of codexFiles(Date.now() - 60 * 86_400_000)) {
    const i = codexInfo(f);
    if (!i || i.entry === 'exec' || i.entry === 'subagent' || !same(i.cwd, root)) continue;
    const { cwd: _cwd, ...info } = i;
    out.push(info);
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** 读一段对话：最后一截里的人说的话、AI 的回答、用了什么工具。只认这个项目文件夹里的。 */
export function readSession(root: string, tool: SessionTool, id: string): { info: SessionInfo; messages: SessionMessage[]; cut: boolean } {
  const file = sessionFile(root, tool, id);
  if (!file) throw new RelayError('这段对话在这个项目文件夹里找不到了', 'no-session');
  const size = fs.statSync(file).size;
  const entries = lines(readSlice(file, 'tail', TAIL));
  const info = tool === 'claude' ? claudeInfo(file) : codexInfo(file);
  if (!info) throw new RelayError('这段对话读不出来', 'no-session');
  const { cwd: _cwd, ...rest } = info;
  const all = tool === 'claude' ? claudeMessages(entries) : codexMessages(entries);
  const messages = all.slice(-400).map((m) => ({ ...m, text: clip(m.text, 6000) }));
  return { info: rest, messages, cut: size > TAIL || all.length > 400 };
}
