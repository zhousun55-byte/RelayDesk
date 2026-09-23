import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from './errors';
import type { RelayConfig } from './types';

export function relayConfigPath(repoRoot: string): string {
  return path.join(repoRoot, '.relay', 'config.json');
}

export function defaultRelayConfig(): RelayConfig {
  return {
    gate: { command: '' },
    protectedPaths: [],
    audit: {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
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

  const auditIn = asObject(orDefault(obj.audit, {}), 'audit', where);
  const audit = {
    baseUrl: reqString(orDefault(auditIn.baseUrl, d.audit.baseUrl), 'audit.baseUrl', where).trim(),
    model: reqString(orDefault(auditIn.model, d.audit.model), 'audit.model', where).trim(),
    apiKeyEnv: reqString(orDefault(auditIn.apiKeyEnv, d.audit.apiKeyEnv), 'audit.apiKeyEnv', where).trim(),
  };
  if (audit.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(audit.apiKeyEnv)) {
    throw new RelayError(`${where} 里的 audit.apiKeyEnv 要填环境变量的名字（如 DEEPSEEK_API_KEY），不是密钥本身。`, 'bad-config');
  }
  return {
    gate: { command },
    protectedPaths: (protectedPaths as string[]).map((p) => p.trim()).filter(Boolean),
    audit,
  };
}

/** 读 .relay/config.json：坏 JSON / 类型不对 → 人能看懂的报错；缺字段补默认。 */
export function loadRelayConfig(repoRoot: string): RelayConfig {
  const p = relayConfigPath(repoRoot);
  if (!fs.existsSync(p)) {
    throw new RelayError('这个文件夹还不是接力项目。先执行 relay init，或在接力台里按「设为接力项目」。', 'no-config');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new RelayError(`${p} 不是合法的 JSON（${msg}）。修好它，或删掉后重新设为接力项目。`, 'bad-config');
  }
  return normalizeConfig(raw, p);
}

export function saveRelayConfig(repoRoot: string, cfg: RelayConfig): RelayConfig {
  const clean = normalizeConfig(cfg);
  fs.mkdirSync(path.dirname(relayConfigPath(repoRoot)), { recursive: true });
  fs.writeFileSync(relayConfigPath(repoRoot), JSON.stringify(clean, null, 2) + '\n');
  return clean;
}
