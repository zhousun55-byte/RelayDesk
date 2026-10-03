import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { CLI, sandbox, until, type Sandbox } from './helpers';

/** 网页的函数在沙箱里跑：先放进 i18n.js（界面上的字 T`…`、后台的字 tr(…)，默认中文）。 */
const I18N = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'i18n.js'), 'utf8').replace("'use strict';", '');
const runWeb = (code: string, ctx: vm.Context) => vm.runInNewContext(`${I18N}\n${code}`, ctx);

/**
 * 「接力台」小程序在后台看着接力台（2026-09-25 用户说：不想在终端里跑、不想自己开关、不想桌面上挂个图标）：
 * 编译出新版就自己重启、网页上点「关闭」留记号、启动脚本告诉小程序该不该重新拉起。
 */

// 这个文件里的测试不碰你真实的 ~/.relay。
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-keeper-home-')));
process.env.RELAY_HOME = path.join(HOME, '.relay');
process.env.RELAY_LOGIN_PATH = 'off';

/* eslint-disable @typescript-eslint/no-require-imports */
const keeper = require('../src/ops/keeper') as typeof import('../src/ops/keeper');
const envMod = require('../src/core/env') as typeof import('../src/core/env');
/* eslint-enable @typescript-eslint/no-require-imports */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DIST = path.join(path.dirname(CLI), '..');
const REPO = path.join(DIST, '..');
const OPEN_RELAY = path.join(REPO, 'scripts', 'open-relay.sh');
const HAS_ZSH = fs.existsSync('/bin/zsh');

test('编译出新版：变了、编完了（连着两次一样）、手上没活，才重启，而且只重启一次', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-build-'));
  const file = path.join(dir, 'cli.js');
  assert.equal(keeper.buildStamp(file), '', '还没编译出来');
  fs.writeFileSync(file, 'v1');
  assert.ok(keeper.buildStamp(file));
  let busy = true;
  let calls = 0;
  const stop = keeper.watchBuild(() => calls++, { file, intervalMs: 20, idle: () => !busy });
  try {
    await sleep(120);
    assert.equal(calls, 0, '没变就不重启');
    // 编译到一半：文件先没了、再一点点写出来
    fs.rmSync(file);
    await sleep(80);
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(file, `v2${'x'.repeat(i)}`);
      await sleep(8);
    }
    await sleep(120);
    assert.equal(calls, 0, '手上有活（调度、群聊、投票、检查）就先不重启');
    busy = false;
    await until(3000, () => calls === 1, '空下来就重启');
    await sleep(100);
    assert.equal(calls, 1, '只重启一次');
  } finally {
    stop();
  }
});

test('编译到一半（文件不在、还在变）不重启', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-build-'));
  const file = path.join(dir, 'cli.js');
  fs.writeFileSync(file, 'v1');
  let calls = 0;
  const stop = keeper.watchBuild(() => calls++, { file, intervalMs: 30, idle: () => true });
  try {
    fs.rmSync(file);
    await sleep(150);
    assert.equal(calls, 0, '文件不在（正在编译）');
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < 200) {
      fs.writeFileSync(file, `v2${'x'.repeat(i++)}`);
      await sleep(5);
    }
    assert.equal(calls, 0, '还在变（还没编完）');
    await until(3000, () => calls === 1, '编完了就重启');
  } finally {
    stop();
  }
});

/** 拷一份编译结果来跑：改它的修改时间假装编译出了新版，不动别的测试正在用的那份。 */
function copyApp(s: Sandbox): string {
  const app = path.join(s.base, 'app');
  fs.cpSync(path.join(DIST, 'src'), path.join(app, 'dist', 'src'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(app, 'package.json'));
  fs.symlinkSync(fs.realpathSync(path.join(REPO, 'node_modules')), path.join(app, 'node_modules'));
  return path.join(app, 'dist', 'src', 'cli.js');
}

async function startKeeper(s: Sandbox, cli: string): Promise<{ child: ChildProcess; out: () => string; call: (p: string, body?: unknown) => Promise<Record<string, any>> }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [cli, 'ui', s.repo, '--port', String(port), '--no-open'], {
    cwd: s.repo,
    env: { ...s.env, RELAY_KEEPER: '1', RELAY_BUILD_WATCH_MS: '100' },
  });
  let out = '';
  child.stdout?.on('data', (c) => (out += c));
  child.stderr?.on('data', (c) => (out += c));
  await until(15_000, () => /接力台已启动：http:\/\/127\.0\.0\.1:(\d+)/.test(out), `接力台启动（${out}）`);
  const base = `http://127.0.0.1:${out.match(/127\.0\.0\.1:(\d+)/)![1]}`;
  const call = async (p: string, body?: unknown) => {
    const res = await fetch(`${base}${p}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return (await res.json()) as Record<string, any>;
  };
  return { child, out: () => out, call };
}

test('小程序看着的接力台：状态里标明；编译出新版、手上没活就自己退出（等小程序用新版拉起）；网页上点「关闭」留下记号', async () => {
  const s = sandbox('keeper');
  const cli = copyApp(s);
  const marker = path.join(s.env.RELAY_HOME!, 'ui-stopped');

  let k = await startKeeper(s, cli);
  try {
    await until(5000, () => /小程序在后台看着/.test(k.out()), `说明由小程序看着（${k.out()}）`);
    const st = await k.call(`/api/state?dir=${encodeURIComponent(s.repo)}`);
    assert.equal(st.keeper, true);
    assert.ok(st.build, '带着编译结果的记号（网页看它变了就刷新）');
    // 编译出了新版
    fs.utimesSync(cli, new Date(), new Date(Date.now() + 60_000));
    await until(10_000, () => k.child.exitCode !== null, `有新版就自己退出（${k.out()}）`);
    assert.equal(k.child.exitCode, 0);
    assert.match(k.out(), /有新版本，重新启动/);
    assert.equal(fs.existsSync(marker), false, '换新版不是你关的：小程序要重新拉起');
  } finally {
    k.child.kill();
  }

  k = await startKeeper(s, cli);
  try {
    const st = await k.call(`/api/state?dir=${encodeURIComponent(s.repo)}`);
    assert.ok(st.build);
    await k.call('/api/quit', {});
    await until(10_000, () => k.child.exitCode !== null, '点「关闭」就退出');
    assert.equal(fs.existsSync(marker), true, '你关的：小程序看到记号就不再拉起');
  } finally {
    k.child.kill();
  }
});

test('不是小程序看着的接力台（在终端里跑 relay ui）：状态里不标，点「关闭」也不留记号', async () => {
  const s = sandbox('no-keeper');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [CLI, 'ui', s.repo, '--port', String(port), '--no-open'], { cwd: s.repo, env: s.env });
  let out = '';
  child.stdout?.on('data', (c) => (out += c));
  try {
    await until(15_000, () => /接力台已启动：http:\/\/127\.0\.0\.1:(\d+)/.test(out), `接力台启动（${out}）`);
    const base = `http://127.0.0.1:${out.match(/127\.0\.0\.1:(\d+)/)![1]}`;
    const st = (await (await fetch(`${base}/api/state?dir=${encodeURIComponent(s.repo)}`)).json()) as Record<string, any>;
    assert.equal(st.keeper, false);
    await until(5000, () => /关掉这个窗口/.test(out), `说明怎么关（${out}）`);
    await fetch(`${base}/api/quit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await until(10_000, () => child.exitCode !== null, '点「关闭」就退出');
    assert.equal(fs.existsSync(path.join(s.env.RELAY_HOME!, 'ui-stopped')), false);
  } finally {
    child.kill();
  }
});

/** 用假的 curl / pgrep / sleep / open 跑启动脚本：不碰这台电脑上真的接力台。 */
function runLauncher(s: Sandbox, args: string[], opts: { ping: boolean }): { code: number | null; out: string; opened: string } {
  const stubs = path.join(s.base, 'stubs');
  const log = path.join(s.base, 'opened.log');
  fs.mkdirSync(stubs, { recursive: true });
  const stub = (name: string, body: string) => fs.writeFileSync(path.join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub('curl', '[ -n "$STUB_PING" ] && echo \'{"ok":true,"app":"relay","version":"2.0.0"}\'\nexit 0');
  stub('pgrep', 'exit 1');
  stub('sleep', 'exit 0');
  stub('open', 'echo "$@" >> "$STUB_LOG"');
  stub('osascript', 'exit 0');
  fs.rmSync(log, { force: true });
  const env: NodeJS.ProcessEnv = { PATH: `${stubs}:/usr/bin:/bin`, HOME: s.home, RELAY_HOME: s.env.RELAY_HOME, STUB_LOG: log, LANG: 'en_US.UTF-8' };
  if (opts.ping) env.STUB_PING = '1';
  const r = spawnSync('/bin/zsh', [OPEN_RELAY, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, opened: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

test('启动脚本：--check 告诉小程序接力台在不在、是不是你关的；--background 不开网页；打开时去掉「你关了」的记号', { skip: !HAS_ZSH && '这台电脑没有 zsh' }, () => {
  const s = sandbox('launcher', { git: false });
  const marker = path.join(s.env.RELAY_HOME!, 'ui-stopped');
  fs.mkdirSync(s.env.RELAY_HOME!, { recursive: true });

  assert.equal(runLauncher(s, ['--check'], { ping: false }).code, 1, '没在运行：小程序重新拉起');
  fs.writeFileSync(marker, 'x');
  assert.equal(runLauncher(s, ['--check'], { ping: false }).code, 3, '你在网页上关的：小程序跟着退出');
  assert.equal(runLauncher(s, ['--check'], { ping: true }).code, 0, '在运行');

  const bg = runLauncher(s, ['--background'], { ping: true });
  assert.equal(bg.code, 0, bg.out);
  assert.match(bg.out, /7388/);
  assert.equal(bg.opened, '', '后台启动不打开网页');
  assert.equal(fs.existsSync(marker), false, '要它运行了：去掉记号');

  fs.writeFileSync(marker, 'x');
  const fg = runLauncher(s, [], { ping: true });
  assert.equal(fg.code, 0, fg.out);
  assert.match(fg.opened, /http:\/\/127\.0\.0\.1:7388\//, '打开「接力台」：打开网页');
  assert.equal(fs.existsSync(marker), false);
});

test('网页：接力台换了新版重启过，网页自己刷新；你正在打字、开着弹窗或菜单时先不刷，空下来再刷', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'app.js'), 'utf8').split(/\r?\n/);
  const fn = (name: string) => {
    const i = src.findIndex((l) => new RegExp(`^(async )?function ${name}\\(`).test(l));
    assert.ok(i >= 0, `app.js 里没有 ${name}`);
    let j = i;
    while (src[j] !== '}') j++;
    return src.slice(i, j + 1).join('\n');
  };
  const code = ['q', 'ticket', 'stale', 'setOffline', 'refresh'].map(fn).join('\n\n');
  const out: string[] = [];
  const script = `
const S = { dir: 'A', st: null, gen: 0, seq: {}, offline: false, build: '', newBuild: false };
const CE = { offline: { hidden: true }, offlineText: {}, offlineDot: {}, offlineRetry: {} };
const C = { ta: { value: '' } };
let sheetStack = [];
let menuOpen = false;
const layer = { querySelector: () => (menuOpen ? {} : null) };
let reloads = 0;
const location = { reload() { reloads++; } };
let renders = 0;
const renderAll = () => { renders++; }, toast = () => {}, loadSessions = () => {};
const show = (el, on) => { el.hidden = !on; };
let build = 'a';
async function api() { return { build, project: { root: 'A' } }; }
${code}
(async () => {
  await refresh(); await refresh();
  out(JSON.stringify(['同一版', reloads, S.build]));
  build = 'b'; C.ta.value = '写到一半的话';
  await refresh();
  out(JSON.stringify(['在打字', reloads, S.newBuild]));
  C.ta.value = ''; sheetStack = [() => {}];
  await refresh();
  out(JSON.stringify(['开着弹窗', reloads]));
  sheetStack = []; menuOpen = true;
  await refresh();
  out(JSON.stringify(['开着菜单', reloads]));
  menuOpen = false;
  await refresh();
  out(JSON.stringify(['空下来', reloads]));
  done();
})();`;
  await new Promise<void>((resolve, reject) => {
    try {
      runWeb(script, { setTimeout, URL, URLSearchParams, encodeURIComponent, TypeError, out: (x: string) => out.push(x), done: resolve });
    } catch (e) {
      reject(e);
    }
  });
  assert.deepEqual(JSON.parse(out[0]), ['同一版', 0, 'a']);
  assert.deepEqual(JSON.parse(out[1]), ['在打字', 0, true], '你写到一半的话不会被刷掉');
  assert.deepEqual(JSON.parse(out[2]), ['开着弹窗', 0]);
  assert.deepEqual(JSON.parse(out[3]), ['开着菜单', 0]);
  assert.deepEqual(JSON.parse(out[4]), ['空下来', 1]);
});

test('派给 AI 工具的环境里，不带接力台自己的运行方式（由小程序看着、登录时启动）', () => {
  process.env.RELAY_KEEPER = '1';
  process.env.RELAY_AT_LOGIN = '1';
  try {
    const e = envMod.agentEnv();
    assert.equal(e.RELAY_KEEPER, undefined);
    assert.equal(e.RELAY_AT_LOGIN, undefined);
  } finally {
    delete process.env.RELAY_KEEPER;
    delete process.env.RELAY_AT_LOGIN;
  }
});
