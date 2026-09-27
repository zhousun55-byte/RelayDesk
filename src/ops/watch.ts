import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '../core/errors';
import { trackAndGate, type TrackResult } from './track';

/**
 * 盯着接入过的文件夹：文件一有变化（停下来几秒后）就对一次账；另外每分钟对一次，
 * 好发现「改到一半没动静了」的棒。接力台开着的时候一直在盯（网页、桌面小程序都算开着）。
 */

const DEBOUNCE_MS = Number(process.env.RELAY_WATCH_DEBOUNCE_MS ?? 4000);
const MAX_WAIT_MS = 30_000;
const TICK_MS = Number(process.env.RELAY_WATCH_TICK_MS ?? 60_000);

/** 这些变化不用管：git 自己的、依赖、接力台自己写的。 */
export function ignoredPath(rel: string): boolean {
  const p = rel.split(path.sep).join('/');
  if (p === '.git' || p.startsWith('.git/') || p.includes('/.git/')) return true;
  if (p.startsWith('node_modules/') || p.includes('/node_modules/') || p.endsWith('.DS_Store')) return true;
  if (p === '.relay' || p.startsWith('.relay/')) {
    return !(p === '.relay/任务.md' || p.startsWith('.relay/交接/') || (p.startsWith('.relay/复核/') && p.endsWith('.md')));
  }
  return false;
}

export class ProjectWatcher {
  private watcher: fs.FSWatcher | null = null;
  private tick: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private firstAt = 0;
  private running = false;
  private again = false;
  private closed = false;
  lastError: string | null = null;

  constructor(
    readonly root: string,
    private readonly onChange: (root: string, r: TrackResult) => void = () => undefined
  ) {}

  start(): void {
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_ev, name) => {
        if (name && ignoredPath(String(name))) return;
        this.poke();
      });
      this.watcher.on('error', (e) => {
        this.lastError = errorMessage(e);
      });
    } catch (e) {
      // 有的系统不支持整棵目录一起盯：退回到每分钟对一次账。
      this.lastError = errorMessage(e);
    }
    this.tick = setInterval(() => void this.run(), TICK_MS);
    this.tick.unref?.();
    void this.run();
  }

  /** 有变化：等它停下来几秒再对账（最多等 30 秒）。 */
  poke(): void {
    if (this.closed) return;
    const now = Date.now();
    if (!this.timer) this.firstAt = now;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, this.firstAt + MAX_WAIT_MS - now));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, wait);
    this.timer.unref?.();
  }

  async run(): Promise<void> {
    if (this.closed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      if (!fs.existsSync(path.join(this.root, '.relay', 'journal.jsonl'))) return;
      const r = await trackAndGate(this.root);
      this.lastError = null;
      if (r.changed) this.onChange(this.root, r);
    } catch (e) {
      this.lastError = errorMessage(e);
    } finally {
      this.running = false;
      if (this.again && !this.closed) {
        this.again = false;
        this.poke();
      }
    }
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    if (this.tick) clearInterval(this.tick);
    if (this.timer) clearTimeout(this.timer);
  }
}

const watchers = new Map<string, ProjectWatcher>();

export function watchProject(root: string, onChange?: (root: string, r: TrackResult) => void): ProjectWatcher {
  const key = path.resolve(root);
  let w = watchers.get(key);
  if (!w) {
    w = new ProjectWatcher(key, onChange);
    watchers.set(key, w);
    w.start();
  }
  return w;
}

export function unwatchAll(): void {
  for (const w of watchers.values()) w.close();
  watchers.clear();
}

export function watching(root: string): ProjectWatcher | null {
  return watchers.get(path.resolve(root)) ?? null;
}
