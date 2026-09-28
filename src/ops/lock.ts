import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from '../core/errors';
import { pidAlive } from '../core/proc';

/**
 * 一个项目的状态同一时间只让一件事改：调度（只做一棒 / 全自动）、退回和撤销退回、换任务都拿这一把锁。
 * 网页和命令行各开一个也不行。
 */

export function runsDir(root: string): string {
  return path.join(root, '.relay', 'runs');
}

/** 这个进程拿着的锁（锁文件里写的 token）。 */
const heldLocks = new Set<string>();

/**
 * 拿项目级的锁：.relay/runs/lock 只能新建（别人建好了就是别人在用）。
 * 锁的主人进程没了、或者是本进程已经放掉的旧锁，才算过期、可以拿走。返回放锁的函数。
 */
export function acquireLock(root: string): () => void {
  fs.mkdirSync(runsDir(root), { recursive: true });
  const p = path.join(runsDir(root), 'lock');
  const token = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(p, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }));
      } finally {
        fs.closeSync(fd);
      }
      heldLocks.add(token);
      return () => {
        heldLocks.delete(token);
        try {
          const cur = JSON.parse(fs.readFileSync(p, 'utf8')) as { token?: string };
          if (cur.token === token) fs.rmSync(p, { force: true });
        } catch {
          /* 已经没了 */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let holder: { pid?: number; token?: string } = {};
      let ageMs = Infinity;
      try {
        ageMs = Date.now() - fs.statSync(p).mtimeMs;
        holder = JSON.parse(fs.readFileSync(p, 'utf8')) as typeof holder;
      } catch {
        /* 刚建好还没写内容，或者被删了 */
      }
      const mine = holder.pid === process.pid;
      const alive = !!holder.pid && (mine ? !!holder.token && heldLocks.has(holder.token) : pidAlive(holder.pid));
      // 别的进程刚建好锁、还没来得及写进去：当它在用。
      if (alive || (!holder.pid && ageMs < 3000)) throw new RelayError('接力台已经在调度这个项目（可能是另一个窗口或命令行）', 'busy');
      fs.rmSync(p, { force: true });
    }
  }
  throw new RelayError('拿不到这个项目的调度锁', 'busy');
}

/** 拿着锁做一件同步的事，做完（出错也一样）放掉。 */
export function withLock<T>(root: string, fn: () => T): T {
  const release = acquireLock(root);
  try {
    return fn();
  } finally {
    release();
  }
}
