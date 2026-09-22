import { git } from './git';
import type { RelayConfig } from './types';

/** 简易 glob：** 跨目录，* 不跨目录，? 单字符。 */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * 自 base 以来（不含 .relay）改动并命中保护路径的文件。
 * head 给定时比已提交范围 base..head（handoff 在 checkpoint 之后调用，传检查点 SHA，
 * 不依赖工作区现状）；不给 head 时看工作区现状（含未提交与未跟踪，status 面板用）。
 */
export function protectedHits(worktree: string, cfg: RelayConfig, base: string, head?: string): string[] {
  if (cfg.protectedPaths.length === 0) return [];
  const range = head === undefined ? base : `${base}..${head}`;
  const changed = git(worktree, ['diff', '--name-only', range, '--', '.', ':(exclude).relay'])
    .stdout.split('\n')
    .filter((l) => l.trim() !== '');
  // head 给定时检查点已 add -A，未跟踪必为空；保留扫描只为兼容「看现状」的调用方
  const untracked = git(worktree, ['ls-files', '--others', '--exclude-standard', '--', '.', ':(exclude).relay'])
    .stdout.split('\n')
    .filter((l) => l.trim() !== '');
  const regexes = cfg.protectedPaths.map((p) => globToRegExp(p));
  return [...changed, ...untracked].filter((f) => regexes.some((re) => re.test(f)));
}
