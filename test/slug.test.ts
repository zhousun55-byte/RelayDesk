import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchNameFor, newId, slugify } from '../src/core/slug';

test('slugify: ASCII 词转 kebab', () => {
  assert.equal(slugify('Add login page!!'), 'add-login-page');
  assert.equal(slugify('  fix   CSRF   bug '), 'fix-csrf-bug');
});

test('slugify: 中文/空标题退化为 task（F10：分支不吃中文）', () => {
  assert.equal(slugify('给登录页加验证码'), 'task');
  assert.equal(slugify('   '), 'task');
});

test('slugify: 超长标题截断到 24 字符', () => {
  assert.ok(slugify('a'.repeat(100)).length <= 24);
});

test('branchNameFor: 分支名形如 relay/<slug>-<4位id>', () => {
  const { slug, id, branch } = branchNameFor('Add greeting');
  assert.equal(slug, 'add-greeting');
  assert.match(id, /^[0-9a-f]{4}$/);
  assert.equal(branch, `relay/${slug}-${id}`);
  assert.ok(!branch.includes(' '));
});

test('newId: 4 位十六进制', () => {
  assert.match(newId(), /^[0-9a-f]{4}$/);
});
