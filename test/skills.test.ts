import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 技能：项目里和这台电脑上的汇成一份（同名只算一个，项目的优先）；写了 /技能名 就把做法附在开工说明后面。 */

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-skills-home-')));
process.env.HOME = HOME;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const skills = require('../src/core/skills') as typeof import('../src/core/skills');

const put = (dir: string, name: string, front: string, body: string) => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\n${front}\n---\n\n${body}\n`);
};

test('技能汇总：项目的、~/.claude、~/.agents、~/.codex 的都列出来，同名只留一个（项目的优先），藏起来的、synced 不列；description 写成几行的也读得出', () => {
  const root = path.join(HOME, 'proj');
  put(path.join(root, '.claude', 'skills'), '自审', 'name: 自审\ndescription: 项目里的自审', '项目的做法');
  put(path.join(HOME, '.agents', 'skills'), '自审', 'name: 自审\ndescription: 电脑上的自审', '电脑上的做法');
  put(path.join(HOME, '.claude', 'skills'), 'no-ai', 'name: no-ai\ndescription: >-\n  去 AI 味\n  的写法', '改写规则');
  put(path.join(HOME, '.codex', 'skills'), 'automate', 'name: automate\ndescription: "Codex 自动化"', '做法');
  put(path.join(HOME, '.claude', 'skills', '.备份'), 'x', 'name: x', '不列');
  put(path.join(HOME, '.claude', 'skills', 'synced'), 'pdf', 'name: pdf', '不列');
  const list = skills.listSkills(root);
  assert.deepEqual(
    list.map((s) => [s.name, s.description, s.from]),
    [
      ['自审', '项目里的自审', 'project'],
      ['no-ai', '去 AI 味 的写法', 'user'],
      ['automate', 'Codex 自动化', 'user'],
    ]
  );
  assert.deepEqual(skills.skillsIn(root, '按 /自审 过一遍，再 /no-ai 改写；路径 a/自审 不算', list).map((s) => s.name), ['自审', 'no-ai']);
  const note = skills.skillNote(root, '做事 /自审');
  assert.match(note, /技能「自审」/);
  assert.match(note, /项目的做法/);
  assert.doesNotMatch(note, /电脑上的做法/);
  assert.equal(skills.skillNote(root, '没写技能'), '');
  // 很长的技能只附前 12000 字
  put(path.join(root, '.agents', 'skills'), 'long', 'name: long', 'x'.repeat(20_000));
  assert.ok(skills.skillNote(root, '/long').length < 13_000);
});
