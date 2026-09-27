import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { loadDetected, type DetectReport } from '../core/detect';
import { RelayError } from '../core/errors';

/**
 * 自动识别这台电脑上的 AI 工具：接力台一打开就在后台识别一次（没识别过、或者上次是 12 小时以前）。
 * 识别要十几秒，而且一路同步地问各家工具（版本、登录状态）：放在子进程里跑（relay detect --json），
 * 接力台自己不卡——卡住的时候桌面小程序会以为接力台停了，网页、终端界面也会没反应。
 */

export interface DetectResult {
  report: DetectReport | null;
  changes: string[];
}

let running: Promise<DetectResult> | null = null;

function detectInChild(offline: boolean): Promise<DetectResult> {
  return new Promise((resolve, reject) => {
    const cli = path.join(__dirname, '..', 'cli.js');
    const child = spawn(process.execPath, [cli, 'detect', '--json', ...(offline ? ['--offline'] : [])], { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'] });
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

function track(run: Promise<DetectResult>): Promise<DetectResult> {
  running = run;
  void run
    .catch(() => undefined)
    .finally(() => {
      if (running === run) running = null;
    });
  return run;
}

/** 现在正在识别。 */
export function detecting(): boolean {
  return !!running;
}

/** 马上识别一次（正在识别就等它完了再来一次，拿最新的）。 */
export async function detectNow(offline = false): Promise<DetectResult> {
  if (running) await running.catch(() => undefined);
  return track(detectInChild(offline));
}

/** 没识别过、或者上次是 12 小时以前：在后台识别一次，返回这一次（不用识别返回 null）。 */
export function ensureDetected(): Promise<DetectResult> | null {
  if (running || process.env.RELAY_AUTODETECT === 'off') return null;
  const last = loadDetected();
  if (last && Date.now() - new Date(last.at).getTime() < 12 * 3600_000) return null;
  return track(detectInChild(false));
}
