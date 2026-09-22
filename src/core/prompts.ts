import type { Tier } from './types';

/** 唯一允许喂给 agent 进程的一句话（协议一）。 */
export const ONBOARD_HINT = '先读 .relay/ONBOARD.md 再开工。（relay 上岗指令）';

export interface OnboardInput {
  taskTitle: string;
  /** task.md 全文 */
  taskBody: string;
  branch: string;
  worktree: string;
  /** 自审基准：上一检查点（或 start 首提交）。 */
  reviewBase: string;
  /** 上一位干活的 agent；null = 你是第一位。 */
  predecessor: { agent: string; tier: Tier } | null;
  /** 当前 handoff.md 全文（框架事实段 + 模型建议节）。 */
  handoffDoc: string | null;
  latestAudit: { path: string; content: string } | null;
  protectedPaths: string[];
  generatedAt: string;
}

/** 纯函数：拼上岗词。改动这里 = 改协议一的呈现，须连同单测一起改。 */
export function buildOnboard(input: OnboardInput): string {
  const weak = input.predecessor !== null && input.predecessor.tier === 'weak';
  const sections: string[] = [];

  sections.push(`# 上岗词（relay）

> 本文件由 relay 框架生成，供接手的 agent 阅读。生成时间：${input.generatedAt}

## 你的任务
${input.taskBody}

## 环境事实
- 分支：\`${input.branch}\`（你只能在这个 worktree 里改动：\`${input.worktree}\`）
- 自审基准 commit：\`${input.reviewBase}\`
- 任务标题：${input.taskTitle}
`);

  sections.push(`## 交接事实（框架生成，以 git 为准）
${input.handoffDoc ?? '（你是第一位接手者，无前任。）'}
`);

  sections.push(`## 前任审计报告
${input.latestAudit ? `（${input.latestAudit.path}）\n\n${input.latestAudit.content}` : '（无）'}
`);

  if (weak && input.predecessor) {
    sections.push(`## 强制自审（前任为 weak agent）
前任 \`${input.predecessor.agent}\`（tier=weak）。动工之前必须：
1. \`git diff ${input.reviewBase}..HEAD --stat\` 总览改动；\`git diff ${input.reviewBase}..HEAD\` 逐文件细审（别忘了未跟踪文件：\`git status --porcelain\`）。
2. 好的改动：保留，并在其上继续推进任务。
3. 坏的改动：按文件定点回滚 \`git checkout ${input.reviewBase} -- <file>\`，不要整体回档、不要 rebase/amend。
`);
  }

  sections.push(`## 工作纪律
- ${input.protectedPaths.length > 0 ? `禁止改动保护路径：${input.protectedPaths.join('、')}` : '保护路径：未配置'}
- 只做增量提交；不要 rebase、不要 amend 已有提交。
- 完成或中断（含额度耗尽）后，提醒操作者执行 \`relay handoff\` 完成交接。
`);

  return sections.join('\n');
}
