import { spawn } from 'node:child_process';
import { RelayError } from './errors';

/**
 * 能让命令在沙箱外跑的设置（成员的启动命令、讨论命令、接口地址和密钥，检查命令，权限改成不限制），
 * 网页接口改之前弹一个系统确认框，人点「允许」才改。
 * 本机程序都能像网页一样调接口；2026-10-07 实测 Cursor 的沙箱连得到本机端口，
 * 沙箱里的 AI 能借接口在沙箱外跑命令。系统确认框它点不了。
 * RELAY_CONFIRM=yes / no 给测试用（接口进程的环境，沙箱里的 AI 改不到）。
 * 只在 macOS 上弹；别的系统照旧（手册里写明）。
 */
export async function askUser(text: string, en = false): Promise<boolean> {
  const fixed = process.env.RELAY_CONFIRM;
  if (fixed === 'yes') return true;
  if (fixed === 'no') return false;
  if (process.platform !== 'darwin') return true;
  const allow = en ? 'Allow' : '允许';
  const cancel = en ? 'Cancel' : '取消';
  const title = en ? 'RelayDesk' : '接力台';
  // 文字从参数传进去，不拼进脚本（命令里的引号、反斜杠原样显示，也改不了脚本）
  const script = [
    'on run argv',
    'activate',
    `display dialog (item 1 of argv) with title "${title}" buttons {"${cancel}", "${allow}"} default button "${cancel}" cancel button "${cancel}" with icon caution giving up after 120`,
    'return button returned of result',
    'end run',
  ];
  return new Promise((resolve) => {
    let out = '';
    const p = spawn('osascript', [...script.flatMap((l) => ['-e', l]), text], { stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => (out += d));
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0 && out.trim() === allow));
  });
}

export async function mustAllow(text: string, en = false): Promise<void> {
  if (!(await askUser(text, en))) throw new RelayError(en ? 'Not allowed; nothing changed.' : '没有允许，没改。', 'not-allowed');
}
