import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { CLI, sandbox, until } from './helpers';

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 假的 OpenAI 兼容接口：记录请求，按 handler 回答。 */
function mockApi(handler: (body: { model: string; messages: { role: string; content: string }[] }) => string): Promise<{ url: string; calls: string[]; close: () => void }> {
  return new Promise((resolve) => {
    const calls: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        calls.push(body);
        const content = handler(JSON.parse(body));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const a = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${a.port}`, calls, close: () => server.close() });
    });
  });
}

test('终端工人：第一次 Ctrl-C 转给工人继续等；第二次强杀整组进程、记退出码 130、释放锁', async () => {
  const s = sandbox('interrupt');
  const pidFile = path.join(s.base, 'pids');
  const ready = path.join(s.base, 'ready');
  // 倔工人：自己和子进程都不理 SIGINT，只有整组 SIGKILL 能收掉
  const stubborn = s.script(
    'stubborn.sh',
    [
      "trap '' INT",
      `'${process.execPath}' -e 'const fs=require("fs");process.on("SIGINT",()=>{});fs.writeFileSync("${ready}","ok");setTimeout(()=>{},60000)' &`,
      `echo "$$ $!" > '${pidFile}'`,
      'wait',
    ].join('\n')
  );
  s.relay(['init']);
  s.relay(['workers', 'add', 'stubborn', '--cmd', stubborn, '--tier', 'strong']);
  s.relay(['start', 'interrupt']);
  const wt = s.session()!.worktree;

  const child = spawn(process.execPath, [CLI, 'run', 'stubborn'], { cwd: s.repo, env: s.env });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
  try {
    await until(20_000, () => fs.existsSync(ready), '倔工人就绪');
    const [leader, grand] = fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number);
    child.kill('SIGINT');
    await until(10_000, () => out.includes('等待工人自己结束'), '第一次中断的提示');
    assert.ok(pidAlive(leader) && pidAlive(grand), '第一次中断后工人还活着');
    assert.ok(fs.existsSync(path.join(wt, '.relay', 'session.lock')), '第一次中断不放锁');
    child.kill('SIGINT');
    const code = await Promise.race([exited, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('没退出')), 20_000))]);
    assert.equal(code, 130);
    await until(10_000, () => !pidAlive(leader) && !pidAlive(grand), '整组死亡');
    assert.ok(!fs.existsSync(path.join(wt, '.relay', 'session.lock')), '锁已释放');
    const exits = s.journal().filter((e) => e.type === 'exit');
    assert.equal(exits[exits.length - 1].code, 130);
    // 之后照样能交接
    s.relay(['handoff']);
  } finally {
    child.kill('SIGKILL');
  }
});

test('审计阅读面：配了模型就写「改了什么 / 风险 / 建议的下一步」；密钥只从环境变量读、内容先脱敏', async () => {
  const api = await mockApi(() =>
    JSON.stringify({ what: ['app.txt：新增一行'], why: '按任务要求', risks: ['没有测试'], remaining: '给 app.txt 补说明' })
  );
  try {
    const s = sandbox('audit');
    s.relay(['init']);
    const cfgPath = path.join(s.repo, '.relay', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.audit = { baseUrl: api.url, model: 'cheap-model', apiKeyEnv: 'RELAY_TEST_KEY' };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    s.git(['commit', '-q', '-am', 'audit config']);
    const w = s.script('w.sh', 'echo "token=sk-abcdefghijklmnopqrstuvwxyz" >> app.txt');
    s.relay(['workers', 'add', 'w', '--cmd', w, '--tier', 'weak']);
    s.relay(['start', 'audit']);
    s.relay(['run', 'w']);
    const r = await s.relayAsync(['handoff'], { RELAY_TEST_KEY: 'test-key' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /有模型阅读面/);
    assert.equal(api.calls.length, 1);
    const sent = JSON.parse(api.calls[0]) as { model: string; messages: { content: string }[] };
    assert.equal(sent.model, 'cheap-model');
    assert.ok(!api.calls[0].includes('sk-abcdefghijklmnop'), '送出去的内容里不能有密钥');
    assert.ok(api.calls[0].includes('[REDACTED]'));
    const doc = s.read('.relay/handoff.md', 'wt');
    assert.ok(doc.includes('给 app.txt 补说明'));
    const report = fs.readdirSync(path.join(s.session()!.worktree, '.relay', 'audits'));
    const text = s.read(`.relay/audits/${report[0]}`, 'wt');
    assert.ok(text.includes('没有测试'));
    assert.ok(text.includes('sk-abcdefghijklmnop'), '本机的事实段保留原文');
  } finally {
    api.close();
  }
});

test('审计阅读面：没有密钥 / 接口出错都不耽误交接', async () => {
  const s = sandbox('audit-fail');
  s.relay(['init']);
  const w = s.script('w.sh', 'echo x >> a.txt');
  s.relay(['workers', 'add', 'w', '--cmd', w, '--tier', 'strong']);
  s.relay(['start', 'no key']);
  s.relay(['run', 'w']);
  const out = s.relay(['handoff']);
  assert.match(out, /只有事实：没有设置 DEEPSEEK_API_KEY/);
});

test('讨论：命令型 AI 从标准输入拿到带记录的提示；{{out}} 文件型也行；API 型直接调接口；出错的写一条说明', async () => {
  const api = await mockApi((body) => `API 看到了：${body.messages[0].content.includes('第一个问题') ? '问题' : '??'}`);
  try {
    const s = sandbox('talk');
    s.relay(['init']);
    const echoAi = s.script('echo-ai.sh', 'input=$(cat); case "$input" in *第一个问题*) echo "我看到了问题";; *) echo "没看到";; esac');
    const fileAi = s.script('file-ai.sh', 'cat > /dev/null; echo "写在文件里" > "$1"; echo "标准输出的杂音"');
    const badAi = s.script('bad-ai.sh', 'echo "登录过期" >&2; exit 3');
    s.relay(['workers', 'add', 'echoai', '--cmd', 'true', '--ask', echoAi, '--label', '回声']);
    s.relay(['workers', 'add', 'fileai', '--cmd', 'true', '--ask', `${fileAi} {{out}}`, '--label', '文件']);
    s.relay(['workers', 'add', 'bad', '--cmd', 'true', '--ask', badAi, '--label', '坏的']);
    s.relay(['workers', 'add', 'api', '--kind', 'api', '--api-base', api.url, '--api-model', 'm', '--api-key-env', 'RELAY_TALK_KEY', '--label', '接口']);
    const r = await s.relayAsync(['talk', '第一个问题', '--ask', 'echoai,fileai,bad,api'], { RELAY_TALK_KEY: 'k' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /回声：我看到了问题/);
    assert.match(r.out, /文件：写在文件里/);
    assert.ok(!r.out.includes('标准输出的杂音'));
    assert.match(r.out, /坏的 没回上来：.*登录过期/);
    assert.match(r.out, /接口 · m：API 看到了：问题/);
    assert.match(r.out, /请 echoai、fileai、bad、api 依次回答/);
    const rows = fs.readFileSync(path.join(s.repo, '.relay', 'talk.jsonl'), 'utf8').trim().split('\n');
    assert.equal(rows.length, 5);
    assert.equal(s.git(['status', '--porcelain']), '', '讨论记录不进 git');
    // 第二轮：后发言的看得到前面所有人说的
    const r2 = await s.relayAsync(['talk', '再说一次', '--ask', 'echoai'], { RELAY_TALK_KEY: 'k' });
    assert.match(r2.out, /我看到了问题/, '提示里带着上一轮的记录');
    assert.match(s.relay(['talk', '--clear']), /存档/);
    assert.ok(!fs.existsSync(path.join(s.repo, '.relay', 'talk.jsonl')));
  } finally {
    api.close();
  }
});
