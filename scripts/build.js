// npm run build：编译到 dist.new，整个换掉 dist（正在运行的接力台看到新版，手上没活时自己换过去，见 src/ops/keeper.ts）。
// 用 Node 写，Mac、Linux、Windows 一样跑（以前是 rm / cp / mv，Windows 上没有）。
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const at = (p) => path.join(root, p);
for (const d of ['dist.new', 'dist.old']) fs.rmSync(at(d), { recursive: true, force: true });
const tsc = require.resolve('typescript/bin/tsc', { paths: [root] });
const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--outDir', 'dist.new'], { cwd: root, stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
fs.chmodSync(at('dist.new/src/cli.js'), 0o755);
fs.cpSync(at('src/web'), at('dist.new/src/web'), { recursive: true });
if (fs.existsSync(at('dist'))) fs.renameSync(at('dist'), at('dist.old'));
fs.renameSync(at('dist.new'), at('dist'));
fs.rmSync(at('dist.old'), { recursive: true, force: true });
