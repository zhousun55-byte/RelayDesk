import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { Command } from 'commander';
import { repoRootAt } from '../core/git';
import { loadRelayConfig } from '../core/config';
import { appendEvent } from '../core/journal';
import { acquireLock, releaseLock } from '../core/lock';
import { ONBOARD_HINT } from '../core/prompts';
import { loadRegistry } from '../core/registry';
import { requireSession } from '../core/session';
import { writeOnboardFor } from './onboard';

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 击杀 agent 的整组进程（kill(-pid)，负 pid = 进程组）。agent 可能再 spawn 孙进程，
 * 只杀直接 child 会留孤儿在放锁后继续写盘。组已不存在（agent 已退出）时静默返回 false。
 */
export function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals = 'SIGKILL'): boolean {
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** runShell / runWithStdin 的返回：exited 等退出码；child 供中断时整组击杀。 */
interface AgentProcess {
  exited: Promise<number>;
  child: ChildProcess;
}

function waitExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.on('error', (err) => {
      console.error(`启动失败：${err.message}`);
      resolve(-1);
    });
    child.on('close', (code) => resolve(code ?? -1));
  });
}

// detached: true → agent 独立进程组（stdio 仍 inherit，交互不受影响），
// 中断时才能 kill(-pid) 整组收掉孙进程，而不是只碰直接 child。
function runShell(cwd: string, full: string): AgentProcess {
  const child = spawn('sh', ['-c', full], { cwd, stdio: 'inherit', detached: true });
  return { child, exited: waitExit(child) };
}

function runWithStdin(cwd: string, full: string, input: string): AgentProcess {
  const child = spawn('sh', ['-c', full], { cwd, stdio: ['pipe', 'inherit', 'inherit'], detached: true });
  child.stdin.on('error', () => {
    /* agent 可能不接受 stdin，以退出码为准 */
  });
  child.stdin.write(input + '\n');
  child.stdin.end();
  return { child, exited: waitExit(child) };
}

export function runCommand(): Command {
  const cmd = new Command('run');
  // resume 只是别名（commander alias），禁止第二套逻辑
  cmd.alias('resume');
  cmd.description('在 worktree 里启动指定 CLI agent 接力干活，阻塞到进程退出（resume 为别名；App 客人用 relay open）');
  cmd.argument('<agent>', '注册表里的 agent 名（relay agents list 查看）');
  cmd.option('-f, --force', '存在未交接的 App 软锁时强行接管（覆盖会写进 journal）');
  cmd.option('--llm <name>', '窗口里正在用的模型（同一 App 换模型时用来区分）');
  cmd.action(async (agentName: string, opts: { force?: boolean; llm?: string }) => {
    const root = repoRootAt(process.cwd());
    const cfg = loadRelayConfig(root);
    const s = requireSession(root);
    if (!fs.existsSync(s.worktree)) {
      throw new Error(`worktree 不存在：${s.worktree}（可能已被清理）。可 relay abandon 收尾。`);
    }

    const reg = loadRegistry();
    const agent = reg.agents.find((a) => a.name === agentName);
    if (!agent) throw new Error(`注册表中没有 agent「${agentName}」。relay agents list 查看。`);
    if ((agent.kind ?? 'cli') === 'app') {
      throw new Error(`「${agentName}」是 App 客人（kind=app），不能用 relay run。请用 relay open ${agentName}。`);
    }

    // 先拿锁，再做任何有副作用的写入（写 ONBOARD、journal 记 run）：
    // 锁被拒时 journal 不能留下一条没有 exit 的 run 谎言。
    // --force 覆盖 App 软锁的事实随 run 事件写进 journal（审计痕迹）。
    const takeover = acquireLock(s.worktree, agent.name, { force: opts.force });

    try {
      // 协议一：先写 ONBOARD.md，启动只喂一句话（与 relay open 同一套上岗词）
      const onboardPath = writeOnboardFor(s.worktree, s, cfg);
      appendEvent(s.worktree, {
        ts: new Date().toISOString(),
        type: 'run',
        agent: agent.name,
        tier: agent.tier,
        ...(opts.llm?.trim() ? { llm: opts.llm.trim() } : {}),
        worktree: s.worktree,
        ...(takeover.overrode ? { overrode: takeover.overrode } : {}),
      });

      // Ctrl-C 语义：第一次把信号转发给 agent 的整组进程，继续等它自己收尾（正常记录 exit）；
      // 第二次先 SIGKILL 整组（进程先死），再记 exit=130、放锁、退出——放锁后绝无 agent 进程还在写盘。
      let proc: AgentProcess | null = null;
      let interrupts = 0;
      const onSignal = (sig: NodeJS.Signals): void => {
        interrupts += 1;
        if (interrupts === 1) {
          const forwarded = killProcessGroup(proc?.child.pid, sig);
          console.error(
            `收到 ${sig}：${forwarded ? '已转发给 agent 进程组，' : ''}等待 agent 进程结束` +
              '（再按一次将 SIGKILL 进程组、记录 exit=130 并强制退出）…'
          );
          return;
        }
        killProcessGroup(proc?.child.pid, 'SIGKILL');
        appendEvent(s.worktree, {
          ts: new Date().toISOString(),
          type: 'exit',
          agent: agent.name,
          tier: agent.tier,
          worktree: s.worktree,
          code: 130,
          quotaHint: false,
        });
        releaseLock(s.worktree);
        process.exit(130);
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);

      console.log(`已写入上岗词：${onboardPath}`);
      console.log(`启动 ${agent.name}（tier=${agent.tier}, prompt.mode=${agent.prompt.mode}）于 ${s.worktree}`);
      console.log('');

      let code: number;
      if (agent.prompt.mode === 'arg') {
        proc = runShell(s.worktree, `${agent.cmd} ${shq(ONBOARD_HINT)}`);
        code = await proc.exited;
      } else if (agent.prompt.mode === 'stdin') {
        proc = runWithStdin(s.worktree, agent.cmd, ONBOARD_HINT);
        code = await proc.exited;
      } else {
        // file：裸启动；一句话打印给人，必要时转达
        console.log(`若 agent 未自动读取上岗词，请把这句话发给它：${ONBOARD_HINT}`);
        console.log('');
        proc = runShell(s.worktree, agent.cmd);
        code = await proc.exited;
      }

      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);

      // F7：stdio inherit 下读不到输出，quotaHint 尽力而为（当前恒 false，占位）
      appendEvent(s.worktree, {
        ts: new Date().toISOString(),
        type: 'exit',
        agent: agent.name,
        tier: agent.tier,
        worktree: s.worktree,
        code,
        quotaHint: false,
      });
      console.log('');
      console.log(`${agent.name} 退出（code=${code}）。执行 relay handoff 完成交接（audit + gate + checkpoint）。`);
    } finally {
      releaseLock(s.worktree);
    }
  });
  return cmd;
}
