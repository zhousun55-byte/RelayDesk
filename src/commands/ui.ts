import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Command } from 'commander';
import fs from 'node:fs';
import { errorMessage } from '../core/errors';
import { augmentPath } from '../core/launch';
import { lastProject, rememberProject } from '../core/memory';
import { anyTalkBusy } from '../core/talk';
import { voteBusy } from '../core/vote';
import { goBusy, reapLeftover, stopAllGo } from '../ops/go';
import { liveProjects } from '../ops/init';
import { keeperMode, markStopped, watchBuild } from '../ops/keeper';
import { gateBusy } from '../ops/track';
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

/**
 * 后台的活（盯文件夹对账、定时器、子进程回调）出了没接住的错，或者有没接住的 Promise：
 * 记一行到日志，接力台照常开着。本地就一个用户，服务活着（哪怕这一次没干成）永远好过整个退出、丢掉正在看的页面。
 * 关服务用的信号（SIGINT 之类）不在这里管。
 */
let guarded = false;
function guardProcess(): void {
  if (guarded) return;
  guarded = true;
  process.on('uncaughtException', (e) => warn(`后台出错（接力台继续开着）：${errorMessage(e)}`));
  process.on('unhandledRejection', (e) => warn(`后台有没接住的错（接力台继续开着）：${errorMessage(e)}`));
}

export function uiCommand(): Command {
  return new Command('ui')
    .description('打开接力台（网页）：看进度、派人接着做、全自动、复核、退回、群聊')
    .argument('[文件夹]', '要打开的项目（默认：当前文件夹；在家目录启动时用上次打开的）')
    .option('-p, --port <端口>', '端口', '7388')
    .option('--no-open', '只启动，不自动打开浏览器')
    .action(async (folder: string | undefined, opts: { port: string; open: boolean }) => {
      augmentPath();
      guardProcess();
      let dir = folder ? path.resolve(folder) : findRoot();
      if (!folder && !fs.existsSync(path.join(dir, '.relay', 'journal.jsonl')) && lastProject()) dir = lastProject()!;
      if (fs.existsSync(path.join(dir, '.relay', 'journal.jsonl'))) rememberProject(dir);
      const q = `?dir=${encodeURIComponent(dir)}`;
      const wanted = Number(opts.port) || 7388;
      // 由「接力台」小程序拉起的：它在后台看着，退出了会重新拉起（见 ops/keeper.ts）。
      const keeper = keeperMode();

      for (let port = wanted; port < wanted + 10; port++) {
        let stopping = false;
        const stop = () => {
          if (stopping) return;
          stopping = true;
          // 先叫停调度，等正在干活的工具真正结束、这一棒记好账再退（最多等 10 秒：先发 SIGTERM，5 秒后没停就强制结束）。
          // 不等就退的话，工具会在接力台退出之后接着改文件，没人记账。
          void stopAllGo(10_000).finally(() => {
            unwatchAll();
            server.close();
            process.exit(0);
          });
        };
        // 在网页上点「关闭」：留个记号，小程序就不再把它拉起来。
        const quit = () => {
          if (keeper) markStopped();
          stop();
        };
        const server = createServer({ defaultDir: dir, autoDetect: true, watch: true, onQuit: quit });
        try {
          const actual = await listen(server, port);
          const url = `http://127.0.0.1:${actual}/${q}`;
          ok(`接力台已启动：${url}`);
          if (keeper) {
            console.log('  「接力台」小程序在后台看着：意外退出或者有了新版本，会自己重新启动。');
            // 编译出了新版：手上没活时自己退出，小程序几秒内用新版重新拉起。
            watchBuild(
              () => {
                warn('接力台有新版本，重新启动……');
                stop();
              },
              { idle: () => !goBusy() && !anyTalkBusy() && !voteBusy() && !gateBusy(), intervalMs: Number(process.env.RELAY_BUILD_WATCH_MS) || undefined }
            );
          } else console.log('  关掉这个窗口（或按 Ctrl-C），或在网页「设置」里点「关闭接力台」，接力台就停了。');
          if (opts.open !== false) openBrowser(url);
          // 上次接力台被关掉时还在跑的工具：结束掉（不然它会接着改文件，没人记账）。
          for (const r of liveProjects()) {
            if (reapLeftover(r)) warn(`上次接力台关掉时还在跑的工具已经结束：${r}`);
          }
          process.on('SIGINT', stop);
          process.on('SIGTERM', stop);
          // 关掉终端窗口时收到的是 SIGHUP：一样先收尾再退。终端没了，往里打字会出错，出错就不管。
          process.on('SIGHUP', stop);
          for (const s of [process.stdout, process.stderr]) s.on('error', () => undefined);
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
