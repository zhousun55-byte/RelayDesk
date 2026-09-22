import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHandoffDoc, buildInitialHandoff, buildMergeMessage } from '../src/core/handoff';
import type { JournalEvent } from '../src/core/types';

test('handoff.md：框架填事实段，模型只出现在标注过的「建议的下一步」', () => {
  const doc = buildHandoffDoc(
    {
      taskTitle: '加登录页',
      branch: 'relay/add-login-ab12',
      checkpoint: 'ck1234567890',
      prevCheckpoint: 'ck0000000000',
      diffstat: ' app.txt | 1 +',
      gate: { status: 'fail', command: 'npm test', detail: 'Expected 3 passing, got 1' },
      auditPath: '.relay/audits/20260920-000000-deepseek.md',
      auditStatus: 'failed',
      agent: 'deepseek-ccr',
      tier: 'weak',
      protectedHits: ['app.txt'],
      ts: '2026-09-20T00:00:00Z',
    },
    '先补测试再动 UI'
  );
  assert.ok(doc.includes('ck1234567890'.slice(0, 9)));
  assert.ok(doc.includes(' app.txt | 1 +'));
  assert.ok(doc.includes('未通过'));
  assert.ok(doc.includes('Expected 3 passing, got 1'), '失败输出要写进交接文档');
  assert.ok(doc.includes('deepseek-ccr'));
  assert.ok(doc.includes('tier=weak'));
  assert.ok(doc.includes('⚠ 命中：app.txt'), '保护路径命中要标红');
  // 模型内容只允许出现在标注节里
  assert.ok(doc.includes('建议的下一步（模型生成，非事实）'));
  assert.ok(doc.includes('先补测试再动 UI'));
});

test('handoff.md：无模型建议时写明未生成', () => {
  const doc = buildHandoffDoc(
    {
      taskTitle: 't',
      branch: 'b',
      checkpoint: 'c',
      prevCheckpoint: null,
      diffstat: '（无业务改动）',
      gate: { status: 'pass', command: '(未配置)', detail: '' },
      auditPath: 'p',
      auditStatus: 'failed',
      agent: 'framework',
      tier: null,
      protectedHits: [],
      ts: 't',
    },
    null
  );
  assert.ok(doc.includes('（本次未生成）'));
  assert.ok(doc.includes('（无命中）'));
});

test('初始 handoff：无前任、无改动', () => {
  const doc = buildInitialHandoff('加登录页', 'relay/add-login-ab12', 'basesha', '2026-09-20T00:00:00Z');
  assert.ok(doc.includes('加登录页'));
  assert.ok(doc.includes('basesha'));
  assert.ok(doc.includes('（无）'));
});

test('merge 提交信息：按 journal 分段列出 agent 问责链', () => {
  const events: JournalEvent[] = [
    { ts: 't0', type: 'start', task: '加登录页', branch: 'relay/add-login-ab12', commit: 'startsha1234' },
    { ts: 't1', type: 'run', agent: 'deepseek-ccr', tier: 'weak' },
    { ts: 't2', type: 'exit', agent: 'deepseek-ccr', tier: 'weak', code: 0, quotaHint: false },
    { ts: 't3', type: 'audit', agent: 'deepseek-ccr', report: '.relay/audits/x.md', status: 'failed' },
    { ts: 't4', type: 'gate', agent: 'deepseek-ccr', status: 'pass', command: 'npm test' },
    { ts: 't5', type: 'handoff', agent: 'deepseek-ccr', checkpoint: 'ck1234567890abcdef', commit: 'ck' },
    { ts: 't6', type: 'run', agent: 'claude', tier: 'strong' },
  ];
  const msg = buildMergeMessage({
    taskTitle: '加登录页',
    branch: 'relay/add-login-ab12',
    baseCommit: 'basesha5678',
    events,
  });
  assert.ok(msg.startsWith('relay: merge relay/add-login-ab12'));
  assert.ok(msg.includes('任务: 加登录页'));
  assert.ok(msg.includes('deepseek-ccr'));
  assert.ok(msg.includes('claude'));
  assert.ok(msg.includes('ck1234567'));
  assert.ok(msg.includes('gate pass'));
  assert.ok(msg.includes('audit failed'));
  assert.ok(msg.includes('保留备查'));
});
