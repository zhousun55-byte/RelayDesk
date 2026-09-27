import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 网页版和终端版共用一份核心，以终端版为准（见 scripts/sync-core.sh）。
 * 旁边有终端版时比一比，改了核心忘了拷过来，这里就不过；只下载了网页版的跳过。
 */
const CLI_DIR = process.env.RELAY_CLI_DIR ?? path.join(os.homedir(), '接力台CLI');
const here = fs.existsSync(path.join(CLI_DIR, 'src', 'ops', 'go.ts')) && spawnSync('zsh', ['-c', 'true']).status === 0;

test('和终端版共用的核心一模一样', { skip: here ? false : '旁边没有终端版' }, () => {
  const r = spawnSync('zsh', [path.join(__dirname, '..', '..', 'scripts', 'sync-core.sh'), '--check', CLI_DIR], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}改核心要先在终端版里改，再运行 zsh scripts/sync-core.sh 拷过来`);
});
