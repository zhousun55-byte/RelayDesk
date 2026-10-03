import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// Node 22.15 起才自带 zstd；更旧的 Node 上接力台读不了压缩过的 DeepSeek Harness 记录（读到的是空，不报错），这一项跳过
const zstd = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;

/**
 * 工具 → 接力台：读各家工具自己记的对话（学 mindbus、magpie 读各家记录的做法）。
 * 记录的样子照本机真实记录写（2026-10-03 核对过：DeepSeek Harness v4 是一批批追加的 zstd 帧，Cursor 命令行的正文在 agent-transcripts）。
 */

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sessions-tools-home-')));
process.env.HOME = HOME;
for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME', 'CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR']) delete process.env[k];

/* eslint-disable @typescript-eslint/no-require-imports */
const sessions = require('../src/core/sessions') as typeof import('../src/core/sessions');
/* eslint-enable @typescript-eslint/no-require-imports */

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sessions-proj-')));
const jl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const write = (file: string, text: string | Buffer) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

test('人说的话：去掉夹在里面的系统提醒、Cursor 的 <user_query> 只取里面；整句是工具塞的（技能脚手架、后台通知、被打断）不算', () => {
  assert.equal(sessions.saidText('帮我看看\n<system-reminder>\nCLAUDE.md 里写着……\n</system-reminder>'), '帮我看看');
  assert.equal(sessions.saidText('<timestamp>Sunday, Sep 27, 2026</timestamp>\n<user_query>\n你好\n</user_query>'), '你好');
  assert.equal(sessions.saidText('Base directory for this skill: /x/skills/no-ai'), '');
  assert.equal(sessions.saidText('<task-notification>\n<task-id>1</task-id>'), '');
  assert.equal(sessions.saidText('[Request interrupted by user]'), '');
  assert.equal(sessions.saidText('<system-reminder>只有提醒</system-reminder>'), '');
  assert.equal(sessions.saidText('没写完的 <system-reminder> 留着'), '没写完的 <system-reminder> 留着');
});

test('DeepSeek Harness：zstd 一批批追加的几帧都读得出来；只认人打的字，标题用它最后起的；子代理、接力台派的不列', { skip: !zstd && '这个 Node 没有自带 zstd' }, () => {
  const dir = path.join(HOME, '.dsh', 'sessions', '--some-encoded-cwd--');
  const head = { type: 'session', version: 4, id: 'session-aaaa1111', createdAt: 1790610662758, cwd: ROOT, isSeeded: false, delegationDepth: 0 };
  const frames = [
    jl([head, { type: 'user/message', seq: 1, time: 1790610663000, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把导出做成 CSV' }] } }]),
    jl([{ type: 'user/message', seq: 2, data: { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context.' }] } }, { type: 'session/title', seq: 3, data: { title: '把导出做成' } }]),
    jl([
      { type: 'assistant/message', seq: 4, data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '想一想' }, { type: 'text', text: '好，先读代码。' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"export.py"}' }] } } },
      { type: 'session/title', seq: 5, data: { title: '导出做成 CSV' } },
    ]),
  ];
  write(path.join(dir, 'session-aaaa1111', 'session.v4.jsonl.zstd'), Buffer.concat(frames.map((f) => zstd!(Buffer.from(f)))));
  // 旧格式留下的那份不读
  write(path.join(dir, 'session-aaaa1111', 'session.jsonl'), jl([{ ...head, cwd: '/别处' }]));
  // 子代理
  write(path.join(dir, 'session-bbbb2222', 'session.jsonl'), jl([{ ...head, id: 'session-bbbb2222', parentSession: 'session-aaaa1111', delegationDepth: 1 }]));
  // 接力台派的
  write(path.join(dir, 'session-cccc3333', 'session.jsonl'), jl([{ ...head, id: 'session-cccc3333' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你是「接力台」派来接着做这个项目的第 2 棒' }] } }]));

  const list = sessions.projectSessions(ROOT).filter((x) => x.tool === 'dsh');
  assert.deepEqual(
    list.map((x) => [x.id, x.title]),
    [['session-aaaa1111', '导出做成 CSV']]
  );
  const r = sessions.readSession(ROOT, 'dsh', 'session-aaaa1111');
  assert.deepEqual(
    r.messages.map((m) => [m.role, m.text]),
    [
      ['user', '把导出做成 CSV'],
      ['assistant', '好，先读代码。'],
      ['tool', 'read：export.py'],
    ]
  );
  assert.ok(sessions.readSession(ROOT, 'dsh', 'session-cccc3333'), '接力台派的那一棒：按编号照样读得出（挂在棒上看）');
  assert.throws(() => sessions.readSession(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-other-')), 'dsh', 'session-aaaa1111'), /找不到/, '别的文件夹不认');
});

test('Cursor 命令行：按文件夹的 md5 找到它开过的对话，正文读 agent-transcripts；人打的字取 <user_query> 里面，[REDACTED] 去掉', () => {
  const id = '22669778-879f-461d-aa75-1aae509db8e6';
  const chat = path.join(HOME, '.cursor', 'chats', crypto.createHash('md5').update(ROOT).digest('hex'), id);
  write(path.join(chat, 'meta.json'), JSON.stringify({ schemaVersion: 1, createdAtMs: 1790488824490, hasConversation: true, updatedAtMs: 1790489297671, cwd: ROOT }));
  const slug = ROOT.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  write(
    path.join(HOME, '.cursor', 'projects', slug, 'agent-transcripts', id, `${id}.jsonl`),
    jl([
      { role: 'user', message: { content: [{ type: 'text', text: '<timestamp>Sunday, Sep 27, 2026, 2:00 PM (UTC+8)</timestamp>\n<user_query>\n导出先做哪种格式？\n</user_query>' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: '先做 CSV。\n\n[REDACTED]' }, { type: 'tool_use', name: 'Read', input: { path: 'export.py' } }] } },
      { type: 'turn_ended', status: 'success' },
    ])
  );
  // 子代理的不列
  const sub = path.join(path.dirname(chat), 'sub-agent-0001');
  write(path.join(sub, 'meta.json'), JSON.stringify({ hasConversation: true, cwd: ROOT, isSubagent: true, updatedAtMs: 1790489297671 }));

  const list = sessions.projectSessions(ROOT).filter((x) => x.tool === 'cursor-agent');
  assert.deepEqual(
    list.map((x) => [x.id, x.title]),
    [[id, '导出先做哪种格式？']]
  );
  const r = sessions.readSession(ROOT, 'cursor-agent', id);
  assert.deepEqual(
    r.messages.map((m) => [m.role, m.text]),
    [
      ['user', '导出先做哪种格式？'],
      ['assistant', '先做 CSV。'],
      ['tool', 'Read：export.py'],
    ]
  );
  assert.deepEqual(sessions.resumeHow('cursor-agent', id, ROOT), { command: `cd ${JSON.stringify(ROOT)} && cursor-agent --resume ${id}` });
});

test('Codex：压缩、分叉抄出来的几份同一段对话只列最新的一份；子代理不列；归档了的按编号照样读得出', () => {
  const day = path.join(HOME, '.codex', 'sessions', '2026', '10', '03');
  const meta = (id: string, extra: Record<string, unknown> = {}) => ({ type: 'session_meta', payload: { id, cwd: ROOT, originator: 'codex_cli_rs', source: 'cli', ...extra } });
  const said = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  write(path.join(day, 'rollout-2026-10-03T10-00-00-thread-orig1.jsonl'), jl([meta('thread-orig1'), said('做个 CSV 导出')]));
  write(path.join(day, 'rollout-2026-10-03T11-00-00-thread-fork22.jsonl'), jl([meta('thread-fork22', { forked_from_id: 'thread-orig1' }), said('做个 CSV 导出'), said('<environment_context>cwd</environment_context>')]));
  write(path.join(day, 'rollout-2026-10-03T12-00-00-thread-sub333.jsonl'), jl([meta('thread-sub333', { parent_thread_id: 'thread-orig1' }), said('子代理的活')]));
  const later = new Date(Date.now() + 1000);
  fs.utimesSync(path.join(day, 'rollout-2026-10-03T11-00-00-thread-fork22.jsonl'), later, later);
  const list = sessions.projectSessions(ROOT).filter((x) => x.tool === 'codex');
  assert.deepEqual(
    list.map((x) => x.id),
    ['thread-fork22']
  );
  write(path.join(HOME, '.codex', 'archived_sessions', 'rollout-2026-09-01T10-00-00-thread-old444.jsonl'), jl([meta('thread-old444'), said('很早以前的')]));
  assert.equal(sessions.readSession(ROOT, 'codex', 'thread-old444').messages[0].text, '很早以前的');
});
