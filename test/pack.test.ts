import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLI } from './helpers';

/**
 * 下载包（2026-10-03 用户要开源时 GitHub 上分 Mac、Windows 两个下载）：scripts/pack.js 摆好两个文件夹，
 * 各自只带自己平台的安装脚本，带着编译结果和运行依赖、不带源码；解开以后用包里的启动器起得来、关得掉，而且不去编译。
 */

const REPO = path.join(path.dirname(CLI), '..', '..');
const has = (dir: string, rel: string) => fs.existsSync(path.join(dir, rel));

test('下载包：Mac、Windows 各带各的安装脚本，带编译结果和依赖、不带源码，解开就能启动', { timeout: 180_000 }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pack-'));
  try {
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'pack.js'), '--no-build', '--no-zip', '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const mac = path.join(out, 'mac', 'RelayDesk');
    const win = path.join(out, 'windows', 'RelayDesk');
    const version = (JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { version: string }).version;

    for (const dir of [mac, win]) {
      for (const rel of ['dist/src/cli.js', 'dist/src/web/index.html', 'node_modules/commander/package.json', 'LICENSE', 'INSTALL.txt']) assert.ok(has(dir, rel), `${dir} 里有 ${rel}`);
      for (const rel of ['src', 'test', 'dist/test', 'docs', 'tsconfig.json']) assert.ok(!has(dir, rel), `${dir} 里不带 ${rel}`);
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(pkg.version, version);
      assert.equal(pkg.devDependencies, undefined);
      assert.match(fs.readFileSync(path.join(dir, 'INSTALL.txt'), 'utf8'), new RegExp(version.replaceAll('.', '\\.')));
    }
    assert.ok(has(mac, '安装接力台（Mac）.command') && has(mac, 'scripts/make-desktop-app.sh') && has(mac, 'scripts/open-relay.sh'));
    assert.ok(!has(mac, 'install-windows.cmd') && !has(mac, 'scripts/windows'), 'Mac 包不带 Windows 的');
    assert.ok(has(win, 'install-windows.cmd') && has(win, 'scripts/windows/launch.js') && has(win, 'scripts/windows/install.ps1'));
    assert.ok(!has(win, '安装接力台（Mac）.command') && !has(win, 'scripts/open-relay.sh') && !has(win, 'scripts/make-desktop-app.sh'), 'Windows 包不带 Mac 的');
    if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(mac, '安装接力台（Mac）.command')).mode & 0o100, '双击的安装文件可执行');

    // Windows 的启动器是 Node 写的，哪台电脑都能跑；Mac 的要 zsh
    for (const dir of process.platform === 'win32' ? [win] : fs.existsSync('/bin/zsh') ? [mac, win] : [win]) {
      const s = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'pack-smoke.js'), dir], { encoding: 'utf8', timeout: 120_000 });
      assert.equal(s.status, 0, `${s.stdout}${s.stderr}`);
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
