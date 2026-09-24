import fs from 'node:fs';
import path from 'node:path';
import { buildBrief } from '../core/brief';
import { defaultRelayConfig, loadRelayConfig } from '../core/config';
import { runGate } from '../core/gate';
import { appendLedger, loadLedger, nextStintId, saveStint, type Facts, type LedgerView, type Stint, type Who } from '../core/ledger';
import { pidAlive } from '../core/proc';
import { allMembers, type MemberInfo } from '../core/members';
import {
  BRIEF_REL,
  HANDOFF_DIR,
  handoffFileFor,
  handoffFilled,
  listHandoffFiles,
  listReviewFiles,
  readHandoff,
  readReview,
  readTask,
  reviewDiffFileFor,
  reviewFilled,
  type HandoffDoc,
} from '../core/notes';
import { matchProtected } from '../core/protected';
import { changeLine, headSnap, snapChanges, snapDiff, takeSnapshot } from '../core/snap';
import { stampLocal } from '../core/time';
import { needsReview, resolveWho, UNKNOWN_WHO } from '../core/tier';
import type { RelayConfig } from '../core/types';

/**
 * 记账：把项目文件夹里发生的事对上账本。
 * - 文件有变化 → 存快照；没有进行中的棒就开一棒（先记成「不知道是谁」）；
 * - 交接文件出现 → 认出是谁；交接写了「已交接 / 全部完成 / 卡住了」→ 这一棒结束；
 * - 一段时间没动静又没交接 → 当它被打断了，替它记一笔（要复核）；
 * - 复核文件写好了 → 被复核的那一棒标成「复核过了」；
 * - 最后重新生成接力本。
 * 可以随便重复调用（盯文件夹、打开网页、命令行都会调），结果只取决于文件和账本。
 */

export const QUIET_MS_DEFAULT = 20 * 60_000;

export function quietMs(): number {
  const v = Number(process.env.RELAY_QUIET_MS);
  return Number.isFinite(v) && v > 0 ? v : QUIET_MS_DEFAULT;
}

export function projectConfig(root: string): RelayConfig {
  try {
    return loadRelayConfig(root);
  } catch {
    return defaultRelayConfig();
  }
}

export function factsOf(root: string, from: string, to: string): Facts {
  const files = snapChanges(root, from, to);
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added ?? 0;
    removed += f.removed ?? 0;
  }
  return { files: files.length, added, removed, paths: files.slice(0, 200).map((f) => f.path) };
}

function nowIso(d = new Date()): string {
  return d.toISOString();
}

/** 交接里写的身份 → 认出是谁。 */
export function whoFromHandoff(h: HandoffDoc | null, members: MemberInfo[]): Who {
  if (!h) return UNKNOWN_WHO;
  return resolveWho({ who: h.who, tool: h.tool, model: h.model }, members);
}

/** 给复核准备的改动文件（.relay/复核/第N棒.diff）。太大就截断，并写上看完整的命令。 */
export function writeReviewDiff(root: string, s: Stint): void {
  if (!s.to) return;
  const rel = reviewDiffFileFor(s.id);
  const abs = path.join(root, rel);
  const MAX = 400_000;
  let diff = snapDiff(root, s.from, s.to);
  const cut = diff.length > MAX;
  if (cut) diff = diff.slice(0, MAX);
  const head = [
    `# 第 ${s.id} 棒（${s.who.label}）的真实改动`,
    `# ${changeLine(snapChanges(root, s.from, s.to))}`,
    `# 快照 ${s.from.slice(0, 10)} → ${s.to.slice(0, 10)}`,
    cut ? `# 太长了，只放了前面一部分。完整的：git --git-dir=.relay/snapshots --work-tree=. diff ${s.from.slice(0, 10)} ${s.to.slice(0, 10)}` : '',
    '',
  ]
    .filter((l, i) => l || i === 4)
    .join('\n');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${head}\n${diff}`);
}

/** 它没留交接：接力台替它记一份（只有事实）。 */
export function writeGhostHandoff(root: string, s: Stint, lastWords?: string): string {
  const rel = handoffFileFor(root, s.id, `${s.who.tool ?? 'ai'}-接力台代写`);
  const facts = s.facts;
  const lines = [
    `# 交接：${s.who.label}（接力台代写）`,
    '',
    `- 时间：${stampLocal(s.endedAt ?? new Date())}`,
    '- 状态：已交接',
    '',
    '> 这一棒没留交接（多半是额度用完被打断了），下面是接力台看到的事实。它到底做对没有，要等强模型复核。',
    '',
    '## 做了什么',
    '',
    facts && facts.files ? `- 改了 ${facts.files} 个文件（+${facts.added} −${facts.removed}）：${facts.paths.slice(0, 20).join('、')}${facts.paths.length > 20 ? ' ……' : ''}` : '- 没有改文件。',
    '',
  ];
  if (lastWords?.trim()) lines.push('## 它最后说的话', '', lastWords.trim().slice(0, 3000), '');
  lines.push('## 没做完 / 下一步', '', '- 不知道。先复核它改的东西，再对照任务清单看还差什么。', '');
  fs.mkdirSync(path.join(root, HANDOFF_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, rel), lines.join('\n'));
  return rel;
}

export interface CloseInput {
  status: Stint['status'];
  to: string;
  handoff?: HandoffDoc | null;
  lastWords?: string;
  note?: string;
  quotaUntil?: string;
  now?: Date;
}

/** 结束一棒：算事实、没交接就代写、定要不要复核、准备复核材料。返回结束后的样子（已记账）。 */
export function closeStint(root: string, s: Stint, input: CloseInput, cfg = projectConfig(root)): Stint {
  const now = input.now ?? new Date();
  const out: Stint = { ...s, to: input.to, endedAt: nowIso(now), status: input.status };
  delete out.pid;
  out.facts = factsOf(root, s.from, input.to);
  const hits = matchProtected(out.facts.paths, cfg.protectedPaths);
  if (hits.length) out.protectedHits = hits;
  else delete out.protectedHits;
  if (input.note) out.note = input.note;
  if (input.quotaUntil) out.quotaUntil = input.quotaUntil;
  const h = input.handoff ?? (out.handoff && !out.ghost ? readHandoff(root, out.handoff) : null);
  const real = !!h && !out.ghost && handoffFilled(h);
  if (real && h) {
    out.handoff = h.file;
    out.summary = h.summary || out.summary;
  } else if (!out.ghost && (out.facts.files > 0 || input.lastWords?.trim())) {
    if (h) out.note = [out.note, `它建了交接文件但没写内容：${h.file}`].filter(Boolean).join(' ');
    out.handoff = writeGhostHandoff(root, out, input.lastWords);
    out.ghost = true;
    out.summary = out.facts.files ? `没留交接：${changeLine(snapChanges(root, s.from, input.to))}` : '没留交接，也没改文件';
  }
  if (out.kind !== 'work') out.review = 'skip';
  else if (out.facts.files === 0) out.review = 'skip';
  else out.review = needsReview(out.who, real) ? 'needed' : 'skip';
  if (out.review === 'needed') writeReviewDiff(root, out);
  saveStint(root, out);
  return out;
}

/** 跑检查命令，把结果记到这一棒上（没配检查命令就什么都不做）。 */
export async function gateStint(root: string, id: number, cfg = projectConfig(root)): Promise<void> {
  if (!cfg.gate.command.trim()) return;
  const r = await runGate(root, cfg);
  const v = loadLedger(root);
  const s = v.stints.find((x) => x.id === id);
  if (!s) return;
  saveStint(root, { ...s, gate: { status: r.status, command: r.command, ...(r.status === 'fail' ? { detail: r.detail.slice(-1500) } : {}) } });
}

/** 看复核文件：写好了的，把它复核的那几棒标成「复核过了」。by = 做复核的那一棒。 */
export function applyReviews(root: string, by: Stint | null): number[] {
  const v = loadLedger(root);
  const marked: number[] = [];
  for (const f of listReviewFiles(root)) {
    const r = readReview(root, f.rel);
    if (!r || !reviewFilled(r)) continue;
    for (const id of r.targets) {
      const s = v.stints.find((x) => x.id === id);
      if (!s || s.status === 'working') continue;
      const prev = (s.reviews ?? []).find((m) => m.file === r.file);
      if (prev && prev.verdict === r.verdict) continue;
      const reviewer = by ?? v.stints.at(-1) ?? null;
      const mark = { by: reviewer?.id ?? 0, byLabel: r.by || reviewer?.who.label || '不知道是谁', file: r.file, verdict: r.verdict, at: nowIso() };
      const reviews = [...(s.reviews ?? []).filter((m) => m.file !== r.file), mark];
      saveStint(root, { ...s, review: 'done', reviews });
      marked.push(id);
    }
  }
  return marked;
}

// ---- 接力本 ----

function relayRunning(v: LedgerView): { label: string; since: string } | null {
  const o = v.open;
  if (!o || o.via !== 'relay' || !o.pid || !pidAlive(o.pid)) return null;
  return { label: o.who.label, since: o.startedAt };
}

/** 重新生成接力本。内容没变（除了时间）就不写，免得来回改文件。 */
export function refreshBrief(root: string, now = new Date()): boolean {
  const v = loadLedger(root);
  if (!v.init) return false;
  const cfg = projectConfig(root);
  const handoffs = new Map<string, HandoffDoc>();
  for (const s of v.stints) {
    if (s.handoff && !handoffs.has(s.handoff)) {
      const h = readHandoff(root, s.handoff);
      if (h) handoffs.set(s.handoff, h);
    }
  }
  const members = allMembers()
    .filter((m) => m.kind !== 'app' || m.tierSet || m.model)
    .map((m) => ({ label: m.label, ...(m.model ? { model: m.model } : {}), tier: m.tier }));
  const text = buildBrief({
    task: readTask(root),
    ledger: v,
    handoffs,
    members,
    gateCommand: cfg.gate.command.trim(),
    protectedPaths: cfg.protectedPaths,
    nextId: v.open?.id ?? nextStintId(v),
    now,
    running: relayRunning(v),
  });
  const p = path.join(root, BRIEF_REL);
  const strip = (t: string) => t.replace(/^> 接力台生成于[^\n]*\n/m, '');
  let cur = '';
  try {
    cur = fs.readFileSync(p, 'utf8');
  } catch {
    /* 还没有 */
  }
  if (strip(cur) === strip(text)) return false;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(`${p}.tmp`, text);
  fs.renameSync(`${p}.tmp`, p);
  return true;
}

// ---- 盯着文件夹时的记账 ----

export interface TrackOptions {
  /** 先存一张快照（默认存）。 */
  snapshot?: boolean;
  now?: Date;
}

export interface TrackResult {
  changed: boolean;
  /** 这次结束的棒（要跑检查的）。 */
  closed: number[];
  opened: number[];
  reviewed: number[];
}

/** 接力台调度的那一棒还在跑吗。 */
export function relayBusy(v: LedgerView): Stint | null {
  const o = v.open;
  return o && o.via === 'relay' && o.pid && pidAlive(o.pid) ? o : null;
}

/**
 * 对一次账。接力台自己在调度的时候什么都不做（那一棒由调度负责记）；
 * 调度中途接力台被关掉了，就把那一棒记成「叫停了」。
 */
export function track(root: string, opts: TrackOptions = {}): TrackResult {
  const res: TrackResult = { changed: false, closed: [], opened: [], reviewed: [] };
  let v = loadLedger(root);
  if (!v.init) return res;
  if (relayBusy(v)) return res;
  const now = opts.now ?? new Date();
  const snap = opts.snapshot === false ? headSnap(root) : takeSnapshot(root, '接力台看到了改动').sha;
  if (!snap) return res;
  const cfg = projectConfig(root);
  const members = allMembers();

  // 接力台调度到一半被关了。
  if (v.open && v.open.via === 'relay') {
    closeStint(root, v.open, { status: 'stopped', to: snap, note: '接力台中途被关掉了，这一棒没跑完。', now }, cfg);
    res.closed.push(v.open.id);
    res.changed = true;
    v = loadLedger(root);
  }

  const linked = new Set(v.stints.map((s) => s.handoff).filter(Boolean) as string[]);
  const unlinked = listHandoffFiles(root).filter((f) => !linked.has(f.rel));
  let open = v.open;

  const shouldClose = (s: Stint, h: HandoffDoc | null): 'handed' | 'unfinished' | null => {
    if (h && (h.state === 'handed' || h.state === 'finished' || h.state === 'stuck')) return 'handed';
    const last = Math.max(new Date(s.activeAt ?? s.startedAt).getTime(), h?.mtimeMs ?? 0);
    if (now.getTime() - last > quietMs()) return h ? 'handed' : 'unfinished';
    return null;
  };

  if (open) {
    let cur: Stint = open;
    let dirty = false;
    if (cur.to !== snap) {
      cur = { ...cur, to: snap, activeAt: nowIso(now), facts: factsOf(root, cur.from, snap) };
      dirty = true;
    }
    if (!cur.handoff && unlinked.length) {
      const f = unlinked.shift()!;
      const h = readHandoff(root, f.rel);
      cur = { ...cur, handoff: f.rel, who: whoFromHandoff(h, members), ...(h?.summary ? { summary: h.summary } : {}) };
      dirty = true;
    } else if (cur.handoff && unlinked.length) {
      // 另一个 AI 开始写它的交接了：前一棒到此为止。
      const h = readHandoff(root, cur.handoff);
      closeStint(root, cur, { status: h ? 'handed' : 'unfinished', to: snap, handoff: h, now }, cfg);
      res.closed.push(cur.id);
      res.changed = true;
      open = null;
      dirty = false;
    }
    if (open) {
      if (dirty) {
        saveStint(root, cur);
        res.changed = true;
      }
      const h = cur.handoff ? readHandoff(root, cur.handoff) : null;
      if (h && h.summary && h.summary !== cur.summary) {
        cur = { ...cur, summary: h.summary, who: whoFromHandoff(h, members) };
        saveStint(root, cur);
        res.changed = true;
      }
      const end = shouldClose(cur, h);
      if (end) {
        closeStint(root, cur, { status: end, to: snap, handoff: h, now }, cfg);
        res.closed.push(cur.id);
        res.changed = true;
        open = null;
      }
    }
    v = loadLedger(root);
  }

  // 没有进行中的棒：有新改动、或者有新交接，就开一棒。
  if (!open) {
    const base = v.base ?? snap;
    if (unlinked.length > 1) {
      // 接力台没开着的时候，好几个 AI 先后写了交接：改动分不清是谁的，都记在最后一棒里，按其中最弱的算。
      const docs = unlinked.map((f) => readHandoff(root, f.rel));
      const whos = docs.map((h) => whoFromHandoff(h, members));
      const lastId = nextStintId(v) + unlinked.length - 1;
      const weakest = whos.some((w) => w.tier === 'unknown') ? 'unknown' : whos.some((w) => w.tier === 'weak') ? 'weak' : 'strong';
      unlinked.forEach((f, i) => {
        const last = i === unlinked.length - 1;
        const h = docs[i];
        const s: Stint = {
          id: nextStintId(loadLedger(root)),
          kind: 'work',
          who: last ? { ...whos[i], tier: weakest } : whos[i],
          via: 'native',
          startedAt: nowIso(h?.mtimeMs ? new Date(Math.min(h.mtimeMs, now.getTime())) : now),
          activeAt: nowIso(now),
          from: base,
          to: last ? snap : base,
          status: 'working',
          review: 'needed',
          handoff: f.rel,
          note: last
            ? `接力台没开着的时候，第 ${nextStintId(v)}–${lastId} 棒的改动混在一起了，都记在这一棒里（按其中最弱的算）。`
            : `接力台没开着，这一棒的改动和后面几棒混在一起，记在第 ${lastId} 棒里。`,
          ...(h?.summary ? { summary: h.summary } : {}),
        };
        saveStint(root, s);
        res.opened.push(s.id);
        closeStint(root, s, { status: h && h.state !== 'working' ? 'handed' : last ? 'unfinished' : 'handed', to: s.to!, handoff: h, now }, cfg);
        res.closed.push(s.id);
      });
      unlinked.length = 0;
      res.changed = true;
    } else if (base !== snap || unlinked.length) {
      const f = unlinked.shift();
      const h = f ? readHandoff(root, f.rel) : null;
      const s: Stint = {
        id: nextStintId(v),
        kind: 'work',
        who: whoFromHandoff(h, members),
        via: 'native',
        startedAt: nowIso(h?.mtimeMs ? new Date(Math.min(h.mtimeMs, now.getTime())) : now),
        activeAt: nowIso(now),
        from: base,
        to: snap,
        status: 'working',
        review: 'needed',
        facts: factsOf(root, base, snap),
        ...(f ? { handoff: f.rel } : {}),
        ...(h?.summary ? { summary: h.summary } : {}),
      };
      saveStint(root, s);
      res.opened.push(s.id);
      res.changed = true;
      // 接力台没开着的时候就写好的交接：已经写完了就直接结束。
      if (h && (h.state === 'handed' || h.state === 'finished' || h.state === 'stuck')) {
        closeStint(root, s, { status: 'handed', to: snap, handoff: h, now }, cfg);
        res.closed.push(s.id);
      }
    }
  }

  const reviewer = loadLedger(root).open;
  const marked = applyReviews(root, reviewer);
  if (marked.length) {
    res.reviewed.push(...marked);
    res.changed = true;
  }
  if (refreshBrief(root, now)) res.changed = true;
  return res;
}

/** 对账，再给刚结束的棒跑检查命令（异步）。盯文件夹、网页用这个。 */
export async function trackAndGate(root: string, opts: TrackOptions = {}): Promise<TrackResult> {
  const r = track(root, opts);
  for (const id of r.closed) {
    try {
      await gateStint(root, id);
    } catch {
      /* 检查跑不了不影响记账 */
    }
  }
  if (r.closed.length) refreshBrief(root);
  return r;
}

/** 接力台自己改了项目文件（更新规矩之类）：存一张快照当新的起点，不算到哪一棒头上。 */
export function markBase(root: string, why: string): void {
  const v = loadLedger(root);
  if (!v.init || v.open) return;
  const r = takeSnapshot(root, why);
  if (r.sha !== v.base) appendLedger(root, { type: 'base', ts: nowIso(), snap: r.sha, why });
}
