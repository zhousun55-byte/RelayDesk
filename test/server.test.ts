import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { CLI, sandbox, until, type Sandbox } from './helpers';

/** 起一个真的接力台（relay ui），用 HTTP 打它。 */
async function startUi(s: Sandbox): Promise<{ base: string; child: ChildProcess; call: (p: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: Record<string, unknown> }> }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [CLI, 'ui', s.repo, '--port', String(port), '--no-open'], { cwd: s.repo, env: s.env });
  let out = '';
  child.stdout?.on('data', (c) => (out += c));
  child.stderr?.on('data', (c) => (out += c));
  await until(15_000, () => /接力台已启动：http:\/\/127\.0\.0\.1:(\d+)/.test(out), `接力台启动（${out}）`);
  const actual = Number(out.match(/127\.0\.0\.1:(\d+)/)![1]);
  const base = `http://127.0.0.1:${actual}`;
  const call = async (p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${p}`, body === undefined ? { headers } : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { base, child, call };
}

function fakeTools(s: Sandbox): void {
  // 和 auto.test.ts 同样的假工具，精简版：claude 干活写 hello.txt，codex 审查一律通过。
  const bin = path.join(s.base, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'claude'),
    [
      '#!/bin/sh',
      'case "$1" in --version) echo "9.9.9 (Claude Code)"; exit 0 ;; auth) echo \'{"loggedIn":true}\'; exit 0 ;; esac',
      'cat > /dev/null',
      'echo hi > hello.txt',
      `printf '%s\\n' '{"type":"result","subtype":"success","result":"ok"}'`,
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(bin, 'codex'),
    [
      '#!/bin/sh',
      'case "$1" in --version) echo "codex-cli 9.9.9"; exit 0 ;; login) echo "Logged in using ChatGPT"; exit 0 ;; esac',
      'out=""; prev=""',
      'for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
      'cat > /dev/null',
      `printf '%s' '{"verdict":"pass","summary":"ok","issues":[]}' > "$out"`,
    ].join('\n')
  );
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  s.env.PATH = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
}

test('接力台网页接口：自动识别 → 一键全自动 → 页面状态里能看到进度和结果', async () => {
  const s = sandbox('srv-auto');
  fakeTools(s);
  s.relay(['init']);
  const ui = await startUi(s);
  try {
    const ping = await ui.call('/api/ping');
    assert.equal(ping.json.app, 'relay');

    const det = await ui.call('/api/detect', { offline: true });
    assert.equal(det.status, 200, JSON.stringify(det.json));
    const report = det.json.report as { harnesses: { id: string }[] };
    assert.deepEqual(
      report.harnesses.map((h) => h.id),
      ['claude', 'codex']
    );
    assert.ok((det.json.changes as string[]).length >= 2);

    const state0 = await ui.call(`/api/state?dir=${encodeURIComponent(s.repo)}`);
    const team = state0.json.team as { workers: { name: string }[]; reviewers: { name: string }[] };
    assert.deepEqual(
      team.workers.map((w) => w.name),
      ['claude', 'codex']
    );

    const start = await ui.call('/api/auto/start', { dir: s.repo, goal: '做一个 hello.txt', workers: ['claude'], reviewers: ['codex'] });
    assert.equal(start.status, 200, JSON.stringify(start.json));

    let last: Record<string, unknown> = {};
    await until(
      20_000,
      async () => {
        last = (await ui.call(`/api/state?dir=${encodeURIComponent(s.repo)}`)).json;
        const a = last.auto as { state: { status: string } } | null;
        return !!a && a.state.status !== 'running';
      },
      '全自动做完'
    );
    const a = last.auto as { state: { status: string; steps: { kind: string }[] }; tail: { text: string } | null };
    assert.equal(a.state.status, 'done', JSON.stringify(a.state));
    assert.ok(a.tail && a.tail.text.length > 0, '有日志');
    assert.equal(s.read('hello.txt'), 'hi\n');
    assert.equal((last.project as { task: unknown }).task, null, '任务已合回');

    const stop = await ui.call('/api/auto/stop', { dir: s.repo });
    assert.equal(stop.json.stopped, false, '没在跑时叫停无事发生');
  } finally {
    ui.child.kill('SIGTERM');
  }
});

test('接力台网页接口：只认本机页面；POST 必须是 JSON；不能读项目外的文件；设置会校验', async () => {
  const s = sandbox('srv-guard');
  s.relay(['init']);
  const ui = await startUi(s);
  try {
    const port = Number(new URL(ui.base).port);
    // fetch 会忽略自定义的 Host，用原始 http 请求模拟 DNS 重绑定。
    const badHost = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/ping', headers: { host: `evil.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(badHost, 403);
    const badOrigin = await ui.call('/api/auto/stop', { dir: s.repo }, { origin: 'http://evil.example' });
    assert.equal(badOrigin.status, 403);
    const form = await fetch(`${ui.base}/api/auto/stop`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'dir=x' });
    assert.equal(form.status, 403);
    const outside = await ui.call(`/api/file?dir=${encodeURIComponent(s.repo)}&side=main&path=${encodeURIComponent('../home/.relay/agents.json')}`);
    assert.equal(outside.status, 400);
    assert.equal(outside.json.code, 'outside');
    const bad = await ui.call('/api/auto/settings', { settings: { maxRounds: 99 } });
    assert.equal(bad.status, 400);
    assert.match(String(bad.json.error), /1–10/);
    const good = await ui.call('/api/auto/settings', { settings: { maxRounds: 2, workers: 'codex', autoMerge: false } });
    assert.equal(good.status, 200);
    assert.equal((good.json.settings as { maxRounds: number }).maxRounds, 2);
    const saved = JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'auto.json'), 'utf8'));
    assert.deepEqual(saved.workers, ['codex']);
    const noTeam = await ui.call('/api/auto/start', { dir: s.repo, goal: '随便' });
    assert.equal(noTeam.status, 400);
    assert.match(String(noTeam.json.error), /没有能全自动干活的工人/);
  } finally {
    ui.child.kill('SIGTERM');
  }
});

test('网页上「关闭接力台」：接口回话后 relay ui 自己退出；别的网站发来的关闭请求会被拒绝', async () => {
  const s = sandbox('srv-quit');
  s.relay(['init']);
  const ui = await startUi(s);
  const exited = new Promise<number | null>((resolve) => ui.child.once('exit', (code) => resolve(code)));
  try {
    const bad = await ui.call('/api/quit', {}, { origin: 'http://evil.example' });
    assert.equal(bad.status, 403, '别的网站不能叫它关掉');
    const r = await ui.call('/api/quit', {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.quitting, true);
    const code = await Promise.race([exited, new Promise<string>((res) => setTimeout(() => res('超时'), 8000))]);
    assert.equal(code, 0, '进程要正常退出');
  } finally {
    if (ui.child.exitCode === null) ui.child.kill();
  }
});
