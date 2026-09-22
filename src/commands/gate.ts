import fs from 'node:fs';
import { Command } from 'commander';
import { repoRootAt } from '../core/git';
import { runGate } from '../core/gate';
import { loadRelayConfig } from '../core/config';
import { appendEvent, lastSegmentRun, readEvents } from '../core/journal';
import { requireSession } from '../core/session';

/** 调试入口：单独跑门禁（正常流程由 relay handoff 内部执行，勿依赖此命令）。 */
export function gateCommand(): Command {
  const cmd = new Command('gate');
  cmd.description('单独运行门禁命令（调试用；正常流程走 relay handoff）');
  cmd.action(() => {
    const root = repoRootAt(process.cwd());
    const cfg = loadRelayConfig(root);
    const s = requireSession(root);
    const wt = s.worktree;
    if (!fs.existsSync(wt)) throw new Error(`worktree 不存在：${wt}`);

    const gate = runGate(wt, cfg);
    const events = readEvents(wt);
    const agent = lastSegmentRun(events)?.agent ?? 'framework';
    appendEvent(wt, {
      ts: new Date().toISOString(),
      type: 'gate',
      agent,
      status: gate.status,
      command: gate.command,
      ...(gate.status === 'fail' && gate.detail ? { detail: gate.detail.slice(0, 2000) } : {}),
      worktree: wt,
    });
    console.log(`门禁：${gate.status === 'pass' ? '通过' : '未通过'}（${gate.command}）`);
    if (gate.detail) console.log(gate.detail);
  });
  return cmd;
}
