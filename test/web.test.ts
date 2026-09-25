import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/**
 * 网页（纯内存，不开浏览器）：每家 AI 的图标。
 * 从 app.js 里把用到的函数和表原样取出来，在沙箱里跑。
 */

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'app.js'), 'utf8').split('\n');

/** 取一个顶层函数或常量：从声明那一行到顶格的收尾（`}` / `];` / `};`）。 */
function pick(name: string): string {
  const i = src.findIndex((l) => new RegExp(`^((async )?function ${name}\\(|const ${name} = )`).test(l));
  assert.ok(i >= 0, `app.js 里没有 ${name}`);
  if (/;\s*$/.test(src[i]) && !/[[{(]\s*$/.test(src[i])) return src[i];
  let j = i;
  while (!/^(\}|\];|\};|\}\)\(\);)$/.test(src[j])) j++;
  return src.slice(i, j + 1).join('\n');
}

function icons() {
  const code = ['splitLabel', 'hashStr', 'line', 'solid', 'knot', 'GLYPHS', 'SHAPES', 'TOOL_OWN', 'MODEL_MAKER', 'TOOL_MAKER', 'brandOf', 'toolText'].map(pick).join('\n\n');
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(`${code}\nresult = { GLYPHS, SHAPES, TOOL_OWN, MODEL_MAKER, TOOL_MAKER, brandOf, toolText };`, ctx);
  return ctx.result as {
    GLYPHS: Record<string, string>;
    SHAPES: string[];
    TOOL_OWN: [RegExp, string][];
    MODEL_MAKER: [RegExp, string][];
    TOOL_MAKER: [RegExp, string][];
    brandOf: (tool: string, model: string | null) => string | null;
    toolText: (name: string, label: string, agent?: { harness?: string }) => string;
  };
}

test('网页的图标：跟着在干活的那家模型走（Claude Code 接 DeepSeek 是鲸鱼），能换模型的工具用自己的，认不出来的给几何图形', () => {
  const { brandOf, toolText } = icons();
  const of = (name: string, label: string, model: string | null, harness?: string) => brandOf(toolText(name, label, harness ? { harness } : undefined), model);
  // 用户真实名单里的每一位（2026-09-25）
  const cases: [string, string, string | null, string | undefined, string | null][] = [
    ['codex', 'Codex', 'gpt-6-astra', 'codex', 'openai'],
    ['gpt', 'ChatGPT', 'gpt-6-astra', undefined, 'openai'],
    ['claude-official', 'Claude Code 官方账号', 'claude-opus-5-5', 'claude-official', 'anthropic'],
    ['claude-app', 'Claude', 'claude-opus-5-5', undefined, 'anthropic'],
    ['claude', 'Claude Code', 'deepseek-flash', 'claude', 'deepseek'],
    ['deepseek-harness', 'DeepSeek Harness', 'deepseek-flash', 'dsh', 'deepseek'],
    ['deepseek-harness-app', 'DeepSeek Harness 桌面版', 'deepseek-flash', undefined, 'deepseek'],
    ['deepseek', 'DeepSeek', 'deepseek-v4-pro', undefined, 'deepseek'],
    ['cursor-agent', 'Cursor Agent', 'cursor-grok-4.6-high-fast', 'cursor-agent', 'cursor'],
    ['cursor', 'Cursor', 'cursor-grok-4.6-high-fast', undefined, 'cursor'],
    ['agy', 'Antigravity', null, 'agy', 'antigravity'],
    ['opencode', 'OpenCode', null, 'opencode', 'opencode'],
    ['zcode-cli', 'ZCode 命令行', 'GLM-5.3', 'zcode', 'zhipu'],
    ['zcode', 'ZCode', 'GLM-5.3', undefined, 'zhipu'],
    ['mimo-api', 'MiMo 接口', 'mimo-v2.6-pro', undefined, 'xiaomi'],
    ['mimo', 'MiMo', 'mimo-v2.6-pro', undefined, 'xiaomi'],
    // 没写模型：按工具是哪家的
    ['gemini', 'Gemini CLI', null, 'gemini', 'google'],
    ['grok', 'Grok CLI', null, 'grok', 'xai'],
    ['qwen', 'Qwen Code', null, 'qwen', 'qwen'],
    ['deepseek-harness', 'DeepSeek Harness', null, 'dsh', 'deepseek'],
    ['claude-official', 'Claude Code 官方账号', null, 'claude-official', 'anthropic'],
    ['zcode-cli', 'ZCode 命令行', null, 'zcode', 'zhipu'],
    ['mimo-api', 'MiMo 接口', null, undefined, 'xiaomi'],
    // 同一个工具换了模型：图标跟模型走
    ['claude', 'Claude Code', 'glm-5.3', 'claude', 'zhipu'],
    ['claude', 'Claude Code', 'kimi-k3', 'claude', 'moonshot'],
    ['codex', 'Codex', 'o4-mini', 'codex', 'openai'],
    // 认不出来
    ['my-api', '我的接口', 'some-model-x', undefined, null],
    ['droid', 'Droid', null, 'droid', null],
  ];
  for (const [name, label, model, harness, want] of cases) assert.equal(of(name, label, model, harness), want, `${label}（${model ?? '没写模型'}）`);
});

test('网页的图标：规则里用到的每家都画了，几何图形也都在；每个图形都是能放进 svg 的片段', () => {
  const { GLYPHS, SHAPES, TOOL_OWN, MODEL_MAKER, TOOL_MAKER } = icons();
  const used = new Set([...TOOL_OWN, ...MODEL_MAKER, ...TOOL_MAKER].map(([, b]) => b));
  for (const b of [...used, ...SHAPES, 'unknown']) {
    assert.ok(GLYPHS[b], `没画 ${b}`);
    assert.match(GLYPHS[b], /^<(path|g|rect|circle)\b[\s\S]*>$/, `${b} 不是 svg 片段`);
    assert.doesNotMatch(GLYPHS[b], /<script|on\w+=|href=/i, `${b} 里不该有脚本或链接`);
  }
  assert.equal(new Set(SHAPES).size, SHAPES.length, '几何图形不重样');
  assert.equal(new Set(Object.values(GLYPHS)).size, Object.keys(GLYPHS).length, '每个图形都不一样');
});
