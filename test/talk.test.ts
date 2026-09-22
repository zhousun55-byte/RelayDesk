import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRound, formatTalkHistory, listTalkRooms, maybeAsk, parseMentions, pullIntoTalk, readTalk, resolveProjectFile, saveTalkFile, sayInTalk, settleTalk, talkMdPath } from '../src/core/talk';

test('群聊：写下的话能读回来，拉人先记进了群', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-talk-'));
  sayInTalk(dir, '你好');
  pullIntoTalk(
    dir,
    'claude',
    { who: 'Cursor · Grok 4.6', windowId: 'cursor', text: '进来看看' },
    { ask: false }
  );
  const lines = readTalk(dir);
  assert.ok(lines.some((l) => l.mine && l.text === '你好'));
  assert.ok(lines.some((l) => /Claude 进了群/.test(l.text)));
  assert.ok(lines.some((l) => l.windowId === 'cursor' && /进来看看/.test(l.text)));
  assert.ok(lines.some((l) => l.pending && l.windowId === 'claude'));
  settleTalk(dir, 'claude', '我看见了');
  const after = readTalk(dir);
  assert.ok(after.some((l) => l.text === '我看见了' && !l.pending && l.windowId === 'claude'));
  assert.ok(!after.some((l) => l.pending));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('群聊：人说一句，在座的窗口带着前面的话接', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-talk-ask-'));
  pullIntoTalk(dir, 'claude', undefined, { ask: false });
  settleTalk(dir, 'claude', '我在');
  sayInTalk(dir, '刚才那句你看见了吗');
  maybeAsk(dir, { ask: false, fresh: true });
  const hist = formatTalkHistory(dir);
  assert.match(hist, /Claude 进了群/);
  assert.match(hist, /我在/);
  assert.match(hist, /刚才那句你看见了吗/);
  assert.ok(readTalk(dir).some((l) => l.pending && l.windowId === 'claude'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('群聊：@ 点到的人先接，回话排在后面', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-talk-at-'));
  assert.deepEqual(parseMentions('@Claude 看这里', [{ id: 'claude', label: 'Claude' }]), ['claude']);
  pullIntoTalk(dir, 'claude', undefined, { ask: false });
  sayInTalk(dir, '插一句');
  settleTalk(dir, 'claude', '先说的', { ask: false });
  const texts = readTalk(dir).map((l) => l.text);
  assert.ok(texts.indexOf('插一句') < texts.indexOf('先说的'));
  sayInTalk(dir, '@Claude 接着说');
  assert.deepEqual(buildRound(dir), ['claude']);
  assert.ok(fs.existsSync(talkMdPath(dir)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('群聊：文件挂在这句话上，旧的最认真不显示', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-talk-file-'));
  sayInTalk(dir, '看这个', ['src/desk.js']);
  const mine = readTalk(dir).find((l) => l.mine);
  assert.deepEqual(mine?.files, ['src/desk.js']);
  assert.match(formatTalkHistory(dir), /文件：src\/desk.js/);
  fs.appendFileSync(
    path.join(dir, '.relay', 'talk.jsonl'),
    JSON.stringify({
      ts: new Date().toISOString(),
      kind: 'person',
      who: 'Claude',
      windowId: 'claude',
      sub: 'Claude Opus · 最认真',
      text: '在',
    }) + '\n'
  );
  const line = readTalk(dir).find((l) => l.windowId === 'claude');
  assert.equal(line?.sub, 'Claude Opus');
  assert.equal(formatTalkHistory(dir).includes('最认真'), false);
  const rooms = listTalkRooms([{ name: '这里', root: dir, current: true }]);
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].current, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('上传的文件留在这个项目里', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-talk-up-'));
  const rel = saveTalkFile(dir, '图.png', Buffer.from([137, 80, 78, 71]));
  assert.equal(resolveProjectFile(dir, rel) !== null, true);
  assert.equal(resolveProjectFile(dir, '../etc/passwd'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('群聊：窗口没开就拉不进来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-talk-miss-'));
  assert.throws(() => pullIntoTalk(dir, 'nosuch'), /窗口没开/);
  fs.rmSync(dir, { recursive: true, force: true });
});
