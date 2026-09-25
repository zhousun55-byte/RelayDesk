import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from './errors';
import type { Verdict } from './ledger';
import { stampLocal } from './time';

/**
 * 项目里那几个「人和 AI 都会写」的文件：任务、交接、复核。
 * 接力台只在建的时候写模板、换任务时改任务；之后内容归 AI 和你。这里负责读懂它们。
 */

export const TASK_REL = '.relay/任务.md';
export const DONE_TASKS_REL = '.relay/做完的任务.md';
export const HANDOFF_DIR = '.relay/交接';
export const REVIEW_DIR = '.relay/复核';
export const BRIEF_REL = '.relay/接力本.md';

// ---- 任务 ----

export interface TaskItem {
  done: boolean;
  text: string;
}

export interface TaskDoc {
  /** 「# 任务」下面第一段（要做成什么样）。 */
  title: string;
  body: string;
  items: TaskItem[];
  /** 「## 约定」一节（所有 AI 都要遵守的）。 */
  rules: string;
  raw: string;
  /** 文件还是空模板（没写任务）。 */
  empty: boolean;
}

export const TASK_PLACEHOLDER = '（还没有任务。在接力台里写一句要做什么，或者直接告诉 AI，它会写在这里。）';

export function taskTemplate(title?: string, items: string[] = []): string {
  const t = title?.trim() || TASK_PLACEHOLDER;
  return [
    '# 任务',
    '',
    t,
    '',
    '## 进度',
    '',
    ...(items.length ? items.map((x) => `- [ ] ${x}`) : ['- [ ] （把任务拆成几步写在这里，做完一步打一个勾）']),
    '',
    '## 约定',
    '',
    '（所有接力的 AI 都要遵守的：用什么技术、什么不能动、群聊投票定下来的方案……）',
    '',
  ].join('\n');
}

function section(raw: string, name: RegExp): string {
  const lines = raw.split('\n');
  const start = lines.findIndex((l) => /^##\s+/.test(l) && name.test(l.replace(/^##\s+/, '')));
  if (start < 0) return '';
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

const PLACEHOLDER_ITEM = /^（.*）$/;

export function parseTask(raw: string): TaskDoc {
  const lines = raw.split('\n');
  const h1 = lines.findIndex((l) => /^#\s+/.test(l));
  const bodyLines: string[] = [];
  for (let i = h1 + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    bodyLines.push(lines[i]);
  }
  const body = bodyLines.join('\n').trim();
  const title = (body.split('\n').find((l) => l.trim()) ?? '').trim();
  const items: TaskItem[] = [];
  const progress = section(raw, /进度|清单|步骤|todo/i);
  for (const l of progress.split('\n')) {
    const m = l.match(/^\s*[-*+]\s+\[( |x|X|✓|√)\]\s+(.*)$/);
    if (m && !PLACEHOLDER_ITEM.test(m[2].trim())) items.push({ done: m[1] !== ' ', text: m[2].trim() });
  }
  const rulesRaw = section(raw, /约定|规矩|备注|决定/);
  const rules = PLACEHOLDER_ITEM.test(rulesRaw) ? '' : rulesRaw;
  const empty = !title || title === TASK_PLACEHOLDER;
  return { title: empty ? '' : title, body: empty ? '' : body, items, rules, raw, empty };
}

export function readTask(root: string): TaskDoc {
  let raw = '';
  try {
    raw = fs.readFileSync(path.join(root, TASK_REL), 'utf8');
  } catch {
    /* 没有 */
  }
  return parseTask(raw);
}

/** 任务做完了吗：有清单、全部打勾。 */
export function taskComplete(t: TaskDoc): boolean {
  return !t.empty && t.items.length > 0 && t.items.every((i) => i.done);
}

export function taskProgress(t: TaskDoc): { done: number; total: number } {
  return { done: t.items.filter((i) => i.done).length, total: t.items.length };
}

/** 换任务：旧任务追加到「做完的任务」里存档，再写新任务。 */
export function setTask(root: string, text: string, items: string[] = []): TaskDoc {
  const p = path.join(root, TASK_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const old = readTask(root);
  if (!old.empty) {
    const arch = path.join(root, DONE_TASKS_REL);
    const head = fs.existsSync(arch) ? '' : '# 做完的任务\n\n换任务时，旧任务存在这里。\n';
    fs.appendFileSync(arch, `${head}\n---\n\n> 存档于 ${stampLocal(new Date())}\n\n${old.raw.trim()}\n`);
  }
  const lines = text.trim().split('\n');
  const title = lines[0].trim();
  const rest = lines.slice(1).join('\n').trim();
  let doc = taskTemplate(title, items);
  if (rest) doc = doc.replace(`${title}\n`, `${title}\n\n${rest}\n`);
  fs.writeFileSync(p, doc);
  return parseTask(doc);
}

/** 存档里旧任务的标题（按存档的先后）。 */
export function archivedTaskTitles(root: string): string[] {
  let raw = '';
  try {
    raw = fs.readFileSync(path.join(root, DONE_TASKS_REL), 'utf8');
  } catch {
    return [];
  }
  return raw
    .replace(/\r/g, '')
    .split(/\n---\n/)
    .slice(1)
    .map((block) => parseTask(block).title)
    .filter(Boolean);
}

// ---- 在网页上改任务：改标题、给清单打勾、加一步、删一步 ----

export type TaskEdit = { op: 'title'; text: string } | { op: 'toggle'; index: number; done?: boolean } | { op: 'add'; text: string } | { op: 'remove'; index: number };

const ITEM_LINE = /^(\s*[-*+]\s+\[)( |x|X|✓|√)(\]\s+)(.*)$/;

/** 「进度」一节在哪几行，每一步在第几行（和 parseTask 的 items 一一对应）。 */
function progressLines(lines: string[]): { start: number; items: number[]; placeholders: number[] } | null {
  const start = lines.findIndex((l) => /^##\s+/.test(l) && /进度|清单|步骤|todo/i.test(l.replace(/^##\s+/, '')));
  if (start < 0) return null;
  const items: number[] = [];
  const placeholders: number[] = [];
  for (let i = start + 1; i < lines.length && !/^#{1,2}\s+/.test(lines[i]); i++) {
    const m = lines[i].match(ITEM_LINE);
    if (m) (PLACEHOLDER_ITEM.test(m[4].trim()) ? placeholders : items).push(i);
  }
  return { start, items, placeholders };
}

export function editTask(root: string, edit: TaskEdit): TaskDoc {
  const p = path.join(root, TASK_REL);
  let raw = '';
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    /* 没有就从模板开始 */
  }
  const lines = (raw.trim() ? raw : taskTemplate()).replace(/\r/g, '').replace(/\n+$/, '').split('\n');
  const oneLine = (s: string) => s.trim().replace(/\s*\n\s*/g, ' ');

  if (edit.op === 'title') {
    const text = oneLine(edit.text);
    if (!text) throw new RelayError('任务不能是空的。', 'empty');
    const h1 = lines.findIndex((l) => /^#\s+/.test(l));
    if (h1 < 0) lines.unshift('# 任务', '', text, '');
    else {
      let at = -1;
      for (let i = h1 + 1; i < lines.length && !/^##\s+/.test(lines[i]); i++) {
        if (lines[i].trim()) {
          at = i;
          break;
        }
      }
      if (at >= 0) lines[at] = text;
      else lines.splice(h1 + 1, 0, '', text);
    }
  } else {
    let sec = progressLines(lines);
    if (!sec) {
      // 没有「进度」一节：加在「约定」前面，没有「约定」就加在最后。
      const rules = lines.findIndex((l) => /^##\s+/.test(l) && /约定|规矩|备注|决定/.test(l));
      if (rules >= 0) lines.splice(rules, 0, '## 进度', '');
      else lines.push('', '## 进度');
      sec = progressLines(lines)!;
    }
    if (edit.op === 'add') {
      const text = oneLine(edit.text);
      if (!text) throw new RelayError('先写这一步要做什么。', 'empty');
      if (!sec.items.length && sec.placeholders.length) lines[sec.placeholders[0]] = `- [ ] ${text}`;
      else if (sec.items.length) lines.splice(sec.items[sec.items.length - 1] + 1, 0, `- [ ] ${text}`);
      else {
        const at = sec.start + 1;
        lines.splice(at, 0, '', `- [ ] ${text}`);
        if (lines[at + 2] !== undefined && lines[at + 2].trim()) lines.splice(at + 2, 0, '');
      }
    } else {
      const at = sec.items[edit.index];
      if (at === undefined) throw new RelayError('清单里没有这一步。', 'no-item');
      if (edit.op === 'remove') lines.splice(at, 1);
      else lines[at] = lines[at].replace(ITEM_LINE, (_m, a: string, mark: string, b: string, text: string) => `${a}${(edit.done ?? mark === ' ') ? 'x' : ' '}${b}${text}`);
    }
  }
  const out = `${lines.join('\n')}\n`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, out);
  return parseTask(out);
}

// ---- 交接 ----

export interface HandoffDoc {
  file: string;
  /** 标题里写的身份：「Codex · gpt-6」。 */
  who: string;
  /** 「工具：」「模型：」两行（有的话）。 */
  tool?: string;
  model?: string;
  /** 进行中 / 已交接 / 卡住了 / 全部完成 */
  state: 'working' | 'handed' | 'stuck' | 'finished' | 'unknown';
  did: string;
  next: string;
  unsure: string;
  verify: string;
  /** 一句话摘要：「做了什么」的第一条。 */
  summary: string;
  raw: string;
  mtimeMs: number;
}

export function handoffTemplate(who: string, ts: string | Date = new Date()): string {
  return [
    `# 交接：${who}`,
    '',
    `- 工具：`,
    `- 模型：`,
    `- 时间：${stampLocal(ts)}`,
    '- 状态：进行中',
    '',
    '## 做了什么',
    '',
    '- ',
    '',
    '## 没做完 / 下一步',
    '',
    '- ',
    '',
    '## 不确定、可能有错的地方',
    '',
    '- ',
    '',
    '## 怎么验证',
    '',
    '- ',
    '',
  ].join('\n');
}

function field(raw: string, name: string): string | undefined {
  const m = raw.match(new RegExp(`^[ \\t]*[-*]?[ \\t]*${name}[ \\t]*[:：][ \\t]*(.+)$`, 'm'));
  const v = m?.[1].trim();
  return v && !/^[（(]?(无|空|不知道|未知)?[）)]?$/.test(v) ? v : undefined;
}

function stateOf(text: string | undefined): HandoffDoc['state'] {
  if (!text) return 'unknown';
  if (/全部完成|全部做完|都做完|任务完成|已完成全部/.test(text)) return 'finished';
  if (/卡住|卡在|做不下去|需要人/.test(text)) return 'stuck';
  if (/进行中|正在做|还在做|未完成|没做完/.test(text)) return 'working';
  if (/已交接|交接了|完成|做完|结束|收工/.test(text)) return 'handed';
  return 'unknown';
}

function bullets(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*[-*+]\s*|^\s*\d+[.、)]\s*/, '').trim())
    .filter((t) => t && !/^[（(].*[）)]$/.test(t));
}

const clip80 = (t: string) => (t.length > 80 ? `${t.slice(0, 80)}…` : t);

function firstBullet(text: string): string {
  return clip80(bullets(text)[0] ?? '');
}

/** 「做了什么」里挑一条当一句话摘要：跳过开头「读了接力本、看了任务」这种准备工作，找第一条真干了活的。 */
function workBullet(text: string): string {
  const all = bullets(text);
  const reading = /^(先)?(读|看|查看|阅读|浏览|了解|熟悉)(了|过|完)?|^read\b/i;
  return clip80(all.find((t) => !reading.test(t)) ?? all[0] ?? '');
}

export function parseHandoff(raw: string, file = '', mtimeMs = 0): HandoffDoc {
  const h1 = raw.match(/^#[ \t]*交接[ \t]*[:：]?[ \t]*(.*)$/m) ?? raw.match(/^#[ \t]+(.*)$/m);
  const did = section(raw, /做了什么|做了|完成了/);
  return {
    file,
    who: (h1?.[1] ?? '').trim(),
    tool: field(raw, '工具'),
    model: field(raw, '模型'),
    state: stateOf(field(raw, '状态')),
    did,
    next: section(raw, /没做完|下一步/),
    unsure: section(raw, /不确定|可能有错|风险|假设/),
    verify: section(raw, /怎么验证|验证/),
    summary: workBullet(did),
    raw,
    mtimeMs,
  };
}

/** 交接里真写了东西（不只是开工时建的空模板）。 */
export function handoffFilled(h: HandoffDoc): boolean {
  return !!(h.summary || firstBullet(h.next) || firstBullet(h.unsure) || h.state === 'finished' || h.state === 'stuck');
}

export function readHandoff(root: string, rel: string): HandoffDoc | null {
  const p = path.join(root, rel);
  try {
    const st = fs.statSync(p);
    return parseHandoff(fs.readFileSync(p, 'utf8'), rel, st.mtimeMs);
  } catch {
    return null;
  }
}

/** 交接文件夹里的所有 .md（按修改时间，旧的在前）。 */
export function listHandoffFiles(root: string): { rel: string; mtimeMs: number }[] {
  const dir = path.join(root, HANDOFF_DIR);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.md') && !n.startsWith('.'))
    .map((n) => {
      const rel = `${HANDOFF_DIR}/${n}`;
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(path.join(root, rel)).mtimeMs;
      } catch {
        /* 刚删 */
      }
      return { rel, mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.rel.localeCompare(b.rel));
}

/** 文件名里用的时间：0924-2310。 */
export function fileStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 给第 N 棒起一个交接文件名：.relay/交接/第7棒-0924-2310-codex.md */
export function handoffFileFor(root: string, stintId: number, tool: string, d = new Date()): string {
  const safe = tool.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'ai';
  let rel = `${HANDOFF_DIR}/第${stintId}棒-${fileStamp(d)}-${safe}.md`;
  for (let i = 2; fs.existsSync(path.join(root, rel)); i++) rel = `${HANDOFF_DIR}/第${stintId}棒-${fileStamp(d)}-${safe}-${i}.md`;
  return rel;
}

// ---- 复核 ----

export interface ReviewDoc {
  file: string;
  /** 复核的是第几棒（文件名或标题里的「第 N 棒」）。 */
  targets: number[];
  by: string;
  verdict: Verdict;
  verdictText: string;
  summary: string;
  raw: string;
  mtimeMs: number;
}

export function reviewFileFor(stintId: number): string {
  return `${REVIEW_DIR}/第${stintId}棒.md`;
}

export function reviewDiffFileFor(stintId: number): string {
  return `${REVIEW_DIR}/第${stintId}棒.diff`;
}

export function reviewTemplate(targetTitle: string): string {
  return [
    `# 复核：${targetTitle}`,
    '',
    '- 复核人：（你的工具和模型）',
    '- 结论：（没问题 / 有问题，已修好 / 改坏了，已退回 / 有问题，还没修）',
    '',
    '## 它说的和实际对不对得上',
    '',
    '- ',
    '',
    '## 发现的问题和怎么处理的',
    '',
    '- ',
    '',
  ].join('\n');
}

export function verdictOf(text: string | undefined): Verdict {
  if (!text) return 'unknown';
  const t = text.replace(/[（(][^）)]*[）)]/g, '');
  if (/已退回|退回了|撤销了|回滚/.test(t)) return 'reverted';
  if (/已修|修好|改好|修复了|已改正|已经修/.test(t)) return 'fixed';
  if (/有问题|不对|错误|没修|未修|需要返工|要改|没通过|不通过/.test(t)) return 'problem';
  if (/没问题|无问题|通过|正确|可以继续|没发现问题|属实/.test(t)) return 'ok';
  return 'unknown';
}

export function parseReview(raw: string, file = '', mtimeMs = 0): ReviewDoc {
  const targets = new Set<number>();
  for (const m of `${path.basename(file)}\n${(raw.match(/^#.*$/m) ?? [''])[0]}`.matchAll(/第\s*(\d+)\s*棒/g)) targets.add(Number(m[1]));
  const vt = field(raw, '结论') ?? '';
  return {
    file,
    targets: [...targets].sort((a, b) => a - b),
    by: field(raw, '复核人') ?? '',
    verdict: verdictOf(vt),
    verdictText: vt,
    summary: firstBullet(section(raw, /发现的问题|问题和|处理/)) || vt,
    raw,
    mtimeMs,
  };
}

export function listReviewFiles(root: string): { rel: string; mtimeMs: number }[] {
  const dir = path.join(root, REVIEW_DIR);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.md') && !n.startsWith('.'))
    .map((n) => {
      const rel = `${REVIEW_DIR}/${n}`;
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(path.join(root, rel)).mtimeMs;
      } catch {
        /* 刚删 */
      }
      return { rel, mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

export function readReview(root: string, rel: string): ReviewDoc | null {
  const p = path.join(root, rel);
  try {
    const st = fs.statSync(p);
    return parseReview(fs.readFileSync(p, 'utf8'), rel, st.mtimeMs);
  } catch {
    return null;
  }
}

/** 复核文件是不是真的写了东西（不是空模板）。 */
export function reviewFilled(r: ReviewDoc): boolean {
  return r.verdict !== 'unknown' || r.raw.replace(/[-#\s（）()：:]/g, '').length > 120;
}
