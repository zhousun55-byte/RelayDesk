import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { repoRootAt } from '../core/git';
import { loadRelayConfig, relayConfigPath } from '../core/config';
import { loadRegistry, registryPath } from '../core/registry';
import { loadSession } from '../core/session';

export function doctorCommand(): Command {
  const cmd = new Command('doctor');
  cmd.description('检查本机能不能用 relay（给人类看的体检）');
  cmd.action(() => {
    const lines: string[] = [];
    const ok = (s: string) => lines.push(`✓ ${s}`);
    const warn = (s: string) => lines.push(`⚠ ${s}`);
    const bad = (s: string) => lines.push(`✗ ${s}`);

    const nodeMaj = Number(process.versions.node.split('.')[0]);
    if (nodeMaj >= 20) ok(`Node ${process.version}`);
    else bad(`Node ${process.version}（需要 ≥ 20）`);

    const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (git.status === 0) ok((git.stdout || 'git').trim());
    else bad('找不到 git');

    const which = spawnSync('which', ['relay'], { encoding: 'utf8' });
    if (which.status === 0) ok(`命令 relay 在 PATH：${which.stdout.trim()}`);
    else warn(`终端里直接打 relay 还不行。用：node ${path.join(__dirname, '..', 'cli.js')} …`);

    const agentsFile = registryPath();
    try {
      const reg = loadRegistry();
      if (reg.agents.length === 0) warn(`还没登记工人（${agentsFile}）。relay agents add claude --cmd claude --tier strong`);
      else ok(`已登记 ${reg.agents.length} 个工人：${reg.agents.map((a) => a.name).join('、')}`);
    } catch (e) {
      warn(`读注册表失败：${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      const root = repoRootAt(process.cwd());
      ok(`当前在 git 仓库：${root}`);
      const cfg = relayConfigPath(root);
      if (fs.existsSync(cfg)) {
        try {
          const c = loadRelayConfig(root);
          ok(`项目已 init（门禁：${c.gate.command || '未配置'}）`);
          const key = process.env[c.audit.apiKeyEnv];
          if (key) ok(`审计环境变量 ${c.audit.apiKeyEnv} 已设置（不打印值）`);
          else warn(`没设 ${c.audit.apiKeyEnv}：handoff 仍会出 git 事实报告，只是没有模型阅读面`);
        } catch (e) {
          bad(`config.json 有问题：${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        warn(`这个仓库还没 relay init`);
      }
      const s = loadSession(root);
      if (s) ok(`有进行中的任务：${s.taskTitle}（${s.branch}）`);
      else ok('当前没有进行中的任务，可以 relay start');
    } catch {
      warn(`当前目录不是 git 仓库。relay 只能管已经是 git 的项目。`);
    }

    ok(`全局状态目录：${path.join(os.homedir(), '.relay')}`);

    console.log(lines.join('\n'));
  });
  return cmd;
}
