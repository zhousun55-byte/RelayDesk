import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { which } from '../src/core/env';
import { fillTemplate, shellWords } from '../src/core/launch';
import { parseHandoff, parseReview, parseTask } from '../src/core/notes';
import { protocolBlock, protocolState, upsertBlock } from '../src/core/protocol';
import { npmShimTarget, resolveExec, shellArgv } from '../src/core/proc';

/**
 * 原生 Windows：命令交给 cmd.exe；npm 装的 .cmd 直接用 node 跑它指向的 .js（多行提示词才过得去）；
 * 按 PATHEXT 找命令；模板里的路径按 cmd.exe 的双引号转义。这台电脑不是 Windows，按 Windows 的规矩算一遍。
 */

const SHIM = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`;

function withPath<T>(dir: string, fn: () => T): T {
  const was = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, off: process.env.RELAY_LOGIN_PATH };
  process.env.PATH = dir;
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  process.env.RELAY_LOGIN_PATH = 'off';
  try {
    return fn();
  } finally {
    for (const [k, v] of [['PATH', was.PATH], ['PATHEXT', was.PATHEXT], ['RELAY_LOGIN_PATH', was.off]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('Windows：shell 命令交给 cmd.exe（整条包在引号里原样传）；Mac/Linux 还是 sh -c', () => {
  assert.deepEqual(shellArgv('npm test', false), ['sh', '-c', 'npm test']);
  const w = shellArgv('npm test && echo "好"', true);
  assert.match(w[0], /cmd(\.exe)?$/i);
  assert.deepEqual(w.slice(1), ['/d', '/s', '/c', '"npm test && echo "好""']);
  assert.equal(resolveExec(w, true).verbatim, true);
});

test('Windows：npm 装的 codex.cmd 直接用 node 跑它的 .js；自带 node.exe 的用自带的；指向 .exe 的直接跑；认不出的 .cmd 经 cmd.exe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-win-'));
  try {
    fs.writeFileSync(path.join(dir, 'codex.cmd'), SHIM);
    fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\n'); // npm 放在旁边给 Git Bash 用的，不算
    const js = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    assert.equal(npmShimTarget(path.join(dir, 'codex.cmd')), js);
    withPath(dir, () => {
      assert.equal(which('codex', true), path.join(dir, 'codex.cmd'));
      assert.deepEqual(resolveExec(['codex', 'exec', '第一行\n第二行'], true), { file: process.execPath, args: [js, 'exec', '第一行\n第二行'], verbatim: false });
      fs.writeFileSync(path.join(dir, 'node.exe'), '');
      assert.equal(resolveExec(['codex'], true).file, path.join(dir, 'node.exe'));

      fs.writeFileSync(path.join(dir, 'claude.cmd'), '@"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n');
      assert.deepEqual(resolveExec(['claude', '-p'], true), { file: path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), args: ['-p'], verbatim: false });

      fs.writeFileSync(path.join(dir, 'tool.bat'), '@echo hi\r\n');
      const bat = resolveExec(['tool', 'a b', 'say "hi"'], true);
      assert.equal(bat.verbatim, true);
      assert.equal(bat.args.at(-1), `""${path.join(dir, 'tool.bat')}" "a b" "say ""hi""""`);

      fs.writeFileSync(path.join(dir, 'git.exe'), '');
      assert.deepEqual(resolveExec(['git', 'status'], true), { file: path.join(dir, 'git.exe'), args: ['status'], verbatim: false });
      assert.equal(which('nope', true), null);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Windows：模板里的路径用双引号（里面的双引号写两遍），反斜杠是路径不是转义', () => {
  assert.equal(fillTemplate('code {{dir}}', { dir: 'C:\\Users\\me\\项目 A' }, true), 'code "C:\\Users\\me\\项目 A"');
  assert.equal(fillTemplate('x "{{out}}"', { out: 'a"b' }, true), 'x "a""b"');
  assert.equal(fillTemplate('code {{dir}}', { dir: "/tmp/it's" }, false), `code '/tmp/it'\\''s'`);
  assert.deepEqual(shellWords('C:\\Tools\\x.exe "C:\\My Dir"', true), ['C:\\Tools\\x.exe', 'C:\\My Dir']);
  assert.deepEqual(shellWords('a\\ b', false), ['a b']);
});

test('Windows：AI 写的任务、交接、复核是 \\r\\n 换行也认得（打勾、状态、结论）', () => {
  const crlf = (s: string) => s.replace(/\n/g, '\r\n');
  const t = parseTask(crlf('# 任务\n\n加导出\n\n## 进度\n\n- [x] 第一步\n- [ ] 第二步\n'));
  assert.deepEqual(t.items.map((i) => [i.text, i.done]), [['第一步', true], ['第二步', false]]);
  assert.equal(t.title, '加导出');
  const h = parseHandoff(crlf('# 交接：Codex · gpt-6\n\n- 状态：已交接\n\n## 做了什么\n\n- 加了导出按钮\n'));
  assert.equal(h.state, 'handed');
  assert.equal(h.summary, '加了导出按钮');
  assert.equal(parseReview(crlf('# 复核：第 3 棒\n\n- 结论：没问题\n')).verdict, 'ok');
});

test('Windows：AGENTS.md 是 \\r\\n 换行时，规矩也用 \\r\\n 写，认得出是最新的，再写一遍不改', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-crlf-'));
  try {
    const f = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(f, '# 我的规矩\r\n\r\n用中文回答。\r\n');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '@AGENTS.md\r\n');
    assert.equal(upsertBlock(f), true);
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/[^\r]\n/.test(text), '整个文件都是 \\r\\n');
    assert.ok(text.includes(protocolBlock().split('\n')[1]));
    assert.equal(protocolState(dir), 'ok');
    assert.equal(upsertBlock(f), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
