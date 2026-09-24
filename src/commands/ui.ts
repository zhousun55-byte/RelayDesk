import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Command } from 'commander';
import fs from 'node:fs';
import { augmentPath } from '../core/launch';
import { lastProject, rememberProject } from '../core/memory';
import { stopAllGo } from '../ops/go';
import { unwatchAll } from '../ops/watch';
import { createServer, listen } from '../server/server';
import { ok, warn } from './print';
import { findRoot } from './relay';

function openBrowser(url: string): void {
  if (process.env.RELAY_TERMINAL === 'off') return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawnSync(cmd, [url], { stdio: 'ignore' });
}

async function pingRelay(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    const j = (await res.json()) as { app?: string };
    return j.app === 'relay';
  } catch {
    return false;
  }
}

export function uiCommand(): Command {
  return new Command('ui')
    .description('打开接力台（网页）：看进度、派人接着做、全自动、复核、退回、群聊')
    .argument('[文件夹]', '要打开的项目（默认：当前文件夹；在家目录启动时用上次打开的）')
    .option('-p, --port <端口>', '端口', '7388')
    .option('--no-open', '只启动，不自动打开浏览器')
    .action(async (folder: string | undefined, opts: { port: string; open: boolean }) => {
      augmentPath();
      let dir = folder ? path.resolve(folder) : findRoot();
      if (!folder && !fs.existsSync(path.join(dir, '.relay', 'journal.jsonl')) && lastProject()) dir = lastProject()!;
      if (fs.existsSync(path.join(dir, '.relay', 'journal.jsonl'))) rememberProject(dir);
      const q = `?dir=${encodeURIComponent(dir)}`;
      const wanted = Number(opts.port) || 7388;

      for (let port = wanted; port < wanted + 10; port++) {
        const stop = () => {
          stopAllGo();
          unwatchAll();
          server.close();
          // 给正在干活的工具一点时间收尾（runner 会先发 SIGTERM）。
          setTimeout(() => process.exit(0), 300);
        };
        const server = createServer({ defaultDir: dir, autoDetect: true, watch: true, onQuit: stop });
        try {
          const actual = await listen(server, port);
          const url = `http://127.0.0.1:${actual}/${q}`;
          ok(`接力台已启动：${url}`);
          console.log('  关掉这个窗口（或按 Ctrl-C），或在网页「设置」里点「关闭接力台」，接力台就停了。');
          if (opts.open !== false) openBrowser(url);
          process.on('SIGINT', stop);
          process.on('SIGTERM', stop);
          return;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code !== 'EADDRINUSE') throw e;
          if (await pingRelay(port)) {
            const url = `http://127.0.0.1:${port}/${q}`;
            ok(`接力台已经在运行：${url}`);
            if (opts.open !== false) openBrowser(url);
            return;
          }
          warn(`端口 ${port} 被别的程序占着，换一个试试……`);
        }
      }
      throw new Error(`${wanted}–${wanted + 9} 的端口都被占了，用 --port 指定一个。`);
    });
}
