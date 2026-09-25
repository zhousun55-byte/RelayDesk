import fs from 'node:fs';
import path from 'node:path';
import { relayHome } from '../core/paths';

/**
 * 「接力台」小程序在后台看着的接力台（小程序拉起时带 RELAY_KEEPER=1）：
 * - 小程序没有图标挂在桌面和程序坞上，登录电脑时自己启动；接力台意外退出，它几秒内重新拉起；
 * - 你在网页上点了「关闭」：留一个记号，小程序看到就不再拉起、自己也退出（下次打开「接力台」或重新登录时清掉）；
 * - 编译出了新版：等手上没活（调度、群聊、投票、检查都停了）就自己退出，小程序用新版重新拉起，网页自己刷新。
 */

export function keeperMode(): boolean {
  return process.env.RELAY_KEEPER === '1';
}

/** 「你在网页上点了关闭」的记号（启动脚本 --check 看到它就告诉小程序别再拉起）。 */
export function stoppedMarker(): string {
  return path.join(relayHome(), 'ui-stopped');
}

export function markStopped(): void {
  try {
    fs.mkdirSync(relayHome(), { recursive: true });
    fs.writeFileSync(stoppedMarker(), `${new Date().toISOString()}\n`);
  } catch {
    /* 写不了记号：小程序会把它重新拉起，最多是没关掉 */
  }
}

/** 编译出来的命令行入口（dist/src/cli.js）。整个 dist 换成新编译的，这个文件就变了。 */
const CLI_FILE = path.resolve(__dirname, '..', 'cli.js');

/** 这份编译结果的记号：换了新编译结果就变；文件不在（正在编译）是空串。 */
export function buildStamp(file = CLI_FILE): string {
  try {
    const st = fs.statSync(file);
    return `${Math.round(st.mtimeMs)}-${st.size}`;
  } catch {
    return '';
  }
}

/**
 * 每隔一会儿看一眼编译结果：变了、连着两次看到的一样（编译完了）、手上又没活，就调 onUpdate（只调一次）。
 * 返回停止函数。
 */
export function watchBuild(onUpdate: () => void, opts: { idle: () => boolean; file?: string; intervalMs?: number }): () => void {
  const file = opts.file ?? CLI_FILE;
  const first = buildStamp(file);
  let last = first;
  const timer = setInterval(() => {
    const now = buildStamp(file);
    const settled = now === last;
    last = now;
    if (!now || now === first || !settled || !opts.idle()) return;
    clearInterval(timer);
    onUpdate();
  }, opts.intervalMs ?? 15_000);
  timer.unref();
  return () => clearInterval(timer);
}
