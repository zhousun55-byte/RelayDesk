import { spawnSync } from 'node:child_process';
import type { RelayConfig } from './types';

export interface GateResult {
  status: 'pass' | 'fail';
  command: string;
  detail: string;
}

/** 项目自定义门禁（空 = 未配置，按通过处理并注明；merge 前请自行确认质量）。 */
export function runGate(worktree: string, cfg: RelayConfig): GateResult {
  const cmd = (cfg.gate?.command ?? '').trim();
  if (cmd === '') {
    return { status: 'pass', command: '(未配置)', detail: '未配置门禁命令，按通过处理' };
  }
  const r = spawnSync('sh', ['-c', cmd], { cwd: worktree, encoding: 'utf8', timeout: 600_000 });
  const tail = ((r.stdout ?? '') + '\n' + (r.stderr ?? '')).trim().slice(-2000);
  if (r.status === 0) return { status: 'pass', command: cmd, detail: tail || '（无输出）' };
  return { status: 'fail', command: cmd, detail: tail || r.error?.message || `退出码 ${r.status}` };
}
