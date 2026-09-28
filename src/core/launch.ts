import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 给 sh 用的单引号转义。 */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 把命令模板里的 {{名字}} 换成转义好的值。模板里给占位符加了引号（"{{dir}}"）也照样对：
 * 连引号一起替换，不会变成 "'路径'"。
 */
export function fillTemplate(cmd: string, vars: Record<string, string>): string {
  return cmd.replace(/(["']?)\{\{(\w+)\}\}\1/g, (whole, _q: string, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? shq(vars[key]) : whole
  );
}

/** 简单的 sh 分词（认单双引号和反斜杠），只用来找命令名和 open -a 的应用名。 */
export function shellWords(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

export interface CommandCheck {
  ok: boolean;
  /** 找到的可执行文件或 App。 */
  found?: string;
  problem?: string;
}

function whichSh(bin: string): string | null {
  const r = spawnSync('sh', ['-c', `command -v ${shq(bin)}`], { encoding: 'utf8', timeout: 5000 });
  const out = (r.stdout ?? '').trim();
  return r.status === 0 && out ? out.split('\n')[0] : null;
}

/** 检查一条启动命令能不能用：命令在不在 PATH；open -a 的 App 装没装；cursor 是不是被 cursor-agent 顶替了。 */
export function checkCommand(cmd: string): CommandCheck {
  const words = shellWords(cmd.replace(/\{\{\w+\}\}/g, 'X'));
  if (words.length === 0) return { ok: false, problem: '命令是空的。' };
  const bin = words[0];
  if (bin === 'open' && process.platform === 'darwin') {
    const ai = words.indexOf('-a');
    const app = ai >= 0 ? words[ai + 1] : null;
    if (!app) return { ok: true, found: 'open' };
    const r = spawnSync('open', ['-Ra', app], { encoding: 'utf8', timeout: 8000 });
    return r.status === 0 ? { ok: true, found: `${app}.app` } : { ok: false, problem: `找不到叫「${app}」的 App。看看「应用程序」文件夹里它的准确名字。` };
  }
  const found = bin.includes('/') ? (fs.existsSync(bin) ? bin : null) : whichSh(bin);
  if (!found) return { ok: false, problem: `找不到命令「${bin}」。它装了吗？装在终端能直接运行的位置了吗？` };
  if (bin === 'cursor') {
    let real = found;
    try {
      real = fs.realpathSync(found);
    } catch {
      /* 保持原样 */
    }
    if (/cursor-agent/.test(real)) {
      return { ok: false, found, problem: '这台电脑上的 cursor 命令其实是 cursor-agent（Cursor 的命令行 AI），打不开 Cursor 编辑器。改成：open -a Cursor {{dir}}' };
    }
  }
  return { ok: true, found };
}

export interface OpenerResult {
  code: number | null;
  output: string;
  /** 超时还没退出（有的打开命令会一直挂着），当作已经打开。 */
  lingering: boolean;
}

/** 跑一条「打开」命令：等它退出（open / cursor 这类一两秒就返回），最多等 timeoutMs，然后放手不管。 */
export function runOpener(cmd: string, cwd: string, timeoutMs = 15_000): Promise<OpenerResult> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (c: string) => {
      output = (output + c).slice(-4000);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    let settled = false;
    const finish = (r: OpenerResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      finish({ code: null, output: output.trim(), lingering: true });
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ code: -1, output: err.message, lingering: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code: code ?? -1, output: output.trim(), lingering: false });
    });
  });
}

/** 能跑起来的第一个命令（Linux 上剪贴板、选文件夹的工具各家桌面不一样）。 */
function firstBin(cands: string[][]): string[] | null {
  for (const c of cands) if (spawnSync(c[0], ['--version'], { timeout: 3000, stdio: 'ignore' }).error === undefined) return c;
  return null;
}

/** 复制到剪贴板：macOS pbcopy，Windows 用 PowerShell，Linux 用 wl-copy / xclip / xsel。RELAY_CLIPBOARD=off 时不动剪贴板（测试用）。 */
export function copyToClipboard(text: string): boolean {
  if (process.env.RELAY_CLIPBOARD === 'off') return false;
  const cmd =
    process.platform === 'darwin'
      ? ['pbcopy']
      : process.platform === 'win32'
        ? ['powershell.exe', '-NoProfile', '-Command', '$input | Set-Clipboard']
        : firstBin([['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']]);
  if (!cmd) return false;
  const r = spawnSync(cmd[0], cmd.slice(1), { input: text, timeout: 5000 });
  return r.status === 0;
}

/** 在系统的文件管理器里打开一个文件夹 / 选中一个文件：访达、资源管理器，Linux 打开它所在的文件夹。 */
export function reveal(target: string): boolean {
  if (process.env.RELAY_TERMINAL === 'off') return false;
  const isFile = fs.existsSync(target) && fs.statSync(target).isFile();
  if (process.platform === 'darwin') return spawnSync('open', isFile ? ['-R', target] : [target], { timeout: 10_000 }).status === 0;
  // explorer 打开了也常常返回 1：没报错就算打开了
  if (process.platform === 'win32') return !spawnSync('explorer.exe', isFile ? [`/select,${target}`] : [target], { timeout: 10_000 }).error;
  const r = spawnSync('xdg-open', [isFile ? path.dirname(target) : target], { timeout: 10_000, stdio: 'ignore' });
  return !r.error && r.status === 0;
}

/** 这台电脑上弹选文件夹对话框的命令；没有就是 null（网页上改成自己贴路径）。 */
function pickerCommand(prompt: string): string[] | null {
  if (process.platform === 'darwin') return ['osascript', '-e', `POSIX path of (choose folder with prompt "${prompt.replace(/["\\]/g, '')}")`];
  if (process.platform === 'win32')
    return [
      'powershell.exe',
      '-NoProfile',
      '-STA',
      '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.ShowNewFolderButton = $true; $d.Description = '${prompt.replace(/'/g, '')}'; if ($d.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $d.SelectedPath }`,
    ];
  const bin = firstBin([['zenity'], ['kdialog'], ['qarma']]);
  if (!bin) return null;
  return bin[0] === 'kdialog' ? ['kdialog', '--getexistingdirectory', os.homedir(), '--title', prompt] : [bin[0], '--file-selection', '--directory', `--title=${prompt}`];
}

/**
 * 让用户选一个文件夹（系统自己的对话框）。异步：对话框开着的时候，接力台照样响应别的请求。
 * 返回 null 是没选；这台电脑弹不出对话框时抛 no-picker。
 */
export function chooseFolder(prompt = '选一个项目文件夹'): Promise<string | null> {
  const cmd = pickerCommand(prompt);
  if (!cmd) return Promise.reject(Object.assign(new Error('这台电脑弹不出选文件夹的对话框'), { code: 'no-picker' }));
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => (out += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const p = out.trim().replace(/[\\/]$/, '');
      resolve(code === 0 && p ? p : null);
    });
  });
}

export { augmentPath } from './env';
