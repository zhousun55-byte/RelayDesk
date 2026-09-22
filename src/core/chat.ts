import { prettyLlm, windowLabel, type Identity } from './identity';
import type { JournalEvent } from './types';

export interface ChatLine {
  kind: 'system' | 'person' | 'paper' | 'baton';
  who: string;
  windowId?: string;
  llm?: string;
  title?: string;
  text: string;
  ts: string;
  mine?: boolean;
  pending?: boolean;
  sub?: string;
  at?: string[];
  files?: string[];
}

export interface DeskPaper {
  id: 'summary' | 'review' | 'next';
  title: string;
  body: string;
  empty: boolean;
}

export interface RelayLeg {
  id: string;
  idx: string;
  label: string;
  note: string;
  who: string;
  state: 'done' | 'here' | 'wait';
}

export interface ChatVoice {
  who: string;
  windowId?: string;
}

function speaker(ev: JournalEvent): string {
  const win = windowLabel(ev.agent ?? '');
  const llm = ev.llm ? prettyLlm(ev.llm) : '';
  if (win && llm) return `${win} · ${llm}`;
  return win || '接力';
}

function sys(ts: string, text: string): ChatLine {
  return { kind: 'system', who: '接力', text, ts };
}

function say(ev: JournalEvent, text: string): ChatLine {
  return { kind: 'person', who: speaker(ev), windowId: ev.agent, llm: ev.llm, text, ts: ev.ts };
}

function paper(title: string, text: string, ts = ''): ChatLine {
  return { kind: 'paper', who: '接力', title, text, ts };
}

function baton(from: string, to: string, ts: string): ChatLine {
  return { kind: 'baton', who: '接力', text: `${from} → ${to}`, ts };
}

export function mdSection(md: string, title: string): string {
  const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`##\\s+${esc}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`);
  return (md.match(re)?.[1] ?? '').trim();
}

export function linesFromEvents(
  events: JournalEvent[],
  extra: { summary?: string; review?: string } = {}
): ChatLine[] {
  const out: ChatLine[] = [];
  let lastWho = '';
  for (const ev of events) {
    switch (ev.type) {
      case 'start':
        out.push(sys(ev.ts, `开始 · ${ev.task}`));
        break;
      case 'open':
      case 'run': {
        const who = speaker(ev);
        if (lastWho && lastWho !== who) out.push(baton(lastWho, who, ev.ts));
        out.push(say(ev, '接棒'));
        lastWho = who;
        break;
      }
      case 'exit':
        out.push(sys(ev.ts, `${speaker(ev)} · 离开`));
        break;
      case 'handoff':
        out.push(say(ev, extra.summary?.trim() || '交棒'));
        lastWho = speaker(ev);
        break;
      case 'audit':
        if (extra.review?.trim()) {
          out.push({
            kind: 'person',
            who: lastWho || '自审',
            text: extra.review.trim(),
            ts: ev.ts,
          });
        } else {
          out.push(sys(ev.ts, ev.status === 'ok' ? '自审' : '自审 · 事实'));
        }
        break;
      case 'gate':
        out.push(sys(ev.ts, ev.status === 'pass' ? '过' : '没过'));
        break;
      case 'merge':
        out.push(sys(ev.ts, '总结'));
        break;
      case 'abandon':
        out.push(sys(ev.ts, '不要了'));
        break;
      case 'rollback':
        out.push(sys(ev.ts, '退回'));
        break;
      default:
        break;
    }
  }
  return out;
}

export function buildLegs(
  phase: string,
  events: JournalEvent[],
  live?: { window?: string; who?: string }
): RelayLeg[] {
  const who = (type: JournalEvent['type']): string => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.type !== type) continue;
      if (live?.who && live.window && ev.agent === live.window) return live.who;
      return speaker(ev);
    }
    return '';
  };
  const has = (type: JournalEvent['type']) => events.some((e) => e.type === type);
  const work = has('open') || has('run') || phase === 'working' || phase === 'handed';
  const hand = has('handoff') || phase === 'handed';
  const lastAudit = [...events].reverse().find((e) => e.type === 'audit');
  const review = lastAudit?.status === 'ok';
  const merge = has('merge');
  const here = phase === 'working' ? 'work' : phase === 'handed' ? 'merge' : '';
  const mark = (id: string, done: boolean): 'done' | 'here' | 'wait' => {
    if (here === id) return 'here';
    return done ? 'done' : 'wait';
  };
  return [
    { id: 'work', idx: '', label: '干活', note: '', who: who('open') || who('run'), state: mark('work', work) },
    { id: 'hand', idx: '', label: '交接', note: '', who: who('handoff'), state: mark('hand', hand) },
    { id: 'review', idx: '', label: '自审', note: '', who: '', state: mark('review', review) },
    { id: 'merge', idx: '', label: '总结', note: '', who: '', state: mark('merge', merge) },
  ];
}

export function buildPapers(input: {
  phase: string;
  handoff: string | null;
  latestAudit: { content: string } | null;
  onboard: string | null;
  diff: string;
  product: string;
}): DeskPaper[] {
  const sum = input.handoff ? mdSection(input.handoff, '本段业务改动') : '';
  const next = input.handoff ? mdSection(input.handoff, '建议的下一步（模型生成，非事实）') : '';
  const reviewOnboard = input.onboard ? mdSection(input.onboard, '强制自审（前任为 weak agent）') : '';
  const reviewAudit = input.latestAudit?.content?.trim() ?? '';
  const review = reviewOnboard || reviewAudit;

  const summaryBody =
    (sum && sum !== '（尚未开始）' && !sum.includes('尚未') ? sum : '') ||
    (input.diff.trim() ? input.diff.slice(0, 4000) : '');

  const nextBody = next && !next.includes('未生成') && !next.includes('任务刚开始') ? next : '';

  return [
    {
      id: 'summary',
      title: '总结',
      body: summaryBody,
      empty: !summaryBody,
    },
    {
      id: 'review',
      title: '自审',
      body: review,
      empty: !review,
    },
    {
      id: 'next',
      title: '下一棒',
      body: nextBody,
      empty: !nextBody,
    },
  ];
}

export function mergeChat(a: ChatLine[], b: ChatLine[]): ChatLine[] {
  return [...a, ...b].sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));
}

export function buildVoices(id: Identity, events: JournalEvent[], extra: ChatLine[] = []): ChatVoice[] {
  const seen = new Map<string, ChatVoice>();
  const add = (who: string, windowId?: string) => {
    if (!who || seen.has(who)) return;
    seen.set(who, { who, windowId });
  };
  for (const w of id.windows) {
    const llm = w.brain || (w.on ? id.llmLabel : '');
    add(llm && llm !== w.label ? `${w.label} · ${llm}` : w.label, w.id);
  }
  for (const ev of events) {
    if (ev.agent || ev.llm) add(speaker(ev), ev.agent);
  }
  for (const line of extra) {
    if (line.kind === 'person' && line.who && line.windowId !== 'human') add(line.who, line.windowId);
  }
  return [...seen.values()];
}

export function buildDeskChat(
  events: JournalEvent[],
  id: Identity,
  room: {
    task?: string | null;
    phase?: string;
    product?: string;
    handoff?: string | null;
    latestAudit?: { content: string } | null;
    onboard?: string | null;
    diff?: string;
  }
): ChatLine[] {
  void id;
  const sum = room.handoff ? mdSection(room.handoff, '本段业务改动') : '';
  const summary = sum && !sum.includes('尚未') ? sum : '';
  const review = room.latestAudit?.content?.trim() ?? '';
  return linesFromEvents(events, { summary, review });
}
