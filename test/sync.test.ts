import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withFakes } from './fakes';
import { sandbox } from './helpers';

/**
 * 对话同步（学 mindbus：对话属于人，换工具也接得上）：
 * - 接力台 → 工具：群聊里每一位在自己工具里一直是同一段对话，下一轮接着那段说（只带它没看过的新消息），
 *   工具的历史里看得到、人在工具里也接得上；
 * - 工具 → 接力台：你在工具里开的对话列在接力台里、读得出来。
 */

test('群聊：每一位在自己工具里接着同一段对话说，只带它上次说完之后的新消息；回答记下工具和对话编号', () => {
  const s = sandbox('talk-thread');
  withFakes(s);
  s.relay(['detect', '--offline']);
  s.relay(['init']);
  s.relay(['talk', '先做哪个功能？', '--ask', 'claude,codex']);
  s.relay(['talk', '那导出用什么格式？', '--ask', 'claude,codex']);
  const rows = fs
    .readFileSync(path.join(s.repo, '.relay', 'talk.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { kind: string; agent?: string; session?: { tool: string; id: string } });
  const ai = rows.filter((r) => r.kind === 'ai');
  assert.equal(ai.length, 4);
  for (const r of ai) assert.ok(r.session?.id, `每条回答都记下了对话编号：${JSON.stringify(r)}`);
  const of = (name: string) => ai.filter((r) => r.agent === name).map((r) => r.session!);
  assert.equal(of('claude')[0].id, of('claude')[1].id, 'Claude Code 第二轮接着第一轮那段说');
  assert.equal(of('codex')[0].id, of('codex')[1].id, 'Codex 第二轮接着第一轮那段说');
  assert.equal(of('codex')[0].tool, 'codex');

  const log = fs.readFileSync(s.env.FAKE_LOG!, 'utf8').split('\n');
  assert.ok(log.some((l) => /^claude .*--resume fake-claude-/.test(l)), 'claude --resume 编号');
  assert.ok(log.some((l) => /^codex exec resume .*sandbox_mode="read-only".* fake-\d+ -$/.test(l)), 'codex exec resume，只读');
  assert.ok(!log.some((l) => /^codex .*--ephemeral/.test(l)), '群聊不再用 --ephemeral（不留记录）');

  // 第二轮的提示：只有新消息，没有整套规矩和第一轮的话
  const prompts = fs
    .readdirSync(s.base)
    .filter((f) => /^prompt-codex-\d+\.txt$/.test(f))
    .map((f) => fs.readFileSync(path.join(s.base, f), 'utf8'));
  const second = prompts.find((p) => p.includes('你上次说完之后的新消息'));
  assert.ok(second, prompts.join('\n----\n'));
  assert.match(second!, /那导出用什么格式？/);
  assert.doesNotMatch(second!, /先做哪个功能？/, '第一问它已经在那段对话里了');
});

test('群聊：工具里那段对话没了（被删、过期），另开一段、带上整段记录，照样答', () => {
  const s = sandbox('talk-thread-lost');
  withFakes(s);
  s.relay(['detect', '--offline']);
  s.relay(['init']);
  s.relay(['talk', '先做哪个功能？', '--ask', 'claude']);
  // 把 Claude Code 记的那段对话删掉
  const dir = path.join(s.home, '.claude', 'projects');
  for (const d of fs.readdirSync(dir)) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
  s.relay(['talk', '那导出用什么格式？', '--ask', 'claude']);
  const ai = fs
    .readFileSync(path.join(s.repo, '.relay', 'talk.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { kind: string; session?: { id: string } })
    .filter((r) => r.kind === 'ai');
  assert.equal(ai.length, 2);
  assert.notEqual(ai[0].session!.id, ai[1].session!.id, '另开了一段');
  const log = fs.readFileSync(s.env.FAKE_LOG!, 'utf8');
  assert.doesNotMatch(log, /--resume/, '找不到原来那段就不去接');
});
