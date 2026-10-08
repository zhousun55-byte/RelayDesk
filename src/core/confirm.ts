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

type Dialog = (text: string, en: boolean) => Promise<boolean>;

/**
 * 放进确认框的一段命令、地址：换行显示成 ⏎（不能在框里另起几行，假装是接力台说的「可以放心允许」），
 * 控制字符、改文字方向的字符换成空格，太长截断。
 */
export function shownValue(s: string, max = 300): string {
  const t = s
    .replace(/\r\n|\r|\n/g, ' ⏎ ')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ');
  return t.length > max ? `${t.slice(0, max)}…（共 ${t.length} 个字）` : t;
}

// 文字从参数传进去，不拼进脚本（命令里的引号、反斜杠原样显示，也改不了脚本）
const osaDialog: Dialog = (text, en) => {
  const allow = en ? 'Allow' : '允许';
  const cancel = en ? 'Cancel' : '取消';
  const title = en ? 'RelayDesk' : '接力台';
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
};

let dialog: Dialog = osaDialog;
let pending = false;
let quietUntil = 0;
/** 点了取消（或 120 秒没人点）之后这么久不再弹：别的程序连着发请求刷框，人烦了容易顺手点允许。 */
const QUIET_MS = 60_000;

/** 测试用：换掉弹框（null 换回系统的），顺便清掉「正在等」和「刚取消过」。 */
export function setDialogForTest(d: Dialog | null): void {
  dialog = d ?? osaDialog;
  pending = false;
  quietUntil = 0;
}

export async function mustAllow(text: string, en = false): Promise<void> {
  const no = () => new RelayError(en ? 'Not allowed; nothing changed.' : '没有允许，没改。', 'not-allowed');
  const fixed = process.env.RELAY_CONFIRM;
  if (fixed === 'yes') return;
  if (fixed === 'no') throw no();
  if (process.platform !== 'darwin' && dialog === osaDialog) return;
  // 一次只弹一个框
  if (pending) throw new RelayError(en ? 'A confirmation dialog is already waiting; answer that one first. Nothing changed.' : '已经有一个确认框在等你点，先处理那一个。这次没改。', 'not-allowed');
  if (Date.now() < quietUntil) throw new RelayError(en ? 'You just declined a change like this; try again in a minute. Nothing changed.' : '刚才没有允许，一分钟内不再弹框，过一会再改。这次没改。', 'not-allowed');
  const footer = en ? '\n\nIf you did not just change this yourself in RelayDesk, click Cancel.' : '\n\n不是你刚在接力台里改的，点「取消」。';
  pending = true;
  let ok = false;
  try {
    ok = await dialog(text + footer, en);
  } finally {
    pending = false;
  }
  if (!ok) {
    quietUntil = Date.now() + QUIET_MS;
    throw no();
  }
}
