import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { talkContext } from '../commands/talk';
import { autoSettingsSafe, saveAutoSettings } from '../core/auto-settings';
import { saveRelayConfig } from '../core/config';
import { addModelMembers, canCheckApps, desktopApps, enableProvider, findAppBundle, loadDetected, modelOptions, newerHints, setCrew, setMemberModel, tidyRegistry, type DetectReport } from '../core/detect';
import { RelayError, errorMessage } from '../core/errors';
import { UPLOAD_MAX, UPLOAD_REL, projectFiles, projectPath, readProjectFile, saveUpload } from '../core/files';
import { findHarness } from '../core/harness';
import { copyToClipboard, fillTemplate, openUrl, reveal, runOpener, chooseFolder } from '../core/launch';
import { projectSessions, readSession, resumeHow, sessionToolOf } from '../core/sessions';
import { listSkills } from '../core/skills';
import { loadLedger, markReview, pendingReviews } from '../core/ledger';
import { allMembers, orderMembers } from '../core/members';
import { forgetProject, lastProject, loadMemory, rememberProject } from '../core/memory';
import { appNameOf, llmName, toolName } from '../core/names';
import { BRIEF_REL, TASK_REL, editTask, type TaskEdit } from '../core/notes';
import { isInside } from '../core/paths';
import { untilText } from '../core/quota';
import { agentKind, findAgent, loadRegistry, removeAgent, saveRegistry, upsertAgent } from '../core/registry';
import { snapChanges, snapDiff, takeSnapshot } from '../core/snap';
import { adoptSummary, archiveTalk, deleteTalk, readTalk, restoreTalk, resumeTalk, say, summarize, talkFile, talkPath, talkSessions, talkStatus } from '../core/talk';
import { adoptOption, appendRule, castHumanVote, readVotes, startVote } from '../core/vote';
import { goActive, startGo, stopGo } from '../ops/go';
import { setThreadHidden } from '../ops/hidden';
import { checkRoot, deleteTask, initProject, liveProjects, newTask, restoreTask } from '../ops/init';
import { buildStamp, keeperMode } from '../ops/keeper';
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

/** 这个进程跑的是哪一份编译结果：网页看到它变了（接力台换了新版重启过），就自己刷新。 */
const BUILD = buildStamp();

/** 你自己在别的 AI 工具里接着做时，对它说的第一句话。 */
export const HINT = '接着做这个项目：先读 .relay/接力本.md，再按 AGENTS.md（或 CLAUDE.md）里的「接力规矩」来。';

// ---- 自动识别：接力台一启动就在后台识别一次（没识别过、或者上次是 12 小时以前） ----

let detecting: Promise<unknown> | null = null;

/**
 * 识别要十几秒，而且一路同步地问各家工具（版本、登录状态）：放在子进程里跑（relay detect --json），
 * 接力台自己不卡——卡住的时候桌面小程序会以为接力台停了，网页也会没反应。
 */
function detectInChild(offline: boolean): Promise<{ report: DetectReport | null; changes: string[] }> {
  return new Promise((resolve, reject) => {
    const cli = path.join(__dirname, '..', 'cli.js');
    const child = spawn(process.execPath, [cli, 'detect', '--json', ...(offline ? ['--offline'] : [])], { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    child.stderr.on('data', (c: string) => (err += c));
    child.on('error', (e) => reject(new RelayError(`识别没能开始：${e.message}`, 'detect-failed')));
    child.on('close', (code) => {
      const tail = (err || out).trim().split('\n').slice(-3).join(' ');
      if (code !== 0) return reject(new RelayError(`识别失败：${tail || `退出码 ${code}`}`, 'detect-failed'));
      try {
        const j = JSON.parse(out.slice(out.indexOf('{'))) as { report?: DetectReport; changes?: string[] };
        resolve({ report: j.report ?? loadDetected(), changes: j.changes ?? [] });
      } catch {
        reject(new RelayError('识别的结果看不懂。', 'detect-failed'));
      }
    });
  });
}

function ensureDetected(force = false): void {
  if (detecting || process.env.RELAY_AUTODETECT === 'off') return;
  const last = loadDetected();
  if (!force && last && Date.now() - new Date(last.at).getTime() < 12 * 3600_000) return;
  detecting = detectInChild(false)
    .catch(() => undefined)
    .finally(() => {
      detecting = null;
    });
}

// ---- 给网页看的成员 ----

function memberViewsUnsafe() {
  const s = autoSettingsSafe().settings;
  const now = new Date();
  const report = loadDetected();
  const list = orderMembers(allMembers(s.level, report), s.order);
  const newer = newerHints();
  // 给人看的名字是模型的名字；同一个模型有两位时，后面带上工具
  const nameOf = (m: (typeof list)[number]) => llmName(m.model) || m.label;
  const toolOf = (m: (typeof list)[number]) => toolName(m.harness) ?? (m.kind === 'api' ? '接口' : m.kind === 'app' ? appNameOf(m.agent.cmd) ?? m.label : m.label);
  return list.map((m) => ({
    name: m.name,
    label: m.label,
    llm: list.some((x) => x !== m && nameOf(x) === nameOf(m)) ? `${nameOf(m)}（${toolOf(m)}）` : nameOf(m),
    tool: toolOf(m),
    /** 你自己接着做时打开的桌面程序。 */
    app: appNameOf(m.kind === 'app' ? m.agent.cmd : m.agent.app) ?? null,
    model: m.model ?? null,
    kind: m.kind,
    tier: m.tier,
    tierSet: m.tierSet,
    canWork: m.canWork,
    canTalk: m.canTalk,
    why: m.why ?? null,
    cooling: m.cooling ?? null,
    coolingText: m.cooling ? untilText(m.cooling, now) : null,
    /** 工具自己报的额度窗口（kind：5h / 7d / 7d-opus，used：百分比，resetsAt：恢复时间）；没报过就不带。 */
    ...(m.limits ? { limits: m.limits, limitsAt: m.limitsAt } : {}),
    detected: !!m.agent.detected,
    /** 接力台对这个工具实测到什么程度：yes 改文件、跑命令都实测过 / partial 实测过一部分 / no 按官方参数写的；接口、桌面程序不带。 */
    tested: findHarness(m.harness)?.tested ?? null,
    /** 要升级才用得上最新模型（命令行太旧）：写明怎么升级。别的识别说明不用管，不给。 */
    update: (m.harness && report?.harnesses.find((h) => h.id === m.harness)?.model.note) || null,
    /** 同一条线上有更新的模型、或者工具说现在这个要停用（只提示，换不换由人定）。 */
    newer: newer[m.name] ?? null,
    agent: m.agent,
  }));
}

/** 成员名单坏了（agents.json 不是合法 JSON、格式不对）不能让整个网页打不开：列成空的，同时带上原因（网页顶上提示）。 */
function membersSafe(): { members: ReturnType<typeof memberViewsUnsafe>; error?: string } {
  try {
    return { members: memberViewsUnsafe() };
  } catch (e) {
    return { members: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** 别的接口只要名单：坏了就给空的（网页顶上另有提示）。 */
function memberViews() {
  return membersSafe().members;
}

/** 家目录、桌面这种大文件夹不能当项目：还没打开过项目时（从「接力台」小程序启动，停在家目录）网页先请你选一个。 */
function pickFolder(root: string, init: boolean): boolean {
  if (init) return false;
  try {
    checkRoot(root);
    return false;
  } catch {
    return true;
  }
}

function projectList(current: string | null) {
  const roots = [...(current ? [current] : []), ...(loadMemory().recents ?? [])];
  // 同一个文件夹的两种写法（经过链接的 /var 和 /private/var、Windows 上大小写不同）只列一次
  const real = (r: string) => {
    try {
      return fs.realpathSync.native(path.resolve(r));
    } catch {
      return path.resolve(r);
    }
  };
  const seen = new Set<string>();
  const out: { root: string; name: string; init: boolean; current: boolean; pending: number; live: boolean }[] = [];
  for (const r of roots) {
    const abs = path.resolve(r);
    const key = real(abs);
    if (seen.has(key) || !fs.existsSync(abs)) continue;
    seen.add(key);
    let init = false;
    let pending = 0;
    let live = false;
    try {
      const v = loadLedger(abs);
      init = !!v.init;
      pending = pendingReviews(v).length;
      live = !!v.open;
    } catch {
      /* 读不了当没接入 */
    }
    out.push({ root: abs, name: path.basename(abs), init, current: !!current && key === real(current), pending, live });
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
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      n += c.length;
      if (n > max) {
        // 太大就不再往内存里收，也不砸断连接（砸断的话网页收不到「请求太大」，只看到断线）：等收完再回。
        over = true;
        chunks.length = 0;
        req.resume();
        reject(new RelayError('请求太大。', 'too-large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
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

/**
 * 防 DNS 重绑定和跨站请求：只认本机地址 + 本端口；POST 必须是 JSON（传文件是 octet-stream：别的网站发这两种都要先预检，过不来）。
 * 别的网站里的一张图片、一个链接也会带着本机地址来请求（不带 Origin）：浏览器标明是从别的网站来的（Sec-Fetch-Site: cross-site / same-site），一律不认。
 */
function trusted(req: http.IncomingMessage, pathname: string): boolean {
  const port = req.socket.localPort;
  const okHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!okHosts.has(String(req.headers.host ?? ''))) return false;
  const origin = req.headers.origin;
  if (origin && !okHosts.has(origin.replace(/^http:\/\//, ''))) return false;
  const site = String(req.headers['sec-fetch-site'] ?? '');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').includes(pathname === '/api/upload' ? 'application/octet-stream' : 'application/json')) return false;
  return true;
}

function resolveDir(raw: string | undefined, fallback: string): string {
  const dir = path.resolve(raw && raw.trim() ? raw : fallback);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new RelayError(`找不到文件夹：${dir}`, 'no-dir');
  return dir;
}

function requireProject(root: string): void {
  if (!loadLedger(root).init) throw new RelayError('这个文件夹还没接入接力台', 'not-init');
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
  if (opts.autoDetect) {
    // 名单里重复的先并成一位（旧名单里桌面程序和命令行各占一位）；识别完还会再看一次。
    try {
      tidyRegistry();
    } catch {
      /* 名单坏了：网页上会报出来 */
    }
    ensureDetected();
  }
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
      const w = watching(root);
      const pick = pickFolder(root, !!pv.init);
      const auto = autoSettingsSafe();
      const mem = membersSafe();
      return {
        version: VERSION,
        build: BUILD,
        keeper: keeperMode(),
        home: os.homedir(),
        project: pick ? { ...pv, pick: true } : pv,
        members: mem.members,
        ...(mem.error ? { membersError: mem.error } : {}),
        settings: auto.settings,
        ...(auto.error ? { settingsError: auto.error } : {}),
        projects: projectList(pick ? null : root),
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
      // 看「还没人交接的改动」要先存一张快照：只在接入过的文件夹里做，不能给随便一个文件夹建快照仓库。
      requireProject(root);
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
      // 带 id：看一个存档的群聊
      const id = q.get('id');
      if (id) {
        const file = talkFile(root, id);
        if (!fs.existsSync(file)) throw new RelayError('没有这个群聊。', 'no-talk');
        return { id, rows: readTalk(root, 300, file), votes: readVotes(file).slice(-20), status: talkStatus(file) };
      }
      const file = talkPath(root);
      return { rows: readTalk(root, 300, file), votes: readVotes(file).slice(-20), status: talkStatus(file), sessions: talkSessions(root) };
    },
    '/api/tree': (q) => {
      const root = dirOf(q, {});
      // 家目录这种不是项目的：不列里面的文件
      return pickFolder(root, !!loadLedger(root).init) ? { files: [], truncated: false } : projectFiles(root);
    },
    '/api/file': (q) => readProjectFile(dirOf(q, {}), q.get('path') ?? ''),
    '/api/detect': () => ({ report: loadDetected(), members: memberViews(), detecting: !!detecting }),
    '/api/models': (q) => modelOptions(q.get('name') ?? ''),
    // 这个项目能用的技能（输入框打 / 挑）
    // 技能：接入过的项目连同项目里的；别的文件夹（还没打开项目时）只列这台电脑上的，不读那个文件夹
    // 添加桌面程序时挑：认得的（核实过）和这台电脑上所有的程序
    '/api/apps': () => desktopApps(),
    '/api/skills': (q) => {
      const root = dirOf(q, {});
      const modes = autoSettingsSafe().settings.skills;
      return { skills: listSkills(loadLedger(root).init ? root : null).map(({ name, description, from }) => ({ name, description, from, mode: modes[name] ?? 'named' })) };
    },
    // 这个项目文件夹里你自己在 Claude Code、Codex 里开的对话（设置里关掉就不列）
    '/api/sessions': (q) => {
      const root = dirOf(q, {});
      requireProject(root);
      return { sessions: autoSettingsSafe().settings.showSessions ? projectSessions(root) : [] };
    },
    // 读一段对话（接力台派出去的一棒、或者上面列出来的）：只认这个项目文件夹里的
    '/api/session': (q) => {
      const root = dirOf(q, {});
      requireProject(root);
      const tool = sessionToolOf(q.get('tool') ?? '');
      if (!tool) throw new RelayError('这个工具的对话读不了', 'no-session');
      return readSession(root, tool, q.get('id') ?? '');
    },
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
      newTask(root, str(b.text) ?? '', strList(b.steps), b.mode === 'dispatch' ? 'dispatch' : undefined);
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
      const r = startGo(root, { mode: 'once', kind, ...(str(b.who) ? { who: str(b.who) } : {}), ...(b.force === true ? { force: true } : {}) });
      r.done.catch(() => undefined);
      return { state: r.state };
    },
    '/api/auto': (q, b) => {
      const root = dirOf(q, b);
      requireProject(root);
      if (str(b.task)?.trim()) newTask(root, str(b.task)!, [], b.mode === 'dispatch' ? 'dispatch' : undefined);
      const r = startGo(root, { mode: 'auto', ...(b.force === true ? { force: true } : {}) });
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
      // 你自己接着做：用桌面程序打开这个文件夹，并把第一句话复制好。命令行工具不弹终端窗口，由接力台在后台派活。
      const root = dirOf(q, b);
      requireProject(root);
      const a = findAgent(str(b.who) ?? '');
      if (!a) throw new RelayError('名单里没有它。', 'no-agent');
      const cmd = agentKind(a) === 'app' ? a.cmd : a.app;
      if (!cmd) throw new RelayError('没有桌面程序', 'cannot-open');
      const copied = copyToClipboard(HINT);
      const r = await runOpener(fillTemplate(cmd, { dir: root, worktree: root }), root);
      if (r.code !== 0 && !r.lingering) throw new RelayError(`打不开：${r.output || `退出码 ${r.code}`}`, 'open-failed');
      return { opened: true, copied, hint: HINT };
    },
    '/api/copy-hint': () => ({ copied: copyToClipboard(HINT), hint: HINT }),
    '/api/session/open': (q, b) => {
      const root = dirOf(q, b);
      requireProject(root);
      const how = resumeHow(str(b.tool) ?? '', str(b.id) ?? '', root);
      if (!how) throw new RelayError('这个工具回不到原来的对话', 'no-session');
      if ('url' in how) return { opened: openUrl(how.url) };
      return { command: how.command, copied: copyToClipboard(how.command) };
    },
    '/api/reveal': (q, b) => {
      // 在访达里显示项目文件夹 / 选中其中一个文件。
      const root = dirOf(q, b);
      const rel = str(b.path);
      const target = rel ? projectPath(root, rel).real : root;
      return { revealed: reveal(target) };
    },
    '/api/rollback': (q, b) => {
      const root = dirOf(q, b);
      if (goActive(root)) throw new RelayError('接力台正在调度一棒', 'busy');
      return rollbackBefore(root, num(b.stint, '棒号'));
    },
    '/api/rollback/undo': (q, b) => {
      const root = dirOf(q, b);
      if (goActive(root)) throw new RelayError('接力台正在调度一棒', 'busy');
      return undoRollback(root);
    },
    '/api/mark': (q, b) => {
      const root = dirOf(q, b);
      requireProject(root);
      markReview(root, Number(b.stint), b.review === 'needed' ? 'needed' : 'skip', str(b.note));
      refreshBrief(root);
      return {};
    },
    '/api/detect': async (_q, b) => {
      if (detecting) await detecting;
      const run = detectInChild(b.offline === true);
      const tracked: Promise<unknown> = run
        .catch(() => undefined)
        .finally(() => {
          if (detecting === tracked) detecting = null;
        });
      detecting = tracked;
      const r = await run;
      return { report: r.report, changes: r.changes, members: memberViews() };
    },
    '/api/detect/use': (_q, b) => {
      const report = loadDetected();
      if (!report) throw new RelayError('还没识别过', 'no-detect');
      const agent = enableProvider(report, str(b.id) ?? '');
      return { agent, members: memberViews() };
    },
    '/api/settings': (_q, b) => {
      const before = autoSettingsSafe().settings.lead;
      const settings = saveAutoSettings(b.settings);
      // 选了谁指挥派活：它要做复核、终审，算强（弱模型的复核不算数，不然还得请别的强模型来）
      if (settings.lead && settings.lead !== before) {
        const reg = loadRegistry();
        const a = reg.agents.find((x) => x.name === settings.lead);
        if (a && memberViews().find((m) => m.name === a.name)?.tier !== 'strong') {
          a.tier = 'strong';
          a.tierSet = true;
          saveRegistry(reg);
        }
      }
      return { settings, members: memberViews() };
    },
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
    '/api/members/add-models': (_q, b) => {
      const models = Array.isArray(b.models) ? b.models.filter((x): x is string => typeof x === 'string').slice(0, 30) : [];
      if (!models.some((x) => x.trim())) throw new RelayError('没选模型', 'bad-agent');
      const added = addModelMembers(str(b.from) ?? '', models);
      if (added.length) for (const r of liveProjects()) refreshBrief(r);
      return { added: added.map((a) => a.name), members: memberViews() };
    },
    '/api/members/model': (_q, b) => {
      setMemberModel(str(b.name) ?? '', str(b.model) ?? '');
      for (const r of liveProjects()) refreshBrief(r);
      return { members: memberViews() };
    },
    '/api/skills/mode': (_q, b) => {
      const name = (str(b.name) ?? '').trim();
      if (!name || name.length > 120 || /[\\/\u0000-\u001f]/.test(name)) throw new RelayError('没说清是哪个技能', 'bad-skill');
      const cur = autoSettingsSafe().settings;
      const skills = { ...cur.skills };
      if (b.mode === 'off' || b.mode === 'always') skills[name] = b.mode;
      else delete skills[name];
      return { settings: saveAutoSettings({ ...cur, skills }) };
    },
    '/api/members/crew': (_q, b) => {
      setCrew(str(b.name) ?? '', str(b.crew) ?? '');
      return { members: memberViews() };
    },
    // 桌面程序：核实这台电脑上真有这个程序（程序包在、读得出标识）才收
    '/api/workers/save': (_q, b) => {
      const a = b.agent && typeof b.agent === 'object' ? (b.agent as Record<string, unknown>) : {};
      const app = a.kind === 'app' && typeof a.cmd === 'string' ? appNameOf(a.cmd) : undefined;
      if (app && canCheckApps() && !findAppBundle(app)) throw new RelayError(`这台电脑上找不到「${app}」`, 'no-app');
      return { agent: upsertAgent(b.agent, str(b.originalName)) };
    },
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
    // 新群聊：正在用的存档（左栏里还看得到）。还有人在说、在投也行：他们接着写进存档的那段。
    '/api/talk/clear': (q, b) => ({ archived: archiveTalk(dirOf(q, b)) }),
    // 接着一个存档的群聊：它换成正在用的，原来正在用的存档。
    // 删除一段群聊（挪进 .relay/已删除的群聊/）；找回。
    '/api/talk/delete': (q, b) => ({ id: deleteTalk(dirOf(q, b), str(b.id) || null) }),
    '/api/talk/restore': (q, b) => {
      restoreTalk(dirOf(q, b), str(b.id) ?? '');
      return {};
    },
    // 左边删掉一段对话（任务）/ 撤销：只是不再列出。
    '/api/task/delete': (q, b) => {
      const root = dirOf(q, b);
      requireProject(root);
      return { id: deleteTask(root) };
    },
    '/api/task/restore': (q, b) => {
      const root = dirOf(q, b);
      requireProject(root);
      restoreTask(root, str(b.id) ?? '');
      return {};
    },
    '/api/thread/hide': (q, b) => {
      const root = dirOf(q, b);
      requireProject(root);
      const key = str(b.key) ?? '';
      if (!key) throw new RelayError('不知道是哪一段对话。', 'bad-thread');
      setThreadHidden(root, key, b.hidden !== false);
      // 删掉的对话里的棒不再算待复核：接力本里「先复核」那一节跟着变
      refreshBrief(root);
      return {};
    },
    '/api/talk/resume': (q, b) => {
      resumeTalk(dirOf(q, b), str(b.id) ?? '');
      return {};
    },
    // 总结：请一位把最后一问的几份回答并成一份（回答还在说的，说完再总结）
    '/api/talk/summary': (q, b) => {
      const root = dirOf(q, b);
      const r = summarize(root, str(b.who) ?? '', talkContext(root));
      r.done.catch(() => undefined);
      return { queued: r.queued };
    },
    // 采纳一条总结：它的「结论」写进任务的约定
    '/api/talk/adopt': (q, b) => {
      const root = dirOf(q, b);
      const row = adoptSummary(root, str(b.ts) ?? '', (line) => appendRule(root, line, '群聊总结定下'));
      if (loadLedger(root).init) refreshBrief(root);
      return { row };
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
    '/api/choose-folder': async (_q, b) => {
      const picked = await chooseFolder(b.lang === 'en' ? 'Choose a project folder' : '选一个项目文件夹').catch((e: { code?: string; message?: string }) => {
        throw new RelayError(e.message ?? '弹不出选文件夹的对话框', e.code === 'no-picker' ? 'no-picker' : 'error');
      });
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
        if (!trusted(req, url.pathname)) {
          send(res, 403, { ok: false, error: '只接受本机接力台页面的请求。', code: 'forbidden' });
          return;
        }
        // 传文件：请求体就是文件本身，边收边写进项目的 .relay/uploads
        if (req.method === 'POST' && url.pathname === '/api/upload') {
          const root = resolveDir(url.searchParams.get('dir') ?? undefined, fallbackDir());
          requireProject(root);
          if (Number(req.headers['content-length'] ?? 0) > UPLOAD_MAX) throw new RelayError(`文件太大，上限 ${UPLOAD_MAX / 1024 / 1024} MB。`, 'too-large');
          send(res, 200, { ok: true, path: await saveUpload(root, url.searchParams.get('name') ?? '', req) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/raw') {
          serveRaw(resolveDir(url.searchParams.get('dir') ?? undefined, fallbackDir()), url.searchParams.get('path') ?? '', res);
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
        const status = !known ? 500 : e.code === 'too-large' ? 413 : 400;
        send(res, status, { ok: false, error: errorMessage(e), code: known ? e.code : 'internal' });
      }
    })();
  });
  server.on('close', () => {
    if (opts.watch) unwatchAll();
  });
  return server;
}

/** 项目里一个文件的原样内容（图片的缩略图、点开看原图）。 */
const RAW_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

function serveRaw(root: string, rel: string, res: http.ServerResponse): void {
  const { clean, real } = projectPath(root, rel);
  if (!fs.statSync(real).isFile()) throw new RelayError('不是文件。', 'no-file');
  const type = RAW_TYPES[path.extname(real).toLowerCase()];
  res.writeHead(200, {
    'Content-Type': type ?? 'application/octet-stream',
    'Content-Disposition': type ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(real))}`,
    // 传上来的文件名字带时间、不会再变：浏览器记住，缩略图不用每次重新读
    'Cache-Control': clean.startsWith(`${UPLOAD_REL}/`) ? 'private, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    // 项目里的文件不能在接力台的网址下跑脚本（比如带脚本的 svg）；pdf 交给浏览器自己的阅读器（加了 sandbox 它打不开）
    ...(type === 'application/pdf' ? {} : { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'" }),
  });
  fs.createReadStream(real)
    .on('error', () => res.destroy())
    .pipe(res);
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
    // 字体很大又不常变：浏览器记住就行（换字体时改网址后面的 ?v=）；别的每次都拿最新的
    'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-store',
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
