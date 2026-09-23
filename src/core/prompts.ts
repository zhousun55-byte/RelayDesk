import type { ReviewTarget } from './journal';
import { agentLabel } from './registry';
import type { Tier } from './types';

/** 唯一喂给工人的一句话：让它先去读上岗说明。桌面工人会被复制到剪贴板。 */
export const ONBOARD_HINT = '请先完整阅读当前文件夹里的 .relay/ONBOARD.md（接力上岗说明），然后按里面的要求开始工作。';

/** 工人停手前写自述的地方。交接时接力台会读走它、写进交接文档，然后删掉。 */
export const NOTE_REL = '.relay/NOTE.md';

export interface OnboardInput {
  taskTitle: string;
  /** task.md 全文。 */
  taskBody: string;
  branch: string;
  worktree: string;
  you: { agent: string; label: string; tier: Tier; llm?: string };
  /** 要审的上一段（最近一次有改动的交接）；null = 没有。 */
  review: (ReviewTarget & { label?: string }) | null;
  handoffDoc: string | null;
  latestAudit: { path: string; content: string } | null;
  protectedPaths: string[];
  gateCommand: string;
  /** 同步正式文件夹时留下的冲突文件。 */
  conflicts: string[];
  generatedAt: string;
  /** 全自动流水线派的活：没有人在场；上一轮审查意见必须逐条处理。 */
  auto?: AutoBrief;
}

export interface AutoBrief {
  round: number;
  /** 上一轮审查（要求修改时）。 */
  review: { reviewer: string; summary: string; issues: string[] } | null;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}\n\n…（后面还有，太长没放进来）` : t;
}

/** 纯函数：拼上岗说明。改这里等于改上岗协议，测试要一起改。 */
export function buildOnboard(input: OnboardInput): string {
  const me = `${input.you.label}${input.you.llm ? ` · ${input.you.llm}` : ''}`;
  const s: string[] = [];
  s.push(
    `# 上岗说明（接力台）`,
    '',
    `> 生成于 ${input.generatedAt}。这一棒是你：**${me}**。`,
    '',
    '## 任务',
    input.taskBody.trim() || input.taskTitle,
    '',
    '## 你在哪里干活',
    `- 当前文件夹是这个任务的**隔离副本**（分支 \`${input.branch}\`）：\`${input.worktree}\``,
    input.auto
      ? '- 只在这里改。正式文件夹不用管：你做完后，接力台会自动交接、请另一个 AI 审查，通过了自动合回。'
      : '- 只在这里改。正式文件夹不用管，做完后由人来「合回」。',
    ''
  );
  if (input.auto) {
    s.push('## 全自动模式', `这是全自动流水线的第 ${input.auto.round} 轮。没有人会回答你的问题，也不要等人确认：自己判断，直接做完。`, '');
    const rv = input.auto.review;
    if (rv) {
      s.push(
        `## 上一轮审查意见（${rv.reviewer}，必须逐条处理）`,
        rv.summary,
        '',
        ...rv.issues.map((x, i) => `${i + 1}. ${x}`),
        '',
        '改完后在 `.relay/NOTE.md` 里逐条说明每个问题是怎么处理的。',
        ''
      );
    }
  }

  const r = input.review;
  if (r) {
    const who = r.label ?? agentLabel(r.agent);
    if (r.tier === 'weak') {
      s.push(
        '## 第一件事：审查上一位的改动（必须）',
        `上一位是 **${who}${r.llm ? ` · ${r.llm}` : ''}**，能力标记为「弱」。动手前必须先审它的改动：`,
        `1. \`git diff --stat ${r.from}..${r.to}\` 看改了哪些文件；\`git diff ${r.from}..${r.to}\` 逐个文件细看。`,
        '2. 好的留下，在它的基础上继续。',
        `3. 坏的按文件退回：\`git checkout ${r.from} -- <文件>\`。不要整体回档，不要 rebase / amend / reset。`,
        ''
      );
    } else {
      s.push(
        '## 上一位做了什么',
        `上一位是 **${who}${r.llm ? ` · ${r.llm}` : ''}**。它的全部改动：\`git diff ${r.from}..${r.to}\`。`,
        '动手前先看一眼，确认它说「做完了」的地方真的做完了。',
        ''
      );
    }
  }

  if (input.conflicts.length) {
    s.push(
      '## 先解决合并冲突',
      `同步正式文件夹时，这些文件两边都改了：${input.conflicts.map((f) => `\`${f}\``).join('、')}。`,
      '打开它们，把 `<<<<<<<` 和 `>>>>>>>` 之间的内容合成正确的版本，删掉这些标记。解决完才能交接。',
      ''
    );
  }

  s.push('## 交接文档（上一次交接时生成）', input.handoffDoc ? clip(input.handoffDoc, 8000) : '（你是第一位，还没有交接过。）', '');
  if (input.latestAudit) {
    s.push(`## 最近一份审计报告（${input.latestAudit.path}）`, clip(input.latestAudit.content, 8000), '');
  }

  s.push('## 规矩');
  if (input.protectedPaths.length) s.push(`- 不许改：${input.protectedPaths.map((p) => `\`${p}\``).join('、')}`);
  if (input.gateCommand.trim()) s.push(`- 交接时会自动跑检查命令 \`${input.gateCommand.trim()}\`，停手前最好自己先跑一遍。`);
  s.push(
    input.auto
      ? '- 不要 git commit（接力台交接时会自动存检查点）；不要 rebase、amend、reset，也不要切换分支。只读写当前文件夹，不要去翻别的目录。'
      : '- 可以 git commit，但不要 rebase、amend、reset，也不要切换分支。',
    '- 不要改 `.relay/` 里的文件（`.relay/NOTE.md` 除外）。',
    '',
    '## 停手之前（重要）',
    `1. 把下面三行写进 \`${NOTE_REL}\`（没有就新建），留给下一位：`,
    '   - 做到哪了：……',
    '   - 下一步：……（写成能直接照做的一句话；想不清楚就写「卡在：……」）',
    '   - 没验证的假设：……（你以为是对的、但没亲自验证过的地方；没有就写「无」）',
    input.auto ? '2. 然后直接结束（退出），接力台会自动交接。' : '2. 告诉用户：可以去接力台点「交接」了。',
    ''
  );
  return s.join('\n');
}
