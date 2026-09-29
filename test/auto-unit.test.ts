import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { normalizeAutoSettings } from '../src/core/auto-settings';
import { explainFailure, firstVersion, findHarness, harnessForCommand, tomlTop, type Located } from '../src/core/harness';
import { chat, readKeyFrom, stripJsonComments, ToolChat } from '../src/core/llm';
import { pickModel } from '../src/core/providers';
import { normalizeAgent } from '../src/core/registry';
import { describeArgv, looksLikeNetworkBlip, makeParser, usageLine } from '../src/core/runner';

test('工具调用参数：安全档 / 完全放开 / 只读，各家都按无人值守的方式调', () => {
  const loc: Located = { exec: ['/bin/x'], version: '1', where: '/bin/x' };
  const base = { cwd: '/wt', prompt: 'P', model: undefined, effort: undefined, outFile: '/tmp/o' };
  const claudeSafe = findHarness('claude')!.invoke(loc, { ...base, level: 'safe', readOnly: false });
  assert.deepEqual(claudeSafe.argv.slice(1, 7), ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']);
  assert.equal(claudeSafe.stdin, 'P');
  assert.match(claudeSafe.argv.join(' '), /"autoAllowBashIfSandboxed":true/);
  assert.ok(findHarness('claude')!.invoke(loc, { ...base, level: 'full', readOnly: false }).argv.includes('--dangerously-skip-permissions'));
  assert.ok(findHarness('claude')!.invoke(loc, { ...base, level: 'safe', readOnly: true }).argv.includes('Read,Grep,Glob'));

  const codex = findHarness('codex')!.invoke(loc, { ...base, level: 'safe', readOnly: false, model: 'gpt-6-astra', effort: 'low' });
  assert.deepEqual(codex.argv.slice(1), ['exec', '--skip-git-repo-check', '--color', 'never', '-C', '/wt', '--json', '-o', '/tmp/o', '-s', 'workspace-write', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="low"', '-']);
  assert.equal(codex.outFile, '/tmp/o');
  assert.ok(findHarness('codex')!.invoke(loc, { ...base, level: 'safe', readOnly: true }).argv.includes('read-only'));

  // Cursor：名单里没指定模型就用 Cursor 里选的（这里是假家目录，只有命令行自己的设置）
  const realHome = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cursor-home-'));
  try {
    fs.mkdirSync(path.join(process.env.HOME, '.cursor'));
    fs.writeFileSync(path.join(process.env.HOME, '.cursor', 'cli-config.json'), JSON.stringify({ model: { modelId: 'grok-4.7-high-fast', displayName: 'Grok 4.7' } }));
    const cursor = findHarness('cursor-agent')!.invoke(loc, { ...base, level: 'safe', readOnly: false });
    assert.deepEqual(cursor.argv.slice(1), ['-p', '--trust', '--output-format', 'stream-json', '--workspace', '/wt', '--force', '--sandbox', 'enabled', '--model', 'grok-4.7-high-fast', 'P']);
    assert.ok(findHarness('cursor-agent')!.invoke(loc, { ...base, level: 'safe', readOnly: true }).argv.includes('ask'));
    assert.ok(findHarness('cursor-agent')!.invoke(loc, { ...base, level: 'full', readOnly: false }).argv.includes('--approve-mcps'), '不限制：MCP 自动批准');
    assert.ok(!findHarness('cursor-agent')!.invoke(loc, { ...base, level: 'full', readOnly: true }).argv.includes('--approve-mcps'), '群聊只读：不批准 MCP');
    assert.ok(findHarness('cursor-agent')!.invoke(loc, { ...base, level: 'safe', readOnly: false, model: 'x-1' }).argv.join(' ').includes('--model x-1'), '名单里指定的优先');
  } finally {
    process.env.HOME = realHome;
  }

  const zcode = findHarness('zcode')!.invoke(loc, { ...base, level: 'safe', readOnly: false });
  assert.deepEqual(zcode.argv.slice(1), ['-p', 'P', '--cwd', '/wt', '--mode', 'edit', '--no-color']);
  // Antigravity：安全档接受改文件 + 沙箱（没有 --dangerously-skip-permissions，出沙箱要人点头、没人就拒绝）
  const agy = (level: 'safe' | 'full', readOnly = false) => findHarness('agy')!.invoke(loc, { ...base, level, readOnly }).argv.slice(1);
  assert.deepEqual(agy('safe'), ['-p', 'P', '--output-format', 'stream-json', '--mode', 'accept-edits', '--sandbox']);
  assert.deepEqual(agy('full'), ['-p', 'P', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--sandbox']);
  assert.deepEqual(agy('safe', true), ['-p', 'P', '--output-format', 'stream-json', '--mode', 'plan', '--sandbox'], '群聊也进沙箱：沙箱里的命令才会自动跑');
  assert.equal(harnessForCommand('claude --foo')!.id, 'claude');
  assert.equal(harnessForCommand('/Users/x/.npm-global/bin/codex')!.id, 'codex');
  assert.equal(harnessForCommand('open -a Cursor {{worktree}}'), null);
  assert.equal(firstVersion('codex-cli 0.155.0'), '0.155.0');
  assert.equal(firstVersion('2026.09.15-d2fe57e'), '2026.09.15-d2fe57e');
});

test('解析各家的输出：Claude / Codex / Cursor / Antigravity 的事件翻成中文日志，取出最后一句话', () => {
  const c = makeParser('claude');
  assert.deepEqual(c.line('{"type":"system","subtype":"init","model":"deepseek-flash"}'), ['模型：deepseek-flash']);
  assert.deepEqual(c.line('{"type":"assistant","message":{"content":[{"type":"text","text":"我来写"},{"type":"tool_use","name":"Write","input":{"file_path":"/wt/a.txt","content":"x"}}]}}'), ['说：我来写', '工具 Write：/wt/a.txt']);
  assert.deepEqual(c.line('{"type":"result","subtype":"success","result":"完成了","num_turns":3,"duration_ms":2500}'), ['结束（success，3 轮，3 秒）']);
  assert.equal(c.final(), '完成了');
  assert.equal(c.model(), 'deepseek-flash');

  const x = makeParser('codex');
  assert.deepEqual(x.line('{"type":"item.started","item":{"type":"command_execution","command":"/bin/zsh -lc ls"}}'), ['命令：/bin/zsh -lc ls']);
  assert.deepEqual(x.line('{"type":"item.completed","item":{"type":"command_execution","command":"false","exit_code":1}}'), ['命令失败（退出码 1）：false']);
  assert.deepEqual(x.line('{"type":"item.completed","item":{"type":"agent_message","text":"好了"}}'), ['说：好了']);
  assert.equal(x.final(), '好了');

  const u = makeParser('cursor');
  u.line('{"type":"assistant","message":{"content":[{"type":"text","text":"第一句"}]}}');
  assert.deepEqual(u.line('{"type":"tool_call","subtype":"started","tool_call":{"shellToolCall":{"args":{"command":"ls"}}}}'), ['工具 shell：ls']);
  u.line('{"type":"assistant","message":{"content":[{"type":"text","text":"最后一句"}]}}');
  u.line('{"type":"result","subtype":"success","result":"第一句最后一句","duration_ms":4000}');
  assert.equal(u.final(), '最后一句', 'Cursor 的 result 把所有话拼在一起，取最后一条');

  const a = makeParser('agy');
  assert.deepEqual(a.line('{"event":"step_update","step_update":{"step_type":"tool","state":"ACTIVE","tool_name":"run_command","tool_info":{"parameters":{"CommandLine":"ls"}}}}'), ['工具 run_command：ls']);
  a.line('{"event":"result","result":{"status":"SUCCESS","response":"done","denied_actions":[]}}');
  assert.equal(a.final(), 'done');
  assert.deepEqual(
    a.line('{"event":"step_update","step_update":{"step_type":"tool","state":"ERROR","tool_name":"run_command","tool_info":{"parameters":{"CommandLine":"textutil -convert txt -stdout a.rtf"},"error":{"type":"TOOL_ERROR","message":"permission check failed for unsandboxed \\"textutil\\": user denied permission"}}}}'),
    ['被拒绝：textutil -convert txt -stdout a.rtf']
  );

  const l = makeParser('lines');
  l.line('\u001b[32m普通输出\u001b[0m');
  assert.equal(l.final(), '普通输出');
  assert.equal(describeArgv(['codex', 'exec', 'x'.repeat(300), 'a b']), "codex exec <提示词 300 字> 'a b'");
});

test('调度设置：校验范围，字符串也能当名单；1.x 的 workers 当成派活顺序', () => {
  const s = normalizeAutoSettings({ order: 'codex, claude，codex', maxStints: 5, level: 'full', waitForQuota: false });
  assert.deepEqual(s.order, ['codex', 'claude']);
  assert.equal(s.maxStints, 5);
  assert.equal(s.waitForQuota, false);
  assert.equal(s.finalReview, true);
  assert.throws(() => normalizeAutoSettings({ maxStints: 0 }), /1–100/);
  assert.throws(() => normalizeAutoSettings({ level: 'yolo' }), /safe/);
  const old = normalizeAutoSettings({ workers: ['claude', 'codex'], maxRounds: 3, autoMerge: true, workTimeoutMin: 30 });
  assert.deepEqual(old.order, ['claude', 'codex']);
  assert.equal(old.stintTimeoutMin, 30);
});

test('工人配置：绑定工具、思考强度、别的工具配置里的密钥都能存；乱填会被拦', () => {
  const a = normalizeAgent({ name: 'codex', kind: 'cli', cmd: 'codex', harness: 'codex', effort: 'low', model: 'gpt-6-astra', detected: true });
  assert.equal(a.harness, 'codex');
  assert.equal(a.effort, 'low');
  assert.equal(a.detected, true);
  const api = normalizeAgent({ name: 'mimo-api', kind: 'api', api: { baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', model: 'mimo-v2.6-pro', apiKeyEnv: '', keyFrom: 'mimocode:xiaomi-token-plan-cn' } });
  assert.equal(api.api!.keyFrom, 'mimocode:xiaomi-token-plan-cn');
  const local = normalizeAgent({ name: 'ollama', kind: 'api', api: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3', apiKeyEnv: '' } });
  assert.equal(local.api!.apiKeyEnv, '', '本机服务不要密钥');
  assert.throws(() => normalizeAgent({ name: 'x', kind: 'app', cmd: 'open -a X {{worktree}}', harness: 'claude' }), /只有命令行成员/);
  assert.throws(() => normalizeAgent({ name: 'x', kind: 'api', api: { baseUrl: 'https://a', model: 'm', apiKeyEnv: '', keyFrom: '../../etc/passwd' } }), /密钥来源/);
  assert.throws(() => normalizeAgent({ name: 'x', kind: 'cli', cmd: 'x', effort: 'high; rm -rf /' }), /思考强度/);
});

test('配置文件小工具：JSONC 去注释、TOML 顶层键、按偏好挑模型', () => {
  assert.deepEqual(JSON.parse(stripJsonComments('{\n // 注释\n "a": "http://x//y", /* 块 */ "b": [1,2,],\n}')), { a: 'http://x//y', b: [1, 2] });
  assert.deepEqual(tomlTop('model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n[profiles.x]\nmodel = "other"\n'), { model: 'gpt-6-astra', model_reasoning_effort: 'xhigh' });
  assert.equal(pickModel(['deepseek-reasoner', 'deepseek-chat'], ['deepseek-chat']), 'deepseek-chat');
  assert.equal(pickModel(['mimo-v2.6-pro-ultraspeed', 'mimo-v2.6-pro'], ['mimo-v2.6-pro']), 'mimo-v2.6-pro', '精确匹配优先于前缀');
  assert.equal(pickModel(['a', 'b'], ['z']), 'a');
});

test('从 MiMo 的配置里读密钥：只认指定的接口，读不到返回空', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-keyfrom-'));
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(home, '.config', 'mimocode'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'mimocode', 'mimocode.jsonc'), '{\n  // x\n  "provider": { "xiaomi-token-plan-cn": { "options": { "apiKey": "tp-123" } } }\n}');
    assert.equal(readKeyFrom('mimocode:xiaomi-token-plan-cn'), 'tp-123');
    assert.equal(readKeyFrom('mimocode:other'), null);
    assert.equal(readKeyFrom('zcode:x'), null);
  } finally {
    process.env.HOME = old;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('带工具的对话：太长时整轮丢掉最早的，任务说明一直保留', () => {
  const chat = new ToolChat({ baseUrl: 'http://127.0.0.1:1', model: 'm', apiKeyEnv: '' }, 'sys', []);
  chat.user('任务说明');
  const msgs = (chat as unknown as { msgs: { role: string; content?: unknown }[] }).msgs;
  for (let i = 0; i < 5; i++) {
    msgs.push({ role: 'assistant', content: `第 ${i} 轮`, tool_calls: [{ id: `c${i}` }] } as never);
    msgs.push({ role: 'tool', content: 'x'.repeat(1000) });
  }
  const dropped = chat.prune(3000);
  assert.ok(dropped >= 2);
  assert.equal(msgs[0].content, '任务说明');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[msgs.length - 2].content, '第 4 轮', '最近一轮还在');
});

/** 假接口：第一次回思考内容 + 一个工具调用；之后按 rule 检查传回来的助手消息。 */
function reasoningServer(rule: 'require' | 'reject'): Promise<{ url: string; close: () => void; bodies: unknown[] }> {
  return new Promise((resolve) => {
    const bodies: unknown[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const j = JSON.parse(body) as { messages: { role: string; reasoning_content?: string }[] };
        bodies.push(j);
        res.setHeader('content-type', 'application/json');
        const assistants = j.messages.filter((m) => m.role === 'assistant');
        if (!assistants.length) {
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', reasoning_content: '先读文件', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] } }] }));
          return;
        }
        const carried = assistants.every((m) => m.reasoning_content === '先读文件');
        if (rule === 'require' && !carried) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: 'Missing `reasoning_content` field in the assistant message' } }));
          return;
        }
        if (rule === 'reject' && assistants.some((m) => 'reasoning_content' in m)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: 'reasoning_content is not allowed in input messages' } }));
          return;
        }
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '读完了' } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const a = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${a.port}/v1`, close: () => server.close(), bodies });
    });
  });
}

test('内置小代理：思考模型回的思考内容原样传回；接口不收这个字段时自动去掉再试', async () => {
  for (const rule of ['require', 'reject'] as const) {
    const srv = await reasoningServer(rule);
    try {
      const c = new ToolChat({ baseUrl: srv.url, model: 'm', apiKeyEnv: '' }, '系统说明', [
        { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      ]);
      c.user('开始');
      const first = await c.next(5000);
      assert.equal(first.calls[0].name, 'read_file');
      c.results([{ id: first.calls[0].id, content: '文件内容' }]);
      const second = await c.next(5000);
      assert.equal(second.text, '读完了', `${rule}：第二步要成功`);
    } finally {
      srv.close();
    }
  }
});

test('接口偶尔断线、服务器临时忙：自动重试成功；密钥错误不重试', async () => {
  process.env.RELAY_RETRY_MS = '10';
  let hits = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits++;
      if (req.headers.authorization === 'Bearer bad') {
        res.statusCode = 401;
        res.end('{"error":"bad key"}');
        return;
      }
      if (hits === 1) {
        req.socket.destroy();
        return;
      }
      if (hits === 2) {
        res.statusCode = 503;
        res.end('{"error":"busy"}');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好的' } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  try {
    const text = await chat({ baseUrl: url, model: 'm', apiKeyEnv: '' }, [{ role: 'user', content: '你好' }], { timeoutMs: 5000 });
    assert.equal(text, '好的');
    assert.equal(hits, 3, '断线一次、503 一次，第三次成功');
    process.env.RELAY_TEST_BAD_KEY = 'bad';
    hits = 0;
    await assert.rejects(chat({ baseUrl: url, model: 'm', apiKeyEnv: 'RELAY_TEST_BAD_KEY' }, [{ role: 'user', content: '你好' }], { timeoutMs: 5000 }), /401/);
    assert.equal(hits, 1, '密钥错误不重试');
  } finally {
    delete process.env.RELAY_RETRY_MS;
    delete process.env.RELAY_TEST_BAD_KEY;
    server.close();
  }
});

test('认得网络抖动：连接被断开、服务器临时忙算；没登录、额度用完、改错了不算', () => {
  for (const t of [
    'Error: [aborted] Client network socket disconnected before secure TLS connection was established',
    'API Error: Connection error (ECONNRESET)',
    'stream disconnected before completion: error sending request',
    'HTTP 503 Service Unavailable',
    '429 Too Many Requests',
    'fetch failed',
  ])
    assert.ok(looksLikeNetworkBlip(t), t);
  for (const t of ['Not logged in. Please run /login', 'You have hit your usage limit', 'SyntaxError: Unexpected token', '退出码 1']) assert.ok(!looksLikeNetworkBlip(t), t);
});


test('认得的报错翻成一句说明（只说是什么情况）：ZCode 没选默认模型、没登录', () => {
  assert.equal(explainFailure('zcode', 'Error: Model creation failed (traceId: x)'), 'ZCode 命令行没有默认模型');
  assert.equal(explainFailure('codex', 'Error: not logged in'), '没登录或登录过期');
  assert.equal(explainFailure('codex', 'TypeError: x is undefined'), null);
});

test('各家工具报的 token 用量统一记成一行（输入把读缓存、写缓存的也算上）；没报就没有这一行', () => {
  assert.equal(usageLine({ type: 'result', usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 } }), '本轮用了 115 输入 / 7 输出 token');
  assert.equal(usageLine({ usage: { prompt_tokens: 3, completion_tokens: 4 } }), '本轮用了 3 输入 / 4 输出 token');
  assert.equal(usageLine({ type: 'final', data: { usage: { inputTokens: 8, outputTokens: 9 } } }), '本轮用了 8 输入 / 9 输出 token');
  assert.equal(usageLine({ type: 'result', result: 'x' }), null);
  assert.deepEqual(makeParser('claude').line(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1, output_tokens: 2 } })), ['结束（success）', '本轮用了 1 输入 / 2 输出 token']);
  assert.deepEqual(makeParser('codex').line(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 3, output_tokens: 6 } })), ['本轮用了 5 输入 / 6 输出 token']);
});
