import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { which } from './env';

/** 进程还在不在（权限不够也算在）。 */
export function pidAlive(pid: number | undefined | null): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const isWin = () => process.platform === 'win32';

/** 一条 shell 命令（检查命令、自定义讨论命令、打开命令）：Mac/Linux 交给 sh，Windows 交给 cmd.exe。 */
export function shellArgv(cmd: string, win = isWin()): string[] {
  return win ? [process.env.ComSpec || 'cmd.exe', '/d', '/s', '/c', `"${cmd}"`] : ['sh', '-c', cmd];
}

/**
 * npm 在 Windows 上装的命令是个 .cmd 小脚本，转手去跑包里的 .js（或自带的 .exe）。读出它跑的是哪个文件。
 * 直接跑那个文件：.cmd 只能经 cmd.exe 起，多行的提示词过不去。
 */
export function npmShimTarget(file: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const m = text.match(/"%(?:dp0%|~dp0)\\([^"%]+)"\s*%\*/i);
  return m ? path.join(path.dirname(file), ...m[1].split('\\')) : null;
}

export interface Exec {
  file: string;
  args: string[];
  /** 参数已经按 cmd.exe 的规矩写好了，原样交给它（Node 不再加引号）。 */
  verbatim: boolean;
}

/** 真正要起的程序和参数。Mac/Linux 原样；Windows 上按 PATHEXT 找到 .exe / .cmd，npm 装的 .cmd 直接跑它指向的文件，别的 .cmd/.bat 经 cmd.exe。 */
export function resolveExec(argv: string[], win = isWin()): Exec {
  const [bin, ...args] = argv;
  if (!win) return { file: bin, args, verbatim: false };
  if (/^cmd(\.exe)?$/i.test(path.basename(bin))) return { file: bin, args, verbatim: true };
  const found = which(bin, true);
  if (!found || !/\.(cmd|bat)$/i.test(found)) return { file: found ?? bin, args, verbatim: false };
  const target = npmShimTarget(found);
  if (target && /\.exe$/i.test(target)) return { file: target, args, verbatim: false };
  if (target) {
    const own = path.join(path.dirname(found), 'node.exe');
    return { file: fs.existsSync(own) ? own : process.execPath, args: [target, ...args], verbatim: false };
  }
  const q = (a: string) => `"${a.replace(/"/g, '""')}"`;
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[found, ...args].map(q).join(' ')}"`], verbatim: true };
}

/**
 * 起一个工具或命令，让它连同自己起的子进程能被一起结束：Mac/Linux 上自成一个进程组；
 * Windows 没有进程组，结束时用 taskkill /T 连子进程一起。Windows 上不弹黑窗口。
 */
export function spawnTool(argv: string[], opts: SpawnOptions): ChildProcess {
  const e = resolveExec(argv);
  return spawn(e.file, e.args, { ...opts, detached: !isWin(), windowsHide: true, windowsVerbatimArguments: e.verbatim });
}

/** 结束 spawnTool 起的进程和它的子进程。Windows 上直接强制结束（命令行程序收不到「请退出」）。 */
export function killTree(pid: number | undefined, sig: 'SIGTERM' | 'SIGKILL'): void {
  if (!pid) return;
  if (isWin()) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
    return;
  }
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* 已经结束 */
    }
  }
}
