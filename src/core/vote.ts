import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadDetected, memberModel } from './detect';
import { errorMessage, RelayError } from './errors';
import { TASK_REL } from './notes';
import { redactSecrets } from './redact';
import { plain } from './cause';
import { findAgent } from './registry';
import { memberTier } from './tier';
import { appendTalkRaw, askAgent, checkSpeakers, inParallel, releaseThread, speakerName, talkPath, taskBackground, threadOf, type TalkContext, type Thread } from './talk';
import { stampLocal } from './time';
import { writeProjectFile } from './safe-write';

/**
 * 投票：让弱模型也有话语权。
 * 1. 方案：你来列（两个以上），或者请每个 AI 先各自出一个（互相看不到；你只列了一个的话，它也一起参加）；
 * 2. 方案打乱顺序、去掉名字（方案 A、B、C……），发给每个 AI 投票，要写理由，不能投自己的；
 * 3. 一个 AI 一票，不分强弱；你也可以投一票；
 * 4. 公布票数和理由，再揭晓每个方案是谁出的；平票由你定；
 * 5. 「采纳」后写进任务的「约定」，之后接力的每一棒都会看到。
 * 记录存在群聊记录里（kind = vote，同一个投票追加多次，读的时候取最后一条）；投票途中点了「新群聊」，接着写进原来那段。
 */

export interface VoteOption {
  key: string;
  text: string;
  /** 谁出的：工人名 / human。 */
  author: string;
  authorLabel: string;
}

export interface Ballot {
  voter: string;
  voterLabel: string;
  /** 投给哪个方案；null = 弃权（没按格式回答、投了自己、出错）。 */
  choice: string | null;
  reason: string;
  /** 不作数的原因。 */
  void?: string;
  /** 投票的人是强模型还是弱模型（只用来展示：票数不分强弱）。 */
  tier?: 'strong' | 'weak';
}

export interface Vote {
  kind: 'vote';
  id: string;
  ts: string;
  question: string;
  status: 'proposing' | 'voting' | 'done';
  options: VoteOption[];
  voters: string[];
  ballots: Ballot[];
  counts?: Record<string, number>;
  /** 票最多的（平票时有好几个）。 */
  leaders?: string[];
  /** 你采纳的方案。 */
  adopted?: { key: string; at: string };
  error?: string;
  /** 出方案那一步没出上的（出错、没有输出）：它照样投票，投票和出方案是两回事，不记成弃权。 */
  noOption?: { voter: string; voterLabel: string; why: string }[];
}

/** 旧记录把「没出方案」记成了一张弃权票（同一位后面还有一张真投的票，看着像投了两次）：读的时候挪到 noOption。 */
function tidyOld(v: Vote): Vote {
  const old = (v.ballots ?? []).filter((b) => b.voter !== 'human' && !b.choice && b.void?.startsWith('没出方案'));
  if (!old.length) return v;
  return {
    ...v,
    ballots: v.ballots.filter((b) => !old.includes(b)),
    noOption: [...(v.noOption ?? []), ...old.map((b) => ({ voter: b.voter, voterLabel: b.voterLabel, why: b.void!.replace(/^没出方案[，,]?/, '') }))],
  };
}

/** 一段群聊记录里的投票（同一个投票取最后一条）。 */
export function readVotes(file: string): Vote[] {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const byId = new Map<string, Vote>();
  for (const line of text.split('\n')) {
    if (!line.includes('"vote"')) continue;
    try {
      const v = JSON.parse(line) as Vote;
      if (v.kind === 'vote' && typeof v.id === 'string') byId.set(v.id, tidyOld(v));
    } catch {
      /* 坏行跳过 */
    }
  }
  return [...byId.values()];
}

export function findVote(file: string, id: string): Vote | null {
  return readVotes(file).find((v) => v.id === id) ?? null;
}

function save(file: string, v: Vote): Vote {
  appendTalkRaw(file, { ...v, ts: new Date().toISOString() });
  return v;
}

/**
 * AI 投票的时候你也可以投：存之前先把记录里你最新的那一票并进来。
 * 不然后面每个 AI 投完都拿自己手里那份（没有你那一票的）去存，你的票就被盖掉了。
 */
function withHumanBallot(file: string, v: Vote): void {
  const human = findVote(file, v.id)?.ballots.filter((b) => b.voter === 'human') ?? [];
  v.ballots = [...v.ballots.filter((b) => b.voter !== 'human'), ...human];
}

const KEYS = 'ABCDEFGHIJKL';

function shuffle<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function speaker(name: string): string {
  const a = findAgent(name);
  return a ? speakerName(a) : name;
}

function contextText(ctx: TalkContext): string {
  return taskBackground(ctx);
}

export function proposePrompt(input: { speaker: string; root: string; question: string; context: TalkContext }): string {
  return redactSecrets(
    [
      `你在参加「接力台」里的一次投票，你是「${input.speaker}」。第一步：每个 AI 各自独立出一个方案——你看不到别人的，别人也看不到你的。`,
      `项目文件夹：${input.root}（可以读里面的文件做参考，但不要修改任何文件）。`,
      contextText(input.context),
      `问题：${input.question}`,
      [
        '请给出你的方案，格式：',
        '第一行：一句话说清楚你的方案（不超过 40 个字）',
        '后面：为什么这样做、大概怎么做（300 字以内）。',
        '用中文。不要提你是哪个模型、哪家公司（方案会匿名给大家投票）。',
      ].join('\n'),
    ].join('\n\n')
  );
}

export function ballotPrompt(input: { speaker: string; question: string; options: VoteOption[]; own: string | null; context: TalkContext }): string {
  const opts = input.options.map((o) => `【方案 ${o.key}】\n${o.text.trim()}`).join('\n\n');
  return redactSecrets(
    [
      `你在参加「接力台」里的一次投票，你是「${input.speaker}」。每个 AI 一票，不分强弱；方案都去掉了名字，只按内容好坏投。`,
      contextText(input.context),
      `问题：${input.question}`,
      `方案：\n\n${opts}`,
      input.own ? `其中方案 ${input.own} 是你自己出的，不能投它。` : '',
      ['请只按这个格式回答，不要写别的：', '投票：<方案字母>', '理由：<一两句话，说清楚为什么它比别的好>'].join('\n'),
    ]
      .filter(Boolean)
      .join('\n\n')
  );
}

/** 从回答里读出投给了谁、理由。 */
export function parseBallot(text: string, keys: string[]): { choice: string | null; reason: string } {
  const t = text.replace(/\*\*/g, '');
  const m = t.match(/投票\s*[:：]\s*(?:方案\s*)?[【\[(（]?\s*([A-La-l])\b/) ?? t.match(/(?:投|选|选择)\s*(?:方案\s*)?([A-La-l])(?![A-Za-z])/) ?? t.match(/^\s*(?:方案\s*)?([A-La-l])\s*$/m);
  const choice = m ? m[1].toUpperCase() : null;
  const r = t.match(/理由\s*[:：]\s*([\s\S]+)/);
  const reason = (r ? r[1] : t).trim().split('\n').slice(0, 4).join(' ').slice(0, 300);
  return { choice: choice && keys.includes(choice) ? choice : null, reason };
}

export function tally(options: VoteOption[], ballots: Ballot[]): { counts: Record<string, number>; leaders: string[] } {
  const counts: Record<string, number> = {};
  for (const o of options) counts[o.key] = 0;
  for (const b of ballots) if (b.choice && b.choice in counts) counts[b.choice]++;
  const max = Math.max(0, ...Object.values(counts));
  const leaders = max > 0 ? Object.keys(counts).filter((k) => counts[k] === max) : [];
  return { counts, leaders };
}

function firstLine(text: string): string {
  return (text.trim().split('\n').find((l) => l.trim()) ?? '').replace(/^[#*\s]+|[*\s]+$/g, '').slice(0, 80);
}

export interface StartVoteInput {
  question: string;
  /** 你列的选项：两个以上就直接投；一个或者不给，AI 先各自出方案（你列的那个一起参加）。 */
  options?: string[];
  /** 谁投票（工人名）。 */
  voters: string[];
  context?: () => TalkContext;
}

const running = new Map<string, Promise<Vote>>();

/** 开始一次投票。立即返回；出方案、投票在后台进行，进度写进群聊记录。 */
export function startVote(root: string, input: StartVoteInput): { vote: Vote; done: Promise<Vote> } {
  const q = input.question.trim();
  if (!q) throw new RelayError('投票的问题是空的', 'empty');
  const voters = checkSpeakers(input.voters);
  if (voters.length < 2) throw new RelayError('投票的 AI 少于两个', 'few-voters');
  const own = (input.options ?? []).map((x) => x.trim()).filter(Boolean).slice(0, KEYS.length);
  const ctx = input.context ?? (() => ({}));
  const vote: Vote = {
    kind: 'vote',
    id: `vote-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
    ts: new Date().toISOString(),
    question: q,
    status: own.length >= 2 ? 'voting' : 'proposing',
    options: own.map((text, i) => ({ key: KEYS[i], text, author: 'human', authorLabel: '我' })),
    voters,
    ballots: [],
  };
  const file = talkPath(root);
  save(file, vote);
  const th = threadOf(file);
  th.votes++;
  const done = runVote(root, th, vote, ctx).finally(() => {
    running.delete(vote.id);
    th.votes--;
    releaseThread(th);
  });
  running.set(vote.id, done);
  return { vote, done };
}

/** 出方案、投票。存都按 th.file：投到一半点了「新群聊」，也写回原来那段。 */
async function runVote(root: string, th: Thread, v: Vote, context: () => TalkContext): Promise<Vote> {
  let ctx: TalkContext = {};
  try {
    ctx = context();
  } catch {
    ctx = {};
  }
  try {
    if (v.status === 'proposing') {
      // 你先列的那一个（有的话）和 AI 出的一起打乱
      const got: { author: string; text: string }[] = v.options.map((o) => ({ author: o.author, text: o.text }));
      await inParallel(v.voters, 4, async (name) => {
        const a = findAgent(name);
        if (!a) return;
        try {
          const text = await askAgent(a, proposePrompt({ speaker: speaker(name), root, question: v.question, context: ctx }), root);
          if (text.trim()) got.push({ author: name, text: text.trim().slice(0, 2000) });
        } catch (e) {
          (v.noOption ??= []).push({ voter: name, voterLabel: speaker(name), why: plain(errorMessage(e)) });
        }
      });
      if (got.length < 2) {
        v.status = 'done';
        v.error = got.length ? '投票没开始：只有 1 个方案' : '投票没开始：没有方案';
        return save(th.file, v);
      }
      v.options = shuffle(got)
        .slice(0, KEYS.length)
        .map((g, i) => ({ key: KEYS[i], text: g.text, author: g.author, authorLabel: g.author === 'human' ? '我' : speaker(g.author) }));
      v.status = 'voting';
      save(th.file, v);
    }
    const keys = v.options.map((o) => o.key);
    await inParallel(v.voters, 4, async (name) => {
      const a = findAgent(name);
      if (!a) return;
      const mine = v.options.find((o) => o.author === name)?.key ?? null;
      // 显示用的强弱按它实际用的模型算（接了 DeepSeek 的 Claude Code 是弱），和名单、接力台其他地方一致。
      const tier = memberTier(a, memberModel(a, loadDetected()));
      try {
        const text = await askAgent(a, ballotPrompt({ speaker: speaker(name), question: v.question, options: v.options, own: mine, context: ctx }), root);
        const b = parseBallot(text, keys);
        const bad = !b.choice ? '没按格式投票' : b.choice === mine ? '投了自己的方案' : undefined;
        v.ballots.push({ voter: name, voterLabel: speaker(name), choice: bad ? null : b.choice, reason: b.reason, tier, ...(bad ? { void: bad } : {}) });
      } catch (e) {
        v.ballots.push({ voter: name, voterLabel: speaker(name), choice: null, reason: '', tier, void: plain(errorMessage(e)) });
      }
      withHumanBallot(th.file, v);
      save(th.file, { ...v, ...tally(v.options, v.ballots) });
    });
    withHumanBallot(th.file, v);
    v.status = 'done';
    Object.assign(v, tally(v.options, v.ballots));
    return save(th.file, v);
  } catch (e) {
    v.status = 'done';
    v.error = errorMessage(e);
    return save(th.file, v);
  }
}

/** 你也投一票（一人一票，再投就是改票）。 */
export function castHumanVote(root: string, id: string, key: string, reason = ''): Vote {
  const file = talkPath(root);
  const v = findVote(file, id);
  if (!v) throw new RelayError('找不到这次投票。', 'no-vote');
  if (v.status === 'proposing') throw new RelayError('方案还没出齐', 'not-ready');
  if (!v.options.some((o) => o.key === key)) throw new RelayError(`没有方案 ${key}。`, 'bad-key');
  const ballots = [...v.ballots.filter((b) => b.voter !== 'human'), { voter: 'human', voterLabel: '我', choice: key, reason: reason.trim().slice(0, 300) }];
  const next: Vote = { ...v, ballots, ...(v.status === 'done' ? tally(v.options, ballots) : {}) };
  return save(file, next);
}

/** 采纳一个方案：写进任务的「约定」，之后接力的每一棒都会看到。 */
export function adoptOption(root: string, id: string, key: string): Vote {
  const file = talkPath(root);
  const v = findVote(file, id);
  if (!v) throw new RelayError('找不到这次投票。', 'no-vote');
  if (v.status !== 'done') throw new RelayError('投票还没结束。', 'not-ready');
  const o = v.options.find((x) => x.key === key);
  if (!o) throw new RelayError(`没有方案 ${key}。`, 'bad-key');
  const count = v.counts?.[key] ?? 0;
  const by = /[\u4e00-\u9fff\uff00-\uffef]$/.test(o.authorLabel) ? `${o.authorLabel}出的` : `${o.authorLabel} 出的`;
  appendRule(root, `${v.question.replace(/\s+/g, ' ').slice(0, 60)} → 采用方案 ${key}（${count} 票，${by}）：${firstLine(o.text)}`);
  return save(file, { ...v, adopted: { key, at: new Date().toISOString() } });
}

/** 往任务的「约定」一节里加一条（没有这一节就加上）。 */
export function appendRule(root: string, line: string, how = '群聊投票定下'): void {
  const p = path.join(root, TASK_REL);
  let raw = '';
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    raw = '# 任务\n\n';
  }
  const item = `- ${line.trim()}（${stampLocal(new Date()).slice(0, 16)} ${how}）`;
  const lines = raw.split('\n');
  const at = lines.findIndex((l) => /^##\s+.*(约定|规矩|备注|决定)/.test(l));
  if (at < 0) {
    writeProjectFile(p, `${raw.trimEnd()}\n\n## 约定\n\n${item}\n`);
    return;
  }
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    if (/^#{1,2}\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(at + 1, end).filter((l) => !/^（.*）$/.test(l.trim()));
  while (body.length && !body[body.length - 1].trim()) body.pop();
  const next = [...lines.slice(0, at + 1), ...(body.length ? body : ['']), item, '', ...lines.slice(end)];
  writeProjectFile(p, next.join('\n').replace(/\n{3,}/g, '\n\n'));
}

/** 这个接力台进程里有没有投票在进行。 */
export function voteBusy(): boolean {
  return running.size > 0;
}
