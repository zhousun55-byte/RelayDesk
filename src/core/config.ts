import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from './errors';
import { loadMemory } from './memory';
import { relayHome } from './paths';
import type { RelayConfig } from './types';

export function relayConfigPath(repoRoot: string): string {
  return path.join(repoRoot, '.relay', 'config.json');
}

export function defaultRelayConfig(): RelayConfig {
  return {
    gate: { command: '' },
    protectedPaths: [],
  };
}

function typeName(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? '数组' : typeof v;
}

function reqString(value: unknown, field: string, where: string): string {
  if (typeof value !== 'string') throw new RelayError(`${where} 里的 ${field} 必须是文字（现在是 ${typeName(value)}）。`, 'bad-config');
  return value;
}

function asObject(value: unknown, field: string, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RelayError(`${where} 里的 ${field} 必须是对象（现在是 ${typeName(value)}）。`, 'bad-config');
  }
  return value as Record<string, unknown>;
}

/** 只有「字段不存在」才补默认；写成 null 算写错了。 */
function orDefault(value: unknown, fallback: unknown): unknown {
  return value === undefined ? fallback : value;
}

/** 校验并补默认。用于读文件，也用于网页提交的设置。 */
export function normalizeConfig(raw: unknown, where = '接力配置'): RelayConfig {
  const obj = asObject(raw, '根节点', where);
  const d = defaultRelayConfig();
  const gate = asObject(orDefault(obj.gate, {}), 'gate', where);
  const command = reqString(orDefault(gate.command, d.gate.command), 'gate.command', where).trim();

  const protectedPaths = orDefault(obj.protectedPaths, d.protectedPaths);
  if (!Array.isArray(protectedPaths) || protectedPaths.some((x) => typeof x !== 'string')) {
    throw new RelayError(`${where} 里的 protectedPaths 必须是文字列表（现在是 ${typeName(protectedPaths)}）。`, 'bad-config');
  }

  // 1.x 的 audit（交接时请便宜模型写摘要）已经不用了：旧配置里有也不报错，保存时去掉。
  return {
    gate: { command },
    protectedPaths: (protectedPaths as string[]).map((p) => p.trim()).filter(Boolean),
  };
}

/** 读 .relay/config.json：坏 JSON / 类型不对 → 人能看懂的报错；缺字段补默认。 */
export function loadRelayConfig(repoRoot: string): RelayConfig {
  const p = relayConfigPath(repoRoot);
  if (!fs.existsSync(p)) {
    throw new RelayError('这个文件夹还没接入接力台', 'no-config');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new RelayError(`${p} 不是合法的 JSON（${msg}）。修好它，或删掉后重新接入。`, 'bad-config');
  }
  return normalizeConfig(raw, p);
}

/** 网页「设置 → 项目」、relay config 保存：人看过、自己定的，检查命令算确认过。 */
export function saveRelayConfig(repoRoot: string, cfg: RelayConfig): RelayConfig {
  const clean = normalizeConfig(cfg);
  fs.mkdirSync(path.dirname(relayConfigPath(repoRoot)), { recursive: true });
  fs.writeFileSync(relayConfigPath(repoRoot), JSON.stringify(clean, null, 2) + '\n');
  confirmGateCommand(repoRoot, clean.gate.command);
  return clean;
}

// ---- 检查命令：确认过的才自动跑 ----
// 检查命令是一整行 shell，接力台在项目里替人跑，不受 AI「只在项目里」的限制。可 .relay/config.json 在项目里：
// 会跟着 git 进别人克隆的仓库，正在干活的 AI 也改得到。所以只跑这台电脑上确认过的那一条——
// 网页「设置 → 项目」或 relay config 保存过的。确认记在接力台自己的目录里，项目里的文件说了不算。

export const GATE_UNCONFIRMED = '检查命令和这台电脑上确认过的不一样（可能是项目自带的，或者被改过），没有执行。到「设置 → 项目」看一眼再保存，或运行 relay config --gate 定下来。';

const gateOkPath = () => path.join(relayHome(), 'gate-ok.json');

/** 同一个文件夹换个写法（/tmp 和 /private/tmp、结尾多个斜杠）也是同一个。 */
function gateKey(root: string): string {
  try {
    return fs.realpathSync.native(root);
  } catch {
    return path.resolve(root);
  }
}

/** 读确认过的检查命令；还没有这个文件（刚升级上来）或读不出来时返回 null。 */
function loadGateOk(): Record<string, string> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(gateOkPath(), 'utf8')) as { projects?: unknown };
    const out: Record<string, string> = {};
    if (raw && typeof raw.projects === 'object' && raw.projects) {
      for (const [k, v] of Object.entries(raw.projects as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

function saveGateOk(projects: Record<string, string>): void {
  fs.mkdirSync(relayHome(), { recursive: true });
  fs.writeFileSync(gateOkPath(), JSON.stringify({ projects }, null, 2) + '\n');
}

/**
 * 第一次用到确认（刚升级上来）：这台电脑上最近打开过、接入过的项目，现在的检查命令都算确认过——
 * 它们本来就一直在这里跑，升级不能让它们停下。没打开过的（比如刚克隆来的）不算。
 */
function adoptKnownGates(): Record<string, string> {
  const m = loadMemory();
  const out: Record<string, string> = {};
  for (const root of new Set([...(m.root ? [m.root] : []), ...(m.recents ?? [])])) {
    if (!fs.existsSync(path.join(root, '.relay', 'journal.jsonl'))) continue;
    try {
      const cmd = loadRelayConfig(root).gate.command.trim();
      if (cmd) out[gateKey(root)] = cmd;
    } catch {
      /* 配置读不出来：不算确认过 */
    }
  }
  saveGateOk(out);
  return out;
}

/**
 * 接力台一启动就把升级前的项目记下来（命令行每条命令、网页服务开起来时都调用）。
 * 不能等到第一次跑检查才记：那之前新克隆、新打开的项目会被一起当成确认过。
 */
export function ensureGateOk(): void {
  if (!loadGateOk()) adoptKnownGates();
}

export function confirmGateCommand(root: string, command: string): void {
  const all = loadGateOk() ?? adoptKnownGates();
  const cmd = command.trim();
  if (cmd) all[gateKey(root)] = cmd;
  else delete all[gateKey(root)];
  saveGateOk(all);
}

/** 这个项目现在的检查命令确认过没有（没配检查命令的不用跑，算确认过）。 */
export function gateConfirmed(root: string, command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return true;
  return (loadGateOk() ?? adoptKnownGates())[gateKey(root)] === cmd;
}
