import { spawnSync } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[]): GitResult {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) throw new Error(`无法执行 git：${r.error.message}`);
  return { code: r.status ?? -1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

export function gitOk(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
  return r.stdout;
}

export function repoRootAt(cwd: string): string {
  try {
    return gitOk(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new Error('当前目录不在 git 仓库内。relay 命令须在目标项目仓库中执行。');
  }
}

/** relay 框架自身提交（checkpoint / start / merge 等）的固定署名，与 agent 的提交区分开。 */
export const RELAY_IDENTITY = ['-c', 'user.name=relay', '-c', 'user.email=relay@local'];

/**
 * 尊重 .gitignore 后 add -A 并提交（协议二）。唯一排除项是框架自己的临时锁文件。
 * 返回新提交 SHA；工作区干净（无需提交）返回 null。
 */
export function commitAll(worktree: string, message: string): string | null {
  git(worktree, ['add', '-A', '--', '.', ':(exclude).relay/session.lock']);
  // 锁文件故意不入库。工作区里只剩它时，status 仍非空，不能据此去提交。
  if (gitOk(worktree, ['diff', '--cached', '--name-only']).trim() === '') return null;
  const r = git(worktree, [...RELAY_IDENTITY, 'commit', '-m', message]);
  if (r.code !== 0) throw new Error(`提交失败：${r.stderr}`);
  return gitOk(worktree, ['rev-parse', 'HEAD']);
}
