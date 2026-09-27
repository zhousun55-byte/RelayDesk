import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultRelayConfig, relayConfigPath } from '../core/config';
import { RelayError } from '../core/errors';
import { appendLedger, loadLedger } from '../core/ledger';
import { HANDOFF_DIR, REVIEW_DIR, TASK_REL, readTask, saveTaskCopy, taskTemplate, setTask } from '../core/notes';
import { loadMemory, rememberProject } from '../core/memory';
import { relayHome } from '../core/paths';
import { installProtocol, protocolState } from '../core/protocol';
import { ensureSnapRepo, takeSnapshot } from '../core/snap';
import { markBase, refreshBrief } from './track';

/**
 * 接入：让一个文件夹开始接力。可以重复执行（缺什么补什么）。
 * 不需要 git；不碰你自己的 git（快照在 .relay/snapshots，.relay 里自带 .gitignore）。
 */

const RELAY_GITIGNORE = [
  '# 接力台自己的数据，不进你的 git（任务、交接、复核、账本想提交就提交）',
  'snapshots/',
  'runs/',
  '接力本.md',
  '复核/*.diff',
  'talk*.jsonl',
  '*.tmp',
  '*.lock',
  '',
].join('\n');

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
  const bad = new Set(['/', home, path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads'), '/Users', '/Applications', '/System', '/usr', '/etc', '/private', '/tmp', '/var']);
  if (bad.has(root)) throw new RelayError(`「${root}」太大了，不像是一个项目。选具体的项目文件夹。`, 'bad-root');
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
  if (!fs.existsSync(gi)) {
    fs.writeFileSync(gi, RELAY_GITIGNORE);
  }
  for (const d of [HANDOFF_DIR, REVIEW_DIR]) fs.mkdirSync(path.join(root, d), { recursive: true });
  if (!fs.existsSync(relayConfigPath(root))) {
    fs.writeFileSync(relayConfigPath(root), JSON.stringify(defaultRelayConfig(), null, 2) + '\n');
  }
  if (!fs.existsSync(path.join(root, TASK_REL))) {
    if (opts.task?.trim()) setTask(root, opts.task);
    else fs.writeFileSync(path.join(root, TASK_REL), taskTemplate());
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

/** 从当前文件夹往上找接入过的项目（像 git 找 .git 一样）；找不到就是当前文件夹。 */
export function findRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.relay', 'journal.jsonl'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(start);
    dir = up;
  }
}

// ---- 接入过的文件夹（盯文件夹用） ----

/** 最近打开过、而且接入过的文件夹。 */
export function liveProjects(): string[] {
  const m = loadMemory();
  const list = [...new Set([...(m.root ? [m.root] : []), ...(m.recents ?? [])])];
  return list.filter((r) => fs.existsSync(path.join(r, '.relay', 'journal.jsonl')));
}

// ---- 换任务 ----

/** 写下新任务（旧的存档），记一笔，从这张快照开始算这件事。 */
/** 写下新任务（旧的存档）。mode = dispatch：在派活页写的，全自动用派活。 */
export function newTask(root: string, text: string, items: string[] = [], mode?: 'dispatch'): void {
  const t = text.trim();
  if (!t) throw new RelayError('任务是空的', 'no-task');
  const v = loadLedger(root);
  if (!v.init) throw new RelayError('这个文件夹还没接入接力台。', 'not-init');
  const before = readTask(root);
  const doc = setTask(root, t, items);
  const snap = takeSnapshot(root, '换任务').sha;
  const taskCopy = saveTaskCopy(root);
  appendLedger(root, { type: 'task', ts: new Date().toISOString(), title: doc.title, snap, prev: before.empty ? '' : before.title, ...(taskCopy ? { taskCopy } : {}), ...(mode ? { mode } : {}) });
  refreshBrief(root);
}
