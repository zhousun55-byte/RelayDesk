import fs from 'node:fs';
import path from 'node:path';

/**
 * 单写者锁：同一时间只允许一个 agent 写 worktree。两种锁共用一个文件，靠 kind 区分：
 * - cli（缺省，旧锁文件向后兼容）：pid 活锁。relay run 期间持有，进程死即陈旧、可覆盖。
 * - app：软锁。relay open 期间持有，**绝不**用 pid 判断存活（`open` 的 pid 会立刻死），
 *   正常只由 handoff 释放；merge / abandon 遇软锁默认拒绝，--force 收尾时随 worktree 删除清除。
 */
export interface SessionLock {
  agent: string;
  /** 写锁的 relay 进程 pid。app 软锁里只是留档，不作活性判断。 */
  pid: number;
  ts: string;
  kind?: 'cli' | 'app';
}

/** 拿锁结果。overrode = --force 覆盖了仍持有的 App 软锁时，被覆盖的 agent 名（调用方须写进 journal）。 */
export interface LockTakeover {
  overrode?: string;
}

export function lockPath(wt: string): string {
  return path.join(wt, '.relay', 'session.lock');
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLock(wt: string): SessionLock | null {
  const p = lockPath(wt);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as SessionLock;
  } catch {
    return null;
  }
}

export function isAppLock(lock: SessionLock): boolean {
  return lock.kind === 'app';
}

function writeLock(wt: string, agent: string, kind: 'cli' | 'app'): void {
  fs.mkdirSync(path.dirname(lockPath(wt)), { recursive: true });
  fs.writeFileSync(
    lockPath(wt),
    JSON.stringify({ agent, pid: process.pid, ts: new Date().toISOString(), kind }, null, 2) + '\n'
  );
}

/** 拿锁前的公共检查：App 软锁默认拒绝（--force 覆盖并留痕）；cli 活锁一律拒绝；cli 死锁陈旧覆盖。 */
function checkExisting(wt: string, opts: { force?: boolean }): LockTakeover {
  const existing = readLock(wt);
  if (!existing) return {};
  if (isAppLock(existing)) {
    if (!opts.force) {
      throw new Error(
        `「${existing.agent}」的 App 会话尚未交接（软锁，不看 pid）。` +
          `先回主仓库执行 relay handoff 完成交接（或 relay abandon --force 放弃），` +
          `确认要强行接管可加 --force（覆盖会写进 journal）。`
      );
    }
    console.warn(`--force：覆盖「${existing.agent}」仍持有的 App 软锁（将写进 journal）。`);
    return { overrode: existing.agent };
  }
  if (pidAlive(existing.pid)) {
    throw new Error(
      `「${existing.agent}」的会话仍在运行（pid ${existing.pid}）。同一时间只允许一个 agent 写 worktree。` +
        `确认为误锁后可手工删除 ${lockPath(wt)}`
    );
  }
  console.warn(`发现陈旧锁（${existing.agent}，pid ${existing.pid} 已退出），覆盖之。`);
  return {};
}

/** relay run 拿 CLI pid 活锁。 */
export function acquireLock(wt: string, agent: string, opts: { force?: boolean } = {}): LockTakeover {
  const takeover = checkExisting(wt, opts);
  writeLock(wt, agent, 'cli');
  return takeover;
}

/** relay open 拿 App 软锁。 */
export function acquireAppLock(wt: string, agent: string, opts: { force?: boolean } = {}): LockTakeover {
  const takeover = checkExisting(wt, opts);
  writeLock(wt, agent, 'app');
  return takeover;
}

export function releaseLock(wt: string): void {
  const p = lockPath(wt);
  if (fs.existsSync(p)) fs.rmSync(p);
}

/**
 * CLI 活锁检查：pid 活 → 拒绝；pid 死 → 清除（陈旧）。App 软锁不看 pid，此处直接放行——
 * 是否拒绝由各命令语义决定（run/open/rollback 用 assertNoAppSoftLock 拒绝；
 * handoff 是软锁的正常释放点，merge / abandon 自行检查软锁：默认拒绝，--force 才收尾）。
 */
export function assertNoLiveLock(wt: string, action: string): void {
  const lock = readLock(wt);
  if (!lock || isAppLock(lock)) return;
  if (pidAlive(lock.pid)) {
    throw new Error(
      `「${lock.agent}」的会话仍在运行（pid ${lock.pid}）。${action} 前须等它退出。` +
        `确认为误锁可手工删除 ${lockPath(wt)}`
    );
  }
  console.warn(`发现陈旧锁（${lock.agent}，pid ${lock.pid} 已退出），清除之。`);
  releaseLock(wt);
}

/** App 软锁拒绝：run / open / rollback 用（防止 App 还开着时被接管或 reset）。handoff 不调用——它是软锁的正常释放点；merge / abandon 自行检查（默认拒绝，--force 才收尾）。 */
export function assertNoAppSoftLock(wt: string, action: string): void {
  const lock = readLock(wt);
  if (lock && isAppLock(lock)) {
    throw new Error(
      `「${lock.agent}」的 App 会话尚未交接（软锁，不看 pid）。` +
        `先执行 relay handoff 完成交接（或 relay abandon --force 放弃），才能${action}。`
    );
  }
}
