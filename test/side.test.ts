import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockingMainStatus, isSidePath } from '../src/core/side';

test('群聊文件不挡住合回', () => {
  assert.equal(isSidePath('.relay/talk.jsonl'), true);
  assert.equal(isSidePath('.relay/attach/a.png'), true);
  assert.equal(isSidePath('README.md'), false);
  const porcelain = [' M README.md', '?? .relay/talk.jsonl', '?? .relay/talk.md', '?? .relay/attach/a.png'].join('\n');
  assert.equal(blockingMainStatus(porcelain), ' M README.md');
  assert.equal(blockingMainStatus('?? .relay/talk.jsonl\n?? .relay/title.txt\n'), '');
});
