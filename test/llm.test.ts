import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolChat } from '../src/core/llm';
import { runLlmAgent } from '../src/core/llm-agent';
import type { ApiSpec } from '../src/core/types';

/**
 * 接力台自带的小助手边生成边收（SSE）：Claude 协议、OpenAI 协议都拼得回文字和工具调用；
 * 一直在出字就不算卡住，停着不动才停；接口不支持流式、直接回整段 JSON 的照旧能读。
 */

type Handler = (body: Record<string, unknown>, res: http.ServerResponse) => void;

async function server(handler: Handler): Promise<{ url: string; bodies: Record<string, unknown>[]; close: () => void }> {
  const bodies: Record<string, unknown>[] = [];
  const srv = http.createServer((req, res) => {
    let t = '';
    req.on('data', (c) => (t += c));
    req.on('end', () => {
      const body = JSON.parse(t || '{}') as Record<string, unknown>;
      bodies.push(body);
      handler(body, res);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, bodies, close: () => srv.close() };
}

const sse = (res: http.ServerResponse, events: unknown[], gapMs = 0) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let i = 0;
  const tick = (): void => {
    if (i >= events.length) {
      res.end('data: [DONE]\n\n');
      return;
    }
    res.write(`data: ${JSON.stringify(events[i++])}\n\n`);
    setTimeout(tick, gapMs);
  };
  tick();
};

const tools = [{ name: 'write_file', description: 'w', parameters: { type: 'object' } }];

test('Claude 协议边生成边收：文字、工具调用（参数分几段来）、用量都拼得回；一次最多写的字先要大的', async () => {
  const s = await server((_b, res) =>
    sse(res, [
      { type: 'message_start', message: { usage: { input_tokens: 120 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '先写' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '框架。' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'write_file', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.md","con' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'tent":"' + 'x'.repeat(3000) + '"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 900 } },
      { type: 'message_stop' },
    ])
  );
  try {
    const spec: ApiSpec = { baseUrl: s.url, model: 'm', apiKeyEnv: '', format: 'anthropic' };
    const chat = new ToolChat(spec, 'sys', tools);
    chat.user('做');
    const seen: number[] = [];
    const r = await chat.next(10_000, (n) => seen.push(n));
    assert.equal(r.text, '先写框架。');
    assert.deepEqual([r.calls[0].name, r.calls[0].args.path, String(r.calls[0].args.content).length], ['write_file', 'a.md', 3000]);
    assert.deepEqual(chat.used, { input: 120, output: 900, cached: 0 });
    assert.equal(s.bodies[0].stream, true);
    assert.equal(s.bodies[0].max_tokens, 32000);
    // 标好「可以缓存」：系统提示、最新一条的最后一块；存着的对话本身不带标记
    assert.deepEqual((s.bodies[0].system as { cache_control?: unknown }[])[0].cache_control, { type: 'ephemeral' });
    const sent = s.bodies[0].messages as { content: { cache_control?: unknown }[] }[];
    assert.deepEqual(sent.at(-1)!.content.at(-1)!.cache_control, { type: 'ephemeral' });
    assert.equal(r.cut, false);
    assert.ok(seen.length >= 1, '写长东西时报进度');
  } finally {
    s.close();
  }
});

test('OpenAI 协议边生成边收：文字、思考内容、分段的工具调用都拼得回；接口不收 stream_options 就去掉再试', async () => {
  let n = 0;
  const s = await server((b, res) => {
    if (n++ === 0 && b.stream_options) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"unknown field stream_options"}');
      return;
    }
    sse(res, [
      { choices: [{ delta: { reasoning_content: '想一想' } }] },
      { choices: [{ delta: { content: '好的' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"b.md"}' } }] } }] },
      { choices: [], usage: { prompt_tokens: 50, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 32 } } },
    ]);
  });
  try {
    const spec: ApiSpec = { baseUrl: s.url, model: 'm', apiKeyEnv: '' };
    const chat = new ToolChat(spec, 'sys', tools);
    chat.user('做');
    const r = await chat.next(10_000);
    assert.equal(r.text, '好的');
    assert.deepEqual(r.calls.map((c) => [c.id, c.name, c.args.path]), [['c1', 'write_file', 'b.md']]);
    assert.deepEqual(chat.used, { input: 50, output: 7, cached: 32 }, '其中读缓存的单记');
    assert.equal(s.bodies.length, 2);
    assert.equal(s.bodies[1].stream_options, undefined, '第二次不带');
  } finally {
    s.close();
  }
});

test('写到一次能写的上限被截断：报 cut；接口不收「可以缓存」的标记就去掉再试，之后都不带', async () => {
  let n = 0;
  const s = await server((b, res) => {
    if (n++ === 0 && JSON.stringify(b).includes('cache_control')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"unknown field cache_control"}');
      return;
    }
    sse(res, [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'write_file', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.md","content":"很长' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 32000 } },
    ]);
  });
  try {
    const chat = new ToolChat({ baseUrl: s.url, model: 'm', apiKeyEnv: '', format: 'anthropic' }, 'sys', tools);
    chat.user('写');
    const r = await chat.next(10_000);
    assert.equal(r.cut, true);
    assert.equal(r.calls[0].badArgs, '{"path":"a.md","content":"很长', '半截的参数原样交回去，让它知道断在哪');
    chat.results([{ id: 't', content: '出错' }]);
    chat.user('再来');
    await chat.next(10_000);
    assert.equal(s.bodies.length, 3);
    assert.ok(!JSON.stringify(s.bodies[1]).includes('cache_control') && !JSON.stringify(s.bodies[2]).includes('cache_control'), '去掉之后都不带');
  } finally {
    s.close();
  }
});

test('一直在出字就不算卡住（总时长比「多久没回音」长也照样收完）；停着不动才停；整段 JSON 的接口照旧能读', async () => {
  const slow = await server((_b, res) => sse(res, Array.from({ length: 8 }, (_, i) => ({ choices: [{ delta: { content: String(i) } }] })), 60));
  const stuck = await server((_b, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '开' } }] })}\n\n`);
  });
  const plain = await server((_b, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '整段' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
  });
  process.env.RELAY_RETRY_MS = '10';
  try {
    const mk = (url: string) => {
      const c = new ToolChat({ baseUrl: url, model: 'm', apiKeyEnv: '' }, 'sys', tools);
      c.user('说');
      return c;
    };
    assert.equal((await mk(slow.url).next(10_000, undefined, 200)).text, '01234567', '总共约 500 毫秒，每 60 毫秒来一段，没超过 200 毫秒的空档');
    await assert.rejects(mk(stuck.url).next(10_000, undefined, 150), /没有回音/);
    assert.equal((await mk(plain.url).next(10_000)).text, '整段');
  } finally {
    slow.close();
    stuck.close();
    plain.close();
  }
});

test('小助手干活：没调用 finish 就停下，提醒一次再收；写到上限被截断，告诉它分几次写（append 接在后面）', async () => {
  const replies = [
    // 1. 写到一半被截断：参数是半截的
    [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'write_file', arguments: '{"path":"长.md","content":"开头' } }] } }] }, { choices: [{ delta: {}, finish_reason: 'length' }] }],
    // 2. 分两次写
    [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'b', function: { name: 'write_file', arguments: '{"path":"长.md","content":"前半"}' } }] } }] }],
    [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'write_file', arguments: '{"path":"长.md","content":"后半","append":true}' } }] } }] }],
    // 3. 说了句话就停了（没 finish）
    [{ choices: [{ delta: { content: '写好了' } }] }],
    // 4. 提醒之后 finish
    [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'd', function: { name: 'finish', arguments: '{"summary":"写了长.md"}' } }] } }] }],
  ];
  let i = 0;
  const s = await server((_b, res) => sse(res, replies[Math.min(i++, replies.length - 1)]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-agent-'));
  const lines: string[] = [];
  try {
    const r = await runLlmAgent({ spec: { baseUrl: s.url, model: 'm', apiKeyEnv: '' }, cwd: dir, brief: '写一篇长的', level: 'safe', gateCommand: '', protectedPaths: [], log: (l) => lines.push(l), shouldStop: () => false, deadline: Date.now() + 20_000, maxSteps: 10 });
    assert.equal(r.finalText, '写了长.md');
    assert.equal(fs.readFileSync(path.join(dir, '长.md'), 'utf8'), '前半后半');
    const said = (k: number) => JSON.stringify(s.bodies[k].messages);
    assert.match(said(1), /被截断了：长文件分几次写/);
    assert.match(said(4), /还没调用 finish/);
    assert.ok(lines.some((l) => /被截断/.test(l)));
  } finally {
    s.close();
  }
});
