import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from './errors';
import { agentLabel } from './registry';

/**
 * 单写者锁：同一时间只让一个人写隔离副本。三种锁共用 .relay/session.lock，靠 kind 区分：
 * - cli：终端工人（relay run）。进程活着才算数，进程死了是陈旧锁，可以覆盖；
 * - app：桌面工人（relay open）。软锁，**不看进程**（打开命令一眨眼就退出了），只有交接才释放；
 * - op：接力台自己在做交接 / 合回等操作，防止两个操作撞车。进程活着才算数。
 * 旧版锁文件没有 kind，按 cli 处理。
 */
export type LockKind = 'cli' | 'app' | 'op';

export interface SessionLock {
  agent: string;
  pid: number;
  ts: string;
  kind?: LockKind;
  /** op 锁：正在做什么（交接 / 合回 …）。 */
  op?: string;
  llm?: string;
  /** 全自动流水线派的活。 */
  auto?: boolean;
}

export function lockPath(wt: string): string {
  return path.join(wt, '.relay', 'session.lock');
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLock(wt: string): SessionLock | null {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath(wt), 'utf8')) as SessionLock;
    return raw && typeof raw.agent === 'string' ? raw : null;
  } catch {
    return null;
  }
}

export function lockKind(lock: SessionLock): LockKind {
  return lock.kind ?? 'cli';
}

/** 这把锁现在还算不算数（挡不挡别人）。 */
export function lockActive(lock: SessionLock): boolean {
  return lockKind(lock) === 'app' || pidAlive(lock.pid);
}

export function writeLock(wt: string, lock: Omit<SessionLock, 'pid' | 'ts'> & { pid?: number }): void {
  fs.mkdirSync(path.dirname(lockPath(wt)), { recursive: true });
  const full: SessionLock = { pid: process.pid, ts: new Date().toISOString(), ...lock };
  fs.writeFileSync(lockPath(wt), JSON.stringify(full, null, 2) + '\n');
}

export function restoreLock(wt: string, lock: SessionLock): void {
  fs.mkdirSync(path.dirname(lockPath(wt)), { recursive: true });
  fs.writeFileSync(lockPath(wt), JSON.stringify(lock, null, 2) + '\n');
}

export function releaseLock(wt: string): void {
  fs.rmSync(lockPath(wt), { force: true });
}

/** 描述一把锁，给人看。 */
export function describeLock(lock: SessionLock): string {
  const who = agentLabel(lock.agent);
  switch (lockKind(lock)) {
    case 'app':
      return `「${who}」还在干活（桌面窗口，还没交接）`;
    case 'op':
      return `接力台正在${lock.op ?? '处理'}`;
    default:
      return lock.auto ? `全自动流水线里「${who}」正在干活` : `「${who}」正在终端里干活（进程 ${lock.pid}）`;
  }
}

/** 清掉陈旧锁（进程已经不在的 cli / op 锁）。返回被清掉的锁。 */
export function clearStaleLock(wt: string): SessionLock | null {
  const lock = readLock(wt);
  if (!lock || lockActive(lock)) return null;
  releaseLock(wt);
  return lock;
}

/**
 * 有人占着就拒绝。allowApp：桌面软锁放行（交接就是用来释放它的）。
 * 陈旧锁顺手清掉。
 */
export function assertFree(wt: string, action: string, opts: { allowApp?: boolean } = {}): SessionLock | null {
  clearStaleLock(wt);
  const lock = readLock(wt);
  if (!lock) return null;
  const kind = lockKind(lock);
  if (kind === 'app' && opts.allowApp) return lock;
  if (lock.pid === process.pid && kind !== 'app') return lock;
  if (kind === 'app') throw new RelayError(`${describeLock(lock)}。先交接，再${action}。`, 'locked-app');
  if (kind === 'op') throw new RelayError(`${describeLock(lock)}，请稍等再${action}。`, 'locked-op');
  throw new RelayError(`${describeLock(lock)}。等它退出后再${action}。`, 'locked-cli');
}

/**
 * 在 op 锁里做一件事。成功：锁释放（交接本来就要释放桌面软锁）。
 * 失败：恢复原来的锁（交接失败了，桌面工人还在岗）。
 */
export async function withOpLock<T>(wt: string, op: string, agent: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = readLock(wt);
  writeLock(wt, { agent, kind: 'op', op });
  try {
    const out = await fn();
    const cur = readLock(wt);
    if (cur && cur.pid === process.pid && lockKind(cur) === 'op') releaseLock(wt);
    return out;
  } catch (e) {
    if (fs.existsSync(path.dirname(lockPath(wt)))) {
      if (prev && lockKind(prev) === 'app') restoreLock(wt, prev);
      else releaseLock(wt);
    }
    throw e;
  }
}
