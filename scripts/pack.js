// node scripts/pack.js：做 Mac、Windows 两个下载包，放在 release/：
//   RelayDesk-mac.zip      解压出 RelayDesk 文件夹，双击「安装接力台（Mac）.command」
//   RelayDesk-windows.zip  解压出 RelayDesk 文件夹，双击 install-windows.cmd
// 包里是编译好的 dist/src 和运行要的依赖，装的时候不下依赖、不编译，只要 Node.js 20+（Windows 上没有的话安装程序用 winget 装）。
// 各自只带自己平台的安装脚本。文件名不带版本号：README 的下载链接指向 releases/latest/download/<文件名>。
//   --no-build   用现成的 dist（npm test 刚编过）
//   --no-zip     只摆好文件夹（release/mac/RelayDesk、release/windows/RelayDesk），不压缩（测试用）
//   --out <dir>  放到别处
// 压缩用 macOS 的 ditto（保留可执行权限，中文文件名解压不乱码）；没有 ditto 用 zip。
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const at = (...p) => path.join(root, ...p);
const args = process.argv.slice(2);
const out = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : at('release'));
const pkg = JSON.parse(fs.readFileSync(at('package.json'), 'utf8'));

const run = (cmd, argv, cwd = root) => {
  const r = spawnSync(cmd, argv, { cwd, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} 失败`);
};

if (!args.includes('--no-build')) run(process.execPath, [at('scripts/build.js')]);
if (!fs.existsSync(at('dist/src/cli.js'))) throw new Error('还没编译：先 npm run build');

// 运行要的依赖（package.json 的 dependencies，连同它们自己的），从 node_modules 里照搬。
const deps = new Set();
(function need(names) {
  for (const n of names) {
    if (deps.has(n)) continue;
    const dir = at('node_modules', n);
    if (!fs.existsSync(dir)) throw new Error(`node_modules 里没有 ${n}：先 npm install`);
    deps.add(n);
    need(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies ?? {}));
  }
})(Object.keys(pkg.dependencies ?? {}));

const COMMON = ['dist/src', 'LICENSE', 'README.md', 'README.en.md', ...[...deps].map((n) => `node_modules/${n}`)];
const ONLY = {
  mac: ['安装接力台（Mac）.command', 'scripts/make-desktop-app.sh', 'scripts/open-relay.sh', 'scripts/icon.png', 'scripts/AppIcon.icon', 'scripts/Assets.car'],
  windows: ['install-windows.cmd', 'scripts/windows'],
};

fs.rmSync(out, { recursive: true, force: true });
for (const [os, only] of Object.entries(ONLY)) {
  const dir = path.join(out, os, 'RelayDesk');
  for (const rel of [...COMMON, ...only]) fs.cpSync(at(rel), path.join(dir, rel), { recursive: true, preserveTimestamps: true });
  // 包里的 package.json 只留运行用得到的（版本号网页和 relay --version 要读）；没有 src，不编译。
  const { name, version, description, license, author, bin, engines, dependencies } = pkg;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, description, license, author, private: true, type: pkg.type, bin, engines, dependencies, scripts: { start: 'node dist/src/cli.js ui' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'INSTALL.txt'), fs.readFileSync(at('scripts', 'release', `INSTALL-${os}.txt`), 'utf8').replaceAll('{version}', version));
  if (args.includes('--no-zip')) continue;
  const zip = path.join(out, `RelayDesk-${os}.zip`);
  const ditto = spawnSync('ditto', ['-h'], { stdio: 'ignore' }).error === undefined;
  if (ditto) run('ditto', ['-c', '-k', '--norsrc', '--keepParent', dir, zip]);
  else run('zip', ['-q', '-r', '-X', zip, 'RelayDesk'], path.dirname(dir));
  console.log(`${path.relative(root, zip).startsWith('..') ? zip : path.relative(root, zip)}  ${(fs.statSync(zip).size / 1024 / 1024).toFixed(1)} MB`);
}
