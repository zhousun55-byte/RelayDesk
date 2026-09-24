import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { doctor } from '../commands/doctor';
import { talkContext } from '../commands/talk';
import { loadAutoSettings, saveAutoSettings } from '../core/auto-settings';
import { saveRelayConfig } from '../core/config';
import { detectAll, enableProvider, loadDetected, syncRegistry } from '../core/detect';
import { RelayError, errorMessage } from '../core/errors';
import { projectFiles, projectPath, readProjectFile } from '../core/files';
import { copyToClipboard, fillTemplate, openTerminal, reveal, runOpener, shq, chooseFolder } from '../core/launch';
import { loadLedger, saveStint } from '../core/ledger';
import { allMembers, orderMembers } from '../core/members';
import { forgetProject, lastProject, loadMemory, rememberProject } from '../core/memory';
import { BRIEF_REL, TASK_REL, editTask, type TaskEdit } from '../core/notes';
import { isInside } from '../core/paths';
import { PRESETS } from '../core/presets';
import { untilText } from '../core/quota';
import { agentKind, findAgent, loadRegistry, removeAgent, saveRegistry, upsertAgent } from '../core/registry';
import { snapChanges, snapDiff, takeSnapshot } from '../core/snap';
import { archiveTalk, readTalk, say, talkBusy, talkStatus } from '../core/talk';
import { adoptOption, castHumanVote, readVotes, startVote } from '../core/vote';
import { goActive, startGo, stopGo } from '../ops/go';
import { initProject, liveProjects, newTask } from '../ops/init';
import { rollbackBefore, undoRollback } from '../ops/rollback';
import { refreshBrief, relayBusy, trackAndGate } from '../ops/track';
import { projectView, readRunLog, stintDetail } from '../ops/view';
import { unwatchAll, watchProject, watching } from '../ops/watch';

const WEB = path.join(__dirname, '..', 'web');
const VERSION = (() => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '?';
  }
})();

/** 你自己在别的 AI 工具里接着做时，对它说的第一句话。 */
export const HINT = '接着做这个项目：先读 .relay/接力本.md，再按 AGENTS.md（或 CLAUDE.md）里的「接力规矩」来。';

// ---- 自动识别：接力台一启动就在后台识别一次（没识别过、或者上次是 12 小时以前） ----

let detecting: Promise<unknown> | null = null;

function ensureDetected(force = false): void {
  if (detecting || process.env.RELAY_AUTODETECT === 'off') return;
  const last = loadDetected();
  if (!force && last && Date.now() - new Date(last.at).getTime() < 12 * 3600_000) return;
  detecting = detectAll({ network: true })
    .then((r) => syncRegistry(r))
    .catch(() => undefined)
    .finally(() => {
      detecting = null;
    });
}

// ---- 给网页看的成员 ----

function memberViews() {
  const s = loadAutoSettings();
  const now = new Date();
  return orderMembers(allMembers(s.level), s.order).map((m) => ({
    name: m.name,
    label: m.label,
    model: m.model ?? null,
    kind: m.kind,
    tier: m.tier,
    tierSet: m.tierSet,
    canWork: m.canWork,
    canTalk: m.canTalk,
    why: m.why ?? null,
    cooling: m.cooling ?? null,
    coolingText: m.cooling ? untilText(m.cooling, now) : null,
    detected: !!m.agent.detected,
    agent: m.agent,
  }));
}

function projectList(current: string | null) {
  const roots = [...(current ? [current] : []), ...(loadMemory().recents ?? [])];
  const seen = new Set<string>();
  const out: { root: string; name: string; init: boolean; current: boolean; pending: number; live: boolean }[] = [];
  for (const r of roots) {
    const abs = path.resolve(r);
    if (seen.has(abs) || !fs.existsSync(abs)) continue;
    seen.add(abs);
    let init = false;
    let pending = 0;
    let live = false;
    try {
      const v = loadLedger(abs);
      init = !!v.init;
      pending = v.stints.filter((s) => s.review === 'needed' && s.status !== 'working' && !s.rolledBack).length;
      live = !!v.open;
    } catch {
      /* 读不了当没接入 */
    }
    out.push({ root: abs, name: path.basename(abs), init, current: abs === current, pending, live });
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

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
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

function requireProject(root: string): void {
  if (!loadLedger(root).init) throw new RelayError('这个文件夹还没接入接力台。先点「接入」。', 'not-init');
}

function num(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new RelayError(`${what}不对。`, 'bad-number');
  return n;
}

// ---- 路由 ----

type Handler = (q: URLSearchParams, body: Record<string, unknown>) => Promise<unknown> | unknown;

export interface ServerOptions {
  defaultDir: string;
  autoDetect?: boolean;
  /** 盯着接入过的文件夹自动记账（relay ui 开；测试里按需开）。 */
  watch?: boolean;
  /** 网页上点「关闭接力台」时调用（由启动网页的 relay ui 负责退出进程）；不给就不能从网页关闭。 */
  onQuit?: () => void;
}

export function createServer(opts: ServerOptions): http.Server {
  if (opts.autoDetect) ensureDetected();
  const watchOn = (root: string) => {
    if (opts.watch && loadLedger(root).init) watchProject(root);
  };
  if (opts.watch) for (const r of liveProjects()) watchOn(r);
  const fallbackDir = () => lastProject() ?? opts.defaultDir;
  const dirOf = (q: URLSearchParams, body: Record<string, unknown>) => resolveDir(str(body.dir) ?? q.get('dir') ?? undefined, fallbackDir());

  const get: Record<string, Handler> = {
    '/api/ping': () => ({ app: 'relay', version: VERSION }),
    '/api/state': (q) => {
      const root = dirOf(q, {});
      const pv = projectView(root);
      if (pv.init) {
        rememberProject(root);
        watchOn(root);
      }
      const t = talkStatus(root);
      const w = watching(root);
      return {
        version: VERSION,
        home: os.homedir(),
        project: pv,
        members: memberViews(),
        settings: loadAutoSettings(),
        projects: projectList(root),
        talk: { count: readTalk(root).length, speaking: t.speaking, queue: t.queue },
        detecting: !!detecting,
        detectedAt: loadDetected()?.at ?? null,
        watching: !!w,
        watchError: w?.lastError ?? null,
        hint: HINT,
      };
    },
    '/api/stint': (q) => {
      const root = dirOf(q, {});
      const d = stintDetail(root, num(q.get('id'), '棒号'));
      if (!d) throw new RelayError('没有这一棒。', 'no-stint');
      return d;
    },
    '/api/diff': (q) => {
      const root = dirOf(q, {});
      const v = loadLedger(root);
      const id = q.get('id');
      const file = q.get('path') ?? undefined;
      if (!id || id === '0') {
        // 上一棒结束之后、还没人交接的改动。
        const now = takeSnapshot(root, '看改动').sha;
        const base = v.base ?? now;
        return { files: snapChanges(root, base, now), diff: snapDiff(root, base, now, file) };
      }
      const s = v.stints.find((x) => x.id === Number(id));
      if (!s) throw new RelayError('没有这一棒。', 'no-stint');
      const to = s.to ?? takeSnapshot(root, '看改动').sha;
      return { files: snapChanges(root, s.from, to), diff: snapDiff(root, s.from, to, file) };
    },
    '/api/log': (q) => ({ text: readRunLog(dirOf(q, {}), q.get('path') ?? '') }),
    '/api/brief': (q) => {
      const root = dirOf(q, {});
      try {
        return { text: fs.readFileSync(path.join(root, BRIEF_REL), 'utf8') };
      } catch {
        return { text: '' };
      }
    },
    '/api/task': (q) => {
      const root = dirOf(q, {});
      try {
        return { raw: fs.readFileSync(path.join(root, TASK_REL), 'utf8') };
      } catch {
        return { raw: '' };
      }
    },
    '/api/talk': (q) => {
      const root = dirOf(q, {});
      return { rows: readTalk(root, 300), votes: readVotes(root).slice(-20), status: talkStatus(root) };
    },
    '/api/tree': (q) => projectFiles(dirOf(q, {})),
    '/api/file': (q) => readProjectFile(dirOf(q, {}), q.get('path') ?? ''),
    '/api/detect': () => ({ report: loadDetected(), members: memberViews(), detecting: !!detecting }),
    '/api/presets': () => ({ presets: PRESETS }),
    '/api/doctor': (q) => ({ lines: doctor(dirOf(q, {})) }),
  };

  const post: Record<string, Handler> = {
    '/api/init': (q, b) => {
      const root = dirOf(q, b);
      const r = initProject(root, { task: str(b.task) });
      rememberProject(r.root);
      watchOn(r.root);
      return r;
    },
    '/api/task': (q, b) => {
      const root = dirOf(q, b);
      requireProject(root);
      newTask(root, str(b.text) ?? '', strList(b.steps));
      return {};
    },
    '/api/task/save': (q, b) => {
      const root = dirOf(q, b);
      requireProject(root);
      const raw = str(b.raw) ?? '';
      if (!raw.trim()) throw new RelayError('任务不能是空的。', 'empty');
      fs.writeFileSync(path.join(root, TASK_REL), raw.endsWith('\n') ? raw : `${raw}\n`);
      refreshBrief(root);
      return {};
    },
    '/api/task/edit': (q, b) => {
      // 网页上改标题、打勾、加一步、删一步。
      const root = dirOf(q, b);
      requireProject(root);
      const op = str(b.op);
      const text = str(b.text) ?? '';
      const index = Number(b.index);
      let edit: TaskEdit;
      if (op === 'title' || op === 'add') edit = { op, text };
      else if ((op === 'toggle' || op === 'remove') && Number.isInteger(index) && index >= 0) edit = op === 'toggle' ? { op, index, ...(typeof b.done === 'boolean' ? { done: b.done } : {}) } : { op, index };
      else throw new RelayError('不认识这个改法。', 'bad-edit');
      const t = editTask(root, edit);
      refreshBrief(root);
      return { task: { title: t.title, items: t.items } };
    },
    '/api/go': (q, b) => {
      const root = dirOf(q, b);
      requireProject(root);
      const kind = b.kind === 'review' ? 'review' : 'work';
      const r = startGo(root, { mode: 'once', kind, ...(str(b.who) ? { who: str(b.who) } : {}) });
      r.done.catch(() => undefined);
      return { state: r.state };
    },
    '/api/auto': (q, b) => {
      const root = dirOf(q, b);
      requireProject(root);
      if (str(b.task)?.trim()) newTask(root, str(b.task)!);
      const r = startGo(root, { mode: 'auto' });
      r.done.catch(() => undefined);
      return { state: r.state };
    },
    '/api/stop': (q, b) => ({ stopped: stopGo(dirOf(q, b)) }),
    '/api/snap': async (q, b) => {
      const root = dirOf(q, b);
      requireProject(root);
      return await trackAndGate(root);
    },
    '/api/open': async (q, b) => {
      // 你自己接着做：用桌面程序打开这个文件夹 / 在终端里开编程工具，并把第一句话复制好。
      const root = dirOf(q, b);
      requireProject(root);
      const a = findAgent(str(b.who) ?? '');
      if (!a) throw new RelayError('名单里没有它。', 'no-agent');
      const copied = copyToClipboard(HINT);
      if (agentKind(a) === 'app') {
        const r = await runOpener(fillTemplate(a.cmd ?? '', { dir: root, worktree: root }), root);
        if (r.code !== 0 && !r.lingering) throw new RelayError(`打不开：${r.output || `退出码 ${r.code}`}`, 'open-failed');
        return { opened: true, copied, hint: HINT };
      }
      if (agentKind(a) === 'cli' && a.cmd) {
        const first = a.prompt?.mode === 'arg' ? ` ${shq(HINT)}` : '';
        const t = openTerminal(`cd ${shq(root)} && ${a.cmd}${first}`);
        return { opened: t.ok, copied, hint: HINT, ...(t.ok ? {} : { error: t.error }) };
      }
      throw new RelayError('它没有可以打开的程序（接口模型用「让它接着做」）。', 'cannot-open');
    },
    '/api/copy-hint': () => ({ copied: copyToClipboard(HINT), hint: HINT }),
    '/api/reveal': (q, b) => {
      // 在访达里显示项目文件夹 / 选中其中一个文件。
      const root = dirOf(q, b);
      const rel = str(b.path);
      const target = rel ? projectPath(root, rel).real : root;
      return { revealed: reveal(target) };
    },
    '/api/rollback': (q, b) => {
      const root = dirOf(q, b);
      if (goActive(root)) throw new RelayError('接力台正在调度，先停下再退回。', 'busy');
      return rollbackBefore(root, num(b.stint, '棒号'));
    },
    '/api/rollback/undo': (q, b) => {
      const root = dirOf(q, b);
      if (goActive(root)) throw new RelayError('接力台正在调度，先停下再撤销。', 'busy');
      return undoRollback(root);
    },
    '/api/mark': (q, b) => {
      // 你说这一棒不用复核（比如其实是你自己改的）。
      const root = dirOf(q, b);
      const v = loadLedger(root);
      const s = v.stints.find((x) => x.id === Number(b.stint));
      if (!s) throw new RelayError('没有这一棒。', 'no-stint');
      if (s.status === 'working') throw new RelayError('这一棒还在进行中。', 'working');
      const note = str(b.note)?.trim() || '你标记为不用复核。';
      saveStint(root, { ...s, review: 'skip', note: [s.note, note].filter(Boolean).join(' ') });
      refreshBrief(root);
      return {};
    },
    '/api/detect': async (_q, b) => {
      if (detecting) await detecting;
      const report = await detectAll({ network: b.offline !== true });
      const changes = syncRegistry(report);
      return { report, changes, members: memberViews() };
    },
    '/api/detect/use': (_q, b) => {
      const report = loadDetected();
      if (!report) throw new RelayError('先识别一次。', 'no-detect');
      const agent = enableProvider(report, str(b.id) ?? '');
      return { agent, members: memberViews() };
    },
    '/api/settings': (_q, b) => ({ settings: saveAutoSettings(b.settings), members: memberViews() }),
    '/api/members/tier': (_q, b) => {
      const name = str(b.name) ?? '';
      const tier = b.tier === 'strong' ? 'strong' : b.tier === 'weak' ? 'weak' : null;
      const reg = loadRegistry();
      const a = reg.agents.find((x) => x.name === name);
      if (!a) throw new RelayError('名单里没有它。', 'no-agent');
      if (tier) {
        a.tier = tier;
        a.tierSet = true;
      } else delete a.tierSet;
      saveRegistry(reg);
      for (const r of liveProjects()) refreshBrief(r);
      return { members: memberViews() };
    },
    '/api/workers/save': (_q, b) => ({ agent: upsertAgent(b.agent, str(b.originalName)) }),
    '/api/workers/delete': (_q, b) => {
      removeAgent(str(b.name) ?? '');
      return {};
    },
    '/api/config/save': (q, b) => {
      const root = dirOf(q, b);
      requireProject(root);
      const cfg = saveRelayConfig(root, b.config as never);
      refreshBrief(root);
      return { config: cfg };
    },
    '/api/talk/say': (q, b) => {
      const root = dirOf(q, b);
      const r = say(root, str(b.text) ?? '', strList(b.ask), talkContext(root), b.mode === 'solo' ? 'solo' : 'turn');
      r.done.catch(() => undefined);
      return { row: r.row, queued: r.queued };
    },
    '/api/talk/clear': (q, b) => {
      const root = dirOf(q, b);
      if (talkBusy(root)) throw new RelayError('还有人在发言，等这一轮说完再清空。', 'busy');
      return { archived: archiveTalk(root) };
    },
    '/api/vote/start': (q, b) => {
      const root = dirOf(q, b);
      const r = startVote(root, { question: str(b.question) ?? '', voters: strList(b.voters), options: strList(b.options), context: talkContext(root) });
      r.done.catch(() => undefined);
      return { vote: r.vote };
    },
    '/api/vote/cast': (q, b) => ({ vote: castHumanVote(dirOf(q, b), str(b.id) ?? '', str(b.key) ?? '', str(b.reason) ?? '') }),
    '/api/vote/adopt': (q, b) => {
      const root = dirOf(q, b);
      const v = adoptOption(root, str(b.id) ?? '', str(b.key) ?? '');
      if (loadLedger(root).init) refreshBrief(root);
      return { vote: v };
    },
    '/api/choose-folder': async () => {
      const picked = await chooseFolder();
      if (!picked) throw new RelayError('没有选文件夹。', 'cancelled');
      return { dir: picked };
    },
    '/api/forget': (_q, b) => {
      forgetProject(path.resolve(str(b.dir) ?? ''));
      return {};
    },
    '/api/quit': () => {
      if (!opts.onQuit) throw new RelayError('这个接力台不能从网页关闭。', 'no-quit');
      const quit = opts.onQuit;
      // 先把回复发出去，再退出。
      setTimeout(quit, 200);
      return { quitting: true };
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
          const table = req.method === 'POST' ? post : req.method === 'GET' ? get : {};
          const h = table[url.pathname];
          if (!h) {
            send(res, 404, { ok: false, error: '没有这个接口。', code: 'not-found' });
            return;
          }
          const body = req.method === 'POST' ? await readBody(req) : {};
          const data = await h(url.searchParams, body);
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
  server.on('close', () => {
    if (opts.watch) unwatchAll();
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
    ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : ext === '.svg' ? 'image/svg+xml' : ext === '.woff2' ? 'font/woff2' : 'text/html; charset=utf-8';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'",
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

export { relayBusy };
