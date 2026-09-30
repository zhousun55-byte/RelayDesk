import fs from 'node:fs';
import path from 'node:path';
import { RelayError } from './errors';
import type { Level } from './harness';
import { relayHome } from './paths';

/** 接力台调度的设置（全机通用，存在 ~/.relay/auto.json）。 */
export interface AutoSettings {
  /** 派活的顺序（工人名）。空 = 强的在前、编程工具在前。额度用完的自动跳过。 */
  order: string[];
  /** 权限。safe（只在项目里）：改文件只限项目文件夹、命令进工具自己的沙箱；full（不限制）：工具不再拦任何操作。 */
  level: Level;
  /** 干活一棒最长多少分钟。 */
  stintTimeoutMin: number;
  /** 复核 / 终审一棒最长多少分钟。 */
  reviewTimeoutMin: number;
  /** 全自动最多接力几棒（防止没完没了）。 */
  maxStints: number;
  /** 所有人都没额度时，等最早恢复的那一位（不等就停下）。 */
  waitForQuota: boolean;
  /** 任务清单全部打勾后，请强模型把整件事过一遍再算完成。 */
  finalReview: boolean;
  /** 网页用的语言（网页上换语言时顺手存进来）：en 时请 AI 用英文写交接、复核和回答。 */
  lang: 'zh' | 'en';
  /** 派活谁来指挥（拆步骤、终审）：成员名。空 = 强模型按顺序。 */
  lead: string;
  /** 同一个任务里，一位成员下一棒接着自己上一棒在工具里的那段对话（工具里一个任务就是一段对话）。不接 = 每棒新开，省 token。 */
  sameThread: boolean;
  /** 左边列出这个项目文件夹里、你自己在 Claude Code、Codex 里开的对话。 */
  showSessions: boolean;
  /** 派活时边做边复核：弱模型做下一步的同时，强模型只看不改地复核上一步（省掉最后集中复核的时间）。 */
  sideReview: boolean;
  /** 技能怎么用（技能名 → off 不用 / always 每次都带上）；没写的 = 写了 /技能名 才带上。 */
  skills: Record<string, SkillMode>;
}

export type SkillMode = 'off' | 'always';

export function defaultAutoSettings(): AutoSettings {
  return { order: [], level: 'safe', stintTimeoutMin: 60, reviewTimeoutMin: 30, maxStints: 12, waitForQuota: true, finalReview: true, lang: 'zh', lead: '', sameThread: false, showSessions: true, sideReview: true, skills: {} };
}

export function autoSettingsPath(): string {
  return path.join(relayHome(), 'auto.json');
}

function names(v: unknown, field: string): string[] {
  if (v === undefined || v === null || v === '') return [];
  const list = typeof v === 'string' ? v.split(/[,，\s]+/) : v;
  if (!Array.isArray(list)) throw new RelayError(`${field} 要是成员名的列表`, 'bad-auto');
  return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))].slice(0, 30);
}

function int(v: unknown, field: string, min: number, max: number, dflt: number): number {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new RelayError(`${field} 要是 ${min}–${max} 之间的整数。`, 'bad-auto');
  return n;
}

function bool(v: unknown, dflt: boolean): boolean {
  return v === undefined || v === null ? dflt : v === true || v === 'true';
}

export function normalizeAutoSettings(raw: unknown): AutoSettings {
  const d = defaultAutoSettings();
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const level = o.level === undefined ? d.level : o.level;
  if (level !== 'safe' && level !== 'full') throw new RelayError('权限只能是 safe（只在项目里）或 full（不限制）。', 'bad-auto');
  // 1.x 的设置：干活的人 workers 当成派活顺序。
  const order = o.order !== undefined ? names(o.order, '派活顺序') : names(o.workers, '派活顺序');
  return {
    order,
    level,
    stintTimeoutMin: int(o.stintTimeoutMin ?? o.workTimeoutMin, '一棒的时限', 1, 600, d.stintTimeoutMin),
    reviewTimeoutMin: int(o.reviewTimeoutMin, '复核的时限', 1, 240, d.reviewTimeoutMin),
    maxStints: int(o.maxStints, '最多几棒', 1, 100, d.maxStints),
    waitForQuota: bool(o.waitForQuota, d.waitForQuota),
    finalReview: bool(o.finalReview, d.finalReview),
    lang: o.lang === 'en' ? 'en' : 'zh',
    lead: names(o.lead, '派活谁来指挥')[0] ?? '',
    sameThread: bool(o.sameThread, d.sameThread),
    showSessions: bool(o.showSessions, d.showSessions),
    sideReview: bool(o.sideReview, d.sideReview),
    skills: skillModes(o.skills),
  };
}

function skillModes(v: unknown): Record<string, SkillMode> {
  const out: Record<string, SkillMode> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, m] of Object.entries(v as Record<string, unknown>).slice(0, 500)) {
    const name = k.trim().slice(0, 120);
    if (name && (m === 'off' || m === 'always')) out[name] = m;
  }
  return out;
}

/**
 * 网页是英文时加在给 AI 的话后面：交接、复核、回答都用英文写。接力台要认的几样（小节标题、状态、结论的选项、
 * 文件名）照原样写中文，不然读不出来。中文时什么都不加。
 */
export function langNote(lang: AutoSettings['lang'] = safeLang()): string {
  if (lang !== 'en') return '';
  return '\n\nLanguage: the person running RelayDesk reads English. Write everything meant for people (handoff contents, review findings, replies, checklist steps you add) in English. Keep the words RelayDesk parses exactly as given above, in Chinese: section headings, status words, verdict choices and file names.';
}

function safeLang(): AutoSettings['lang'] {
  try {
    return loadAutoSettings().lang;
  } catch {
    return 'zh';
  }
}

/**
 * 读运行设置。只有文件还不存在时用默认设置；文件在、却读不出来（JSON 写坏了、值不对）就报错，
 * 不能悄悄换成默认的——派活顺序、权限、时限、要不要终审都会跟着变，你还不知道。
 */
export function loadAutoSettings(): AutoSettings {
  const p = autoSettingsPath();
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return defaultAutoSettings();
    throw new RelayError(`${p} 读不出来：${(e as Error).message}`, 'bad-settings');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new RelayError(`${p} 不是完整的 JSON（${(e as Error).message}）：改好它，或者恢复默认（网页「设置 → 运行」、relay settings --reset）`, 'bad-settings');
  }
  try {
    return normalizeAutoSettings(raw);
  } catch (e) {
    if (e instanceof RelayError) throw new RelayError(`${p} 有问题：${e.message}`, e.code);
    throw e;
  }
}

/** 给人看的地方用（网页、成员名单）：读不出来就先按默认的显示，同时带上原因（网页顶上会提示）。 */
export function autoSettingsSafe(): { settings: AutoSettings; error?: string } {
  try {
    return { settings: loadAutoSettings() };
  } catch (e) {
    return { settings: defaultAutoSettings(), error: e instanceof Error ? e.message : String(e) };
  }
}

/** 存设置。原来的文件读不出来：先留一份 auto.json.broken，再写新的。 */
export function saveAutoSettings(raw: unknown): AutoSettings {
  const s = normalizeAutoSettings(raw);
  const p = autoSettingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p) && autoSettingsSafe().error) fs.copyFileSync(p, `${p}.broken`);
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  return s;
}
