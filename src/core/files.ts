import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from './errors';
import { isInside } from './paths';
import { workFiles } from './snap';

/**
 * 网页右边的项目树：列出项目里的文件、读一个文件给人看。只读，不改任何东西。
 * 接力台自己的 .relay/ 不列（交接、复核在对话里看）。
 */

/** 没接入的文件夹直接走一遍时跳过的（体积大、能重新生成、或者是别的工具的仓库）。 */
const SKIP = new Set(['.git', '.hg', '.svn', '.relay', 'node_modules', '.venv', 'venv', '__pycache__', '.DS_Store', '.next', '.nuxt', '.turbo', '.parcel-cache', '.cache', 'coverage', 'Pods', 'DerivedData', '.gradle']);

export interface FileList {
  files: string[];
  /** 文件太多，只列了前面的。 */
  truncated: boolean;
}

export function projectFiles(root: string, limit = 5000): FileList {
  const fromSnap = workFiles(root);
  if (fromSnap) {
    const files = fromSnap.filter((f) => !f.startsWith('.relay/')).sort();
    return { files: files.slice(0, limit), truncated: files.length > limit };
  }
  // 还没接入：一层一层往下走，够数就停。
  const files: string[] = [];
  const queue = [''];
  let dirs = 0;
  while (queue.length && files.length <= limit && dirs < 20_000) {
    const rel = queue.shift()!;
    dirs++;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) queue.push(p);
      else if (e.isFile() || e.isSymbolicLink()) files.push(p);
    }
  }
  files.sort();
  return { files: files.slice(0, limit), truncated: files.length > limit || queue.length > 0 };
}

export interface FileView {
  path: string;
  size: number;
  /** 二进制文件不给内容。 */
  binary: boolean;
  /** 太大，只给了前面一段。 */
  truncated: boolean;
  text: string;
}

/** 项目里的一个路径（相对项目根目录）→ 真实的绝对路径。不许出项目文件夹，也不许碰快照仓库。 */
export function projectPath(root: string, rel: string): { clean: string; real: string } {
  const clean = path.normalize(String(rel ?? '').replace(/^\.\//, ''));
  if (!clean || clean === '.' || path.isAbsolute(clean) || clean.startsWith('..')) throw new RelayError('路径不对。', 'bad-path');
  let real: string;
  try {
    real = fs.realpathSync(path.join(root, clean));
  } catch {
    throw new RelayError(`找不到：${clean}`, 'no-file');
  }
  const realRoot = fs.realpathSync(root);
  const inner = path.relative(realRoot, real).split(path.sep).join('/');
  if (!isInside(realRoot, real) || /^(\.git|\.relay\/snapshots)(\/|$)/.test(inner)) throw new RelayError('不能看这个文件。', 'bad-path');
  return { clean: clean.split(path.sep).join('/'), real };
}

/** 读项目里的一个文件。 */
export function readProjectFile(root: string, rel: string, maxBytes = 512 * 1024): FileView {
  const { clean, real } = projectPath(root, rel);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new RelayError(`不是文件：${clean}`, 'no-file');
  const len = Math.min(st.size, maxBytes);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(real, 'r');
  try {
    fs.readSync(fd, buf, 0, len, 0);
  } finally {
    fs.closeSync(fd);
  }
  const binary = buf.subarray(0, 8000).includes(0);
  return { path: clean, size: st.size, binary, truncated: st.size > maxBytes, text: binary ? '' : buf.toString('utf8') };
}
