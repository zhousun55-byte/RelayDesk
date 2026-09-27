import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { withFakes } from './fakes';
import { CLI, sandbox, type Sandbox } from './helpers';

/**
 * 命令行补齐网页有的功能：改清单、调度设置、项目设置、标记不用复核、以前的群聊、投票时自己投和采纳、
 * 一直开着看进度、终端里连续群聊。全部用假的 claude（接 DeepSeek，弱）和 codex（gpt-6，强）。
 */

function prepared(name: string): Sandbox {
  const s = sandbox(name);
  withFakes(s);
  s.relay(['detect', '--offline']);
  s.relay(['init']);
  return s;
}

test('命令行改清单：加一步、打勾、去掉勾、删一步；不带参数列出来', () => {
  const s = prepared('cli-step');
  s.relay(['task', '做三件事', '--step', '甲', '乙']);
  s.relay(['step', 'add', '丙']);
  s.relay(['step', 'done', '1']);
  let out = s.relay(['step']);
  assert.match(out, /1\. \[x\] 甲\n\s+2\. \[ \] 乙\n\s+3\. \[ \] 丙/);
  s.relay(['step', 'remove', '2']);
  s.relay(['step', 'undo', '1']);
  out = s.relay(['step']);
  assert.match(out, /1\. \[ \] 甲\n\s+2\. \[ \] 丙/);
  assert.match(s.relay(['step', 'done', '9'], true), /清单里没有这一步/);
});

test('命令行的调度设置和项目设置：和网页是同一份；写错了说清楚', () => {
  const s = prepared('cli-settings');
  let out = s.relay(['settings', '--mode', 'dispatch', '--max', '5', '--no-wait', '--order', 'claude,codex']);
  assert.match(out, /全自动：派活/);
  const auto = JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'auto.json'), 'utf8'));
  assert.deepEqual([auto.dispatch, auto.maxStints, auto.waitForQuota, auto.order], [true, 5, false, ['claude', 'codex']]);
  out = s.relay(['settings', '--mode', 'relay']);
  assert.match(out, /全自动：接力/);
  assert.match(s.relay(['settings', '--mode', 'xyz'], true), /不认识的方式「xyz」/);
  assert.match(s.relay(['settings', '--max', '0'], true), /最多几棒 要是 1–100 之间的整数/);

  s.relay(['config', '--gate', 'true', '--protect', 'a.txt,conf/*.json']);
  let cfg = JSON.parse(s.read('.relay/config.json'));
  assert.deepEqual([cfg.gate.command, cfg.protectedPaths], ['true', ['a.txt', 'conf/*.json']]);
  out = s.relay(['config', '--no-gate', '--no-protect']);
  assert.match(out, /检查命令：没有/);
  cfg = JSON.parse(s.read('.relay/config.json'));
  assert.deepEqual([cfg.gate.command, cfg.protectedPaths], ['', []]);
});

test('命令行标记「不用复核」和撤销', () => {
  const s = prepared('cli-mark');
  s.relay(['task', '做一件事', '--step', '甲']);
  s.relay(['go', 'claude']);
  assert.equal(s.stints()[0].review, 'needed', 'DeepSeek 做的：待复核');
  s.relay(['review', '--skip', '1', '--note', '其实是我自己改的']);
  assert.equal(s.stints()[0].review, 'skip');
  assert.match(s.stints()[0].note, /其实是我自己改的/);
  s.relay(['review', '--need', '1']);
  assert.equal(s.stints()[0].review, 'needed');
});

test('命令行的群聊：新群聊、列出存档、接着一段；投票时自己投一票、采纳（写进任务的约定）', () => {
  const s = prepared('cli-talk');
  s.relay(['task', '做一件事', '--step', '甲']);
  s.relay(['talk', '你好', '--ask', 'claude']);
  assert.match(s.relay(['talk', '--clear']), /已开始新群聊，原来那段存档为 talk-/);
  assert.match(s.relay(['talk', '--list']), /1\. 你好/);
  assert.match(s.relay(['talk', '--resume', '1']), /已接着「你好」/);
  assert.match(s.relay(['talk']), /我：你好/);

  let out = s.relay(['vote', '用哪个', '--option', '稳的', '快的', '--ask', 'claude,codex']);
  assert.match(out, /投票：用哪个/);
  out = s.relay(['vote', '--cast', 'b', '--reason', '快']);
  assert.match(out, /已投方案 B/);
  out = s.relay(['vote', '--adopt', 'A']);
  assert.match(out, /已采纳方案 A/);
  assert.match(s.read('.relay/任务.md'), /用哪个 → 采用方案 A/);
});

test('一直开着看进度：不是终端时打印一次；清单里下一步有箭头、下面写做法', () => {
  const s = prepared('cli-watch');
  s.relay(['task', '做两件事', '--step', '甲', '乙']);
  s.relay(['step', 'done', '1']);
  s.write('.relay/任务.md', s.read('.relay/任务.md').replace('- [ ] 乙', '- [ ] 乙\n  - 改 b.txt，写一行 b'));
  const out = s.relay(['watch']);
  assert.match(out, /接力台 · repo · \d\d:\d\d/);
  assert.match(out, /✓ 1\. 甲\n\s+→ 2\. 乙\n\s+改 b\.txt，写一行 b/);
  assert.match(out, /现在：/);
});

test('终端里连续群聊：打一句大家依次回答；/成员 换人、/对比、/退出 时等这一轮说完', () => {
  const s = prepared('cli-chat');
  const r = spawnSync(process.execPath, [CLI, 'chat', '--ask', 'claude,codex'], {
    cwd: s.repo,
    env: s.env,
    input: '大家好\n/成员 codex\n/对比 各自说一句\n/不认识\n/退出\n',
    encoding: 'utf8',
    timeout: 60_000,
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  assert.match(out, /claude 的看法：同意/);
  assert.match(out, /codex 的看法：同意/);
  assert.match(out, /群聊成员：GPT-6/);
  assert.match(out, /codex 独立想了想：可以/);
  assert.match(out, /不认识 \/不认识/);
  assert.doesNotMatch(out, /我：大家好/, '自己打的话不再打一遍');
});
