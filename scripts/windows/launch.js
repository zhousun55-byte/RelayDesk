// 接力台在 Windows 上的启动器。开始菜单和「启动」文件夹里的「接力台」快捷方式经 relaydesk.vbs 调它，不弹黑窗口。
//   launch.js               接力台没在运行就在后台启动它，然后用默认浏览器打开网页
//   launch.js --background  同上，但不打开网页（登录电脑时）
//   launch.js --quit        请接力台正常关闭
//   launch.js --keep        （内部用）在后台看着接力台：意外退出、编译出了新版，就重新拉起；
//                           你在网页上点了「关闭」（留下 ui-stopped 记号，见 src/ops/keeper.ts）就不再拉起，自己也退出
// 接力台的输出记在 %USERPROFILE%\.relay\ui.log。出错时退出码不是 0，relaydesk.vbs 弹窗并打开这个记录。
// 对应 Mac 上的 open-relay.sh 和「接力台」小程序。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', '..', 'dist', 'src', 'cli.js');
const HOME = process.env.RELAY_HOME || path.join(os.homedir(), '.relay');
const LOG = path.join(HOME, 'ui.log');
const STOPPED = path.join(HOME, 'ui-stopped');
const PORT = Number(process.env.RELAY_PORT) || 7388;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 正在运行的接力台在哪个端口（7388 被别的程序占着时它会往后顺延，最多 10 个）；没在运行是 0。 */
async function runningPort() {
  for (let p = PORT; p < PORT + 10; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/ping`, { signal: AbortSignal.timeout(1000) });
      if ((await r.json()).app === 'relay') return p;
    } catch {
      /* 这个端口上没有 */
    }
  }
  return 0;
}

function log(line) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.appendFileSync(LOG, `${line}\n`);
}

function fail(why) {
  log(why);
  console.error(why);
  process.exit(1);
}

async function keep() {
  const exits = [];
  for (;;) {
    log(`\n==== ${new Date().toLocaleString()} 由「接力台」启动器启动 ====`);
    const out = fs.openSync(LOG, 'a');
    const child = spawn(process.execPath, [CLI, 'ui', '--no-open', '--port', String(PORT)], {
      cwd: os.homedir(),
      env: { ...process.env, RELAY_KEEPER: '1' },
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    await new Promise((res) => {
      child.on('exit', res);
      child.on('error', res);
    });
    fs.closeSync(out);
    if (fs.existsSync(STOPPED)) return;
    const now = Date.now();
    exits.push(now);
    while (now - exits[0] > 60_000) exits.shift();
    if (exits.length >= 5) return log('一分钟里退出了 5 次，不再重新拉起。原因看上面几行。');
    await sleep(2000);
    // 别的接力台占着端口（比如在终端里用 npm start 开的）：不跟它抢。
    if (await runningPort()) return;
  }
}

async function main() {
  const mode = process.argv[2] || '';
  if (mode === '--keep') return keep();
  if (mode === '--quit') {
    const p = await runningPort();
    if (p) await fetch(`http://127.0.0.1:${p}/api/quit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => undefined);
    return;
  }
  fs.rmSync(STOPPED, { force: true });
  let port = await runningPort();
  if (!port) {
    if (!fs.existsSync(CLI)) fail('接力台还没编译。双击接力台文件夹里的 install-windows.cmd 再装一次。');
    try {
      if (fs.statSync(LOG).size > 2_000_000) fs.renameSync(LOG, `${LOG}.old`);
    } catch {
      /* 还没有记录 */
    }
    spawn(process.execPath, [__filename, '--keep'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    for (let i = 0; i < 60 && !port; i++) {
      await sleep(500);
      port = await runningPort();
    }
    if (!port) fail('接力台没能启动。');
  }
  if (mode !== '--background') spawn('explorer.exe', [`http://127.0.0.1:${port}/`], { detached: true, stdio: 'ignore' }).unref();
}

main();
