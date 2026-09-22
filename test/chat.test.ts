import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeskChat, buildLegs, buildPapers, buildVoices, linesFromEvents, mdSection, mergeChat } from '../src/core/chat';
import type { Identity } from '../src/core/identity';
import type { JournalEvent } from '../src/core/types';

test('群聊：同一窗口换模型，两条人话能分开', () => {
  const events: JournalEvent[] = [
    { ts: 't0', type: 'start', task: '加一行', branch: 'b', commit: 's' },
    { ts: 't1', type: 'open', agent: 'cursor', tier: 'strong', llm: 'grok-4.6' },
    { ts: 't2', type: 'handoff', checkpoint: 'ck1', commit: 'ck1', agent: 'cursor', llm: 'grok-4.6' },
    { ts: 't3', type: 'open', agent: 'cursor', tier: 'strong', llm: 'glm-5.3' },
  ];
  const lines = linesFromEvents(events);
  assert.equal(lines[0].kind, 'system');
  assert.match(lines[0].text, /加一行/);
  assert.equal(lines[1].who, 'Cursor · Grok 4.6');
  assert.equal(lines[3].kind, 'baton');
  assert.match(lines[3].text, /Grok 4\.6 → .*GLM 5\.3/);
  assert.equal(lines[4].who, 'Cursor · GLM 5.3');
});

test('只打开窗口时，总结不是当前步，交接上没有人', () => {
  const legs = buildLegs('working', [
    { ts: 't0', type: 'start', task: 'x', branch: 'b', commit: 's' },
    { ts: 't1', type: 'open', agent: 'cursor', tier: 'strong', llm: 'grok-4.7' },
  ]);
  assert.equal(legs.find((l) => l.id === 'work')?.state, 'here');
  assert.equal(legs.find((l) => l.id === 'hand')?.who, '');
  assert.equal(legs.find((l) => l.id === 'merge')?.state, 'wait');
});

test('接力条：干活到总结，没有开会', () => {
  const legs = buildLegs('idle', []);
  assert.deepEqual(
    legs.map((l) => l.label),
    ['干活', '交接', '自审', '总结']
  );
});

test('总结与自审：handoff 正文抽得出来，没有就不编', () => {
  const md = `## 本段业务改动\n加了一行演示。\n\n## 建议的下一步（模型生成，非事实）\n下一棒看 HELLO。\n`;
  assert.equal(mdSection(md, '本段业务改动'), '加了一行演示。');
  assert.equal(
    mdSection('## 本段业务改动（相对上一检查点，不含 .relay）\n加了一行。\n\n## 门禁\n通过\n', '本段业务改动'),
    '加了一行。'
  );
  const papers = buildPapers({
    phase: 'handed',
    handoff: md,
    latestAudit: { content: '读过 diff，没有胡来。' },
    onboard: null,
    diff: '',
    product: '',
  });
  assert.equal(papers[0].empty, false);
  assert.match(papers[0].body, /加了一行/);
  assert.match(papers[1].body, /没有胡来/);
  assert.match(papers[2].body, /下一棒看/);
  const idle = buildPapers({
    phase: 'idle',
    handoff: null,
    latestAudit: null,
    onboard: null,
    diff: '',
    product: '# HELLO-RELAY\n说明书不要直接铺上来。',
  });
  assert.equal(idle[0].empty, true);
  assert.equal(idle[1].empty, true);
});

test('群聊：交棒带上总结，空场也有座席', () => {
  const id = {
    who: 'Cursor · Grok 4.6',
    windowId: 'cursor',
    llmId: 'grok-4.6',
    llmLabel: 'Grok 4.6',
    llmHint: '',
    windows: [
      { id: 'cursor', label: 'Cursor', running: true, on: true, brain: 'Grok 4.6' },
      { id: 'claude', label: 'Claude', running: false, on: false, brain: '' },
    ],
    brains: [],
  } as Identity;
  const voices = buildVoices(id, []);
  assert.ok(voices.some((v) => /Grok/.test(v.who)));
  assert.ok(voices.some((v) => v.who === 'Claude'));
  const lines = buildDeskChat(
    [
      { ts: 't0', type: 'start', task: '加一行', branch: 'b', commit: 's' },
      { ts: 't1', type: 'handoff', checkpoint: 'ck1', commit: 'ck1', agent: 'cursor', llm: 'grok-4.6' },
    ],
    id,
    { handoff: '## 本段业务改动\n加了一行演示。\n', latestAudit: null }
  );
  assert.match(lines.map((l) => l.text).join('\n'), /加了一行演示/);
});

test('群聊：交接账和说话按时间排在一起', () => {
  const merged = mergeChat(
    [{ kind: 'system', who: '接力', text: '开始 · 加一行', ts: '2020-01-01T00:00:00.000Z' }],
    [{ kind: 'person', who: '我', text: '进来', ts: '2020-01-01T00:00:01.000Z', mine: true }]
  );
  assert.equal(merged[0].text, '开始 · 加一行');
  assert.equal(merged[1].text, '进来');
  assert.equal(merged[1].mine, true);
});
