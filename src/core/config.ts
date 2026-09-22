import fs from 'node:fs';
import path from 'node:path';
import type { RelayConfig } from './types';

export function relayConfigPath(repoRoot: string): string {
  return path.join(repoRoot, '.relay', 'config.json');
}

/** init 样例与 loadRelayConfig 补默认共用的默认配置（两处必须一致，改就一起改）。 */
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

/** 缺省补默认后须仍是字符串，否则报错（不要静默当通过）。显式 null 算类型不对，不补默认。 */
function reqString(value: unknown, field: string, p: string): string {
  if (typeof value !== 'string') {
    const got = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    throw new Error(`${p} 的 ${field} 必须是字符串（当前是 ${got}）。`);
  }
  return value;
}

/** 只有「字段不存在」（undefined）才补默认；显式 null 是类型错误。 */
function orDefault(value: unknown, fallback: unknown): unknown {
  return value === undefined ? fallback : value;
}

function asObject(value: unknown, field: string, p: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    const got = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    throw new Error(`${p} 的 ${field} 必须是对象（当前是 ${got}）。`);
  }
  return value as Record<string, unknown>;
}

/**
 * 读 .relay/config.json：坏 JSON / 字段类型不对 → 人类可读报错（带路径）；
 * 缺字段按 defaultRelayConfig 补默认。密钥只认环境变量名（apiKeyEnv），本函数绝不写文件。
 */
export function loadRelayConfig(repoRoot: string): RelayConfig {
  const p = relayConfigPath(repoRoot);
  if (!fs.existsSync(p)) throw new Error(`未找到 ${p}。请先在目标项目里执行 relay init。`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${p} 不是合法 JSON：${msg}。请修复，或删除该文件后重跑 relay init。`);
  }
  const obj = asObject(raw, '根节点', p);

  const defaults = defaultRelayConfig();
  const gate = asObject(orDefault(obj.gate, {}), 'gate', p);
  const command = reqString(orDefault(gate.command, defaults.gate.command), 'gate.command', p);

  const protectedPaths = orDefault(obj.protectedPaths, defaults.protectedPaths);
  if (!Array.isArray(protectedPaths) || protectedPaths.some((x) => typeof x !== 'string')) {
    throw new Error(`${p} 的 protectedPaths 必须是字符串数组（当前是 ${typeof protectedPaths}）。`);
  }

  const auditIn = asObject(orDefault(obj.audit, {}), 'audit', p);
  const audit = {
    baseUrl: reqString(orDefault(auditIn.baseUrl, defaults.audit.baseUrl), 'audit.baseUrl', p),
    model: reqString(orDefault(auditIn.model, defaults.audit.model), 'audit.model', p),
    apiKeyEnv: reqString(orDefault(auditIn.apiKeyEnv, defaults.audit.apiKeyEnv), 'audit.apiKeyEnv', p),
  };

  return { gate: { command }, protectedPaths, audit };
}
