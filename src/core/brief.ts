import { acceptance } from './acceptance';
import type { LedgerView, Stint } from './ledger';
import { countedReviews, statusWord, stintTitle, tierWord, verdictWord } from './ledger';
import { BRIEF_REL, HANDOFF_DIR, handoffTemplate, reviewDiffFileFor, reviewFileFor, reviewTemplate, TASK_REL, VERDICT_CHOICES, type HandoffDoc, type TaskDoc } from './notes';
import { snapGit } from './snap';
import { stampLocal } from './time';

/**
 * 接力本 .relay/接力本.md：每个 AI 开工第一件事读它。接力台生成，AI 不改。
 * 要短：弱模型的上下文也装得下；要具体：命令、文件名都直接给出来，照着做就行。
 */

export interface BriefMember {
  label: string;
  model?: string;
  tier: 'strong' | 'weak';
}

export interface BriefInput {
  task: TaskDoc;
  ledger: LedgerView;
  /** 各棒的交接（按文件名取）。 */
  handoffs: Map<string, HandoffDoc>;
  members: BriefMember[];
  gateCommand: string;
  protectedPaths: string[];
  /** 配置文件坏了的原因（这时检查和不许改的文件都没法核对）。 */
  configError?: string;
  /** 全自动开着终审（验收要终审）。 */
  finalRequired?: boolean;
  /** 下一棒的编号（有进行中的就是它）。 */
  nextId: number;
  now: Date;
  /** 接力台正在调度的那一棒（给人看：现在谁在做）。 */
  running?: { label: string; since: string } | null;
}

function short(sha: string | undefined): string {
  return (sha ?? '').slice(0, 10);
}

function when(ts: string | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function factsLine(s: Stint): string {
  const f = s.facts;
  const parts = [f ? (f.files ? `改了 ${f.files} 个文件，+${f.added} −${f.removed}` : '没有改文件') : ''];
  if (s.gate) parts.push(s.gate.status === 'pass' ? '检查通过' : '检查没通过');
  if (s.protectedHits?.length) parts.push(`⚠ 改到了不许改的文件：${s.protectedHits.join('、')}`);
  return parts.filter(Boolean).join(' · ');
}

function quote(text: string, max = 600): string {
  const t = text.trim();
  if (!t) return '';
  const cut = t.length > max ? `${t.slice(0, max)}……` : t;
  return cut
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

function reviewBlock(s: Stint, h: HandoffDoc | undefined, gate: string, dropped: ReadonlySet<number>): string[] {
  const out = [`### ${stintTitle(s)}（${tierWord(s.who.tier)}）`, `- ${when(s.endedAt ?? s.startedAt)} · ${statusWord(s.status)} · ${factsLine(s)}`];
  if (h && !s.ghost) out.push(`- 它的交接：\`${s.handoff}\`（它自己说的，不一定对）`);
  else out.push('- 它没留交接（多半是额度用完被打断了），只能看改动本身。');
  if (s.to) {
    out.push(
      `- 真实改动：\`${reviewDiffFileFor(s.id)}\`；也可以自己看：\`${snapGit()} diff ${short(s.from)} ${short(s.to)}\``,
      `- 某个文件在它改之前的样子：\`${snapGit()} show ${short(s.from)}:文件路径\``
    );
  }
  for (const m of (s.reviews ?? []).filter((x) => x.weak)) out.push(`- ${m.byLabel} 复核过（\`${m.file}\`），但它是弱模型、或者是自己复核自己，不算数；可以参考，要你再核一遍。`);
  const last = countedReviews(s, dropped).at(-1);
  if (last) out.push(`- 上一次复核（${last.byLabel}）的结论是「${verdictWord(last.verdict)}」，见 \`${last.file}\`：这次要把里面的问题修好（或者补上验证），再重写结论。`);
  if (s.factsError) out.push(`- 接力台读不到这一棒的改动（${s.factsError}）：自己用上面的 diff 命令看，看不了就在结论里写「证据不足」。`);
  out.push(`- 结论写到：\`${reviewFileFor(s.id)}\``);
  if (gate) out.push(`- 检查命令：\`${gate}\``);
  return out;
}

export function buildBrief(input: BriefInput): string {
  const { task, ledger, handoffs } = input;
  const s: string[] = [];
  s.push('# 接力本', '', `> 接力台生成于 ${stampLocal(input.now)}。**别改这个文件**：进度写在 \`${TASK_REL}\`，交接写在 \`${HANDOFF_DIR}/\`。`, '');

  // 任务
  s.push('## 任务', '');
  if (task.empty) {
    s.push(`还没有写下任务。用户交给你的事，先写进 \`${TASK_REL}\`（一句话说清楚要做成什么样，再拆成几步），然后开始做。`, '');
  } else {
    s.push(task.body.length > 800 ? `${task.body.slice(0, 800)}……（完整的见 \`${TASK_REL}\`）` : task.body, '');
    if (task.items.length) {
      const done = task.items.filter((i) => i.done).length;
      s.push(`进度（${done}/${task.items.length}）：`, ...task.items.slice(0, 40).map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}`), '');
    } else {
      s.push(`还没拆成步骤：先在 \`${TASK_REL}\` 的「进度」里拆成几步（每步一行 \`- [ ] …\`）。`, '');
    }
    if (task.rules) s.push('约定（必须遵守）：', task.rules.length > 1200 ? `${task.rules.slice(0, 1200)}……` : task.rules, '');
  }

  // 验收：清单打勾不等于做完了
  const acc = acceptance({ ledger, task, gateCommand: input.gateCommand, ...(input.configError ? { configError: input.configError } : {}), finalRequired: input.finalRequired ?? true });
  s.push(`> 验收：${acc.headline}${acc.state === 'accepted' ? '' : '。清单打勾只说明「说做完了」，复核、终审、检查都过了才算做完。'}`, '');
  if (input.configError) s.push(`> 接力台的配置文件坏了（\`.relay/config.json\`）：${input.configError}。检查命令没法跑、不许改的文件也没法核对——别动它，也别在这个时候收工。`, '');

  // 现在
  const live = ledger.stints.filter((x) => !x.rolledBack);
  const dropped = new Set(ledger.stints.filter((x) => x.rolledBack).map((x) => x.id));
  const open = ledger.open;
  if (input.running) s.push(`> 现在：接力台正在调度 ${input.running.label}（从 ${when(input.running.since)} 开始）。`, '');
  else if (open && open.via === 'native') s.push(`> 现在：第 ${open.id} 棒还没交接（${open.who.label}，${when(open.startedAt)} 开始有改动）。如果那就是你，接着写你的交接就行。`, '');

  // 待复核
  const pending = live.filter((x) => x.review === 'needed' && x.status !== 'working');
  if (pending.length) {
    const strong = input.members.filter((m) => m.tier === 'strong');
    s.push(`## 先复核（${pending.length} 棒待复核）`, '');
    s.push(
      strong.length
        ? `**强模型开工先做这件事**；弱模型跳过这一节，直接接着干活（你的活之后也会被复核）。`
        : '现在名单里没有强模型；能复核的请先复核，不能的跳过。',
      ''
    );
    for (const p of pending.slice(-6)) s.push(...reviewBlock(p, p.handoff ? handoffs.get(p.handoff) : undefined, input.gateCommand, dropped), '');
    if (pending.length > 6) s.push(`（还有更早的 ${pending.length - 6} 棒，见 \`.relay/journal.jsonl\`）`, '');
    s.push(
      '复核怎么做：',
      '1. 先读它的交接，再逐个文件看真实改动：说做了的真做了吗？有没有没说的改动？有没有改错、改坏、偷工减料？',
      '2. 跑一遍检查（有检查命令的话），看看功能是不是真的能用。',
      '3. 发现问题直接改好（就在这个文件夹里改）；改得太乱的文件可以恢复成它改之前的样子（用上面的 show 命令）。',
      `4. 每一棒写一份结论。「结论」一行只写这几种之一：${VERDICT_CHOICES.join(' / ')}。没实际跑过检查、验证不了的写「证据不足」；问题没修完写「有问题，还没修」。接力台按这一行判断这一棒算不算复核过，只有「没问题 / 有问题，已修好 / 改坏了，已退回」算。格式：`,
      '',
      '```markdown',
      reviewTemplate('第 N 棒（它的工具 · 模型）').trim(),
      '```',
      ''
    );
  }

  // 复核发现但还没修的问题
  const unresolved = live
    .map((x) => ({ s: x, r: countedReviews(x, dropped).at(-1) }))
    .filter((x): x is { s: Stint; r: NonNullable<typeof x.r> } => !!x.r && (x.r.verdict === 'problem' || x.r.verdict === 'insufficient' || x.r.verdict === 'unknown'));
  if (unresolved.length) {
    s.push('## 复核发现、还没解决的问题', '');
    for (const { s: x, r } of unresolved.slice(-5)) s.push(`- 第 ${x.id} 棒：复核结论是「${verdictWord(r.verdict)}」，见 \`${r.file}\`（${r.byLabel} 复核）`);
    s.push('');
  }

  // 上一棒留的话
  const lastHanded = [...live].reverse().find((x) => x.status !== 'working' && x.kind !== 'review');
  if (lastHanded) {
    const h = lastHanded.handoff ? handoffs.get(lastHanded.handoff) : undefined;
    s.push('## 上一棒留的话', '', `${stintTitle(lastHanded)}（${tierWord(lastHanded.who.tier)}）· ${when(lastHanded.endedAt)} · ${statusWord(lastHanded.status)} · ${factsLine(lastHanded)}`, '');
    if (h && !lastHanded.ghost) {
      if (h.next) s.push('没做完 / 下一步：', quote(h.next), '');
      if (h.unsure) s.push('它不确定的地方：', quote(h.unsure, 400), '');
      if (!h.next && !h.unsure && h.did) s.push('做了什么：', quote(h.did), '');
      s.push(`全文：\`${lastHanded.handoff}\``, '');
    } else {
      s.push('它没留交接。先看看它改了什么（见上面的复核），再决定怎么接着做。', '');
    }
    if (lastHanded.note) s.push(`接力台的说明：${lastHanded.note}`, '');
  }

  // 最近几棒
  const recent = [...ledger.stints].reverse().filter((x) => x.status !== 'working').slice(0, 6);
  if (recent.length) {
    s.push('## 最近几棒', '');
    for (const x of recent) {
      const h = x.handoff ? handoffs.get(x.handoff) : undefined;
      const counted = countedReviews(x, dropped).at(-1);
      const rv = x.rolledBack
        ? '已退回（作废）'
        : x.review === 'needed'
          ? counted
            ? `待复核（上次结论：${verdictWord(counted.verdict)}）`
            : '待复核'
          : x.review === 'done' && counted
            ? `复核：${verdictWord(counted.verdict)}`
            : x.kind === 'final' && x.verdict
              ? `终审结论：${verdictWord(x.verdict)}`
              : '';
      const what = x.summary || h?.summary || '';
      s.push(`- ${stintTitle(x)}（${tierWord(x.who.tier)}）· ${when(x.endedAt)} · ${statusWord(x.status)}${rv ? ` · ${rv}` : ''}${what ? ` · ${what}` : ''}`);
    }
    s.push('');
  }
  if (ledger.lastRollback) {
    const r = ledger.lastRollback;
    const tk = r.task?.missing
      ? '任务清单是旧账本、没法跟着退回，先对照代码看看哪些步骤其实没做完，把勾去掉。'
      : r.task?.unchecked.length
        ? `任务清单里这几步的勾也去掉了，要重新做：${r.task.unchecked.slice(0, 6).join('、')}${r.task.unchecked.length > 6 ? ' ……' : ''}。`
        : '';
    if (r.dropped.length) s.push(`> ${when(r.ts)} 退回到了「${r.label}」：第 ${r.dropped.join('、')} 棒的改动已经不在了，别再按它们的交接往下做。${tk}`, '');
  }

  // 强弱名单
  const strong = input.members.filter((m) => m.tier === 'strong');
  const weak = input.members.filter((m) => m.tier === 'weak');
  const name = (m: BriefMember) => `${m.label}${m.model ? `（${m.model}）` : ''}`;
  s.push(
    '## 谁是强模型',
    '',
    `- 强：${strong.map(name).join('、') || '（还没有）'}`,
    `- 弱：${weak.map(name).join('、') || '（还没有）'}`,
    '- 看的是模型，不是工具（Claude Code 接的是 DeepSeek，就算弱）。名单里没有你：Claude Opus / Sonnet、GPT-5 及以上、Gemini Pro 算强，其他算弱。',
    ''
  );

  // 这一棒要做的
  const n = input.nextId;
  s.push(
    '## 这一棒你要做的',
    '',
    `1. 在 \`${HANDOFF_DIR}/\` 新建 \`第${n}棒-月日-时分-你的工具名.md\`（例如 \`第${n}棒-0924-2310-codex.md\`），照下面的格式先写上你是谁（工具 + 模型），状态写「进行中」。`,
    pending.length ? '2. 你是强模型：先做上面的复核。' : '2. 看一眼上一棒的改动和留言，确认它说做完的真的做完了。',
    `3. 接着做任务里没打勾的事。每做完一步，就在 \`${TASK_REL}\` 里打勾，交接里也记一笔。`,
    '4. 收工前把交接写完整，状态改成「已交接」（整个任务都做完了写「全部完成」；做不下去写「卡住了」并写清楚卡在哪）。'
  );
  if (input.gateCommand) s.push(`5. 收工前跑一遍检查：\`${input.gateCommand}\`，没通过要写进交接。`);
  if (input.protectedPaths.length) s.push(`- 不许改：${input.protectedPaths.map((p) => `\`${p}\``).join('、')}`);
  s.push('', '交接格式：', '', '```markdown', handoffTemplate('你的工具 · 你的模型', input.now).trim(), '```', '');
  s.push(`（这份接力本在 \`${BRIEF_REL}\`，接力台每次记账后都会更新。）`);
  return s.join('\n') + '\n';
}
