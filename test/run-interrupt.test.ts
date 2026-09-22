import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killProcessGroup } from '../src/commands/run';

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function until(deadlineMs: number, fn: () => boolean, what: string): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待超时：${what}`);
}

test('killProcessGroup：SIGKILL 整组击杀（孙进程也死）；无效 pid 返回 false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-kill-'));
  const pidFile = path.join(dir, 'pids');
  const child = spawn('sh', ['-c', `sleep 30 & echo "$$ $!" > '${pidFile}'; wait`], {
    detached: true,
    stdio: 'ignore',
  });
  assert.ok(child.pid !== undefined && child.pid > 0);
  try {
    await until(10_000, () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', '假 agent 写出 pid');
    const [leader, grand] = fs
      .readFileSync(pidFile, 'utf8')
      .trim()
      .split(/\s+/)
      .map(Number);
    assert.equal(leader, child.pid, 'detached child 应是进程组 leader');
    assert.ok(pidAlive(grand), '孙进程（sleep）应在组内活着');

    assert.equal(killProcessGroup(undefined), false, '无 pid 应返回 false');
    assert.equal(killProcessGroup(0), false, '非法 pid 应返回 false');
    assert.equal(killProcessGroup(-1), false, '非法 pid 应返回 false');
    assert.ok(killProcessGroup(child.pid, 'SIGKILL'));

    await until(10_000, () => !pidAlive(leader) && !pidAlive(grand), '整组死亡');
    assert.ok(!pidAlive(grand), '孙进程必须随组死亡——只杀直接 child 会留孤儿继续写盘');
  } finally {
    killProcessGroup(child.pid, 'SIGKILL'); // 兜底，避免泄漏 sleep 30
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('e2e 双重中断：第二次 Ctrl-C 先 SIGKILL agent 进程组再放锁，exit=130', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-int-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(home);

  // 倔 agent：sh 与孙进程（node）都忽略 SIGINT，第一次转发杀不死它；
  // 只有第二次的整组 SIGKILL 能收掉两个进程。node 装 handler 后写就绪文件（pid 文件写就绪 ≠
  // handler 已装好，直接发信号会踩启动竞态）；pid 文件在仓库外，不污染 worktree。
  const pidFile = path.join(base, 'agent-pids');
  const readyFile = path.join(base, 'agent-ready');
  const stubborn = path.join(base, 'stubborn-agent.sh');
  fs.writeFileSync(
    stubborn,
    [
      '#!/bin/sh',
      "trap '' INT",
      `'${process.execPath}' -e 'const fs=require("fs");process.on("SIGINT",()=>{});fs.writeFileSync("${readyFile}","ok");setTimeout(()=>{},60000)' &`,
      `echo "$$ $!" > '${pidFile}'`,
      'wait',
      '',
    ].join('\n')
  );
  fs.chmodSync(stubborn, 0o755);

  execFileSync('git', ['init', '-q', repo]);
  const g = (a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'init']);

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.DEEPSEEK_API_KEY;
  const relaySync = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: 'utf8', env });
  relaySync(['init']);
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'relay config']);
  relaySync(['agents', 'add', 'stubborn', '--cmd', stubborn, '--tier', 'strong']);
  relaySync(['start', 'interrupt test']);

  const projectsDir = path.join(home, '.relay', 'projects');
  let wt: string | null = null;
  for (const d of fs.readdirSync(projectsDir)) {
    const sp = path.join(projectsDir, d, 'session.json');
    if (fs.existsSync(sp)) wt = (JSON.parse(fs.readFileSync(sp, 'utf8')) as { worktree: string }).worktree;
  }
  assert.ok(wt, 'start 后应有会话 worktree');

  // 异步跑 run，捕获输出（供断言第一次中断的提示语）
  const runProc = spawn(process.execPath, [CLI, 'run', 'stubborn'], { cwd: repo, env });
  let out = '';
  runProc.stdout.on('data', (c) => (out += c));
  runProc.stderr.on('data', (c) => (out += c));
  const exited = new Promise<number | null>((resolve) => runProc.on('close', (code) => resolve(code)));

  try {
    await until(20_000, () => fs.existsSync(readyFile), '倔 agent 的 SIGINT handler 就绪');
    assert.ok(fs.existsSync(pidFile));
    const [leader, grand] = fs
      .readFileSync(pidFile, 'utf8')
      .trim()
      .split(/\s+/)
      .map(Number);
    assert.ok(pidAlive(leader) && pidAlive(grand));

    // 第一次 SIGINT：relay 转发给 agent 进程组；agent 忽略之，relay 继续等（不退出、不放锁）
    runProc.kill('SIGINT');
    await until(10_000, () => out.includes('等待 agent 进程结束'), '第一次中断的提示');
    assert.ok(pidAlive(leader) && pidAlive(grand), '忽略 SIGINT 的 agent 不应死于第一次中断');
    assert.ok(fs.existsSync(path.join(wt, '.relay', 'session.lock')), '第一次中断不放锁');

    // 第二次 SIGINT：SIGKILL 整组 → 记 exit=130 → 放锁 → 退出 130
    runProc.kill('SIGINT');
    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('relay 未在第二次中断后退出')), 20_000)),
    ]);
    assert.equal(code, 130, '第二次中断后 relay 应以 130 退出');

    await until(10_000, () => !pidAlive(leader) && !pidAlive(grand), 'agent 进程组死亡');
    assert.ok(!pidAlive(grand), '孙进程必须随组被杀（放锁后不能再有 agent 进程写盘）');
    assert.ok(!fs.existsSync(path.join(wt, '.relay', 'session.lock')), '第二次中断后锁必须已释放');

    const journal = fs.readFileSync(path.join(wt, '.relay', 'journal.jsonl'), 'utf8');
    assert.ok(journal.includes('"type":"exit"') && journal.includes('"code":130'), 'journal 应记录 exit=130');
    const exits = journal
      .split('\n')
      .filter((l) => l.includes('"type":"exit"'))
      .map((l) => JSON.parse(l) as { code: number });
    assert.equal(exits[exits.length - 1].code, 130, '最后一条 exit 应是 130');
  } finally {
    // runProc 非 detached、与测试同组，只能按 pid 直杀（组击杀只针对 detached 的 agent）
    runProc.kill('SIGKILL');
    fs.rmSync(base, { recursive: true, force: true });
  }
});
