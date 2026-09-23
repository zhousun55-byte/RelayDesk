import fs from 'node:fs';
import path from 'node:path';
import { loadRelayConfig } from '../core/config';
import { RelayError } from '../core/errors';
import { commitAll, currentBranch, git, headSha, requireRepoRoot, shortSha } from '../core/git';
import { buildInitialHandoff } from '../core/handoff-doc';
import { appendEvent } from '../core/journal';
import { worktreePathFor } from '../core/paths';
import { ensureProjectCommitted, ensureRelayGitignore, inspectProject, setupProject } from '../core/project';
import { loadSession, saveSession } from '../core/session';
import { branchNameFor } from '../core/slug';
import { snapshotMain } from '../core/status';

export interface StartInput {
  /** 要做什么。第一行当标题，其余当细节。 */
  task: string;
  /** 验收标准（可选）。 */
  acceptance?: string;
}

export interface StartResult {
  root: string;
  title: string;
  branch: string;
  worktree: string;
  base: string;
  notes: string[];
}

export function taskTitleOf(task: string): string {
  const first = task.trim().split('\n')[0].trim();
  return first.length > 80 ? `${first.slice(0, 80)}…` : first;
}

export function startTask(dir: string, input: StartInput): StartResult {
  const task = input.task.trim();
  if (!task) throw new RelayError('先写下要做什么。', 'no-title');
  const notes: string[] = [];

  const info = inspectProject(dir);
  if (!info.isGit || !info.hasConfig || !info.hasCommits) {
    const setup = setupProject(dir);
    if (setup.actions.length) notes.push(`先把这个文件夹设为接力项目：${setup.actions.join('；')}。`);
  }
  const root = requireRepoRoot(dir);
  loadRelayConfig(root);
  if (loadSession(root)) {
    throw new RelayError('这个项目已经有一个进行中的任务。先合回或放弃它，再开始新的。', 'has-task');
  }
  const mainBranch = currentBranch(root);
  if (!mainBranch) {
    throw new RelayError('正式文件夹现在不在任何分支上（git 处于分离状态）。先切回主分支（如 git switch main）。', 'detached');
  }
  ensureRelayGitignore(root);
  if (ensureProjectCommitted(root)) notes.push('把接力配置提交进了正式文件夹。');
  const base = headSha(root);
  if (!base) throw new RelayError('正式文件夹还没有任何提交。', 'no-commit');

  const snapshot = snapshotMain(root);
  const dirtyCount = Object.keys(snapshot).filter((k) => k !== '*').length;
  if (dirtyCount > 0 || snapshot['*']) {
    notes.push(`正式文件夹里有 ${snapshot['*'] ? '很多' : dirtyCount} 个没提交的改动，它们不会带进这个任务。`);
  }

  let picked: { slug: string; id: string; branch: string } | null = null;
  let wt = '';
  for (let i = 0; i < 8 && !picked; i++) {
    const cand = branchNameFor(taskTitleOf(task));
    const exists = git(root, ['rev-parse', '--verify', '-q', `refs/heads/${cand.branch}`]).code === 0;
    const dirPath = worktreePathFor(root, cand.branch);
    if (!exists && !fs.existsSync(dirPath)) {
      picked = cand;
      wt = dirPath;
    }
  }
  if (!picked) throw new RelayError('没能给任务起一个不重名的分支，请重试。', 'branch');
  const { branch, slug, id } = picked;

  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const added = git(root, ['worktree', 'add', '-q', '-b', branch, wt, base]);
  if (added.code !== 0) throw new RelayError(`没能建立隔离副本：${added.stderr || added.stdout}`, 'git');

  try {
    const title = taskTitleOf(task);
    const startedAt = new Date().toISOString();
    fs.mkdirSync(path.join(wt, '.relay', 'audits'), { recursive: true });
    const acceptance = input.acceptance?.trim() || '（没写。做完后由人判断。）';
    fs.writeFileSync(path.join(wt, '.relay', 'task.md'), `# 任务\n\n${task}\n\n## 验收标准\n\n${acceptance}\n`);
    fs.writeFileSync(path.join(wt, '.relay', 'handoff.md'), buildInitialHandoff(title, branch, base, startedAt));
    // 先记事件再提交：开始那个提交里就带着 journal，退回到开始时账本还在。
    appendEvent(wt, { ts: startedAt, type: 'start', task, branch, commit: base, worktree: wt });
    const startSha = commitAll(wt, `relay: start ${slug}-${id}`);
    if (!startSha) throw new RelayError('开始提交没有生成。', 'git');
    saveSession({
      repoRoot: root,
      branch,
      worktree: wt,
      taskTitle: title,
      baseCommit: base,
      startCommit: startSha,
      startedAt,
      mainBranch,
      mainSnapshot: snapshot,
    });
    return { root, title, branch, worktree: wt, base: shortSha(base), notes };
  } catch (e) {
    git(root, ['worktree', 'remove', '--force', wt]);
    fs.rmSync(wt, { recursive: true, force: true });
    git(root, ['worktree', 'prune']);
    git(root, ['branch', '-D', branch]);
    throw e;
  }
}
