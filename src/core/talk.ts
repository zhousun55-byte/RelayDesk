import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatLine } from './chat';
import {
  prettyLlm,
  readHarnessBrain,
  runningHarnesses,
  windowLabel,
} from './identity';
import { loadRegistry } from './registry';

export interface TalkRow {
  ts: string;
  kind: 'system' | 'person';
  who: string;
  windowId?: string;
  llm?: string;
  sub?: string;
  at?: string[];
  text: string;
  mine?: boolean;
  pending?: boolean;
  files?: string[];
}

export interface TalkOpener {
  who: string;
  windowId?: string;
  llm?: string;
  text: string;
}

const asking = new Set<string>();
const waiting = new Set<string>();
const queues = new Map<string, string[]>();

function now(): string {
  return new Date().toISOString();
}

function roomKey(root: string): string {
  return path.resolve(root);
}

function productRoot(): string {
  return path.resolve(__dirname, '../../..');
}

export function talkPath(root: string): string {
  return path.join(path.resolve(root), '.relay', 'talk.jsonl');
}

export function talkMdPath(root: string): string {
  return path.join(path.resolve(root), '.relay', 'talk.md');
}

export function saveTalkFile(root: string, name: string, bytes: Buffer): string {
  const base = path.basename(name).replace(/[^\w.\-\u4e00-\u9fff]+/g, '_').slice(0, 80) || 'file';
  const dir = path.join(path.resolve(root), '.relay', 'attach');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now().toString(36)}-${base}`;
  fs.writeFileSync(path.join(dir, filename), bytes);
  return `.relay/attach/${filename}`;
}

export function resolveProjectFile(root: string, rel: string): string | null {
  if (!rel || rel.includes('\0')) return null;
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, rel);
  if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  if (fs.statSync(abs).size > 8_000_000) return null;
  return abs;
}

export function knownWindows(): { id: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const a of loadRegistry().agents) seen.set(a.name, windowLabel(a.name));
  for (const id of ['claude', 'cursor', 'zcode']) {
    if (!seen.has(id)) seen.set(id, windowLabel(id));
  }
  return [...seen.entries()].map(([id, label]) => ({ id, label }));
}

export function parseMentions(text: string, known: { id: string; label: string }[] = knownWindows()): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(/@([^\s@]+)/g)) {
    const token = m[1].split(/[·.]/)[0];
    const hit = known.find(
      (k) => k.id.toLowerCase() === token.toLowerCase() || k.label.toLowerCase() === token.toLowerCase()
    );
    if (hit && !ids.includes(hit.id)) ids.push(hit.id);
  }
  return ids;
}

export function readTalkRows(root: string): TalkRow[] {
  const p = talkPath(root);
  if (!fs.existsSync(p)) return [];
  const out: TalkRow[] = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TalkRow);
    } catch {
      /* skip a broken talk line */
    }
  }
  return out;
}

export function shownSub(sub?: string): string | undefined {
  if (!sub) return undefined;
  const t = sub.replace(/\s*[·•]\s*最认真/g, '').replace(/最认真/g, '').trim();
  return t || undefined;
}

export function rowToChat(row: TalkRow): ChatLine {
  return {
    kind: row.kind,
    who: row.who,
    windowId: row.windowId,
    llm: row.llm,
    sub: shownSub(row.sub),
    at: row.at,
    text: row.text,
    ts: row.ts,
    mine: row.mine,
    pending: row.pending,
    files: row.files,
  };
}

function writeTalk(root: string, rows: TalkRow[]): void {
  const p = talkPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  writeTalkMd(root);
}

/** 后到的正式回复盖住同一扇窗前面那条「正在说」，文件本身只追加。 */
export function collapsePending(rows: TalkRow[]): TalkRow[] {
  const hide = new Set<number>();
  const open = new Map<string, number>();
  rows.forEach((r, i) => {
    if (r.pending && r.windowId) {
      open.set(r.windowId, i);
      return;
    }
    if (r.kind === 'person' && r.windowId && !r.pending && open.has(r.windowId)) {
      hide.add(open.get(r.windowId)!);
      open.delete(r.windowId);
    }
  });
  return rows.filter((_, i) => !hide.has(i));
}

function expirePending(root: string): void {
  const stuck = collapsePending(readTalkRows(root)).filter(
    (r) => r.pending && r.windowId && Number.isFinite(Date.parse(r.ts)) && Date.now() - Date.parse(r.ts) > 200_000
  );
  for (const r of stuck) {
    appendTalk(root, {
      kind: 'person',
      who: r.who,
      windowId: r.windowId,
      text: '没听见。',
    });
  }
}

export function readTalk(root: string): ChatLine[] {
  expirePending(root);
  return collapsePending(readTalkRows(root)).map(rowToChat);
}

export function pendingWindow(lines: ChatLine[]): string | null {
  return lines.find((l) => l.pending)?.windowId ?? null;
}

export function talkSub(windowId: string): string {
  return prettyLlm(readHarnessBrain(windowId) || '');
}

export function talkWho(windowId: string): string {
  const win = windowLabel(windowId);
  const sub = talkSub(windowId);
  return sub && sub !== win ? `${win} · ${sub}` : win;
}

export function writeTalkMd(root: string): string {
  const p = talkMdPath(root);
  const rows = readTalkRows(root).filter((r) => !r.pending);
  const lines = [
    `# 群聊 · ${path.basename(path.resolve(root))}`,
    '',
  ];
  for (const r of rows) {
    const t = new Date(r.ts);
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const who = r.sub ? `${r.who}（${r.sub}）` : r.who;
    const at = r.at?.length ? ` @${r.at.join(' @')}` : '';
    lines.push(`- ${hh}:${mm} **${who}**${at}：${r.text.replace(/\s+/g, ' ').trim()}`);
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

export function openTalkWindow(root: string, windowId?: string): string {
  const p = writeTalkMd(root);
  if (windowId === 'claude') {
    spawn('open', ['-a', 'Claude', p], { stdio: 'ignore', detached: true }).unref();
  } else {
    spawn('open', [p], { stdio: 'ignore', detached: true }).unref();
  }
  return p;
}

export function appendTalk(root: string, row: Omit<TalkRow, 'ts'> & { ts?: string }): TalkRow {
  const full: TalkRow = { ...row, ts: row.ts ?? now() };
  const p = talkPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(full) + '\n');
  writeTalkMd(root);
  return full;
}

export function settleTalk(root: string, windowId: string, text: string, opts?: { ask?: boolean }): void {
  appendTalk(root, {
    kind: 'person',
    who: windowLabel(windowId),
    windowId,
    llm: readHarnessBrain(windowId) || undefined,
    sub: talkSub(windowId) || undefined,
    text,
  });
  const key = roomKey(root);
  const leftover = queues.get(key) ?? [];
  if (waiting.has(key) && leftover.length === 0) {
    waiting.delete(key);
    maybeAsk(root, { ask: opts?.ask, fresh: true });
    return;
  }
  maybeAsk(root, { ask: opts?.ask });
}

export function sayInTalk(root: string, text: string, files: string[] = []): void {
  const t = text.trim();
  const clips = files.map((f) => f.trim()).filter(Boolean);
  if (!t && !clips.length) throw new Error('先说一句');
  appendTalk(root, {
    kind: 'person',
    who: '我',
    windowId: 'human',
    text: t || clips.map((f) => f.split('/').pop()).join('、'),
    at: parseMentions(t),
    files: clips.length ? clips : undefined,
    mine: true,
  });
}

export function sayAs(root: string, opener: TalkOpener): void {
  const t = opener.text.trim();
  if (!t) throw new Error('先说一句');
  appendTalk(root, {
    kind: 'person',
    who: opener.who,
    windowId: opener.windowId,
    llm: opener.llm,
    text: t,
    at: parseMentions(t),
    mine: opener.windowId === 'human',
  });
}

export function formatTalkHistory(root: string, limit = 24): string {
  return readTalkRows(root)
    .filter((r) => !r.pending)
    .slice(-limit)
    .map((r) => {
      const sub = shownSub(r.sub);
      const who = sub ? `${r.who} · ${sub}` : r.who;
      const files = r.files?.length ? `\n文件：${r.files.join('、')}` : '';
      return `${who}：${r.text}${files}`;
    })
    .join('\n\n');
}

export function seatedWindows(rows: TalkRow[]): string[] {
  const ids: string[] = [];
  for (const r of rows) {
    if (!r.windowId || r.windowId === 'human') continue;
    if (r.kind === 'system' && /进了群/.test(r.text) && !ids.includes(r.windowId)) ids.push(r.windowId);
  }
  return ids;
}

function replyApp(windowId: string): string | null {
  if (windowId === 'claude') return 'Claude';
  return null;
}

export function canReply(windowId: string): boolean {
  return replyApp(windowId) !== null;
}

function lastHuman(rows: TalkRow[]): TalkRow | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].mine || rows[i].windowId === 'human') return rows[i];
  }
  return null;
}

function spokenSinceHuman(rows: TalkRow[]): Set<string> {
  const spoken = new Set<string>();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.mine || r.windowId === 'human') break;
    if (r.kind === 'person' && r.windowId && !r.pending) spoken.add(r.windowId);
  }
  return spoken;
}

export function buildRound(root: string): string[] {
  const rows = readTalkRows(root);
  const seated = seatedWindows(rows);
  const able = seated.filter((id) => canReply(id));
  const spoken = spokenSinceHuman(rows);
  const mentions = (lastHuman(rows)?.at ?? []).filter((id) => able.includes(id) && !spoken.has(id));
  const rest = able.filter((id) => !mentions.includes(id) && !spoken.has(id));
  return [...mentions, ...rest];
}

export function maybeAsk(root: string, opts?: { ask?: boolean; fresh?: boolean }): void {
  const ask = opts?.ask !== false;
  const key = roomKey(root);
  const rows = collapsePending(readTalkRows(root));
  if (rows.some((r) => r.pending)) {
    waiting.add(key);
    return;
  }
  let q = queues.get(key) ?? [];
  if (opts?.fresh) {
    q = buildRound(root);
    queues.set(key, q);
    const mentioned = (lastHuman(rows)?.at ?? []).filter((id) => !canReply(id));
    for (const id of mentioned) {
      appendTalk(root, {
        kind: 'system',
        who: '接力',
        windowId: id,
        text: `${windowLabel(id)} 不自动回`,
      });
    }
  }
  const next = q.shift();
  queues.set(key, q);
  if (!next) return;
  if (ask && !windowIsRunning(next)) {
    appendTalk(root, { kind: 'system', who: '接力', windowId: next, text: `${windowLabel(next)} 窗口没开。` });
    maybeAsk(root, { ask, fresh: false });
    return;
  }
  appendTalk(root, {
    kind: 'person',
    who: windowLabel(next),
    windowId: next,
    llm: readHarnessBrain(next) || undefined,
    sub: talkSub(next) || undefined,
    text: '正在说',
    pending: true,
  });
  if (ask) kickReply(root, next);
}

export function windowIsRunning(windowId: string): boolean {
  return runningHarnesses().includes(windowId);
}

function claudeBin(): string {
  const home = path.join(os.homedir(), '.local/bin/claude');
  return fs.existsSync(home) ? home : 'claude';
}

function bringFront(app: string): void {
  spawn('open', ['-a', app], { stdio: 'ignore', detached: true }).unref();
}

export function pullIntoTalk(
  root: string,
  windowId: string,
  opener?: TalkOpener,
  opts?: { ask?: boolean }
): void {
  const ask = opts?.ask !== false;
  if (ask && !windowIsRunning(windowId)) throw new Error('窗口没开');
  const rows = collapsePending(readTalkRows(root));
  if (rows.some((r) => r.pending)) throw new Error('还在等上一句');
  const label = windowLabel(windowId);
  if (!rows.some((r) => r.windowId === windowId && /进了群/.test(r.text))) {
    appendTalk(root, { kind: 'system', who: '接力', windowId, text: `${label} 进了群` });
  }
  if (opener?.text.trim()) {
    appendTalk(root, {
      kind: 'person',
      who: opener.who,
      windowId: opener.windowId,
      llm: opener.llm,
      text: opener.text.trim(),
      at: parseMentions(opener.text),
    });
  }
  writeTalkMd(root);
  if (ask && windowId === 'claude') openTalkWindow(root, 'claude');
  if (!canReply(windowId)) {
    appendTalk(root, { kind: 'system', who: '接力', windowId, text: `${label} 不自动回` });
    return;
  }
  queues.set(roomKey(root), [windowId]);
  maybeAsk(root, { ask, fresh: false });
}

export function listTalkRooms(
  projects: { name: string; root: string; current: boolean }[]
): { name: string; root: string; current: boolean; preview: string }[] {
  const out: { name: string; root: string; current: boolean; preview: string }[] = [];
  for (const p of projects) {
    if (!fs.existsSync(talkPath(p.root))) continue;
    const rows = readTalkRows(p.root).filter((r) => r.kind === 'person' && !r.pending);
    const last = rows[rows.length - 1];
    out.push({
      name: p.name,
      root: p.root,
      current: p.current,
      preview: (last?.text || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    });
  }
  return out;
}

export function lastHumanText(root: string): string {
  const row = lastHuman(readTalkRows(root));
  return row?.text.replace(/@\S+/g, '').trim() || '';
}

export function kickReply(root: string, windowId: string): void {
  const app = replyApp(windowId);
  if (!app) {
    settleTalk(root, windowId, '这扇窗开着，但还不会在群聊里回。');
    return;
  }
  const key = `${path.resolve(root)}::${windowId}`;
  if (asking.has(key)) return;
  asking.add(key);
  bringFront(app);
  writeTalkMd(root);
  const product = productRoot();
  const history = formatTalkHistory(root);
  const mentioned = (lastHuman(readTalkRows(root))?.at ?? []).includes(windowId);
  const prompt = [
    `你是 ${talkWho(windowId)}。用你这个模型本来的说法说话，不要装成另一个助手，不要改任何文件。`,
    `当前房间：${path.resolve(root)}`,
    '这是接力的群聊。改代码走接力那一条，不在这里改。',
    '看着下面整段往下说。别人说过的不要重复。点到你就先答那一句。',
    mentioned ? '最后一句点了你。' : '这轮大家都在。',
    history || '（还没有别人说话）',
  ].join('\n\n');
  const child = spawn(
    claudeBin(),
    ['-p', prompt, '--output-format', 'text', '--model', 'opus', '--add-dir', product],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${path.join(os.homedir(), '.local/bin')}:${process.env.PATH ?? ''}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let out = '';
  let err = '';
  child.stdout?.on('data', (c: Buffer) => {
    out += c.toString('utf8');
  });
  child.stderr?.on('data', (c: Buffer) => {
    err += c.toString('utf8');
  });
  const done = (text: string): void => {
    if (!asking.has(key)) return;
    asking.delete(key);
    const t = text.replace(/\u001b\[[0-9;]*m/g, '').trim();
    try {
      settleTalk(root, windowId, (t || '没听见。').slice(0, 4000));
    } catch {
      /* a late reply must not take the page down */
    }
  };
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    done('等太久，没接到。');
  }, 180_000);
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0 && out.trim()) done(out);
    else done((out.trim() || err.trim() || '没听见。').slice(0, 4000));
  });
  child.on('error', () => {
    clearTimeout(timer);
    done('没能叫到 Claude。');
  });
}
