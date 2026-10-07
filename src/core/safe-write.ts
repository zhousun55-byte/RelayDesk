import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from './errors';

/**
 * 往项目里写文件：从项目根往下逐级看，路上有链接（文件或文件夹）就不写。
 * 别人给的仓库可以把 .relay/复核/第1棒.diff 这种猜得到的名字做成指向 ~/.zshrc 的链接，
 * 直接 writeFileSync 会顺着链接把家目录里的文件整个换掉。
 * root 不给时取路径里最近的 .relay 的上一级（接力台自己的文件都在 .relay 里）。
 */
function rootOf(file: string, root?: string): string {
  if (root) return path.resolve(root);
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    if (path.basename(dir) === '.relay') return path.dirname(dir);
    const up = path.dirname(dir);
    if (up === dir) throw new RelayError(`接力台只往项目里写：${file}`, 'bad-path');
    dir = up;
  }
}

/** 查一遍，没问题返回绝对路径；不在项目里、路上有链接都报错。 */
export function noLinkPath(file: string, root?: string): string {
  const base = rootOf(file, root);
  const abs = path.resolve(file);
  const rel = path.relative(base, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new RelayError(`接力台只往项目里写：${file}`, 'bad-path');
  let cur = base;
  for (const part of rel.split(path.sep)) {
    cur = path.join(cur, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      break; // 还没有：后面新建的都是真文件夹、真文件
    }
    if (st.isSymbolicLink()) throw new RelayError(`${path.relative(base, cur)} 是个链接，接力台不往链接里写（会写到项目外面）。`, 'link');
  }
  return abs;
}

// Windows 没有 O_NOFOLLOW：上面的逐级检查照样拦
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function put(file: string, data: string | Buffer, flags: number, root?: string): void {
  const abs = noLinkPath(file, root);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const fd = fs.openSync(abs, flags | NOFOLLOW, 0o666);
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

export function writeProjectFile(file: string, data: string | Buffer, root?: string): void {
  put(file, data, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, root);
}

export function appendProjectFile(file: string, data: string | Buffer, root?: string): void {
  put(file, data, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND, root);
}

/** 复制进项目（目标按上面的规矩写；来源是接力台自己的临时文件）。 */
export function copyIntoProject(src: string, file: string, root?: string): void {
  writeProjectFile(file, fs.readFileSync(src), root);
}
