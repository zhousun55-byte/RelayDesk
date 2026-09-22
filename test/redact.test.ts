import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/core/redact';

test('redactSecrets：API key / GitHub token / 私钥块替换为 [REDACTED]', () => {
  const raw = [
    'const k = "sk-abcdefghijklmnopqrstuvwxyz012345";',
    'token: ghp_abcdefghijklmnopqrstuvwx',
    'AKIAIOSFODNN7EXAMPLE',
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIBOgIBAAJBAK8=',
    '-----END RSA PRIVATE KEY-----',
    'api_key=supersecretvalue99',
  ].join('\n');
  const out = redactSecrets(raw);
  assert.ok(!out.includes('sk-abcdefghijklmnopqrstuvwxyz012345'));
  assert.ok(!out.includes('ghp_abcdefghijklmnopqrstuvwx'));
  assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!out.includes('MIIBOgIBAAJBAK8='));
  assert.ok(!out.includes('supersecretvalue99'));
  assert.ok(out.includes('[REDACTED]'));
});

test('redactSecrets：普通业务 diff 不动', () => {
  const raw = '+UNIQUE-CONTENT-9f8e7d6c\n+hello world';
  assert.equal(redactSecrets(raw), raw);
});
