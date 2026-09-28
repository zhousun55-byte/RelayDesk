import fs from 'node:fs';
import path from 'node:path';
import { relayHome } from './paths';

/**
 * 额度：认出各家「额度用完 / 次数用完 / 余额不足」的提示，记下什么时候恢复（~/.relay/quota.json）；
 * 各家工具自己报的额度窗口（用了多少、什么时候恢复）也记在这里。
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
  // DeepSeek Harness 报的是「dsh: ACCOUNT_QUOTA: …」这种错误码。
  const line = lines.find((l) => /error|错误|失败|limit|用完|不足|上限|exceed|exhaust|429|402|频繁|try again|重试|upgrade/i.test(l) || /\b(?:ACCOUNT_)?QUOTA\b/.test(l));
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

/** 额度窗口：5 小时、一周、一周 Opus。键是固定的，怎么说由网页写。 */
export type LimitKind = '5h' | '7d' | '7d-opus';

export interface Limit {
  kind: LimitKind;
  /** 用了百分之多少（0～100）。 */
  used: number;
  /** 什么时候恢复（ISO）；过了恢复时间的窗口不带：下一轮从什么时候算，要等下次用到才知道。 */
  resetsAt?: string;
}

export interface QuotaFile {
  members: Record<string, QuotaEntry>;
  /** 各家工具自己报的额度窗口：at 是什么时候读到的。 */
  limits: Record<string, { at: string; windows: Limit[] }>;
  /** 调度时出过错的成员：最近一次在什么时候、连着错了几次（做成一棒就清掉）。 */
  errors: Record<string, { at: string; n: number }>;
}

export function quotaPath(): string {
  return path.join(relayHome(), 'quota.json');
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function loadQuotaFile(): QuotaFile {
  try {
    const j = obj(JSON.parse(fs.readFileSync(quotaPath(), 'utf8')));
    return { members: obj(j.members) as QuotaFile['members'], limits: obj(j.limits) as QuotaFile['limits'], errors: obj(j.errors) as QuotaFile['errors'] };
  } catch {
    return { members: {}, limits: {}, errors: {} };
  }
}

export function loadQuota(): Record<string, QuotaEntry> {
  return loadQuotaFile().members;
}

function saveQuota(f: QuotaFile): void {
  fs.mkdirSync(path.dirname(quotaPath()), { recursive: true });
  const p = quotaPath();
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(f, null, 2) + '\n');
  fs.renameSync(`${p}.tmp`, p);
}

/** 没认出恢复时间时，先歇多久再试。 */
export const DEFAULT_COOLDOWN_MS = 60 * 60_000;

export function markQuota(member: string, hit: QuotaHit, now = new Date()): QuotaEntry {
  const until = hit.until ?? new Date(now.getTime() + Number(process.env.RELAY_COOLDOWN_MS ?? DEFAULT_COOLDOWN_MS)).toISOString();
  const e: QuotaEntry = { until, note: hit.line ?? '额度用完了', at: now.toISOString() };
  const f = loadQuotaFile();
  f.members[member] = e;
  saveQuota(f);
  return e;
}

/** 这一位好好做完了一棒：额度用完、出过错的记号都清掉。 */
export function markOk(member: string): void {
  const f = loadQuotaFile();
  if (!(member in f.members) && !(member in f.errors)) return;
  delete f.members[member];
  delete f.errors[member];
  saveQuota(f);
}

// ---- 出过错的成员：下一轮全自动也先放到后面（借 magpie：代理节点不通时，不用每轮都先等它错一次） ----

/** 出错后多久内往后放：第 1 次 1 分钟，每多错一次翻倍，最多 10 分钟。 */
export function errorBackoffMs(n: number): number {
  return Math.min(10, 2 ** Math.max(0, n - 1)) * 60_000;
}

export function noteError(member: string, now = new Date()): void {
  const f = loadQuotaFile();
  f.errors[member] = { at: now.toISOString(), n: (f.errors[member]?.n ?? 0) + 1 };
  saveQuota(f);
}

/** 现在还在「出错后歇一会」里的成员。 */
export function recentErrors(now = new Date(), all = loadQuotaFile().errors): Set<string> {
  return new Set(Object.entries(all).flatMap(([name, e]) => (now.getTime() - Date.parse(e.at) < errorBackoffMs(e.n) ? [name] : [])));
}

// ---- 各家工具自己报的额度窗口 ----

const KINDS: LimitKind[] = ['5h', '7d', '7d-opus'];

function limit(kind: LimitKind | undefined, used: unknown, resetsSec: unknown): Limit | null {
  if (!kind || typeof used !== 'number' || !Number.isFinite(used)) return null;
  const at = typeof resetsSec === 'number' && resetsSec > 0 ? new Date(resetsSec * 1000).toISOString() : undefined;
  return { kind, used: Math.min(100, Math.max(0, Math.round(used * 10) / 10)), ...(at ? { resetsAt: at } : {}) };
}

const CLAUDE_KINDS: Record<string, LimitKind> = { five_hour: '5h', seven_day: '7d', seven_day_opus: '7d-opus' };

/**
 * Claude Code stream-json 里 rate_limit_event 的 rate_limit_info（claude.ai 登录才有，接口密钥没有）：
 * unifiedWindows 里是 5 小时、一周两个窗口，utilization 是 0～1 的比例（超过额度时会大于 1），resetsAt 是秒；
 * 顶上的 rateLimitType / utilization 是眼下最紧的那个窗口（可能是一周 Opus），status 为 rejected 就是它用满了。
 */
export function claudeLimits(info: unknown): Limit[] {
  const i = obj(info);
  const out = new Map<LimitKind, Limit>();
  for (const [k, w] of Object.entries(obj(i.unifiedWindows))) {
    const u = obj(w).utilization;
    const l = limit(CLAUDE_KINDS[k], typeof u === 'number' ? u * 100 : null, obj(w).resetsAt);
    if (l) out.set(l.kind, l);
  }
  const top = CLAUDE_KINDS[String(i.rateLimitType)];
  const u = i.status === 'rejected' ? 1 : i.utilization;
  if (top && typeof u === 'number' && (i.status === 'rejected' || !out.has(top))) {
    const l = limit(top, u * 100, i.resetsAt);
    const prev = out.get(top)?.resetsAt;
    if (l) out.set(top, { ...l, ...(!l.resetsAt && prev ? { resetsAt: prev } : {}) });
  }
  return KINDS.flatMap((k) => out.get(k) ?? []);
}

/** Codex 会话记录里的 rate_limits：primary、secondary 各一个窗口（300 分钟 = 5 小时，10080 分钟 = 一周），used_percent 是百分比，resets_at 是秒。 */
export function codexLimits(rateLimits: unknown): Limit[] {
  const r = obj(rateLimits);
  return [r.primary, r.secondary].map(obj).flatMap((w) => limit(w.window_minutes === 300 ? '5h' : w.window_minutes === 10080 ? '7d' : undefined, w.used_percent, w.resets_at) ?? []);
}

/** 记下这一位的工具这次报的额度窗口；没报就留着上一次的。 */
export function noteLimits(member: string, windows: Limit[] | null | undefined, now = new Date()): void {
  if (!windows?.length) return;
  const f = loadQuotaFile();
  f.limits[member] = { at: now.toISOString(), windows: [...windows].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)) };
  saveQuota(f);
}

/** 这一位现在的额度窗口：过了恢复时间的窗口重新算起（0%，下一次什么时候恢复不知道）。没记过返回 null。 */
export function limitsOf(member: string, now = new Date(), all = loadQuotaFile().limits): { at: string; windows: Limit[] } | null {
  const l = all[member];
  if (!Array.isArray(l?.windows) || !l.windows.length) return null;
  return { at: l.at, windows: l.windows.map((w) => (w.resetsAt && Date.parse(w.resetsAt) <= now.getTime() ? { kind: w.kind, used: 0 } : w)) };
}

/** 用满了的窗口什么时候恢复（几个都满了，等最晚的那个）；没有用满的返回 undefined。 */
export function fullUntil(windows: Limit[] | null | undefined): string | undefined {
  return windows?.flatMap((w) => (w.used >= 100 && w.resetsAt ? [w.resetsAt] : [])).sort().pop();
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
