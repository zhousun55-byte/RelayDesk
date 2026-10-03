import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 建快照仓库：先在旁边建好再挪过去，几个进程同时建也不撞；挪不过去（Windows 上杀毒软件占着刚建的文件）就原地建。
 * 这个文件在 Windows 上也跑（.github/workflows/test.yml）：挪文件夹在 Windows 上的规矩和 Mac、Linux 不一样。
 */
test('快照仓库：网页开着时在终端里接入同一个文件夹，几个进程同时建快照仓库也不撞（以前对同一个文件夹 git init：config 被锁、模板复制失败）', async () => {
  const snapJs = path.join(__dirname, '..', 'src', 'core', 'snap.js');
  for (let round = 0; round < 3; round++) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-snap-race-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    const code = `try{require(${JSON.stringify(snapJs)}).ensureSnapRepo(${JSON.stringify(root)})}catch(e){console.error(e.message);process.exit(1)}`;
    const runs = await Promise.all(
      [...Array(6)].map(
        () =>
          new Promise<{ code: number | null; err: string }>((resolve) => {
            const c = spawn(process.execPath, ['-e', code], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
            let err = '';
            c.stderr.on('data', (d) => (err += d));
            c.on('exit', (x) => resolve({ code: x, err }));
          }),
      ),
    );
    for (const r of runs) assert.equal(r.code, 0, r.err);
    assert.ok(fs.existsSync(path.join(root, '.relay', 'snapshots', 'HEAD')));
    assert.deepEqual(fs.readdirSync(path.join(root, '.relay')), ['snapshots'], '没有留下建到一半的临时文件夹');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('快照仓库：挪不过去（Windows 上杀毒软件正占着刚建的文件，挪文件夹报 EPERM）就照原来的办法原地建，不留临时文件夹', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const snap = require('../src/core/snap') as typeof import('../src/core/snap');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-snap-eperm-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'x');
  const rename = fs.renameSync;
  let tried = 0;
  fs.renameSync = (() => {
    tried++;
    throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
  }) as typeof fs.renameSync;
  try {
    snap.ensureSnapRepo(root);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(tried, 1, '先试过挪');
  assert.ok(snap.hasSnapRepo(root), '原地建好了');
  assert.deepEqual(fs.readdirSync(path.join(root, '.relay')), ['snapshots'], '临时文件夹删掉了');
  fs.rmSync(root, { recursive: true, force: true });
});
