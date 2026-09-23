import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from './errors';
import { relayHome, repoKey } from './paths';

/**
 * 进行中任务的指针（一个项目同一时间只有一件事）：~/.relay/projects/<项目键>/session.json。
 * 放在仓库外，正式文件夹的 git status 才能一直干净。
 */
export interface SessionState {
  repoRoot: string;
  /** 接力分支 relay/<slug>-<id>。 */
  branch: string;
  /** 隔离工作副本的绝对路径。 */
  worktree: string;
  taskTitle: string;
  /** 开始时正式文件夹的 HEAD。 */
  baseCommit: string;
  /** 接力分支的第一个提交（里面已经有带 start 事件的 journal）。 */
  startCommit: string;
  startedAt: string;
  /** 开始时正式文件夹所在的分支（合回的目标）。旧会话没有这个字段。 */
  mainBranch?: string;
  /**
   * 开始时正式文件夹里本来就没提交的文件（路径 → 内容哈希，删除记为 "-"）。
   * 用来区分「用户自己原有的改动」和「任务期间被 AI 误改的」。旧会话没有这个字段。
   */
  mainSnapshot?: Record<string, string>;
}

function sessionDir(repoRoot: string): string {
  return path.join(relayHome(), 'projects', repoKey(repoRoot));
}

export function sessionPath(repoRoot: string): string {
  return path.join(sessionDir(repoRoot), 'session.json');
}

export function loadSession(repoRoot: string): SessionState | null {
  const p = sessionPath(repoRoot);
  if (!fs.existsSync(p)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    throw new RelayError(`任务指针损坏：${p}。删除这个文件即可（接力分支还在，不会丢东西）。`, 'bad-session');
  }
  const s = raw as Partial<SessionState>;
  if (!s || typeof s.branch !== 'string' || typeof s.worktree !== 'string' || typeof s.baseCommit !== 'string') {
    throw new RelayError(`任务指针内容不完整：${p}。删除这个文件即可（接力分支还在，不会丢东西）。`, 'bad-session');
  }
  return { ...s, repoRoot: s.repoRoot ?? repoRoot, taskTitle: s.taskTitle ?? s.branch } as SessionState;
}

export function requireSession(repoRoot: string): SessionState {
  const s = loadSession(repoRoot);
  if (!s) throw new RelayError('现在没有进行中的任务。先开始一个任务（relay start "要做什么"）。', 'no-task');
  return s;
}

export function saveSession(s: SessionState): void {
  fs.mkdirSync(sessionDir(s.repoRoot), { recursive: true });
  fs.writeFileSync(sessionPath(s.repoRoot), JSON.stringify(s, null, 2) + '\n');
}

export function clearSession(repoRoot: string): void {
  const p = sessionPath(repoRoot);
  if (fs.existsSync(p)) fs.rmSync(p);
}

/** 所有进行中任务的项目根目录（接力台「项目」列表用）。坏指针跳过。 */
export function listSessionRoots(): string[] {
  const dir = path.join(relayHome(), 'projects');
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name, 'session.json');
    if (!fs.existsSync(p)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(p, 'utf8')) as { repoRoot?: string };
      if (typeof s.repoRoot === 'string') out.push(s.repoRoot);
    } catch {
      /* 坏指针不影响别的项目 */
    }
  }
  return out;
}
