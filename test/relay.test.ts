import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mockLlm, setOrder, withFakes } from './fakes';
import { sandbox, type Sandbox } from './helpers';

/**
 * 接力台 2.0 的端到端测试：接入 → 你自己在别的工具里干（接力台记账）→ 接力台调度 → 额度用完换人 →
 * 弱模型的活由强模型复核 → 终审 → 退回。全部用假的 claude（接 DeepSeek，弱）和 codex（gpt-6，强）。
 */

function prepared(name: string, extra: NodeJS.ProcessEnv = {}, opts: { git?: boolean } = {}): Sandbox {
  const s = sandbox(name, opts);
  withFakes(s, extra);
  s.relay(['detect', '--offline']);
  return s;
}

function handoff(s: Sandbox, file: string, who: string, state: string, did: string): void {
  s.write(`.relay/交接/${file}`, `# 交接：${who}\n\n- 状态：${state}\n\n## 做了什么\n\n- ${did}\n\n## 没做完 / 下一步\n\n- 接着做\n`);
}

test('自动识别：Claude Code 接的是 DeepSeek 算弱，Codex 是强；桌面程序不在的不加', () => {
  const s = prepared('detect');
  const reg = JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'agents.json'), 'utf8')) as { agents: { name: string; tier: string; harness?: string }[] };
  assert.deepEqual(
    reg.agents.map((a) => [a.name, a.harness, a.tier]),
    [
      ['claude', 'claude', 'weak'],
      ['codex', 'codex', 'strong'],
    ]
  );
  const out = s.relay(['detect', '--offline']);
  assert.match(out, /工人名单不用改/);
  assert.match(out, /强 Codex（gpt-6）/);
  assert.match(out, /弱 Claude Code（deepseek-v4-flash）/);
});

test('接入：建好 .relay、写规矩、存第一张快照；不需要 git；重复接入不重复', () => {
  const s = sandbox('init', { git: false });
  const out = s.relay(['init', '做一个', '滤镜']);
  assert.match(out, /接入了/);
  for (const f of ['.relay/接力本.md', '.relay/任务.md', '.relay/config.json', '.relay/journal.jsonl', '.relay/.gitignore', '.relay/snapshots/HEAD', 'AGENTS.md', 'CLAUDE.md']) assert.ok(s.exists(f), f);
  assert.ok(!s.exists('.git'), '没有给你建 git');
  assert.match(s.read('.relay/任务.md'), /做一个 滤镜/);
  assert.match(s.read('AGENTS.md'), /开工先读 `\.relay\/接力本\.md`/);
  const brief = s.read('.relay/接力本.md');
  assert.match(brief, /做一个 滤镜/);
  assert.match(brief, /第1棒-月日-时分-你的工具名\.md/);
  assert.equal(s.journal().filter((e) => e.type === 'init').length, 1);
  assert.match(s.relay(['init']), /已经接入过了/);
  assert.equal(s.journal().filter((e) => e.type === 'init').length, 1);
  assert.match(s.relay(['status']), /任务：做一个 滤镜/);
});

test('你自己在别的工具里接着做：接力台认出是谁、弱模型的棒标待复核、强模型写了复核就算复核过', () => {
  const s = prepared('native');
  s.relay(['init', '做滤镜']);
  // DeepSeek（在 Claude Code 里）干了一段，写了交接
  s.write('filter.xmp', '<x/>\n');
  handoff(s, '第1棒-0924-2100-claude.md', 'Claude Code · deepseek-v4-flash', '已交接', '写了 filter.xmp');
  s.relay(['snap']);
  let st = s.stints();
  assert.equal(st.length, 1);
  assert.equal(st[0].who.member, 'claude');
  assert.equal(st[0].who.tier, 'weak');
  assert.equal(st[0].status, 'handed');
  assert.equal(st[0].review, 'needed');
  assert.deepEqual(st[0].facts.paths, ['filter.xmp']);
  assert.match(s.read('.relay/复核/第1棒.diff'), /\+<x\/>/);
  const brief = s.read('.relay/接力本.md');
  assert.match(brief, /## 先复核（1 棒待复核）/);
  assert.match(brief, /第2棒-月日-时分-你的工具名\.md/);

  // Codex（强）来了：先复核、修了一处，再交接
  s.write('filter.xmp', '<x fixed="1"/>\n');
  s.write('.relay/复核/第1棒.md', '# 复核：第 1 棒\n\n- 复核人：Codex · gpt-6\n- 结论：有问题，已修好\n\n## 发现的问题和怎么处理的\n\n- 少了属性，补上了\n');
  handoff(s, '第2棒-0924-2200-codex.md', 'Codex · gpt-6', '已交接', '复核了第 1 棒，修了 filter.xmp');
  s.relay(['snap']);
  st = s.stints();
  assert.equal(st[0].review, 'done');
  assert.equal(st[0].reviews[0].verdict, 'fixed');
  assert.equal(st[1].who.member, 'codex');
  assert.equal(st[1].review, 'skip', '强模型自己交接的不用复核');
  assert.doesNotMatch(s.read('.relay/接力本.md'), /先复核/);
  assert.match(s.relay(['status']), /复核：有问题，已修好/);
});

test('额度用完被打断、没留交接：一段时间没动静后接力台替它记一笔，要复核', () => {
  const s = prepared('cutoff', { RELAY_QUIET_MS: '1' });
  s.relay(['init', '做滤镜']);
  s.write('half.txt', '写到一半\n');
  s.relay(['snap']);
  s.relay(['snap']);
  const st = s.stints();
  assert.equal(st.length, 1);
  assert.equal(st[0].status, 'unfinished');
  assert.equal(st[0].ghost, true);
  assert.equal(st[0].who.tier, 'unknown');
  assert.equal(st[0].review, 'needed');
  assert.match(s.read(st[0].handoff), /接力台代写/);
  assert.match(s.read(st[0].handoff), /half\.txt/);
  assert.match(s.read('.relay/接力本.md'), /它没留交接/);
});

test('接力台调度一棒：弱模型干完标待复核；relay review 派强模型复核', () => {
  const s = prepared('go');
  s.relay(['init']);
  s.relay(['task', '做两件事', '--step', '第一件', '第二件']);
  const out = s.relay(['go', 'claude']);
  assert.match(out, /这一棒做完了/);
  assert.match(out, /等强模型复核/);
  let st = s.stints();
  assert.equal(st.length, 1);
  assert.equal(st[0].via, 'relay');
  assert.equal(st[0].who.member, 'claude');
  assert.equal(st[0].review, 'needed');
  assert.equal(s.read('work.txt'), 'claude 干了一步\n');
  assert.match(s.read('.relay/任务.md'), /- \[x\] 第一件/);
  assert.match(s.read(st[0].handoff), /Claude Code · deepseek-v4-flash/);
  // 真的按无人值守的参数、在项目文件夹里调的
  const log = fs.readFileSync(s.env.FAKE_LOG!, 'utf8');
  assert.match(log, /claude -p --output-format stream-json --verbose --permission-mode acceptEdits --settings/);

  s.relay(['review']);
  st = s.stints();
  assert.equal(st.length, 2);
  assert.equal(st[1].kind, 'review');
  assert.equal(st[1].who.member, 'codex', '复核自动挑强模型');
  assert.equal(st[0].review, 'done');
  assert.match(fs.readFileSync(s.env.FAKE_LOG!, 'utf8'), /codex exec --skip-git-repo-check --color never -C .* -s workspace-write -/);
});

test('全自动：弱模型干一棒 → 强模型复核 → 再干 → 再复核 → 强模型终审 → 完成，全程不用人动手', () => {
  const s = prepared('auto');
  setOrder(s, ['claude', 'codex']);
  s.relay(['init']);
  s.relay(['task', '做两件事', '--step', '第一件', '第二件']);
  const out = s.relay(['auto']);
  assert.match(out, /完成：任务清单 2\/2 全部打勾，Codex · gpt-6 终审过了/);
  const st = s.stints();
  assert.deepEqual(
    st.map((x) => [x.kind, x.who.member]),
    [
      ['work', 'claude'],
      ['review', 'codex'],
      ['work', 'claude'],
      ['review', 'codex'],
      ['final', 'codex'],
    ]
  );
  assert.ok(st.filter((x) => x.kind === 'work').every((x) => x.review === 'done'), '弱模型的每一棒都复核过');
  assert.equal(s.read('work.txt'), 'claude 干了一步\nclaude 干了一步\n');
});

test('全自动：复核的那位实际跑的是弱模型，写的复核不算数；两次之后停下，说清楚是「算弱不算数」', () => {
  const s = prepared('weak-reviewer', { FAKE_CLAUDE_OFFICIAL: 'pro', FAKE_CLAUDE_OFFICIAL_MODEL: 'deepseek-flash' });
  setOrder(s, ['claude', 'claude-official']);
  s.relay(['init']);
  s.relay(['task', '做一件事', '--step', '第一件']);
  const out = s.relay(['auto']);
  assert.match(out, /第 1 棒复核了两次，但写复核的都算弱，结论不算数/);
  const st = s.stints();
  assert.deepEqual(
    st.map((x) => [x.kind, x.who.member, x.who.tier]),
    [
      ['work', 'claude', 'weak'],
      ['review', 'claude-official', 'weak'],
      ['review', 'claude-official', 'weak'],
    ]
  );
  assert.equal(st[0].review, 'needed');
});

test('全自动：终审没做成，不说「终审过了」，停下来说清楚', () => {
  const s = prepared('final-fail', { FAKE_CODEX_MODE: 'final-fail' });
  setOrder(s, ['claude', 'codex']);
  s.relay(['init']);
  s.relay(['task', '做一件事', '--step', '第一件']);
  const out = s.relay(['auto']);
  assert.match(out, /任务清单都打勾了，但终审没做成（Codex · gpt-6 出错了/);
  assert.doesNotMatch(out, /终审过了/);
  assert.deepEqual(
    s.stints().map((x) => [x.kind, x.who.member, x.status]),
    [
      ['work', 'claude', 'handed'],
      ['review', 'codex', 'handed'],
      ['final', 'codex', 'failed'],
    ]
  );
});

test('全自动的终审换一双眼睛：强模型自己干完的活，请另一位强模型终审', () => {
  const s = prepared('final-other', { FAKE_CLAUDE_OFFICIAL: 'pro' });
  setOrder(s, ['codex', 'claude-official', 'claude']);
  s.relay(['init']);
  s.relay(['task', '做一件事', '--step', '第一件']);
  s.relay(['auto']);
  assert.deepEqual(
    s.stints().map((x) => [x.kind, x.who.member]),
    [
      ['work', 'codex'],
      ['final', 'claude-official'],
    ]
  );
});

test('额度用完：记下什么时候恢复，自动换下一位接着做；下次调度跳过它', () => {
  const s = prepared('quota', { FAKE_CLAUDE_MODE: 'quota' });
  setOrder(s, ['claude', 'codex'], { finalReview: false });
  s.relay(['init']);
  s.relay(['task', '做一件事', '--step', '只有一件']);
  const out = s.relay(['auto']);
  assert.match(out, /完成/);
  const st = s.stints();
  assert.equal(st[0].who.member, 'claude');
  assert.equal(st[0].status, 'quota');
  assert.ok(st[0].quotaUntil, '记下了恢复时间');
  assert.equal(new Date(st[0].quotaUntil).getHours(), 15, '认出了「reset at 3pm」');
  assert.equal(st[1].who.member, 'codex');
  const q = JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'quota.json'), 'utf8'));
  assert.ok(q.members.claude.until);
  assert.match(s.relay(['detect', '--offline']), /额度用完/);
  // 再调度一棒：跳过还在等额度的 claude
  s.relay(['task', '再做一件', '--step', 'x']);
  s.relay(['go']);
  assert.equal(s.stints().at(-1)!.who.member, 'codex');
});

test('都没额度了又不等：停下交给你，说清楚原因', () => {
  const s = prepared('noquota', { FAKE_CLAUDE_MODE: 'quota', FAKE_CODEX_MODE: 'quota' });
  s.relay(['init']);
  s.relay(['task', '做一件事', '--step', 'x']);
  const out = s.relay(['auto', '--no-wait']);
  assert.match(out, /没有能干活的 AI 了/);
  assert.deepEqual(
    s.stints().map((x) => [x.who.member, x.status]),
    [
      ['codex', 'quota'],
      ['claude', 'quota'],
    ]
  );
});

test('它没写交接就结束了：用它最后说的话代写一份，要复核', () => {
  const s = prepared('ghost', { FAKE_CODEX_MODE: 'nohandoff' });
  s.relay(['init']);
  s.relay(['task', '做', '--step', 'x']);
  s.relay(['go', 'codex']);
  const st = s.stints()[0];
  assert.equal(st.ghost, true);
  assert.equal(st.review, 'needed', '强模型没留交接也要复核');
  assert.match(s.read(st.handoff), /做完一步了/);
});

test('网络抖一下：原地再试一次接着做完', () => {
  const s = prepared('blip', { FAKE_CODEX_MODE: 'blip-once' });
  s.relay(['init']);
  s.relay(['task', '做', '--step', 'x']);
  s.relay(['go', 'codex']);
  const st = s.stints()[0];
  assert.equal(st.status, 'handed');
  assert.match(s.read(`.relay/runs/${path.basename(st.log)}`), /网络抖了一下/);
});

test('退回：整个文件夹恢复成第 N 棒之前，之后的棒作废；撤销退回又回来', () => {
  const s = prepared('rollback');
  s.relay(['init']);
  s.write('a.txt', '1\n');
  handoff(s, 'x1.md', 'Codex · gpt-6', '已交接', '写了 a');
  s.relay(['snap']);
  s.write('a.txt', '2\n');
  s.write('b/c.txt', '新的\n');
  handoff(s, 'x2.md', 'Claude Code · deepseek-v4-flash', '已交接', '改了 a，加了 c');
  s.relay(['snap']);
  assert.equal(s.stints().length, 2);
  const out = s.relay(['rollback', '2']);
  assert.match(out, /已退回到第 2 棒之前/);
  assert.equal(s.read('a.txt'), '1\n');
  assert.ok(!s.exists('b/c.txt'));
  assert.deepEqual(
    s.stints().map((x) => !!x.rolledBack),
    [false, true]
  );
  const brief = s.read('.relay/接力本.md');
  assert.match(brief, /退回到了「第 2 棒之前」/);
  assert.doesNotMatch(brief, /先复核/, '作废的棒不用复核');
  s.relay(['rollback', '--undo']);
  assert.equal(s.read('a.txt'), '2\n');
  assert.equal(s.read('b/c.txt'), '新的\n');
  assert.deepEqual(
    s.stints().map((x) => !!x.rolledBack),
    [false, false]
  );
});

for (const git of [true, false]) {
  test(`只有接口的模型也能接一棒：内置小代理搜代码、写文件、写交接${git ? '' : '（项目不是 git 仓库）'}`, async () => {
    const s = prepared(git ? 'api' : 'api-plain', { MOCK_KEY: 'k-test' }, { git });
    s.relay(['init']);
    s.relay(['task', '写一条笔记', '--step', '写']);
    const mock = await mockLlm();
    try {
      s.relay(['workers', 'add', 'mock', '--kind', 'api', '--api-base', mock.url, '--api-model', 'mock-coder', '--api-key-env', 'MOCK_KEY']);
      const r = await s.relayAsync(['go', 'mock']);
      assert.equal(r.code, 0, r.out);
      assert.match(mock.toolResults[0], /^README\.md:1:demo$/m, '搜得到项目里的文件');
      assert.doesNotMatch(mock.toolResults[0], /\.relay\//, '不搜 .relay/');
      assert.equal(s.read('notes/llm.txt'), '模型写的\n');
      const st = s.stints()[0];
      assert.equal(st.who.member, 'mock');
      assert.equal(st.who.tier, 'weak');
      assert.equal(st.ghost, undefined, '它自己写了交接');
      assert.match(s.read(st.handoff), /写了 notes\/llm\.txt/);
    } finally {
      mock.close();
    }
  });
}

test('两个 Claude：接了 DeepSeek 的算弱、官方账号的算强；派官方账号时跳过你的设置、不带 ANTHROPIC_*，由它来复核', () => {
  const s = prepared('two-claude', { FAKE_CLAUDE_OFFICIAL: 'pro', ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'shell-token' });
  const reg = JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'agents.json'), 'utf8')) as { agents: { name: string; cmd?: string }[] };
  assert.deepEqual(
    reg.agents.map((a) => a.name),
    ['claude', 'claude-official', 'codex']
  );
  assert.match(reg.agents[1].cmd ?? '', /claude --setting-sources project,local$/, '你自己在终端里开官方账号的命令');
  s.relay(['workers', 'add', 'claude-app', '--kind', 'app', '--cmd', 'open -a Claude {{dir}}', '--label', 'Claude']);
  s.relay(['init']);
  s.relay(['task', '做两步', '--step', '第一步', '第二步']);
  const brief = s.read('.relay/接力本.md');
  assert.match(brief, /- 强：.*Claude Code 官方账号（opus）/);
  assert.match(brief, /- 强：.*Claude（opus）/, '桌面版借官方账号的模型');
  assert.match(brief, /- 弱：.*Claude Code（deepseek-v4-flash）/);

  s.relay(['go', 'claude']);
  assert.equal(s.stints()[0].who.member, 'claude');
  assert.equal(s.stints()[0].who.model, 'deepseek-v4-flash', '用回复里的模型名，不带 init 里的 [1m]');
  assert.equal(s.stints()[0].review, 'needed');
  assert.match(s.relay(['review', 'claude'], true), /复核要强模型来做/);
  // 这台电脑上用过的 Opus：旧会话里是 claude-opus-5-5，最近一个会话是 claude-opus-5。派官方账号时按版本挑最新的。
  const logs = path.join(s.home, '.claude', 'projects', '-desk-');
  fs.mkdirSync(logs, { recursive: true });
  const said = (model: string) => `${JSON.stringify({ type: 'assistant', message: { model, content: [] }, timestamp: new Date().toISOString() })}\n`;
  fs.writeFileSync(path.join(logs, 'a.jsonl'), said('claude-opus-5-5'));
  fs.writeFileSync(path.join(logs, 'b.jsonl'), said('claude-opus-5'));
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(logs, 'a.jsonl'), past, past);
  s.relay(['review', 'claude-official']);
  const [first, second] = s.stints();
  assert.equal(second.who.member, 'claude-official');
  assert.equal(second.who.model, 'claude-opus-5-5', '记下工具报出来的实际模型');
  assert.equal(second.who.tier, 'strong');
  assert.equal(second.status, 'handed', '官方账号那一次没带 ANTHROPIC_* 变量，没被接到 DeepSeek');
  assert.equal(first.review, 'done');
  assert.match(first.reviews[0].byLabel, /^Claude Code 官方账号/, '复核人写认出来的身份，不写它自称的「Claude Code」');
  const calls = fs.readFileSync(path.join(s.base, 'fake.log'), 'utf8').trim().split('\n');
  assert.ok(calls.some((l) => l.startsWith('claude --setting-sources project,local -p ') && l.includes('--model claude-opus-5-5')), `用最新的 Opus，不用简称 opus（它不一定是最新版）\n${calls.join('\n')}`);
  assert.ok(calls.some((l) => l.startsWith('claude -p ')), '接 DeepSeek 的那位照常调用');

  // 官方账号额度用完（新版的原话）：记成额度用完，按提示里的时区记下恢复时间，不是「出错」。
  s.env.FAKE_CLAUDE_OFFICIAL_MODE = 'session-limit';
  assert.match(s.relay(['go', 'claude-official']), /额度用完.*3:50 恢复/);
  const third = s.stints()[2];
  assert.equal(third.status, 'quota');
  const q = JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'quota.json'), 'utf8')).members['claude-official'];
  const until = new Date(q.until);
  assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(until), '03:50');
  assert.ok(until.getTime() > Date.now() && until.getTime() - Date.now() <= 24 * 3600_000, '下一个 3:50');
  assert.equal(third.quotaUntil, q.until);

  // 命令行太旧、用不了最新的 Opus：当场换成 opus 再干，这一棒照样做完；记下来，下次直接用 opus，升级之后再换回来。
  fs.rmSync(path.join(s.home, '.relay', 'quota.json'));
  s.env.FAKE_CLAUDE_OFFICIAL_MODE = 'too-old';
  fs.writeFileSync(path.join(s.base, 'fake.log'), '');
  s.relay(['task', '再做一步', '--step', '第三步']);
  s.relay(['go', 'claude-official']);
  const fourth = s.stints()[3];
  assert.equal(fourth.status, 'handed', '换成 opus 之后做完了');
  const tries = fs.readFileSync(path.join(s.base, 'fake.log'), 'utf8').trim().split('\n').filter((l) => l.includes('--setting-sources'));
  assert.deepEqual(
    tries.map((l) => l.match(/--model (\S+)/)?.[1]),
    ['claude-opus-5-5', 'opus']
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'cli-models.json'), 'utf8')), { 'claude-opus-5-5': '99.0.0' });
  const det = JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'detected.json'), 'utf8')).harnesses.find((h: { id: string }) => h.id === 'claude-official');
  assert.equal(det.model.model, 'opus', '名单上显示实际会用的');
  assert.match(det.note, /claude update/, '告诉你升级命令行就能用上');
  fs.writeFileSync(path.join(s.base, 'fake.log'), '');
  assert.match(s.relay(['talk', '说一句', '--ask', 'claude-official']), /Claude Code 官方账号 · opus：/, '署名写实际用的');
  const talkCalls = fs.readFileSync(path.join(s.base, 'fake.log'), 'utf8').trim().split('\n');
  assert.equal(talkCalls.length, 1, `记下来之后直接用 opus，不再先试一次：\n${talkCalls.join('\n')}`);
  assert.match(talkCalls[0], /--model opus/);
  // 群聊里第一次碰到：先试最新的被拒，换成 opus 再答；署名写答完之后实际用的。
  fs.rmSync(path.join(s.home, '.relay', 'cli-models.json'));
  s.relay(['detect', '--offline']);
  fs.writeFileSync(path.join(s.base, 'fake.log'), '');
  assert.match(s.relay(['talk', '再说一句', '--ask', 'claude-official']), /Claude Code 官方账号 · opus：claude 的看法/);
  assert.deepEqual(
    fs.readFileSync(path.join(s.base, 'fake.log'), 'utf8').trim().split('\n').map((l) => l.match(/--model (\S+)/)?.[1]),
    ['claude-opus-5-5', 'opus']
  );
});

test('你自己在各家工具里做的棒：拿 Claude Code 自己的记录核对——自称 Opus 的 DeepSeek 认得出来，它给自己写的复核不算数', () => {
  const s = prepared('claude-log', { FAKE_CLAUDE_OFFICIAL: 'pro' });
  s.relay(['init']);
  const logs = path.join(s.home, '.claude', 'projects', '-repo-');
  fs.mkdirSync(logs, { recursive: true });
  /** 假装 Claude Code 用某个模型改了一个文件：写文件，并在它的会话记录里记一笔。 */
  const edit = (model: string, entry: string, rel: string, text: string) => {
    s.write(rel, text);
    const row = { type: 'assistant', entrypoint: entry, message: { model, content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(s.repo, rel), content: text } }] }, timestamp: new Date().toISOString() };
    fs.appendFileSync(path.join(logs, `${entry}.jsonl`), JSON.stringify(row) + '\n');
  };
  const handoffText = (who: string, did: string) => `# 交接：${who}\n\n- 状态：已交接\n\n## 做了什么\n\n- ${did}\n`;

  // 终端里接了 DeepSeek 的 Claude Code 干了一棒，交接里却说自己是 Opus，还给自己写了复核「没问题」。
  edit('deepseek-v4-flash', 'cli', 'app.js', 'console.log(1)\n');
  edit('deepseek-v4-flash', 'cli', '.relay/交接/第1棒-0924-2100-claude.md', handoffText('Claude Code · Opus 5.5', '写了 app.js'));
  s.relay(['snap']);
  edit('deepseek-v4-flash', 'cli', '.relay/复核/第1棒.md', '# 复核：第 1 棒\n\n- 复核人：Claude Code · Opus 5.5\n- 结论：没问题\n');
  s.relay(['snap']);
  const one = s.stints()[0];
  assert.equal(one.who.member, 'claude', '以记录为准');
  assert.equal(one.who.tier, 'weak');
  assert.match(one.who.claimed, /Opus 5\.5/);
  assert.match(one.note, /Claude Code 的记录/);
  assert.equal(one.review, 'needed', '它给自己写的复核不算数');
  assert.equal(one.reviews[0].weak, true);
  assert.match(s.read('.relay/接力本.md'), /不算数/);

  // 桌面版的 Opus 接着做：复核第 1 棒、修好，再往下做。
  edit('claude-opus-5-5', 'claude-desktop', '.relay/复核/第1棒.md', '# 复核：第 1 棒\n\n- 复核人：Claude Code · Opus 5.5\n- 结论：有问题，已修好\n');
  edit('claude-opus-5-5', 'claude-desktop', 'app.js', 'console.log(2)\n');
  edit('claude-opus-5-5', 'claude-desktop', '.relay/交接/第2棒-0924-2200-claude.md', handoffText('Claude Code · Opus 5.5', '复核了第 1 棒，修了 app.js'));
  s.relay(['snap']);
  const [first, second] = s.stints();
  assert.equal(first.review, 'done');
  assert.equal(first.reviews.at(-1).verdict, 'fixed');
  assert.equal(second.who.member, 'claude-official');
  assert.equal(second.who.model, 'claude-opus-5-5', '模型名换成记录里的准确写法');
  assert.equal(second.review, 'skip', '强模型自己交接的，不用复核');
});

test('群聊：轮流说、各自先想；投票不投自己，一个 AI 一票', async () => {
  const s = prepared('talk');
  s.relay(['init', '做滤镜']);
  const t1 = s.relay(['talk', '先做哪个？', '--ask', 'claude,codex']);
  assert.match(t1, /Claude Code · deepseek-v4-flash：claude 的看法：同意/);
  const t2 = s.relay(['talk', '各自说说', '--ask', 'claude,codex', '--solo']);
  assert.match(t2, /claude 独立想了想/);
  assert.match(t2, /codex 独立想了想/);
  const v = s.relay(['vote', '用什么格式导出？', '--ask', 'claude,codex']);
  assert.match(v, /方案 A/);
  assert.match(v, /方案 B/);
  assert.doesNotMatch(v, /弃权/, '都没投自己');
  const votes = fs
    .readFileSync(path.join(s.repo, '.relay', 'talk.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('"vote"'))
    .map((l) => JSON.parse(l));
  const last = votes.at(-1);
  assert.equal(last.status, 'done');
  assert.equal(last.ballots.length, 2);
  for (const b of last.ballots) assert.notEqual(last.options.find((o: { key: string }) => o.key === b.choice).author, b.voter, '不投自己');
});
