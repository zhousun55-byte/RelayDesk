/**
 * 全自动流水线里的审查：把「任务 + 全部改动 + 检查结果 + 上一轮意见」交给另一个 AI，
 * 让它只输出一个 JSON 结论。解析要宽容（模型爱加代码块、前后说废话）。
 */

export interface Verdict {
  verdict: 'pass' | 'fix';
  summary: string;
  issues: string[];
}

/** 找出文本里所有顶层的 {...}（认字符串里的括号和转义）。 */
export function jsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      if (depth > 0) inStr = true;
    } else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

function normVerdict(v: unknown): 'pass' | 'fix' | null {
  const t = String(v ?? '').trim().toLowerCase();
  if (['pass', 'passed', 'approve', 'approved', 'ok', 'lgtm', 'accept', '通过', '合格'].includes(t)) return 'pass';
  if (['fix', 'fail', 'failed', 'reject', 'rejected', 'changes', 'needs_changes', 'needs-changes', 'request_changes', 'revise', '不通过', '要改', '修改'].includes(t)) return 'fix';
  return null;
}

/** 从审查员的回答里取结论：从后往前找第一个带 verdict 的 JSON。找不到返回 null。 */
export function parseVerdict(text: string): Verdict | null {
  const objs = jsonObjects(text);
  // 前面的废话里有落单的「{」时，整段会被当成一个没闭合的对象：再从每个 {"verdict" 处单独找一次。
  for (const m of text.matchAll(/\{\s*"(?:verdict|result|decision)"/g)) {
    const first = jsonObjects(text.slice(m.index ?? 0))[0];
    if (first) objs.push(first);
  }
  for (let i = objs.length - 1; i >= 0; i--) {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(objs[i]) as Record<string, unknown>;
    } catch {
      continue;
    }
    const v = normVerdict(j.verdict ?? j.result ?? j.decision);
    if (!v) continue;
    const issuesIn = j.issues ?? j.problems ?? j.changes ?? [];
    const issues = (Array.isArray(issuesIn) ? issuesIn : [issuesIn])
      .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? JSON.stringify(x) : String(x ?? '')))
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 30);
    const summary = String(j.summary ?? j.reason ?? j.comment ?? '').trim().slice(0, 1000);
    // 判了 fix 却一条问题都没列：当成 fix，但把总结当问题。
    if (v === 'fix' && issues.length === 0 && summary) issues.push(summary);
    return { verdict: v, summary: summary || (v === 'pass' ? '审查通过。' : '需要修改。'), issues };
  }
  return null;
}

export interface ReviewInput {
  taskText: string;
  round: number;
  implementer: string;
  selfNote?: string;
  gate: { status: 'pass' | 'fail'; command: string; detail?: string } | null;
  previous: { reviewer: string; issues: string[] } | null;
  protectedHits: string[];
  diffstat: string;
  diff: string;
}

/** 审查请求（写进隔离副本的 .relay/review-request.md，接口型审查员直接收全文）。 */
export function buildReviewRequest(r: ReviewInput): string {
  const s: string[] = [
    '# 审查请求（接力台全自动流水线）',
    '',
    '你是审查员：只读不改。不要修改任何文件，不要执行会改变东西的命令。',
    '',
    '## 任务',
    r.taskText.trim(),
    '',
    `## 这是第 ${r.round} 轮，干活的是：${r.implementer}`,
    '',
  ];
  if (r.selfNote?.trim()) s.push('## 干活的人自己说（不一定可信，以改动为准）', r.selfNote.trim().slice(0, 3000), '');
  if (r.previous?.issues.length) {
    s.push(`## 上一轮 ${r.previous.reviewer} 提的问题（逐条看有没有改好）`, ...r.previous.issues.map((x, i) => `${i + 1}. ${x}`), '');
  }
  if (r.gate) {
    s.push(
      '## 检查命令',
      r.gate.status === 'pass' ? `\`${r.gate.command}\`：通过` : `\`${r.gate.command}\`：**没通过**\n\n\`\`\`\n${(r.gate.detail ?? '').slice(-3000)}\n\`\`\``,
      ''
    );
  }
  if (r.protectedHits.length) s.push('## 改到了不许改的文件', r.protectedHits.join('、'), '');
  s.push(
    '## 全部改动（相对正式文件夹）',
    '```',
    r.diffstat.trim() || '（没有改动）',
    '```',
    '',
    '```diff',
    r.diff.trim() || '（没有改动）',
    '```',
    '',
    '需要看上下文时，可以直接读当前文件夹里的文件（这就是改完后的样子）。',
    '',
    '## 你要输出',
    '只输出一个 JSON 对象，不要代码块，不要别的文字：',
    '{"verdict": "pass 或 fix", "summary": "一两句话的总评", "issues": ["必须修改的问题，每条一句，写清楚哪个文件、怎么改"]}',
    '',
    '判定标准：',
    '- 任务要求都做到了、没有明显错误、没有破坏原有功能、检查命令通过 → pass（issues 为空数组）。',
    '- 否则 → fix，issues 只列必须改的；风格偏好、可有可无的优化不要列。',
    '- 用中文。'
  );
  return s.join('\n');
}

/** 给编程工具型审查员的一句话（完整材料在文件里）。 */
export const REVIEW_PROMPT =
  '你是代码审查员，只读不改。请完整阅读当前文件夹里的 .relay/review-request.md，按其中「你要输出」的要求，只输出一个 JSON 对象作为最终回答。';

/** 给编程工具型干活者的一句话（完整说明在 ONBOARD.md）。 */
export const WORK_PROMPT = [
  '你在「接力台」的全自动流水线里工作：没有人会回答你的问题，也不需要等人确认，直接干。',
  '1. 先完整阅读当前文件夹里的 .relay/ONBOARD.md（任务、上一轮审查意见、规矩都在里面）。',
  '2. 在当前文件夹里把任务做完；能验证就自己验证（跑测试 / 构建）。',
  '3. 结束前把三行总结写进 .relay/NOTE.md：做到哪了 / 下一步 / 没验证的假设。',
  '4. 不要 git commit（接力台交接时会自动存检查点），不要切换分支、rebase、reset；不要改 .relay/ 里除 NOTE.md 以外的文件。',
  '5. 只读写当前文件夹里的东西，不要去翻别的目录（包括接力台自己的程序）。做完就结束。',
].join('\n');
