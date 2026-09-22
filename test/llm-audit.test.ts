import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

/** mock 一个 OpenAI 兼容 /chat/completions：返回带 remaining 的审计 JSON。 */
function mockLlm(): Promise<{ server: http.Server; url: string; calls: string[] }> {
  return new Promise((resolve) => {
    const calls: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        calls.push(body);
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    what: ['app.txt：新增一行 weak-agent edit'],
                    why: '按任务要求追加内容',
                    risks: [],
                    remaining: '下一步：给 app.txt 补一个 README 说明',
                  }),
                },
              },
            ],
          })
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}`, calls });
    });
  });
}

/** 异步 spawn：mock 服务器在本进程里，spawnSync 会阻塞事件循环导致服务器无法应答。 */
function sh(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`relay ${args.join(' ')} 失败：\n${out}`));
      else resolve(out);
    });
  });
}

test('审计阅读面：LLM 成功时 status=ok，remaining 写进 handoff.md 的生成内容节', async () => {
  const { server, url, calls } = await mockLlm();
  try {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-llm-'));
    const home = path.join(base, 'home');
    const repo = path.join(base, 'repo');
    fs.mkdirSync(home);
    const fake = path.join(base, 'fake-agent.sh');
    fs.writeFileSync(fake, '#!/bin/sh\necho "edit" >> app.txt\n');
    fs.chmodSync(fake, 0o755);
    execFileSync('git', ['init', '-q', repo]);
    const g = (a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'init']);

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, RELAY_TEST_AUDIT_KEY: 'test-key-123' };
    delete env.DEEPSEEK_API_KEY;

    await sh(repo, ['init'], env);
    const cfgPath = path.join(repo, '.relay', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    (cfg as { audit: Record<string, string> }).audit.baseUrl = url;
    (cfg as { audit: Record<string, string> }).audit.apiKeyEnv = 'RELAY_TEST_AUDIT_KEY';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'relay config']);
    await sh(repo, ['agents', 'add', 'fake', '--cmd', fake, '--tier', 'weak'], env);

    await sh(repo, ['start', 'llm audit flow'], env);
    await sh(repo, ['run', 'fake'], env);
    const out = await sh(repo, ['handoff'], env);
    assert.ok(out.includes('含阅读面'), out);

    // LLM 收到的是 OpenAI 兼容请求，且带 Bearer key
    assert.equal(calls.length, 1);
    const sent = JSON.parse(calls[0]) as { model: string; messages: { role: string }[] };
    assert.equal(sent.model, 'deepseek-chat');
    assert.equal(sent.messages.length, 2);

    // journal 记 ok；handoff.md 的模型建议节带上 remaining 且有生成标注
    const projRoot = path.join(home, '.relay', 'projects');
    const projDir = fs.readdirSync(projRoot)[0];
    const session = JSON.parse(fs.readFileSync(path.join(projRoot, projDir, 'session.json'), 'utf8')) as {
      worktree: string;
    };
    const journal = fs.readFileSync(path.join(session.worktree, '.relay', 'journal.jsonl'), 'utf8');
    assert.ok(journal.includes('"type":"audit"'));
    assert.ok(journal.includes('"status":"ok"'));

    const handoffDoc = fs.readFileSync(path.join(session.worktree, '.relay', 'handoff.md'), 'utf8');
    assert.ok(handoffDoc.includes('建议的下一步（模型生成，非事实）'));
    assert.ok(handoffDoc.includes('补一个 README 说明'));

    fs.rmSync(base, { recursive: true, force: true });
  } finally {
    server.close();
  }
});
