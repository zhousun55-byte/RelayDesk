import { spawnSync } from 'node:child_process';
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
  if (r.error) throw new RelayError(`没能执行 git：${r.error.message}`, 'no-git');
  const stdout = r.stdout ?? '';
  return { code: r.status ?? -1, stdout: opts.raw ? stdout : stdout.trim(), stderr: (r.stderr ?? '').trim() };
}
