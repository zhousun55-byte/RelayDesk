import { spawn } from 'node:child_process';
import { checkEnv } from './env';
import type { RelayConfig } from './types';

export interface GateResult {
  status: 'pass' | 'fail';
  command: string;
  /** 输出的最后一段（失败时给人看原因）。 */
  detail: string;
}

export const GATE_NONE = '(未配置)';

/**
 * 跑项目的检查命令（门禁）。异步执行，不会卡住接力台。
 * 没配置 = 通过（并写明没配置）。超时算失败。
 * 环境里去掉像密钥的变量（checkEnv）：检查命令是项目里写的，拿不到各家模型的密钥。
 */
export function runGate(worktree: string, cfg: RelayConfig, timeoutMs = 10 * 60_000): Promise<GateResult> {
  const cmd = cfg.gate.command.trim();
  if (!cmd) return Promise.resolve({ status: 'pass', command: GATE_NONE, detail: '没有配置检查命令，按通过处理。' });
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { cwd: worktree, env: checkEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    const keep = (c: string) => {
      out = (out + c).slice(-8000);
    };
    // 按字符读：汉字被切在两次读取之间也不会变成乱码。
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* 已经结束 */
      }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ status: 'fail', command: cmd, detail: `启动失败：${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const tail = out.trim().slice(-2000);
      if (timedOut) resolve({ status: 'fail', command: cmd, detail: `超过 ${Math.round(timeoutMs / 60000)} 分钟没跑完，已停止。\n${tail}` });
      else if (code === 0) resolve({ status: 'pass', command: cmd, detail: tail || '（没有输出）' });
      else resolve({ status: 'fail', command: cmd, detail: tail || `退出码 ${code}` });
    });
  });
}
