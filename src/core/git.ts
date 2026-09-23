import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from './errors';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** 不裁剪 stdout。解析 porcelain / -z 输出时必须用原样（行首空格是状态位）。 */
  raw?: boolean;
  input?: string;
}

/**
 * 所有 git 调用的公共前缀：
 * - core.quotepath=off：中文文件名原样输出，不变成 "\347\220\206" 这种转义；
 * - 不弹终端提示（凭据、编辑器），接力台在后台跑，弹了就卡死。
 */
const BASE = ['-c', 'core.quotepath=off'];

export function git(cwd: string, args: string[], opts: GitOptions = {}): GitResult {
  const r = spawnSync('git', [...BASE, ...args], {
    cwd,
    encoding: 'utf8',
    input: opts.input,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
  });
  if (r.error) throw new RelayError(`无法执行 git：${r.error.message}。请先安装 git。`, 'no-git');
  const stdout = r.stdout ?? '';
  return { code: r.status ?? -1, stdout: opts.raw ? stdout : stdout.trim(), stderr: (r.stderr ?? '').trim() };
}

export function gitOk(cwd: string, args: string[], opts: GitOptions = {}): string {
  const r = git(cwd, args, opts);
  if (r.code !== 0) throw new RelayError(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`, 'git');
  return r.stdout;
}

/** relay 自己的提交（检查点、交接、合回）统一署名；不跑钩子、不签名，免得被用户的 hook / GPG 卡住。 */
export const RELAY_IDENTITY = ['-c', 'user.name=relay', '-c', 'user.email=relay@local', '-c', 'commit.gpgsign=false'];

export function relayCommit(cwd: string, message: string, extra: string[] = []): GitResult {
  return git(cwd, [...RELAY_IDENTITY, 'commit', '--no-verify', '-q', '-m', message, ...extra]);
}

/** cwd 所在仓库的根目录；不在仓库里返回 null。 */
export function repoRootOf(cwd: string): string | null {
  if (!fs.existsSync(cwd)) return null;
  const r = git(cwd, ['rev-parse', '--show-toplevel']);
  return r.code === 0 && r.stdout ? path.resolve(r.stdout) : null;
}

export function requireRepoRoot(cwd: string): string {
  const root = repoRootOf(cwd);
  if (!root) {
    throw new RelayError(`${cwd} 还不是接力项目（没有 git 记录）。先执行 relay init，或在接力台里按「设为接力项目」。`, 'not-git');
  }
  return root;
}

export function headSha(cwd: string): string | null {
  const r = git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
  return r.code === 0 && r.stdout ? r.stdout : null;
}

/** 当前分支名；分离 HEAD 或还没有提交时返回 null。 */
export function currentBranch(cwd: string): string | null {
  const r = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return r.code === 0 && r.stdout ? r.stdout : null;
}

export function mergeBase(cwd: string, a: string, b: string): string | null {
  const r = git(cwd, ['merge-base', a, b]);
  return r.code === 0 && r.stdout ? r.stdout : null;
}

export function revExists(cwd: string, rev: string): boolean {
  return git(cwd, ['rev-parse', '--verify', '-q', `${rev}^{commit}`]).code === 0;
}

/** worktree 里是否有一个没收尾的 merge（同步主线时有冲突）。 */
export function mergeInProgress(cwd: string): boolean {
  const r = git(cwd, ['rev-parse', '--git-path', 'MERGE_HEAD']);
  if (r.code !== 0) return false;
  const p = path.isAbsolute(r.stdout) ? r.stdout : path.join(cwd, r.stdout);
  return fs.existsSync(p);
}

/** 会话锁是框架的临时文件，永远不进提交。 */
export const LOCK_REL = '.relay/session.lock';

/**
 * 尊重 .gitignore 后 add -A 并提交（检查点协议）。锁文件除外。
 * 返回新提交 SHA；没有可提交的内容返回 null。
 */
export function commitAll(worktree: string, message: string): string | null {
  const add = git(worktree, ['add', '-A', '--', '.', `:(exclude)${LOCK_REL}`]);
  if (add.code !== 0) throw new RelayError(`暂存改动失败：${add.stderr || add.stdout}`, 'git');
  const staged = git(worktree, ['diff', '--cached', '--quiet']);
  if (staged.code === 0 && !mergeInProgress(worktree)) return null;
  const c = relayCommit(worktree, message);
  if (c.code !== 0) throw new RelayError(`提交失败：${c.stderr || c.stdout}`, 'git');
  return gitOk(worktree, ['rev-parse', 'HEAD']);
}

export function shortSha(sha: string | null | undefined): string {
  return (sha ?? '').slice(0, 9) || '?';
}
