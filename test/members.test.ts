import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

/** 网页的函数在沙箱里跑：先放进 i18n.js（界面上的字 T`…`、后台的字 tr(…)，默认中文）。 */
const I18N = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'i18n.js'), 'utf8').replace("'use strict';", '');
const runWeb = (code: string, ctx: vm.Context) => vm.runInNewContext(`${I18N}\n${code}`, ctx);

/**
 * 成员一律叫它用的模型、名单去重、删掉的不再加回来、Cursor 跟着桌面版选的模型、群聊分成几段。
 * 这个文件里的测试不碰你真实的家目录。
 */

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-members-home-')));
process.env.HOME = HOME;
process.env.RELAY_HOME = path.join(HOME, '.relay');
process.env.RELAY_SCAN_APPS = 'off';
process.env.RELAY_LOGIN_PATH = 'off';
process.env.RELAY_AUTODETECT = 'off';
fs.mkdirSync(process.env.RELAY_HOME, { recursive: true });

/* eslint-disable @typescript-eslint/no-require-imports */
const names = require('../src/core/names') as typeof import('../src/core/names');
const registry = require('../src/core/registry') as typeof import('../src/core/registry');
const detect = require('../src/core/detect') as typeof import('../src/core/detect');
const harness = require('../src/core/harness') as typeof import('../src/core/harness');
const talk = require('../src/core/talk') as typeof import('../src/core/talk');
/* eslint-enable @typescript-eslint/no-require-imports */

const home = (rel: string) => path.join(process.env.RELAY_HOME!, rel);
const writeJson = (p: string, v: unknown) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v));
};

/** 模型 id（工具报的、名单里写的、交接里自己写的）→ 给人看的名字。 */
const NAMES: [string, string][] = [
  ['gpt-6-sol', 'GPT-6 Sol'],
  ['GPT-6', 'GPT-6'],
  ['gpt-5.3-codex-high-fast', 'GPT-5.3 Codex'],
  ['claude-opus-5-5', 'Claude Opus 5.5'],
  ['opus', 'Claude Opus'],
  ['Claude Opus 4.6 (Thinking)', 'Claude Opus 4.6'],
  ['claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet'],
  ['claude-sonnet-4-20250514', 'Claude Sonnet 4'],
  ['claude-fable-5-1', 'Claude Fable 5.1'],
  ['cursor-grok-4.6-high-fast', 'Grok 4.6'],
  ['grok-4.7-high-fast', 'Grok 4.7'],
  ['Grok 4.6 Fast', 'Grok 4.6'],
  ['deepseek-flash', 'DeepSeek Flash'],
  ['deepseek-flash[1m]', 'DeepSeek Flash'],
  ['deepseek/deepseek-flash', 'DeepSeek Flash'],
  ['deepseek-v4-pro', 'DeepSeek V4 Pro'],
  ['GLM-5.3', 'GLM-5.3'],
  ['mimo-v2.6-pro', 'MiMo V2.6 Pro'],
  ['gemini-3.7-flash-high', 'Gemini 3.7 Flash'],
  ['kimi-k2', 'Kimi K2'],
  ['qwen3-coder-plus', 'Qwen3 Coder Plus'],
  ['', ''],
];

test('成员叫它用的模型：gpt-6-sol → GPT-6 Sol、opus → Claude Opus、带思考强度和快慢的去掉；网页里的写法和后台一样', () => {
  for (const [id, want] of NAMES) assert.equal(names.llmName(id), want, id);
  // 网页没有构建步骤，同一套规则写了两份：拿同一张表对照
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'app.js'), 'utf8').split('\n');
  const pick = (name: string) => {
    const i = src.findIndex((l) => new RegExp(`^(function ${name}\\(|const ${name} = )`).test(l));
    assert.ok(i >= 0, `app.js 里没有 ${name}`);
    if (/;\s*$/.test(src[i])) return src[i];
    let j = i;
    while (!/^(\}|\};)$/.test(src[j])) j++;
    return src.slice(i, j + 1).join('\n');
  };
  const ctx: Record<string, unknown> = {};
  runWeb(`${['splitLabel', 'LLM_WORD', 'LLM_VARIANT', 'llmName', 'nameOf'].map(pick).join('\n')}\nresult = { llmName, nameOf };`, ctx);
  const web = ctx.result as { llmName: (m: string) => string; nameOf: (label: string, model?: string) => string };
  for (const [id] of NAMES) assert.equal(web.llmName(id), names.llmName(id), `网页和后台对「${id}」叫法不一样`);
  // 记录里的「工具 · 模型」按模型叫；新的群聊记录里写的就是名字（两位同一个模型时后面带着工具，不能丢）
  assert.equal(web.nameOf('Claude Code 官方账号 · claude-opus-5-5'), 'Claude Opus 5.5');
  assert.equal(web.nameOf('Codex', undefined), 'Codex');
  assert.equal(web.nameOf('DeepSeek Flash（OpenCode）', 'deepseek-flash'), 'DeepSeek Flash（OpenCode）');
  assert.equal(names.whoName({ label: 'Codex · gpt-6-sol' }), 'GPT-6 Sol');
  assert.equal(names.whoName({ label: 'Cursor Agent', model: 'grok-4.7-high-fast' }), 'Grok 4.7');
  assert.equal(names.whoName({ label: '不知道是谁' }), '不知道是谁');
  assert.equal(names.appNameOf('open -a "Xiaomi MiMo" {{dir}}'), 'Xiaomi MiMo');
  assert.equal(names.appNameOf('open -a Cursor {{worktree}}'), 'Cursor');
});

test('名单去重：桌面程序记到同一家的命令行名下；同一个工具、同一个模型的并成一位；不同工具的同一个模型不并（往往是两份额度）', () => {
  writeJson(home('auto.json'), { order: ['claude-official', 'codex', 'claude'] });
  writeJson(home('agents.json'), {
    agents: [
      { name: 'claude', kind: 'cli', cmd: 'claude', tier: 'strong', harness: 'claude', model: 'opus' },
      { name: 'cursor', kind: 'app', cmd: 'open -a Cursor {{worktree}}', tier: 'strong' },
      { name: 'codex', kind: 'cli', cmd: 'codex', tier: 'strong', harness: 'codex', model: 'gpt-6-sol' },
      { name: 'gpt', kind: 'app', cmd: 'open -a ChatGPT {{worktree}}', tier: 'strong' },
      { name: 'cursor-agent', kind: 'cli', cmd: 'agent', tier: 'strong', harness: 'cursor-agent', model: 'grok-4.7-high-fast' },
      { name: 'claude-app', label: 'Claude', kind: 'app', cmd: 'open -a Claude {{dir}}', tier: 'strong' },
      { name: 'claude-official', kind: 'cli', cmd: 'claude --setting-sources project,local', tier: 'strong', harness: 'claude-official', model: 'claude-opus-5-5' },
      { name: 'agy', kind: 'cli', cmd: 'agy', tier: 'strong', harness: 'agy', model: 'claude-opus-5-5' },
      { name: 'trae', kind: 'app', cmd: 'open -a Trae {{dir}}', tier: 'weak' },
      { name: 'zcode-app', label: 'ZCode', kind: 'app', cmd: 'open -a ZCode {{dir}}', tier: 'weak' },
      { name: 'glm-api', kind: 'api', tier: 'weak', api: { baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'GLM-5.3', apiKeyEnv: 'ZHIPU_CODING_KEY', format: 'anthropic' } },
    ],
  });
  const changes = detect.tidyRegistry(null);
  assert.equal(changes.length, 5, changes.join('\n'));
  const reg = registry.loadRegistry();
  assert.deepEqual(
    reg.agents.map((a) => [a.name, names.appNameOf(a.app) ?? null]),
    [
      ['codex', 'ChatGPT'],
      ['cursor-agent', 'Cursor'],
      ['claude-official', 'Claude'],
      ['agy', null],
      ['trae', null],
      ['glm-api', 'ZCode'],
    ],
    '派活顺序靠前的官方账号留下，终端里的 Claude Code 并进去；Antigravity 里的同一个模型不并；认不出是哪一家的桌面程序单独一位；没有 ZCode 命令行时 ZCode 记到智谱接口名下'
  );
  assert.deepEqual(detect.tidyRegistry(null), [], '并过了就不再改');
});

test('删掉的成员：再识别也不加回来（连同记在它名下的桌面程序）；自己加回来就不算删掉的；新识别到的桌面程序记到同一家名下', () => {
  const PATH = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin';
  try {
    writeJson(home('auto.json'), { order: [] });
    writeJson(home('agents.json'), {
      agents: [
        { name: 'codex', kind: 'cli', cmd: 'codex', tier: 'strong', harness: 'codex', model: 'gpt-6-sol', detected: true },
        { name: 'opencode', kind: 'cli', cmd: 'opencode', tier: 'weak', harness: 'opencode', detected: true },
      ],
    });
    const h = (id: string) => ({ id, label: id, vendor: '', version: '1', where: '', login: { state: 'ok' as const, detail: '' }, model: {}, workLevels: ['safe' as const], canReview: true, tested: 'yes' as const, loginHint: '' });
    const report = { at: '', harnesses: [h('codex'), h('opencode')], providers: [], apps: [{ name: 'ChatGPT', hint: '' }], unknownKeys: [] };

    registry.removeAgent('opencode');
    assert.deepEqual(registry.loadRegistry().removed, ['h:opencode']);
    detect.syncRegistry(report);
    let reg = registry.loadRegistry();
    assert.deepEqual(
      reg.agents.map((a) => a.name),
      ['codex'],
      '删掉的 OpenCode 没回来'
    );
    assert.equal(reg.agents[0].app, 'open -a ChatGPT {{dir}}', 'ChatGPT 桌面版记在 Codex 名下，不单独占一位');

    registry.removeAgent('codex');
    assert.deepEqual(registry.loadRegistry().removed?.sort(), ['app:ChatGPT', 'h:codex', 'h:opencode']);
    detect.syncRegistry(report);
    assert.deepEqual(registry.loadRegistry().agents, [], '连同它名下的桌面程序都不回来');

    registry.upsertAgent({ name: 'codex', kind: 'cli', cmd: 'codex', harness: 'codex', tier: 'strong' });
    reg = registry.loadRegistry();
    assert.deepEqual(reg.removed?.sort(), ['app:ChatGPT', 'h:opencode'], '自己加回来的不再算删掉的');
  } finally {
    process.env.PATH = PATH;
  }
});

test('Cursor 用的模型：以桌面版对话框里选的为准（换成命令行认的名字）；没选、对不上就看命令行自己的设置', () => {
  const variant = (effort: string, fast: string, legacySlug: string) => ({
    parameterValues: [
      { id: 'context', value: '256k' },
      { id: 'reasoning_effort', value: effort },
      { id: 'fast', value: fast },
    ],
    legacySlug,
  });
  const state = (modelId: string, fast = 'true') => ({
    aiSettings: {
      modelConfig: {
        composer: {
          selectedModels: [
            {
              modelId,
              parameters: [
                { id: 'context', value: '256k' },
                { id: 'reasoning_effort', value: 'high' },
                { id: 'fast', value: fast },
              ],
            },
          ],
        },
      },
    },
    availableDefaultModels2: [{ name: 'grok-4.7', clientDisplayName: 'Grok 4.7', variants: [variant('high', 'false', 'grok-4.7-high'), variant('high', 'true', 'grok-4.7-high-fast')] }],
  });
  assert.deepEqual(harness.cursorDesktopModel(state('grok-4.7')), { model: 'grok-4.7-high-fast', label: 'Grok 4.7' });
  assert.deepEqual(harness.cursorDesktopModel(state('grok-4.7', 'false')), { model: 'grok-4.7-high', label: 'Grok 4.7' });
  assert.equal(harness.cursorDesktopModel(state('default')), null, '自动选的：看命令行自己的');
  assert.equal(harness.cursorDesktopModel(state('grok-9')), null, '模型表里没有');
  assert.equal(harness.cursorDesktopModel(null), null);

  // 没有桌面版（假家目录里没有它的库）：命令行的设置，新写法直接用 modelId，旧写法从显示名转
  writeJson(path.join(HOME, '.cursor', 'cli-config.json'), { model: { modelId: 'cursor-grok-4.6-high-fast', displayName: 'Grok 4.6 Fast' } });
  assert.deepEqual(harness.cursorSettings(), { model: 'cursor-grok-4.6-high-fast', label: 'Grok 4.6 Fast' });
  writeJson(path.join(HOME, '.cursor', 'cli-config.json'), { model: { modelId: 'grok-4.6', displayName: 'Cursor Grok 4.6 High Fast' } });
  assert.deepEqual(harness.cursorSettings(), { model: 'cursor-grok-4.6-high-fast', label: 'Grok 4.6 High Fast' });
});

test('群聊分成几段：新群聊把正在用的存档（空的不存）；存档按第一句问话起名；接着一段存档时，正在用的先存档；同一秒存两次不会盖掉', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-talks-')));
  talk.appendTalk(root, { kind: 'human', who: '我', text: '第一段的问题\n第二行' });
  talk.appendTalk(root, { kind: 'ai', who: 'GPT-6 Sol', agent: 'codex', model: 'gpt-6-sol', text: '回答' });
  const a = talk.archiveTalk(root)!;
  assert.match(a, /^talk-\d{8}-\d{6}$/);
  assert.equal(talk.archiveTalk(root), null, '没有正在用的：不存');
  talk.appendTalk(root, { kind: 'human', who: '我', text: '第二段' });
  assert.deepEqual(
    talk.talkSessions(root).map((x) => x.title),
    ['第一段的问题']
  );
  talk.resumeTalk(root, a);
  assert.equal(talk.readTalk(root)[0].text, '第一段的问题\n第二行', '接着的那段换成了正在用的');
  const now = talk.talkSessions(root);
  assert.deepEqual(
    now.map((x) => x.title),
    ['第二段'],
    '原来正在用的存了档'
  );
  assert.equal(talk.readTalk(root, 10, talk.talkFile(root, now[0].id))[0].text, '第二段');
  assert.throws(() => talk.talkFile(root, '../talk'), /没有这个群聊/);
  assert.throws(() => talk.resumeTalk(root, 'talk-20200101-000000'), /没有这个群聊/);
});

test('群聊里的名字：叫模型的名字；名单里两位是同一个模型时后面带上工具', () => {
  writeJson(home('agents.json'), {
    agents: [
      { name: 'dsh', kind: 'cli', cmd: 'dsh', tier: 'weak', harness: 'dsh', model: 'deepseek-flash' },
      { name: 'opencode', kind: 'cli', cmd: 'opencode', tier: 'weak', harness: 'opencode', model: 'deepseek/deepseek-flash' },
      { name: 'codex', kind: 'cli', cmd: 'codex', tier: 'strong', harness: 'codex', model: 'gpt-6-sol' },
    ],
  });
  const of = (n: string) => talk.speakerName(registry.findAgent(n)!);
  assert.equal(of('codex'), 'GPT-6 Sol');
  assert.equal(of('dsh'), 'DeepSeek Flash（DeepSeek Harness）');
  assert.equal(of('opencode'), 'DeepSeek Flash（OpenCode）');
});

test('Antigravity 安全档：它的设置允许读写项目外的文件就不派它（写文件的工具不经过沙箱）；关掉就派；完全放开不受这条限制', () => {
  writeJson(home('agents.json'), { agents: [{ name: 'agy', kind: 'cli', cmd: 'agy', tier: 'weak', harness: 'agy', detected: true }] });
  const h = { id: 'agy', label: 'Antigravity', vendor: '', version: '1.2.11', where: '', login: { state: 'ok' as const, detail: '' }, model: {}, workLevels: ['safe' as const, 'full' as const], canReview: true, tested: 'partial' as const, loginHint: '' };
  const report = { at: '', harnesses: [h], providers: [], apps: [], unknownKeys: [] };
  const settings = path.join(HOME, '.gemini', 'antigravity-cli', 'settings.json');
  const agy = (level: 'safe' | 'full') => detect.listMembers(level, report).find((m) => m.name === 'agy')!;

  writeJson(settings, { model: 'Gemini 3.8 Flash (High)', allowNonWorkspaceAccess: true, toolPermission: 'proceed-in-sandbox' });
  assert.equal(agy('safe').canWork, false);
  assert.match(agy('safe').why ?? '', /项目外/);
  assert.equal(agy('full').canWork, true, '完全放开本来就不拦');

  writeJson(settings, { model: 'Gemini 3.8 Flash (High)', allowNonWorkspaceAccess: false });
  assert.equal(agy('safe').canWork, true);
  assert.equal(agy('safe').why, undefined);
  assert.equal(harness.findHarness('agy')!.model({ exec: [], version: '', where: '' }).label, 'Gemini 3.8 Flash (High)');
});

test('新装识别：桌面版自带的 Claude Code 排在终端的前面（同一个账号、同一个模型只留它，名字带版本）；同意用 MiMo 的密钥后，单独占着的 MiMo 桌面版记到它名下', () => {
  const PATH = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin';
  try {
    writeJson(home('auto.json'), { order: [] });
    writeJson(home('agents.json'), { agents: [] });
    const h = (id: string, model: string) => ({ id, label: id, vendor: '', version: '1', where: '', login: { state: 'ok' as const, detail: '' }, model: { model, label: model }, workLevels: ['safe' as const], canReview: true, tested: 'yes' as const, loginHint: '' });
    const mimo = { id: 'mimocode:xiaomi', label: 'MiMo', format: 'openai' as const, baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', keyFrom: 'mimocode', needsConsent: true, models: ['mimo-v2.6-pro'], model: 'mimo-v2.6-pro', state: 'ok' as const, detail: '', source: 'mimocode' as const };
    const report = { at: '', harnesses: [h('claude', 'opus'), h('claude-official', 'claude-opus-5-5')], providers: [mimo], apps: [{ name: 'Claude', hint: '' }, { name: 'Xiaomi MiMo', hint: '' }], unknownKeys: [] };

    detect.syncRegistry(report);
    let reg = registry.loadRegistry();
    assert.deepEqual(
      reg.agents.map((a) => a.name),
      ['claude-official', 'mimo'],
      '终端里的 Claude Code 是同一个账号、同一个模型，不再加一位；MiMo 的密钥还没同意，桌面版先单独一位'
    );
    assert.equal(reg.agents[0].app, 'open -a Claude {{dir}}');

    detect.enableProvider(report, mimo.id);
    reg = registry.loadRegistry();
    assert.deepEqual(
      reg.agents.map((a) => [a.name, a.app ?? '']),
      [
        ['claude-official', 'open -a Claude {{dir}}'],
        ['mimo-api', 'open -a "Xiaomi MiMo" {{dir}}'],
      ],
      '同意之后桌面版记在接口名下，不再单独一位'
    );
  } finally {
    process.env.PATH = PATH;
  }
});

test('运行设置 auto.json 写坏了：直接报出来，不悄悄按默认的派活；给人看的地方先按默认显示并带上原因；存设置时先留一份 .broken；名单先不去重', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const autoS = require('../src/core/auto-settings') as typeof import('../src/core/auto-settings');
  fs.rmSync(home('auto.json'), { force: true });
  assert.deepEqual(autoS.loadAutoSettings(), autoS.defaultAutoSettings(), '还没有这个文件：用默认');
  const broken = '{ "order": ["codex"], "finalReview": false, }';
  fs.writeFileSync(home('auto.json'), broken);
  // 以前这里悄悄返回默认设置：派活顺序没了、终审又开了，你还不知道
  assert.throws(() => autoS.loadAutoSettings(), (e: { code?: string; message: string }) => e.code === 'bad-settings' && /auto\.json 不是完整的 JSON/.test(e.message));
  const safe = autoS.autoSettingsSafe();
  assert.equal(safe.settings.finalReview, true);
  assert.match(safe.error ?? '', /auto\.json 不是完整的 JSON.*恢复默认/);
  assert.deepEqual(detect.tidyRegistry(null), [], '派活顺序读不出来：名单先不并');
  assert.equal(autoS.saveAutoSettings({ ...safe.settings, maxStints: 5 }).maxStints, 5);
  assert.equal(fs.readFileSync(home('auto.json.broken'), 'utf8'), broken, '坏的那份留着');
  assert.equal(autoS.autoSettingsSafe().error, undefined);
  fs.rmSync(home('auto.json'), { force: true });
});
