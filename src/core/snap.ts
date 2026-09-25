import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from './errors';
import { parseNameStatusZ, parseNumstatZ, sumChanges, type FileChange } from './status';

/**
 * 快照：整个项目文件夹的存档，存在项目里的 .relay/snapshots（接力台自己的 git 仓库）。
 * 不碰用户自己的 git：不提交、不改索引、不切分支；用户的 .gitignore 照样生效。
 * 每一棒前后各存一张；退回就是把文件恢复成某一张的样子（先存一张「退回前」，退回本身也能撤销）。
 */

export const SNAP_REL = '.relay/snapshots';

/** 除了项目自己的 .gitignore，快照还一律不收的东西（体积大、能重新生成）。 */
const DEFAULT_EXCLUDES = [
  '/.relay/',
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.DS_Store',
  '.next/',
  '.nuxt/',
  '.turbo/',
  '.parcel-cache/',
  '.cache/',
  'coverage/',
  'Pods/',
  'DerivedData/',
  '.gradle/',
  '*.pyc',
];

const BIG_MARK = '# 接力台：太大的文件，不进快照';
/** 超过这个大小的新文件不进快照（多半是数据、安装包、视频）。 */
const BIG_FILE = 20 * 1024 * 1024;
/** 第一次存快照时文件太多，多半是选错了文件夹（比如整个家目录）。 */
const TOO_MANY = 150_000;

export function snapDir(root: string): string {
  return path.join(root, SNAP_REL);
}

/** 给 AI 看的命令前缀（在项目根目录执行）。 */
export function snapGit(): string {
  return `git --git-dir=${SNAP_REL} --work-tree=.`;
}

interface SgResult {
  code: number;
  stdout: string;
  stderr: string;
}

function cleanEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' };
  // 从 git 钩子里调用时会带着这些变量，会把快照写进用户的仓库。
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_NAMESPACE']) {
    delete env[k];
  }
  env.GIT_INDEX_FILE = path.join(snapDir(root), 'index');
  return env;
}

const BASE = [
  '-c', 'core.quotepath=off',
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'commit.gpgsign=false',
  '-c', 'user.name=接力台',
  '-c', 'user.email=relay@local',
];

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 在快照仓库里跑 git。别的进程正拿着索引锁时，等一下再试。 */
function sg(root: string, args: string[], opts: { raw?: boolean; input?: string } = {}): SgResult {
  for (let attempt = 0; ; attempt++) {
    const r = spawnSync('git', [...BASE, `--git-dir=${snapDir(root)}`, `--work-tree=${root}`, ...args], {
      cwd: root,
      encoding: 'utf8',
      input: opts.input,
      maxBuffer: 256 * 1024 * 1024,
      env: cleanEnv(root),
    });
    if (r.error) throw new RelayError(`无法执行 git：${r.error.message}。请先安装 git。`, 'no-git');
    const res = { code: r.status ?? -1, stdout: opts.raw ? r.stdout ?? '' : (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
    if (res.code !== 0 && /index\.lock|Unable to create .*\.lock/.test(res.stderr) && attempt < 20) {
      sleepMs(150);
      continue;
    }
    return res;
  }
}

function sgOk(root: string, args: string[], what: string, opts: { raw?: boolean } = {}): string {
  const r = sg(root, args, opts);
  if (r.code !== 0) throw new RelayError(`${what}失败：${r.stderr || r.stdout}`, 'snap');
  return r.stdout;
}

export function hasSnapRepo(root: string): boolean {
  return fs.existsSync(path.join(snapDir(root), 'HEAD'));
}

/** 建快照仓库（已经有了就只补排除规则）。 */
export function ensureSnapRepo(root: string): void {
  const dir = snapDir(root);
  if (!hasSnapRepo(root)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const r = spawnSync('git', ['init', '-q', '--bare', dir], { encoding: 'utf8', env: cleanEnv(root) });
    if (r.status !== 0) throw new RelayError(`建快照仓库失败：${(r.stderr ?? '').trim() || r.error?.message}`, 'snap');
  }
  const ex = path.join(dir, 'info', 'exclude');
  fs.mkdirSync(path.dirname(ex), { recursive: true });
  const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
  const have = new Set(cur.split('\n').map((l) => l.trim()));
  const missing = DEFAULT_EXCLUDES.filter((l) => !have.has(l));
  if (missing.length) fs.writeFileSync(ex, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}

/** 最新一张快照；还没有返回 null。 */
export function headSnap(root: string): string | null {
  if (!hasSnapRepo(root)) return null;
  const r = sg(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  return r.code === 0 && r.stdout ? r.stdout : null;
}

export function snapExists(root: string, sha: string): boolean {
  return /^[0-9a-f]{4,64}$/i.test(sha) && sg(root, ['cat-file', '-e', `${sha}^{commit}`]).code === 0;
}

/** 新出现的大文件记进排除规则（只看还没进快照的文件）。 */
function excludeBigFiles(root: string): void {
  const r = sg(root, ['ls-files', '-z', '--others', '--exclude-standard'], { raw: true });
  if (r.code !== 0) return;
  const files = r.stdout.split('\0').filter(Boolean);
  if (files.length > TOO_MANY && !headSnap(root)) {
    throw new RelayError(`这个文件夹里有 ${files.length} 个文件，不像是一个项目（是不是选成了整个家目录？）。换一个项目文件夹再接入。`, 'too-many');
  }
  const big: string[] = [];
  for (const f of files) {
    try {
      if (fs.statSync(path.join(root, f)).size > BIG_FILE) big.push(f);
    } catch {
      /* 刚被删掉 */
    }
  }
  if (!big.length) return;
  const ex = path.join(snapDir(root), 'info', 'exclude');
  const cur = fs.readFileSync(ex, 'utf8');
  const lines = big.map((f) => `/${f.replace(/([*?[\\!#])/g, '\\$1')}`);
  fs.writeFileSync(ex, `${cur}${cur.includes(BIG_MARK) ? '' : `${BIG_MARK}\n`}${lines.join('\n')}\n`);
}

export interface SnapResult {
  sha: string;
  /** false = 和上一张一模一样，没有新存。 */
  changed: boolean;
}

/** 存一张快照。和上一张一样就不新存，返回上一张。 */
export function takeSnapshot(root: string, message: string): SnapResult {
  ensureSnapRepo(root);
  excludeBigFiles(root);
  const add = sg(root, ['add', '-A', '--ignore-errors', '--', '.']);
  if (add.code !== 0 && !/warning|error: open\(/i.test(add.stderr)) throw new RelayError(`存快照失败：${add.stderr || add.stdout}`, 'snap');
  const head = headSnap(root);
  if (head && sg(root, ['diff', '--cached', '--quiet', 'HEAD']).code === 0) return { sha: head, changed: false };
  sgOk(root, ['commit', '-q', '--no-verify', '--allow-empty', '-m', message], '存快照');
  return { sha: sgOk(root, ['rev-parse', 'HEAD'], '读快照'), changed: true };
}

/** 看改动时一律不跑快照仓库配置里的外部 diff 和转换程序（那些配置可能被改过）。 */
const DIFF_SAFE = ['--no-ext-diff', '--no-textconv'];

/**
 * 两张快照之间改了哪些文件。git 出错（快照找不到、仓库坏了）就报错——
 * 不能返回空列表，那会被当成「这一棒没改文件」，弱模型的活就不用复核了。
 */
export function snapChanges(root: string, from: string, to: string): FileChange[] {
  if (from === to) return [];
  const ns = sgOk(root, ['diff', ...DIFF_SAFE, '-z', '--name-status', '--find-renames', from, to], '读改动', { raw: true });
  const num = sg(root, ['diff', ...DIFF_SAFE, '-z', '--numstat', '--find-renames', from, to], { raw: true });
  const stats = num.code === 0 ? parseNumstatZ(num.stdout) : new Map();
  return parseNameStatusZ(ns).map((f) => ({
    path: f.path,
    status: f.status,
    ...(f.orig ? { orig: f.orig } : {}),
    added: stats.get(f.path)?.added ?? null,
    removed: stats.get(f.path)?.removed ?? null,
  }));
}

export { sumChanges };

/** 两张快照之间的完整改动（统一 diff 格式）。file 给了就只看这一个文件。git 出错就报错（不能当成没改动）。 */
export function snapDiff(root: string, from: string, to: string, file?: string): string {
  if (from === to) return '';
  return sgOk(root, ['diff', ...DIFF_SAFE, '--find-renames', from, to, ...(file ? ['--', file] : [])], '读改动', { raw: true });
}

/** 某张快照里有没有这个文件。快照本身找不到、仓库出错就报错（不能当成「没有这个文件」）。 */
export function snapHas(root: string, sha: string, file: string): boolean {
  const rel = file.replace(/^\.\//, '');
  const out = sgOk(root, ['ls-tree', '-z', '--name-only', sha, '--', rel], '读快照', { raw: true });
  return out.split('\0').includes(rel);
}

/** 某张快照里的一个文件；快照里没有它返回 null；读不了（快照找不到、仓库出错）报错。 */
export function snapFile(root: string, sha: string, file: string): string | null {
  if (!snapHas(root, sha, file)) return null;
  return sgOk(root, ['show', `${sha}:${file.replace(/^\.\//, '')}`], '读快照里的文件', { raw: true });
}

/** 文件夹里现在的文件（按快照的规则：.gitignore 和默认排除的都不算）；还没建快照仓库返回 null。 */
export function workFiles(root: string): string[] | null {
  if (!hasSnapRepo(root)) return null;
  const r = sg(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { raw: true });
  if (r.code !== 0) return null;
  // 索引里还留着上一张快照之后删掉的文件。
  return [...new Set(r.stdout.split('\0').filter(Boolean))].filter((f) => fs.existsSync(path.join(root, f)));
}

/** 快照里的文件列表。读不了就报错（退回时不能因为读不到就当成空快照、什么都不恢复）。 */
export function snapFiles(root: string, sha: string): string[] {
  return sgOk(root, ['ls-tree', '-r', '-z', '--name-only', sha], '读快照', { raw: true }).split('\0').filter(Boolean);
}

function removeEmptyDirs(root: string, rel: string): void {
  let dir = path.dirname(path.join(root, rel));
  while (dir.startsWith(root + path.sep)) {
    try {
      if (fs.readdirSync(dir).length) return;
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

export interface RestoreResult {
  /** 退回前存的那一张（想撤销退回就退回到它）。 */
  safety: string;
  /** 退回后的那一张。 */
  after: string;
  files: number;
}

/** 把整个文件夹恢复成某张快照的样子：改过的改回去、删掉的找回来、后来新加的删掉。 */
export function restoreSnapshot(root: string, sha: string, message = '退回'): RestoreResult {
  if (!snapExists(root, sha)) throw new RelayError(`找不到这张快照：${sha.slice(0, 9)}`, 'no-snap');
  const safety = takeSnapshot(root, `${message}之前`).sha;
  const changed = snapChanges(root, sha, safety);
  // 后来新加的文件（快照里没有）删掉。
  const added = sgOk(root, ['diff', ...DIFF_SAFE, '-z', '--name-only', '--no-renames', '--diff-filter=A', sha, safety], '读改动', { raw: true });
  for (const f of added.split('\0').filter(Boolean)) {
    const abs = path.join(root, f);
    if (!abs.startsWith(root + path.sep) || f.startsWith('.relay/')) continue;
    try {
      fs.rmSync(abs, { force: true });
      removeEmptyDirs(root, f);
    } catch {
      /* 删不掉的留着，下一张快照会记下来 */
    }
  }
  if (snapFiles(root, sha).length) sgOk(root, ['checkout', '-f', sha, '--', '.'], '恢复文件');
  const after = takeSnapshot(root, message).sha;
  return { safety, after, files: changed.length };
}

/** 只把一个文件恢复成某张快照里的样子（那张快照里没有它就删掉）。 */
export function restoreFile(root: string, sha: string, file: string): void {
  const rel = file.replace(/^\.\//, '');
  const abs = path.join(root, rel);
  if (!abs.startsWith(root + path.sep) || rel.startsWith('.relay/')) throw new RelayError(`不能恢复这个路径：${file}`, 'bad-path');
  if (snapFile(root, sha, rel) === null) {
    fs.rmSync(abs, { force: true });
    removeEmptyDirs(root, rel);
    return;
  }
  sgOk(root, ['checkout', '-f', sha, '--', rel], '恢复文件');
}

export interface SnapInfo {
  sha: string;
  ts: string;
  message: string;
}

/** 最近的快照（新的在前）。 */
export function listSnaps(root: string, limit = 50): SnapInfo[] {
  if (!headSnap(root)) return [];
  const r = sg(root, ['log', `-${limit}`, '--format=%H%x1f%cI%x1f%s']);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, ts, message] = l.split('\x1f');
      return { sha, ts, message };
    });
}

/** 改动的一句话统计：「3 个文件，+20 −4」。 */
export function changeLine(files: FileChange[]): string {
  if (!files.length) return '没有改动';
  const s = sumChanges(files);
  return `${s.files} 个文件，+${s.added} −${s.removed}`;
}
