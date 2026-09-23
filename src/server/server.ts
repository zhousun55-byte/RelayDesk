import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { doctor } from '../commands/doctor';
import { loadAutoSettings, saveAutoSettings } from '../core/auto-settings';
import { detectAll, enableProvider, listMembers, loadDetected, resolveTeam, syncRegistry } from '../core/detect';
import { apiUsable, keyWhere } from '../core/llm';
import { talkContext } from '../commands/talk';
import { saveRelayConfig } from '../core/config';
import { RelayError, errorMessage } from '../core/errors';
import { mergeBase } from '../core/git';
import { checkCommand, chooseFolder, copyToClipboard, reveal } from '../core/launch';
import { forgetProject, lastProject, loadMemory, rememberProject } from '../core/memory';
import { isInside } from '../core/paths';
import { PRESETS } from '../core/presets';
import { inspectProject, setupProject } from '../core/project';
import { ONBOARD_HINT } from '../core/prompts';
import { agentKind, agentLabel, canTalk, loadRegistry, removeAgent, upsertAgent } from '../core/registry';
import { listSessionRoots, loadSession } from '../core/session';
import { fileDiff } from '../core/status';
import { archiveTalk, readTalk, say, talkStatus } from '../core/talk';
import type { AgentConfig } from '../core/types';
import { abandon } from '../ops/abandon';
import { autoActive, autoLogTail, loadAutoState, startAuto, stopAuto } from '../ops/auto';
import { openTask } from '../ops/context';
import { handoff } from '../ops/handoff';
import { merge } from '../ops/merge';
import { rollback } from '../ops/rollback';
import { startTask } from '../ops/start';
import { abortSync, syncMain } from '../ops/sync';
import { takeStray } from '../ops/take';
import { loadProjectView } from '../ops/view';
import { launchInTerminal, openApp } from '../ops/work';

const WEB = path.join(__dirname, '..', 'web');
const VERSION = (() => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '?';
  }
})();

// ---- 同一个项目同一时间只做一件事 ----

const busy = new Map<string, { op: string; since: string }>();

async function exclusive<T>(root: string, op: string, fn: () => Promise<T> | T): Promise<T> {
  const key = path.resolve(root);
  const cur = busy.get(key);
  if (cur) throw new RelayError(`正在${cur.op}，请等它做完。`, 'busy');
  if (autoActive(root)) throw new RelayError('全自动正在跑。先「停止」它，再手动操作。', 'auto-running');
  busy.set(key, { op, since: new Date().toISOString() });
  try {
    return await fn();
  } finally {
    busy.delete(key);
  }
}

// ---- 自动识别：接力台一启动就在后台识别一次（没识别过、或者上次是 12 小时以前） ----

let detecting: Promise<unknown> | null = null;

function ensureDetected(force = false): void {
  if (detecting || process.env.RELAY_AUTODETECT === 'off') return;
  const last = loadDetected();
  if (!force && last && Date.now() - new Date(last.at).getTime() < 12 * 3600_000) return;
  detecting = detectAll({ network: true })
    .then((r) => {
      syncRegistry(r);
      checkCache.clear();
    })
    .catch(() => undefined)
    .finally(() => {
      detecting = null;
    });
}

// ---- 工人命令检查比较慢（要起进程），缓存一分钟 ----

const checkCache = new Map<string, { at: number; ok: boolean; problem?: string }>();

function cachedCheck(cmd: string): { ok: boolean; problem?: string } {
  const hit = checkCache.get(cmd);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  const r = checkCommand(cmd);
  const v = { at: Date.now(), ok: r.ok, ...(r.problem ? { problem: r.problem } : {}) };
  checkCache.set(cmd, v);
  return v;
}

function workerViews() {
  const members = new Map(listMembers(loadAutoSettings().level).map((m) => [m.name, m]));
  return loadRegistry().agents.map((a: AgentConfig) => {
    const kind = agentKind(a);
    let check: { ok: boolean; problem?: string };
    if (kind === 'api') {
      check = a.api && apiUsable(a.api) ? { ok: true } : { ok: false, problem: `没有密钥（${a.api ? keyWhere(a.api) : '没配接口'}）` };
    } else {
      check = cachedCheck(a.cmd ?? '');
    }
    const m = members.get(a.name);
    const auto = m ? { work: m.canWork, review: m.canReview, model: m.model ?? null, why: m.why ?? null } : null;
    return { ...a, kind, label: agentLabel(a), canTalk: canTalk(a), check, auto };
  });
}

function autoView(root: string) {
  const state = loadAutoState(root);
  return state ? { state, tail: autoLogTail(state, 80) } : null;
}

function teamView() {
  const settings = loadAutoSettings();
  const report = loadDetected();
  const members = listMembers(settings.level, report);
  const team = resolveTeam(members, settings);
  const brief = (l: typeof members) => l.map((m) => ({ name: m.name, label: m.label, model: m.model ?? null }));
  return {
    settings,
    detectedAt: report?.at ?? null,
    workers: brief(team.workers),
    reviewers: brief(team.reviewers),
    problems: team.problems,
    members: members.map((m) => ({ name: m.name, label: m.label, model: m.model ?? null, kind: m.kind, work: m.canWork, review: m.canReview, why: m.why ?? null })),
  };
}

function projectList(current: string | null) {
  const roots = [...(current ? [current] : []), ...(loadMemory().recents ?? []), ...listSessionRoots()];
  const seen = new Set<string>();
  const out: { root: string; name: string; hasTask: boolean; current: boolean }[] = [];
  for (const r of roots) {
    const abs = path.resolve(r);
    if (seen.has(abs) || !fs.existsSync(abs)) continue;
    seen.add(abs);
    let hasTask = false;
    try {
      hasTask = !!loadSession(abs);
    } catch {
      hasTask = false;
    }
    out.push({ root: abs, name: path.basename(abs), hasTask, current: abs === current });
    if (out.length >= 15) break;
  }
  return out;
}

// ---- 请求工具 ----

function send(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, max = 1_000_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > max) {
        reject(new RelayError('请求太大。', 'too-large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const v = JSON.parse(raw) as unknown;
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
      } catch {
        reject(new RelayError('请求内容不是 JSON。', 'bad-json'));
      }
    });
    req.on('error', reject);
  });
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** 防 DNS 重绑定和跨站请求：只认本机地址 + 本端口；POST 必须是 JSON。 */
function trusted(req: http.IncomingMessage): boolean {
  const port = req.socket.localPort;
  const okHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!okHosts.has(String(req.headers.host ?? ''))) return false;
  const origin = req.headers.origin;
  if (origin && !okHosts.has(origin.replace(/^http:\/\//, ''))) return false;
  if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').includes('application/json')) return false;
  return true;
}

function resolveDir(raw: string | undefined, fallback: string): string {
  const dir = path.resolve(raw && raw.trim() ? raw : fallback);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new RelayError(`找不到文件夹：${dir}`, 'no-dir');
  return dir;
}

function sideBase(dir: string, side: string | undefined): string {
  const info = inspectProject(dir);
  if (side === 'task') {
    const s = info.isGit ? loadSession(info.root) : null;
    if (!s || !fs.existsSync(s.worktree)) throw new RelayError('现在没有隔离副本。', 'no-worktree');
    return s.worktree;
  }
  return info.root;
}

function insideBase(base: string, rel: string): string {
  const target = path.resolve(base, rel || '.');
  if (!isInside(base, target)) throw new RelayError('不能看这个位置。', 'outside');
  return target;
}

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

// ---- 路由 ----

type Handler = (q: URLSearchParams, body: Record<string, unknown>, res: http.ServerResponse) => Promise<unknown> | unknown;

/**
 * onQuit：网页上点「关闭接力台」时调用（由启动网页的 relay ui 负责退出进程）；不给就不能从网页关闭。
 */
export function createServer(opts: { defaultDir: string; autoDetect?: boolean; onQuit?: () => void }): http.Server {
  if (opts.autoDetect) ensureDetected();
  const fallbackDir = () => lastProject() ?? opts.defaultDir;
  const dirOf = (q: URLSearchParams, body: Record<string, unknown>) => resolveDir(str(body.dir) ?? q.get('dir') ?? q.get('root') ?? undefined, fallbackDir());
  const rootOf = (q: URLSearchParams, body: Record<string, unknown>) => inspectProject(dirOf(q, body)).root;

  const get: Record<string, Handler> = {
    '/api/ping': () => ({ app: 'relay', version: VERSION }),
    '/api/state': (q) => {
      const dir = dirOf(q, {});
      const project = loadProjectView(dir);
      if (project.isGit) rememberProject(project.root);
      const key = path.resolve(project.root);
      const t = talkStatus(project.root);
      return {
        version: VERSION,
        home: os.homedir(),
        project,
        workers: workerViews(),
        projects: projectList(project.root),
        busy: busy.get(key) ?? null,
        talk: { count: readTalk(project.root).length, current: t.current, queue: t.queue },
        auto: project.isGit ? autoView(project.root) : null,
        team: teamView(),
        detecting: !!detecting,
      };
    },
    '/api/auto': (q) => {
      const root = rootOf(q, {});
      return { auto: autoView(root), team: teamView() };
    },
    '/api/detect': () => ({ report: loadDetected(), team: teamView() }),
    '/api/talk': (q) => {
      const root = rootOf(q, {});
      return { rows: readTalk(root, 300), status: talkStatus(root) };
    },
    '/api/presets': () => ({ presets: PRESETS }),
    '/api/doctor': (q) => ({ lines: doctor(dirOf(q, {})) }),
    '/api/files': (q) => {
      const base = sideBase(dirOf(q, {}), q.get('side') ?? 'main');
      const target = insideBase(base, q.get('sub') ?? '');
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new RelayError('这不是文件夹。', 'not-dir');
      const entries = fs
        .readdirSync(target, { withFileTypes: true })
        .filter((d) => d.name !== '.git' && d.name !== '.DS_Store')
        .map((d) => ({ name: d.name, dir: d.isDirectory() }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh') : a.dir ? -1 : 1))
        .slice(0, 500);
      return { base, sub: path.relative(base, target), entries };
    },
    '/api/file': (q) => {
      const base = sideBase(dirOf(q, {}), q.get('side') ?? 'main');
      const abs = insideBase(base, q.get('path') ?? '');
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new RelayError('找不到这个文件。', 'no-file');
      const size = fs.statSync(abs).size;
      const ext = path.extname(abs).toLowerCase();
      if (IMAGE_TYPES[ext]) return { path: path.relative(base, abs), size, image: true };
      const fd = fs.openSync(abs, 'r');
      const buf = Buffer.alloc(Math.min(size, 256 * 1024));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      if (buf.subarray(0, 8000).includes(0)) return { path: path.relative(base, abs), size, binary: true };
      return { path: path.relative(base, abs), size, text: buf.toString('utf8'), truncated: size > buf.length };
    },
    '/api/diff': (q) => {
      const ctx = openTask(dirOf(q, {}));
      const mb = mergeBase(ctx.wt, ctx.session.mainBranch ?? 'HEAD', 'HEAD') ?? ctx.session.baseCommit;
      const file = q.get('path') ?? '';
      if (!file) throw new RelayError('要看哪个文件？', 'no-file');
      const committed = fileDiff(ctx.wt, mb, 'HEAD', file);
      const working = fileDiff(ctx.wt, 'HEAD', null, file);
      return { path: file, diff: committed + (working ? `${committed ? '\n' : ''}# ↓ 还没交接的改动\n${working}` : '') };
    },
    '/api/audit': (q) => {
      const ctx = openTask(dirOf(q, {}));
      const rel = q.get('path') ?? '';
      const abs = insideBase(path.join(ctx.wt, '.relay', 'audits'), path.relative('.relay/audits', rel));
      if (!fs.existsSync(abs)) throw new RelayError('找不到这份审计报告。', 'no-file');
      return { path: rel, text: fs.readFileSync(abs, 'utf8') };
    },
  };

  const post: Record<string, Handler> = {
    '/api/detect': async (_q, b) => {
      if (detecting) await detecting;
      const report = await detectAll({ network: b.offline !== true });
      const changes = syncRegistry(report);
      checkCache.clear();
      return { report, changes, team: teamView() };
    },
    '/api/detect/use': (_q, b) => {
      const report = loadDetected();
      if (!report) throw new RelayError('先识别一次。', 'no-detect');
      const agent = enableProvider(report, str(b.id) ?? '');
      return { agent, team: teamView() };
    },
    '/api/auto/settings': (_q, b) => ({ settings: saveAutoSettings(b.settings), team: teamView() }),
    '/api/auto/start': (q, b) => {
      const dir = dirOf(q, b);
      const root = inspectProject(dir).root;
      if (busy.get(path.resolve(root))) throw new RelayError(`正在${busy.get(path.resolve(root))!.op}，请等它做完。`, 'busy');
      const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
      const r = startAuto(dir, {
        goal: str(b.goal),
        acceptance: str(b.acceptance),
        workers: list(b.workers),
        reviewers: list(b.reviewers),
        ...(typeof b.maxRounds === 'number' ? { maxRounds: b.maxRounds } : {}),
        ...(typeof b.autoMerge === 'boolean' ? { autoMerge: b.autoMerge } : {}),
        ...(b.level === 'safe' || b.level === 'full' ? { level: b.level } : {}),
      });
      r.done.catch(() => undefined);
      rememberProject(r.state.root);
      return { state: r.state };
    },
    '/api/auto/stop': (q, b) => ({ stopped: stopAuto(rootOf(q, b)) }),
    '/api/choose-folder': async () => {
      const picked = await chooseFolder();
      if (!picked) throw new RelayError('没有选文件夹。', 'cancelled');
      return { dir: picked };
    },
    '/api/forget': (_q, b) => {
      forgetProject(path.resolve(str(b.dir) ?? ''));
      return {};
    },
    '/api/setup': (q, b) => {
      const dir = dirOf(q, b);
      return exclusive(dir, '设置项目', () => {
        const r = setupProject(dir);
        rememberProject(r.root);
        return r;
      });
    },
    '/api/start': (q, b) => {
      const dir = dirOf(q, b);
      return exclusive(inspectProject(dir).root, '开始任务', () => {
        const r = startTask(dir, { task: str(b.task) ?? '', acceptance: str(b.acceptance) });
        rememberProject(r.root);
        return r;
      });
    },
    '/api/work': (q, b) => {
      const dir = dirOf(q, b);
      const name = str(b.agent) ?? '';
      const agent = loadRegistry().agents.find((a) => a.name === name);
      if (!agent) throw new RelayError(`工人名单里没有「${name}」。`, 'no-agent');
      const o = { model: str(b.model), force: b.force === true };
      return exclusive(inspectProject(dir).root, '安排上岗', async () => {
        if (agentKind(agent) === 'app') return { kind: 'app', ...(await openApp(dir, name, o)) };
        return { kind: 'cli', ...launchInTerminal(dir, name, o) };
      });
    },
    '/api/copy-hint': () => ({ copied: copyToClipboard(ONBOARD_HINT), hint: ONBOARD_HINT }),
    '/api/handoff': (q, b) => {
      const dir = dirOf(q, b);
      return exclusive(inspectProject(dir).root, '交接', () => handoff(dir, { note: str(b.note) }));
    },
    '/api/merge': (q, b) => {
      const dir = dirOf(q, b);
      return exclusive(inspectProject(dir).root, '合回', () => merge(dir, { force: b.force === true, keepAudits: b.keepAudits === true }));
    },
    '/api/abandon': (q, b) => {
      const dir = dirOf(q, b);
      return exclusive(inspectProject(dir).root, '放弃任务', () => abandon(dir, { force: b.force === true }));
    },
    '/api/rollback': (q, b) => {
      const dir = dirOf(q, b);
      return exclusive(inspectProject(dir).root, '退回', () => rollback(dir, str(b.sha) ?? ''));
    },
    '/api/take': (q, b) => {
      const dir = dirOf(q, b);
      const only = Array.isArray(b.paths) ? b.paths.filter((p): p is string => typeof p === 'string') : undefined;
      return exclusive(inspectProject(dir).root, '收进任务', () => takeStray(dir, only));
    },
    '/api/sync': (q, b) => {
      const dir = dirOf(q, b);
      return exclusive(inspectProject(dir).root, '同步主线', () => {
        if (b.abort === true) {
          abortSync(dir);
          return { status: 'aborted' };
        }
        return syncMain(dir);
      });
    },
    '/api/reveal': (q, b) => {
      const base = sideBase(dirOf(q, b), str(b.side) ?? 'main');
      const target = insideBase(base, str(b.path) ?? '');
      return { opened: reveal(target), target };
    },
    '/api/workers/save': (_q, b) => {
      const agent = upsertAgent(b.agent, str(b.originalName));
      checkCache.clear();
      return { agent };
    },
    '/api/workers/delete': (_q, b) => {
      removeAgent(str(b.name) ?? '');
      return {};
    },
    '/api/config/save': (q, b) => {
      const root = rootOf(q, b);
      const info = inspectProject(root);
      if (!info.hasConfig) throw new RelayError('这个文件夹还不是接力项目。', 'no-config');
      return { config: saveRelayConfig(root, b.config as never) };
    },
    '/api/talk/say': (q, b) => {
      const root = rootOf(q, b);
      const ask = Array.isArray(b.ask) ? b.ask.filter((x): x is string => typeof x === 'string') : [];
      const r = say(root, str(b.text) ?? '', ask, talkContext(root));
      r.done.catch(() => undefined);
      return { row: r.row, queued: r.queued };
    },
    '/api/quit': () => {
      if (!opts.onQuit) throw new RelayError('这个接力台不能从网页关闭。', 'no-quit');
      const quit = opts.onQuit;
      // 先把回复发出去，再退出。
      setTimeout(quit, 200);
      return { quitting: true };
    },
    '/api/talk/clear': (q, b) => {
      const root = rootOf(q, b);
      if (talkStatus(root).current) throw new RelayError('还有人在发言，等这一轮说完再清空。', 'busy');
      return { archived: archiveTalk(root) };
    },
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (!trusted(req)) {
          send(res, 403, { ok: false, error: '只接受本机接力台页面的请求。', code: 'forbidden' });
          return;
        }
        if (url.pathname.startsWith('/api/')) {
          if (req.method === 'GET' && url.pathname === '/api/raw') {
            const base = sideBase(resolveDir(url.searchParams.get('dir') ?? undefined, fallbackDir()), url.searchParams.get('side') ?? 'main');
            const abs = insideBase(base, url.searchParams.get('path') ?? '');
            const type = IMAGE_TYPES[path.extname(abs).toLowerCase()];
            if (!type || !fs.existsSync(abs) || fs.statSync(abs).size > 20_000_000) {
              send(res, 404, { ok: false, error: '没有这张图。' });
              return;
            }
            res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            fs.createReadStream(abs).pipe(res);
            return;
          }
          const table = req.method === 'POST' ? post : req.method === 'GET' ? get : {};
          const h = table[url.pathname];
          if (!h) {
            send(res, 404, { ok: false, error: '没有这个接口。', code: 'not-found' });
            return;
          }
          const body = req.method === 'POST' ? await readBody(req) : {};
          const data = await h(url.searchParams, body, res);
          send(res, 200, { ok: true, ...(data as object) });
          return;
        }
        serveStatic(url.pathname, res);
      } catch (e) {
        const known = e instanceof RelayError;
        send(res, known ? 400 : 500, { ok: false, error: errorMessage(e), code: known ? e.code : 'internal' });
      }
    })();
  });
  return server;
}

function serveStatic(pathname: string, res: http.ServerResponse): void {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(WEB, path.normalize(rel));
  if (!isInside(WEB, file) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('找不到页面');
    return;
  }
  const ext = path.extname(file);
  const type =
    ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : ext === '.svg' ? 'image/svg+xml' : 'text/html; charset=utf-8';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  });
  res.end(fs.readFileSync(file));
}

export function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(e);
    };
    const onListening = () => {
      server.off('error', onError);
      const a = server.address();
      resolve(typeof a === 'object' && a ? a.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}
