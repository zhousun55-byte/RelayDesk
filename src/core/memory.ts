import fs from 'node:fs';
import path from 'node:path';
import { relayHome } from './paths';

/**
 * 接力台记住的东西：最近打开的项目，和打开过、还没接入的文件夹（选择器选的、命令行 relay ui 打开的）。
 * 网页上的列表看它；网页接口只认这里记着的文件夹和接入过的项目（见 knownDir）。
 */
export interface UiMemory {
  root?: string;
  recents?: string[];
  opened?: string[];
}

export function memoryPath(): string {
  return path.join(relayHome(), 'ui-last.json');
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((r): r is string => typeof r === 'string') : []);

export function loadMemory(): UiMemory {
  try {
    const raw = JSON.parse(fs.readFileSync(memoryPath(), 'utf8')) as UiMemory;
    return { root: typeof raw.root === 'string' ? raw.root : undefined, recents: strings(raw.recents), opened: strings(raw.opened) };
  } catch {
    return {};
  }
}

function saveMemory(m: UiMemory): void {
  fs.mkdirSync(relayHome(), { recursive: true });
  fs.writeFileSync(memoryPath(), JSON.stringify({ root: m.root, recents: m.recents ?? [], ...(m.opened?.length ? { opened: m.opened } : {}) }, null, 2) + '\n');
}

/** 记住最近打开的项目。已经是最近的那一个就不写（网页每隔一两秒问一次状态，不能每次都写盘）。 */
export function rememberProject(root: string): void {
  const cur = loadMemory();
  if (cur.root === root && cur.recents?.[0] === root) return;
  saveMemory({ ...cur, root, recents: [root, ...(cur.recents ?? []).filter((r) => r !== root)].slice(0, 12) });
}

/** 记住打开过的文件夹（还没接入也算）：选择器里选的、命令行 relay ui 打开的。 */
export function rememberOpened(dir: string): void {
  const cur = loadMemory();
  if (cur.opened?.[0] === dir) return;
  saveMemory({ ...cur, opened: [dir, ...(cur.opened ?? []).filter((r) => r !== dir)].slice(0, 12) });
}

export function forgetProject(root: string): void {
  const cur = loadMemory();
  const recents = (cur.recents ?? []).filter((r) => r !== root);
  saveMemory({ root: cur.root === root ? recents[0] : cur.root, recents, opened: (cur.opened ?? []).filter((r) => r !== root) });
}

/** 上次打开的项目（还在的话）。 */
export function lastProject(): string | null {
  const root = loadMemory().root;
  return root && fs.existsSync(root) ? root : null;
}

const realOf = (p: string): string => {
  try {
    return fs.realpathSync.native(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
};

/**
 * 网页接口认不认这个文件夹：接入过的项目、最近打开的、打开过的（选择器、relay ui）、这个接力台启动时给的那个。
 * 路径按磁盘上的真实写法比（macOS 上 /tmp 和 /private/tmp 是同一个）。
 * 别的路径一律不认——不然过了来源检查的请求（本机任何程序，包括只许改项目文件夹的 AI）拿一个任意 dir，就能列、读、往里写。
 */
export function knownDir(dir: string, startDir?: string): boolean {
  if (fs.existsSync(path.join(dir, '.relay', 'journal.jsonl'))) return true;
  const m = loadMemory();
  const real = realOf(dir);
  return [startDir, m.root, ...(m.recents ?? []), ...(m.opened ?? [])].some((r) => r && realOf(r) === real);
}
