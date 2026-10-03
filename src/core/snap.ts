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
  // 测试、检查工具自己写的缓存和报告（检查命令一跑就变，不是谁写的代码）。
  '.pytest_cache/',
  '.mypy_cache/',
  '.ruff_cache/',
  '.hypothesis/',
  '.tox/',
  '.nox/',
  '.nyc_output/',
  'htmlcov/',
  '.coverage',
  '.eslintcache',
  '*.tsbuildinfo',
];

/** 生成出来的目录和文件（缓存、报告、依赖）：检查命令改了这些，不算谁写了代码。 */
const GENERATED_DIRS = new Set(['.pytest_cache', '.mypy_cache', '.ruff_cache', '.hypothesis', '.tox', '.nox', '.nyc_output', 'htmlcov', 'coverage', '__pycache__', 'node_modules', '.cache', '.next', '.nuxt', '.turbo', '.parcel-cache', '.gradle', '.venv', 'venv', 'DerivedData', 'Pods', '.dart_tool', '.svelte-kit', '.angular', '.vite']);
const GENERATED_FILE = /(?:^|\/)(?:\.coverage(?:\.[^/]+)?|\.eslintcache|\.stylelintcache|coverage\.xml|junit\.xml|test-results\.xml|[^/]+\.tsbuildinfo|[^/]+\.pyc|\.DS_Store)$/;

export function generatedPath(p: string): boolean {
  const parts = p.split('/');
  return parts.slice(0, -1).some((d) => GENERATED_DIRS.has(d)) || GENERATED_FILE.test(p);
}

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
  // 从 git 钩子里调用时会带着这些变量，会把快照写进用户的仓库；后几个能从外面塞进配置、属性和外部 diff。
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_ATTR_SOURCE', 'GIT_EXTERNAL_DIFF']) {
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
  '-c', 'core.attributesFile=/dev/null',
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
    if (r.error) throw new RelayError(`没能执行 git：${r.error.message}`, 'no-git');
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

/**
 * 快照仓库在项目的 .relay 里：干活的 AI、克隆来的仓库都改得到它的 config。
 * config 里的 filter、diff 驱动、别名、include 都能让 git add / checkout 去执行命令，所以每次用之前整份对一遍，
 * 只留 git 建库时自己写的这几项、而且值得是建库时会写的那几种，别的都去掉（去掉的按 git 的默认值算）。
 * 值也要管：写上 sha256（对象其实是 sha1）、换一种引用的存法，git 就认不得这个仓库，快照、退回、看改动全都用不了。
 * 接力台从来不往这份 config 里写别的。
 */
const BOOL = /^(true|false)$/i;
const SNAP_CONFIG_KEEP: Record<string, Record<string, RegExp>> = {
  core: { repositoryformatversion: /^[01]$/, filemode: BOOL, bare: /^true$/i, ignorecase: BOOL, precomposeunicode: BOOL, symlinks: BOOL, logallrefupdates: BOOL },
  extensions: { objectformat: /^sha1$/i, refstorage: /^files$/i },
};

function tidySnapConfig(dir: string): void {
  const p = path.join(dir, 'config');
  let cur: string;
  try {
    cur = fs.readFileSync(p, 'utf8');
  } catch {
    return;
  }
  const out: string[] = [];
  let keep: Record<string, RegExp> | null = null;
  for (const line of cur.split('\n')) {
    const sec = line.match(/^\s*\[\s*([A-Za-z0-9.-]+)\s*\]\s*$/);
    if (sec) {
      keep = SNAP_CONFIG_KEEP[sec[1].toLowerCase()] ?? null;
      if (keep) out.push(`[${sec[1].toLowerCase()}]`);
      continue;
    }
    if (/^\s*\[/.test(line)) {
      keep = null; // 带子段名的（[filter "x"]、[diff "y"]、[include]……）一律不要
      continue;
    }
    const kv = line.match(/^\s*([A-Za-z][A-Za-z0-9-]*)\s*=\s*([^\n]*?)\s*$/);
    const ok = kv && keep?.[kv[1].toLowerCase()];
    if (kv && ok && ok.test(kv[2])) out.push(`\t${kv[1].toLowerCase()} = ${kv[2]}`);
  }
  const next = out.join('\n') + '\n';
  if (next !== cur) fs.writeFileSync(p, next);
}

/** HEAD 只该是「ref: refs/heads/某个分支」。被写坏了：指回已有的分支，快照和历史都还在，不用重建。 */
function repairSnapHead(dir: string): void {
  const p = path.join(dir, 'HEAD');
  let head = '';
  try {
    // 被换成了同名的文件夹：git 就认不出这是仓库了。挪到一边（不删，里面的东西还在），下面写回一个正常的 HEAD
    if (fs.statSync(p).isDirectory()) fs.renameSync(p, `${p}.broken-${Date.now()}`);
    else head = fs.readFileSync(p, 'utf8').trim();
  } catch {
    return;
  }
  if (/^ref: refs\/heads\/[A-Za-z0-9._/-]+$/.test(head) || /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(head)) return;
  const heads = path.join(dir, 'refs', 'heads');
  let branches: string[] = [];
  try {
    branches = fs.readdirSync(heads).filter((b) => /^[A-Za-z0-9._-]+$/.test(b) && fs.statSync(path.join(heads, b)).isFile());
  } catch {
    /* 没有分支目录：指向 main，下一张快照会把它建出来 */
  }
  let packed = '';
  try {
    packed = fs.readFileSync(path.join(dir, 'packed-refs'), 'utf8');
  } catch {
    /* 没有打包过 */
  }
  for (const m of packed.matchAll(/ refs\/heads\/([A-Za-z0-9._-]+)$/gm)) branches.push(m[1]);
  const branch = ['main', 'master'].find((b) => branches.includes(b)) ?? branches[0] ?? 'main';
  fs.writeFileSync(p, `ref: refs/heads/${branch}\n`);
}

/** 建快照仓库（已经有了就只补排除规则，顺手把被改过的 config、HEAD 理回来）。 */
export function ensureSnapRepo(root: string): void {
  const dir = snapDir(root);
  if (!hasSnapRepo(root)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const init = (at: string) => {
      const r = spawnSync('git', ['init', '-q', '--bare', at], { encoding: 'utf8', env: cleanEnv(root) });
      if (r.status !== 0) throw new RelayError(`建快照仓库失败：${(r.stderr ?? '').trim() || r.error?.message}`, 'snap');
    };
    if (fs.existsSync(dir)) init(dir); // 残缺的（没有 HEAD）：原地补全
    else {
      // 先在旁边建好再一下子挪过去：网页开着（盯着文件夹）时在终端里接入，两个进程会同时建，
      // 对同一个文件夹 git init 会撞上（config 被锁、模板复制失败）。挪的时候别人已经建好了，就用别人的。
      const tmp = `${dir}.new-${process.pid}-${Date.now()}`;
      try {
        init(tmp);
        fs.renameSync(tmp, dir);
      } catch {
        // 挪不过去：别人先建好了就用别人的；不然（Windows 上杀毒软件可能正占着刚建的文件）照原来的办法原地建
        if (!hasSnapRepo(root)) init(dir);
      } finally {
        try {
          fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
          /* 删不掉的临时文件夹留在 .relay 里，不进快照、不进 git */
        }
      }
    }
  }
  repairSnapHead(dir);
  tidySnapConfig(dir);
  // git 仓库自己的 info/attributes 比项目里的 .gitattributes 优先：快照只存文件本身，不走任何 filter（LFS 之类）和合并驱动。
  const attrs = path.join(dir, 'info', 'attributes');
  const want = '# 接力台：快照只存文件本身，不走 filter 和合并驱动\n* -filter -merge\n';
  fs.mkdirSync(path.dirname(attrs), { recursive: true });
  if (!fs.existsSync(attrs) || fs.readFileSync(attrs, 'utf8') !== want) fs.writeFileSync(attrs, want);
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
    throw new RelayError(`这个文件夹里有 ${files.length} 个文件，不像是一个项目`, 'too-many');
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
  /** 恢复完和目标快照对不上的文件（删不掉、写不回去）；都对上是空的。 */
  left: string[];
}

/**
 * 把整个文件夹恢复成某张快照的样子：改过的改回去、删掉的找回来、后来新加的删掉。
 * onSafety：「退回前」那张存好、还没动文件时叫一次（调用方在这里记下「退回做到一半」）。
 * 做完拿「退回后」那张和目标比一遍，对不上的文件放进 left，不当作退回成功了事。
 */
export function restoreSnapshot(root: string, sha: string, message = '退回', onSafety?: (safety: string) => void): RestoreResult {
  if (!snapExists(root, sha)) throw new RelayError(`找不到这张快照：${sha.slice(0, 9)}`, 'no-snap');
  const safety = takeSnapshot(root, `${message}之前`).sha;
  onSafety?.(safety);
  const changed = snapChanges(root, sha, safety);
  // 后来新加的文件（快照里没有）删掉；删不掉的留着，最后核对时会报出来。
  const added = sgOk(root, ['diff', ...DIFF_SAFE, '-z', '--name-only', '--no-renames', '--diff-filter=A', sha, safety], '读改动', { raw: true });
  for (const f of added.split('\0').filter(Boolean)) {
    const abs = path.join(root, f);
    if (!abs.startsWith(root + path.sep) || f.startsWith('.relay/')) continue;
    try {
      fs.rmSync(abs, { force: true });
      removeEmptyDirs(root, f);
    } catch {
      /* 见上 */
    }
  }
  if (snapFiles(root, sha).length) sgOk(root, ['checkout', '-f', sha, '--', '.'], '恢复文件');
  const after = takeSnapshot(root, message).sha;
  const left = after === sha ? [] : snapChanges(root, sha, after).map((f) => f.path);
  return { safety, after, files: changed.length, left };
}

/**
 * 文件夹现在和某张快照比有没有改动（按快照的规则，生成出来的缓存、报告不算）。读不了返回 null。
 * 不存快照、不动索引（--no-optional-locks）：给验收结果对指纹——在接力台之外改了文件，旧的通过就不能再算。
 */
export function changedSince(root: string, sha: string): boolean | null {
  const head = headSnap(root);
  if (!head) return null;
  if (head !== sha) {
    const d = sg(root, ['diff', '--quiet', ...DIFF_SAFE, sha, head]);
    if (d.code === 1) return true;
    if (d.code !== 0) return null;
  }
  const st = sg(root, ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all'], { raw: true });
  if (st.code !== 0) return null;
  return st.stdout.split('\0').some((l) => l.length > 3 && !l.slice(3).startsWith('.relay/') && !generatedPath(l.slice(3)));
}

/** 改动的一句话统计：「3 个文件，+20 −4」。 */
export function changeLine(files: FileChange[]): string {
  if (!files.length) return '没有改动';
  const s = sumChanges(files);
  return `${s.files} 个文件，+${s.added} −${s.removed}`;
}
