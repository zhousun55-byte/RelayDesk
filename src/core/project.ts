import fs from 'node:fs';
import path from 'node:path';
import { defaultRelayConfig, relayConfigPath } from './config';
import { RelayError } from './errors';
import { currentBranch, git, headSha, relayCommit, repoRootOf } from './git';
import { statusEntries } from './status';

/** 放在项目里、但不进主线的接力文件（讨论记录等）。 */
export const SIDE_IGNORES = ['.relay/talk.jsonl', '.relay/talk.md', '.relay/talk-*.jsonl', '.relay/title.txt', '.relay/attach/'];
const GITIGNORE_MARKER = '# relay-side';
const GITIGNORE_EXTRA = ['.DS_Store'];

/** 保证 .gitignore 里有接力台的那几行。缺哪行补哪行，重复调用不会重复写。返回是否改了文件。 */
export function ensureRelayGitignore(root: string): boolean {
  const p = path.join(root, '.gitignore');
  const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const want = [...SIDE_IGNORES, ...GITIGNORE_EXTRA].filter((l) => !have.has(l));
  if (want.length === 0 && have.has(GITIGNORE_MARKER)) return false;
  const lines = have.has(GITIGNORE_MARKER) ? want : [GITIGNORE_MARKER, ...want];
  if (lines.length === 0) return false;
  const sep = cur.length === 0 ? '' : cur.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(p, `${cur}${sep}${lines.join('\n')}\n`);
  return true;
}

export interface ProjectInfo {
  /** 用户选的文件夹。 */
  dir: string;
  /** 项目根（git 仓库根；不是仓库时就是 dir）。 */
  root: string;
  name: string;
  isGit: boolean;
  hasCommits: boolean;
  hasConfig: boolean;
  branch: string | null;
}

export function inspectProject(dir: string): ProjectInfo {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new RelayError(`找不到文件夹：${abs}`, 'no-dir');
  }
  const root = repoRootOf(abs);
  if (!root) {
    return { dir: abs, root: abs, name: path.basename(abs), isGit: false, hasCommits: false, hasConfig: false, branch: null };
  }
  return {
    dir: abs,
    root,
    name: path.basename(root),
    isGit: true,
    hasCommits: headSha(root) !== null,
    hasConfig: fs.existsSync(relayConfigPath(root)),
    branch: currentBranch(root),
  };
}

const RELAY_FILES = ['.relay/config.json', '.gitignore'];

/**
 * 把接力台自己的两个文件（配置、.gitignore 里的那几行）提交进正式文件夹。
 * 只提交这两个文件，用户暂存的其他东西不动。没有要提交的返回 null。
 */
export function ensureProjectCommitted(root: string): string | null {
  const dirty = statusEntries(root)
    .map((e) => e.path)
    .filter((p) => RELAY_FILES.includes(p));
  if (dirty.length === 0) return null;
  const add = git(root, ['add', '--', ...dirty]);
  if (add.code !== 0) throw new RelayError(`接力配置没能放进 git：${add.stderr || add.stdout}`, 'git');
  const c = relayCommit(root, '接力：项目设置', ['--', ...dirty]);
  if (c.code !== 0) throw new RelayError(`接力配置没能提交：${c.stderr || c.stdout}`, 'git');
  return headSha(root);
}

/**
 * 把一个文件夹设为接力项目（可以重复执行）：
 * 没有 git 就建一个，把现有文件存为第一版；写默认配置；补 .gitignore；把接力文件提交进去。
 */
export function setupProject(dir: string): { root: string; actions: string[] } {
  const info = inspectProject(dir);
  const actions: string[] = [];
  let root = info.root;

  if (!info.isGit) {
    let init = git(info.dir, ['init', '-q', '-b', 'main']);
    if (init.code !== 0) init = git(info.dir, ['init', '-q']);
    if (init.code !== 0) throw new RelayError(`没能在这里建立 git 记录：${init.stderr || init.stdout}`, 'git');
    root = repoRootOf(info.dir) ?? info.dir;
    actions.push('建立了 git 记录');
  }

  if (!fs.existsSync(relayConfigPath(root))) {
    fs.mkdirSync(path.dirname(relayConfigPath(root)), { recursive: true });
    fs.writeFileSync(relayConfigPath(root), JSON.stringify(defaultRelayConfig(), null, 2) + '\n');
    actions.push('写了默认配置 .relay/config.json');
  }
  if (ensureRelayGitignore(root)) actions.push('在 .gitignore 里加了接力台的几行');

  if (headSha(root) === null) {
    const add = git(root, ['add', '-A']);
    if (add.code !== 0) throw new RelayError(`没能记录现有文件：${add.stderr || add.stdout}`, 'git');
    const c = relayCommit(root, '接力：建立项目（现有文件存为第一版）', ['--allow-empty']);
    if (c.code !== 0) throw new RelayError(`第一版没能存下：${c.stderr || c.stdout}`, 'git');
    actions.push('把现有文件存为第一版');
  } else if (ensureProjectCommitted(root)) {
    actions.push('提交了接力配置');
  }
  return { root, actions };
}
