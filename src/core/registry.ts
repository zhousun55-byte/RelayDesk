import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentsRegistry } from './types';

export function registryPath(): string {
  return path.join(os.homedir(), '.relay', 'agents.json');
}

export function loadRegistry(): AgentsRegistry {
  const p = registryPath();
  if (!fs.existsSync(p)) return { agents: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    throw new Error(`注册表损坏（不是合法 JSON）：${p}，请手工修复或删除。`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as Partial<AgentsRegistry>).agents)
  ) {
    throw new Error(`注册表格式不对：${p}，应为 { "agents": [...] }。`);
  }
  return parsed as AgentsRegistry;
}

export function saveRegistry(reg: AgentsRegistry): void {
  const p = registryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(reg, null, 2) + '\n');
}
