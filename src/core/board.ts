import fs from 'node:fs';
import path from 'node:path';
import { git, repoRootAt } from './git';
import { relayConfigPath } from './config';
import { lastAudit, lastGate, lastRun, readEvents } from './journal';
import type { JournalEvent } from './types';
import { isAppLock, readLock } from './lock';
import { loadRegistry } from './registry';
import { loadSession, relayHome, type SessionState } from './session';
import { buildDeskChat, buildLegs, buildPapers, buildVoices, mergeChat, type ChatLine, type ChatVoice, type DeskPaper, type RelayLeg } from './chat';
import { buildIdentity, type Identity } from './identity';
import { listTalkRooms, pendingWindow, readTalk } from './talk';
import { loadUiMemory } from './ui-memory';

export type DeskPhase = 'not_git' | 'need_init' | 'idle' | 'working' | 'handed';
export type DeskFileSide = 'project' | 'site';

export interface DeskFile {
  name: string;
  kind: 'file' | 'dir';
}

export interface DeskProject {
  name: string;
  root: string;
  busy: boolean;
  current: boolean;
}

export interface ProjectDocket {
  name: string;
  root: string;
  current: boolean;
  papers: DeskPaper[];
}

export interface DeskState {
  root: string;
  phase: DeskPhase;
  title: string;
  hint: string;
  inited: boolean;
  task: string | null;
  branch: string | null;
  worktree: string | null;
  worktreeExists: boolean;
  dirtyCount: number;
  lastAgent: string | null;
  selectedAgent: string | null;
  who: string;
  windowId: string | null;
  llmId: string | null;
  llmLabel: string;
  llmHint: string;
  windows: Identity['windows'];
  brains: Identity['brains'];
  voices: ChatVoice[];
  chat: ChatLine[];
  pendingTalk: string | null;
  papers: DeskPaper[];
  dockets: ProjectDocket[];
  legs: RelayLeg[];
  product: string;
  onboard: string | null;
  lock: string | null;
  gate: string;
  audit: string;
  latestAudit: { path: string; content: string } | null;
  handoff: string | null;
  diff: string;
  agents: { name: string; kind: string; tier: string; note?: string }[];
  projects: DeskProject[];
  talks: { name: string; root: string; current: boolean; preview: string }[];
  files: DeskFile[];
  fileSide: DeskFileSide;
  fileRel: string;
  filePath: string;
  fileParent: string | null;
}

const SKIP_NAMES = new Set(['.git', 'node_modules', 'dist', '.DS_Store']);

function lastProduct(root: string): string {
  for (const name of ['HELLO-RELAY.md', '说明.txt', 'README.md']) {
    const p = path.join(root, name);
    const text = readSafe(p);
    if (text && text.trim()) return text.trim().slice(0, 4000);
  }
  return '';
}

function readSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function resolveProjectRoot(input: string): string {
  const abs = path.resolve(input);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`找不到文件夹：${abs}`);
  }
  try {
    return repoRootAt(abs);
  } catch {
    return abs;
  }
}

function underBase(base: string, target: string): boolean {
  const b = path.resolve(base);
  const t = path.resolve(target);
  return t === b || t.startsWith(b + path.sep);
}

export function resolveDeskDir(
  root: string,
  side: DeskFileSide,
  rel: string,
  worktree: string | null
): string {
  const base = side === 'site' && worktree ? worktree : root;
  const target = path.resolve(base, rel || '.');
  if (!underBase(base, target)) throw new Error('不能看这个位置');
  return target;
}

export function listDeskFiles(dir: string, limit = 80): DeskFile[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const names = fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, 'zh'));
  const out: DeskFile[] = [];
  for (const name of names) {
    if (SKIP_NAMES.has(name)) continue;
    const abs = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    out.push({ name, kind: st.isDirectory() ? 'dir' : 'file' });
    if (out.length >= limit) break;
  }
  return out;
}

export function readDeskPreview(abs: string, max = 12_000): string {
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    throw new Error('这不是文件');
  }
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) throw new Error('这个文件不能在这里预览');
  const text = buf.toString('utf8');
  return text.length > max ? `${text.slice(0, max)}\n…（后面还有）` : text;
}

function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function projectTitle(root: string): string {
  const file = path.join(root, '.relay', 'title.txt');
  try {
    const line = fs.readFileSync(file, 'utf8').split('\n')[0].trim();
    if (line) return line;
  } catch {
    /* 没有自定题目就用文件夹名 */
  }
  return path.basename(root);
}

export function writeProjectTitle(root: string, title: string): string {
  const line = title.replace(/\s+/g, ' ').trim();
  if (!line) throw new Error('先写题目');
  fs.mkdirSync(path.join(root, '.relay'), { recursive: true });
  fs.writeFileSync(path.join(root, '.relay', 'title.txt'), line + '\n');
  return line;
}

export function listKnownProjects(current: string): DeskProject[] {
  const seen = new Set<string>();
  const out: DeskProject[] = [];
  const here = realPath(current);
  const add = (root: string) => {
    const abs = realPath(root);
    if (seen.has(abs) || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return;
    seen.add(abs);
    let busy = false;
    try {
      busy = loadSession(abs) !== null;
    } catch {
      busy = false;
    }
    out.push({
      name: projectTitle(abs),
      root: abs,
      busy,
      current: abs === here,
    });
  };

  add(current);
  for (const r of loadUiMemory().recents ?? []) add(r);

  const projDir = path.join(relayHome(), 'projects');
  if (fs.existsSync(projDir)) {
    for (const name of fs.readdirSync(projDir)) {
      const sp = path.join(projDir, name, 'session.json');
      if (!fs.existsSync(sp)) continue;
      try {
        const s = JSON.parse(fs.readFileSync(sp, 'utf8')) as { repoRoot?: string };
        if (s.repoRoot) add(s.repoRoot);
      } catch {
        /* skip broken pointer */
      }
    }
  }

  return out.slice(0, 16);
}

function loadForeignDocket(p: DeskProject): ProjectDocket {
  const blank: ProjectDocket = {
    name: p.name,
    root: p.root,
    current: p.current,
    papers: buildPapers({
      phase: 'idle',
      handoff: null,
      latestAudit: null,
      onboard: null,
      diff: '',
      product: '',
    }),
  };
  try {
    const session = loadSession(p.root);
    if (!session) return blank;
    const wt = session.worktree;
    if (!fs.existsSync(wt)) return blank;
    let events: JournalEvent[] = [];
    try {
      events = readEvents(wt);
    } catch {
      events = [];
    }
    const a = lastAudit(events);
    let latestAudit: { content: string } | null = null;
    if (a) {
      const content = readSafe(path.join(wt, a.report));
      if (content) latestAudit = { content };
    }
    return {
      name: p.name,
      root: p.root,
      current: p.current,
      papers: buildPapers({
        phase: 'working',
        handoff: readSafe(path.join(wt, '.relay', 'handoff.md')),
        latestAudit,
        onboard: readSafe(path.join(wt, '.relay', 'ONBOARD.md')),
        diff: '',
        product: '',
      }),
    };
  } catch {
    return blank;
  }
}

export function pickDefaultAgent(agents: DeskState['agents'], last?: string | null): string | null {
  const mem = loadUiMemory().agent;
  if (mem && agents.some((a) => a.name === mem)) return mem;
  if (last && agents.some((a) => a.name === last)) return last;
  const cursor = agents.find((a) => a.name === 'cursor');
  if (cursor) return cursor.name;
  const app = agents.find((a) => a.kind === 'app');
  return (app ?? agents[0])?.name ?? null;
}

export function loadDeskState(
  rootInput: string,
  view: { side?: DeskFileSide; rel?: string } = {}
): DeskState {
  const root = path.resolve(rootInput);
  const agents = loadRegistry().agents.map((a) => ({
    name: a.name,
    kind: a.kind ?? 'cli',
    tier: a.tier,
    note: a.note,
  }));
  const projects = listKnownProjects(root);
  const selectedAgent = pickDefaultAgent(agents);
  const finish = (s: DeskState, events: JournalEvent[] = []): DeskState => {
    const extraLlms = events.map((e) => e.llm).filter((x): x is string => !!x);
    const id = buildIdentity(s.agents, s.lastAgent, extraLlms);
    const next = {
      ...s,
      ...id,
      selectedAgent: id.windowId ?? s.selectedAgent,
    };
    const papers = buildPapers({ ...next, product: '' });
    const talk = readTalk(next.root);
    const dockets = (next.projects || [])
      .map((p) =>
        p.current
          ? { name: p.name, root: p.root, current: true, papers }
          : loadForeignDocket(p)
      )
      .filter((d) => d.current || d.papers.some((p) => !p.empty));
    return {
      ...next,
      voices: buildVoices(id, events, talk),
      chat: mergeChat(buildDeskChat(events, id, next), talk),
      pendingTalk: pendingWindow(talk),
      talks: listTalkRooms(next.projects || []),
      papers,
      dockets,
      legs: buildLegs(next.phase, events, {
        window: id.windowId || undefined,
        who: id.who && id.who !== '未识别' ? id.who : undefined,
      }),
    };
  };

  const empty = (phase: DeskPhase, title: string, hint: string): DeskState => {
    const fileSide: DeskFileSide = view.side === 'site' ? 'site' : 'project';
    const fileRel = view.rel ?? '';
    let filePath = root;
    try {
      filePath = resolveDeskDir(root, fileSide, fileRel, null);
    } catch {
      filePath = root;
    }
    return {
      root,
      phase,
      title,
      hint,
      inited: false,
      task: null,
      branch: null,
      worktree: null,
      worktreeExists: false,
      dirtyCount: 0,
      lastAgent: null,
      selectedAgent,
      who: '',
      windowId: null,
      llmId: null,
      llmLabel: '',
      llmHint: '',
      windows: [],
      brains: [],
      voices: [],
      chat: [],
      pendingTalk: null,
      papers: [],
      dockets: [],
      legs: [],
      product: '',
      onboard: null,
      lock: null,
      gate: '还没跑',
      audit: '还没跑',
      latestAudit: null,
      handoff: null,
      diff: '',
      agents,
      projects,
      talks: [],
      files: listDeskFiles(filePath),
      fileSide,
      fileRel: filePath === root ? '' : path.relative(root, filePath),
      filePath,
      fileParent: filePath === root ? null : path.dirname(fileRel || '.') === '.' ? '' : path.dirname(fileRel),
    };
  };

  let gitRoot: string;
  try {
    gitRoot = repoRootAt(root);
  } catch {
    return finish(empty('not_git', '写下要做什么', '这个文件夹还不是项目。写下要做什么，按开始，这里会做成项目。'));
  }

  const inited = fs.existsSync(relayConfigPath(gitRoot));
  if (!inited) {
    return finish({
      ...empty('need_init', '还没布置', '按开始。'),
      root: gitRoot,
      projects: listKnownProjects(gitRoot),
    });
  }

  const session: SessionState | null = loadSession(gitRoot);
  if (!session) {
    return finish({
      ...empty('idle', '写下要做什么', '正式文件夹先不动。'),
      root: gitRoot,
      inited: true,
      projects: listKnownProjects(gitRoot),
      product: lastProduct(gitRoot),
    });
  }

  const wt = session.worktree;
  const exists = fs.existsSync(wt);
  let events: JournalEvent[] = [];
  try {
    events = exists ? readEvents(wt) : [];
  } catch {
    events = [];
  }
  const lock = exists ? readLock(wt) : null;
  const dirty = exists ? git(wt, ['status', '--porcelain']).stdout : '';
  const dirtyCount = dirty === '' ? 0 : dirty.split('\n').filter((l) => l.trim() !== '').length;
  const g = lastGate(events);
  const a = lastAudit(events);
  const run = lastRun(events);

  let latestAudit: DeskState['latestAudit'] = null;
  if (a) {
    const content = readSafe(path.join(wt, a.report));
    if (content) latestAudit = { path: a.report, content };
  }
  const handoff = exists ? readSafe(path.join(wt, '.relay', 'handoff.md')) : null;
  const base = session.baseCommit;
  const head = exists ? git(wt, ['rev-parse', 'HEAD']).stdout : '';
  const businessDiff =
    exists && head ? git(wt, ['diff', '--name-only', `${base}..${head}`, '--', '.', ':(exclude).relay']) : null;
  const business = businessDiff && businessDiff.code === 0 ? businessDiff.stdout.trim() : '';
  const handed =
    exists && dirtyCount === 0 && g?.status === 'pass' && events.some((e) => e.type === 'handoff') && business !== '';
  const phase: DeskPhase = handed ? 'handed' : 'working';
  const diff =
    exists && head
      ? git(wt, ['diff', `${base}..${head}`, '--', '.', ':(exclude).relay']).stdout
      : '';

  const title = handed ? '可以合回去了' : dirtyCount > 0 || lock ? '正在改' : '已经开始，还没改';
  const hint = handed
    ? '看过文件没问题，按合回去。还想改，再打开窗口。'
    : '打开窗口去改。改完按记下来。正式文件夹现在还是旧的。';

  const fileSide: DeskFileSide = view.side ?? (exists ? 'site' : 'project');
  const fileRel = view.rel ?? '';
  let filePath = fileSide === 'site' && exists ? wt : gitRoot;
  try {
    filePath = resolveDeskDir(gitRoot, fileSide, fileRel, exists ? wt : null);
  } catch {
    filePath = fileSide === 'site' && exists ? wt : gitRoot;
  }
  const fileBase = fileSide === 'site' && exists ? wt : gitRoot;
  const relNow = path.relative(fileBase, filePath);

  return finish({
    root: gitRoot,
    phase,
    title,
    hint,
    inited: true,
    task: session.taskTitle,
    branch: session.branch,
    worktree: wt,
    worktreeExists: exists,
    dirtyCount,
    lastAgent: run?.agent ?? null,
    selectedAgent: pickDefaultAgent(agents, run?.agent),
    who: '',
    windowId: null,
    llmId: null,
    llmLabel: '',
    llmHint: '',
    windows: [],
    brains: [],
    voices: [],
    chat: [],
    pendingTalk: null,
    papers: [],
    dockets: [],
    legs: [],
    product: lastProduct(gitRoot),
    onboard: exists ? readSafe(path.join(wt, '.relay', 'ONBOARD.md')) : null,
    lock: lock ? (isAppLock(lock) ? `${lock.agent} 的窗口还开着` : `${lock.agent} 还在跑`) : null,
    gate: g ? (g.status === 'pass' ? '通过' : `没通过（${g.command}）`) : '还没跑',
    audit: a ? (a.status === 'ok' ? '有摘要' : '只有事实') : '还没跑',
    latestAudit,
    handoff,
    diff: diff.slice(0, 20_000),
    agents,
    projects: listKnownProjects(gitRoot),
    talks: [],
    files: listDeskFiles(filePath),
    fileSide,
    fileRel: relNow === '.' ? '' : relNow,
    filePath,
    fileParent: relNow && relNow !== '.' ? (path.dirname(relNow) === '.' ? '' : path.dirname(relNow)) : null,
  }, events);
}
