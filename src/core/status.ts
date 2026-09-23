import fs from 'node:fs';
import path from 'node:path';
import { git } from './git';

/** git status --porcelain=v1 -z 的一项。code 是两位状态码（XY），如 " M"、"??"、"R "。 */
export interface StatusEntry {
  code: string;
  path: string;
  /** 改名 / 复制时的原路径。 */
  orig?: string;
}

/**
 * 解析 `git status --porcelain=v1 -z`。必须用 -z：路径原样（中文、空格都不转义），
 * 也不会因为裁掉行首空格而把「 M 文件」读错成「M 文件」。
 */
export function parsePorcelainZ(raw: string): StatusEntry[] {
  const parts = raw.split('\0');
  const out: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    if (item.length < 4) continue;
    const code = item.slice(0, 2);
    const p = item.slice(3);
    if (code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C') {
      out.push({ code, path: p, orig: parts[i + 1] });
      i++;
    } else {
      out.push({ code, path: p });
    }
  }
  return out;
}

export function statusEntries(cwd: string): StatusEntry[] {
  const r = git(cwd, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { raw: true });
  if (r.code !== 0) return [];
  return parsePorcelainZ(r.stdout);
}

/** .relay/ 下是接力台自己的文件（交接记录、配置、讨论），不算业务改动。 */
export function isRelayPath(p: string): boolean {
  const f = p.replace(/\\/g, '/').replace(/^\.\//, '');
  return f === '.relay' || f.startsWith('.relay/');
}

/** 业务改动（排除 .relay/ 与锁文件）。 */
export function businessEntries(cwd: string): StatusEntry[] {
  return statusEntries(cwd).filter((e) => !isRelayPath(e.path) && !(e.orig && isRelayPath(e.orig)));
}

export function isUntracked(e: StatusEntry): boolean {
  return e.code === '??';
}

export function isDeleted(e: StatusEntry): boolean {
  return e.code.includes('D');
}

export function statusWord(code: string): string {
  if (code === '??' || code.includes('A')) return '新增';
  if (code.includes('D')) return '删除';
  if (code.includes('R')) return '改名';
  if (code.includes('U')) return '冲突';
  return '修改';
}

// ---- 两个提交之间的业务改动 ----

export interface FileChange {
  path: string;
  /** A 新增 / M 修改 / D 删除 / R 改名 / T 类型变化 */
  status: string;
  orig?: string;
  /** 二进制文件为 null。 */
  added: number | null;
  removed: number | null;
}

const EXCLUDE_RELAY = ['--', '.', ':(exclude).relay'];

export function parseNameStatusZ(raw: string): { status: string; path: string; orig?: string }[] {
  const parts = raw.split('\0').filter((x, i, arr) => !(x === '' && i === arr.length - 1));
  const out: { status: string; path: string; orig?: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (!s) continue;
    const letter = s[0];
    if (letter === 'R' || letter === 'C') {
      out.push({ status: letter, orig: parts[i + 1], path: parts[i + 2] });
      i += 2;
    } else {
      out.push({ status: letter, path: parts[i + 1] });
      i += 1;
    }
  }
  return out.filter((x) => x.path);
}

export function parseNumstatZ(raw: string): Map<string, { added: number | null; removed: number | null }> {
  const map = new Map<string, { added: number | null; removed: number | null }>();
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (!s) continue;
    const m = s.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) continue;
    const added = m[1] === '-' ? null : Number(m[1]);
    const removed = m[2] === '-' ? null : Number(m[2]);
    let p = m[3];
    if (p === '') {
      // 改名：接下来两个字段是 原路径、新路径
      p = parts[i + 2] ?? '';
      i += 2;
    }
    if (p) map.set(p, { added, removed });
  }
  return map;
}

/** from..to 之间的业务文件改动（不含 .relay）。to 省略 = 工作区现状（含未提交，不含未跟踪）。 */
export function diffFiles(cwd: string, from: string, to?: string): FileChange[] {
  const range = to ? [`${from}..${to}`] : [from];
  const ns = git(cwd, ['diff', '-z', '--name-status', '--find-renames', ...range, ...EXCLUDE_RELAY], { raw: true });
  if (ns.code !== 0) return [];
  const num = git(cwd, ['diff', '-z', '--numstat', '--find-renames', ...range, ...EXCLUDE_RELAY], { raw: true });
  const stats = num.code === 0 ? parseNumstatZ(num.stdout) : new Map();
  return parseNameStatusZ(ns.stdout).map((f) => ({
    path: f.path,
    status: f.status,
    ...(f.orig ? { orig: f.orig } : {}),
    added: stats.get(f.path)?.added ?? null,
    removed: stats.get(f.path)?.removed ?? null,
  }));
}

export function sumChanges(files: FileChange[]): { files: number; added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added ?? 0;
    removed += f.removed ?? 0;
  }
  return { files: files.length, added, removed };
}

/** 单个文件的 diff 文本（网页点开看）。 */
export function fileDiff(cwd: string, from: string, to: string | null, file: string): string {
  const range = to ? [`${from}..${to}`] : [from];
  const r = git(cwd, ['diff', '--find-renames', ...range, '--', file], { raw: true });
  return r.code === 0 ? r.stdout : '';
}

/** 还没解决的合并冲突文件。 */
export function unmergedFiles(cwd: string): string[] {
  const r = git(cwd, ['diff', '--name-only', '-z', '--diff-filter=U'], { raw: true });
  if (r.code !== 0) return [];
  return r.stdout.split('\0').filter(Boolean);
}

/** 文件里还留着冲突标记（<<<<<<< / >>>>>>>）。 */
export function hasConflictMarkers(cwd: string, file: string): boolean {
  try {
    const text = fs.readFileSync(path.join(cwd, file), 'utf8');
    return /^(<{7}|>{7})( |$)/m.test(text);
  } catch {
    return false;
  }
}

// ---- 正式文件夹：任务期间被误改的文件 ----

/** 批量算内容哈希；文件不存在记为 "-"。 */
export function hashFiles(cwd: string, files: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const existing = files.filter((f) => {
    const abs = path.join(cwd, f);
    const ok = fs.existsSync(abs) && fs.statSync(abs).isFile();
    if (!ok) out[f] = '-';
    return ok;
  });
  if (existing.length === 0) return out;
  const r = git(cwd, ['hash-object', '--no-filters', '--stdin-paths'], { input: existing.join('\n') + '\n' });
  const hashes = r.code === 0 ? r.stdout.split('\n') : [];
  existing.forEach((f, i) => {
    out[f] = hashes[i]?.trim() || '?';
  });
  return out;
}

const SNAPSHOT_LIMIT = 2000;

/** 开始任务时，正式文件夹里本来就没提交的文件。 */
export function snapshotMain(root: string): Record<string, string> {
  const entries = businessEntries(root);
  if (entries.length > SNAPSHOT_LIMIT) return { '*': 'too-many' };
  return hashFiles(root, entries.map((e) => e.path));
}

/**
 * 任务期间正式文件夹里新冒出来的改动（多半是 AI 开错了文件夹，改到了正式版上）。
 * 开始时就有、之后没再变的，是用户自己原来的改动，不算。
 * 旧会话没有快照：所有未提交改动都算。
 */
export function listStray(root: string, snapshot?: Record<string, string>): StatusEntry[] {
  if (snapshot?.['*']) return [];
  const entries = businessEntries(root);
  if (!snapshot || entries.length === 0) return entries;
  const known = entries.filter((e) => snapshot[e.path] !== undefined);
  const now = hashFiles(root, known.map((e) => e.path));
  return entries.filter((e) => snapshot[e.path] === undefined || snapshot[e.path] !== now[e.path]);
}
