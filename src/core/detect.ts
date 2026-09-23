import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanApps } from './env';
import { checkCommand } from './launch';
import { findHarness, HARNESSES, harnessForCommand, locateCached, clearLocateCache, type HarnessSpec, type Level, type LoginInfo, type ModelInfo } from './harness';
import { apiUsable } from './llm';
import { relayHome } from './paths';
import { scanProviders, toApiSpec, type DetectedProvider } from './providers';
import { agentKind, agentLabel, agentModel, loadRegistry, registryPath, saveRegistry } from './registry';
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

const APPS: { name: string; hint: string }[] = [
  { name: 'Cursor', hint: '桌面版只能手动用；全自动用 Cursor Agent（同一个账号、同样的模型）。' },
  { name: 'ZCode', hint: '桌面版只能手动用；全自动用它自带的命令行内核（ZCode 命令行）。' },
  { name: 'Xiaomi MiMo', hint: '没有命令行；全自动可以用它的 Token Plan 接口（要你同意）。' },
  { name: 'ChatGPT', hint: '只能手动用；全自动用 Codex。' },
  { name: 'Claude', hint: '只能手动用；全自动用 Claude Code。' },
  { name: 'Codex', hint: '只能手动用；全自动用 Codex 命令行。' },
  { name: 'Trae', hint: '只能手动用。' },
  { name: 'Windsurf', hint: '只能手动用。' },
  { name: 'Kiro', hint: '只能手动用。' },
  { name: 'Qoder', hint: '只能手动用。' },
  { name: 'CodeBuddy', hint: '只能手动用。' },
  { name: 'Antigravity', hint: '只能手动用；全自动用 agy 命令行。' },
];

function findApps(): AppReport[] {
  if (process.platform !== 'darwin' || !scanApps()) return [];
  const dirs = ['/Applications', path.join(os.homedir(), 'Applications')];
  return APPS.filter((a) => dirs.some((d) => fs.existsSync(path.join(d, `${a.name}.app`)))).map((a) => ({ ...a }));
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
  return {
    id: spec.id,
    label: spec.label,
    vendor: spec.vendor,
    version: loc.version,
    where: loc.where,
    ...(loc.note ? { note: loc.note } : {}),
    login,
    model,
    workLevels: spec.workLevels,
    canReview: spec.canReview,
    tested: spec.tested,
    loginHint: spec.loginHint,
  };
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
const DEFAULT_NAMES: Record<string, string> = { claude: 'claude', codex: 'codex', 'cursor-agent': 'cursor-agent', zcode: 'zcode-cli', agy: 'agy', gemini: 'gemini', qwen: 'qwen', opencode: 'opencode', droid: 'droid', copilot: 'copilot', grok: 'grok' };

const LABELS: Record<string, string> = { zcode: 'ZCode 命令行' };

/** 手动在终端里用时，第一句话怎么喂：大多数工具认「第一个参数是提示词」；ZCode / OpenCode 不认，只提示人转告。 */
const MANUAL_MODE: Record<string, 'arg' | 'file'> = { zcode: 'file', opencode: 'file' };

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
  const reg = loadRegistry();
  const changes: string[] = [];
  const names = new Set(reg.agents.map((a) => a.name));

  for (const a of reg.agents) {
    if (agentKind(a) === 'app' && /^cursor(\s|$)/.test((a.cmd ?? '').trim())) {
      const chk = checkCommand(a.cmd ?? '');
      if (!chk.ok) {
        a.cmd = 'open -a Cursor {{worktree}}';
        changes.push(`「${agentLabel(a)}」的打开命令坏了（cursor 命令其实是 cursor-agent），改成了 open -a Cursor {{worktree}}。`);
      }
    }
  }

  for (const h of report.harnesses) {
    if (h.login.state === 'no') continue;
    const loc = locateCached(findHarness(h.id)!);
    const cmd = loc ? loc.exec.map((x) => (/[\s"']/.test(x) ? `'${x.replace(/'/g, `'\\''`)}'` : x)).join(' ') : h.id;
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
    let name = DEFAULT_NAMES[h.id] ?? h.id;
    for (let i = 2; names.has(name); i++) name = `${DEFAULT_NAMES[h.id] ?? h.id}${i}`;
    names.add(name);
    reg.agents.push({ name, label: LABELS[h.id] ?? h.label, kind: 'cli', cmd, tier: 'strong', prompt: { mode: MANUAL_MODE[h.id] ?? 'arg' }, harness: h.id, detected: true });
    changes.push(`新加了 ${LABELS[h.id] ?? h.label}（${name}）。`);
  }

  for (const p of report.providers) {
    if (p.needsConsent || p.state !== 'ok' || !p.model) continue;
    const same = reg.agents.find((a) => agentKind(a) === 'api' && a.api && a.api.baseUrl.replace(/\/+$/, '') === p.baseUrl.replace(/\/+$/, ''));
    if (same) continue;
    let name = p.id.replace(/[^a-zA-Z0-9_-]/g, '-');
    for (let i = 2; names.has(name); i++) name = `${p.id.replace(/[^a-zA-Z0-9_-]/g, '-')}${i}`;
    names.add(name);
    reg.agents.push({ name, label: p.label, kind: 'api', tier: 'weak', api: toApiSpec(p), model: p.model, detected: true });
    changes.push(`新加了模型接口 ${p.label}（${p.model}）。`);
  }

  if (changes.length) {
    backupRegistryOnce();
    saveRegistry(reg);
  }
  return changes;
}

/** 用户同意后，启用一个要用别的工具密钥的接口（如 MiMo 的 Token Plan）。 */
export function enableProvider(report: DetectReport, id: string, name?: string): AgentConfig {
  const p = report.providers.find((x) => x.id === id);
  if (!p) throw new Error(`识别结果里没有 ${id}，先重新识别一次。`);
  const reg = loadRegistry();
  const existing = reg.agents.find((a) => a.api?.keyFrom === p.keyFrom && a.api?.baseUrl === p.baseUrl);
  if (existing) return existing;
  const names = new Set(reg.agents.map((a) => a.name));
  let n = name ?? (p.source === 'mimocode' ? 'mimo-api' : p.id.replace(/[^a-zA-Z0-9_-]/g, '-'));
  for (let i = 2; names.has(n); i++) n = `${name ?? 'mimo-api'}${i}`;
  const agent: AgentConfig = { name: n, label: p.source === 'mimocode' ? 'MiMo 接口' : p.label, kind: 'api', tier: 'strong', api: toApiSpec(p), model: p.model, detected: true };
  reg.agents.push(agent);
  backupRegistryOnce();
  saveRegistry(reg);
  return agent;
}

// ---- 谁能全自动干活 / 审查 ----

export interface Member {
  agent: AgentConfig;
  name: string;
  label: string;
  /** 这一位用的模型（显示用）：名单里指定的 > 工具的默认。 */
  model?: string;
  kind: 'harness' | 'api';
  harness?: string;
  canWork: boolean;
  canReview: boolean;
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
      out.push({ ...base, kind: 'api', canWork: ok, canReview: ok, ...(ok ? {} : { why: '没有密钥' }) });
      continue;
    }
    const spec = harnessOf(a);
    if (!spec || kind !== 'cli') continue;
    const hr = report?.harnesses.find((x) => x.id === spec.id);
    let why: string | undefined;
    if (!locateCached(spec)) why = '这台电脑上找不到它';
    else if (hr?.login.state === 'no') why = `没登录：${spec.loginHint}`;
    const work = !why && spec.workLevels.includes(level);
    out.push({
      ...base,
      kind: 'harness',
      harness: spec.id,
      canWork: work,
      canReview: !why && spec.canReview,
      ...(why ? { why } : !work ? { why: '只有「完全放开」档才能无人值守地干活' } : {}),
    });
  }
  return out;
}

function rankOf(m: Member): number {
  if (m.kind === 'api') return 1000;
  return findHarness(m.harness)?.rank ?? 500;
}

/** 按设置排出干活的人和审查的人。设置里没写就按默认顺序（编程工具在前，模型接口在后）。 */
export function resolveTeam(
  members: Member[],
  want: { workers: string[]; reviewers: string[] }
): { workers: Member[]; reviewers: Member[]; problems: string[] } {
  const problems: string[] = [];
  const pick = (names: string[], ok: (m: Member) => boolean, what: string): Member[] => {
    if (!names.length) return members.filter(ok).sort((a, b) => rankOf(a) - rankOf(b));
    const out: Member[] = [];
    for (const n of names) {
      const m = members.find((x) => x.name === n);
      if (!m) problems.push(`「${n}」不在工人名单里。`);
      else if (!ok(m)) problems.push(`「${m.label}」现在不能${what}${m.why ? `：${m.why}` : ''}。`);
      else if (!out.includes(m)) out.push(m);
    }
    return out;
  };
  return { workers: pick(want.workers, (m) => m.canWork, '干活'), reviewers: pick(want.reviewers, (m) => m.canReview, '审查'), problems };
}
