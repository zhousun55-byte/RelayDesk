import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOnboard, ONBOARD_HINT } from '../src/core/prompts';

function baseInput(overrides: Partial<Parameters<typeof buildOnboard>[0]> = {}) {
  return {
    taskTitle: '加登录页',
    taskBody: '# 任务\n\n加登录页\n\n## 验收标准\n\n（待补充）',
    branch: 'relay/add-login-ab12',
    worktree: '/home/u/.relay/worktrees/demo-repo-ab12/add-login-ab12',
    reviewBase: 'abc1234def',
    predecessor: null as null | { agent: string; tier: 'strong' | 'weak' },
    handoffDoc: null,
    latestAudit: null,
    protectedPaths: [],
    generatedAt: '2026-09-20T00:00:00Z',
    ...overrides,
  };
}

test('上岗词：无前任 → 不含强制自审段，含任务与纪律', () => {
  const doc = buildOnboard(baseInput());
  assert.ok(doc.includes('# 上岗词'));
  assert.ok(doc.includes('加登录页'));
  assert.ok(doc.includes('relay/add-login-ab12'));
  assert.ok(doc.includes('你是第一位接手者'));
  assert.ok(doc.includes('relay handoff'));
  assert.ok(!doc.includes('强制自审'));
});

test('上岗词：前任 weak → 必须含强制自审 + git diff + 按文件回滚（协议一核心条款）', () => {
  const doc = buildOnboard(
    baseInput({ predecessor: { agent: 'deepseek-ccr', tier: 'weak' } })
  );
  assert.ok(doc.includes('强制自审'));
  assert.ok(doc.includes('deepseek-ccr'));
  assert.ok(doc.includes(`git diff abc1234def..HEAD --stat`));
  assert.ok(doc.includes(`git checkout abc1234def -- <file>`));
  assert.ok(doc.includes('不要整体回档'));
});

test('上岗词：前任 strong → 不含强制自审段', () => {
  const doc = buildOnboard(
    baseInput({ predecessor: { agent: 'claude', tier: 'strong' } })
  );
  assert.ok(!doc.includes('强制自审'));
});

test('上岗词：包含交接事实与审计报告正文', () => {
  const doc = buildOnboard(
    baseInput({
      handoffDoc: '# 交接文档\n\n检查点 abc',
      latestAudit: { path: '.relay/audits/20260920-000000-deepseek.md', content: '事实段：改了 app.txt' },
    })
  );
  assert.ok(doc.includes('# 交接文档'));
  assert.ok(doc.includes('检查点 abc'));
  assert.ok(doc.includes('.relay/audits/20260920-000000-deepseek.md'));
  assert.ok(doc.includes('改了 app.txt'));
});

test('上岗词：渲染保护路径', () => {
  const doc = buildOnboard(baseInput({ protectedPaths: ['src/core/**', '.env'] }));
  assert.ok(doc.includes('src/core/**'));
  assert.ok(doc.includes('禁止改动保护路径'));
});

test('ONBOARD_HINT 是一句话且指向文件（启动只喂这一句）', () => {
  assert.ok(ONBOARD_HINT.includes('.relay/ONBOARD.md'));
  assert.ok(!ONBOARD_HINT.includes('\n'));
});
