import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { auditSpec } from '../core/audit';
import { loadAutoSettings } from '../core/auto-settings';
import { loadRelayConfig } from '../core/config';
import { listMembers, loadDetected, resolveTeam } from '../core/detect';
import { errorMessage } from '../core/errors';
import { checkCommand } from '../core/launch';
import { apiUsable, keyWhere } from '../core/llm';
import { relayHome } from '../core/paths';
import { inspectProject } from '../core/project';
import { agentKind, agentLabel, loadRegistry } from '../core/registry';
import { loadSession } from '../core/session';

export interface DoctorLine {
  level: 'ok' | 'warn' | 'bad';
  text: string;
}

/** 体检：这台电脑、工人、当前项目能不能用。网页的「环境检查」也用它。 */
export function doctor(dir: string): DoctorLine[] {
  const out: DoctorLine[] = [];
  const add = (level: DoctorLine['level'], text: string) => out.push({ level, text });

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) add('ok', `Node ${process.version}`);
  else add('bad', `Node ${process.version}，需要 20 或更新的版本`);

  const g = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (g.status === 0) add('ok', (g.stdout || 'git').trim());
  else add('bad', '找不到 git。先安装 git（macOS 上执行 xcode-select --install）。');

  const w = spawnSync('sh', ['-c', 'command -v relay'], { encoding: 'utf8' });
  if (w.status === 0 && w.stdout.trim()) add('ok', `终端里可以直接用 relay 命令（${w.stdout.trim()}）`);
  else add('warn', `终端里还不能直接打 relay。到 agent-relay 文件夹执行 npm link；或用 node ${path.join(__dirname, '..', 'cli.js')}`);

  try {
    const reg = loadRegistry();
    if (reg.agents.length === 0) add('warn', '还没有工人。在接力台「设置」里添加，或 relay workers add claude --preset claude');
    for (const a of reg.agents) {
      if (agentKind(a) === 'api') {
        if (a.api && apiUsable(a.api)) add('ok', `工人 ${agentLabel(a)}：${keyWhere(a.api)} 有了`);
        else add('warn', `工人 ${agentLabel(a)}：没有密钥（${a.api ? keyWhere(a.api) : '没配接口'}），它现在用不了`);
        continue;
      }
      const r = checkCommand(a.cmd ?? '');
      if (r.ok) add('ok', `工人 ${agentLabel(a)}：${r.found}`);
      else add('warn', `工人 ${agentLabel(a)}：${r.problem}`);
      if (a.ask) {
        const t = checkCommand(a.ask);
        if (!t.ok) add('warn', `工人 ${agentLabel(a)} 的讨论命令：${t.problem}`);
      }
    }
  } catch (e) {
    add('bad', errorMessage(e));
  }

  try {
    const settings = loadAutoSettings();
    const report = loadDetected();
    if (!report) add('warn', '还没自动识别过这台电脑上的 AI 工具（接力台启动时会自动识别，或执行 relay detect）。');
    const team = resolveTeam(listMembers(settings.level, report), settings);
    const names = (l: typeof team.workers) => l.map((m) => m.label).join('、');
    if (team.workers.length) add('ok', `全自动能派的：干活 ${names(team.workers)}；审查 ${names(team.reviewers) || '（没有）'}`);
    else add('warn', '全自动现在派不出人：装好并登录 Claude Code、Codex、Cursor Agent 等之一，再 relay detect。');
    for (const p of team.problems) add('warn', p);
  } catch (e) {
    add('warn', errorMessage(e));
  }

  try {
    const info = inspectProject(dir);
    if (!info.isGit || !info.hasConfig) {
      add('warn', `${info.root} 还不是接力项目（开始第一个任务时会自动设好，也可以 relay init）。`);
    } else {
      add('ok', `接力项目：${info.root}`);
      try {
        const cfg = loadRelayConfig(info.root);
        add('ok', `检查命令：${cfg.gate.command || '没配置（交接时不检查）'}`);
        if (apiUsable(cfg.audit)) add('ok', `审计模型：${auditSpec(cfg.audit).spec.model}（${cfg.audit.apiKeyEnv} 已设置）`);
        else add('warn', `审计模型没有密钥（${cfg.audit.apiKeyEnv || '没填变量名'}）：交接照常，只是没有模型写的阅读面`);
      } catch (e) {
        add('bad', errorMessage(e));
      }
      const s = loadSession(info.root);
      if (s) {
        if (fs.existsSync(s.worktree)) add('ok', `进行中的任务：${s.taskTitle}`);
        else add('bad', `进行中的任务「${s.taskTitle}」的隔离副本不见了，只能放弃（relay abandon）。`);
      }
    }
  } catch (e) {
    add('warn', errorMessage(e));
  }
  add('ok', `接力台的数据目录：${relayHome()}`);
  return out;
}

export function doctorCommand(): Command {
  return new Command('doctor').description('体检：这台电脑和当前项目能不能用').action(() => {
    for (const l of doctor(process.cwd())) console.log(`${l.level === 'ok' ? '✓' : l.level === 'warn' ? '⚠' : '✗'} ${l.text}`);
  });
}
