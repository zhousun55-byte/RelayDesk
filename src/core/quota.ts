import fs from 'node:fs';
import path from 'node:path';
import { relayHome } from './paths';

/**
 * 额度：认出各家「额度用完 / 次数用完 / 余额不足」的提示，记下什么时候恢复（~/.relay/quota.json）。
 * 全机通用：额度跟着账号走，不跟着项目走。
 */

const HIT = new RegExp(
  [
    'usage[ _-]?limit',
    // Claude Code：「You've hit your session limit」「hit your weekly / Opus limit」「Weekly limit reached」
    'hit your (?:[\\w-]+ )?limit',
    'limit (?:reached|exceeded)',
    'reached (?:your|the) (?:[\\w-]+ )?limit',
    'quota',
    'insufficient[ _](?:balance|quota|credits?)',
    'credit balance is too low',
    'out of credits',
    'exceeded your current',
    'too many requests',
    'rate[ _-]?limit(?:ed)?',
    'resource[ _]exhausted',
    'upgrade to (?:pro|plus|max)',
    '额度',
    '余额不足',
    '用量(?:已)?(?:达到)?上限',
    '次数(?:已)?(?:达到)?上限',
    '已达(?:到)?(?:使用)?上限',
    '资源包',
    '请求过于频繁',
    '速率限制',
  ].join('|'),
  'i'
);

export interface QuotaHit {
  hit: boolean;
  /** 什么时候恢复（认得出来的话）。 */
  until?: string;
  /** 命中的那一行（给人看）。 */
  line?: string;
}

const UNITS: [RegExp, number][] = [
  [/(\d+)\s*(?:days?|d\b|天)/i, 86_400_000],
  [/(\d+)\s*(?:hours?|hrs?|h\b|小时)/i, 3_600_000],
  [/(\d+)\s*(?:minutes?|mins?|m\b|分钟)/i, 60_000],
  [/(\d+)\s*(?:seconds?|secs?|s\b|秒)/i, 1_000],
];

/** 「try again in 2 days 3 hours」「3 小时后」这种相对时间。 */
function relative(text: string, now: Date): Date | null {
  const m = text.match(/(?:try again in|retry in|resets? in|in about|after|等待|请在|约)\s*((?:\d+\s*[a-z\u4e00-\u9fa5]+[\s,，]*){1,4})/i) ?? text.match(/((?:\d+\s*(?:days?|hours?|minutes?|天|小时|分钟)[\s,，]*){1,4})\s*(?:后|later)/i);
  if (!m) return null;
  let ms = 0;
  for (const [re, unit] of UNITS) {
    const x = m[1].match(re);
    if (x) ms += Number(x[1]) * unit;
  }
  return ms > 0 ? new Date(now.getTime() + ms) : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** 提示里写的时区：「resets 3:50am (Asia/Shanghai)」。没写或认不出就用这台电脑的时区。 */
function zoneOf(text: string): string | undefined {
  const m = text.match(/\(\s*((?:[A-Za-z]+\/)+[A-Za-z0-9_+-]+|UTC|GMT)\s*\)/);
  if (!m) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: m[1] });
    return m[1];
  } catch {
    return undefined;
  }
}

/** ms 这一刻在某个时区（不给就是本机）是几年几月几日几点几分。 */
function wallOf(ms: number, tz?: string): { y: number; mo: number; d: number; h: number; mi: number } {
  if (!tz) {
    const x = new Date(ms);
    return { y: x.getFullYear(), mo: x.getMonth(), d: x.getDate(), h: x.getHours(), mi: x.getMinutes() };
  }
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(ms));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: g('year'), mo: g('month') - 1, d: g('day'), h: g('hour') % 24, mi: g('minute') };
}

/** 某个时区里的「y 年 mo 月 d 日 h:mi」是哪一刻（日子超出当月会自动进位）。 */
function zoned(y: number, mo: number, d: number, h: number, mi: number, tz?: string): Date {
  if (!tz) return new Date(y, mo, d, h, mi, 0, 0);
  const want = Date.UTC(y, mo, d, h, mi);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const w = wallOf(t, tz);
    const diff = want - Date.UTC(w.y, w.mo, w.d, w.h, w.mi);
    if (!diff) break;
    t += diff;
  }
  return new Date(t);
}

function hour24(h: string, ap?: string): number {
  let n = Number(h);
  const a = (ap ?? '').toLowerCase();
  if (a === 'pm' && n < 12) n += 12;
  if (a === 'am' && n === 12) n = 0;
  return n;
}

/**
 * 「resets 3pm」「resets at 15:30」「于 15:00 恢复」这种钟点（过了就算明天），
 * 和「resets Oct 9, 10am」「resets Sep 30 at 9:30pm」这种带日期的；后面写了时区就按那个时区算。
 */
function clock(text: string, now: Date): Date | null {
  const tz = zoneOf(text);
  const dm = text.match(/resets?\s+(?:on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(.*)/i);
  if (dm) {
    const rest = dm[3];
    const tm = rest.match(/^\s*,?\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) ?? rest.match(/^\s*,?\s*(?:at\s+)?(\d{1,2}):(\d{2})\b/);
    const h = tm ? hour24(tm[1], tm[3]) : 0;
    const mi = tm?.[2] ? Number(tm[2]) : 0;
    const day = Number(dm[2]);
    if (h > 23 || mi > 59 || day < 1 || day > 31) return null;
    const mo = MONTHS.indexOf(dm[1].toLowerCase());
    const y = wallOf(now.getTime(), tz).y;
    let d = zoned(y, mo, day, h, mi, tz);
    if (d.getTime() <= now.getTime()) d = zoned(y + 1, mo, day, h, mi, tz);
    return d;
  }
  const m =
    text.match(/resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i) ??
    text.match(/(?:于|在)\s*(\d{1,2})[:：](\d{2})\s*(?:后|之后)?\s*(?:恢复|重置|重试)/) ??
    text.match(/(\d{1,2})[:：](\d{2})\s*(?:后|之后)?\s*(?:恢复|重置)/);
  if (!m) return null;
  const h = hour24(m[1], m[3]);
  const mi = m[2] ? Number(m[2]) : 0;
  if (h > 23 || mi > 59) return null;
  const t = wallOf(now.getTime(), tz);
  let d = zoned(t.y, t.mo, t.d, h, mi, tz);
  if (d.getTime() <= now.getTime()) d = zoned(t.y, t.mo, t.d + 1, h, mi, tz);
  return d;
}

/** ISO 时间或 Claude 旧版的「|1737000000」秒数。 */
function absolute(text: string, now: Date): Date | null {
  const iso = text.match(/\b(20\d\d-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d)?(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?)/);
  if (iso) {
    const d = new Date(iso[1].replace(' ', 'T'));
    if (!Number.isNaN(d.getTime()) && d.getTime() > now.getTime()) return d;
  }
  const epoch = text.match(/\|\s*(1[6-9]\d{8})\b/);
  if (epoch) {
    const d = new Date(Number(epoch[1]) * 1000);
    if (d.getTime() > now.getTime()) return d;
  }
  return null;
}

/** 看一段输出是不是「额度用完了」，认得出就顺便算出恢复时间。 */
export function detectQuota(text: string, now = new Date()): QuotaHit {
  if (!text) return { hit: false };
  const lines = text.split('\n').filter((l) => HIT.test(l));
  if (!lines.length) return { hit: false };
  // 讲「额度」的正常说明文字（比如任务本身在做额度功能）不算：要像报错。
  const line = lines.find((l) => /error|错误|失败|limit|用完|不足|上限|exceed|exhaust|429|402|频繁|try again|重试|upgrade/i.test(l));
  if (!line) return { hit: false };
  const all = lines.join('\n');
  const until = absolute(all, now) ?? relative(all, now) ?? clock(all, now);
  return { hit: true, line: line.trim().slice(0, 300), ...(until ? { until: until.toISOString() } : {}) };
}

// ---- 记下谁的额度什么时候恢复 ----

export interface QuotaEntry {
  until: string;
  note: string;
  at: string;
}

export function quotaPath(): string {
  return path.join(relayHome(), 'quota.json');
}

export function loadQuota(): Record<string, QuotaEntry> {
  try {
    const j = JSON.parse(fs.readFileSync(quotaPath(), 'utf8')) as { members?: Record<string, QuotaEntry> };
    return j && typeof j.members === 'object' && j.members ? j.members : {};
  } catch {
    return {};
  }
}

function saveQuota(m: Record<string, QuotaEntry>): void {
  fs.mkdirSync(path.dirname(quotaPath()), { recursive: true });
  const p = quotaPath();
  fs.writeFileSync(`${p}.tmp`, JSON.stringify({ members: m }, null, 2) + '\n');
  fs.renameSync(`${p}.tmp`, p);
}

/** 没认出恢复时间时，先歇多久再试。 */
export const DEFAULT_COOLDOWN_MS = 60 * 60_000;

export function markQuota(member: string, hit: QuotaHit, now = new Date()): QuotaEntry {
  const until = hit.until ?? new Date(now.getTime() + Number(process.env.RELAY_COOLDOWN_MS ?? DEFAULT_COOLDOWN_MS)).toISOString();
  const e: QuotaEntry = { until, note: hit.line ?? '额度用完了', at: now.toISOString() };
  const m = loadQuota();
  m[member] = e;
  saveQuota(m);
  return e;
}

export function clearQuota(member: string): void {
  const m = loadQuota();
  if (!(member in m)) return;
  delete m[member];
  saveQuota(m);
}

/** 这一位现在还在等额度恢复吗？返回恢复时间，没在等返回 null。 */
export function coolingUntil(member: string, now = new Date(), all = loadQuota()): string | null {
  const e = all[member];
  if (!e) return null;
  return new Date(e.until).getTime() > now.getTime() ? e.until : null;
}

/** 给人看的「15:00 恢复」「明天 09:30 恢复」。 */
export function untilText(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  if (diff <= 0) return `${hm} 恢复`;
  if (diff === 1) return `明天 ${hm} 恢复`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm} 恢复`;
}
