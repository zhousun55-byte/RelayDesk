import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/** 接力台自己的目录：工人名单、会话指针、隔离工作副本都在这里，不在用户的项目里。 */
export function relayHome(): string {
  const override = process.env.RELAY_HOME;
  return override && override.trim() ? path.resolve(override) : path.join(os.homedir(), '.relay');
}

/**
 * 项目的稳定键：文件夹名 + 路径哈希。英文名和旧版完全一样（旧版进行中的任务还找得到）；
 * 中文名保留原字（旧版会变成一串下划线）。
 */
export function repoKey(repoRoot: string): string {
  const h = crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 8);
  const name = path.basename(repoRoot).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 40) || 'repo';
  return `${name}-${h}`;
}

/** 隔离工作副本一律建在仓库外：~/.relay/worktrees/<项目键>/<分支名>。 */
export function worktreePathFor(repoRoot: string, branch: string): string {
  return path.join(relayHome(), 'worktrees', repoKey(repoRoot), path.basename(branch));
}

export function isInside(parent: string, child: string): boolean {
  const base = path.resolve(parent);
  const target = path.resolve(child);
  return target === base || target.startsWith(base + path.sep);
}
