import path from 'node:path';
import { relayHome, repoKey } from './session';

/** 协议三：worktree 一律建在仓库外 ~/.relay/worktrees/<repoKey>/<slug>-<id>。 */
export function worktreePathFor(repoRoot: string, branch: string): string {
  const base = path.basename(branch);
  return path.join(relayHome(), 'worktrees', repoKey(repoRoot), base);
}
