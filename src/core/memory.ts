import fs from 'node:fs';
import path from 'node:path';
import { relayHome } from './paths';

/** 接力台记住的东西：最近打开的项目。只影响网页上的列表，不是事实。 */
export interface UiMemory {
  root?: string;
  recents?: string[];
}

export function memoryPath(): string {
  return path.join(relayHome(), 'ui-last.json');
}

export function loadMemory(): UiMemory {
  try {
    const raw = JSON.parse(fs.readFileSync(memoryPath(), 'utf8')) as UiMemory;
    return {
      root: typeof raw.root === 'string' ? raw.root : undefined,
      recents: Array.isArray(raw.recents) ? raw.recents.filter((r): r is string => typeof r === 'string') : [],
    };
  } catch {
    return {};
  }
}

export function rememberProject(root: string): void {
  const cur = loadMemory();
  const recents = [root, ...(cur.recents ?? []).filter((r) => r !== root)].slice(0, 12);
  fs.mkdirSync(relayHome(), { recursive: true });
  fs.writeFileSync(memoryPath(), JSON.stringify({ root, recents }, null, 2) + '\n');
}

export function forgetProject(root: string): void {
  const cur = loadMemory();
  const recents = (cur.recents ?? []).filter((r) => r !== root);
  fs.mkdirSync(relayHome(), { recursive: true });
  fs.writeFileSync(memoryPath(), JSON.stringify({ root: cur.root === root ? recents[0] : cur.root, recents }, null, 2) + '\n');
}

/** 上次打开的项目（还在的话）。 */
export function lastProject(): string | null {
  const root = loadMemory().root;
  return root && fs.existsSync(root) ? root : null;
}
