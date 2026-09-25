import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setOrder, withFakeDesktopClaude, withFakeDsh, withFakes } from './fakes';
import { sandbox, type Sandbox } from './helpers';

/**
 * 端到端（假工具）：全自动不会把「没验收」说成「完成」、换人前先确认外部工具停了、一个项目只能有一个调度、
 * 退回时任务清单跟着退、DeepSeek Harness 和桌面版自带的 Claude Code 能被调度。
 */

function prepared(name: string, extra: NodeJS.ProcessEnv = {}, setup?: (s: Sandbox) => void): Sandbox {
  const s = sandbox(name);
  withFakes(s, extra);
  setup?.(s);
  s.relay(['detect', '--offline']);
  return s;
}

function handoff(s: Sandbox, file: string, who: string, state: string, did: string): void {
  s.write(`.relay/交接/${file}`, `# 交接：${who}\n\n- 状态：${state}\n\n## 做了什么\n\n- ${did}\n`);
}

function fakeLog(s: Sandbox): string {
  const p = path.join(s.base, 'fake.log');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

test('全自动：强模型复核写的是「有问题，还没修」，不算复核过；复核两次还没过就停下，说清楚结论，不说「完成」', () => {
  const s = prepared('review-problem', { FAKE_REVIEW_VERDICT: '有问题，还没修' });
  setOrder(s, ['claude', 'codex']);
  s.relay(['init']);
  s.relay(['task', '做一件事', '--step', '第一件']);
  const out = s.relay(['auto']);
  assert.doesNotMatch(out, /完成：/);
  assert.match(out, /第 1 棒复核结论是「有问题，还没修」/);
  const st = s.stints();
  assert.deepEqual(
    st.map((x) => [x.kind, x.who.member]),
    [
      ['work', 'claude'],
      ['review', 'codex'],
      ['review', 'codex'],
    ]
  );
  assert.equal(st[0].review, 'needed');
  assert.match(s.relay(['status']), /验收：清单都打勾了，验收还没过：第 1 棒复核结论是「有问题，还没修」/);
});

test('全自动：终审写的是「有问题，还没修」，不算终审过；终审两次都没过就停下', () => {
  const s = prepared('final-problem', { FAKE_FINAL_VERDICT: '有问题，还没修' });
  setOrder(s, ['codex']);
  s.relay(['init']);
  s.relay(['task', '做一件事', '--step', '第一件']);
  const out = s.relay(['auto']);
  assert.doesNotMatch(out, /完成：/);
  assert.match(out, /终审两次都没过：终审结论是「有问题，还没修」/);
  const finals = s.stints().filter((x) => x.kind === 'final');
  assert.equal(finals.length, 2);
  assert.equal(finals[0].verdict, 'problem');
  assert.match(finals[0].reviewFile, /^\.relay\/复核\/终审-第2棒-/);
});

test('全自动：开着终审、强模型都在等额度又不等，不会跳过终审直接说完成', () => {
  const s = prepared('final-cooling');
  setOrder(s, ['codex']);
  s.relay(['init']);
  s.relay(['task', '做一件事', '--step', '第一件']);
  s.relay(['go', 'codex']);
  assert.equal(s.stints().length, 1, 'codex（强）干完了唯一的一步');
  fs.writeFileSync(path.join(s.home, '.relay', 'quota.json'), JSON.stringify({ members: { codex: { until: new Date(Date.now() + 3 * 3600_000).toISOString(), note: '额度用完了', at: new Date().toISOString() } } }));
  const out = s.relay(['auto', '--no-wait']);
  assert.doesNotMatch(out, /完成：/);
  assert.match(out, /任务清单都打勾了，但还没终审/);
});

test('换人之前：有 AI 在别的工具里干到一半、刚才还在改文件，就先问你；确认它停了（--force）才换人，账上记下是你确认的', () => {
  const s = prepared('native-active');
  s.relay(['init']);
  s.relay(['task', '做一件事', '--step', '第一件']);
  s.write('half.txt', '写到一半\n');
  handoff(s, '第1棒-0925-1000-claude.md', 'Claude Code · deepseek-v4-flash', '进行中', '写了一半');
  s.relay(['snap']);
  assert.equal(s.stints()[0].status, 'working');
  const out = s.relay(['go', 'codex'], true);
  assert.match(out, /第 1 棒（Claude Code · deepseek-v4-flash）不到一分钟前还在改这个文件夹/);
  assert.equal(s.stints().length, 1, '没换人');
  s.relay(['go', 'codex', '--force']);
  const st = s.stints();
  assert.equal(st[0].status, 'handed');
  assert.equal(st[0].stopConfirmed, true);
  assert.match(st[0].note, /你确认过它已经停下/);
  assert.equal(st[1].who.member, 'codex');
});

test('一个项目同一时间只能有一个调度：锁在别的活着的进程手里就拒绝；那个进程没了，锁就能拿走', async () => {
  const s = prepared('lock');
  s.relay(['init']);
  s.relay(['task', '做一件事', '--step', '第一件']);
  const holder = spawn('sleep', ['30']);
  try {
    await new Promise((r) => setTimeout(r, 100));
    fs.mkdirSync(path.join(s.repo, '.relay', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(s.repo, '.relay', 'runs', 'lock'), JSON.stringify({ pid: holder.pid, token: 'other', at: new Date().toISOString() }));
    const out = s.relay(['go', 'codex'], true);
    assert.match(out, /接力台已经在调度这个项目了/);
    assert.equal(s.stints().length, 0);
  } finally {
    holder.kill('SIGKILL');
  }
  await new Promise((r) => setTimeout(r, 200));
  s.relay(['go', 'codex']);
  assert.equal(s.stints().length, 1);
  assert.ok(!fs.existsSync(path.join(s.repo, '.relay', 'runs', 'lock')), '用完放掉了');
});

test('退回：任务清单跟着退，被退回的那几棒打的勾去掉；撤销退回，勾也回来', () => {
  const s = prepared('rollback-task');
  s.relay(['init']);
  s.relay(['task', '做两件事', '--step', '第一件', '第二件']);
  s.relay(['go', 'codex']);
  s.relay(['go', 'codex']);
  assert.match(s.read('.relay/任务.md'), /- \[x\] 第一件\n- \[x\] 第二件/);
  const out = s.relay(['rollback', '2']);
  assert.match(out, /任务清单里这几步的勾去掉了：第二件/);
  assert.match(s.read('.relay/任务.md'), /- \[x\] 第一件\n- \[ \] 第二件/);
  assert.match(s.read('.relay/接力本.md'), /任务清单里这几步的勾也去掉了，要重新做：第二件/);
  assert.match(s.relay(['status']), /任务：做两件事（1\/2）/);
  s.relay(['rollback', '--undo']);
  assert.match(s.read('.relay/任务.md'), /- \[x\] 第一件\n- \[x\] 第二件/);
});

test('DeepSeek Harness：用它的无界面模式干活，带上桌面版的账号和模型；安全档只能写工作目录；额度用完认得出来', () => {
  const s = prepared('dsh', {}, withFakeDsh);
  const members = s.relay(['workers', 'list']);
  assert.match(members, /DeepSeek Harness/);
  s.relay(['init']);
  s.relay(['task', '做一件事', '--step', '第一件']);
  s.relay(['go', 'deepseek-harness']);
  let st = s.stints();
  assert.equal(st[0].who.member, 'deepseek-harness');
  assert.equal(st[0].who.tier, 'weak', 'deepseek-flash 算弱');
  assert.equal(st[0].review, 'needed');
  assert.equal(st[0].status, 'handed');
  assert.match(s.read('work.txt'), /dsh 干了一步/);
  const log = fakeLog(s);
  assert.match(log, /dsh --profile headless --patch \S+ --json - PERM=workspace-write/);
  const patch = fs.readFileSync(path.join(s.base, 'dsh-patch-seen.yml'), 'utf8');
  assert.match(patch, /provider: deepseek-account/);
  assert.match(patch, /model: deepseek-flash/);
  // 额度用完
  s.env.FAKE_DSH_MODE = 'quota';
  s.relay(['task', '再做一件', '--step', 'x']);
  s.relay(['go', 'deepseek-harness']);
  st = s.stints();
  assert.equal(st.at(-1)!.status, 'quota');
});

test('官方账号的 Claude Code：用 Claude 桌面版自带的新版（终端里的不动），调用时关掉自动更新', () => {
  const s = prepared('desktop-claude', { FAKE_CLAUDE_OFFICIAL: 'pro' }, (x) => withFakeDesktopClaude(x));
  const report = JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'detected.json'), 'utf8')) as { harnesses: { id: string; where: string; version: string; note?: string }[] };
  const off = report.harnesses.find((h) => h.id === 'claude-official')!;
  assert.match(off.where, /claude-desktop\/2\.1\.281\/claude\.app/);
  assert.equal(off.version, '2.1.281');
  assert.match(off.note ?? '', /Claude 桌面版自带的 Claude Code 2\.1\.281.*终端里的 claude 9\.9\.9 没动/);
  s.relay(['init']);
  s.relay(['task', '做一件事', '--step', '第一件']);
  s.relay(['go', 'claude-official']);
  assert.match(fakeLog(s), /desktop-claude DISABLE_AUTOUPDATER=1 --setting-sources project,local -p/);
  const st = s.stints();
  assert.equal(st[0].who.member, 'claude-official');
  assert.equal(st[0].who.tier, 'strong');
});
