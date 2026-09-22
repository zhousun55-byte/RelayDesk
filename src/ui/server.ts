import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { adoptProject } from '../core/adopt';
import {
  loadDeskState,
  readDeskPreview,
  resolveDeskDir,
  resolveProjectRoot,
  writeProjectTitle,
  type DeskFileSide,
} from '../core/board';
import { readHarnessBrain } from '../core/identity';
import { lastHumanText, maybeAsk, openTalkWindow, pullIntoTalk, resolveProjectFile, sayAs, sayInTalk, saveTalkFile, talkWho } from '../core/talk';
import { loadUiMemory, rememberUi } from '../core/ui-memory';

const CLI = path.join(__dirname, '..', 'cli.js');
const PUBLIC = path.join(__dirname, 'public');

export function rememberRoot(root: string): void {
  rememberUi({ root });
}

export function lastRoot(): string | null {
  const root = loadUiMemory().root;
  return root && fs.existsSync(root) ? root : null;
}

function runRelay(root: string, args: string[], timeout = 180_000): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { code: r.status ?? 1, out };
}

function send(res: http.ServerResponse, code: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req: http.IncomingMessage, max = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > max) {
        reject(new Error('请求太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function mime(p: string): string {
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  return 'text/html; charset=utf-8';
}

function viewFrom(url: URL): { side?: DeskFileSide; rel?: string } {
  const side = url.searchParams.get('side');
  const rel = url.searchParams.get('rel') ?? '';
  return {
    side: side === 'site' || side === 'project' ? side : undefined,
    rel: rel || undefined,
  };
}

function chooseFolderMac(): string | null {
  const r = spawnSync(
    'osascript',
    ['-e', 'POSIX path of (choose folder with prompt "选一个项目文件夹")'],
    { encoding: 'utf8', timeout: 300_000 }
  );
  if (r.status !== 0) return null;
  return r.stdout.trim().replace(/\/$/, '');
}

function localOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || Array.isArray(origin)) return !origin;
  try {
    const u = new URL(origin);
    const port = String(req.socket.localPort ?? '');
    const hostOk = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    const portOk = u.port === '' || u.port === port;
    return u.protocol === 'http:' && hostOk && portOk;
  } catch {
    return false;
  }
}

function insideDir(parent: string, child: string): boolean {
  const base = path.resolve(parent);
  const target = path.resolve(child);
  return target === base || target.startsWith(base + path.sep);
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  if (!localOrigin(req)) {
    send(res, 403, { error: '只接受本机这个页面的请求' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const raw = url.searchParams.get('root') || lastRoot() || process.cwd();
    const root = resolveProjectRoot(raw);
    rememberRoot(root);
    send(res, 200, loadDeskState(root, viewFrom(url)));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/preview') {
    const raw = url.searchParams.get('root') || lastRoot() || process.cwd();
    const root = resolveProjectRoot(raw);
    const view = viewFrom(url);
    const name = url.searchParams.get('file') || '';
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
      send(res, 400, { error: '文件名不对' });
      return;
    }
    const st = loadDeskState(root, view);
    const dir = resolveDeskDir(st.root, st.fileSide, st.fileRel, st.worktree);
    const abs = path.join(dir, name);
    try {
      send(res, 200, { name, content: readDeskPreview(abs) });
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/file') {
    const raw = url.searchParams.get('root') || lastRoot() || process.cwd();
    const root = resolveProjectRoot(raw);
    const rel = url.searchParams.get('rel') || '';
    const abs = resolveProjectFile(root, rel);
    if (!abs || !/\.(png|jpe?g|gif|webp)$/i.test(abs)) {
      send(res, 404, { error: '没有这张图' });
      return;
    }
    const type = abs.endsWith('.png')
      ? 'image/png'
      : abs.endsWith('.gif')
        ? 'image/gif'
        : abs.endsWith('.webp')
          ? 'image/webp'
          : 'image/jpeg';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(abs));
    return;
  }

  if (req.method !== 'POST') {
    send(res, 404, { error: '没有这个接口' });
    return;
  }

  if (url.pathname === '/api/talk-file') {
    try {
      const up = JSON.parse((await readBody(req, 12_000_000)) || '{}') as { root?: string; name?: string; data?: string };
      const root = resolveProjectRoot(up.root || lastRoot() || process.cwd());
      const data = up.data || '';
      if (!data) throw new Error('没有文件');
      const bytes = Buffer.from(data, 'base64');
      if (!bytes.length || bytes.length > 8_000_000) throw new Error('文件太大');
      const saved = saveTalkFile(root, up.name || 'file', bytes);
      send(res, 200, { ok: true, path: saved, name: path.basename(saved) });
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }

  const body = JSON.parse((await readBody(req)) || '{}') as {
    root?: string;
    task?: string;
    agent?: string;
    llm?: string;
    force?: boolean;
    side?: DeskFileSide;
    rel?: string;
    file?: string;
    text?: string;
    from?: string;
    files?: string[];
    title?: string;
  };

  if (url.pathname === '/api/choose-folder') {
    const picked = process.platform === 'darwin' ? chooseFolderMac() : null;
    if (!picked) {
      send(res, 400, { error: '没有选文件夹' });
      return;
    }
    const root = resolveProjectRoot(picked);
    rememberRoot(root);
    send(res, 200, { ok: true, root, state: loadDeskState(root) });
    return;
  }

  const root = resolveProjectRoot(body.root || lastRoot() || process.cwd());
  rememberRoot(root);

  if (url.pathname === '/api/remember') {
    rememberUi({
      ...(body.agent ? { agent: body.agent } : {}),
      ...(body.llm !== undefined ? { llm: body.llm } : {}),
    });
    send(res, 200, { ok: true, state: loadDeskState(root, { side: body.side, rel: body.rel }) });
    return;
  }

  const openArgs = ['open', body.agent ?? ''];
  if (body.llm?.trim()) openArgs.push('--llm', body.llm.trim());

  if (url.pathname === '/api/talk') {
    try {
      const text = body.text ?? '';
      const from = body.from?.trim();
      if (from && from !== 'human') {
        sayAs(root, {
          who: talkWho(from),
          windowId: from,
          llm: readHarnessBrain(from) || undefined,
          text,
        });
      } else {
        sayInTalk(root, text, Array.isArray(body.files) ? body.files : []);
      }
      maybeAsk(root, { fresh: true });
      send(res, 200, { ok: true, state: loadDeskState(root, { side: body.side, rel: body.rel }) });
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.message : String(e), state: loadDeskState(root) });
    }
    return;
  }

  if (url.pathname === '/api/title') {
    try {
      writeProjectTitle(root, body.title ?? '');
      send(res, 200, { ok: true, state: loadDeskState(root, { side: body.side, rel: body.rel }) });
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.message : String(e), state: loadDeskState(root) });
    }
    return;
  }

  if (url.pathname === '/api/invite') {
    try {
      const agent = body.agent?.trim() || 'claude';
      const text = body.text?.trim();
      const from = body.from?.trim();
      const opener = text
        ? {
            who: from && from !== 'human' ? talkWho(from) : '我',
            windowId: from && from !== 'human' ? from : 'human',
            llm: from && from !== 'human' ? readHarnessBrain(from) || undefined : undefined,
            text,
          }
        : undefined;
      pullIntoTalk(root, agent, opener);
      send(res, 200, { ok: true, state: loadDeskState(root, { side: body.side, rel: body.rel }) });
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.message : String(e), state: loadDeskState(root) });
    }
    return;
  }

  if (url.pathname === '/api/open-talk') {
    try {
      const opened = openTalkWindow(root, body.agent?.trim() || 'claude');
      send(res, 200, { ok: true, opened, state: loadDeskState(root, { side: body.side, rel: body.rel }) });
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.message : String(e), state: loadDeskState(root) });
    }
    return;
  }

  if (url.pathname === '/api/talk-task') {
    send(res, 200, {
      ok: true,
      task: lastHumanText(root),
      state: loadDeskState(root, { side: body.side, rel: body.rel }),
    });
    return;
  }

  if (url.pathname === '/api/init') {
    try {
      const adopted = adoptProject(root);
      rememberRoot(adopted);
      send(res, 200, { ok: true, root: adopted, state: loadDeskState(adopted, { side: body.side, rel: body.rel }) });
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.message : String(e), state: loadDeskState(root) });
    }
    return;
  }

  const map: Record<string, string[]> = {
    '/api/start': ['start', body.task ?? ''],
    '/api/handoff': ['handoff'],
    '/api/merge': body.force ? ['merge', '--force'] : ['merge'],
    '/api/abandon': body.force ? ['abandon', '--force'] : ['abandon'],
    '/api/open': openArgs,
  };

  if (url.pathname === '/api/reveal') {
    const st = loadDeskState(root, { side: body.side, rel: body.rel });
    let target = st.worktree && st.worktreeExists ? st.worktree : root;
    if (body.file) {
      const dir = resolveDeskDir(st.root, st.fileSide, st.fileRel, st.worktree);
      const next = path.resolve(dir, body.file);
      if (!insideDir(dir, next)) {
        send(res, 400, { error: '文件不在这个文件夹里' });
        return;
      }
      target = next;
    } else if (body.side) {
      target = st.filePath;
    }
    spawnSync('open', [target], { encoding: 'utf8' });
    send(res, 200, { ok: true, opened: target, state: st });
    return;
  }

  if (url.pathname === '/api/run') {
    if (!body.agent?.trim()) {
      send(res, 400, { error: '先点一扇窗口' });
      return;
    }
    const runArgs = [CLI, 'run', body.agent.trim()];
    if (body.llm?.trim()) runArgs.push('--llm', body.llm.trim());
    const child = spawn(process.execPath, runArgs, { cwd: root, detached: true, stdio: 'ignore' });
    child.unref();
    send(res, 200, { ok: true, state: loadDeskState(root, { side: body.side, rel: body.rel }) });
    return;
  }

  const args = map[url.pathname];
  if (!args) {
    send(res, 404, { error: '没有这个接口' });
    return;
  }
  if (url.pathname === '/api/start' && !body.task?.trim()) {
    send(res, 400, { error: '先写下要做什么' });
    return;
  }
  if (url.pathname === '/api/open' && !body.agent?.trim()) {
    send(res, 400, { error: '先点一扇窗口' });
    return;
  }

  const r = runRelay(root, args, url.pathname === '/api/handoff' ? 780_000 : 180_000);
  send(res, r.code === 0 ? 200 : 400, {
    ok: r.code === 0,
    out: r.out,
    state: loadDeskState(root, { side: body.side, rel: body.rel }),
  });
}

export function createUiServer(): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      try {
        const host = req.headers.host ?? '127.0.0.1';
        const url = new URL(req.url ?? '/', `http://${host}`);
        if (url.pathname.startsWith('/api/')) {
          await handleApi(req, res, url);
          return;
        }
        const rel = url.pathname === '/' ? '/index.html' : url.pathname;
        const file = path.join(PUBLIC, path.normalize(rel).replace(/^[/\\]+/, ''));
        if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          send(res, 404, '找不到页面', 'text/plain; charset=utf-8');
          return;
        }
        send(res, 200, fs.readFileSync(file, 'utf8'), mime(file));
      } catch (e) {
        send(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    })();
  });
}

export function listenUi(port: number): Promise<{ port: number; url: string }> {
  const server = createUiServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ port: p, url: `http://127.0.0.1:${p}/` });
    });
  });
}

export function defaultUiRoot(explicit?: string): string {
  if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);
  const last = lastRoot();
  if (last) return last;
  return process.cwd();
}

export function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawnSync(cmd, [url], { encoding: 'utf8', shell: process.platform === 'win32' });
}
