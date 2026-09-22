import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAIN_BY_WINDOW, BRAIN_CATALOG, buildIdentity, extractModelId, parseComposerModel, parseCursorOpenModel, parseZcodeModelId, prettyEffort, prettyLlm } from '../src/core/identity';

test('parseCursorOpenModel：读出 selectedModels[0].modelId', () => {
  assert.equal(
    parseCursorOpenModel('{"selectedModels":[{"modelId":"grok-4.6","parameters":[]}]}'),
    'grok-4.6'
  );
});

test('parseCursorOpenModel：坏 JSON / 空 → null', () => {
  assert.equal(parseCursorOpenModel(''), null);
  assert.equal(parseCursorOpenModel('{'), null);
  assert.equal(parseCursorOpenModel('{"selectedModels":[]}'), null);
});

test('prettyLlm：同一窗口换模型时，名字能分开', () => {
  assert.equal(prettyLlm('grok-4.6'), 'Grok 4.6');
  assert.equal(prettyLlm('grok-4.7'), 'Grok 4.7');
  assert.equal(
    parseComposerModel('{"aiSettings":{"modelConfig":{"composer":{"modelName":"grok-4.7","selectedModels":[{"modelId":"grok-4.7"}]}}}}'),
    'grok-4.7'
  );
  assert.equal(prettyLlm('glm-5.3'), 'GLM 5.3');
  assert.equal(prettyLlm('gpt-6-astra'), 'GPT-6 Astra');
  assert.equal(prettyLlm('mimo-v2.6-pro'), 'MiMo-V2.6-Pro');
  assert.equal(parseZcodeModelId('{"modelId":"GLM-5.1"}\n{"modelId":"GLM-5.3"}'), 'GLM-5.3');
  assert.equal(
    parseZcodeModelId('{"modelId":"GLM-5.3","providerId":"account:bigmodel-individual-coding-plan"}\n{"modelId":"deepseek-flash","providerId":"deepseek"}'),
    'GLM-5.3'
  );
  assert.equal(prettyLlm('claude-opus-4-6'), 'Claude Opus 4');
  assert.equal(prettyLlm('deepseek-chat'), 'DeepSeek');
  assert.equal(prettyLlm('kimi-k2.5'), 'Kimi 2.5');
  assert.equal(prettyLlm('claude'), 'Claude');
  assert.equal(prettyLlm('sonnet'), 'Claude Sonnet');
  assert.equal(prettyEffort('max'), '最认真');
  assert.equal(prettyLlm('composer-2'), 'Composer 2');
  assert.equal(prettyLlm('gemini-2.5-pro'), 'Gemini 2.5');
});

test('脑子名单：只认正在输出的，ZCode 不挂 Cursor 的模型', () => {
  const cursor = buildIdentity([{ name: 'cursor', kind: 'app' }]);
  assert.ok(BRAIN_CATALOG.length > 3);
  assert.ok(cursor.brains.every((b) => b.detected));
  assert.equal(BRAIN_BY_WINDOW.zcode.length, 0);
  assert.ok(BRAIN_BY_WINDOW.claude.every((id) => /claude/i.test(id)));
});

test('extractModelId：从杂字里只抽出模型名', () => {
  assert.equal(extractModelId('x claude-sonnet-4-6 y'), 'claude-sonnet-4-6');
  assert.equal(extractModelId('no model here'), null);
});
