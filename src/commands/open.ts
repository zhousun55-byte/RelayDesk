import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { Command } from 'commander';
import { repoRootAt } from '../core/git';
import { loadRelayConfig } from '../core/config';
import { appendEvent } from '../core/journal';
import { acquireAppLock, releaseLock } from '../core/lock';
import { WORKTREE_PLACEHOLDER } from './agents';
import { loadRegistry } from '../core/registry';
import { requireSession } from '../core/session';
import { writeOnboardFor } from './onboard';

/** 只等「打开命令」自己退出（open / cursor 这类启动后即返回），不跟踪被打开的 App。 */
function runOpener(cwd: string, full: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', full], { cwd, stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`启动失败：${err.message}`);
      resolve(-1);
    });
    child.on('close', (code) => resolve(code ?? -1));
  });
}

export function openCommand(): Command {
  const cmd = new Command('open');
  cmd.description('为 App 客人（ZCode/Cursor 等桌面 App）打开 worktree：写上岗词 → 打开 → 立即返回（软锁到 handoff 才释放）');
  cmd.argument('<agent>', '注册表里 kind=app 的 agent 名');
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
    if ((agent.kind ?? 'cli') !== 'app') {
      throw new Error(
        `「${agentName}」是 CLI 客人（kind=${agent.kind ?? 'cli'}），不能用 relay open。请在主仓库执行 relay run ${agentName}。`
      );
    }

    // 先拿 App 软锁，再做任何有副作用的写入（写 ONBOARD、journal 记 open）——与 run 同理。
    // 软锁不看 pid：App 段唯一正常收尾是 handoff（merge / abandon 遇软锁默认拒绝，--force 才收尾）；
    // --force 覆盖的事实随 open 事件写进 journal（审计痕迹）。
    const takeover = acquireAppLock(s.worktree, agent.name, { force: opts.force });

    let onboardPath = '';
    try {
      // 与 relay run 同一套上岗词（buildOnboard + reviewBaseFor）
      onboardPath = writeOnboardFor(s.worktree, s, cfg);
      appendEvent(s.worktree, {
        ts: new Date().toISOString(),
        type: 'open',
        agent: agent.name,
        tier: agent.tier,
        ...(opts.llm?.trim() ? { llm: opts.llm.trim() } : {}),
        worktree: s.worktree,
        ...(takeover.overrode ? { overrode: takeover.overrode } : {}),
      });

      if (!agent.cmd.includes(WORKTREE_PLACEHOLDER)) {
        console.warn(`⚠ cmd 里没有 ${WORKTREE_PLACEHOLDER} 占位符，App 可能打不开正确的 worktree。`);
      }
      const full = agent.cmd.split(WORKTREE_PLACEHOLDER).join(s.worktree);
      const code = await runOpener(s.worktree, full);

      if (code !== 0) {
        // 打开命令本身失败：App 没起来，软锁无意义，自愈释放（journal 里的 open 记录保留，历史不删）
        releaseLock(s.worktree);
        console.error(`打开命令退出码 ${code}（${full}）。已释放软锁；修正 cmd 后可重新 relay open ${agent.name}。`);
        process.exitCode = 1;
        return;
      }
    } catch (err) {
      releaseLock(s.worktree);
      throw err;
    }

    console.log('');
    console.log(`App 客人 ${agent.name}（tier=${agent.tier}）的 worktree：${s.worktree}`);
    console.log(`上岗词已写入：${onboardPath}（请让 App 先读这份文件再开工）`);
    console.log('');
    console.log(`这段活干完/停手后，回到主仓库目录执行：relay handoff（这是 App 段唯一的正常收尾方式，之后才能 merge）。`);
    console.log(`在此之前软锁生效：relay run / open / rollback / merge / abandon 一律拒绝；run / open 的 --force 是强行接管（写进 journal），merge / abandon 的 --force 是强行收尾（未交接的未提交改动可能丢失），rollback 无 --force。`);
  });
  return cmd;
}
