import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultRelayConfig, loadRelayConfig, relayConfigPath } from '../src/core/config';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cfg-'));
}

function writeConfig(root: string, content: unknown): string {
  const p = relayConfigPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  return p;
}

function expectHumanError(root: string, ...needles: string[]): void {
  assert.throws(
    () => loadRelayConfig(root),
    (e: unknown) => {
      assert.ok(e instanceof Error, `应抛 Error，不是 TypeError（实际：${String(e)}）`);
      for (const n of needles) assert.ok(e.message.includes(n), `报错应含「${n}」：${e.message}`);
      return true;
    }
  );
}

test('loadRelayConfig：坏 JSON → 人类可读错误（含路径），不是裸 SyntaxError', () => {
  const root = tmpRoot();
  const p = writeConfig(root, '{ oops');
  expectHumanError(root, p, '不是合法 JSON');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadRelayConfig：根节点不是对象 → 明确报错', () => {
  const root = tmpRoot();
  writeConfig(root, '[1, 2]');
  expectHumanError(root, '根节点', '对象');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadRelayConfig：protectedPaths 是字符串而非数组 → 明确报错，不是 TypeError', () => {
  const root = tmpRoot();
  writeConfig(root, { ...defaultRelayConfig(), protectedPaths: 'nope' });
  expectHumanError(root, 'protectedPaths', '字符串数组');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadRelayConfig：protectedPaths 元素不是字符串 → 明确报错', () => {
  const root = tmpRoot();
  writeConfig(root, { ...defaultRelayConfig(), protectedPaths: ['ok.txt', 3] });
  expectHumanError(root, 'protectedPaths', '字符串数组');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadRelayConfig：gate.command 非字符串 → 明确报错', () => {
  const root = tmpRoot();
  writeConfig(root, { ...defaultRelayConfig(), gate: { command: 123 } });
  expectHumanError(root, 'gate.command', '字符串');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadRelayConfig：audit 字段类型不对 → 明确报错（不静默当通过）', () => {
  const root = tmpRoot();
  writeConfig(root, { ...defaultRelayConfig(), audit: { ...defaultRelayConfig().audit, baseUrl: 42 } });
  expectHumanError(root, 'audit.baseUrl', '字符串');
  writeConfig(root, { ...defaultRelayConfig(), audit: { ...defaultRelayConfig().audit, apiKeyEnv: null } });
  expectHumanError(root, 'audit.apiKeyEnv', '字符串');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadRelayConfig：显式 null 不算缺字段（gate/audit 为 null → 报错，不补默认）', () => {
  const root = tmpRoot();
  writeConfig(root, { ...defaultRelayConfig(), gate: null });
  expectHumanError(root, 'gate', '对象');
  writeConfig(root, { ...defaultRelayConfig(), audit: null });
  expectHumanError(root, 'audit', '对象');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadRelayConfig：缺 audit 的残缺 config → 补 init 同款默认并继续', () => {
  const root = tmpRoot();
  writeConfig(root, { gate: { command: 'npm test' }, protectedPaths: ['secret.env'] });
  const cfg = loadRelayConfig(root);
  assert.equal(cfg.gate.command, 'npm test', '已有字段不被动');
  assert.deepEqual(cfg.protectedPaths, ['secret.env']);
  assert.deepEqual(cfg.audit, defaultRelayConfig().audit, '缺 audit 应补 init 同款默认');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadRelayConfig：空对象 → 全部补默认（与 init 样例一致）', () => {
  const root = tmpRoot();
  writeConfig(root, {});
  assert.deepEqual(loadRelayConfig(root), defaultRelayConfig());
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadRelayConfig：完整合法 config 原样读回', () => {
  const root = tmpRoot();
  writeConfig(root, defaultRelayConfig());
  assert.deepEqual(loadRelayConfig(root), defaultRelayConfig());
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadRelayConfig：文件不存在 → 报错提示 relay init', () => {
  const root = tmpRoot();
  expectHumanError(root, '未找到', 'relay init');
  fs.rmSync(root, { recursive: true, force: true });
});
