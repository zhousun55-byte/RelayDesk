import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Command } from 'commander';
import { loadAutoSettings } from '../core/auto-settings';
import { gateConfirmed } from '../core/config';
import { loadDetected } from '../core/detect';
import { which } from '../core/env';
import { errorMessage } from '../core/errors';
import { checkCommand } from '../core/launch';
import { loadLedger } from '../core/ledger';
import { apiUsable, keyWhere } from '../core/llm';
import { allMembers, readyMembers } from '../core/members';
import { relayHome } from '../core/paths';
import { protocolState } from '../core/protocol';
import { cause } from '../core/cause';
import { agentKind, agentLabel, loadRegistry } from '../core/registry';
import { projectConfigSafe } from '../ops/track';
import { findRoot } from './relay';

export interface DoctorLine {
  level: 'ok' | 'warn' | 'bad';
  text: string;
}

/** 体检：这台电脑、成员、当前项目能不能用。网页的「环境检查」也用它。 */
export function doctor(dir: string): DoctorLine[] {
  const out: DoctorLine[] = [];
  const add = (level: DoctorLine['level'], text: string) => out.push({ level, text });

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) add('ok', `Node ${process.version}`);
  else add('bad', `Node ${process.version}，需要 20 或更新的版本`);

  const g = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (g.status === 0) add('ok', (g.stdout || 'git').trim());
  else add('bad', '找不到 git。先安装 git（macOS 上执行 xcode-select --install）。');

  const w = which('relay');
  if (w) add('ok', `终端里可以直接用 relay 命令（${w}）`);
  else add('warn', `终端里还不能直接打 relay。到接力台的文件夹执行 npm link；或用 node ${path.join(__dirname, '..', 'cli.js')}`);

  try {
    const reg = loadRegistry();
    if (reg.agents.length === 0) add('warn', '还没有成员。在接力台「设置」里添加，或 relay workers add claude --preset claude');
    for (const a of reg.agents) {
      if (agentKind(a) === 'api') {
        if (a.api && apiUsable(a.api)) add('ok', `成员 ${agentLabel(a)}：${keyWhere(a.api)} 有了`);
        else add('warn', `成员 ${agentLabel(a)}：没有密钥（${a.api ? keyWhere(a.api) : '没配接口'}），它现在用不了`);
        continue;
      }
      const r = checkCommand(a.cmd ?? '');
      if (r.ok) add('ok', `成员 ${agentLabel(a)}：${r.found}`);
      else add('warn', `成员 ${agentLabel(a)}：${r.problem}`);
      if (a.ask) {
        const t = checkCommand(a.ask);
        if (!t.ok) add('warn', `成员 ${agentLabel(a)} 的讨论命令：${t.problem}`);
      }
    }
  } catch (e) {
    add('bad', errorMessage(e));
  }

  try {
    const settings = loadAutoSettings();
    if (!loadDetected()) add('warn', '还没自动识别过这台电脑上的 AI 工具（接力台启动时会自动识别，或执行 relay detect）。');
    const list = allMembers(settings.level);
    const ready = readyMembers(list);
    const strong = ready.filter((m) => m.tier === 'strong');
    if (ready.length) add('ok', `能派活的成员：${ready.map((m) => m.label).join('、')}`);
    else add('warn', '没有能派活的成员：没装、没登录或额度都用完了');
    if (ready.length && !strong.length) add('warn', '能派活的成员里没有强模型');
    for (const m of list.filter((x) => x.cooling)) add('warn', `${m.label} ${cause.quota(m.cooling)}`);
    for (const m of list.filter((x) => x.blocked)) add('warn', `${m.label} 先停用着：${m.why}（换了模型、重新登录后在网页「设置 → 成员」里点「再试一次」）`);
  } catch (e) {
    add('warn', errorMessage(e));
  }

  try {
    const root = findRoot(dir);
    const v = loadLedger(root);
    if (!v.init) {
      add('warn', `${root} 还没接入接力台（relay init，或在网页里点「接入」）。`);
    } else {
      add('ok', `接入的项目：${root}（${v.stints.length} 棒）`);
      const st = protocolState(root);
      if (st === 'ok') add('ok', 'AGENTS.md / CLAUDE.md 里的接力规矩是最新的');
      else add('warn', st === 'old' ? '接力规矩是旧版的：relay init 更新一下' : 'AGENTS.md / CLAUDE.md 里没有接力规矩了：relay init 补上');
      const { cfg, error } = projectConfigSafe(root);
      if (error) add('warn', `配置文件坏了（检查命令、不许改的文件都没法用，全自动不会开工）：${error}`);
      else if (cfg.gate.command && !gateConfirmed(root, cfg.gate.command)) add('warn', `检查命令：${cfg.gate.command}（还没在这台电脑上确认过，不会自动跑：relay config --gate 定下来，或在网页「设置 → 项目」里保存一次）`);
      else add('ok', `检查命令：${cfg.gate.command || '没配置（每一棒结束时不跑检查）'}`);
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
