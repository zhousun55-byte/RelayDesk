import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeAutoSettings } from '../src/core/auto-settings';
import { resolveTeam, type Member } from '../src/core/detect';
import { firstVersion, findHarness, harnessForCommand, tomlTop, type Located } from '../src/core/harness';
import { readKeyFrom, stripJsonComments, ToolChat } from '../src/core/llm';
import { buildOnboard } from '../src/core/prompts';
import { pickModel } from '../src/core/providers';
import { normalizeAgent } from '../src/core/registry';
import { buildReviewRequest, jsonObjects, parseVerdict } from '../src/core/review';
import { describeArgv, makeParser } from '../src/core/runner';
import type { AgentConfig } from '../src/core/types';

test('审查结论：代码块、前后废话、落单的括号都能取出 JSON；认得各种写法', () => {
  assert.deepEqual(parseVerdict('```json\n{"verdict":"pass","summary":"好","issues":[]}\n```'), { verdict: 'pass', summary: '好', issues: [] });
  assert.deepEqual(parseVerdict('我看了一下 {不成对的括号\n结论：{"verdict": "FIX", "summary": "差一点", "issues": ["a.js 少了分号"]}'), {
    verdict: 'fix',
    summary: '差一点',
    issues: ['a.js 少了分号'],
  });
  assert.equal(parseVerdict('{"verdict":"approved"}')!.verdict, 'pass');
  assert.equal(parseVerdict('{"decision":"不通过","reason":"没写测试"}')!.issues[0], '没写测试', 'fix 没列问题时把理由当问题');
  assert.equal(parseVerdict('没有 JSON'), null);
  assert.equal(parseVerdict('{"verdict":"maybe"}'), null);
  // 多个 JSON 时取最后一个
  assert.equal(parseVerdict('{"verdict":"fix","issues":["x"]} 再想想 {"verdict":"pass"}')!.verdict, 'pass');
  assert.deepEqual(jsonObjects('a {"s":"}{"} b {"x":1}'), ['{"s":"}{"}', '{"x":1}']);
});

test('审查请求：任务、自述、检查结果、上一轮问题、改动都在，结尾要求只输出 JSON', () => {
  const t = buildReviewRequest({
    taskText: '# 任务\n\n做滤镜',
    round: 2,
    implementer: 'Claude Code（deepseek-flash）',
    selfNote: '做完了',
    gate: { status: 'fail', command: 'npm test', detail: '1 failing' },
    previous: { reviewer: 'Codex', issues: ['少了暗部'] },
    protectedHits: ['.env'],
    diffstat: ' a.xmp | 3 +++',
    diff: '+<x/>',
  });
  for (const part of ['做滤镜', '第 2 轮', '做完了', '**没通过**', '1 failing', '少了暗部', '.env', 'a.xmp', '+<x/>', '"verdict"']) assert.ok(t.includes(part), part);
});

test('上岗说明（全自动）：写明没人在场、上一轮审查意见逐条列出、做完直接结束', () => {
  const text = buildOnboard({
    taskTitle: 't',
    taskBody: '# 任务\n\n做滤镜',
    branch: 'relay/x',
    worktree: '/wt',
    you: { agent: 'codex', label: 'Codex', tier: 'strong', llm: 'gpt-6-astra' },
    review: null,
    handoffDoc: null,
    latestAudit: null,
    protectedPaths: [],
    gateCommand: '',
    conflicts: [],
    generatedAt: 'now',
    auto: { round: 2, review: { reviewer: 'Claude Code', summary: '差一点', issues: ['暗部要偏青'] } },
  });
  assert.match(text, /全自动流水线的第 2 轮/);
  assert.match(text, /上一轮审查意见（Claude Code，必须逐条处理）/);
  assert.match(text, /1\. 暗部要偏青/);
  assert.match(text, /直接结束（退出），接力台会自动交接/);
  assert.doesNotMatch(text, /去接力台点「交接」/);
});

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

  const cursor = findHarness('cursor-agent')!.invoke(loc, { ...base, level: 'safe', readOnly: false });
  assert.deepEqual(cursor.argv.slice(1), ['-p', '--trust', '--output-format', 'stream-json', '--workspace', '/wt', '--force', '--sandbox', 'enabled', 'P']);
  assert.ok(findHarness('cursor-agent')!.invoke(loc, { ...base, level: 'safe', readOnly: true }).argv.includes('ask'));

  const zcode = findHarness('zcode')!.invoke(loc, { ...base, level: 'safe', readOnly: false });
  assert.deepEqual(zcode.argv.slice(1), ['-p', 'P', '--cwd', '/wt', '--mode', 'edit', '--no-color']);
  assert.deepEqual(findHarness('agy')!.workLevels, ['full'], 'Antigravity 只有完全放开才能无人值守');
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

  const l = makeParser('lines');
  l.line('\u001b[32m普通输出\u001b[0m');
  assert.equal(l.final(), '普通输出');
  assert.equal(describeArgv(['codex', 'exec', 'x'.repeat(300), 'a b']), "codex exec <提示词 300 字> 'a b'");
});

test('全自动设置：校验范围，字符串也能当名单；团队按设置排，缺人说清楚', () => {
  const s = normalizeAutoSettings({ workers: 'codex, claude，codex', maxRounds: 5, level: 'full' });
  assert.deepEqual(s.workers, ['codex', 'claude']);
  assert.equal(s.maxRounds, 5);
  assert.equal(s.autoMerge, true);
  assert.throws(() => normalizeAutoSettings({ maxRounds: 0 }), /1–10/);
  assert.throws(() => normalizeAutoSettings({ level: 'yolo' }), /safe/);

  const m = (name: string, kind: Member['kind'], work: boolean, review: boolean, harness?: string): Member => ({
    agent: { name, tier: 'strong' } as AgentConfig,
    name,
    label: name,
    kind,
    ...(harness ? { harness } : {}),
    canWork: work,
    canReview: review,
    ...(work ? {} : { why: '没登录' }),
  });
  const members = [m('deepseek', 'api', true, true), m('codex', 'harness', true, true, 'codex'), m('claude', 'harness', true, true, 'claude'), m('grok', 'harness', false, false, 'grok')];
  const auto = resolveTeam(members, { workers: [], reviewers: [] });
  assert.deepEqual(
    auto.workers.map((x) => x.name),
    ['claude', 'codex', 'deepseek'],
    '默认：编程工具按排名在前，接口模型在后，不能用的不上'
  );
  const picked = resolveTeam(members, { workers: ['codex', 'grok', 'nobody'], reviewers: ['deepseek'] });
  assert.deepEqual(
    picked.workers.map((x) => x.name),
    ['codex']
  );
  assert.equal(picked.problems.length, 2);
  assert.match(picked.problems.join(''), /没登录/);
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
  assert.throws(() => normalizeAgent({ name: 'x', kind: 'app', cmd: 'open -a X {{worktree}}', harness: 'claude' }), /只有终端工人/);
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
