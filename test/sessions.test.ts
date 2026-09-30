import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 各家工具自己记的对话：只列、只读接进接力台的这个项目文件夹里的；接力台派的不列（挂在每一棒上）；
 * 读的时候去掉工具自己塞进去的话，只留人说的、AI 答的、用了什么工具。这个文件里的测试不碰你真实的家目录。
 */

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sessions-home-')));
process.env.HOME = HOME;
/* eslint-disable @typescript-eslint/no-require-imports */
const sessions = require('../src/core/sessions') as typeof import('../src/core/sessions');
const runner = require('../src/core/runner') as typeof import('../src/core/runner');
/* eslint-enable @typescript-eslint/no-require-imports */

const root = path.join(HOME, '项目 甲');
const other = path.join(HOME, '别的');
fs.mkdirSync(root);
fs.mkdirSync(other);
const jsonl = (file: string, rows: unknown[]) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
};

test('对话编号：各家输出里认得出来（Claude Code、Cursor 的 session_id，Codex 的 thread_id，DeepSeek Harness 的 session 事件）；不像编号的不认', () => {
  assert.equal(runner.sessionIdOf('{"type":"system","subtype":"init","session_id":"a1b2c3-d4"}'), 'a1b2c3-d4');
  assert.equal(runner.sessionIdOf('{"type":"thread.started","thread_id":"019a-77ff"}'), '019a-77ff');
  assert.equal(runner.sessionIdOf('{"type":"session","id":"session-fake"}'), 'session-fake');
  assert.equal(runner.sessionIdOf('{"type":"text","id":"session-fake"}'), undefined, '别的事件里的 id 不算');
  assert.equal(runner.sessionIdOf('{"session_id":"x"}'), undefined, '太短');
  assert.equal(runner.sessionIdOf('{"session_id":"a b;rm -rf"}'), undefined);
  assert.equal(runner.sessionIdOf('不是 JSON'), undefined);
});

test('这个项目文件夹里自己在工具里开的对话：Claude Code、Codex 各列出来（标题按改过的名字、工具起的、第一句问话），接力台派的、别的文件夹的不列；读的时候去掉工具塞进去的话', () => {
  const dir = sessions.claudeDirOf(root);
  assert.equal(path.basename(dir), root.replace(/[^A-Za-z0-9]/g, '-'), '和 Claude Code 一样：不是字母数字的都换成 -');
  jsonl(path.join(dir, 'c-desk-0001.jsonl'), [
    { type: 'user', cwd: root, entrypoint: 'claude-desktop', timestamp: '2026-09-29T10:00:00Z', message: { role: 'user', content: '帮我看看这个项目' } },
    { type: 'user', cwd: root, isMeta: true, message: { role: 'user', content: '工具自己加的' } },
    { type: 'user', cwd: root, message: { role: 'user', content: '<command-name>/model</command-name>' } },
    { type: 'assistant', cwd: root, message: { role: 'assistant', content: [{ type: 'text', text: '好的，我先读 README' }, { type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }] } },
    { type: 'user', cwd: root, message: { role: 'user', content: [{ type: 'tool_result', content: '# 甲' }] } },
    { type: 'assistant', cwd: root, isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: '子代理说的' }] } },
    { type: 'ai-title', aiTitle: '看项目' },
    { type: 'custom-title', customTitle: '我起的名字' },
  ]);
  jsonl(path.join(dir, 'c-relay-0002.jsonl'), [{ type: 'user', cwd: root, entrypoint: 'sdk-cli', message: { role: 'user', content: '接力台派的' } }]);
  const day = path.join(HOME, '.codex', 'sessions', '2026', '09', '29');
  const now = new Date().toISOString();
  jsonl(path.join(day, 'rollout-2026-09-29T10-00-00-x-desk-0003.jsonl'), [
    { type: 'session_meta', payload: { id: 'x-desk-0003', cwd: root, source: 'vscode' } },
    { type: 'response_item', timestamp: now, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
    { type: 'response_item', timestamp: now, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '加一个导出功能' }] } },
    { type: 'response_item', timestamp: now, payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls","-la"]}' } },
    { type: 'response_item', timestamp: now, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '加好了' }] } },
  ]);
  jsonl(path.join(day, 'rollout-2026-09-29T10-01-00-x-exec-0004.jsonl'), [{ type: 'session_meta', payload: { id: 'x-exec-0004', cwd: root, source: 'exec' } }]);
  jsonl(path.join(day, 'rollout-2026-09-29T10-02-00-x-other-0005.jsonl'), [{ type: 'session_meta', payload: { id: 'x-other-0005', cwd: other, source: 'vscode' } }]);

  const list = sessions.projectSessions(root);
  assert.deepEqual(
    list.map((x) => [x.tool, x.id, x.title]).sort(),
    [
      ['claude', 'c-desk-0001', '我起的名字'],
      ['codex', 'x-desk-0003', '加一个导出功能'],
    ]
  );
  assert.deepEqual(sessions.projectSessions(other).map((x) => x.id), ['x-other-0005']);

  const c = sessions.readSession(root, 'claude', 'c-desk-0001');
  assert.deepEqual(
    c.messages.map((m) => [m.role, m.text]),
    [
      ['user', '帮我看看这个项目'],
      ['assistant', '好的，我先读 README'],
      ['tool', 'Read：README.md'],
    ]
  );
  const x = sessions.readSession(root, 'codex', 'x-desk-0003');
  assert.deepEqual(
    x.messages.map((m) => [m.role, m.text]),
    [
      ['user', '加一个导出功能'],
      ['tool', 'shell：ls -la'],
      ['assistant', '加好了'],
    ]
  );
  assert.throws(() => sessions.readSession(root, 'codex', 'x-other-0005'), (e: { code?: string }) => e.code === 'no-session', '别的文件夹的对话不读');
  assert.throws(() => sessions.readSession(other, 'claude', 'c-desk-0001'), (e: { code?: string }) => e.code === 'no-session');
  assert.equal(sessions.sessionFile(root, 'claude', '../../etc/passwd'), null, '编号不像编号：不去找');
});

test('回到原工具接着说：Claude Code 用桌面版的链接打开，别家给一条在项目文件夹里接着说的命令', () => {
  assert.deepEqual(sessions.resumeHow('claude-official', 'abc-123456', root), { url: 'claude://resume?session=abc-123456' });
  assert.deepEqual(sessions.resumeHow('codex', 'abc-123456', root), { command: `cd ${JSON.stringify(root)} && codex resume abc-123456` });
  assert.match((sessions.resumeHow('cursor-agent', 'abc-123456', root) as { command: string }).command, /cursor-agent --resume abc-123456$/);
  assert.match((sessions.resumeHow('agy', 'abc-123456', root) as { command: string }).command, /agy --conversation abc-123456$/);
  assert.equal(sessions.resumeHow('dsh', 'abc-123456', root), null);
  assert.equal(sessions.resumeHow('codex', 'x; rm -rf /', root), null);
});

test('Codex 桌面版存成「1\\.」「\\- 」的行首列表记号读回来还原，别处的反斜杠不动', () => {
  assert.equal(sessions.unescapeListMarks('1\\. 跑一遍只读检查\n2\\) 再看 `a\\.b`\n\\- 一条\n  \\* 缩进的\n路径 C:\\\\x 和 \\n 不动'), '1. 跑一遍只读检查\n2) 再看 `a\\.b`\n- 一条\n  * 缩进的\n路径 C:\\\\x 和 \\n 不动');
});
