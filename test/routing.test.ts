import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { blockedOf, BLOCK_MS, failureKind, type QuotaFile } from '../src/core/quota';
import { setOrder, withFakes } from './fakes';
import { sandbox } from './helpers';

/**
 * 路由：每一位都派得准、不白跑（借 magpie 给失败分类）。
 * 「模型这个账号用不了」「没登录」换个时间再试也一样：先停用这一位，派活、群聊直接跳过，
 * 换了模型、重新登录（或在设置里点「再试一次」）、过一阵、做成一棒之后再算。网络抖、额度用完照旧。
 */

test('认失败：模型用不了、没登录各算一种；额度、限流、网络、别的报错不算（照旧等恢复、往后放）', () => {
  assert.equal(failureKind(`ERROR: {"detail":"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."}`), 'model', '2026-10-01 的原话');
  assert.equal(failureKind('Error: 404 model_not_found'), 'model');
  assert.equal(failureKind('The model `glm-9` does not exist or you do not have access to it.'), 'model');
  assert.equal(failureKind('请求失败：模型不存在'), 'model');
  assert.equal(failureKind('Invalid API key · Please run /login'), 'auth');
  assert.equal(failureKind('dsh: ACCOUNT_SIGN_IN_REQUIRED: sign in first'), 'auth');
  assert.equal(failureKind('API Error: 401 Unauthorized'), 'auth');
  assert.equal(failureKind('ERROR: You have hit your usage limit. Upgrade to Pro or try again in 2 hours 5 minutes.'), null, '额度用完：等恢复');
  assert.equal(failureKind('429 Too Many Requests: rate limit exceeded for model gpt-6'), null, '限流里提到 model 也是额度');
  assert.equal(failureKind('API Error: Connection error (ECONNRESET)'), null);
  assert.equal(failureKind('something broke'), null);
  assert.equal(failureKind(''), null);
});

test('停用多久：没登录的 30 分钟后再试；模型用不了的换了模型就算，不换最多 12 小时', () => {
  const at = new Date('2026-10-03T10:00:00Z');
  const all: QuotaFile['blocked'] = {
    codex: { kind: 'model', note: '模型 gpt-6.1-sol 用不了', at: at.toISOString(), model: 'gpt-6.1-sol' },
    claude: { kind: 'auth', note: '没登录或登录过期', at: at.toISOString() },
  };
  const later = (ms: number) => new Date(at.getTime() + ms);
  assert.equal(blockedOf('codex', 'gpt-6.1-sol', later(3600_000), all)?.kind, 'model');
  assert.equal(blockedOf('codex', 'gpt-6-sol', later(60_000), all), null, '换了模型');
  assert.equal(blockedOf('codex', 'gpt-6.1-sol', later(BLOCK_MS.model), all), null, '12 小时后再试一次');
  assert.equal(blockedOf('claude', undefined, later(29 * 60_000), all)?.kind, 'auth');
  assert.equal(blockedOf('claude', undefined, later(30 * 60_000), all), null);
  assert.equal(blockedOf('cursor-agent', undefined, at, all), null);
});

test('全自动：Codex 说这个账号用不了 gpt-6.1-sol，先停用它、这一轮换人做；下一轮不再先去试它；它做成一棒就恢复', () => {
  const s = sandbox('route-block');
  withFakes(s);
  s.relay(['detect', '--offline']);
  s.relay(['init']);
  s.relay(['task', '做几步', '--step', '一', '二', '三']);
  setOrder(s, ['codex', 'claude'], { finalReview: false });
  const quota = () => JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'quota.json'), 'utf8')) as QuotaFile;
  const calls = (name: string) => fs.readFileSync(s.env.FAKE_LOG!, 'utf8').split('\n').filter((l) => l.startsWith(`${name} `) && !/--version|models|login/.test(l)).length;

  s.env.FAKE_CODEX_MODE = 'model-refused';
  s.relay(['go'], true);
  let st = s.stints();
  assert.equal(st[0].who.member, 'codex');
  assert.equal(st[0].status, 'failed');
  const b = quota().blocked.codex;
  assert.equal(b?.kind, 'model');
  assert.match(b.note, /用不了，原话：.*not supported when using Codex with a ChatGPT account/);
  assert.equal(quota().errors.codex, undefined, '不再按「出错了过几分钟再试」记');

  const before = calls('codex');
  s.relay(['go']);
  st = s.stints();
  assert.equal(st.at(-1)!.who.member, 'claude', '停用的 Codex 排在顺序第一也不派');
  assert.equal(calls('codex'), before, '没有再去试 Codex');
  const team = s.relay(['detect', '--offline']);
  assert.match(team, /Codex.*用不了，原话/, `成员表里写着为什么：\n${team}`);
  assert.match(s.relay(['doctor']), /先停用着：.*用不了/);

  // 点名派给它、做成了：停用清掉
  s.env.FAKE_CODEX_MODE = 'work';
  s.relay(['go', 'codex']);
  assert.equal(quota().blocked.codex, undefined);
});

test('全自动：没登录的那一位（Claude Code 说 Please run /login）先停用，换人做', () => {
  const s = sandbox('route-auth');
  withFakes(s);
  s.relay(['detect', '--offline']);
  s.relay(['init']);
  s.relay(['task', '做几步', '--step', '一', '二']);
  setOrder(s, ['claude', 'codex'], { finalReview: false });
  s.env.FAKE_CLAUDE_MODE = 'logged-out';
  s.relay(['go'], true);
  s.relay(['go']);
  const st = s.stints();
  assert.deepEqual(
    st.map((x) => [x.who.member, x.status]),
    [
      ['claude', 'failed'],
      ['codex', 'handed'],
    ]
  );
  const q = JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'quota.json'), 'utf8')) as QuotaFile;
  assert.equal(q.blocked.claude?.kind, 'auth');
  assert.match(q.blocked.claude.note, /没登录或登录过期，原话：Invalid API key · Please run \/login/);
});
