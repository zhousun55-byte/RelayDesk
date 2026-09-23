import fs from 'node:fs';
import path from 'node:path';
import { loadRelayConfig } from '../core/config';
import { envValue } from '../core/env';
import { errorMessage } from '../core/errors';
import { gateConfigured } from '../core/gate';
import { currentBranch, git, mergeBase, mergeInProgress, shortSha } from '../core/git';
import {
  checkpoints,
  lastAudit,
  lastGate,
  lastHandoff,
  lastReviewTarget,
  lastSegmentRun,
  pendingSyncConflicts,
  readEvents,
  type CheckpointInfo,
} from '../core/journal';
import { clearStaleLock, lockActive, lockKind, readLock } from '../core/lock';
import { inspectProject, type ProjectInfo } from '../core/project';
import { matchProtected } from '../core/protected';
import { agentLabel, findAgent } from '../core/registry';
import { loadSession, type SessionState } from '../core/session';
import { businessEntries, diffFiles, listStray, statusWord, sumChanges, type FileChange } from '../core/status';
import type { JournalEvent, RelayConfig } from '../core/types';
import { pendingChanges } from './context';
import { mainAhead } from './sync';

export type Phase = 'broken' | 'working' | 'busy' | 'conflict' | 'unsaved' | 'fresh' | 'blocked' | 'mergeable';

export interface TimelineItem {
  ts: string;
  kind: JournalEvent['type'];
  text: string;
  who?: string;
  /** 工人名（网页按它给支线上色）。 */
  agent?: string;
  detail?: string;
  sha?: string;
  report?: string;
  ok?: boolean;
  /** 交接：这一段改了多少。 */
  size?: string;
  /** 全自动流水线派的活。 */
  auto?: boolean;
}

export interface TaskView {
  title: string;
  taskText: string;
  branch: string;
  worktree: string;
  worktreeExists: boolean;
  startedAt: string;
  base: string;
  mainBranch: string | null;
  phase: Phase;
  phaseText: string;
  /** 正在岗的人（有锁时）。 */
  onShift: { agent: string; label: string; kind: 'cli' | 'app' | 'op'; llm?: string; since: string; op?: string; auto?: boolean } | null;
  /** 这一段上岗过、但已经下岗（终端工人退出了）的人。 */
  lastWorker: { agent: string; label: string; llm?: string } | null;
  pending: string[];
  changes: FileChange[];
  totals: { files: number; added: number; removed: number };
  gate: { status: 'pass' | 'fail'; command: string; detail?: string; ts: string } | null;
  audit: { path: string; status: 'ok' | 'failed'; ts: string } | null;
  handoffDoc: string | null;
  checkpoints: CheckpointInfo[];
  timeline: TimelineItem[];
  stray: { path: string; word: string }[];
  conflicts: string[];
  mainAhead: number;
  protectedHits: string[];
  review: { label: string; weak: boolean; from: string; to: string } | null;
  handoffs: number;
  error?: string;
}

export interface PastTask {
  branch: string;
  title: string;
  date: string;
  result: 'merged' | 'abandoned' | 'unfinished';
  commit?: string;
}

export interface ProjectView extends ProjectInfo {
  config: (RelayConfig & { keySet: boolean }) | null;
  configError?: string;
  task: TaskView | null;
  taskError?: string;
  past: PastTask[];
  mainDirty: number;
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** 检查点的说法：「手动终端工具 交接后」「任务开始时」。 */
function checkpointWords(c: CheckpointInfo): string {
  return c.label === '交接' ? `${agentLabel(c.agent)} 交接后` : '任务开始时';
}

function who(ev: { agent?: string; llm?: string }): string {
  const a = ev.agent ? agentLabel(findAgent(ev.agent) ?? ev.agent) : '接力台';
  return ev.llm ? `${a} · ${ev.llm}` : a;
}

const AUTO_WORDS: Record<string, string> = { done: '完成', ready: '审查通过，等你合回', 'needs-human': '需要你来看一下', failed: '没做成', stopped: '已停止' };

/** 交接记录 → 给人看的时间线。检查、审计合并进它们所属的那次交接。 */
export function buildTimeline(events: JournalEvent[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  let pendingGate: JournalEvent | null = null;
  let pendingAudit: JournalEvent | null = null;
  for (const ev of events) {
    switch (ev.type) {
      case 'start':
        out.push({ ts: ev.ts, kind: ev.type, text: '开始任务', detail: ev.task });
        break;
      case 'run':
      case 'open':
        out.push({
          ts: ev.ts,
          kind: ev.type,
          who: who(ev),
          ...(ev.agent ? { agent: ev.agent } : {}),
          text: `${who(ev)} 上岗${ev.type === 'open' ? '（桌面）' : ev.type === 'run' && ev.auto ? `（全自动第 ${ev.round ?? 1} 轮）` : '（终端）'}`,
          ...(ev.type === 'run' && ev.auto ? { auto: true } : {}),
          ...(ev.overrode ? { detail: `强行接替了 ${agentLabel(ev.overrode)}` } : {}),
        });
        break;
      case 'exit':
        out.push({
          ts: ev.ts,
          kind: ev.type,
          who: who(ev),
          ...(ev.agent ? { agent: ev.agent } : {}),
          text: `${who(ev)} 退出${ev.code === 0 ? '' : `（代码 ${ev.code}）`}`,
          ok: ev.code === 0,
        });
        break;
      case 'gate':
        pendingGate = ev;
        break;
      case 'audit':
        pendingAudit = ev;
        break;
      case 'handoff': {
        const g = pendingGate?.type === 'gate' ? pendingGate : null;
        const a = pendingAudit?.type === 'audit' ? pendingAudit : null;
        const size = ev.empty ? '没有改动' : ev.files !== undefined ? `${ev.files} 个文件 +${ev.added ?? 0} −${ev.removed ?? 0}` : '有改动';
        const parts = [size];
        const checked = g && gateConfigured(g) ? g : null;
        if (checked) parts.push(checked.status === 'pass' ? `检查通过` : `检查没过`);
        out.push({
          ts: ev.ts,
          kind: ev.type,
          who: who(ev),
          ...(ev.agent ? { agent: ev.agent } : {}),
          text: `${who(ev)} 交接：${parts.join('，')}`,
          size,
          sha: ev.checkpoint,
          ...(a ? { report: a.report } : {}),
          ...(checked ? { ok: checked.status === 'pass' } : {}),
          ...(ev.note || ev.selfNote ? { detail: [ev.note ? `留言：${ev.note}` : '', ev.selfNote ? `自述：${ev.selfNote}` : ''].filter(Boolean).join('\n') } : {}),
        });
        pendingGate = null;
        pendingAudit = null;
        break;
      }
      case 'take':
        out.push({ ts: ev.ts, kind: ev.type, text: `从正式文件夹收进 ${ev.files.length} 个文件`, detail: ev.files.join('、') });
        break;
      case 'sync':
        out.push({
          ts: ev.ts,
          kind: ev.type,
          text: ev.aborted ? '撤销了同步' : ev.conflicts?.length ? '同步正式文件夹的新提交，有冲突' : '同步了正式文件夹的新提交',
          ...(ev.conflicts?.length ? { detail: ev.conflicts.join('、') } : {}),
          ...(ev.commit ? { sha: ev.commit } : {}),
        });
        break;
      case 'rollback': {
        const cp = checkpoints(events).find((c) => c.sha === ev.to);
        out.push({ ts: ev.ts, kind: ev.type, text: `退回到${cp ? `「${checkpointWords(cp)}」` : ` ${shortSha(ev.to)}`}`, sha: ev.to });
        break;
      }
      case 'merge':
        out.push({ ts: ev.ts, kind: ev.type, text: '合回正式文件夹', sha: ev.commit });
        break;
      case 'abandon':
        out.push({ ts: ev.ts, kind: ev.type, text: '放弃任务' });
        break;
      case 'review':
        out.push({
          ts: ev.ts,
          kind: ev.type,
          who: who(ev),
          ...(ev.agent ? { agent: ev.agent } : {}),
          text: `${who(ev)} 审查：${ev.verdict === 'pass' ? '通过' : `要修改（${ev.issues.length} 条）`}`,
          ok: ev.verdict === 'pass',
          sha: ev.checkpoint,
          detail: [ev.summary, ...ev.issues.map((x, i) => `${i + 1}. ${x}`)].filter(Boolean).join('\n'),
        });
        break;
      case 'auto':
        out.push({
          ts: ev.ts,
          kind: ev.type,
          text: ev.phase === 'begin' ? '全自动开始' : `全自动结束：${AUTO_WORDS[ev.status ?? ''] ?? ev.status ?? ''}`,
          ...(ev.detail ? { detail: ev.detail } : {}),
          ...(ev.phase === 'end' ? { ok: ev.status === 'done' || ev.status === 'ready' } : {}),
        });
        break;
    }
  }
  // 单独跑的检查（relay gate）没有对应交接，也列出来。
  if (pendingGate?.type === 'gate' && gateConfigured(pendingGate)) {
    out.push({ ts: pendingGate.ts, kind: 'gate', text: pendingGate.status === 'pass' ? '检查通过' : '检查没过', ok: pendingGate.status === 'pass' });
  }
  return out;
}

export function loadTaskView(root: string, session: SessionState, cfg: RelayConfig | null): TaskView {
  const wt = session.worktree;
  const exists = fs.existsSync(wt);
  const base: TaskView = {
    title: session.taskTitle,
    taskText: '',
    branch: session.branch,
    worktree: wt,
    worktreeExists: exists,
    startedAt: session.startedAt,
    base: shortSha(session.baseCommit),
    mainBranch: session.mainBranch ?? currentBranch(root),
    phase: 'broken',
    phaseText: '',
    onShift: null,
    lastWorker: null,
    pending: [],
    changes: [],
    totals: { files: 0, added: 0, removed: 0 },
    gate: null,
    audit: null,
    handoffDoc: null,
    checkpoints: [],
    timeline: [],
    stray: [],
    conflicts: [],
    mainAhead: 0,
    protectedHits: [],
    review: null,
    handoffs: 0,
  };
  if (!exists) {
    return { ...base, phaseText: '这个任务的隔离副本不见了。只能放弃它（接力分支还在，东西不会丢）。' };
  }
  let events: JournalEvent[];
  try {
    events = readEvents(wt);
  } catch (e) {
    return { ...base, phaseText: errorMessage(e), error: errorMessage(e) };
  }
  clearStaleLock(wt);
  const lock = readLock(wt);
  const active = lock && lockActive(lock) ? lock : null;
  const pending = pendingChanges(wt, events, session.baseCommit);
  const mainRef = base.mainBranch ?? 'HEAD';
  const mb = mergeBase(wt, mainRef, 'HEAD') ?? session.baseCommit;
  const changes = diffFiles(wt, mb, 'HEAD');
  const gateEv = lastGate(events);
  const auditEv = lastAudit(events);
  const conflicts = mergeInProgress(wt) ? pendingSyncConflicts(events) : [];
  const hits = cfg ? matchProtected(changes.map((f) => f.path), cfg.protectedPaths) : [];
  const seg = lastSegmentRun(events);
  const review = lastReviewTarget(events);

  let phase: Phase;
  let phaseText: string;
  if (active) {
    const k = lockKind(active);
    const name = `${agentLabel(findAgent(active.agent) ?? active.agent)}${active.llm ? ` · ${active.llm}` : ''}`;
    if (k === 'app') {
      phase = 'working';
      phaseText = `${name} 正在干活（桌面窗口）。它停手后，回来点「交接」。`;
    } else if (k === 'cli') {
      phase = 'working';
      phaseText = active.auto ? `全自动：${name} 正在干活，做完会自动交接、审查。` : `${name} 正在终端里干活。它退出后，回来点「交接」。`;
    } else {
      phase = 'busy';
      phaseText = `接力台正在${active.op ?? '处理'}，请稍等……`;
    }
  } else if (conflicts.length || mergeInProgress(wt)) {
    phase = 'conflict';
    phaseText = `同步正式文件夹时有冲突：${conflicts.join('、') || '（见隔离副本）'}。让一个工人上岗把冲突解决掉，然后交接。`;
  } else if (pending.files.length) {
    phase = 'unsaved';
    phaseText = `有 ${pending.files.length} 个改动还没交接。点「交接」把它们存下来。`;
  } else if (changes.length === 0) {
    phase = 'fresh';
    phaseText = events.some((e) => e.type === 'handoff') ? '目前没有要合回的改动。选一个工人上岗接着干。' : '还没有改动。选一个工人上岗开始干活。';
  } else if (gateEv?.status === 'fail') {
    phase = 'blocked';
    phaseText =
      `检查没通过（${gateEv.command}）${hits.length ? `，还改到了不许改的文件：${hits.join('、')}` : ''}。` +
      '让工人修好再交接；确定没问题也可以强制合回。';
  } else if (hits.length) {
    phase = 'blocked';
    phaseText = `改到了不许改的文件：${hits.join('、')}。让工人改回来，或者强制合回。`;
  } else {
    phase = 'mergeable';
    phaseText = '改好了，可以合回正式文件夹。也可以换个工人接着改或复查。';
  }

  const stray = listStray(root, session.mainSnapshot).map((e) => ({ path: e.path, word: statusWord(e.code) }));
  return {
    ...base,
    taskText: readText(path.join(wt, '.relay', 'task.md')) ?? session.taskTitle,
    phase,
    phaseText,
    onShift: active
      ? {
          agent: active.agent,
          label: agentLabel(findAgent(active.agent) ?? active.agent),
          kind: lockKind(active),
          ...(active.llm ? { llm: active.llm } : {}),
          since: active.ts,
          ...(active.op ? { op: active.op } : {}),
          ...(active.auto ? { auto: true } : {}),
        }
      : null,
    lastWorker: seg ? { agent: seg.agent, label: agentLabel(findAgent(seg.agent) ?? seg.agent), ...(seg.llm ? { llm: seg.llm } : {}) } : null,
    pending: pending.files,
    changes,
    totals: sumChanges(changes),
    gate: gateEv ? { status: gateEv.status, command: gateEv.command, ...(gateEv.detail ? { detail: gateEv.detail } : {}), ts: gateEv.ts } : null,
    audit: auditEv ? { path: auditEv.report, status: auditEv.status, ts: auditEv.ts } : null,
    handoffDoc: lastHandoff(events) ? readText(path.join(wt, '.relay', 'handoff.md')) : null,
    checkpoints: checkpoints(events, session.startCommit).map((c) => ({ ...c, who: checkpointWords(c) })),
    timeline: buildTimeline(events),
    stray,
    conflicts,
    mainAhead: mainAhead(wt, mainRef),
    protectedHits: hits,
    review: review
      ? { label: `${agentLabel(findAgent(review.agent) ?? review.agent)}${review.llm ? ` · ${review.llm}` : ''}`, weak: review.tier === 'weak', from: review.from, to: review.to }
      : null,
    handoffs: events.filter((e) => e.type === 'handoff').length,
  };
}

/** 这个项目以前的任务（接力分支），新的在前。 */
export function listPastTasks(root: string, activeBranch?: string, limit = 15): PastTask[] {
  const r = git(root, ['for-each-ref', '--sort=-committerdate', `--count=${limit + 1}`, '--format=%(refname:short)%09%(committerdate:iso-strict)', 'refs/heads/relay/']);
  if (r.code !== 0 || !r.stdout) return [];
  const out: PastTask[] = [];
  for (const line of r.stdout.split('\n')) {
    const [branch, date] = line.split('\t');
    if (!branch || branch === activeBranch) continue;
    const j = git(root, ['show', `${branch}:.relay/journal.jsonl`]);
    let title = branch.replace(/^relay\//, '');
    let result: PastTask['result'] = 'unfinished';
    let commit: string | undefined;
    if (j.code === 0) {
      for (const l of j.stdout.split('\n')) {
        try {
          const ev = JSON.parse(l) as JournalEvent;
          if (ev.type === 'start') title = ev.task.split('\n')[0].slice(0, 80);
          if (ev.type === 'merge') {
            result = 'merged';
            commit = ev.commit;
          }
          if (ev.type === 'abandon') result = 'abandoned';
        } catch {
          /* 坏行跳过 */
        }
      }
    }
    out.push({ branch, title, date, result, ...(commit ? { commit } : {}) });
    if (out.length >= limit) break;
  }
  return out;
}

export function loadProjectView(dir: string): ProjectView {
  const info = inspectProject(dir);
  const view: ProjectView = { ...info, config: null, task: null, past: [], mainDirty: 0 };
  if (!info.isGit) return view;
  if (info.hasConfig) {
    try {
      const cfg = loadRelayConfig(info.root);
      view.config = { ...cfg, keySet: !!(cfg.audit.apiKeyEnv && envValue(cfg.audit.apiKeyEnv)) };
    } catch (e) {
      view.configError = errorMessage(e);
    }
  }
  try {
    const s = loadSession(info.root);
    if (s) view.task = loadTaskView(info.root, s, view.config);
  } catch (e) {
    view.taskError = errorMessage(e);
  }
  view.mainDirty = businessEntries(info.root).length;
  view.past = listPastTasks(info.root, view.task?.branch);
  return view;
}
