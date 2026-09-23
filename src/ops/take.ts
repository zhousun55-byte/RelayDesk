import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from '../core/errors';
import { git } from '../core/git';
import { appendEvent } from '../core/journal';
import { assertFree } from '../core/lock';
import { businessEntries, isDeleted, listStray, type StatusEntry } from '../core/status';
import { openTask } from './context';

export interface TakeResult {
  taken: string[];
  skipped: { path: string; why: string }[];
}

/** 正式文件夹里这个文件恢复成最后一次提交的样子；是新文件就删掉。 */
function restoreMain(root: string, p: string): void {
  const inHead = git(root, ['cat-file', '-e', `HEAD:${p}`]).code === 0;
  if (inHead) {
    git(root, ['checkout', 'HEAD', '--', p]);
  } else {
    git(root, ['rm', '--cached', '-q', '--ignore-unmatch', '--', p]);
    fs.rmSync(path.join(root, p), { force: true });
  }
}

/**
 * 收进任务：任务期间正式文件夹里被改动的文件（多半是 AI 开错了文件夹），挪进隔离副本，
 * 正式文件夹恢复原样。隔离副本里同一个文件也改过的，不覆盖，跳过并说明。
 */
export function takeStray(dir: string, only?: string[]): TakeResult {
  const ctx = openTask(dir);
  const { root, wt, session } = ctx;
  assertFree(wt, '收进任务', { allowApp: true });
  let stray: StatusEntry[] = listStray(root, session.mainSnapshot);
  if (only?.length) stray = stray.filter((e) => only.includes(e.path));
  if (stray.length === 0) throw new RelayError('正式文件夹里没有需要收进来的改动。', 'nothing');

  const wtDirty = new Set(businessEntries(wt).flatMap((e) => [e.path, ...(e.orig ? [e.orig] : [])]));
  const taken: string[] = [];
  const skipped: { path: string; why: string }[] = [];
  for (const e of stray) {
    if (wtDirty.has(e.path) || (e.orig && wtDirty.has(e.orig))) {
      skipped.push({ path: e.path, why: '隔离副本里这个文件也改过，没有覆盖' });
      continue;
    }
    const dst = path.join(wt, e.path);
    if (isDeleted(e)) {
      fs.rmSync(dst, { force: true });
    } else {
      const src = path.join(root, e.path);
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
        skipped.push({ path: e.path, why: '不是普通文件' });
        continue;
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      if (e.orig) fs.rmSync(path.join(wt, e.orig), { force: true });
    }
    restoreMain(root, e.path);
    if (e.orig) restoreMain(root, e.orig);
    taken.push(e.path);
  }
  if (taken.length) appendEvent(wt, { ts: new Date().toISOString(), type: 'take', files: taken, worktree: wt });
  return { taken, skipped };
}
