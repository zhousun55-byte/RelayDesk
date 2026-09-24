import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { withFakes } from './fakes';
import { CLI, sandbox, until, type Sandbox } from './helpers';

/** 起一个真的接力台（relay ui），用 HTTP 打它。 */
async function startUi(s: Sandbox): Promise<{ child: ChildProcess; port: number; call: (p: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: Record<string, any> }> }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [CLI, 'ui', s.repo, '--port', String(port), '--no-open'], { cwd: s.repo, env: { ...s.env, RELAY_WATCH_DEBOUNCE_MS: '150', RELAY_WATCH_TICK_MS: '400' } });
  let out = '';
  child.stdout?.on('data', (c) => (out += c));
  child.stderr?.on('data', (c) => (out += c));
  await until(15_000, () => /接力台已启动：http:\/\/127\.0\.0\.1:(\d+)/.test(out), `接力台启动（${out}）`);
  const actual = Number(out.match(/127\.0\.0\.1:(\d+)/)![1]);
  const base = `http://127.0.0.1:${actual}`;
  const call = async (p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${p}`, body === undefined ? { headers } : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { child, port: actual, call };
}

const q = (s: Sandbox) => `?dir=${encodeURIComponent(s.repo)}`;

test('网页接口：接入 → 写任务 → 派人接着做一棒 → 看交接和改动 → 退回再撤销', async () => {
  const s = sandbox('srv');
  withFakes(s);
  s.relay(['detect', '--offline']);
  const ui = await startUi(s);
  try {
    assert.equal((await ui.call('/api/ping')).json.app, 'relay');
    let st = await ui.call(`/api/state${q(s)}`);
    assert.equal(st.json.project.init, false);

    const init = await ui.call('/api/init', { dir: s.repo });
    assert.equal(init.status, 200, JSON.stringify(init.json));
    assert.ok(s.exists('.relay/接力本.md'));
    const task = await ui.call('/api/task', { dir: s.repo, text: '做两件事', steps: ['第一件', '第二件'] });
    assert.equal(task.status, 200, JSON.stringify(task.json));

    st = await ui.call(`/api/state${q(s)}`);
    assert.equal(st.json.project.init, true);
    assert.equal(st.json.project.task.total, 2);
    assert.deepEqual(
      st.json.members.map((m: { name: string; tier: string }) => [m.name, m.tier]),
      [
        ['codex', 'strong'],
        ['claude', 'weak'],
      ],
      '强的排在前面'
    );

    const go = await ui.call('/api/go', { dir: s.repo, who: 'claude' });
    assert.equal(go.status, 200, JSON.stringify(go.json));
    await until(15_000, async () => (await ui.call(`/api/state${q(s)}`)).json.project.go?.status === 'done', '这一棒做完');
    st = await ui.call(`/api/state${q(s)}`);
    assert.equal(st.json.project.stints.length, 1);
    assert.equal(st.json.project.pending.length, 1, '弱模型的棒待复核');
    assert.equal(st.json.project.task.done, 1);

    const detail = await ui.call(`/api/stint${q(s)}&id=1`);
    assert.match(detail.json.handoff, /在 work\.txt 里加了一行/);
    const diff = await ui.call(`/api/diff${q(s)}&id=1`);
    assert.deepEqual(
      diff.json.files.map((f: { path: string }) => f.path),
      ['work.txt']
    );

    const mark = await ui.call('/api/mark', { dir: s.repo, stint: 1 });
    assert.equal(mark.status, 200);
    st = await ui.call(`/api/state${q(s)}`);
    assert.equal(st.json.project.pending.length, 0, '你说不用复核就不用');

    const rb = await ui.call('/api/rollback', { dir: s.repo, stint: 1 });
    assert.equal(rb.status, 200, JSON.stringify(rb.json));
    assert.ok(!s.exists('work.txt'));
    const undo = await ui.call('/api/rollback/undo', { dir: s.repo });
    assert.equal(undo.status, 200, JSON.stringify(undo.json));
    assert.ok(s.exists('work.txt'));
  } finally {
    ui.child.kill();
  }
});

test('网页开着时盯着文件夹：你在别的工具里改文件、写交接，接力台自动记上账', async () => {
  const s = sandbox('srv-watch');
  withFakes(s);
  s.relay(['detect', '--offline']);
  s.relay(['init', '做滤镜']);
  const ui = await startUi(s);
  try {
    await ui.call(`/api/state${q(s)}`);
    s.write('filter.xmp', '<x/>\n');
    s.write('.relay/交接/第1棒-0924-2100-codex.md', '# 交接：Codex · gpt-6\n\n- 状态：已交接\n\n## 做了什么\n\n- 写了 filter.xmp\n');
    await until(15_000, () => s.stints().some((x) => x.status === 'handed'), '自动记上第 1 棒');
    const st = s.stints()[0];
    assert.equal(st.who.member, 'codex');
    assert.equal(st.review, 'skip');
    assert.deepEqual(st.facts.paths, ['filter.xmp']);
  } finally {
    ui.child.kill();
  }
});

test('网页接口：强弱可以改；投票出结果后采纳，写进任务的约定', async () => {
  const s = sandbox('srv-vote');
  withFakes(s);
  s.relay(['detect', '--offline']);
  s.relay(['init', '做滤镜']);
  const ui = await startUi(s);
  try {
    const t = await ui.call('/api/members/tier', { name: 'claude', tier: 'strong' });
    assert.equal(t.status, 200);
    const claude = t.json.members.find((m: { name: string }) => m.name === 'claude');
    assert.equal(claude.tier, 'strong');
    assert.equal(claude.tierSet, true);

    const v = await ui.call('/api/vote/start', { dir: s.repo, question: '导出什么格式？', voters: ['claude', 'codex'] });
    assert.equal(v.status, 200, JSON.stringify(v.json));
    const id = v.json.vote.id;
    await until(15_000, async () => (await ui.call(`/api/talk${q(s)}`)).json.votes.find((x: { id: string }) => x.id === id)?.status === 'done', '投完票');
    const done = (await ui.call(`/api/talk${q(s)}`)).json.votes.find((x: { id: string }) => x.id === id);
    assert.equal(done.options.length, 2);
    const mine = await ui.call('/api/vote/cast', { dir: s.repo, id, key: 'A' });
    assert.equal(mine.json.vote.ballots.length, 3, '你也投了一票');
    const ad = await ui.call('/api/vote/adopt', { dir: s.repo, id, key: done.leaders[0] });
    assert.equal(ad.status, 200, JSON.stringify(ad.json));
    assert.match(s.read('.relay/任务.md'), /导出什么格式？ → 采用方案/);
    assert.match(s.read('.relay/接力本.md'), /采用方案/, '接力本里也能看到约定');
  } finally {
    ui.child.kill();
  }
});

test('网页接口的安全检查：只认本机地址和本端口，POST 必须是 JSON；网页能关闭接力台', async () => {
  const s = sandbox('srv-sec');
  const ui = await startUi(s);
  let exited = false;
  ui.child.on('exit', () => (exited = true));
  try {
    // fetch 会忽略自定义的 Host，用原始 http 请求模拟 DNS 重绑定。
    const badHost = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: ui.port, path: '/api/ping', headers: { host: `evil.example:${ui.port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(badHost, 403);
    assert.equal((await ui.call('/api/init', { dir: s.repo }, { Origin: 'http://evil.example.com' })).status, 403);
    assert.equal((await ui.call('/api/quit', {}, { Origin: 'http://evil.example.com' })).status, 403, '别的网站关不掉接力台');
    assert.ok(!s.exists('.relay'), '别的网站接入不了');
    const port = (await ui.call('/api/ping')).json;
    assert.equal(port.app, 'relay');
    const res = await ui.call('/api/quit', {});
    assert.equal(res.json.quitting, true);
    await until(10_000, () => exited, '接力台退出');
  } finally {
    if (!exited) ui.child.kill();
  }
});

test('不许接入整个家目录这种大文件夹', async () => {
  const s = sandbox('srv-home');
  const out = s.relay(['init'], false);
  assert.match(out, /接入了/);
  const bad = spawnRelay(s, ['init'], s.home);
  assert.match(bad, /太大了|不像是一个项目/);
});

function spawnRelay(s: Sandbox, args: string[], cwd: string): string {
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...s.env, HOME: s.home } });
  return (r.stdout ?? '') + (r.stderr ?? '');
}

