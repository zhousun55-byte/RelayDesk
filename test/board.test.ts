import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adoptProject } from '../src/core/adopt';
import { loadDeskState } from '../src/core/board';
import { defaultRelayConfig } from '../src/core/config';
import { createUiServer } from '../src/ui/server';

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-board-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

test('desk：普通文件夹 → not_git', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-nogit-'));
  const s = loadDeskState(dir);
  assert.equal(s.phase, 'not_git');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('desk：普通文件夹按开始 → 做成项目，可以写任务', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-adopt-'));
  const root = adoptProject(dir);
  const s = loadDeskState(root);
  assert.equal(s.phase, 'idle');
  assert.equal(s.inited, true);
  assert.ok(fs.existsSync(path.join(root, '.git')));
  assert.ok(fs.existsSync(path.join(root, '.relay', 'config.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('desk：git 仓库未 init → need_init', () => {
  const dir = tmpRepo();
  const s = loadDeskState(dir);
  assert.equal(s.phase, 'need_init');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('desk：已 init 无任务 → idle，并带上文件和当前项目', () => {
  const dir = tmpRepo();
  fs.mkdirSync(path.join(dir, '.relay'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.relay', 'config.json'), JSON.stringify(defaultRelayConfig(), null, 2));
  const s = loadDeskState(dir);
  assert.equal(s.phase, 'idle');
  assert.equal(s.inited, true);
  assert.ok(s.files.some((f) => f.name === 'README.md' && f.kind === 'file'));
  assert.ok(s.projects.some((p) => p.current && path.resolve(p.root) === path.resolve(s.root)));
  assert.equal(s.legs.length, 4);
  assert.equal(s.papers.length, 3);
  assert.equal(s.papers[0].empty, true);
  assert.ok(s.dockets.some((d) => d.current && d.name === path.basename(dir)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('接力台网页：/api/state 返回 JSON', async () => {
  const dir = tmpRepo();
  const server = createUiServer();
  const prevHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-home-'));
  process.env.HOME = home;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state?root=${encodeURIComponent(dir)}`);
    assert.equal(r.ok, true);
    const j = (await r.json()) as { phase: string };
    assert.equal(j.phase, 'need_init');
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.ok, true);
    const html = await page.text();
    assert.ok(html.includes('接力'));
    assert.ok(html.includes('叠着的窗口'));
    assert.ok(html.includes('id="dockets"'));
    assert.ok(html.includes('id="talk-door"'));
    assert.ok(html.includes('id="talk"'));
    assert.ok(html.includes('id="talk-input"'));
    assert.equal(html.includes('id="talk-start"'), false);
    assert.ok(html.includes('>接力</button>'));
    assert.ok(html.includes('id="history"'));
    assert.ok(html.includes('id="talk-add"'));
    assert.ok(html.includes('id="shelf"'));
    assert.equal(html.includes('新建文件'), false);
    assert.ok(html.includes('id="past"'));
    assert.ok(html.includes('id="rail-files"'));
    assert.ok(html.includes('id="clips"'));
    assert.ok(html.includes('id="talk-bar"'));
    assert.equal(html.includes('开工'), false);
    assert.equal(html.includes('最认真'), false);
    assert.equal(html.includes('>合回<'), false);
    assert.equal(html.includes('id="seats"'), false);
    assert.ok(html.includes('talk-sheet'));
    assert.ok(html.includes('id="track"'));
    assert.ok(html.includes('id="who-card"'));
    assert.ok(html.includes('class="relay-sec"'));
    assert.ok(!html.includes('talk.html'));
    assert.ok(Array.isArray((j as { chat?: unknown[]; files?: unknown[] }).chat));
    assert.ok(Array.isArray((j as { files?: unknown[] }).files));
  } finally {
    process.env.HOME = prevHome;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
