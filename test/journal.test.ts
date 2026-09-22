import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, checkpoints, journalPath, lastCheckpoint, lastRun, lastSegmentRun, readEvents, reviewBaseFor } from '../src/core/journal';
import type { JournalEvent } from '../src/core/types';

function tmpWt(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-journal-'));
}

test('journal: append/read 往返保序', () => {
  const wt = tmpWt();
  appendEvent(wt, { ts: '2026-01-01T00:00:00Z', type: 'start', task: 't', branch: 'relay/task-abcd', commit: 'aaa' });
  appendEvent(wt, { ts: '2026-01-01T01:00:00Z', type: 'run', agent: 'deepseek', tier: 'weak' });
  appendEvent(wt, { ts: '2026-01-01T02:00:00Z', type: 'exit', agent: 'deepseek', tier: 'weak', code: 0, quotaHint: false });
  const events = readEvents(wt);
  assert.equal(events.length, 3);
  assert.equal(events[0].type, 'start');
  assert.equal(events[2].type, 'exit');
  fs.rmSync(wt, { recursive: true, force: true });
});

test('journal: 不存在的 journal 读出空数组', () => {
  assert.deepEqual(readEvents('/nonexistent-path'), []);
});

test('lastCheckpoint: 无 handoff 时退回 start 首提交', () => {
  const events: JournalEvent[] = [
    { ts: 't0', type: 'start', task: 't', branch: 'b', commit: 'startsha' },
    { ts: 't1', type: 'run', agent: 'a', tier: 'weak' },
  ];
  assert.equal(lastCheckpoint(events), 'startsha');
});

test('lastCheckpoint: 取最近的 handoff 检查点', () => {
  const events: JournalEvent[] = [
    { ts: 't0', type: 'start', task: 't', branch: 'b', commit: 'startsha' },
    { ts: 't1', type: 'handoff', checkpoint: 'ck1', commit: 'ck1' },
    { ts: 't2', type: 'run', agent: 'a', tier: 'strong' },
    { ts: 't3', type: 'handoff', checkpoint: 'ck2', commit: 'ck2' },
  ];
  assert.equal(lastCheckpoint(events), 'ck2');
});

test('lastCheckpoint: 回滚之后基准是回滚落点，不是更晚的旧检查点', () => {
  const events: JournalEvent[] = [
    { ts: 't0', type: 'start', task: 't', branch: 'b', commit: 'startsha' },
    { ts: 't1', type: 'handoff', checkpoint: 'ck1', commit: 'ck1' },
    { ts: 't2', type: 'handoff', checkpoint: 'ck2', commit: 'ck2' },
    { ts: 't3', type: 'rollback', to: 'ck1' },
    { ts: 't4', type: 'run', agent: 'a', tier: 'strong' },
  ];
  assert.equal(lastCheckpoint(events), 'ck1');
});

test('lastRun: 找最近一次 run 的 agent 与 tier', () => {
  const events: JournalEvent[] = [
    { ts: 't0', type: 'start', task: 't', branch: 'b', commit: 's' },
    { ts: 't1', type: 'run', agent: 'deepseek', tier: 'weak' },
    { ts: 't2', type: 'exit', agent: 'deepseek', tier: 'weak', code: 0, quotaHint: false },
    { ts: 't3', type: 'run', agent: 'claude', tier: 'strong' },
  ];
  const r = lastRun(events);
  assert.equal(r?.agent, 'claude');
  assert.equal(r?.tier, 'strong');
});

test('lastRun：同一窗口换模型时记下 llm', () => {
  const events: JournalEvent[] = [
    { ts: 't0', type: 'start', task: 't', branch: 'b', commit: 's' },
    { ts: 't1', type: 'open', agent: 'cursor', tier: 'strong', llm: 'grok-4.6' },
    { ts: 't2', type: 'handoff', checkpoint: 'ck1', commit: 'ck1' },
    { ts: 't3', type: 'open', agent: 'cursor', tier: 'strong', llm: 'glm-5.3' },
  ];
  const r = lastRun(events);
  assert.equal(r?.agent, 'cursor');
  assert.equal(r?.llm, 'glm-5.3');
});

test('lastRun: open（App 客人上岗）也算干活，取最近者', () => {
  const events: JournalEvent[] = [
    { ts: 't0', type: 'start', task: 't', branch: 'b', commit: 's' },
    { ts: 't1', type: 'run', agent: 'claude', tier: 'strong' },
    { ts: 't2', type: 'exit', agent: 'claude', tier: 'strong', code: 0, quotaHint: false },
    { ts: 't3', type: 'handoff', agent: 'claude', checkpoint: 'ck1', commit: 'ck1' },
    { ts: 't4', type: 'open', agent: 'zcode', tier: 'weak' },
  ];
  const r = lastRun(events);
  assert.equal(r?.agent, 'zcode', 'handoff 之后最近的上岗是 open，前任应归因到 App 客人');
  assert.equal(r?.tier, 'weak');
});

test('checkpoints: start + handoff 依序列出（rollback 目标）', () => {
  const events: JournalEvent[] = [
    { ts: 't0', type: 'start', task: 't', branch: 'b', commit: 'basesha' },
    { ts: 't1', type: 'run', agent: 'a', tier: 'weak' },
    { ts: 't2', type: 'handoff', agent: 'a', checkpoint: 'ck1', commit: 'ck1' },
  ];
  const cps = checkpoints(events, 'startsha');
  assert.equal(cps.length, 2);
  assert.equal(cps[0].sha, 'startsha', 'startCommit 优先于 start 事件里的主线基准');
  assert.equal(cps[1].sha, 'ck1');
  // 未提供 startCommit 时退回事件里的 commit（主线基准）
  assert.equal(checkpoints(events)[0].sha, 'basesha');
});

test('reviewBaseFor: handoff 之后 → 上一段的起点，不是刚打的检查点', () => {
  const events: JournalEvent[] = [
    { ts: 't0', type: 'start', task: 't', branch: 'b', commit: 'basesha' },
    { ts: 't1', type: 'run', agent: 'weak', tier: 'weak' },
    { ts: 't2', type: 'handoff', agent: 'weak', checkpoint: 'ck1', commit: 'ck1' },
    { ts: 't3', type: 'run', agent: 'strong', tier: 'strong' },
  ];
  assert.equal(reviewBaseFor(events), 'basesha', '首次 handoff 后基准是段起点（=主线基准），不是 ck1');
});

test('reviewBaseFor: 两次 handoff 之后 → 倒数第二个检查点', () => {
  const events: JournalEvent[] = [
    { ts: 't0', type: 'start', task: 't', branch: 'b', commit: 'basesha' },
    { ts: 't1', type: 'handoff', checkpoint: 'ck1', commit: 'ck1' },
    { ts: 't2', type: 'handoff', checkpoint: 'ck2', commit: 'ck2' },
    { ts: 't3', type: 'run', agent: 'a', tier: 'strong' },
  ];
  assert.equal(reviewBaseFor(events), 'ck1');
});

test('reviewBaseFor: 最近事件是 rollback → 用其落点', () => {
  const events: JournalEvent[] = [
    { ts: 't0', type: 'start', task: 't', branch: 'b', commit: 'basesha' },
    { ts: 't1', type: 'handoff', checkpoint: 'ck1', commit: 'ck1' },
    { ts: 't2', type: 'handoff', checkpoint: 'ck2', commit: 'ck2' },
    { ts: 't3', type: 'rollback', to: 'ck1' },
    { ts: 't4', type: 'run', agent: 'a', tier: 'strong' },
  ];
  assert.equal(reviewBaseFor(events), 'ck1');
});

test('reviewBaseFor: 从未 handoff → start 记录的主线基准', () => {
  const events: JournalEvent[] = [
    { ts: 't0', type: 'start', task: 't', branch: 'b', commit: 'basesha' },
    { ts: 't1', type: 'run', agent: 'a', tier: 'strong' },
  ];
  assert.equal(reviewBaseFor(events), 'basesha');
});

test('journalPath: 落在 worktree 的 .relay 下', () => {
  assert.equal(journalPath('/wt'), path.join('/wt', '.relay', 'journal.jsonl'));
});

test('lastSegmentRun：只看最近 handoff 之后的上岗；连续 handoff 不把上一段人再记一次', () => {
  const events: JournalEvent[] = [
    { ts: 't0', type: 'start', task: 't', branch: 'b', commit: 's' },
    { ts: 't1', type: 'run', agent: 'deepseek', tier: 'weak' },
    { ts: 't2', type: 'handoff', agent: 'deepseek', checkpoint: 'ck1', commit: 'ck1' },
    { ts: 't3', type: 'handoff', agent: 'framework', checkpoint: 'ck2', commit: 'ck2' },
  ];
  assert.equal(lastSegmentRun(events), null, '两次 handoff 之间没人上岗');
  assert.equal(lastRun(events)?.agent, 'deepseek', 'lastRun 仍是整本最近一次上岗（给 ONBOARD 前任用）');
});

test('lastSegmentRun：handoff 之后又 run，本段归新来的人', () => {
  const events: JournalEvent[] = [
    { ts: 't0', type: 'start', task: 't', branch: 'b', commit: 's' },
    { ts: 't1', type: 'run', agent: 'deepseek', tier: 'weak' },
    { ts: 't2', type: 'handoff', agent: 'deepseek', checkpoint: 'ck1', commit: 'ck1' },
    { ts: 't3', type: 'run', agent: 'claude', tier: 'strong' },
  ];
  assert.equal(lastSegmentRun(events)?.agent, 'claude');
});

test('lastSegmentRun：rollback 后本段清空，不把已回滚的人再归因', () => {
  const events: JournalEvent[] = [
    { ts: 't0', type: 'start', task: 't', branch: 'b', commit: 's' },
    { ts: 't1', type: 'run', agent: 'weak', tier: 'weak' },
    { ts: 't2', type: 'handoff', checkpoint: 'ck1', commit: 'ck1' },
    { ts: 't3', type: 'run', agent: 'oops', tier: 'weak' },
    { ts: 't4', type: 'rollback', to: 'ck1' },
  ];
  assert.equal(lastSegmentRun(events), null);
});

test('readEvents：脏行抛人类可读错误（含行号），不是裸 SyntaxError', () => {
  const wt = tmpWt();
  const p = journalPath(wt);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{"ts":"t","type":"start","task":"t","branch":"b"}\nTHIS IS NOT JSON\n');
  assert.throws(
    () => readEvents(wt),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.ok(e.message.includes('第 2 行'), e.message);
      assert.ok(e.message.includes('abandon --force'), e.message);
      return true;
    }
  );
  fs.rmSync(wt, { recursive: true, force: true });
});
