import { Command } from 'commander';
import { loadRegistry, registryPath, saveRegistry } from '../core/registry';
import type { AgentConfig, AgentKind, AgentsRegistry, PromptMode, Tier } from '../core/types';

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const TIERS: readonly Tier[] = ['strong', 'weak'];
const MODES: readonly PromptMode[] = ['arg', 'stdin', 'file'];
const KINDS: readonly AgentKind[] = ['cli', 'app'];
/** App 打开模板的占位符，relay open 时代入 worktree 绝对路径。 */
export const WORKTREE_PLACEHOLDER = '{{worktree}}';

interface AddOptions {
  cmd: string;
  tier: string;
  mode: string;
  kind: string;
  note?: string;
}

export function agentsCommand(): Command {
  const agents = new Command('agents');
  agents.description('管理全局 agent 注册表（~/.relay/agents.json）');

  const add = new Command('add');
  add.description('登记一个 agent');
  add.argument('<name>', '唯一名，如 claude / zcode');
  add.requiredOption('--cmd <cmd>', '启动命令。cli：在 worktree 内执行；app：打开模板，须含 {{worktree}} 占位符');
  add.requiredOption('--tier <tier>', `能力分级：${TIERS.join(' | ')}`);
  add.option('--mode <mode>', `上岗词喂入方式（仅 cli 客人）：${MODES.join(' | ')}，默认 file`, 'file');
  add.option('--kind <kind>', `客人类型：cli（终端阻塞，relay run）| app（桌面 App，relay open），默认 cli`, 'cli');
  add.option('--note <note>', '备注，如「ZCode 桌面 App」');
  add.action((name: string, opts: AddOptions) => {
    if (!NAME_RE.test(name)) {
      throw new Error(`名字只能以字母数字开头，含字母数字、-、_：${name}`);
    }
    if (!TIERS.includes(opts.tier as Tier)) {
      throw new Error(`--tier 只能是 ${TIERS.join(' | ')}，收到：${opts.tier}`);
    }
    if (!MODES.includes(opts.mode as PromptMode)) {
      throw new Error(`--mode 只能是 ${MODES.join(' | ')}，收到：${opts.mode}`);
    }
    if (!KINDS.includes(opts.kind as AgentKind)) {
      throw new Error(`--kind 只能是 ${KINDS.join(' | ')}，收到：${opts.kind}`);
    }
    if (opts.kind === 'app' && !opts.cmd.includes(WORKTREE_PLACEHOLDER)) {
      throw new Error(
        `kind=app 的 cmd 必须含 ${WORKTREE_PLACEHOLDER} 占位符（如 'open -a ZCode ${WORKTREE_PLACEHOLDER}'），` +
          '否则 App 不知道要打开哪个 worktree。'
      );
    }
    const reg: AgentsRegistry = loadRegistry();
    if (reg.agents.some((a) => a.name === name)) {
      throw new Error(`已存在同名 agent：${name}。如需修改请手工编辑 ${registryPath()}`);
    }
    const agent: AgentConfig = {
      name,
      cmd: opts.cmd,
      tier: opts.tier as Tier,
      prompt: { mode: opts.mode as PromptMode },
      kind: opts.kind as AgentKind,
      ...(opts.note !== undefined ? { note: opts.note } : {}),
    };
    reg.agents.push(agent);
    saveRegistry(reg);
    console.log(
      `已登记 ${name}（kind=${agent.kind}, tier=${agent.tier}, prompt.mode=${agent.prompt.mode}, cmd="${agent.cmd}"）→ ${registryPath()}`
    );
  });

  const list = new Command('list');
  list.description('列出已登记的 agent');
  list.action(() => {
    const reg = loadRegistry();
    if (reg.agents.length === 0) {
      console.log('（注册表为空。用 relay agents add <name> --cmd "..." --tier strong|weak 登记）');
      return;
    }
    const rows = reg.agents.map((a) => ({
      name: a.name,
      kind: a.kind ?? 'cli',
      tier: a.tier,
      mode: a.prompt.mode,
      cmd: a.cmd,
      note: a.note ?? '',
    }));
    const widths = {
      name: Math.max(4, ...rows.map((r) => r.name.length)),
      kind: Math.max(4, ...rows.map((r) => r.kind.length)),
      tier: Math.max(4, ...rows.map((r) => r.tier.length)),
      mode: Math.max(4, ...rows.map((r) => r.mode.length)),
      cmd: Math.max(3, ...rows.map((r) => r.cmd.length)),
    };
    console.log(
      ['NAME'.padEnd(widths.name), 'KIND'.padEnd(widths.kind), 'TIER'.padEnd(widths.tier), 'MODE'.padEnd(widths.mode), 'CMD'.padEnd(widths.cmd), 'NOTE'].join('  ')
    );
    for (const r of rows) {
      console.log(
        [r.name.padEnd(widths.name), r.kind.padEnd(widths.kind), r.tier.padEnd(widths.tier), r.mode.padEnd(widths.mode), r.cmd.padEnd(widths.cmd), r.note].join('  ')
      );
    }
  });

  agents.addCommand(add);
  agents.addCommand(list);
  return agents;
}
