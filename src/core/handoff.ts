import type { GateResult } from './gate';
import type { JournalEvent } from './types';

export function buildInitialHandoff(
  taskTitle: string,
  branch: string,
  baseCommit: string,
  startedAt: string
): string {
  return `# 交接文档（relay）

> 事实段由框架生成，以 git 为准；「建议的下一步」为模型生成，仅供参酌。

## 任务
${taskTitle}（分支 \`${branch}\`）

## 检查点（rollback 目标）
- 当前：（尚未产生 handoff 检查点；start 首提交见 journal）
- 主线基准：\`${baseCommit}\`
- 开始时间：${startedAt}

## 本段业务改动
（尚未开始）

## 门禁
（尚未运行）

## 审计
（尚未运行）

## 前任
（无）

## 建议的下一步（模型生成，非事实）
> ⚠ 本节由 LLM 生成，是评论不是历史。

（无：任务刚开始）
`;
}

export interface HandoffFactsInput {
  taskTitle: string;
  branch: string;
  checkpoint: string;
  prevCheckpoint: string | null;
  diffstat: string;
  gate: GateResult;
  auditPath: string;
  auditStatus: 'ok' | 'failed';
  agent: string;
  tier: string | null;
  llm?: string;
  protectedHits: string[];
  ts: string;
}

/**
 * handoff.md 生成规则：框架填全部事实段；
 * 模型只准出现「建议的下一步」一节且必须标注生成内容。
 */
export function buildHandoffDoc(input: HandoffFactsInput, modelNext: string | null): string {
  return `# 交接文档（relay）

> 事实段由框架生成，以 git 为准；「建议的下一步」为模型生成，仅供参酌。
> 生成时间：${input.ts}

## 任务
${input.taskTitle}（分支 \`${input.branch}\`）

## 检查点（rollback 目标）
- 当前：\`${input.checkpoint}\`
- 上一：${input.prevCheckpoint ? `\`${input.prevCheckpoint}\`` : '（无，本段为第一段）'}

## 本段业务改动（相对上一检查点，不含 .relay）
\`\`\`
${input.diffstat}
\`\`\`

## 门禁
- ${input.gate.status === 'pass' ? '通过' : '未通过'}（命令：${input.gate.command}）
${input.gate.status === 'fail' && input.gate.detail.trim() !== '' ? `- 输出：\n\`\`\`\n${input.gate.detail.slice(0, 800)}\n\`\`\`` : ''}

## 审计
- 报告：${input.auditPath}（${input.auditStatus === 'ok' ? '阅读面已生成' : '仅事实报告（阅读面失败或未配置）'}）

## 保护路径
${input.protectedHits.length > 0 ? `⚠ 命中：${input.protectedHits.join('、')}（relay merge 将拒绝，除非 --force）` : '（无命中）'}

## 前任
- agent：${input.agent}${input.llm ? ` · ${input.llm}` : ''}${input.tier ? `（tier=${input.tier}）` : ''}

## 建议的下一步（模型生成，非事实）
> ⚠ 本节由 LLM 生成，是评论不是历史；以下方 git 事实为准。

${modelNext ?? '（本次未生成）'}
`;
}

export interface MergeReportInput {
  taskTitle: string;
  branch: string;
  baseCommit: string;
  events: JournalEvent[];
}

/** 主线 squash 提交的信息：从 journal 生成按时间分段的参与记录（agent 问责链）。 */
export function buildMergeMessage(input: MergeReportInput): string {
  const lines: string[] = [];
  for (const ev of input.events) {
    switch (ev.type) {
      case 'start':
        lines.push(`- start @ ${ev.ts}（首提交 ${short(ev.commit)}）`);
        break;
      case 'run':
        lines.push(
          `- run ${ev.agent ?? '?'}（${ev.tier ?? '?'}）@ ${ev.ts}` +
            `${ev.overrode ? `（--force 覆盖了 ${ev.overrode} 的软锁）` : ''}`
        );
        break;
      case 'open':
        lines.push(
          `- open ${ev.agent ?? '?'}（${ev.tier ?? '?'}）@ ${ev.ts}` +
            `${ev.overrode ? `（--force 覆盖了 ${ev.overrode} 的软锁）` : ''}`
        );
        break;
      case 'exit':
        lines.push(`  - exit code=${ev.code}${ev.quotaHint ? '（疑似额度耗尽，尽力而为的标记）' : ''}`);
        break;
      case 'gate':
        lines.push(`  - gate ${ev.status}（${ev.command}）`);
        break;
      case 'audit':
        lines.push(`  - audit ${ev.status}（${ev.report}）`);
        break;
      case 'handoff':
        lines.push(`  - handoff checkpoint ${short(ev.checkpoint)} @ ${ev.ts}`);
        break;
      case 'rollback':
        lines.push(`  - rollback → ${short(ev.to)} @ ${ev.ts}`);
        break;
      case 'abandon':
        lines.push(`- abandon @ ${ev.ts}`);
        break;
      case 'merge':
        break;
    }
  }
  return [
    `relay: merge ${input.branch}`,
    '',
    `任务: ${input.taskTitle}`,
    `接力分支: ${input.branch}（已保留备查；完整过程见该分支 .relay/journal.jsonl 与 audits/）`,
    `主线基准: ${short(input.baseCommit)}`,
    '',
    '参与记录（由 journal 生成）:',
    ...lines,
  ].join('\n');
}

function short(sha: string | undefined): string {
  return (sha ?? '').slice(0, 9) || '?';
}
