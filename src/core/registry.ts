import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from './errors';
import { relayHome } from './paths';
import type { AgentConfig, AgentKind, AgentsRegistry, PromptMode, Tier } from './types';

/** 桌面程序「打开文件夹」命令里的占位符（旧版叫 {{worktree}}，也认）。 */
export const DIR_PLACEHOLDER = '{{dir}}';
const DIR_PLACEHOLDERS = ['{{dir}}', '{{worktree}}'];
export const OUT_PLACEHOLDER = '{{out}}';

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;
const KEY_FROM_RE = /^mimocode:[A-Za-z0-9._-]{1,80}$/;
const KINDS: readonly AgentKind[] = ['cli', 'app', 'api'];
const TIERS: readonly Tier[] = ['strong', 'weak'];
const MODES: readonly PromptMode[] = ['arg', 'stdin', 'file'];

const KNOWN_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  'cursor-agent': 'Cursor Agent',
  'zcode-cli': 'ZCode 命令行',
  agy: 'Antigravity',
  'mimo-api': 'MiMo 接口',
  zcode: 'ZCode',
  mimo: 'MiMo',
  gpt: 'ChatGPT',
  deepseek: 'DeepSeek',
  framework: '未登记',
  human: '人工',
};

export function registryPath(): string {
  return path.join(relayHome(), 'agents.json');
}

/** 名单文件没变就不重读（接力台每几秒刷新一次状态，时间线里每一行都要查显示名）。 */
let cache: { path: string; mtimeMs: number; size: number; reg: AgentsRegistry } | null = null;

export function loadRegistry(): AgentsRegistry {
  const p = registryPath();
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return { agents: [] };
  }
  if (cache && cache.path === p && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
    return { agents: cache.reg.agents.map((a) => ({ ...a })) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    throw new RelayError(`工人名单 ${p} 不是合法的 JSON。修好它，或删掉后重新添加工人。`, 'bad-registry');
  }
  const list = (parsed as Partial<AgentsRegistry> | null)?.agents;
  if (!Array.isArray(list)) throw new RelayError(`工人名单 ${p} 格式不对，应为 { "agents": [...] }。`, 'bad-registry');
  const reg = { agents: list.filter((a): a is AgentConfig => !!a && typeof a === 'object' && typeof a.name === 'string') };
  cache = { path: p, mtimeMs: st.mtimeMs, size: st.size, reg };
  return { agents: reg.agents.map((a) => ({ ...a })) };
}

export function saveRegistry(reg: AgentsRegistry): void {
  const p = registryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(reg, null, 2) + '\n');
  cache = null;
}

export function agentKind(a: Pick<AgentConfig, 'kind'>): AgentKind {
  return a.kind ?? 'cli';
}

/** 工人在用的模型：接口工人以接口里填的为准。 */
export function agentModel(a: Pick<AgentConfig, 'kind' | 'model' | 'api'>): string | undefined {
  return ((a.kind === 'api' ? a.api?.model : a.model) ?? '').trim() || undefined;
}

/** 显示名：自己填的 > 常见工具名 > 名字本身。只给名字时会去工人名单里查。 */
export function agentLabel(a: Pick<AgentConfig, 'name' | 'label'> | string | undefined | null): string {
  if (!a) return '未登记';
  if (typeof a === 'string') {
    let found: AgentConfig | undefined;
    try {
      found = loadRegistry().agents.find((x) => x.name === a);
    } catch {
      found = undefined;
    }
    return found?.label?.trim() || KNOWN_LABELS[a.toLowerCase()] || a;
  }
  return a.label?.trim() || KNOWN_LABELS[a.name.toLowerCase()] || a.name;
}

/** 能不能参加讨论：接 API 的、配了讨论命令的，或者绑定了认得的编程工具的（用它的只读模式）。 */
export function canTalk(a: AgentConfig): boolean {
  return agentKind(a) === 'api' || !!a.ask?.trim() || (agentKind(a) === 'cli' && !!a.harness);
}

export function findAgent(name: string): AgentConfig | null {
  return loadRegistry().agents.find((a) => a.name === name) ?? null;
}

export function requireAgent(name: string): AgentConfig {
  const a = findAgent(name);
  if (!a) throw new RelayError(`工人名单里没有「${name}」。在设置里添加，或 relay workers add。`, 'no-agent');
  return a;
}

function optText(v: unknown, field: string, max = 200): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new RelayError(`${field} 必须是文字。`, 'bad-agent');
  const t = v.trim();
  if (t.length > max) throw new RelayError(`${field} 太长了（最多 ${max} 个字）。`, 'bad-agent');
  return t || undefined;
}

/** 校验一条工人配置并整理成标准形状。网页保存、命令行添加、预设都走这里。 */
export function normalizeAgent(input: unknown): AgentConfig {
  if (!input || typeof input !== 'object') throw new RelayError('工人配置不完整。', 'bad-agent');
  const o = input as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!NAME_RE.test(name)) {
    throw new RelayError('名字只能用英文字母、数字、- 和 _，并以字母或数字开头（例如 claude、cursor2）。', 'bad-agent');
  }
  const kind = (o.kind ?? 'cli') as AgentKind;
  if (!KINDS.includes(kind)) throw new RelayError(`类型只能是 终端(cli) / 桌面(app) / 接口(api)。`, 'bad-agent');
  // 没说强弱的按弱（认不出来按弱处理：它做的活要复核）。
  const tier = (o.tier ?? 'weak') as Tier;
  if (!TIERS.includes(tier)) throw new RelayError('能力只能是 strong（强）或 weak（弱）。', 'bad-agent');

  const agent: AgentConfig = { name, kind, tier };
  if (o.tierSet === true) agent.tierSet = true;
  const label = optText(o.label, '显示名', 40);
  const model = optText(o.model, '模型', 80);
  const note = optText(o.note, '备注', 200);
  const ask = optText(o.ask, '讨论命令', 500);
  if (label) agent.label = label;

  if (kind === 'api') {
    const api = (o.api ?? {}) as Record<string, unknown>;
    const baseUrl = optText(api.baseUrl, '接口地址', 300) ?? '';
    const apiModel = optText(api.model, '接口模型', 100) ?? '';
    const apiKeyEnv = optText(api.apiKeyEnv, '密钥环境变量名', 100) ?? '';
    const keyFrom = optText(api.keyFrom, '密钥来源', 100);
    const format = api.format === 'anthropic' ? 'anthropic' : api.format === undefined || api.format === 'openai' || api.format === '' ? undefined : null;
    if (!/^https?:\/\/\S+$/.test(baseUrl)) throw new RelayError('接口地址要以 http:// 或 https:// 开头。', 'bad-agent');
    if (!apiModel) throw new RelayError('接口模型不能空（例如 deepseek-chat）。', 'bad-agent');
    if (format === null) throw new RelayError('接口协议只能是 openai 或 anthropic。', 'bad-agent');
    if (keyFrom && !KEY_FROM_RE.test(keyFrom)) throw new RelayError('密钥来源格式不对。', 'bad-agent');
    const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(baseUrl);
    if (!keyFrom && !(local && !apiKeyEnv) && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
      throw new RelayError('密钥环境变量名只能是英文、数字、下划线（例如 DEEPSEEK_API_KEY）。密钥本身不要填在这里。', 'bad-agent');
    }
    agent.api = { baseUrl: baseUrl.replace(/\/+$/, ''), model: apiModel, apiKeyEnv, ...(format ? { format } : {}), ...(keyFrom ? { keyFrom } : {}) };
    // 接口工人的模型就是接口里填的那个；不另存一份，免得改了接口模型后两边对不上。
    agent.model = apiModel;
  } else {
    const cmd = optText(o.cmd, '启动命令', 500) ?? '';
    if (!cmd) throw new RelayError('启动命令不能空。', 'bad-agent');
    if (kind === 'app' && !DIR_PLACEHOLDERS.some((x) => cmd.includes(x))) {
      throw new RelayError(`桌面程序的打开命令必须含 ${DIR_PLACEHOLDER}（项目文件夹），例如 open -a Cursor ${DIR_PLACEHOLDER}。`, 'bad-agent');
    }
    agent.cmd = cmd;
    const promptIn = o.prompt as { mode?: unknown } | undefined;
    const mode = (promptIn?.mode ?? o.mode ?? 'file') as PromptMode;
    if (!MODES.includes(mode)) throw new RelayError('上岗词喂法只能是 arg / stdin / file。', 'bad-agent');
    agent.prompt = { mode };
    if (model) agent.model = model;
    if (ask) agent.ask = ask;
    const harness = optText(o.harness, '编程工具', 40);
    if (harness) {
      if (kind !== 'cli') throw new RelayError('只有终端工人能绑定编程工具。', 'bad-agent');
      if (!/^[a-z][a-z0-9-]{0,30}$/.test(harness)) throw new RelayError('编程工具的名字不对。', 'bad-agent');
      agent.harness = harness;
    }
    const effort = optText(o.effort, '思考强度', 20);
    if (effort) {
      if (!/^[A-Za-z0-9_-]+$/.test(effort)) throw new RelayError('思考强度只能是英文，例如 low / medium / high。', 'bad-agent');
      agent.effort = effort;
    }
  }
  if (note) agent.note = note;
  if (o.detected === true) agent.detected = true;
  return agent;
}

/** 新增或修改。originalName 给了就是改名修改；新名字不能和别人撞。 */
export function upsertAgent(input: unknown, originalName?: string): AgentConfig {
  const agent = normalizeAgent(input);
  const reg = loadRegistry();
  const from = originalName ?? agent.name;
  const idx = reg.agents.findIndex((a) => a.name === from);
  if (agent.name !== from && reg.agents.some((a) => a.name === agent.name)) {
    throw new RelayError(`已经有叫「${agent.name}」的工人了，换个名字。`, 'dup-agent');
  }
  if (idx >= 0) reg.agents[idx] = agent;
  else {
    if (originalName) throw new RelayError(`工人名单里没有「${originalName}」。`, 'no-agent');
    reg.agents.push(agent);
  }
  saveRegistry(reg);
  return agent;
}

export function addAgent(input: unknown): AgentConfig {
  const agent = normalizeAgent(input);
  if (findAgent(agent.name)) throw new RelayError(`已经有叫「${agent.name}」的工人了。要改请用 relay workers edit。`, 'dup-agent');
  return upsertAgent(agent);
}

export function removeAgent(name: string): void {
  const reg = loadRegistry();
  const next = reg.agents.filter((a) => a.name !== name);
  if (next.length === reg.agents.length) throw new RelayError(`工人名单里没有「${name}」。`, 'no-agent');
  saveRegistry({ agents: next });
}
