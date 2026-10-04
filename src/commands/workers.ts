import { Command } from 'commander';
import { RelayError } from '../core/errors';
import { checkCommand } from '../core/launch';
import { apiUsable, keyWhere } from '../core/llm';
import { findPreset, PRESETS } from '../core/presets';
import { addAgent, agentKind, agentLabel, canTalk, findAgent, loadRegistry, registryPath, removeAgent, restoreAgent, trashedAgents, upsertAgent } from '../core/registry';
import type { AgentConfig } from '../core/types';
import { info, ok, warn } from './print';

interface AgentFlags {
  preset?: string;
  label?: string;
  kind?: string;
  cmd?: string;
  tier?: string;
  model?: string;
  ask?: string;
  apiBase?: string;
  apiModel?: string;
  apiKeyEnv?: string;
  note?: string;
  rename?: string;
  harness?: string;
  effort?: string;
}

function withFlags(cmd: Command): Command {
  return cmd
    .option('--label <显示名>', '显示名，如「Claude Code」')
    .option('--kind <类型>', 'cli（终端）| app（桌面）| api（只讨论）')
    .option('--cmd <命令>', '启动命令；桌面程序要含 {{dir}}（项目文件夹）')
    .option('--tier <能力>', 'strong（强）| weak（弱）')
    .option('--model <模型>', '派活时用的模型（如 gpt-6-sol；不填用工具自己的默认）')
    .option('--ask <命令>', '讨论命令：从标准输入读题、标准输出回答')
    .option('--api-base <地址>', 'API 地址（kind=api）')
    .option('--api-model <模型>', 'API 模型名（kind=api）')
    .option('--api-key-env <变量名>', '放密钥的环境变量名（kind=api）')
    .option('--note <备注>', '备注')
    .option('--harness <工具>', '绑定认得的编程工具（claude / codex / cursor-agent / zcode …），绑定后能全自动')
    .option('--effort <强度>', '全自动时要求的思考强度（如 low / medium / high）');
}

function merged(base: Partial<AgentConfig>, name: string, f: AgentFlags): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base, name: f.rename ?? name };
  if (f.label !== undefined) out.label = f.label;
  if (f.kind !== undefined) out.kind = f.kind;
  if (f.cmd !== undefined) out.cmd = f.cmd;
  if (f.tier !== undefined) out.tier = f.tier;
  if (f.model !== undefined) out.model = f.model;
  if (f.ask !== undefined) out.ask = f.ask;
  if (f.note !== undefined) out.note = f.note;
  if (f.harness !== undefined) out.harness = f.harness;
  if (f.effort !== undefined) out.effort = f.effort;
  if (f.apiBase !== undefined || f.apiModel !== undefined || f.apiKeyEnv !== undefined) {
    const api = { ...(base.api ?? { baseUrl: '', model: '', apiKeyEnv: '' }) };
    if (f.apiBase !== undefined) api.baseUrl = f.apiBase;
    if (f.apiModel !== undefined) api.model = f.apiModel;
    if (f.apiKeyEnv !== undefined) api.apiKeyEnv = f.apiKeyEnv;
    out.api = api;
  }
  return out;
}

function kindWord(a: AgentConfig): string {
  const k = agentKind(a);
  return k === 'app' ? '桌面' : k === 'api' ? '接口' : '终端';
}

function describe(a: AgentConfig): string {
  const bits = [`${kindWord(a)}`, a.tier === 'weak' ? '弱' : '强'];
  if (a.model) bits.push(a.model);
  if (a.effort) bits.push(`思考 ${a.effort}`);
  if (a.harness) bits.push(`全自动：${a.harness}`);
  if (canTalk(a)) bits.push('能讨论');
  return `${a.name.padEnd(12)} ${agentLabel(a)}（${bits.join('，')}）  ${agentKind(a) === 'api' ? a.api?.baseUrl ?? '' : a.cmd ?? ''}`;
}

export function workersCommand(): Command {
  const workers = new Command('workers').alias('agents').description('管理成员（全局名单 ~/.relay/agents.json）');

  workers
    .command('list')
    .description('列出所有成员')
    .action(() => {
      const reg = loadRegistry();
      if (reg.agents.length === 0) {
        console.log('还没有成员。先加一个，例如：relay workers add claude --preset claude');
        console.log('有哪些现成的：relay workers presets');
        return;
      }
      for (const a of reg.agents) console.log(describe(a));
    });

  workers
    .command('presets')
    .description('看看有哪些现成的成员配置')
    .action(() => {
      for (const p of PRESETS) console.log(`${p.id.padEnd(10)} ${p.title}：${p.hint}`);
      console.log('');
      console.log('用法：relay workers add <名字> --preset <上面的编号>（可以再加 --model 等覆盖）');
    });

  withFlags(workers.command('add').description('添加一个成员').argument('<名字>', '英文名，命令里用它，如 claude'))
    .option('--preset <编号>', '从现成配置开始（relay workers presets 查看）')
    .action((name: string, f: AgentFlags) => {
      let base: Partial<AgentConfig> = { kind: 'cli', tier: 'weak' };
      if (f.preset) {
        const p = findPreset(f.preset);
        if (!p) throw new RelayError(`没有叫 ${f.preset} 的现成配置。relay workers presets 查看。`, 'no-preset');
        base = { ...p.agent };
      }
      const a = addAgent(merged(base, name, f));
      ok(`已添加：${describe(a)}`);
      const chk = agentKind(a) === 'api' ? null : checkCommand(a.cmd ?? '');
      if (chk && !chk.ok) warn(chk.problem ?? '启动命令好像不能用。');
      info(`名单文件：${registryPath()}`);
    });

  withFlags(workers.command('edit').description('修改一个成员（只改给出的项）').argument('<名字>'))
    .option('--rename <新名字>', '改名')
    .action((name: string, f: AgentFlags) => {
      const cur = findAgent(name);
      if (!cur) throw new RelayError(`名单里没有「${name}」`, 'no-agent');
      const a = upsertAgent(merged(cur, name, f), name);
      ok(`已修改：${describe(a)}`);
    });

  workers
    .command('remove')
    .alias('rm')
    .description('删掉一个成员')
    .argument('<名字>')
    .action((name: string) => {
      removeAgent(name);
      ok(`已删除成员「${name}」（relay workers restore ${name} 能加回来）`);
    });

  workers
    .command('restore')
    .description('把删掉的成员加回来（不带名字就列出删掉的）')
    .argument('[名字]')
    .action((name?: string) => {
      if (!name) {
        const list = trashedAgents();
        if (!list.length) return info('没有删掉的成员。');
        for (const x of list) console.log(`${x.agent.name}  ${agentLabel(x.agent)}  删于 ${new Date(x.at).toLocaleString()}`);
        return;
      }
      const a = restoreAgent(name);
      ok(`已加回来：${describe(a)}`);
    });

  workers
    .command('check')
    .description('检查成员的命令在这台电脑上能不能用')
    .argument('[名字]')
    .action((name?: string) => {
      const list = name ? [findAgent(name)].filter((a): a is AgentConfig => !!a) : loadRegistry().agents;
      if (name && list.length === 0) throw new RelayError(`名单里没有「${name}」`, 'no-agent');
      for (const a of list) {
        if (agentKind(a) === 'api') {
          if (a.api && apiUsable(a.api)) ok(`${agentLabel(a)}：${keyWhere(a.api)} 有了`);
          else warn(`${agentLabel(a)}：没有密钥（${a.api ? keyWhere(a.api) : '没配接口'}）`);
          continue;
        }
        const r = checkCommand(a.cmd ?? '');
        if (r.ok) ok(`${agentLabel(a)}：${r.found}`);
        else warn(`${agentLabel(a)}：${r.problem}`);
        if (a.ask) {
          const t = checkCommand(a.ask);
          if (!t.ok) warn(`${agentLabel(a)} 的讨论命令：${t.problem}`);
        }
      }
    });

  return workers;
}
