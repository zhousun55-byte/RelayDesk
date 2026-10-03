import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { langNote, normalizeAutoSettings } from '../src/core/auto-settings';

/**
 * 网页的英文版：app.js 里每个 T`…` 在英文表里都有；后台送来的常见说法 tr(…) 换得成英文；
 * 认不出来的模型写名字的头一个字母；网页是英文时请 AI 用英文写。
 */

const WEB = path.join(__dirname, '..', 'src', 'web');
const I18N = fs.readFileSync(path.join(WEB, 'i18n.js'), 'utf8').replace("'use strict';", '');
const APP = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');

/** 在沙箱里按某种语言载入 i18n.js。 */
function i18n(lang: 'zh' | 'en') {
  const ctx: Record<string, unknown> = { localStorage: { getItem: () => lang }, navigator: { language: lang } };
  vm.runInNewContext(`${I18N}\nresult = { T, L, tr, EN, LANG };`, ctx);
  return ctx.result as { T: (s: TemplateStringsArray | string[], ...v: unknown[]) => string; L: (s: string, ctx?: string) => string; tr: (s: string) => string; EN: Record<string, unknown>; LANG: { now: string } };
}

test('英文版：app.js 里每一句 T`…` 在英文表里都有；中文时原样拼出来', () => {
  const sf = ts.createSourceFile('app.js', APP, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const keys = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isTaggedTemplateExpression(n) && n.tag.getText(sf) === 'T') {
      const t = n.template;
      keys.add(ts.isNoSubstitutionTemplateLiteral(t) ? t.text : [t.head.text, ...t.templateSpans.map((x) => x.literal.text)].join('{}'));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(keys.size > 300, `只找到 ${keys.size} 句`);
  const { EN } = i18n('en');
  const missing = [...keys].filter((k) => !(k in EN));
  assert.deepEqual(missing, [], '这几句没有英文');

  const zh = i18n('zh');
  const n = 3;
  const tpl = (strs: TemplateStringsArray, ...v: unknown[]) => zh.T(strs, ...v);
  assert.equal(tpl`第 ${n} 棒待复核${''}`, '第 3 棒待复核');
  const en = i18n('en');
  const tplEn = (strs: TemplateStringsArray, ...v: unknown[]) => en.T(strs, ...v);
  assert.equal(tplEn`第 ${n} 棒待复核${''}`, 'Leg 3 needs review');
  assert.equal(tplEn`${1} 个文件`, '1 file');
  assert.equal(tplEn`${4} 个文件`, '4 files');
  assert.equal(en.L('项目'), 'Projects');
  assert.equal(en.L('项目', '设置'), 'Project');
  assert.equal(zh.L('项目', '设置'), '项目');
});

test('英文版：后台送来的状态、结论、验收、恢复时间换成英文；AI 写的话、认不出的原样', () => {
  const { tr } = i18n('en');
  const cases: [string, string][] = [
    ['已交接', 'Handed off'],
    ['复核：没问题（Codex · gpt-6）', 'Review: No problems (Codex · gpt-6)'],
    ['待复核 · 只有弱模型复核过，不算数', "Needs review · Only a weak model reviewed it, so it doesn't count"],
    ['接力台中途被关掉了，这一棒没跑完。', 'RelayDesk was closed midway, so this leg did not finish.'],
    ['明天 09:30 恢复', 'back tomorrow 09:30'],
    ['15:00 恢复', 'back 15:00'],
    ['3 分钟没有输出，已停止', 'No output for 3 min, stopped'],
    ['检查没过（第 7 棒之后）', 'Check failed (after leg 7)'],
    ['清单 9/9 全部打勾，Claude Opus 5.5 终审过了，检查通过', 'Checklist 9/9 all ticked, final review passed (Claude Opus 5.5), check passed'],
    ['Claude Code 官方账号', 'Claude Code (official account)'],
    ['智谱接口 · GLM-5.3', 'Zhipu API · GLM-5.3'],
    ['第 3 步：加 subtract 和测试', 'Step 3: 加 subtract 和测试'],
  ];
  for (const [zh, want] of cases) assert.equal(tr(zh), want, zh);
  // AI 写的交接摘要、认不出的原样
  assert.equal(tr('给 calc.py 加了 power，测试全过'), '给 calc.py 加了 power，测试全过');
  assert.equal(tr('Added power()'), 'Added power()');
  assert.equal(i18n('zh').tr('已交接'), '已交接');
});

test('认不出来的模型：写名字的头一个字母（豆包写「豆」），撞了的写两个字母；名字里没有字才用几何图形', () => {
  const pick = (name: string) => {
    // 按 \r\n 和 \n 都能切行：Windows 上签出的文件是 \r\n，只按 \n 切的话那一行是「}\r」，永远找不到函数的结尾
    const lines = APP.split(/\r?\n/);
    const i = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    let j = i;
    while (lines[j] !== '}') j++;
    return lines.slice(i, j + 1).join('\n');
  };
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(`${pick('monoOf')}\nresult = monoOf;`, ctx);
  const monoOf = ctx.result as (t: string, taken?: Set<string>) => string | null;
  assert.equal(monoOf('Mistral Large 3'), 'M');
  assert.equal(monoOf('豆包'), '豆');
  assert.equal(monoOf('我的接口'), '接');
  const taken = new Set(['M']);
  assert.equal(monoOf('MiniMax M3', taken), 'Mi');
  taken.add('Mi');
  assert.equal(monoOf('Mistral', taken), 'Ms');
  assert.equal(monoOf('···'), null);
});

test('网页是英文时，给 AI 的话后面请它用英文写（接力台要认的词照原样）；中文时什么都不加', () => {
  assert.equal(langNote('zh'), '');
  assert.match(langNote('en'), /in English/);
  assert.match(langNote('en'), /section headings, status words, verdict choices/);
  assert.equal(normalizeAutoSettings({}).lang, 'zh');
  assert.equal(normalizeAutoSettings({ lang: 'en' }).lang, 'en');
  assert.equal(normalizeAutoSettings({ lang: 'fr' }).lang, 'zh');
  // 没有设置文件时按中文
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-lang-'));
  const was = process.env.RELAY_HOME;
  process.env.RELAY_HOME = home;
  try {
    assert.equal(langNote(), '');
    fs.writeFileSync(path.join(home, 'auto.json'), JSON.stringify({ lang: 'en' }));
    assert.match(langNote(), /English/);
  } finally {
    if (was === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = was;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
