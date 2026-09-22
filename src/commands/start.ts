import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { commitAll, git, gitOk, repoRootAt } from '../core/git';
import { loadRelayConfig } from '../core/config';
import { appendEvent } from '../core/journal';
import { loadSession, saveSession } from '../core/session';
import { branchNameFor } from '../core/slug';
import { buildInitialHandoff } from '../core/handoff';
import { worktreePathFor } from '../core/worktree';

export function startCommand(): Command {
  const cmd = new Command('start');
  cmd.description('开始一个任务：创建 relay/* 分支与仓库外 worktree（主线保持干净）');
  cmd.argument('<task>', '任务描述（完整标题存 .relay/task.md）');
  cmd.action((task: string) => {
    const root = repoRootAt(process.cwd());
    loadRelayConfig(root);
    if (loadSession(root)) {
      throw new Error('已有活跃任务（单仓库单任务）。先 relay merge 或 relay abandon 收尾，再开始新任务。');
    }

    const { slug, id, branch } = branchNameFor(task);
    const base = gitOk(root, ['rev-parse', 'HEAD']);
    const wt = worktreePathFor(root, branch);
    if (fs.existsSync(wt)) {
      throw new Error(`worktree 目录已存在：${wt}。请先清理（relay abandon 或 git worktree prune）。`);
    }

    const added = git(root, ['worktree', 'add', '-b', branch, wt]);
    if (added.code !== 0) throw new Error(`创建 worktree 失败：${added.stderr}`);

    // 会话文件只活在 relay 分支（协议三）
    fs.mkdirSync(path.join(wt, '.relay', 'audits'), { recursive: true });
    const startedAt = new Date().toISOString();
    fs.writeFileSync(path.join(wt, '.relay', 'task.md'), `# 任务\n\n${task}\n\n## 验收标准\n\n（待补充）\n`);
    fs.writeFileSync(path.join(wt, '.relay', 'handoff.md'), buildInitialHandoff(task, branch, base, startedAt));

    // 先记事件再提交：start 提交的树里必须有 journal（rollback 到 start 后仍能读到它）。
    // 事件里的 commit 是主线基准；首提交 SHA 自己不可能装进自己的树，记在会话指针 startCommit。
    appendEvent(wt, {
      ts: startedAt,
      type: 'start',
      task,
      branch,
      commit: base,
      worktree: wt,
    });

    const startSha = commitAll(wt, `relay: start ${slug}-${id}`);
    if (!startSha) throw new Error('start 提交失败：worktree 为空。');

    saveSession({
      repoRoot: root,
      branch,
      worktree: wt,
      taskTitle: task,
      baseCommit: base,
      startCommit: startSha,
      startedAt,
    });

    console.log(`任务已开始`);
    console.log(`  标题：${task}`);
    console.log(`  分支：${branch}`);
    console.log(`  worktree：${wt}`);
    console.log(`  主线基准：${base.slice(0, 9)}`);
    console.log('');
    console.log(`下一步：relay run <工人名> 或 relay open <App名>（relay agents list 查看）`);
  });
  return cmd;
}
