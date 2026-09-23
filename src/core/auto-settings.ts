import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from './errors';
import type { Level } from './harness';
import { relayHome } from './paths';

/** 全自动流水线的设置（全机通用，存在 ~/.relay/auto.json）。 */
export interface AutoSettings {
  /** 干活的人（工人名），按优先级。空 = 自动排（编程工具在前）。第一位是主力，失败了才轮到下一位。 */
  workers: string[];
  /** 审查的人，按优先级。空 = 自动排。每一轮会挑一个和干活的人不同的。 */
  reviewers: string[];
  /** 最多改几轮（干活 → 审查算一轮）。 */
  maxRounds: number;
  /** 审查通过后自动合回正式文件夹。 */
  autoMerge: boolean;
  /** safe：只改隔离副本、命令进沙箱；full：完全放开。 */
  level: Level;
  /** 干活一段最长多少分钟。 */
  workTimeoutMin: number;
  /** 审查一次最长多少分钟。 */
  reviewTimeoutMin: number;
}

export function defaultAutoSettings(): AutoSettings {
  return { workers: [], reviewers: [], maxRounds: 3, autoMerge: true, level: 'safe', workTimeoutMin: 60, reviewTimeoutMin: 20 };
}

export function autoSettingsPath(): string {
  return path.join(relayHome(), 'auto.json');
}

function names(v: unknown, field: string): string[] {
  if (v === undefined || v === null || v === '') return [];
  const list = typeof v === 'string' ? v.split(/[,，\s]+/) : v;
  if (!Array.isArray(list)) throw new RelayError(`${field} 要是工人名的列表。`, 'bad-auto');
  return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))].slice(0, 20);
}

function int(v: unknown, field: string, min: number, max: number, dflt: number): number {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new RelayError(`${field} 要是 ${min}–${max} 之间的整数。`, 'bad-auto');
  return n;
}

export function normalizeAutoSettings(raw: unknown): AutoSettings {
  const d = defaultAutoSettings();
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const level = o.level === undefined ? d.level : o.level;
  if (level !== 'safe' && level !== 'full') throw new RelayError('权限档位只能是 safe（安全）或 full（完全放开）。', 'bad-auto');
  return {
    workers: names(o.workers, '干活的人'),
    reviewers: names(o.reviewers, '审查的人'),
    maxRounds: int(o.maxRounds, '最多轮数', 1, 10, d.maxRounds),
    autoMerge: o.autoMerge === undefined ? d.autoMerge : o.autoMerge === true,
    level,
    workTimeoutMin: int(o.workTimeoutMin, '干活时限', 1, 600, d.workTimeoutMin),
    reviewTimeoutMin: int(o.reviewTimeoutMin, '审查时限', 1, 120, d.reviewTimeoutMin),
  };
}

export function loadAutoSettings(): AutoSettings {
  try {
    return normalizeAutoSettings(JSON.parse(fs.readFileSync(autoSettingsPath(), 'utf8')));
  } catch (e) {
    if (e instanceof RelayError) throw new RelayError(`${autoSettingsPath()} 有问题：${e.message}`, e.code);
    return defaultAutoSettings();
  }
}

export function saveAutoSettings(raw: unknown): AutoSettings {
  const s = normalizeAutoSettings(raw);
  fs.mkdirSync(path.dirname(autoSettingsPath()), { recursive: true });
  fs.writeFileSync(autoSettingsPath(), JSON.stringify(s, null, 2) + '\n');
  return s;
}
