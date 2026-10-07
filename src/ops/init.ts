import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultRelayConfig, relayConfigPath } from '../core/config';
import { RelayError } from '../core/errors';
import { appendLedger, loadLedger, taskChanges } from '../core/ledger';
import { HANDOFF_DIR, REVIEW_DIR, TASK_REL, parseTask, readTask, readTaskCopy, saveTaskCopy, taskTemplate, setTask } from '../core/notes';
import { loadMemory, rememberProject } from '../core/memory';
import { relayHome } from '../core/paths';
import { installProtocol, protocolState } from '../core/protocol';
import { ensureSnapRepo, takeSnapshot } from '../core/snap';
import { setThreadHidden } from './hidden';
import { withLock } from './lock';
import { markBase, refreshBrief } from './track';
import { acceptanceNow } from './view';
import { writeProjectFile } from '../core/safe-write';

/**
 * 接入：让一个文件夹开始接力。可以重复执行（缺什么补什么）。
 * 不需要 git；不碰你自己的 git（快照在 .relay/snapshots，.relay 里自带 .gitignore）。
 */

/**
 * .relay 默认整个不进你的 git：任务、交接、复核、账本里有 AI 的原话、改动摘要和文件名。
 * 只留配置（检查命令、不许改的文件），同伴拉下来能用同一套规矩。
 */
const RELAY_GITIGNORE = [
  '# 接力台自己的数据，默认都不进你的 git（任务、交接、复核、账本里有 AI 的原话和改动摘要）',
  '# 想提交哪样，在最后加一行，比如：!任务.md，或者 !交接/ 和 !交接/**',
  '*',
  '!.gitignore',
  '!config.json',
  '',
].join('\n');

/** 以前版本写的默认内容（没被人改过的，接入时换成现在的）。 */
const OLD_GITIGNORE = ['# 接力台自己的数据，不进你的 git（任务、交接、复核、账本想提交就提交）', 'snapshots/', 'runs/', '接力本.md', '复核/*.diff', 'talk*.jsonl', '*.tmp', '*.lock', ''].join('\n');

export interface InitResult {
  root: string;
  /** 这次新做了哪些事（给人看）。 */
  actions: string[];
  /** 之前就接入过。 */
  already: boolean;
}

/** 不许接入的文件夹：整个家目录、系统目录。 */
export function checkRoot(dir: string): string {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new RelayError(`找不到文件夹：${root}`, 'no-dir');
  const home = os.homedir();
  // Windows 上路径不分大小写，盘符根目录（C:\）、Windows、Program Files、Users 也不行
  const win = process.platform === 'win32';
  const key = (p: string) => (win ? path.resolve(p).toLowerCase() : p);
  const sys = win
    ? [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData, path.dirname(home)].filter((x): x is string => !!x)
    : ['/Users', '/Applications', '/System', '/usr', '/etc', '/private', '/tmp', '/var'];
  const bad = new Set([home, path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads'), ...sys].map(key));
  if (path.parse(root).root === root || bad.has(key(root))) throw new RelayError(`「${root}」太大了，不像是一个项目。选具体的项目文件夹。`, 'bad-root');
  if (root === path.resolve(relayHome()) || root.startsWith(path.resolve(relayHome()) + path.sep)) throw new RelayError('不能接入接力台自己的数据文件夹。', 'bad-root');
  return root;
}

export interface InitOptions {
  /** 顺手写下任务。 */
  task?: string;
  /** 只补规矩（已接入时用）。 */
  quiet?: boolean;
}

export function initProject(dir: string, opts: InitOptions = {}): InitResult {
  const root = checkRoot(dir);
  const actions: string[] = [];
  const relayDir = path.join(root, '.relay');
  const already = loadLedger(root).init !== null;

  fs.mkdirSync(relayDir, { recursive: true });
  const gi = path.join(relayDir, '.gitignore');
  if (!fs.existsSync(gi) || fs.readFileSync(gi, 'utf8') === OLD_GITIGNORE) {
    writeProjectFile(gi, RELAY_GITIGNORE, root);
  }
  for (const d of [HANDOFF_DIR, REVIEW_DIR]) fs.mkdirSync(path.join(root, d), { recursive: true });
  if (!fs.existsSync(relayConfigPath(root))) {
    writeProjectFile(relayConfigPath(root), JSON.stringify(defaultRelayConfig(), null, 2) + '\n', root);
  }
  if (!fs.existsSync(path.join(root, TASK_REL))) {
    if (opts.task?.trim()) setTask(root, opts.task);
    else writeProjectFile(path.join(root, TASK_REL), taskTemplate(), root);
    actions.push(`建了任务清单 ${TASK_REL}`);
  } else if (opts.task?.trim()) {
    setTask(root, opts.task);
    actions.push('换了新任务（旧任务存进了 .relay/做完的任务.md）');
  }

  const before = protocolState(root);
  const changed = installProtocol(root);
  if (changed.length) actions.push(before === 'missing' ? `在 ${changed.join('、')} 里写了接力规矩（各家 AI 工具开工都会读）` : `更新了 ${changed.join('、')} 里的接力规矩`);

  ensureSnapRepo(root);
  if (!already) {
    const snap = takeSnapshot(root, '接入').sha;
    const taskCopy = saveTaskCopy(root);
    appendLedger(root, { type: 'init', ts: new Date().toISOString(), snap, version: '2', ...(taskCopy ? { taskCopy } : {}) });
    actions.push('存了第一张快照（以后改坏了能退回到这里）');
  } else if (changed.length) {
    markBase(root, '接力台更新了接力规矩');
  }
  rememberProject(root);
  refreshBrief(root);
  return { root, actions, already };
}

// ---- 接入过的文件夹（盯文件夹用） ----

/** 最近打开过、而且接入过的文件夹。 */
export function liveProjects(): string[] {
  const m = loadMemory();
  const list = [...new Set([...(m.root ? [m.root] : []), ...(m.recents ?? [])])];
  return list.filter((r) => fs.existsSync(path.join(r, '.relay', 'journal.jsonl')));
}

// ---- 换任务 ----

/**
 * 写下新任务（旧的存档），记一笔，从这张快照开始算这件事。mode = dispatch：在派活页写的，全自动用派活。
 * 拿着调度锁：全自动跑到一半不能把任务换掉。
 */
export function newTask(root: string, text: string, items: string[] = [], mode?: 'dispatch'): void {
  const t = text.trim();
  if (!t) throw new RelayError('任务是空的', 'no-task');
  const v = loadLedger(root);
  if (!v.init) throw new RelayError('这个文件夹还没接入接力台。', 'not-init');
  withLock(root, () => switchTask(root, t, items, mode));
}

function switchTask(root: string, t: string, items: string[], mode?: 'dispatch'): void {
  const before = readTask(root);
  // 旧任务被换掉那一刻的清单和验收记下来：网页上翻回旧任务，清单、打的勾和「验收通过」都还在
  const prevCopy = before.empty ? undefined : saveTaskCopy(root);
  let prevAccept: { state: string; headline: string; items: { text: string }[] } | undefined;
  if (!before.empty) {
    try {
      const a = acceptanceNow(root, loadLedger(root), before);
      prevAccept = { state: a.state, headline: a.headline, items: a.items.map((x) => ({ text: x.text })) };
    } catch {
      /* 算不出来就不记，网页上只是没有终点 */
    }
  }
  const doc = setTask(root, t, items);
  const snap = takeSnapshot(root, '换任务').sha;
  const taskCopy = saveTaskCopy(root);
  appendLedger(root, {
    type: 'task',
    ts: new Date().toISOString(),
    title: doc.title,
    snap,
    prev: before.empty ? '' : before.title,
    ...(taskCopy ? { taskCopy } : {}),
    ...(mode ? { mode } : {}),
    ...(prevCopy ? { prevCopy } : {}),
    ...(prevAccept ? { prevAccept } : {}),
  });
  refreshBrief(root);
}

// ---- 删除正在做的任务 ----

/** 拿调度锁；全自动正在跑（锁在它手里）就说清楚要先停。 */
function withIdleLock<T>(root: string, fn: () => T): T {
  try {
    return withLock(root, fn);
  } catch (e) {
    if (e instanceof RelayError && e.code === 'busy') throw new RelayError('全自动还在跑，先停止再删', 'task-busy');
    throw e;
  }
}

/**
 * 删除正在做的任务：任务清单清空（回到还没写任务的样子），账本记一笔换任务（deleted 记下删掉的那份清单），
 * 左边不再列出这一段。每一棒的记录、交接、快照都不动。全自动在跑时删不了（网页上删会先叫停它）；
 * 有一棒还没交接（你在工具里开着）也能删，那一棒算在删掉的这一段里。
 * 返回这一笔的时间，撤销时用。
 */
export function deleteTask(root: string): string {
  if (!loadLedger(root).init) throw new RelayError('这个文件夹还没接入接力台。', 'not-init');
  return withIdleLock(root, () => {
    const v = loadLedger(root);
    const before = readTask(root);
    const changes = taskChanges(v.events);
    const key = changes.at(-1)?.ts ?? v.init!.ts;
    if (before.empty) {
      // 没写任务，这一段却有棒（旧版把没有任务时文件夹里的改动也记成一棒）：另起一段，把这一段藏起来。
      const lo = changes.length ? Date.parse(key) : -Infinity;
      if (!v.stints.some((s) => Date.parse(s.startedAt) >= lo)) throw new RelayError('还没有任务。', 'no-task');
      const ts = new Date().toISOString();
      const taskCopy = saveTaskCopy(root);
      appendLedger(root, { type: 'task', ts, title: '', snap: takeSnapshot(root, '删除对话').sha, prev: '', blank: true, ...(taskCopy ? { taskCopy } : {}) });
      setThreadHidden(root, key, true);
      refreshBrief(root);
      return ts;
    }
    const deleted = saveTaskCopy(root);
    if (!deleted) throw new RelayError('任务清单存不下来，没有删。', 'no-copy');
    writeProjectFile(path.join(root, TASK_REL), taskTemplate(), root);
    const ts = new Date().toISOString();
    const taskCopy = saveTaskCopy(root);
    appendLedger(root, { type: 'task', ts, title: '', snap: takeSnapshot(root, '删除任务').sha, prev: before.title, deleted, ...(taskCopy ? { taskCopy } : {}) });
    setThreadHidden(root, key, true);
    refreshBrief(root);
    return ts;
  });
}

/** 撤销删除任务：删掉以后还没写新任务，就把原来的清单写回去，那一段接着是正在做的任务（那一删一撤两笔都不算）。 */
export function restoreTask(root: string, id: string): void {
  withIdleLock(root, () => {
    const v = loadLedger(root);
    const del = taskChanges(v.events).at(-1);
    if (!(del?.deleted || del?.blank) || del.ts !== id || !readTask(root).empty) throw new RelayError('删了之后已经写了新任务，撤销不了。', 'task-moved');
    const raw = del.deleted ? readTaskCopy(root, del.deleted) : readTask(root).raw;
    if (raw === null) throw new RelayError('删掉的任务清单找不到了。', 'no-copy');
    if (del.deleted) writeProjectFile(path.join(root, TASK_REL), raw, root);
    const taskCopy = saveTaskCopy(root);
    appendLedger(root, { type: 'task', ts: new Date().toISOString(), title: parseTask(raw).title, snap: takeSnapshot(root, '撤销删除任务').sha, undo: id, ...(taskCopy ? { taskCopy } : {}) });
    setThreadHidden(root, taskChanges(loadLedger(root).events).at(-1)?.ts ?? v.init!.ts, false);
    refreshBrief(root);
  });
}
