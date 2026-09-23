import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from '../core/errors';
import { commitAll, git, shortSha } from '../core/git';
import { appendEvent, checkpoints, type CheckpointInfo } from '../core/journal';
import { assertFree } from '../core/lock';
import { isRelayPath } from '../core/status';
import { openTask } from './context';

export function listCheckpoints(dir: string): CheckpointInfo[] {
  const ctx = openTask(dir);
  return checkpoints(ctx.events, ctx.session.startCommit);
}

function lsTree(cwd: string, rev: string): string[] {
  return git(cwd, ['ls-tree', '-r', '-z', '--name-only', rev], { raw: true })
    .stdout.split('\0')
    .filter((p) => p && !isRelayPath(p));
}

/**
 * 退回到某个检查点。不改写历史：新提交一个「文件内容和那个检查点一模一样」的版本，
 * 交接记录、审计报告都还在，退回本身也记一笔。只动隔离副本，正式文件夹不碰。
 * 还没交接的改动会被丢掉（网页上会先确认）。
 */
export function rollback(dir: string, target: string): { to: string; label: string; ts: string } {
  const ctx = openTask(dir);
  const { wt, events, session } = ctx;
  assertFree(wt, '退回');
  const cps = checkpoints(events, session.startCommit);
  const t = target.trim();
  const hit = cps.find((c) => c.sha === t || (t.length >= 4 && c.sha.startsWith(t)));
  if (!hit) throw new RelayError(`${t} 不是这个任务的检查点。relay rollback 不带参数可以看列表。`, 'bad-checkpoint');

  // 1. 丢掉没提交的业务改动和新建的文件（.relay 和被忽略的文件不动）。
  git(wt, ['reset', '-q']);
  git(wt, ['checkout', '--', '.', ':(exclude).relay']);
  git(wt, ['clean', '-fdq', '--', '.', ':(exclude).relay']);
  // 2. 检查点之后新增的文件删掉；其余文件恢复成检查点的样子。
  const want = new Set(lsTree(wt, hit.sha));
  for (const f of lsTree(wt, 'HEAD')) {
    if (!want.has(f)) {
      git(wt, ['rm', '-q', '-f', '--', f]);
      fs.rmSync(path.join(wt, f), { force: true });
    }
  }
  if (want.size > 0) {
    const r = git(wt, ['checkout', hit.sha, '--', '.', ':(exclude).relay']);
    if (r.code !== 0) throw new RelayError(`退回失败：${r.stderr || r.stdout}`, 'git');
  }
  appendEvent(wt, { ts: new Date().toISOString(), type: 'rollback', to: hit.sha, worktree: wt });
  commitAll(wt, `接力：退回到 ${shortSha(hit.sha)}`);
  return { to: hit.sha, label: hit.agent, ts: hit.ts };
}
