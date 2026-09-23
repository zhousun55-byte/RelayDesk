import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayError, errorMessage } from './errors';
import { findHarness, locateCached } from './harness';
import { fillTemplate } from './launch';
import { chat } from './llm';
import { redactSecrets } from './redact';
import { startRun } from './runner';
import { agentKind, agentLabel, canTalk, findAgent, OUT_PLACEHOLDER } from './registry';
import type { AgentConfig } from './types';

/**
 * 讨论：人问一句，选中的几个 AI 依次发言，每个都看得到前面的全部内容。
 * 讨论只说话、不改文件，记录存在项目的 .relay/talk.jsonl（不进 git）。
 */
export interface TalkRow {
  ts: string;
  kind: 'human' | 'ai' | 'system';
  who: string;
  agent?: string;
  model?: string;
  text: string;
  /** 这条是「没回上来」的说明。 */
  error?: boolean;
}

export function talkPath(root: string): string {
  return path.join(root, '.relay', 'talk.jsonl');
}

/** 读讨论记录。兼容旧版格式（person/system + windowId），跳过旧版残留的「正在说」占位行。 */
export function readTalk(root: string, limit = 400): TalkRow[] {
  const p = talkPath(root);
  if (!fs.existsSync(p)) return [];
  const out: TalkRow[] = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (r.pending) continue;
    const text = typeof r.text === 'string' ? r.text : '';
    if (!text.trim()) continue;
    const ts = typeof r.ts === 'string' ? r.ts : new Date(0).toISOString();
    const kindIn = r.kind;
    const windowId = typeof r.windowId === 'string' ? r.windowId : undefined;
    let kind: TalkRow['kind'];
    if (kindIn === 'human' || kindIn === 'ai' || kindIn === 'system') kind = kindIn;
    else if (r.mine || windowId === 'human') kind = 'human';
    else if (kindIn === 'system') kind = 'system';
    else kind = 'ai';
    const agent = typeof r.agent === 'string' ? r.agent : windowId && windowId !== 'human' ? windowId : undefined;
    const model = typeof r.model === 'string' ? r.model : typeof r.llm === 'string' ? r.llm : undefined;
    out.push({
      ts,
      kind,
      who: typeof r.who === 'string' && r.who ? r.who : kind === 'human' ? '我' : agentLabel(agent ?? '?'),
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      text,
      ...(r.error ? { error: true } : {}),
    });
  }
  return out.slice(-limit);
}

export function appendTalk(root: string, row: Omit<TalkRow, 'ts'> & { ts?: string }): TalkRow {
  const full: TalkRow = { ts: row.ts ?? new Date().toISOString(), ...row } as TalkRow;
  fs.mkdirSync(path.dirname(talkPath(root)), { recursive: true });
  fs.appendFileSync(talkPath(root), JSON.stringify(full) + '\n');
  return full;
}

/** 清空讨论：旧记录改名存档（talk-时间.jsonl），不删。 */
export function archiveTalk(root: string): string | null {
  const p = talkPath(root);
  if (!fs.existsSync(p)) return null;
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const name = `talk-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jsonl`;
  const to = path.join(path.dirname(p), name);
  fs.renameSync(p, to);
  return to;
}

export interface TalkContext {
  task?: { title: string; phaseText: string; changes: string[] } | null;
}

function hhmm(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 拼给某个 AI 的发言提示：规则 + 项目背景 + 最近的讨论记录。纯函数。 */
export function buildTalkPrompt(input: { speaker: string; root: string; rows: TalkRow[]; context?: TalkContext; maxChars?: number }): string {
  const max = input.maxChars ?? 24_000;
  const lines = input.rows
    .filter((r) => !r.error)
    .map((r) => `[${hhmm(r.ts)}] ${r.kind === 'system' ? '（接力台）' : r.who}：${r.text.trim()}`);
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    size += lines[i].length + 2;
    if (size > max && kept.length > 0) break;
    kept.unshift(lines[i]);
  }
  const t = input.context?.task;
  const parts = [
    `你在参加「接力台」里的一场多 AI 讨论。你是「${input.speaker}」。`,
    `项目文件夹：${input.root}（可以读里面的文件做参考，但不要修改任何文件，也不要执行会改变东西的命令）。`,
    t
      ? `当前任务：${t.title}\n任务状态：${t.phaseText}${t.changes.length ? `\n已改动的文件：${t.changes.slice(0, 30).join('、')}` : ''}`
      : '现在没有进行中的任务。',
    [
      '怎么发言：',
      '- 直接给出你的判断和理由，不客套，不复述别人已经说过的话。',
      '- 可以点名回应别人的观点：同意还是不同意，为什么。',
      '- 一般控制在 300 字以内；被要求详细时再展开。',
      '- 用中文。只输出你要说的话本身。',
    ].join('\n'),
    `讨论记录（${kept.length < lines.length ? '较早的已省略，' : ''}最新的在最后）：\n${kept.join('\n\n') || '（还没有人说话）'}`,
    `现在轮到你（${input.speaker}）发言。`,
  ];
  return redactSecrets(parts.join('\n\n'));
}

function cleanReply(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '')
    .trim()
    .slice(0, 8000);
}

/** 让一个 AI 回答：API 型直接调接口；命令型把提示从标准输入喂进去，读标准输出（或 {{out}} 文件）。 */
export async function askAgent(agent: AgentConfig, prompt: string, cwd: string, timeoutMs = 240_000): Promise<string> {
  if (agentKind(agent) === 'api') {
    if (!agent.api) throw new RelayError('这个工人没有配置接口。', 'no-api');
    return cleanReply(await chat(agent.api, [{ role: 'user', content: prompt }], { timeoutMs, temperature: 0.5 }));
  }
  const tpl = agent.ask?.trim();
  if (!tpl) {
    // 绑定了认得的编程工具：用它的只读模式回答。
    const spec = findHarness(agent.harness);
    const loc = spec ? locateCached(spec) : null;
    if (!spec || !loc) throw new RelayError(`「${agentLabel(agent)}」没有配置讨论命令。`, 'no-ask');
    const stamp = `${process.pid}-${Date.now()}`;
    const inv = spec.invoke(loc, {
      cwd,
      prompt,
      level: 'safe',
      readOnly: true,
      model: agent.model?.trim() || undefined,
      effort: agent.effort,
      outFile: path.join(os.tmpdir(), `relay-talk-${stamp}.txt`),
    });
    const logPath = path.join(os.tmpdir(), `relay-talk-${stamp}.log`);
    const r = await startRun({ invocation: inv, cwd, timeoutMs, logPath, title: '讨论' }).done;
    fs.rmSync(logPath, { force: true });
    const text = cleanReply(r.finalText);
    if (!text) throw new RelayError(r.error ?? (r.timedOut ? `${Math.round(timeoutMs / 1000)} 秒没回话，停掉了。` : `什么都没说（退出码 ${r.code}）。`), 'ask-empty');
    return text;
  }
  const outFile = tpl.includes(OUT_PLACEHOLDER) ? path.join(os.tmpdir(), `relay-talk-${process.pid}-${Date.now()}.txt`) : null;
  const cmd = fillTemplate(tpl, outFile ? { out: outFile } : {});
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', cmd], { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: { ...process.env, NO_COLOR: '1' } });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
      if (out.length > 200_000) out = out.slice(-200_000);
    });
    child.stderr?.on('data', (c: Buffer) => {
      err = (err + c.toString('utf8')).slice(-4000);
    });
    child.stdin?.on('error', () => {
      /* 有的命令不读标准输入 */
    });
    child.stdin?.end(prompt);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* 已结束 */
      }
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new RelayError(`启动不了：${e.message}`, 'ask-spawn'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let reply = out;
      if (outFile) {
        try {
          reply = fs.readFileSync(outFile, 'utf8');
        } catch {
          /* 没写文件就用标准输出 */
        }
        fs.rmSync(outFile, { force: true });
      }
      const text = cleanReply(reply);
      if (timedOut) return reject(new RelayError(`${Math.round(timeoutMs / 1000)} 秒没回话，停掉了。`, 'ask-timeout'));
      if (code !== 0 && !text) return reject(new RelayError(`命令出错（退出码 ${code}）：${cleanReply(err).slice(-600) || '没有输出'}`, 'ask-failed'));
      if (!text) return reject(new RelayError(`什么都没说。${cleanReply(err).slice(-300)}`, 'ask-empty'));
      resolve(text);
    });
  });
}

// ---- 一轮发言（按项目排队，同一个项目同一时间只有一轮在跑） ----

interface Round {
  queue: string[];
  current: string | null;
  since: string | null;
  running: Promise<void> | null;
}

const rounds = new Map<string, Round>();

function roundOf(root: string): Round {
  const key = path.resolve(root);
  let r = rounds.get(key);
  if (!r) {
    r = { queue: [], current: null, since: null, running: null };
    rounds.set(key, r);
  }
  return r;
}

export function talkStatus(root: string): { current: { agent: string; label: string; since: string } | null; queue: { agent: string; label: string }[] } {
  const r = rounds.get(path.resolve(root));
  const lab = (n: string) => agentLabel(findAgent(n) ?? n);
  return {
    current: r?.current ? { agent: r.current, label: lab(r.current), since: r.since ?? '' } : null,
    queue: (r?.queue ?? []).map((n) => ({ agent: n, label: lab(n) })),
  };
}

function speakerName(agent: AgentConfig): string {
  return `${agentLabel(agent)}${agent.model ? ` · ${agent.model}` : ''}`;
}

async function runRound(root: string, context: () => TalkContext): Promise<void> {
  const r = roundOf(root);
  while (r.queue.length) {
    const name = r.queue.shift()!;
    r.current = name;
    r.since = new Date().toISOString();
    const agent = findAgent(name);
    try {
      if (!agent) throw new RelayError('工人名单里已经没有它了。', 'no-agent');
      let ctx: TalkContext = {};
      try {
        ctx = context();
      } catch {
        ctx = {};
      }
      const who = speakerName(agent);
      const prompt = buildTalkPrompt({ speaker: who, root, rows: readTalk(root, 80), context: ctx });
      const text = await askAgent(agent, prompt, root);
      appendTalk(root, { kind: 'ai', who, agent: agent.name, ...(agent.model ? { model: agent.model } : {}), text });
    } catch (e) {
      appendTalk(root, { kind: 'system', who: '接力台', agent: name, text: `${agentLabel(agent ?? name)} 没回上来：${errorMessage(e)}`, error: true });
    }
  }
  r.current = null;
  r.since = null;
}

/**
 * 人说一句，并请几位 AI 依次回应。立即返回；回答在后台陆续写进记录。
 * 已经有一轮在跑时，新请的人排到队尾（他们发言时会看到这句话）。
 */
export function say(root: string, text: string, ask: string[], context: () => TalkContext = () => ({})): { row: TalkRow; queued: string[]; done: Promise<void> } {
  const t = text.trim();
  if (!t) throw new RelayError('先写一句话。', 'empty');
  const names: string[] = [];
  for (const n of ask) {
    const a = findAgent(n);
    if (!a) throw new RelayError(`工人名单里没有「${n}」。`, 'no-agent');
    if (!canTalk(a)) throw new RelayError(`「${agentLabel(a)}」还不能参加讨论：在设置里给它填「讨论命令」。`, 'cannot-talk');
    if (!names.includes(n)) names.push(n);
  }
  const row = appendTalk(root, { kind: 'human', who: '我', text: t });
  const r = roundOf(root);
  for (const n of names) if (!r.queue.includes(n) && r.current !== n) r.queue.push(n);
  if (!r.running && r.queue.length) {
    r.running = runRound(root, context).finally(() => {
      r.running = null;
    });
  }
  return { row, queued: names, done: r.running ?? Promise.resolve() };
}
