import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { TaskDoc, TaskItem } from '../core/notes';
import { relayHome } from '../core/paths';
import { PARALLEL_MARK } from '../core/prompts';
import { copyIntoProject, noLinkPath } from '../core/safe-write';

/**
 * 派活时同时做几步：清单里写了「可以同时做」的几步，每一位在自己的一份项目副本里做，谁先做完谁先并回项目，
 * 每一份记成一棒。副本放在 ~/.relay/worktrees/ 下，并回去之后就删掉（没并回去的留着，路径写在那一棒的说明里）。
 */

/** 清单里下一步（第几步从 1 数）。 */
export interface Step {
  index: number;
  text: string;
}

/** 步骤自己写了「第 3 步：」的去掉（不然提示和卡片上都是「第 3 步：第 3 步：……」）。 */
export function stepOf(task: TaskDoc, i: number): Step {
  return { index: i + 1, text: task.items[i].text.replace(/^第\s*[\d一二三四五六七八九十百]+\s*步\s*[：:.、，,]?\s*/, '') || task.items[i].text };
}

/** 强模型拆解时给这一步标了「可以同时做」（写在这一步下面或这一行里）。 */
export function isParallel(item: TaskItem): boolean {
  return (item.note ?? '').includes(PARALLEL_MARK) || item.text.includes(PARALLEL_MARK);
}

/** 不复制进副本的：快照仓库、运行日志（大，也用不着）。 */
const SKIP_RELAY = new Set(['snapshots', 'runs']);

function cloneEntry(src: string, dst: string): void {
  // macOS 的 APFS 上 cp -c 是写时复制，几乎不占空间、也快；不行就普通复制
  if (process.platform === 'darwin' && spawnSync('cp', ['-cRP', src, dst], { stdio: 'ignore' }).status === 0) return;
  fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
}

/** 建一份项目副本（name 区分同一个项目的几份），返回它的路径。 */
export function cloneProject(root: string, name: string): string {
  const tag = crypto.createHash('sha1').update(root).digest('hex').slice(0, 8);
  const dest = path.join(relayHome(), 'worktrees', `${path.basename(root)}-${tag}-${name}`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(root)) {
    if (name === '.relay') continue;
    cloneEntry(path.join(root, name), path.join(dest, name));
  }
  const relay = path.join(root, '.relay');
  fs.mkdirSync(path.join(dest, '.relay'), { recursive: true });
  for (const name of fs.existsSync(relay) ? fs.readdirSync(relay) : []) {
    if (SKIP_RELAY.has(name)) continue;
    cloneEntry(path.join(relay, name), path.join(dest, '.relay', name));
  }
  return dest;
}

/** 删掉副本（只删 ~/.relay/worktrees/ 下面的）。 */
export function dropClone(dir: string): void {
  const base = path.join(relayHome(), 'worktrees') + path.sep;
  if (dir.startsWith(base)) fs.rmSync(dir, { recursive: true, force: true });
}

/** 把副本里的这些文件搬回项目（删掉的也删掉）。 */
export function applyFiles(root: string, dir: string, files: { path: string; deleted: boolean }[]): void {
  for (const f of files) {
    const to = path.join(root, f.path);
    if (f.deleted) {
      fs.rmSync(to, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    noLinkPath(to, root);
    fs.rmSync(to, { force: true });
    copyIntoProject(path.join(dir, f.path), to, root);
  }
}
