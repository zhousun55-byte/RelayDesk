import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 活跃会话指针（单任务约束）：存在 ~/.relay/projects/<repoKey>/session.json。
 * 放在仓库外，保证主线的 git status 永远干净（第 2 步验收标准）。
 */
export interface SessionState {
  repoRoot: string;
  branch: string;
  worktree: string;
  taskTitle: string;
  /** 主线基准：start 时的主线 HEAD，merge 时用于 diff 与防漂移检查。 */
  baseCommit: string;
  /** relay 分支首提交 SHA（该提交的树里含带 start 事件的 journal）。start 事件里存的 commit 是主线基准。 */
  startCommit: string;
  startedAt: string;
}

export function relayHome(): string {
  return path.join(os.homedir(), '.relay');
}

export function repoKey(repoRoot: string): string {
  const h = crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 8);
  const name = path.basename(repoRoot).replace(/[^a-zA-Z0-9._-]/g, '_') || 'repo';
  return `${name}-${h}`;
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
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as SessionState;
  } catch {
    throw new Error(`会话指针损坏：${p}，请手工修复或删除。`);
  }
}

export function requireSession(repoRoot: string): SessionState {
  const s = loadSession(repoRoot);
  if (!s) {
    throw new Error('无活跃任务。用 relay start "任务描述" 开始（单仓库同一时间只有一个任务）。');
  }
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
