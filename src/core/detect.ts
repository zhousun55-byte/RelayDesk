import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanApps } from './env';
import { RelayError } from './errors';
import { checkCommand } from './launch';
import { findHarness, HARNESSES, harnessForCommand, locateCached, clearLocateCache, type HarnessSpec, type Level, type LoginInfo, type ModelInfo } from './harness';
import { autoSettingsSafe } from './auto-settings';
import { apiUsable } from './llm';
import { appNameOf } from './names';
import { relayHome } from './paths';
import { scanProviders, toApiSpec, type DetectedProvider } from './providers';
import { agentKind, agentLabel, agentModel, loadRegistry, loadRegistryForDetect, registryPath, saveRegistry } from './registry';
import { sameModel, tierForModel, toolFamily } from './tier';
import type { AgentConfig } from './types';

/**
 * 自动识别：这台电脑上装了哪些 AI 编程工具（harness）、各自登没登录、默认用什么模型；
 * 配了哪些模型接口（LLM）；还有哪些只能手动用的桌面 App。结果缓存在 ~/.relay/detected.json。
 */

export interface HarnessReport {
  id: string;
  label: string;
  vendor: string;
  version: string;
  where: string;
  note?: string;
  login: LoginInfo;
  model: ModelInfo;
  workLevels: Level[];
  canReview: boolean;
  tested: 'yes' | 'partial' | 'no';
  loginHint: string;
}

export interface AppReport {
  name: string;
  /** 全自动时用什么代替它。 */
  hint: string;
}

export interface DetectReport {
  at: string;
  harnesses: HarnessReport[];
  providers: DetectedProvider[];
  apps: AppReport[];
  unknownKeys: string[];
}

/** 认得的桌面程序。id = 加进名单时的名字；tier = 默认强弱（桌面程序看不出用的哪个模型，你可以在设置里改）。 */
const APPS: { name: string; id: string; label: string; tier: 'strong' | 'weak'; hint: string }[] = [
  { name: 'Cursor', id: 'cursor', label: 'Cursor', tier: 'weak', hint: '你自己打开它接着做；接力台调度时用 Cursor Agent（同一个账号、同样的模型）。' },
  { name: 'ZCode', id: 'zcode', label: 'ZCode', tier: 'weak', hint: '你自己打开它接着做；接力台调度时用它自带的命令行内核。' },
  { name: 'Xiaomi MiMo', id: 'mimo', label: 'MiMo', tier: 'weak', hint: '你自己打开它接着做；接力台调度时可以用它的 Token Plan 接口（要你同意）。' },
  { name: 'ChatGPT', id: 'chatgpt', label: 'ChatGPT', tier: 'strong', hint: '你自己打开它接着做；接力台调度时用 Codex。' },
  { name: 'Claude', id: 'claude-app', label: 'Claude', tier: 'strong', hint: '你自己打开它接着做；接力台调度时用 Claude Code。' },
  { name: 'Codex', id: 'codex-app', label: 'Codex 桌面版', tier: 'strong', hint: '你自己打开它接着做；接力台调度时用 Codex 命令行。' },
  { name: 'Trae', id: 'trae', label: 'Trae', tier: 'weak', hint: '你自己打开它接着做。' },
  { name: 'Windsurf', id: 'windsurf', label: 'Windsurf', tier: 'weak', hint: '你自己打开它接着做。' },
  { name: 'Kiro', id: 'kiro', label: 'Kiro', tier: 'weak', hint: '你自己打开它接着做。' },
  { name: 'Qoder', id: 'qoder', label: 'Qoder', tier: 'weak', hint: '你自己打开它接着做。' },
  { name: 'CodeBuddy', id: 'codebuddy', label: 'CodeBuddy', tier: 'weak', hint: '你自己打开它接着做。' },
  { name: 'Antigravity', id: 'antigravity', label: 'Antigravity', tier: 'weak', hint: '你自己打开它接着做；接力台调度时用 agy 命令行。' },
  { name: 'DeepSeek Harness', id: 'deepseek-harness-app', label: 'DeepSeek Harness 桌面版', tier: 'weak', hint: '你自己打开它接着做；接力台调度时用它自带的无界面模式（同一个登录、同一个模型）。' },
];

function findApps(): AppReport[] {
  if (process.platform !== 'darwin' || !scanApps()) return [];
  const dirs = ['/Applications', path.join(os.homedir(), 'Applications')];
  return APPS.filter((a) => dirs.some((d) => fs.existsSync(path.join(d, `${a.name}.app`)))).map((a) => ({ name: a.name, hint: a.hint }));
}

export function detectedPath(): string {
  return path.join(relayHome(), 'detected.json');
}

export function loadDetected(): DetectReport | null {
  try {
    const j = JSON.parse(fs.readFileSync(detectedPath(), 'utf8')) as DetectReport;
    return j && Array.isArray(j.harnesses) && Array.isArray(j.providers) ? j : null;
  } catch {
    return null;
  }
}

function saveDetected(r: DetectReport): void {
  fs.mkdirSync(path.dirname(detectedPath()), { recursive: true });
  fs.writeFileSync(detectedPath(), JSON.stringify(r, null, 2) + '\n');
}

export function detectHarness(spec: HarnessSpec): HarnessReport | null {
  const loc = spec.locate();
  if (!loc) return null;
  let login: LoginInfo;
  let model: ModelInfo;
  try {
    login = spec.login(loc);
  } catch {
    login = { state: 'unknown', detail: '看不出登录状态' };
  }
  try {
    model = spec.model(loc);
  } catch {
    model = {};
  }
  const note = [loc.note, model.note].filter(Boolean).join(' ');
  return {
    id: spec.id,
    label: spec.label,
    vendor: spec.vendor,
    version: loc.version,
    where: loc.where,
    ...(note ? { note } : {}),
    login,
    model,
    workLevels: spec.workLevels,
    canReview: spec.canReview,
    tested: spec.tested,
    loginHint: spec.loginHint,
  };
}

/** 某个编程工具要用的模型变了（比如发现命令行太旧，换了模型）：只重看这一个，更新识别结果。 */
export function refreshHarnessModel(id: string): void {
  const report = loadDetected();
  const spec = findHarness(id);
  const h = report?.harnesses.find((x) => x.id === id);
  const loc = spec ? locateCached(spec) : null;
  if (!report || !spec || !h || !loc) return;
  try {
    h.model = spec.model(loc);
  } catch {
    return;
  }
  const note = [loc.note, h.model.note].filter(Boolean).join(' ');
  if (note) h.note = note;
  else delete h.note;
  saveDetected(report);
}

let running: Promise<DetectReport> | null = null;

/** 完整识别一遍（找工具要起进程、查接口要连网，几秒钟）。同时只跑一次。 */
export function detectAll(opts: { network?: boolean } = {}): Promise<DetectReport> {
  if (running) return running;
  running = (async () => {
    clearLocateCache();
    const harnesses = HARNESSES.map((h) => detectHarness(h)).filter((h): h is HarnessReport => !!h);
    const scan = await scanProviders(opts);
    const report: DetectReport = { at: new Date().toISOString(), harnesses, providers: scan.providers, apps: findApps(), unknownKeys: scan.unknownKeys };
    saveDetected(report);
    return report;
  })().finally(() => {
    running = null;
  });
  return running;
}

// ---- 把识别结果并进工人名单 ----

/** 工具 → 名单里的默认名字（和桌面 App 的名字错开）。 */
const DEFAULT_NAMES: Record<string, string> = { claude: 'claude', 'claude-official': 'claude-official', codex: 'codex', 'cursor-agent': 'cursor-agent', dsh: 'deepseek-harness', zcode: 'zcode-cli', agy: 'agy', gemini: 'gemini', qwen: 'qwen', opencode: 'opencode', droid: 'droid', copilot: 'copilot', grok: 'grok' };

const LABELS: Record<string, string> = { zcode: 'ZCode 命令行' };

function harnessOf(a: AgentConfig): HarnessSpec | null {
  if (a.harness) return findHarness(a.harness);
  if (agentKind(a) === 'cli') return harnessForCommand(a.cmd);
  return null;
}

function backupRegistryOnce(): void {
  const p = registryPath();
  const bak = `${p}.bak-before-detect`;
  if (fs.existsSync(p) && !fs.existsSync(bak)) fs.copyFileSync(p, bak);
}

/**
 * 把识别到的工具和接口并进工人名单：已有的补上 harness 绑定，没有的新加一条。
 * 从不删人、不改人手填的字段；顺手修掉已知的坏命令（cursor 被 cursor-agent 顶替）。返回做了哪些改动。
 */
export function syncRegistry(report: DetectReport): string[] {
  const recover = loadRegistryForDetect();
  const reg = recover.reg;
  const changes: string[] = [];
  if (recover.recovered) changes.push(`成员名单原来读不出来（${recover.recovered}），坏的那份存成了 agents.json.broken，这次从头识别重建。`);
  const names = new Set(reg.agents.map((a) => a.name));
  // 你删掉的：再识别也不加回来
  const removed = new Set(reg.removed ?? []);

  for (const a of reg.agents) {
    if (agentKind(a) === 'app' && /^cursor(\s|$)/.test((a.cmd ?? '').trim())) {
      const chk = checkCommand(a.cmd ?? '');
      if (!chk.ok) {
        a.cmd = 'open -a Cursor {{dir}}';
        changes.push(`「${agentLabel(a)}」的打开命令坏了（cursor 命令其实是 cursor-agent），改成了 open -a Cursor {{dir}}。`);
      }
    }
  }

  // 按排序先后加：同一个工具同一个模型的两份（桌面版自带的 Claude Code 和终端里的）留排在前面的那份
  for (const h of [...report.harnesses].sort((x, y) => (findHarness(x.id)?.rank ?? 99) - (findHarness(y.id)?.rank ?? 99))) {
    if (h.login.state === 'no') continue;
    const spec = findHarness(h.id)!;
    const loc = locateCached(spec);
    const cmd = loc ? [...loc.exec, ...(spec.manualArgs ?? [])].map((x) => (/[\s"']/.test(x) ? `'${x.replace(/'/g, `'\\''`)}'` : x)).join(' ') : h.id;
    const bound = reg.agents.find((a) => harnessOf(a)?.id === h.id && agentKind(a) === 'cli');
    if (bound) {
      if (!bound.harness) {
        bound.harness = h.id;
        if (!bound.label) bound.label = LABELS[h.id] ?? h.label;
        changes.push(`「${bound.name}」认出来是 ${h.label}，可以全自动了。`);
      } else if (bound.detected && loc && bound.cmd !== cmd) {
        // 自动加的条目：工具升级后路径变了（比如 Cursor Agent 的版本目录），跟着更新。
        bound.cmd = cmd;
        changes.push(`「${bound.name}」的位置变了（${h.label} 升级过），已更新。`);
      }
      continue;
    }
    if (removed.has(`h:${h.id}`)) continue;
    // 同一个工具、同一个模型的已经有一位了（Claude Code 和官方账号都是 Opus）：不再加一位
    const want = h.model.model ?? h.model.label;
    if (want && reg.agents.some((a) => agentKind(a) === 'cli' && toolFamily(a.harness) === toolFamily(h.id) && sameModel(memberModel(a, report) ?? '', want))) continue;
    let name = DEFAULT_NAMES[h.id] ?? h.id;
    for (let i = 2; names.has(name); i++) name = `${DEFAULT_NAMES[h.id] ?? h.id}${i}`;
    names.add(name);
    // 看不出用的哪个模型：按弱算（它做的活要复核），你在设置里可以改成强。
    const t = tierForModel(h.model.model);
    reg.agents.push({ name, label: LABELS[h.id] ?? h.label, kind: 'cli', cmd, tier: t === 'strong' ? 'strong' : 'weak', harness: h.id, detected: true });
    changes.push(`新加了 ${LABELS[h.id] ?? h.label}（${name}）。`);
  }

  for (const p of report.providers) {
    if (p.needsConsent || p.state !== 'ok' || !p.model) continue;
    const same = reg.agents.find((a) => agentKind(a) === 'api' && a.api && a.api.baseUrl.replace(/\/+$/, '') === p.baseUrl.replace(/\/+$/, ''));
    if (same || removed.has(`api:${p.baseUrl.replace(/\/+$/, '')}`)) continue;
    let name = p.id.replace(/[^a-zA-Z0-9_-]/g, '-');
    for (let i = 2; names.has(name); i++) name = `${p.id.replace(/[^a-zA-Z0-9_-]/g, '-')}${i}`;
    names.add(name);
    reg.agents.push({ name, label: p.label, kind: 'api', tier: 'weak', api: toApiSpec(p), model: p.model, detected: true });
    changes.push(`新加了模型接口 ${p.label}（${p.model}）。`);
  }

  // 桌面程序：同一家的命令行 / 接口在名单里，就记在它身上（同一个账号、同一个模型，是一位）；不然单独加一位。
  for (const app of report.apps) {
    const def = APPS.find((x) => x.name === app.name);
    if (!def || removed.has(`app:${def.name}`)) continue;
    const exists = reg.agents.some((a) => appNameOf(agentKind(a) === 'app' ? a.cmd : a.app) === def.name || (agentKind(a) === 'app' && a.name === def.id));
    if (exists || names.has(def.id)) continue;
    const q = /\s/.test(def.name) ? `"${def.name}"` : def.name;
    const entry: AgentConfig = { name: def.id, label: def.label, kind: 'app', cmd: `open -a ${q} {{dir}}`, tier: def.tier, detected: true };
    const sib = siblingOf(entry, reg.agents, report);
    if (sib && !sib.app) {
      sib.app = entry.cmd;
      changes.push(`桌面程序 ${def.label} 记在了 ${agentLabel(sib)} 名下。`);
      continue;
    }
    names.add(def.id);
    reg.agents.push(entry);
    changes.push(`新加了桌面程序 ${def.label}。`);
  }

  if (changes.length) {
    backupRegistryOnce();
    saveRegistry(reg);
  }
  return [...changes, ...tidyRegistry(report)];
}

// ---- 同一家的并成一位 ----

/**
 * 桌面程序和它的命令行 / 接口是一家（同一个账号、同一个模型）。harness：同一家的命令行工具；api：同一家的接口（按地址、密钥来源认）；
 * accept：只认用这种模型的（Claude 桌面版是官方账号，不会是被接到 DeepSeek 上的 Claude Code）。
 */
const FAMILIES: { app: RegExp; harness?: string[]; api?: RegExp; accept?: RegExp }[] = [
  { app: /cursor/i, harness: ['cursor-agent'] },
  // 桌面版的内核登不了国内编程套餐：没有 ZCode 命令行那位时，记到智谱接口（编程套餐的 API Key）名下
  { app: /zcode/i, harness: ['zcode'], api: /bigmodel\.cn|\bz\.ai\b/i },
  { app: /mimo/i, api: /mimo/i },
  { app: /deepseek/i, harness: ['dsh'] },
  { app: /chatgpt|codex/i, harness: ['codex'] },
  { app: /antigravity/i, harness: ['agy'] },
  { app: /^claude$/i, harness: ['claude-official', 'claude'], accept: /claude|opus|sonnet|fable|haiku/i },
];

/** 桌面程序在名单里的同一家：命令行 / 接口的那一位。 */
export function siblingOf(app: AgentConfig, all: AgentConfig[], report: DetectReport | null): AgentConfig | undefined {
  const f = FAMILIES.find((x) => x.app.test(appNameOf(app.cmd) ?? app.label ?? app.name));
  if (!f) return undefined;
  for (const h of f.harness ?? []) {
    const hit = all.find((x) => agentKind(x) === 'cli' && x.harness === h && (!f.accept || f.accept.test(memberModel(x, report) ?? '')));
    if (hit) return hit;
  }
  return f.api ? all.find((x) => agentKind(x) === 'api' && f.api!.test(`${x.api?.baseUrl ?? ''} ${x.api?.keyFrom ?? ''}`)) : undefined;
}

/**
 * 名单里重复的并成一位（识别完、接力台启动时各看一次，没有重复就什么都不改）：
 * - 同一个工具、同一个模型的（Claude Code 和 Claude Code 官方账号都是 Opus 5.5）：留派活顺序靠前的那位；
 * - 桌面程序并到同一家的命令行 / 接口上，记成它的 app（你自己接着做时打开它）。
 * 同一个模型、不同工具的不并：常常是两份额度（Cursor 里的 Opus 和 Claude Code 的 Opus），额度用完换人时用得上。
 */
export function tidyRegistry(report: DetectReport | null = loadDetected()): string[] {
  // 运行设置读不出来：派活顺序不知道，先不并（不然可能留错了那一位）。
  const auto = autoSettingsSafe();
  if (auto.error) return [];
  const reg = loadRegistry();
  const order = auto.settings.order;
  const rank = (a: AgentConfig) => {
    const i = order.indexOf(a.name);
    return i >= 0 ? i : order.length + reg.agents.indexOf(a);
  };
  const gone = new Set<AgentConfig>();
  const changes: string[] = [];
  const cli = reg.agents.filter((a) => agentKind(a) === 'cli' && a.harness).sort((a, b) => rank(a) - rank(b));
  cli.forEach((a, i) => {
    const ma = memberModel(a, report);
    if (gone.has(a) || !ma) return;
    for (const b of cli.slice(i + 1)) {
      const mb = memberModel(b, report);
      if (gone.has(b) || toolFamily(a.harness) !== toolFamily(b.harness) || !mb || !sameModel(ma, mb)) continue;
      gone.add(b);
      if (!a.app && b.app) a.app = b.app;
      changes.push(`「${agentLabel(b)}」和「${agentLabel(a)}」是同一个工具、同一个模型，并成了一位。`);
    }
  });
  for (const a of reg.agents) {
    if (agentKind(a) !== 'app' || gone.has(a)) continue;
    const sib = siblingOf(
      a,
      reg.agents.filter((x) => !gone.has(x)),
      report
    );
    if (!sib || sib.app) continue;
    sib.app = a.cmd;
    gone.add(a);
    changes.push(`桌面程序「${agentLabel(a)}」记在了「${agentLabel(sib)}」名下。`);
  }
  if (gone.size) {
    backupRegistryOnce();
    saveRegistry({ ...reg, agents: reg.agents.filter((a) => !gone.has(a)) });
  }
  return changes;
}

/** 用户同意后，启用一个要用别的工具密钥的接口（如 MiMo 的 Token Plan）。 */
export function enableProvider(report: DetectReport, id: string, name?: string): AgentConfig {
  const p = report.providers.find((x) => x.id === id);
  if (!p) throw new RelayError(`识别结果里没有 ${id}`, 'no-provider');
  const reg = loadRegistry();
  const existing = reg.agents.find((a) => a.api?.keyFrom === p.keyFrom && a.api?.baseUrl === p.baseUrl);
  if (existing) return existing;
  const names = new Set(reg.agents.map((a) => a.name));
  const want = name ?? (p.source === 'mimocode' ? 'mimo-api' : p.id.replace(/[^a-zA-Z0-9_-]/g, '-'));
  let n = want;
  for (let i = 2; names.has(n); i++) n = `${want}${i}`;
  // 强弱按接口里的模型算；认不出来的模型按弱。
  const agent: AgentConfig = { name: n, label: p.source === 'mimocode' ? 'MiMo 接口' : p.label, kind: 'api', tier: tierForModel(p.model) === 'strong' ? 'strong' : 'weak', api: toApiSpec(p), model: p.model, detected: true };
  reg.agents.push(agent);
  backupRegistryOnce();
  saveRegistry(reg);
  // 同一家的桌面程序之前没处挂、单独占着一位：现在记到它名下
  tidyRegistry(report);
  return agent;
}

// ---- 谁能全自动干活 ----

export interface Member {
  agent: AgentConfig;
  name: string;
  label: string;
  /** 这一位用的模型（显示用）：名单里指定的 > 工具的默认。 */
  model?: string;
  kind: 'harness' | 'api';
  harness?: string;
  canWork: boolean;
  /** 不能用的原因。 */
  why?: string;
}

export function memberModel(a: AgentConfig, report: DetectReport | null): string | undefined {
  if (a.kind === 'api') return agentModel(a);
  if (a.model?.trim()) return a.model.trim();
  const h = harnessOf(a);
  if (h) {
    const hr = report?.harnesses.find((x) => x.id === h.id);
    return hr?.model.label ?? hr?.model.model;
  }
  return a.api?.model;
}

/** 名单里每一位在全自动里能干什么。 */
export function listMembers(level: Level, report: DetectReport | null = loadDetected()): Member[] {
  const out: Member[] = [];
  for (const a of loadRegistry().agents) {
    const kind = agentKind(a);
    const base = { agent: a, name: a.name, label: agentLabel(a), model: memberModel(a, report) };
    if (kind === 'api') {
      if (!a.api) continue;
      const ok = apiUsable(a.api);
      out.push({ ...base, kind: 'api', canWork: ok, ...(ok ? {} : { why: '没有密钥' }) });
      continue;
    }
    const spec = harnessOf(a);
    if (!spec || kind !== 'cli') continue;
    const hr = report?.harnesses.find((x) => x.id === spec.id);
    let why: string | undefined;
    // 识别结果里有它就不再现找（现找要运行一遍它的 --version；网页每隔几秒要一次成员，找工具的缓存一过期就会卡住整个接力台）。
    // 识别结果里没有（没识别过、或者识别之后才装的）才现找：没装的工具找得很快，装了的只在这时慢一次。
    if (!hr && !locateCached(spec)) why = '这台电脑上没找到';
    else if (hr?.login.state === 'no') why = '没登录';
    // 档位不够，或者你给它的设置让安全档守不住：列出来，但不派活
    const held = !spec.workLevels.includes(level) ? '权限「只在项目里」时不能无人值守地干活' : level === 'safe' ? spec.unsafe?.() : undefined;
    out.push({
      ...base,
      kind: 'harness',
      harness: spec.id,
      canWork: !why && !held,
      ...(why || held ? { why: why ?? held } : {}),
    });
  }
  return out;
}
