import os from 'node:os';
import path from 'node:path';

/** 接力台自己的目录（全机通用的设置：工人名单、识别结果、额度、最近的项目）。 */
export function relayHome(): string {
  const override = process.env.RELAY_HOME;
  return override && override.trim() ? path.resolve(override) : path.join(os.homedir(), '.relay');
}

export function isInside(parent: string, child: string): boolean {
  const base = path.resolve(parent);
  const target = path.resolve(child);
  return target === base || target.startsWith(base + path.sep);
}
