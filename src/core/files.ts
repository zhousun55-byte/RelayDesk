import fs from 'node:fs';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
    // native：macOS 上顺便把大小写换成磁盘上的写法（.GIT 就是 .git），下面按真实写法拦。
    real = fs.realpathSync.native(path.join(root, clean));
  } catch {
    throw new RelayError(`找不到：${clean}`, 'no-file');
  }
  const realRoot = fs.realpathSync.native(root);
  const inner = path.relative(realRoot, real).split(path.sep).join('/');
  if (!isInside(realRoot, real) || /^(\.git|\.relay\/snapshots)(\/|$)/i.test(inner)) throw new RelayError('不能看这个文件。', 'bad-path');
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

/** 群聊、新任务里传上来的文件：放在项目里（AI 在项目里就打得开），不进快照，也不进你的 git。 */
export const UPLOAD_REL = '.relay/uploads';
export const UPLOAD_MAX = 200 * 1024 * 1024;

/** 存一个传上来的文件，返回它在项目里的路径：.relay/uploads/0926-2310-原来的名字。 */
export async function saveUpload(root: string, name: string, body: Readable, max = UPLOAD_MAX): Promise<string> {
  const dir = path.join(root, UPLOAD_REL);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
  // Windows 上文件名不能带 <>:"|?*：一律换掉，别的电脑传上来的名字在哪都存得下
  const base = path.basename(String(name).replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>:"|?*]/g, '-').trim() || '文件';
  const ext = path.extname(base).slice(0, 16);
  const stem = base.slice(0, base.length - path.extname(base).length).slice(0, 80) || '文件';
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  const stamp = `${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
  let file = `${stamp}-${stem}${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, file)); i++) file = `${stamp}-${stem}-${i}${ext}`;
  const dest = path.join(dir, file);
  let n = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      n += chunk.length;
      done(n > max ? new RelayError(`文件太大，上限 ${max / 1024 / 1024} MB。`, 'too-large') : null, chunk);
    },
  });
  try {
    await pipeline(body, cap, fs.createWriteStream(`${dest}.tmp`));
    fs.renameSync(`${dest}.tmp`, dest);
  } catch (e) {
    fs.rmSync(`${dest}.tmp`, { force: true });
    throw e;
  }
  return `${UPLOAD_REL}/${file}`;
}
