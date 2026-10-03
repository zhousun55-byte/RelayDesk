// 下载包解开以后起不起得来：node scripts/pack-smoke.js <解开的 RelayDesk 文件夹> [端口]
// 用包里自己的启动器在后台启动（Mac 包：scripts/open-relay.sh；Windows 包：scripts/windows/launch.js，Node 写的，哪台电脑都能跑），
// 临时的 HOME 和 RELAY_HOME、不开网页；等 /api/ping 答上来、核对版本号，再用启动器请它关掉，等它真的停下。
// 顺带核对：启动没有改包里的东西（没装依赖、没编译）。成功退出码 0。
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = path.resolve(process.argv[2] ?? '');
const port = Number(process.argv[3]) || 7470 + Math.floor(Math.random() * 200);
const mac = fs.existsSync(path.join(dir, 'scripts', 'open-relay.sh'));
const launcher = mac ? ['/bin/zsh', [path.join(dir, 'scripts', 'open-relay.sh')]] : [process.execPath, [path.join(dir, 'scripts', 'windows', 'launch.js')]];
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pack-smoke-'));
const env = { ...process.env, HOME: home, USERPROFILE: home, RELAY_HOME: path.join(home, '.relay'), RELAY_PORT: String(port), RELAY_NO_BROWSER: '1', RELAY_AUTODETECT: 'off', RELAY_SCAN_APPS: 'off', RELAY_LOGIN_PATH: 'off' };
delete env.RELAY_KEEPER;
delete env.RELAY_AT_LOGIN;

const fail = (why) => {
  console.error(`下载包没起来：${why}`);
  process.exit(1);
};
const launch = (arg) => spawnSync(launcher[0], [...launcher[1], arg], { env, encoding: 'utf8', timeout: 60_000 });
const ping = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1000) })).json();
  } catch {
    return null;
  }
};

(async () => {
  if (!fs.existsSync(path.join(dir, 'dist', 'src', 'cli.js'))) fail(`${dir} 里没有 dist/src/cli.js`);
  if (fs.existsSync(path.join(dir, 'src'))) fail('包里不该带 src（带了会在用户电脑上编译）');
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  const before = fs.readdirSync(dir).sort().join(',');
  const stamp = fs.statSync(path.join(dir, 'dist', 'src', 'cli.js')).mtimeMs;

  // 解压、复制以后 package.json 常比编译结果新：照最坏的情况摆好，启动器也不该去编译
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 'package.json'), later, later);
  const r = launch('--background');
  if (r.status !== 0) fail(`启动器退出码 ${r.status}：${r.stderr || r.stdout}`);
  const p = await ping();
  if (p?.app !== 'relay') fail(`端口 ${port} 没有接力台`);
  if (p.version !== version) fail(`版本是 ${p.version}，包里写的是 ${version}`);

  launch('--quit');
  for (let i = 0; i < 40 && (await ping()); i++) await new Promise((res) => setTimeout(res, 250));
  if (await ping()) fail('请它关掉以后还在运行');
  // Windows 启动器在后台看着接力台：留下「你关了」的记号它才不再拉起
  await new Promise((res) => setTimeout(res, 2500));
  if (await ping()) fail('关掉以后又被拉起来了');

  if (fs.readdirSync(dir).sort().join(',') !== before) fail(`启动时改了包里的东西：${fs.readdirSync(dir).join(',')}`);
  if (fs.statSync(path.join(dir, 'dist', 'src', 'cli.js')).mtimeMs !== stamp) fail('启动时重新编译了');
  fs.rmSync(home, { recursive: true, force: true });
  console.log(`${mac ? 'Mac' : 'Windows'} 包：用启动器起来了（${version}，端口 ${port}），也关掉了`);
})();
