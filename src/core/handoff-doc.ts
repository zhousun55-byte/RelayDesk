import type { GateResult } from './gate';
import { shortSha } from './git';
import { agentLabel } from './registry';
import type { JournalEvent, Tier } from './types';

const HEAD_NOTE = '> 事实段由接力台从 git 生成，以它为准。「留言」「自述」「建议的下一步」都是人或模型写的，只供参考。';

export function buildInitialHandoff(taskTitle: string, branch: string, baseCommit: string, startedAt: string): string {
  return `# 交接文档

${HEAD_NOTE}

## 任务
${taskTitle}

- 接力分支：\`${branch}\`
- 正式文件夹基准：\`${shortSha(baseCommit)}\`
- 开始时间：${startedAt}

## 这一段
还没有人交接过。

## 建议的下一步（模型生成，非事实）
（还没有）
`;
}

export interface HandoffDocInput {
  taskTitle: string;
  branch: string;
  agent: string;
  tier: Tier | null;
  llm?: string;
  base: string;
  checkpoint: string;
  empty: boolean;
  diffstat: string;
  /** null = 这一段没改动，没重跑检查，沿用上一次。 */
  gate: GateResult | null;
  auditPath: string;
  auditStatus: 'ok' | 'failed';
  modelNote: string | null;
  protectedHits: string[];
  note?: string;
  selfNote?: string;
  modelNext: string | null;
  ts: string;
}

/** 交接文档：接力台写全部事实；人和模型的话单独成节，并标明不是事实。 */
export function buildHandoffDoc(input: HandoffDocInput): string {
  const who = `${agentLabel(input.agent)}${input.llm ? ` · ${input.llm}` : ''}${input.tier ? `（${input.tier === 'weak' ? '弱' : '强'}）` : ''}`;
  const gate = input.gate
    ? `${input.gate.status === 'pass' ? '✅ 通过' : '❌ 没通过'}（命令：${input.gate.command}）` +
      (input.gate.status === 'fail' && input.gate.detail.trim() ? `\n\n\`\`\`\n${input.gate.detail.slice(-1500)}\n\`\`\`` : '')
    : '这一段没有改动，没有重跑（沿用上一次的结果）。';
  const sections = [
    `# 交接文档`,
    '',
    HEAD_NOTE,
    `> 生成时间：${input.ts}`,
    '',
    '## 任务',
    input.taskTitle,
    '',
    `- 接力分支：\`${input.branch}\``,
    '',
    '## 这一段',
    `- 谁：${who}`,
    `- 范围：\`${shortSha(input.base)}..${shortSha(input.checkpoint)}\`（检查点 \`${shortSha(input.checkpoint)}\` 可以退回）`,
    '',
    input.empty ? '这一段没有业务改动。' : '```\n' + input.diffstat + '\n```',
    '',
    '## 检查',
    gate,
    '',
    '## 保护路径',
    input.protectedHits.length ? `⚠ 改到了不许改的文件：${input.protectedHits.join('、')}（合回时会被拒绝）` : '没有碰。',
    '',
    '## 审计报告',
    `\`${input.auditPath}\`（${input.auditStatus === 'ok' ? '有模型阅读面' : `只有事实${input.modelNote ? `：${input.modelNote}` : ''}`}）`,
    '',
  ];
  if (input.note?.trim()) sections.push('## 交接留言（人写的）', input.note.trim(), '');
  if (input.selfNote?.trim()) sections.push('## 上一位的自述（它自己写的，不是事实）', input.selfNote.trim(), '');
  sections.push('## 建议的下一步（模型生成，非事实）', input.modelNext ?? '（这次没有）', '');
  return sections.join('\n');
}

export interface MergeMessageInput {
  taskTitle: string;
  branch: string;
  baseCommit: string;
  events: JournalEvent[];
}

/** 合回主线那个提交的说明：按 journal 列出谁在什么时候干了什么（问责链）。 */
export function buildMergeMessage(input: MergeMessageInput): string {
  const lines: string[] = [];
  const who = (ev: JournalEvent) => `${agentLabel(ev.agent ?? '?')}${ev.llm ? ` · ${ev.llm}` : ''}${ev.tier ? `（${ev.tier}）` : ''}`;
  for (const ev of input.events) {
    switch (ev.type) {
      case 'start':
        lines.push(`- 开始 @ ${ev.ts}`);
        break;
      case 'run':
      case 'open':
        lines.push(`- ${who(ev)} 上岗 @ ${ev.ts}${ev.overrode ? `（强行接替了 ${ev.overrode}）` : ''}`);
        break;
      case 'exit':
        lines.push(`  - 退出，代码 ${ev.code}`);
        break;
      case 'gate':
        lines.push(`  - 检查 ${ev.status === 'pass' ? '通过' : '没通过'}（${ev.command}）`);
        break;
      case 'audit':
        lines.push(`  - 审计 ${ev.report}`);
        break;
      case 'handoff':
        lines.push(`  - 交接，检查点 ${shortSha(ev.checkpoint)}${ev.empty ? '（没有改动）' : ev.files !== undefined ? `（${ev.files} 个文件）` : ''} @ ${ev.ts}`);
        break;
      case 'take':
        lines.push(`  - 从正式文件夹收进 ${ev.files.length} 个文件`);
        break;
      case 'sync':
        lines.push(`  - 同步主线 ${shortSha(ev.main)}${ev.conflicts?.length ? `（冲突：${ev.conflicts.join('、')}）` : ''}${ev.aborted ? '（已撤销）' : ''}`);
        break;
      case 'rollback':
        lines.push(`  - 退回到 ${shortSha(ev.to)} @ ${ev.ts}`);
        break;
      default:
        break;
    }
  }
  return [
    `relay: ${input.taskTitle.split('\n')[0].slice(0, 60)}`,
    '',
    `任务：${input.taskTitle}`,
    `接力分支：${input.branch}（保留备查；完整过程见该分支的 .relay/journal.jsonl 和 audits/）`,
    `正式文件夹基准：${shortSha(input.baseCommit)}`,
    '',
    '参与记录：',
    ...lines,
  ].join('\n');
}
