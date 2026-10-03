import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { RelayError } from './errors';

/**
 * 各家工具自己记的对话（只读）：
 * - 接力台派出去的每一棒、群聊里每一位的回答记下它在工具里的对话编号，网页能看整段对话、回到原工具接着说；
 * - 接进接力台的项目文件夹里，你自己在工具里开的对话也列出来（只列这个文件夹的，别的文件夹一律不读）。
 * 只在网页要看的时候读，不另存、不外发。读得懂的四家（存法照 mindbus、magpie 读各家记录的做法核实过）：
 * Claude Code（~/.claude/projects）、Codex（~/.codex/sessions）、DeepSeek Harness（~/.dsh/sessions，常压成 zstd）、
 * Cursor 命令行（~/.cursor/chats 记每段对话在哪个文件夹，正文在 ~/.cursor/projects/…/agent-transcripts）。
 * 工具自己塞进去的话（系统提醒、技能清单、环境说明、被打断的标记）不算人说的；子代理、压缩后留下的重复记录不列。
 */

export type SessionTool = 'claude' | 'codex' | 'dsh' | 'cursor-agent';

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
  if (harness === 'codex' || harness === 'dsh' || harness === 'cursor-agent') return harness;
  return null;
}

const home = () => os.homedir();
const envDir = (k: string) => process.env[k]?.trim() || '';
const claudeRoot = () => path.join(envDir('CLAUDE_CONFIG_DIR') || path.join(home(), '.claude'), 'projects');
const codexHome = () => envDir('CODEX_HOME') || path.join(home(), '.codex');
const codexRoot = () => path.join(codexHome(), 'sessions');
const dshRoot = () => path.join(envDir('DSH_HOME') || path.join(home(), '.dsh'), 'sessions');
const cursorConfig = () => envDir('CURSOR_CONFIG_DIR') || path.join(home(), '.cursor');
const cursorData = () => envDir('CURSOR_DATA_DIR') || path.join(home(), '.cursor');

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

/**
 * 工具自己塞进对话里的话（命令、提醒、环境说明、后台任务通知、技能脚手架、被打断的标记），不算人说的。
 * 句式照 mindbus 的 isInjectedUserText，加上 Codex、Cursor 自己的几种。
 */
const NOT_SAID =
  /^\s*<(command-|local-command|system-reminder|environment_context|user_instructions|permissions|user_shell_command|task-notification|turn_aborted|app-context|user_info|rules)|^\s*# AGENTS\.md|^\s*Caveat:|^\s*Base directory for this skill:|^\s*\[Request interrupted by user/;

/** 接力台自己派的活、群聊、投票的开头：列「你自己在工具里开的对话」时不算。 */
const RELAY_PROMPT = /^\s*(?:你是「接力台」派来|你在参加「接力台」里|还是「接力台」里的这场)/;

/**
 * 人说的那句话本身：去掉夹在里面的系统提醒（<system-reminder>…</system-reminder>，没有收尾的照原样留），
 * Cursor 包着的 <user_query> 只取里面，前面的 <timestamp> 不要。剩下空的、整句是工具塞的，返回空。
 */
export function saidText(raw: string): string {
  let t = raw;
  for (let i = t.indexOf('<system-reminder>'); i >= 0; i = t.indexOf('<system-reminder>', i)) {
    const end = t.indexOf('</system-reminder>', i);
    if (end < 0) break;
    t = t.slice(0, i) + t.slice(end + '</system-reminder>'.length);
  }
  const q = t.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  if (q) t = q[1];
  t = t.replace(/^\s*<timestamp>[\s\S]*?<\/timestamp>\s*/, '').trim();
  return t && !NOT_SAID.test(t) ? t : '';
}

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
        const t = saidText(c);
        if (t) out.push({ role: 'user', text: t, at });
        continue;
      }
      for (const b of Array.isArray(c) ? c : []) {
        const blk = o(b);
        const t = blk.type === 'text' ? saidText(str(blk.text)) : '';
        if (t) out.push({ role: 'user', text: t, at });
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
      const text = p.role === 'user' ? saidText(unescapeListMarks(joined)) : joined.replace(/<oai-mem-citation>[\s\S]*?(<\/oai-mem-citation>|$)/g, '').trimEnd();
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

function codexMeta(file: string): { id: string; cwd: string; source: string; thread: string } | null {
  const first = lines(readSlice(file, 'head', 256 * 1024))[0];
  const p = o(first?.payload);
  if (first?.type !== 'session_meta' || !str(p.id)) return null;
  // 子代理的来源是一个对象（{ subagent: … }），不是字符串；带 parent_thread_id 的也是子代理
  const source = typeof p.source === 'string' && !str(p.parent_thread_id) ? p.source : 'subagent';
  // 压缩、分叉会把整段历史抄进一份新文件（编号是新的，forked_from_id 指回原来那段）：归到原来那段，只列最新的一份
  return { id: str(p.id), cwd: str(p.cwd), source, thread: str(p.forked_from_id) || str(p.id) };
}

function codexInfo(file: string): (SessionInfo & { cwd: string; thread: string }) | null {
  const meta = codexMeta(file);
  if (!meta) return null;
  const title = codexMessages(lines(readSlice(file, 'head', HEAD))).find((m) => m.role === 'user')?.text ?? '';
  return { tool: 'codex', id: meta.id, title: clip(oneLine(title), 80), at: fs.statSync(file).mtime.toISOString(), entry: meta.source, cwd: meta.cwd, thread: meta.thread };
}

// ---- DeepSeek Harness ----
// ~/.dsh/sessions/<文件夹编码>/session-<编号>/session(.vN).jsonl(.zstd)：第一行是头（编号、cwd、子代理的 parentSession），
// 之后一行一个事件 {type, seq, time, data}。zstd 是一批一批追加的独立帧，Node 自带的解压只解第一帧，要一帧一帧解。
// user/message 只有 data.source.kind = user 的是人打的字（别的是工具塞的说明、技能清单、运行环境）；session/title 是标题。
// 它没有按编号接着一段对话的命令。

const ZSTD = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 一份 zstd 记录解成文字：按帧头切开一帧帧解；切错了（数据里碰巧有帧头）就和下一段并起来再解。只解最后 max 字节附近的帧。 */
function unzstd(buf: Buffer, max = TAIL): string {
  const unzip = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
  if (!unzip) return '';
  const starts: number[] = [];
  for (let i = buf.indexOf(ZSTD, Math.max(0, buf.length - max)); i >= 0; i = buf.indexOf(ZSTD, i + 1)) starts.push(i);
  let out = '';
  for (let k = 0; k < starts.length; ) {
    let end = k + 1;
    for (;;) {
      try {
        out += unzip(buf.subarray(starts[k], starts[end] ?? buf.length)).toString('utf8');
        break;
      } catch {
        if (end >= starts.length) break;
        end++;
      }
    }
    k = end;
  }
  return out;
}

/** 一个 dsh 对话文件夹里最新格式的那一份（session.v4.jsonl.zstd 比 session.jsonl 新）。 */
function dshFileIn(dir: string): string | null {
  let best: { f: string; v: number } | null = null;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const n of names) {
    const m = n.match(/^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/);
    if (m && (!best || Number(m[1] ?? 1) > best.v)) best = { f: path.join(dir, n), v: Number(m[1] ?? 1) };
  }
  return best?.f ?? null;
}

function dshText(file: string, from: 'head' | 'tail'): string {
  if (!file.endsWith('.zstd')) return readSlice(file, from, from === 'head' ? HEAD : TAIL);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return '';
  }
  if (from === 'head') {
    const second = buf.indexOf(ZSTD, 4);
    const unzip = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
    try {
      return unzip ? unzip(buf.subarray(0, second > 0 ? second : buf.length)).toString('utf8') : '';
    } catch {
      return unzstd(buf, buf.length).slice(0, HEAD);
    }
  }
  return unzstd(buf);
}

/** 所有 dsh 对话文件夹（每个里最新的那份）。 */
function dshFiles(): string[] {
  const out: string[] = [];
  let cwds: string[] = [];
  try {
    cwds = fs.readdirSync(dshRoot());
  } catch {
    return out;
  }
  for (const c of cwds) {
    let ss: string[] = [];
    try {
      ss = fs.readdirSync(path.join(dshRoot(), c));
    } catch {
      continue;
    }
    for (const sdir of ss) {
      if (!sdir.startsWith('session-')) continue;
      const f = dshFileIn(path.join(dshRoot(), c, sdir));
      if (f) out.push(f);
    }
  }
  return out;
}

function dshHead(file: string): { id: string; cwd: string; sub: boolean } | null {
  const first = lines(dshText(file, 'head'))[0];
  if (first?.type !== 'session' || !str(first.id)) return null;
  return { id: str(first.id), cwd: str(first.cwd), sub: !!str(first.parentSession) || Number(first.delegationDepth ?? 0) > 0 };
}

function dshMessages(entries: J[]): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const e of entries) {
    const d = o(e.data);
    const at = typeof e.time === 'number' ? new Date(e.time).toISOString() : str(e.time) || undefined;
    if (e.type === 'user/message') {
      if (o(d.source).kind !== 'user') continue;
      const t = saidText((Array.isArray(d.content) ? d.content : []).map((c) => str(o(c).text)).join('\n'));
      if (t) out.push({ role: 'user', text: t, at });
    } else if (e.type === 'assistant/message') {
      for (const b of Array.isArray(o(d.message).content) ? (o(d.message).content as unknown[]) : []) {
        const blk = o(b);
        if (blk.type === 'text' && str(blk.text).trim()) out.push({ role: 'assistant', text: str(blk.text), at });
        else if (blk.type === 'tool-call') {
          let args: unknown = blk.arguments;
          try {
            args = typeof args === 'string' ? JSON.parse(args) : args;
          } catch {
            /* 不是 JSON：原样 */
          }
          out.push({ role: 'tool', text: toolLine(str(blk.name), args), at });
        }
      }
    }
  }
  return out;
}

function dshInfo(file: string): (SessionInfo & { cwd: string; sub: boolean; firstSaid: string }) | null {
  const head = dshHead(file);
  if (!head) return null;
  const all = lines(dshText(file, 'tail'));
  const title = str(o([...all].reverse().find((e) => e.type === 'session/title')?.data).title);
  const first = dshMessages(lines(dshText(file, 'head'))).find((m) => m.role === 'user')?.text ?? dshMessages(all).find((m) => m.role === 'user')?.text ?? '';
  return { tool: 'dsh', id: head.id, title: clip(oneLine(title || first), 80), at: fs.statSync(file).mtime.toISOString(), cwd: head.cwd, sub: head.sub, firstSaid: first };
}

// ---- Cursor 命令行（cursor-agent） ----
// ~/.cursor/chats/<md5(文件夹)>/<编号>/meta.json 写着在哪个文件夹开的、什么时候、是不是子代理；正文是它另写的文字记录：
// ~/.cursor/projects/<文件夹路径非字母数字换成 ->/agent-transcripts/<编号>/<编号>.jsonl（老版本是 <编号>.jsonl）。
// 每行 {role, message: {content: [{type: text | tool_use, …}]}}；人打的字包在 <user_query> 里。cursor-agent --resume 编号 接着说。

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');

function cursorChatDirs(root: string): string[] {
  const out: string[] = [];
  for (const r of new Set([root, realOf(root)])) {
    const dir = path.join(cursorConfig(), 'chats', md5(r));
    try {
      for (const id of fs.readdirSync(dir)) out.push(path.join(dir, id));
    } catch {
      /* 这个文件夹没用过 Cursor 命令行 */
    }
  }
  return out;
}

function cursorMeta(chatDir: string): { id: string; cwd: string; title: string; at: string; sub: boolean } | null {
  try {
    const m = o(JSON.parse(fs.readFileSync(path.join(chatDir, 'meta.json'), 'utf8')));
    if (m.hasConversation === false) return null;
    const at = typeof m.updatedAtMs === 'number' ? new Date(m.updatedAtMs).toISOString() : fs.statSync(chatDir).mtime.toISOString();
    return { id: path.basename(chatDir), cwd: str(m.cwd), title: str(m.title), at, sub: m.isSubagent === true };
  } catch {
    return null;
  }
}

function cursorTranscript(cwd: string, id: string): string | null {
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || !ID.test(id)) return null;
  const dir = path.join(cursorData(), 'projects', slug, 'agent-transcripts');
  return [path.join(dir, id, `${id}.jsonl`), path.join(dir, `${id}.jsonl`)].find((f) => fs.existsSync(f)) ?? null;
}

function cursorMessages(entries: J[]): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const e of entries) {
    const role = e.role;
    if (role !== 'user' && role !== 'assistant') continue;
    for (const b of Array.isArray(o(e.message).content) ? (o(e.message).content as unknown[]) : []) {
      const blk = o(b);
      if (blk.type === 'text') {
        const t = role === 'user' ? saidText(str(blk.text)) : str(blk.text).replace(/\n*\[REDACTED\]\s*$/, '').trim();
        if (t) out.push({ role, text: t });
      } else if (blk.type === 'tool_use' && role === 'assistant') out.push({ role: 'tool', text: toolLine(str(blk.name), blk.input) });
    }
  }
  return out;
}

const realOf = (p: string) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

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

/** Codex 归档了的对话（~/.codex/archived_sessions，平铺）：棒上记着的编号在 sessions 里找不到时到这里找。 */
function codexArchived(id: string): string[] {
  const dir = path.join(codexHome(), 'archived_sessions');
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith(`-${id}.jsonl`)).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** 这个对话的记录文件（只认在这个项目文件夹里开的）。找不到是 null。 */
export function sessionFile(root: string, tool: SessionTool, id: string): string | null {
  if (!ID.test(id)) return null;
  if (tool === 'claude') return claudeDirs(root).map((d) => path.join(d, `${id}.jsonl`)).find((f) => fs.existsSync(f)) ?? null;
  if (tool === 'dsh') {
    // 编号就是它的文件夹名（session-…）；文件夹按 cwd 分，直接找，再核对头里的 cwd
    for (const f of dshFiles()) if (path.basename(path.dirname(f)) === id) return same(dshHead(f)?.cwd ?? '', root) ? f : null;
    return null;
  }
  if (tool === 'cursor-agent') {
    const dir = cursorChatDirs(root).find((d) => path.basename(d) === id);
    const meta = dir ? cursorMeta(dir) : null;
    return meta && same(meta.cwd || root, root) ? cursorTranscript(meta.cwd || root, id) : null;
  }
  // Codex 的文件名末尾是编号；按修改时间从新到旧找（压缩、分叉后同一段对话可能有几份，最新的最全）
  const hit = [...codexFiles(0).filter((f) => f.endsWith(`-${id}.jsonl`)), ...codexArchived(id)].sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!hit) return null;
  const meta = codexMeta(hit);
  return meta && same(meta.cwd, root) ? hit : null;
}

/**
 * 这个项目文件夹里、你自己在工具里开的对话（接力台派的、群聊里的不列：它们挂在每一棒、每条回答上）。新的在前，最多 limit 条。
 * Claude Code、Cursor 按文件夹放，只读这个文件夹的；Codex 按日期放，只看最近 60 天里在这个文件夹开的；
 * DeepSeek Harness 每段对话的头里写着文件夹，对上了才算。子代理的、压缩后抄出来的重复记录不列。
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
  // Codex：同一段对话（分叉、压缩出来的几份）只列最新的一份
  const threads = new Map<string, SessionInfo>();
  for (const f of codexFiles(Date.now() - 60 * 86_400_000)) {
    const i = codexInfo(f);
    if (!i || i.entry === 'exec' || i.entry === 'subagent' || !same(i.cwd, root)) continue;
    const { cwd: _cwd, thread, ...info } = i;
    const had = threads.get(thread);
    if (!had || had.at < info.at) threads.set(thread, info);
  }
  out.push(...threads.values());
  for (const f of dshFiles()) {
    const i = dshInfo(f);
    if (!i || i.sub || !same(i.cwd, root) || RELAY_PROMPT.test(i.firstSaid)) continue;
    const { cwd: _cwd, sub: _sub, firstSaid: _f, ...info } = i;
    out.push(info);
  }
  for (const dir of cursorChatDirs(root)) {
    const m = cursorMeta(dir);
    if (!m || m.sub) continue;
    const t = cursorTranscript(m.cwd || root, m.id);
    if (!t) continue;
    const first = cursorMessages(lines(readSlice(t, 'head', HEAD))).find((x) => x.role === 'user')?.text ?? '';
    if (RELAY_PROMPT.test(first)) continue;
    out.push({ tool: 'cursor-agent', id: m.id, title: clip(oneLine(m.title || first), 80), at: m.at });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** 读一段对话：最后一截里的人说的话、AI 的回答、用了什么工具。只认这个项目文件夹里的。 */
export function readSession(root: string, tool: SessionTool, id: string): { info: SessionInfo; messages: SessionMessage[]; cut: boolean } {
  const file = sessionFile(root, tool, id);
  if (!file) throw new RelayError('这段对话在这个项目文件夹里找不到了', 'no-session');
  const size = fs.statSync(file).size;
  let info: SessionInfo | null;
  let all: SessionMessage[];
  if (tool === 'dsh') {
    const i = dshInfo(file);
    info = i ? { tool: i.tool, id: i.id, title: i.title, at: i.at } : null;
    all = dshMessages(lines(dshText(file, 'tail')));
  } else if (tool === 'cursor-agent') {
    const m = cursorChatDirs(root).map(cursorMeta).find((x) => x?.id === id) ?? null;
    all = cursorMessages(lines(readSlice(file, 'tail', TAIL)));
    info = m ? { tool, id, title: clip(oneLine(m.title || all.find((x) => x.role === 'user')?.text || ''), 80), at: m.at } : null;
  } else {
    const i = tool === 'claude' ? claudeInfo(file) : codexInfo(file);
    info = i ? { tool: i.tool, id: i.id, title: i.title, at: i.at, ...(i.entry ? { entry: i.entry } : {}) } : null;
    const entries = lines(readSlice(file, 'tail', TAIL));
    all = tool === 'claude' ? claudeMessages(entries) : codexMessages(entries);
  }
  if (!info) throw new RelayError('这段对话读不出来', 'no-session');
  const messages = all.slice(-400).map((m) => ({ ...m, text: clip(m.text, 6000) }));
  return { info, messages, cut: size > TAIL || all.length > 400 };
}
