import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from './errors';
import { isInside } from './paths';

/**
 * 往项目里写文件：从项目根往下逐级看，路上的链接（文件或文件夹）指到项目外面的就不写。
 * 别人给的仓库可以把 .relay/复核/第1棒.diff 这种猜得到的名字做成指向 ~/.zshrc 的链接，
 * 直接 writeFileSync 会顺着链接把家目录里的文件整个换掉。
 * 指到项目里面的照常写（AGENTS.md 指向 CLAUDE.md 这种很常见），但不写进 .git 和快照仓库（钩子、配置在那里）。
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

function real(p: string): string {
  return fs.realpathSync.native(p);
}

/** 路上碰到的链接：指到项目里面的换成它指的地方；指到外面、.git、快照仓库，或者断了的，报错。 */
function follow(base: string, link: string, shown: string): string {
  let to: string;
  try {
    to = real(link);
  } catch {
    throw new RelayError(`${shown} 是个断了的链接，接力台不往里写。`, 'link');
  }
  const realBase = real(base);
  if (!isInside(realBase, to)) throw new RelayError(`${shown} 是个链接，指到了项目外面，接力台不往那里写。`, 'link');
  const inner = path.relative(realBase, to).split(path.sep).join('/');
  if (/(^|\/)\.git(\/|$)|^\.relay\/snapshots(\/|$)/i.test(inner)) throw new RelayError(`${shown} 是个链接，指到了 .git 或快照仓库，接力台不往那里写。`, 'link');
  return to;
}

/** 查一遍，返回真正要写的绝对路径（路上指向项目里面的链接已经换成它指的地方）；不在项目里、链接指到外面都报错。 */
export function noLinkPath(file: string, root?: string): string {
  const base = rootOf(file, root);
  const abs = path.resolve(file);
  const rel = path.relative(base, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new RelayError(`接力台只往项目里写：${file}`, 'bad-path');
  const parts = rel.split(path.sep);
  let cur = base;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return path.join(cur, ...parts.slice(i + 1)); // 还没有：后面新建的都是真文件夹、真文件
    }
    if (st.isSymbolicLink()) cur = follow(base, cur, parts.slice(0, i + 1).join('/'));
  }
  return cur;
}

// Windows 没有 O_NOFOLLOW：上面的逐级检查和下面打开后的核对照样拦
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const { O_WRONLY, O_CREAT, O_APPEND } = fs.constants;

function put(file: string, data: string | Buffer, append: boolean, root?: string): void {
  const target = noLinkPath(file, root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // 先不清空：查和开之间，路上的文件夹可能刚被换成链接（正在干活的 AI 改得到 .relay）。
  // 开好之后再查一遍，核对开的就是项目里那个文件，对上了才清空、写入。
  const fd = fs.openSync(target, O_WRONLY | O_CREAT | (append ? O_APPEND : 0) | NOFOLLOW, 0o666);
  try {
    const again = noLinkPath(file, root);
    const opened = fs.fstatSync(fd);
    const there = fs.lstatSync(again);
    if (again !== target || opened.ino !== there.ino || opened.dev !== there.dev) {
      throw new RelayError(`${path.basename(file)} 写的时候路上换成了链接，接力台没写。`, 'link');
    }
    if (!append) fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

export function writeProjectFile(file: string, data: string | Buffer, root?: string): void {
  put(file, data, false, root);
}

export function appendProjectFile(file: string, data: string | Buffer, root?: string): void {
  put(file, data, true, root);
}

/** 复制进项目（目标按上面的规矩写；来源是接力台自己的临时文件）。 */
export function copyIntoProject(src: string, file: string, root?: string): void {
  writeProjectFile(file, fs.readFileSync(src), root);
}
