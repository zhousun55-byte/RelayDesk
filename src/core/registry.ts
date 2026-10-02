import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from './errors';
import { appNameOf } from './names';
import { relayHome } from './paths';
import type { AgentConfig, AgentKind, AgentsRegistry, Tier } from './types';

/** 桌面程序「打开文件夹」命令里的占位符（旧版叫 {{worktree}}，也认）。 */
export const DIR_PLACEHOLDER = '{{dir}}';
const DIR_PLACEHOLDERS = ['{{dir}}', '{{worktree}}'];

/**
 * 桌面程序的打开命令是网页上一点就交给 shell 执行的：只认 open -a 程序 {{dir}} 这一种写法
 * （程序名带空格用引号；{{worktree}} 是旧写法）。程序名里不许有 shell 会展开的符号，别的写法一律不认。
 */
const OPEN_CMD_RE = /^open\s+-a\s+(?:"[^"$`\\]+"|'[^']+'|[^\s"'$`\\;&|<>(){}[\]*?!#~]+)\s+(["']?)\{\{(?:dir|worktree)\}\}\1$/;

export function isOpenCommand(cmd: string | undefined): boolean {
  return typeof cmd === 'string' && OPEN_CMD_RE.test(cmd.trim());
}
export const OUT_PLACEHOLDER = '{{out}}';

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;
const KEY_FROM_RE = /^mimocode:[A-Za-z0-9._-]{1,80}$/;
const KINDS: readonly AgentKind[] = ['cli', 'app', 'api'];
const TIERS: readonly Tier[] = ['strong', 'weak'];

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
  if (cache && cache.path === p && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return copyOf(cache.reg);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    throw new RelayError(`成员名单 ${p} 不是合法的 JSON`, 'bad-registry');
  }
  const list = (parsed as Partial<AgentsRegistry> | null)?.agents;
  if (!Array.isArray(list)) throw new RelayError(`成员名单 ${p} 格式不对，应为 { "agents": [...] }`, 'bad-registry');
  const removed = (parsed as Partial<AgentsRegistry>).removed;
  const reg: AgentsRegistry = {
    agents: list.filter((a): a is AgentConfig => !!a && typeof a === 'object' && typeof a.name === 'string'),
    ...(Array.isArray(removed) ? { removed: removed.filter((x): x is string => typeof x === 'string') } : {}),
  };
  cache = { path: p, mtimeMs: st.mtimeMs, size: st.size, reg };
  return copyOf(reg);
}

function copyOf(reg: AgentsRegistry): AgentsRegistry {
  return { agents: reg.agents.map((a) => ({ ...a })), ...(reg.removed ? { removed: [...reg.removed] } : {}) };
}

/**
 * 识别时用：名单文件读得出来就正常读；读不出来（JSON 坏了、格式不对）不报错，而是把坏的那份挪成 agents.json.broken，
 * 当作空名单从头识别（识别完会重新写好）。返回名单和坏了的原因（有就说给人看）。
 */
export function loadRegistryForDetect(): { reg: AgentsRegistry; recovered?: string } {
  try {
    return { reg: loadRegistry() };
  } catch (e) {
    const p = registryPath();
    try {
      if (fs.existsSync(p)) fs.renameSync(p, `${p}.broken`);
    } catch {
      /* 挪不动就算了，下面照样从空的开始 */
    }
    cache = null;
    return { reg: { agents: [] }, recovered: e instanceof Error ? e.message : String(e) };
  }
}

export function saveRegistry(reg: AgentsRegistry): void {
  const p = registryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const out: AgentsRegistry = { agents: reg.agents, ...(reg.removed?.length ? { removed: [...new Set(reg.removed)] } : {}) };
  fs.writeFileSync(p, JSON.stringify(out, null, 2) + '\n');
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

function optText(v: unknown, field: string, max = 200): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new RelayError(`${field} 必须是文字。`, 'bad-agent');
  const t = v.trim();
  if (t.length > max) throw new RelayError(`${field} 太长了（最多 ${max} 个字）。`, 'bad-agent');
  return t || undefined;
}

/** 校验一条工人配置并整理成标准形状。网页保存、命令行添加、预设都走这里。 */
export function normalizeAgent(input: unknown): AgentConfig {
  if (!input || typeof input !== 'object') throw new RelayError('成员配置不完整', 'bad-agent');
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
    // 没写协议就按地址认：…/anthropic 结尾（智谱、Z.AI、DeepSeek、Kimi 兼容 Claude 的地址）和 api.anthropic.com 是 anthropic，别的是 openai。
    const guess = /\/anthropic\/?$|^https:\/\/api\.anthropic\.com(\/|$)/i.test(baseUrl) ? 'anthropic' : undefined;
    const format = api.format === 'anthropic' ? 'anthropic' : api.format === undefined || api.format === '' ? guess : api.format === 'openai' ? undefined : null;
    if (!/^https?:\/\/\S+$/.test(baseUrl)) throw new RelayError('接口地址不是 http:// 或 https:// 开头', 'bad-agent');
    if (!apiModel) throw new RelayError('接口模型是空的', 'bad-agent');
    if (format === null) throw new RelayError('接口协议只能是 openai 或 anthropic', 'bad-agent');
    if (keyFrom && !KEY_FROM_RE.test(keyFrom)) throw new RelayError('密钥来源格式不对。', 'bad-agent');
    const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(baseUrl);
    if (!keyFrom && !(local && !apiKeyEnv) && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
      throw new RelayError('密钥环境变量名只能是英文、数字、下划线（例如 DEEPSEEK_API_KEY）', 'bad-agent');
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
    if (kind === 'app' && !isOpenCommand(cmd)) throw new RelayError(`桌面程序的打开命令只能写成 open -a 程序 ${DIR_PLACEHOLDER}，例如 open -a Cursor ${DIR_PLACEHOLDER}。`, 'bad-agent');
    agent.cmd = cmd;
    if (model) agent.model = model;
    if (ask) agent.ask = ask;
    const harness = optText(o.harness, '编程工具', 40);
    if (harness) {
      if (kind !== 'cli') throw new RelayError('只有命令行成员能绑定编程工具', 'bad-agent');
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
  const app = optText(o.app, '桌面程序', 300);
  if (app) {
    if (kind === 'app') throw new RelayError('桌面程序不能再配桌面程序', 'bad-agent');
    if (!DIR_PLACEHOLDERS.some((x) => app.includes(x))) throw new RelayError(`桌面程序的打开命令必须含 ${DIR_PLACEHOLDER}（项目文件夹）。`, 'bad-agent');
    if (!isOpenCommand(app)) throw new RelayError(`桌面程序的打开命令只能写成 open -a 程序 ${DIR_PLACEHOLDER}，例如 open -a Cursor ${DIR_PLACEHOLDER}。`, 'bad-agent');
    agent.app = app;
  }
  if (o.detected === true) agent.detected = true;
  const crew = optText(o.crew, '派活时干活的成员', 40);
  if (crew) {
    if (!NAME_RE.test(crew) || crew === name) throw new RelayError('派活时干活的成员名不对', 'bad-agent');
    agent.crew = crew;
  }
  return agent;
}

/** 新增或修改。originalName 给了就是改名修改；新名字不能和别人撞。 */
export function upsertAgent(input: unknown, originalName?: string): AgentConfig {
  const agent = normalizeAgent(input);
  const reg = loadRegistry();
  const from = originalName ?? agent.name;
  const idx = reg.agents.findIndex((a) => a.name === from);
  if (agent.name !== from && reg.agents.some((a) => a.name === agent.name)) {
    throw new RelayError(`已经有叫「${agent.name}」的成员`, 'dup-agent');
  }
  if (idx >= 0) reg.agents[idx] = agent;
  else {
    if (originalName) throw new RelayError(`名单里没有「${originalName}」`, 'no-agent');
    reg.agents.push(agent);
  }
  // 自己加回来的：不再算删掉的
  const back = new Set(removalKeys(agent));
  if (reg.removed) reg.removed = reg.removed.filter((k) => !back.has(k));
  saveRegistry(reg);
  return agent;
}

export function addAgent(input: unknown): AgentConfig {
  const agent = normalizeAgent(input);
  if (findAgent(agent.name)) throw new RelayError(`已经有叫「${agent.name}」的成员`, 'dup-agent');
  return upsertAgent(agent);
}

/** 识别时认它的记号：删掉之后，再识别也不把它加回来。 */
export function removalKeys(a: AgentConfig): string[] {
  const keys: string[] = [];
  if (a.harness) keys.push(`h:${a.harness}`);
  if (a.api?.baseUrl) keys.push(`api:${a.api.baseUrl.replace(/\/+$/, '')}`);
  for (const cmd of [agentKind(a) === 'app' ? a.cmd : undefined, a.app]) {
    const n = appNameOf(cmd);
    if (n) keys.push(`app:${n}`);
  }
  return keys;
}

export function removeAgent(name: string): void {
  const reg = loadRegistry();
  const gone = reg.agents.find((a) => a.name === name);
  if (!gone) throw new RelayError(`名单里没有「${name}」`, 'no-agent');
  const rest = reg.agents.filter((a) => a !== gone);
  // 谁派活时派给它的：改回按顺序
  for (const a of rest) if (a.crew === name) delete a.crew;
  // 同一个工具换了模型的还有别的几位在：这个工具不算删掉（重新识别照常更新它的位置）
  const held = new Set(rest.flatMap(removalKeys));
  saveRegistry({ agents: rest, removed: [...(reg.removed ?? []), ...removalKeys(gone).filter((k) => !held.has(k))] });
}
