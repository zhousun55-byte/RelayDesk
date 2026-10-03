import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexSessionLimits } from '../src/core/harness';
import { spareFirst, type MemberInfo } from '../src/core/members';
import { claudeLimits, codexLimits, errorBackoffMs, fullUntil, limitsOf, loadQuotaFile, markOk, markQuota, noteError, noteLimits, quotaPath, recentErrors, type Limit } from '../src/core/quota';
import { makeParser } from '../src/core/runner';
import type { AgentConfig } from '../src/core/types';
import { setOrder, withFakes } from './fakes';
import { sandbox } from './helpers';

process.env.RELAY_LOGIN_PATH = 'off';

const iso = (sec: number) => new Date(sec * 1000).toISOString();

test('额度窗口：Claude 的 rate_limit_event 取 5 小时和一周（比例换成百分比），眼下最紧的一周 Opus 用顶上的数、被拒就是用满；Codex 按窗口长短认', () => {
  const t = 1790454532;
  const p = makeParser('claude');
  assert.deepEqual(p.line(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.05, resetsAt: t }, seven_day: { utilization: 0.72, resetsAt: t + 86400 } } } })), [], '不进日志');
  p.line(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', unifiedWindows: { five_hour: { utilization: 0.913, resetsAt: t } } } }));
  assert.deepEqual(p.limits!(), [
    { kind: '5h', used: 91.3, resetsAt: iso(t) },
    { kind: '7d', used: 72, resetsAt: iso(t + 86400) },
  ], '同一个窗口留最新的，别的窗口留着');
  assert.deepEqual(claudeLimits({ status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: t + 3600, unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: t } } }), [
    { kind: '5h', used: 20, resetsAt: iso(t) },
    { kind: '7d-opus', used: 100, resetsAt: iso(t + 3600) },
  ]);
  assert.deepEqual(claudeLimits({ status: 'rejected', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.99, resetsAt: t } } }), [{ kind: '5h', used: 100, resetsAt: iso(t) }], '被拒时顶上没写恢复时间：用窗口里的');
  assert.deepEqual(claudeLimits({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 1.07, resetsAt: t }, seven_day_overage_included: { utilization: 0.5, resetsAt: t } } }), [{ kind: '5h', used: 100, resetsAt: iso(t) }], '超过额度按用满算；不认得的窗口不要');
  assert.deepEqual(claudeLimits(undefined), []);
  assert.deepEqual(codexLimits({ primary: { used_percent: 5.0, window_minutes: 300, resets_at: t }, secondary: { used_percent: 72.0, window_minutes: 10080, resets_at: t + 1 }, plan_type: 'plus' }), [
    { kind: '5h', used: 5, resetsAt: iso(t) },
    { kind: '7d', used: 72, resetsAt: iso(t + 1) },
  ]);
  assert.deepEqual(codexLimits(null), [], '接口密钥登录时是 null');
});

test('Codex 的额度从它自己的会话记录读：只认这个项目、这一棒开始之后的那份，取最后一条 rate_limits', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-proj-'));
  const quiet = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-quiet-'));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const now = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const day = path.join(home, 'sessions', String(now.getFullYear()), p2(now.getMonth() + 1), p2(now.getDate()));
    fs.mkdirSync(day, { recursive: true });
    // 真的第一行带着整段说明，有两万字节
    const meta = (cwd: string) => JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd, originator: 'codex_exec', base_instructions: { text: '说明'.repeat(8000) } } });
    const rl = (p: number, w: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: p, window_minutes: 300, resets_at: 2000000000 }, secondary: { used_percent: w, window_minutes: 10080, resets_at: 2000003600 } } } });
    const since = Date.now() - 1000;
    fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), [meta(fs.realpathSync(root)), rl(1, 10), rl(5, 72), '{"type":"event_msg","payload":{"type":"agent_message"}}'].join('\n') + '\n');
    fs.writeFileSync(path.join(day, 'rollout-b.jsonl'), [meta('/别的/项目'), rl(99, 99)].join('\n') + '\n');
    const old = path.join(day, 'rollout-c.jsonl');
    fs.writeFileSync(old, [meta(quiet), rl(50, 50)].join('\n') + '\n');
    fs.utimesSync(old, new Date(since - 60_000), new Date(since - 60_000));
    assert.deepEqual(codexSessionLimits(root, since), [
      { kind: '5h', used: 5, resetsAt: iso(2000000000) },
      { kind: '7d', used: 72, resetsAt: iso(2000003600) },
    ], '文件夹写的是真实路径也认');
    assert.equal(codexSessionLimits(quiet, since), null, '这个项目只有这一棒开始之前的记录（这一棒 Codex 没留记录）：不拿上一棒的数冒充');
    assert.equal(codexSessionLimits(path.join(root, '子文件夹'), since), null, '别的文件夹的不算');
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(quiet, { recursive: true, force: true });
  }
});

test('额度窗口和额度用完记在同一个 quota.json，互不冲掉；过了恢复时间的窗口从 0 算起；用满的窗口给出恢复时间', () => {
  const prev = process.env.RELAY_HOME;
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-limits-home-'));
  try {
    const now = new Date('2026-09-28T12:00:00Z');
    const later = '2026-09-29T05:06:00.000Z';
    markQuota('claude-official', { hit: true, until: '2026-09-28T15:00:00.000Z', line: 'limit' }, now);
    noteLimits('codex', [{ kind: '7d', used: 72, resetsAt: later }, { kind: '5h', used: 5, resetsAt: '2026-09-28T11:00:00.000Z' }], now);
    noteLimits('codex', [], now);
    assert.equal(loadQuotaFile().members['claude-official'].until, '2026-09-28T15:00:00.000Z', '记额度窗口没冲掉额度用完');
    markOk('claude-official');
    assert.deepEqual(loadQuotaFile().limits.codex, { at: now.toISOString(), windows: [{ kind: '5h', used: 5, resetsAt: '2026-09-28T11:00:00.000Z' }, { kind: '7d', used: 72, resetsAt: later }] }, '按 5 小时、一周的顺序存；这次没报就留着上一次的；清掉额度用完没冲掉额度窗口');
    assert.deepEqual(limitsOf('codex', now)!.windows, [{ kind: '5h', used: 0 }, { kind: '7d', used: 72, resetsAt: later }], '5 小时窗口过了恢复时间');
    assert.equal(limitsOf('cursor-agent', now), null);
    const full: Limit[] = [
      { kind: '5h', used: 100, resetsAt: '2026-09-28T13:00:00.000Z' },
      { kind: '7d', used: 100, resetsAt: later },
      { kind: '7d-opus', used: 99.9, resetsAt: '2026-10-01T00:00:00.000Z' },
    ];
    assert.equal(fullUntil(full), later, '两个都用满了，等晚的那个');
    assert.equal(fullUntil(full.slice(2)), undefined);
    fs.writeFileSync(quotaPath(), JSON.stringify({ members: { x: { until: later, note: '', at: later } } }));
    assert.deepEqual(loadQuotaFile(), { members: { x: { until: later, note: '', at: later } }, limits: {}, errors: {}, blocked: {} }, '旧的 quota.json 照样读');
    // 出过错：第 1 次歇 1 分钟，连着错翻倍，最多 10 分钟；做成一棒就清掉
    assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => errorBackoffMs(n) / 60_000), [1, 2, 4, 8, 10, 10]);
    noteError('codex', now);
    noteError('codex', now);
    assert.equal(loadQuotaFile().errors.codex.n, 2);
    assert.deepEqual([...recentErrors(new Date(now.getTime() + 90_000))], ['codex'], '错了两次：1.5 分钟后还在歇');
    assert.deepEqual([...recentErrors(new Date(now.getTime() + 3 * 60_000))], [], '3 分钟后不歇了');
    markOk('codex');
    assert.equal(loadQuotaFile().errors.codex, undefined);
    assert.equal(loadQuotaFile().members.x.until, later, '清出错记号没冲掉别人的额度用完');
  } finally {
    if (prev === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = prev;
  }
});

test('全自动挑人：同一档里报了额度的几位，一周额度先恢复的先上，没报的不挪；有窗口用了九成以上的挪到这一档最后', () => {
  const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  const m = (name: string, tier: 'strong' | 'weak', limits?: Limit[]) => ({ name, label: name, tier, kind: 'harness', canWork: true, canTalk: true, tierSet: false, agent: { name } as AgentConfig, ...(limits ? { limits } : {}) }) as MemberInfo;
  const names = (l: MemberInfo[]) => l.map((x) => x.name);
  const codex = m('codex', 'strong', [{ kind: '5h', used: 5, resetsAt: at(3) }, { kind: '7d', used: 72, resetsAt: at(120) }]);
  const cursor = m('cursor-agent', 'strong');
  const claude = m('claude-official', 'strong', [{ kind: '5h', used: 10, resetsAt: at(2) }, { kind: '7d', used: 40, resetsAt: at(30) }]);
  const dsh = m('deepseek-harness', 'weak');
  assert.deepEqual(names(spareFirst([codex, dsh, cursor, claude])), ['claude-official', 'deepseek-harness', 'cursor-agent', 'codex'], 'Claude 的一周额度先恢复，换到 Codex 原来的位置；Cursor 和弱的那一档不动');
  assert.deepEqual(names(spareFirst([m('codex', 'strong', [{ kind: '7d', used: 0 }]), claude])), ['claude-official', 'codex'], '过了恢复时间的（下次什么时候恢复不知道）排在知道的后面');
  const tight = m('claude-official', 'strong', [{ kind: '5h', used: 93, resetsAt: at(1) }, { kind: '7d', used: 40, resetsAt: at(30) }]);
  assert.deepEqual(names(spareFirst([tight, dsh, cursor, codex])), ['cursor-agent', 'deepseek-harness', 'codex', 'claude-official'], '5 小时用了 93%：排到强的最后，没报额度的 Cursor 也在它前面');
  assert.deepEqual(names(spareFirst([cursor, dsh])), ['cursor-agent', 'deepseek-harness'], '都没报：照原样');
  assert.deepEqual(names(spareFirst([cursor, dsh, codex], new Set(['cursor-agent']))), ['codex', 'deepseek-harness', 'cursor-agent'], '刚出过错的：排到这一档最后');
});

test('一棒跑完、群聊答完记下工具报的额度（Codex 读它的会话记录，官方账号的 Claude 读输出），全自动挑人时用上；额度用完的恢复时间以工具报的为准', () => {
  const s = sandbox('limits');
  withFakes(s, { FAKE_CLAUDE_OFFICIAL: 'pro' });
  s.relay(['detect', '--offline']);
  s.relay(['init']);
  s.relay(['task', '做几步', '--step', '一', '二', '三', '四', '五', '六']);
  const q = () => JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'quota.json'), 'utf8')) as { members: Record<string, { until: string }>; limits: Record<string, { at: string; windows: Limit[] }> };
  const near = (iso: string | undefined, ms: number, what: string) => assert.ok(iso && Math.abs(Date.parse(iso) - ms) < 60_000, `${what}：${iso}`);
  const kinds = (w: Limit[]) => w.map((x) => [x.kind, x.used]);

  let t = Date.now();
  s.relay(['go', 'codex']);
  const codex = q().limits.codex.windows;
  assert.deepEqual(kinds(codex), [['5h', 30], ['7d', 41]]);
  near(codex[0].resetsAt, t + 3 * 3600_000, '5 小时窗口');
  near(codex[1].resetsAt, t + 2 * 86_400_000, '一周窗口');
  s.relay(['go', 'claude-official']);
  assert.deepEqual(kinds(q().limits['claude-official'].windows), [['5h', 5], ['7d', 72]]);
  s.relay(['go', 'claude']);
  assert.equal(q().limits.claude, undefined, '接 DeepSeek 的 Claude Code（接口密钥）不报额度');
  s.env.FAKE_CLAUDE_OFFICIAL_LIMITS = '12 73';
  s.relay(['talk', '看看', '--ask', 'claude-official']);
  assert.deepEqual(kinds(q().limits['claude-official'].windows), [['5h', 12], ['7d', 73]], '群聊里答话时报的也记下');

  // 两位强的：Codex 排在前面，但官方账号的一周额度先恢复——不指定人时先派官方账号；它 5 小时用到九成以上时派 Codex
  setOrder(s, ['codex', 'claude-official', 'claude']);
  const f = q();
  f.limits.codex.windows = [{ kind: '7d', used: 41, resetsAt: new Date(Date.now() + 5 * 86_400_000).toISOString() }];
  f.limits['claude-official'].windows = [{ kind: '5h', used: 20, resetsAt: new Date(Date.now() + 3600_000).toISOString() }, { kind: '7d', used: 72, resetsAt: new Date(Date.now() + 86_400_000).toISOString() }];
  fs.writeFileSync(path.join(s.home, '.relay', 'quota.json'), JSON.stringify(f));
  s.env.FAKE_CLAUDE_OFFICIAL_LIMITS = '95 72';
  s.relay(['go']);
  assert.equal(s.stints().at(-1)!.who.member, 'claude-official');
  s.relay(['go']);
  assert.equal(s.stints().at(-1)!.who.member, 'codex', '官方账号这一棒报的 5 小时是 95%');

  // 额度用完：Codex 的原话说 2 小时 5 分钟后再试，会话记录里写的是 5 小时窗口用满、90 分钟后恢复——记后者
  s.env.FAKE_CODEX_MODE = 'quota';
  s.env.FAKE_RESETS_IN = '5400';
  t = Date.now();
  s.relay(['go', 'codex']);
  const last = s.stints().at(-1)!;
  assert.equal(last.status, 'quota');
  near(last.quotaUntil, t + 5400_000, '恢复时间');
  assert.equal(q().members.codex.until, last.quotaUntil);
  assert.deepEqual(kinds(q().limits.codex.windows), [['5h', 100], ['7d', 41]]);
});

test('Claude 额度：Claude Code 2.1.282 官方账号真跑一次报的 rate_limit_event（2026-09-28 录下的原样）读得出两个窗口', () => {
  const info = { status: 'allowed', resetsAt: 1790623800, rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0, resetsAt: 1790623800 }, seven_day: { utilization: 0.72, resetsAt: 1790892000 } } };
  assert.deepEqual(claudeLimits(info), [
    { kind: '5h', used: 0, resetsAt: '2026-09-28T19:30:00.000Z' },
    { kind: '7d', used: 72, resetsAt: '2026-10-01T22:00:00.000Z' },
  ]);
});
