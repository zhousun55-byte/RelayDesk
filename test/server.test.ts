import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
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
    const unmark = await ui.call('/api/mark', { dir: s.repo, stint: 1, review: 'needed' });
    assert.equal(unmark.status, 200);
    st = await ui.call(`/api/state${q(s)}`);
    assert.equal(st.json.project.pending.length, 1, '跳过复核可以撤销');
    await ui.call('/api/mark', { dir: s.repo, stint: 1 });

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

test('网页接口：右边的项目文件、读文件（出不了项目文件夹）、在网页上改任务、按任务分的对话', async () => {
  const s = sandbox('srv-files');
  withFakes(s);
  s.relay(['detect', '--offline']);
  s.write('src/a.ts', 'export const a = 1;\n');
  s.write('node_modules/x/index.js', '');
  const ui = await startUi(s);
  try {
    let tree = await ui.call(`/api/tree${q(s)}`);
    assert.ok(tree.json.files.includes('src/a.ts'), '没接入也能看文件');
    assert.ok(!tree.json.files.some((f: string) => f.startsWith('node_modules/') || f.startsWith('.git/')));
    await ui.call('/api/init', { dir: s.repo });
    await ui.call('/api/task', { dir: s.repo, text: '做两件事', steps: ['一', '二'] });
    tree = await ui.call(`/api/tree${q(s)}`);
    assert.ok(tree.json.files.includes('src/a.ts'));
    assert.ok(!tree.json.files.some((f: string) => f.startsWith('.relay/') || f.startsWith('node_modules/')), '接力台自己的东西、依赖都不列');

    const f = await ui.call(`/api/file${q(s)}&path=${encodeURIComponent('src/a.ts')}`);
    assert.equal(f.json.text, 'export const a = 1;\n');
    assert.equal(f.json.binary, false);
    fs.writeFileSync(path.join(s.base, 'secret.txt'), '项目外面的文件\n');
    fs.symlinkSync(s.base, path.join(s.repo, 'outside'));
    for (const bad of ['../secret.txt', path.join(s.base, 'secret.txt'), '.relay/snapshots/HEAD', '.git/config', 'outside/secret.txt']) {
      const r = await ui.call(`/api/file${q(s)}&path=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 400, `不能读 ${bad}`);
    }
    assert.equal((await ui.call('/api/reveal', { dir: s.repo, path: '../x' })).status, 400);

    const e = await ui.call('/api/task/edit', { dir: s.repo, op: 'toggle', index: 1 });
    assert.equal(e.status, 200, JSON.stringify(e.json));
    assert.deepEqual(
      e.json.task.items.map((i: { done: boolean }) => i.done),
      [false, true]
    );
    await ui.call('/api/task/edit', { dir: s.repo, op: 'add', text: '三' });
    await ui.call('/api/task/edit', { dir: s.repo, op: 'title', text: '做三件事' });
    assert.match(s.read('.relay/任务.md'), /做三件事[\s\S]*- \[x\] 二\n- \[ \] 三/);
    assert.match(s.read('.relay/接力本.md'), /- \[ \] 三/, '接力本跟着更新');
    assert.equal((await ui.call('/api/task/edit', { dir: s.repo, op: 'toggle', index: 9 })).status, 400);
    assert.equal((await ui.call('/api/task/edit', { dir: s.repo, op: 'bogus' })).status, 400);

    await ui.call('/api/task', { dir: s.repo, text: '下一件事' });
    const st = await ui.call(`/api/state${q(s)}`);
    assert.deepEqual(
      st.json.project.threads.map((t: { title: string; current: boolean }) => [t.title, t.current]),
      [
        ['做三件事', false],
        ['下一件事', true],
      ]
    );
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
    // 重新识别在子进程里跑（接力台自己不卡）：结果照样带回来，名单照样更新，做完「正在识别」要复位。
    const d = await ui.call('/api/detect', { dir: s.repo, offline: true });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    assert.ok(d.json.report.harnesses.some((x: { id: string }) => x.id === 'claude'));
    assert.ok(Array.isArray(d.json.changes));
    assert.deepEqual(d.json.members.map((m: { name: string }) => m.name).sort(), ['claude', 'codex']);
    assert.equal((await ui.call(`/api/state${q(s)}`)).json.detecting, false);

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
    // 别的网站里的一张图片：不带 Origin，浏览器标明是从别的网站来的（Sec-Fetch-Site: cross-site）
    const fromOtherSite = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: ui.port, path: `/api/diff${q(s)}`, headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(fromOtherSite, 403);
    // 看改动要先存快照：没接入的文件夹不给建快照仓库
    const diff = await ui.call(`/api/diff${q(s)}`);
    assert.equal(diff.status, 400);
    assert.equal(diff.json.code, 'not-init');
    assert.ok(!s.exists('.relay'), '没给没接入的文件夹建快照仓库');
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

