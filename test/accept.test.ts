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
 * 「是不是真做完了」这一类判断的回归测试（2026-09-25 审查找出的问题，每一条都是当时的反例）：
 * 复核结论怎么读、复核过没过、验收、快照读不出来、配置文件坏了、退回时的任务清单、内置小代理的路径、网页切换项目。
 */

// 这个文件里的测试不碰你真实的家目录（会话记录、接力台的数据）。
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-accept-home-')));
process.env.HOME = HOME;
process.env.RELAY_HOME = path.join(HOME, '.relay');
process.env.RELAY_SCAN_APPS = 'off';
process.env.RELAY_LOGIN_PATH = 'off';

/* eslint-disable @typescript-eslint/no-require-imports */
const { acceptance } = require('../src/core/acceptance') as typeof import('../src/core/acceptance');
const ledger = require('../src/core/ledger') as typeof import('../src/core/ledger');
const notes = require('../src/core/notes') as typeof import('../src/core/notes');
const snap = require('../src/core/snap') as typeof import('../src/core/snap');
const track = require('../src/ops/track') as typeof import('../src/ops/track');
const llm = require('../src/core/llm') as Record<string, unknown>;
const agent = require('../src/core/llm-agent') as typeof import('../src/core/llm-agent');
/* eslint-enable @typescript-eslint/no-require-imports */

type Stint = import('../src/core/ledger').Stint;
type LedgerEvent = import('../src/core/ledger').LedgerEvent;
type ReviewMark = import('../src/core/ledger').ReviewMark;

const WEAK = { member: 'claude', label: 'Claude Code · deepseek-flash', tool: 'claude', model: 'deepseek-flash', tier: 'weak' as const };
const STRONG = { member: 'codex', label: 'Codex · gpt-6', tool: 'codex', model: 'gpt-6', tier: 'strong' as const };

function at(min: number): string {
  return new Date(Date.UTC(2026, 8, 25, 1, min)).toISOString();
}

function stint(id: number, over: Partial<Stint> = {}): Stint {
  return { id, kind: 'work', who: WEAK, via: 'relay', startedAt: at(id * 2), endedAt: at(id * 2 + 1), from: `s${id - 1}`, to: `s${id}`, status: 'handed', review: 'needed', facts: { files: 1, added: 1, removed: 0, paths: ['a.txt'] }, ...over };
}

function mark(by: number, verdict: ReviewMark['verdict'], over: Partial<ReviewMark> = {}): ReviewMark {
  return { by, byLabel: 'Codex · gpt-6', file: '.relay/复核/第1棒.md', verdict, at: at(40), ...over };
}

function view(stints: Stint[], extra: LedgerEvent[] = []) {
  return ledger.viewLedger([{ type: 'init', ts: at(0), snap: 's0' }, ...stints.map((s): LedgerEvent => ({ type: 'stint', ts: s.endedAt ?? s.startedAt, stint: s })), ...extra]);
}

function tmpDir(name: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-${name}-`)));
}

const DONE_TASK = notes.parseTask('# 任务\n\n做一个登录页。\n\n## 进度\n\n- [x] 页面\n- [x] 接口\n');

test('复核结论：照模板写的五种都认得；自己组织的话一句一句看——还有问题、没通过、只修了一部分都算有问题，没跑测试、「应该没问题」算证据不足', () => {
  const cases: [string, string][] = [
    ['没问题', 'ok'],
    ['有问题，已修好', 'fixed'],
    ['改坏了，已退回', 'reverted'],
    ['有问题，还没修', 'problem'],
    ['证据不足', 'insufficient'],
    // 2026-09-25 的反例：以前前九个都读反了
    ['未通过', 'problem'],
    ['测试未通过，已记录', 'problem'],
    ['有问题，尚未修好', 'problem'],
    ['没修好', 'problem'],
    ['部分修好，剩下的没修', 'problem'],
    ['已修复 A，但 B 还有问题', 'problem'],
    ['没问题（没跑测试）', 'insufficient'],
    ['通过（有 2 个用例失败，下一棒再修）', 'problem'],
    ['大部分通过，还有 2 个用例失败', 'problem'],
    ['2 个用例失败', 'problem'],
    ['没发现问题，但没有运行测试', 'insufficient'],
    ['应该没问题', 'insufficient'],
    ['原先未通过，修复后重新测试通过', 'fixed'],
    ['测试没通过，现在通过了', 'fixed'],
    ['其他都没问题', 'ok'],
    ['通过，全部完成', 'ok'],
    ['检查没通过', 'problem'],
    ['（没问题 / 有问题，已修好 / 改坏了，已退回 / 有问题，还没修 / 证据不足）', 'unknown'],
    ['', 'unknown'],
  ];
  for (const [text, want] of cases) assert.equal(notes.verdictOf(text), want, `「${text}」`);
  const r = notes.parseReview('# 复核：第 4 棒\n\n- 复核人：Codex\n- 结论：（没问题 / 有问题，已修好）\n\n## 发现的问题和怎么处理的\n\n- ' + '边界条件没处理，重置密码的链接也没有过期时间，都要下一棒接着处理。'.repeat(3) + '\n', '.relay/复核/第4棒.md');
  assert.equal(r.verdict, 'unknown', '没填结论、正文再长也认不出结论');
});

test('复核过没过：只看最近一次算数的复核的结论；复核它的那一棒被退回，复核就作废（撤销退回又算数）', () => {
  const d = new Set<number>();
  assert.equal(ledger.reviewStateOf(stint(1, { reviews: [mark(2, 'problem')] }), d), 'needed', '强模型写「有问题，还没修」：还是待复核');
  assert.equal(ledger.reviewStateOf(stint(1, { reviews: [mark(2, 'insufficient')] }), d), 'needed');
  assert.equal(ledger.reviewStateOf(stint(1, { reviews: [mark(2, 'unknown')] }), d), 'needed');
  assert.equal(ledger.reviewStateOf(stint(1, { reviews: [mark(2, 'ok', { weak: true })] }), d), 'needed', '弱模型写的不算数');
  assert.equal(ledger.reviewStateOf(stint(1, { reviews: [mark(2, 'problem'), mark(3, 'fixed', { file: 'b.md' })] }), d), 'done', '后来又复核、修好了');
  assert.equal(ledger.reviewStateOf(stint(1, { reviews: [mark(2, 'ok')] }), d), 'done');
  assert.equal(ledger.reviewStateOf(stint(1, { review: 'done' }), d), 'done', '没有复核记录：按账上记的（旧账本）');
  assert.equal(ledger.reviewStateOf(stint(1, { review: 'skip', reviews: [mark(2, 'problem')] }), d), 'skip', '你标了不用复核就不用');
  assert.equal(ledger.reviewStateOf(stint(2, { kind: 'final', review: 'needed' }), d), 'skip', '终审自己不用复核');
  // 第 2 棒复核了第 1 棒（没问题），后来退回到第 2 棒之前：第 1 棒回到待复核
  const s1 = stint(1, { review: 'done', reviews: [mark(2, 'ok')] });
  const s2 = stint(2, { kind: 'review', review: 'skip', targets: [1] });
  const rb: LedgerEvent = { type: 'rollback', ts: at(50), to: 's1', label: '第 2 棒之前', safety: 'x', after: 'y', dropped: [2] };
  assert.equal(view([s1, s2]).stints[0].review, 'done');
  assert.equal(view([s1, s2], [rb]).stints[0].review, 'needed', '复核它的那一棒被退回了');
  assert.equal(view([s1, s2], [rb, { type: 'rollback', ts: at(51), to: 'x', label: '退回之前', safety: 'z', after: 'x', dropped: [], restored: [2] }]).stints[0].review, 'done', '撤销退回，复核又算数');
});

test('看复核文件：强模型写「有问题，还没修」「未通过」「已修复 A 但 B 还有问题」、没填结论，都不算复核过；写「没问题」才算', () => {
  const root = tmpDir('apply');
  const ev: LedgerEvent[] = [{ type: 'init', ts: at(0), snap: 's0' }];
  for (const id of [1, 2, 3, 4, 5]) ev.push({ type: 'stint', ts: at(id), stint: stint(id) });
  const reviewer = stint(6, { kind: 'review', who: STRONG, status: 'working', review: 'skip', targets: [1, 2, 3, 4, 5] });
  ev.push({ type: 'stint', ts: at(20), stint: reviewer });
  fs.mkdirSync(path.join(root, '.relay', '复核'), { recursive: true });
  fs.writeFileSync(path.join(root, '.relay', 'journal.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const write = (id: number, v: string, body: string) => fs.writeFileSync(path.join(root, `.relay/复核/第${id}棒.md`), `# 复核：第 ${id} 棒\n\n- 复核人：Codex · gpt-6\n${v}\n\n## 发现的问题和怎么处理的\n\n- ${body}\n`);
  write(1, '- 结论：有问题，还没修', '登录接口没校验密码长度。');
  write(2, '- 结论：未通过', '单元测试 3 项失败。');
  write(3, '- 结论：已修复 A，但 B 还有问题', 'B 的并发写还会丢数据。');
  write(4, '- 结论：（没问题 / 有问题，已修好 / 改坏了，已退回 / 有问题，还没修）', '逐个文件看过了，登录流程里有两处边界条件没处理，重置密码的链接也没有过期时间，这些都要下一棒接着处理，现在还不能算完成。'.repeat(2));
  write(5, '- 结论：没问题', '看过了，测试通过。');
  const members = [{ name: 'codex', label: 'Codex', harness: 'codex', model: 'gpt-6', tier: 'strong' as const, tierSet: false, kind: 'harness' as const, canWork: true, canTalk: true, agent: { name: 'codex', tier: 'strong' as const } }];
  track.applyReviews(root, reviewer, members);
  const v = ledger.loadLedger(root);
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((id) => {
      const s = v.stints.find((x) => x.id === id)!;
      return [id, s.review, s.reviews?.at(-1)?.verdict];
    }),
    [
      [1, 'needed', 'problem'],
      [2, 'needed', 'problem'],
      [3, 'needed', 'problem'],
      [4, 'needed', 'unknown'],
      [5, 'done', 'ok'],
    ]
  );
  assert.deepEqual(
    ledger.pendingReviews(v).map((x) => x.id),
    [1, 2, 3, 4]
  );
  // 账上存下来的也要对（不只靠读账本时再算一遍）：每一棒最后一条记录。
  const saved = new Map<number, Stint>();
  for (const line of fs.readFileSync(path.join(root, '.relay', 'journal.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    const e = JSON.parse(line) as LedgerEvent;
    if (e.type === 'stint') saved.set(e.stint.id, e.stint);
  }
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((id) => saved.get(id)!.review),
    ['needed', 'needed', 'needed', 'needed', 'done']
  );
});

test('派活的终审一起复核：一份结论记到并进来的每一棒；终审开工后又单独给某一棒写了复核的，以那一份为准', () => {
  const root = tmpDir('merged');
  const final = stint(4, { kind: 'final', who: STRONG, status: 'working', review: 'skip', startedAt: at(20), endedAt: undefined, targets: [1, 2, 3], reviewFile: '.relay/复核/终审-第4棒-0925-0920.md' });
  const ev: LedgerEvent[] = [{ type: 'init', ts: at(0), snap: 's0' }, ...[1, 2, 3].map((id): LedgerEvent => ({ type: 'stint', ts: at(id), stint: stint(id) })), { type: 'stint', ts: at(20), stint: final }];
  fs.mkdirSync(path.join(root, '.relay', '复核'), { recursive: true });
  fs.writeFileSync(path.join(root, '.relay', 'journal.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const write = (rel: string, verdict: string) => fs.writeFileSync(path.join(root, rel), `# 复核\n\n- 复核人：Codex · gpt-6\n- 结论：${verdict}\n`);
  write('.relay/复核/第3棒.md', '有问题，还没修');
  fs.utimesSync(path.join(root, '.relay/复核/第3棒.md'), new Date(at(10)), new Date(at(10)));
  write('.relay/复核/第2棒.md', '没问题');
  write(final.reviewFile!, '有问题，已修好');
  const members = [{ name: 'codex', label: 'Codex', harness: 'codex', model: 'gpt-6', tier: 'strong' as const, tierSet: false, kind: 'harness' as const, canWork: true, canTalk: true, agent: { name: 'codex', tier: 'strong' as const } }];
  track.applyReviews(root, final, members);
  const v = ledger.loadLedger(root);
  assert.deepEqual(
    [1, 2, 3].map((id) => {
      const s = v.stints.find((x) => x.id === id)!;
      return [id, s.review, s.reviews?.at(-1)?.file, s.reviews?.at(-1)?.verdict];
    }),
    [
      [1, 'done', final.reviewFile, 'fixed'],
      [2, 'done', '.relay/复核/第2棒.md', 'ok'],
      [3, 'done', final.reviewFile, 'fixed'],
    ],
    '第 3 棒那份是终审开工前写的：终审的结论更新'
  );
});

test('验收：清单打勾不等于做完——开着终审却没终审、终审是弱模型、终审结论有问题、终审之后又改了文件、检查没过或没跑，都不算通过', () => {
  const base = { task: DONE_TASK, gateCommand: '', finalRequired: true };
  const work = stint(1, { who: STRONG, review: 'skip' });
  const good = stint(2, { kind: 'final', who: STRONG, review: 'skip', verdict: 'ok', facts: { files: 0, added: 0, removed: 0, paths: [] } });
  // 甲：一次终审都没做（以前强模型都在等额度、又不等时会直接说「完成」）
  let a = acceptance({ ...base, ledger: view([work]) });
  assert.equal(a.state, 'blocked');
  assert.match(a.headline, /还没终审/);
  // 乙：终审实际跑的是弱模型
  a = acceptance({ ...base, ledger: view([work, { ...good, who: WEAK }]) });
  assert.equal(a.state, 'blocked');
  assert.match(a.final.text, /弱模型/);
  // 丙：终审结论是「有问题，还没修」
  a = acceptance({ ...base, ledger: view([work, { ...good, verdict: 'problem' }]) });
  assert.equal(a.state, 'blocked');
  assert.match(a.final.text, /有问题，还没修/);
  // 终审没留下结论
  a = acceptance({ ...base, ledger: view([work, { ...good, verdict: undefined }]) });
  assert.equal(a.state, 'blocked');
  assert.match(a.final.text, /终审没留下结论/);
  // 终审出错
  a = acceptance({ ...base, ledger: view([work, { ...good, status: 'failed', verdict: undefined }]) });
  assert.match(a.final.text, /^终审出错（GPT-6）$/);
  // 终审之后又有人改了文件（复核棒改的也算）
  a = acceptance({ ...base, ledger: view([work, good, stint(3, { kind: 'review', who: STRONG, review: 'skip' })]) });
  assert.match(a.final.text, /^终审之后文件又改过$/);
  // 旧终审通过、新终审否决：以新的为准（弱模型的、没交接成功的终审不算否决）
  const again = stint(3, { kind: 'final', who: STRONG, review: 'skip', verdict: 'problem', facts: { files: 0, added: 0, removed: 0, paths: [] } });
  a = acceptance({ ...base, ledger: view([work, good, again]) });
  assert.equal(a.state, 'blocked');
  assert.equal(a.final.stint, 3);
  assert.match(a.final.text, /有问题，还没修/);
  assert.equal(acceptance({ ...base, ledger: view([work, good, { ...again, who: WEAK }]) }).state, 'accepted');
  assert.equal(acceptance({ ...base, ledger: view([work, good, { ...again, status: 'failed', verdict: undefined }]) }).state, 'accepted');
  // 终审之后任务改过（加了一步、改了要求）：它审的不是现在的任务；没记版本的旧终审不比
  const ver = notes.taskVersion(DONE_TASK);
  assert.equal(acceptance({ ...base, ledger: view([work, { ...good, taskVer: ver }]) }).state, 'accepted');
  a = acceptance({ ...base, ledger: view([work, { ...good, taskVer: 'old-version' }]) });
  assert.equal(a.state, 'blocked');
  assert.match(a.final.text, /^终审之后任务改过$/);
  assert.equal(notes.taskVersion(notes.parseTask(DONE_TASK.raw.replace(/\n/g, '\n\n'))), ver, '只多了空行：还是同一版');
  // 都对：通过
  a = acceptance({ ...base, ledger: view([work, good]) });
  assert.equal(a.state, 'accepted');
  assert.match(a.headline, /验收通过：清单 2\/2 全部打勾，GPT-6 终审过了/);
  // 没开终审：强模型干完就行
  assert.equal(acceptance({ ...base, finalRequired: false, ledger: view([work]) }).state, 'accepted');
  // 弱模型的活没复核、复核结论有问题
  a = acceptance({ ...base, finalRequired: false, ledger: view([stint(1)]) });
  assert.equal(a.state, 'blocked');
  assert.deepEqual(a.pending, [1]);
  a = acceptance({ ...base, finalRequired: false, ledger: view([stint(1, { reviews: [mark(2, 'problem')] })]) });
  assert.match(a.headline, /^验收没过：第 1 棒复核结论「有问题，还没修」/);
  // 检查：没跑、最后一次改动之后没跑、没过、没跑成
  const g = { ...base, finalRequired: false, gateCommand: 'npm test' };
  assert.match(acceptance({ ...g, ledger: view([work]) }).gate.text, /还没跑过检查/);
  assert.equal(acceptance({ ...g, ledger: view([{ ...work, gate: { status: 'pass', command: 'npm test' } }, stint(2, { who: STRONG, review: 'skip' })]) }).gate.status, 'stale');
  assert.equal(acceptance({ ...g, ledger: view([{ ...work, gate: { status: 'fail', command: 'npm test' } }]) }).state, 'blocked');
  assert.equal(acceptance({ ...g, ledger: view([{ ...work, gate: { status: 'error', command: '', detail: '配置文件坏了' } }]) }).gate.status, 'error');
  assert.equal(acceptance({ ...g, ledger: view([{ ...work, gate: { status: 'pass', command: 'npm test' } }]) }).state, 'accepted');
  // 检查命令改过：按旧命令跑过的通过不算
  a = acceptance({ ...g, gateCommand: 'npm run lint && npm test', ledger: view([{ ...work, gate: { status: 'pass', command: 'npm test' } }]) });
  assert.equal(a.state, 'blocked');
  assert.equal(a.gate.status, 'stale');
  assert.match(a.gate.text, /检查命令改过/);
  // 证据读不到：没法判断，不能算通过
  a = acceptance({ ...base, finalRequired: false, configError: '.relay/config.json 不是合法的 JSON', ledger: view([work]) });
  assert.equal(a.state, 'unknown');
  a = acceptance({ ...base, finalRequired: false, ledger: view([{ ...work, facts: undefined, factsError: '读改动失败：fatal: bad object' }]) });
  assert.equal(a.state, 'unknown');
  // 清单没打完：还在做
  assert.equal(acceptance({ ...base, task: notes.parseTask('# 任务\n\n做\n\n## 进度\n\n- [x] 一\n- [ ] 二\n'), ledger: view([work]) }).state, 'working');
});

test('旧版本没把终审结论记进账本：按时间找回它写的结论文件补上；时间对不上、找到好几份都不乱补', () => {
  const root = tmpDir('legacy-final');
  fs.writeFileSync(path.join(root, 'a.txt'), '1\n');
  const sha = snap.takeSnapshot(root, 't').sha;
  const t0 = Date.now() - 3600_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const facts0 = { files: 0, added: 0, removed: 0, paths: [] };
  const work = stint(1, { who: STRONG, review: 'skip', from: sha, to: sha, startedAt: iso(t0), endedAt: iso(t0 + 60_000) });
  const fin = stint(2, { kind: 'final', who: STRONG, review: 'skip', from: sha, to: sha, startedAt: iso(t0 + 120_000), endedAt: iso(t0 + 300_000), facts: facts0 });
  const old = stint(3, { kind: 'final', who: STRONG, review: 'skip', from: sha, to: sha, startedAt: iso(t0 + 900_000), endedAt: iso(t0 + 960_000), facts: facts0 });
  const ev: LedgerEvent[] = [{ type: 'init', ts: iso(t0 - 1000), snap: sha }, ...[work, fin, old].map((x): LedgerEvent => ({ type: 'stint', ts: x.endedAt!, stint: x }))];
  fs.writeFileSync(path.join(root, '.relay', 'journal.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.mkdirSync(path.join(root, '.relay', '复核'), { recursive: true });
  const file = path.join(root, '.relay', '复核', '终审-0925-0842.md');
  fs.writeFileSync(file, '# 复核：终审\n\n- 复核人：Codex · gpt-6\n- 结论：通过，全部完成\n');
  fs.utimesSync(file, new Date(t0 + 200_000), new Date(t0 + 200_000));
  track.track(root, { snapshot: false });
  const v = ledger.loadLedger(root);
  const f2 = v.stints.find((x) => x.id === 2)!;
  assert.equal(f2.verdict, 'ok');
  assert.equal(f2.reviewFile, '.relay/复核/终审-0925-0842.md');
  assert.equal(v.stints.find((x) => x.id === 3)!.verdict, undefined, '第 3 棒那段时间没有结论文件：不乱补');
});

test('快照读不出来（快照找不到、仓库坏了）就报错，不能当成没改动；弱模型的这一棒按要复核算', () => {
  const root = tmpDir('snaperr');
  fs.writeFileSync(path.join(root, 'a.txt'), '1\n');
  const sha = snap.takeSnapshot(root, 't').sha;
  assert.throws(() => snap.snapChanges(root, 'deadbeef', sha), (e: { code?: string }) => e.code === 'snap');
  assert.throws(() => snap.snapDiff(root, 'deadbeef', sha), (e: { code?: string }) => e.code === 'snap');
  assert.throws(() => snap.snapFile(root, 'deadbeef', 'a.txt'), (e: { code?: string }) => e.code === 'snap');
  assert.equal(snap.snapFile(root, sha, 'nope.txt'), null, '快照里真没有这个文件才是 null');
  assert.equal(snap.snapFile(root, sha, 'a.txt'), '1\n');
  fs.writeFileSync(path.join(root, '.relay', 'journal.jsonl'), JSON.stringify({ type: 'init', ts: at(0), snap: sha }) + '\n');
  const out = track.closeStint(root, { ...stint(1), from: 'deadbeef', to: undefined, facts: undefined, status: 'working' }, { status: 'handed', to: sha });
  assert.equal(out.review, 'needed', '以前会因为「改了 0 个文件」直接跳过复核');
  assert.equal(out.facts, undefined);
  assert.match(out.factsError ?? '', /读改动失败/);
  assert.match(out.note ?? '', /读不到这一棒的改动/);
  assert.match(fs.readFileSync(path.join(root, '.relay/复核/第1棒.diff'), 'utf8'), /读不到改动/);
});

test('配置文件坏了：直接报出来，不当成「没配检查、没有不许改的文件」；检查记成「没跑成」', async () => {
  const root = tmpDir('cfg');
  fs.mkdirSync(path.join(root, '.relay'));
  assert.deepEqual(track.projectConfig(root), { gate: { command: '' }, protectedPaths: [] }, '还没有配置文件：用默认');
  fs.writeFileSync(path.join(root, '.relay', 'config.json'), '{\n  "gate": { "command": "npm test" },\n  "protectedPaths": ["src/secret.ts"],\n}\n');
  assert.throws(() => track.projectConfig(root), (e: { code?: string }) => e.code === 'bad-config');
  const safe = track.projectConfigSafe(root);
  assert.match(safe.error ?? '', /不是合法的 JSON/);
  fs.writeFileSync(path.join(root, '.relay', 'journal.jsonl'), [JSON.stringify({ type: 'init', ts: at(0), snap: 's0' }), JSON.stringify({ type: 'stint', ts: at(1), stint: stint(1) })].join('\n') + '\n');
  await track.gateStint(root, 1);
  const g = ledger.loadLedger(root).stints[0].gate;
  assert.equal(g?.status, 'error');
  assert.match(g?.detail ?? '', /配置文件坏了/);
});

test('退回时的任务清单：按那时的清单改回打勾，那时还没有的步骤取消打勾；别的字、换行格式都不动', () => {
  const root = tmpDir('taskback');
  fs.mkdirSync(path.join(root, '.relay'));
  const file = path.join(root, '.relay', '任务.md');
  fs.writeFileSync(file, '# 任务\n\n做登录\n\n## 进度\n\n- [x] 页面\n- [ ] 接口\n- [ ] 测试\n');
  const id = notes.saveTaskCopy(root)!;
  assert.ok(id);
  assert.equal(notes.saveTaskCopy(root), id, '内容一样只存一份');
  fs.writeFileSync(file, '# 任务\r\n\r\n做登录（改过标题）\r\n\r\n## 进度\r\n\r\n- [x] 页面\r\n- [x] 接口\r\n- [ ] 测试\r\n- [x] 文档\r\n');
  const r = notes.restoreTaskChecks(root, notes.readTaskCopy(root, id)!);
  assert.deepEqual(r, { unchecked: ['接口', '文档'], checked: [] });
  const now = fs.readFileSync(file, 'utf8');
  assert.equal(now, '# 任务\r\n\r\n做登录（改过标题）\r\n\r\n## 进度\r\n\r\n- [x] 页面\r\n- [ ] 接口\r\n- [ ] 测试\r\n- [ ] 文档\r\n');
  assert.equal(notes.readTaskCopy(root, '../../etc/passwd'), null, '编号不对不读');
});

test('内置小代理的路径：链接指到项目外面、写链接、大小写换个写法（.GIT、.Relay、SRC）都拦住；以两个点开头的普通文件名可以写', async () => {
  const root = tmpDir('paths');
  const outside = tmpDir('outside');
  fs.writeFileSync(path.join(outside, 'secret.txt'), '外面的秘密\n');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n');
  fs.mkdirSync(path.join(root, '.relay', '交接'), { recursive: true });
  fs.writeFileSync(path.join(root, '.relay', 'journal.jsonl'), '');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'secret.ts'), 'export {};\n');
  fs.symlinkSync(outside, path.join(root, 'link-out'));
  fs.writeFileSync(path.join(root, 'real.txt'), '真的\n');
  fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'link-file'));
  const tries: [string, string, boolean][] = [
    ['write_file', 'link-out/new.txt', false],
    ['read_file', 'link-out/secret.txt', false],
    ['write_file', 'link-file', false],
    ['write_file', '.git/config', false],
    ['write_file', '.GIT/config', false],
    ['write_file', '.relay/journal.jsonl', false],
    ['write_file', '.Relay/journal.jsonl', false],
    ['write_file', 'src/secret.ts', false],
    ['write_file', 'SRC/secret.ts', false],
    ['write_file', 'src/Secret.ts', false],
    ['write_file', '..notes.md', true],
    ['write_file', 'ok/new.txt', true],
    ['write_file', '.relay/交接/第1棒.md', true],
  ];
  const results: string[] = [];
  class FakeChat {
    used = { input: 0, output: 0 };
    n = 0;
    user(): void {}
    size(): number {
      return 0;
    }
    prune(): number {
      return 0;
    }
    results(r: { content: string }[]): void {
      results.push(...r.map((x) => x.content));
    }
    async next(): Promise<{ text: string; calls: { id: string; name: string; args: Record<string, unknown> }[] }> {
      this.n++;
      if (this.n === 1) return { text: '', calls: tries.map(([name, p], i) => ({ id: `c${i}`, name, args: { path: p, content: 'x' } })) };
      return { text: '', calls: [{ id: 'f', name: 'finish', args: { summary: '好了' } }] };
    }
  }
  const real = llm.ToolChat;
  llm.ToolChat = FakeChat;
  try {
    await agent.runLlmAgent({ spec: { baseUrl: 'http://x', model: 'm', apiKeyEnv: 'X' } as never, cwd: root, brief: '试', level: 'safe', gateCommand: '', protectedPaths: ['src/secret.ts'], log: () => undefined, shouldStop: () => false, deadline: Date.now() + 60_000 });
  } finally {
    llm.ToolChat = real;
  }
  tries.forEach(([, p, ok], i) => assert.equal(!results[i].startsWith('出错'), ok, `${p} → ${results[i]}`));
  assert.ok(!fs.existsSync(path.join(outside, 'new.txt')), '没写到项目外面');
  assert.equal(fs.readFileSync(path.join(root, 'real.txt'), 'utf8'), '真的\n', '没通过链接改到别的文件');
  assert.equal(fs.readFileSync(path.join(root, '.git', 'config'), 'utf8'), '[core]\n');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'secret.ts'), 'utf8'), 'export {};\n');
  assert.equal(fs.readFileSync(path.join(root, '.relay', 'journal.jsonl'), 'utf8'), '');
});

test('内置代理不读、不搜放密钥的文件（.env、私钥）；模板照常；读给模型的密钥抹掉，抹掉的不许原样写回', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-agent-secret-')));
  const key = 'sk-' + 'abcdefghijklmnopqrstuvwx';
  fs.writeFileSync(path.join(root, '.env'), `MARK_X=${key}\n`);
  fs.writeFileSync(path.join(root, '.env.example'), 'MARK_X=\n');
  fs.writeFileSync(path.join(root, 'server.pem'), 'MARK_X\n');
  fs.writeFileSync(path.join(root, 'config.ts'), `// MARK_X\nexport const k = '${key}';\n`);
  const calls = [
    { name: 'read_file', args: { path: '.env' } },
    { name: 'read_file', args: { path: 'server.pem' } },
    { name: 'read_file', args: { path: '.env.example' } },
    { name: 'search', args: { pattern: 'MARK_X' } },
    { name: 'read_file', args: { path: 'config.ts' } },
    { name: 'write_file', args: { path: 'config.ts', content: "export const k = '[REDACTED]';\n" } },
  ];
  const results: string[] = [];
  class FakeChat {
    used = { input: 0, output: 0 };
    n = 0;
    user(): void {}
    size(): number {
      return 0;
    }
    prune(): number {
      return 0;
    }
    results(r: { content: string }[]): void {
      results.push(...r.map((x) => x.content));
    }
    async next(): Promise<{ text: string; calls: { id: string; name: string; args: Record<string, unknown> }[] }> {
      this.n++;
      if (this.n === 1) return { text: '', calls: calls.map((c, i) => ({ id: `c${i}`, ...c })) };
      return { text: '', calls: [{ id: 'f', name: 'finish', args: { summary: '好了' } }] };
    }
  }
  const real = llm.ToolChat;
  llm.ToolChat = FakeChat;
  try {
    await agent.runLlmAgent({ spec: { baseUrl: 'http://x', model: 'm', apiKeyEnv: 'X' } as never, cwd: root, brief: '试', level: 'safe', gateCommand: '', protectedPaths: [], log: () => undefined, shouldStop: () => false, deadline: Date.now() + 60_000 });
  } finally {
    llm.ToolChat = real;
  }
  assert.match(results[0], /^出错：.*多半放着密钥/);
  assert.match(results[1], /^出错：.*多半放着密钥/);
  assert.match(results[2], /MARK_X=/);
  assert.match(results[3], /config\.ts/);
  assert.doesNotMatch(results[3], /\.env|server\.pem/, '搜索跳过放密钥的文件');
  assert.ok(!results.join('\n').includes(key), '密钥没交给模型');
  assert.match(results[4], /\[REDACTED\]/);
  assert.match(results[5], /^出错：.*REDACTED/);
  assert.ok(fs.readFileSync(path.join(root, 'config.ts'), 'utf8').includes(key), '原文没被 [REDACTED] 冲掉');
});

test('网页切换项目：A 的请求晚回来也不会显示在 B 里（状态、对话、文件树、棒的详情、打开的文件都一样）；点棒上的按钮发往当前项目', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'app.js'), 'utf8').split('\n');
  const fn = (name: string) => {
    const i = src.findIndex((l) => new RegExp(`^(async )?function ${name}\\(`).test(l));
    assert.ok(i >= 0, `app.js 里没有 ${name}`);
    let j = i;
    while (src[j] !== '}') j++;
    return src.slice(i, j + 1).join('\n');
  };
  const code = ['q', 'ticket', 'stale', 'fail', 'setOffline', 'refresh', 'loadTalk', 'loadTree', 'loadDetail', 'loadDoc', 'switchProject', 'tabKey'].map(fn).join('\n\n');
  const out: string[] = [];
  const script = `
let treeKey = '', stintsKey = '', streamThread = null, docSig = '', barSig = '', heroSig = '', tabsSig = '';
const detailLoading = new Set();
const S = { dir: 'A', st: null, gen: 0, seq: {}, talk: { rows: [], votes: [], status: { speaking: [], queue: [] } }, tree: null, treeRev: 0, thread: null, draft: false, fold: false, open: new Set(), detail: new Map(), tabs: [], tab: 0, docs: new Map(), ask: null, files: [], treeOpen: new Set(), treeFilter: '', onlyChanged: false, treeSel: '', offline: false };
const node = () => ({ replaceChildren() {}, querySelector: () => null, hidden: true });
const CE = { offline: node(), stream: node(), bar: node(), hero: node() };
const store = { json: () => [] };
const history = { replaceState() {} };
const closeDrawers = () => {}, restoreDraft = () => {}, scrollBottom = () => {}, renderAll = () => {}, renderCenter = () => {}, renderRight = () => {}, toast = () => {}, fillDetail = () => {};
const stintById = () => null;
async function api(url) {
  const u = new URL(url, 'http://x');
  const dir = u.searchParams.get('dir');
  await new Promise((r) => setTimeout(r, dir === 'A' ? 60 : 5));
  const p = u.pathname;
  if (p === '/api/state') return { project: { root: dir, stints: [{ id: 3, summary: dir + ' 的第 3 棒' }] } };
  if (p === '/api/talk') return { rows: [{ from: dir }], votes: [], status: { speaking: [], queue: [] } };
  if (p === '/api/tree') return { files: [dir + '.txt'], truncated: false };
  if (p === '/api/stint') return { id: 3, project: dir };
  if (p === '/api/file') return { text: dir + ' 的 README' };
  throw new Error(p);
}
${code}
(async () => {
  refresh(); loadTalk(); loadTree(); loadDetail(3); loadDoc({ type: 'file', path: 'README.md' });
  switchProject('B');
  await new Promise((r) => setTimeout(r, 150));
  out(JSON.stringify([S.dir, S.st && S.st.project.root, S.talk.rows[0] && S.talk.rows[0].from, S.tree && S.tree.files[0], S.detail.get(3) && S.detail.get(3).project, (S.docs.get(tabKey({ type: 'file', path: 'README.md' })) || {}).data]));
  await loadDetail(3);
  await loadDoc({ type: 'file', path: 'README.md' });
  out(JSON.stringify([S.detail.get(3).project, S.docs.get(tabKey({ type: 'file', path: 'README.md' })).data.text, q('/api/stint?id=3')]));
  done();
})();`;
  await new Promise<void>((resolve, reject) => {
    try {
      runWeb(script, { setTimeout, URL, URLSearchParams, encodeURIComponent, TypeError, out: (x: string) => out.push(x), done: resolve });
    } catch (e) {
      reject(e);
    }
  });
  assert.deepEqual(JSON.parse(out[0]), ['B', 'B', 'B', 'B.txt', null, null], '以前这里全是 A 的：状态、对话、文件树、第 3 棒详情、README');
  assert.deepEqual(JSON.parse(out[1]), ['B', 'B 的 README', '/api/stint?id=3&dir=B']);
});
