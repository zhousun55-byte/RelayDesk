import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, type Sandbox } from './helpers';

/** 登记两个假工人：终端工人（弱）往 app.txt 追加一行；桌面工人的「打开命令」往隔离副本里写 app.txt。 */
function workers(s: Sandbox): void {
  const cli = s.script('fake-cli.sh', 'echo "cli edit" >> app.txt');
  const opener = s.script('fake-open.sh', 'echo "app edit" >> "$1/app.txt"');
  s.relay(['workers', 'add', 'weakcli', '--cmd', cli, '--tier', 'weak', '--label', '弱终端']);
  s.relay(['workers', 'add', 'desk', '--kind', 'app', '--cmd', `${opener} {{worktree}}`, '--tier', 'strong', '--label', '桌面A']);
  s.relay(['workers', 'add', 'desk2', '--kind', 'app', '--cmd', `${s.script('noop-open.sh', 'exit 0')} {{worktree}}`, '--tier', 'strong', '--label', '桌面B']);
}

function lastOf(s: Sandbox, type: string): Record<string, unknown> | undefined {
  return s.journal().filter((e) => e.type === type).pop();
}

test('完整接力：普通文件夹 → init → start → 终端工人 → 交接 → 桌面工人 → 交接 → 合回', () => {
  const s = sandbox('full', { git: false });
  // 旧版的致命问题：网页把普通文件夹「做成项目」后，配置没提交，正式文件夹永远「不干净」，合回必失败。
  s.relay(['init']);
  assert.equal(s.git(['status', '--porcelain']), '', 'init 之后正式文件夹必须是干净的');
  assert.ok(s.git(['ls-files']).includes('.relay/config.json'), '配置要提交进去');
  workers(s);

  s.relay(['start', '给', 'app.txt', '加内容']);
  const sess = s.session()!;
  assert.ok(sess.worktree.startsWith(path.join(s.home, '.relay', 'worktrees')), '隔离副本在仓库外');
  assert.equal(s.git(['status', '--porcelain']), '', '开始后正式文件夹不动');

  s.relay(['run', 'weakcli']);
  assert.ok(s.exists('app.txt', 'wt'));
  assert.ok(!s.exists('app.txt'), '正式文件夹里没有');
  const h1 = s.relay(['handoff', '-m', '先写了一行']);
  assert.match(h1, /1 个文件/);
  const audits = fs.readdirSync(path.join(sess.worktree, '.relay', 'audits'));
  assert.equal(audits.length, 1);
  const report = fs.readFileSync(path.join(sess.worktree, '.relay', 'audits', audits[0]), 'utf8');
  assert.ok(report.includes('+cli edit'), '事实段里有新文件的内容，不只是文件名');

  // 桌面工人上岗：前任是弱模型 → 上岗说明要求先审
  const out = s.relay(['run', 'desk', '--model', 'grok-4.6']);
  assert.match(out, /桌面A 上岗了/);
  const onboard = s.read('.relay/ONBOARD.md', 'wt');
  assert.ok(onboard.includes('审查上一位的改动（必须）'));
  assert.ok(onboard.includes(`git diff ${sess.baseCommit}..`));
  assert.ok(onboard.includes('先写了一行'), '上一次交接的留言带给下一位');
  assert.equal(lastOf(s, 'open')?.llm, 'grok-4.6');

  s.write('.relay/NOTE.md', '做到哪了：加了第二行\n下一步：合回', 'wt');
  s.relay(['handoff']);
  assert.ok(!s.exists('.relay/NOTE.md', 'wt'), '自述读走后删掉');
  const doc = s.read('.relay/handoff.md', 'wt');
  assert.ok(doc.includes('上一位的自述'));
  assert.ok(doc.includes('加了第二行'));
  assert.ok(doc.includes('桌面A · grok-4.6'));

  const m = s.relay(['merge']);
  assert.match(m, /合回完成/);
  assert.equal(s.read('app.txt'), 'cli edit\napp edit\n');
  assert.equal(s.git(['status', '--porcelain']), '', '合回后正式文件夹干净');
  const tracked = s.git(['ls-files', '.relay']);
  assert.equal(tracked, '.relay/config.json', '接力台自己的文件只有配置进正式文件夹');
  const msg = s.git(['log', '-1', '--format=%B']);
  assert.ok(msg.includes('弱终端'));
  assert.ok(msg.includes('桌面A · grok-4.6'));
  assert.equal(s.session(), null);
  assert.ok(!fs.existsSync(sess.worktree), '隔离副本删掉');
  assert.ok(s.git(['branch', '--list', sess.branch]).includes(sess.branch), '接力分支保留');
});

test('旧版遗留：正式文件夹里的配置从没提交过（XMP 的情况）也能合回，并顺手补提交', () => {
  const s = sandbox('legacy');
  // 模拟旧版：.relay/config.json 在，但没提交；还有旧版的讨论文件
  s.write('.relay/config.json', JSON.stringify({ gate: { command: '' }, protectedPaths: [], audit: { baseUrl: '', model: '', apiKeyEnv: 'X' } }));
  s.write('.relay/talk.jsonl', '{"ts":"x","kind":"person","who":"我","text":"hi"}\n');
  workers(s);
  // 旧版的会话已经开着：直接用新版继续（绕过 start 的自动提交，模拟旧会话）
  const r = s.relay(['start', 'legacy']);
  assert.match(r, /接力配置/, 'start 会把没提交的配置提交掉');
  s.relay(['run', 'desk']);
  s.relay(['handoff']);
  s.relay(['merge']);
  assert.equal(s.read('app.txt'), 'app edit\n');
  const st = s.git(['status', '--porcelain']);
  assert.equal(st, '', `合回后正式文件夹应干净，实际：${st}`);
});

test('没改动也能交接：桌面工人下岗，别人才能接（旧版这里是死循环）', () => {
  const s = sandbox('empty');
  s.relay(['init']);
  workers(s);
  s.relay(['start', 'empty handoff']);
  s.relay(['run', 'desk2']);
  // 桌面B 占着：换人被拒
  const refused = s.relay(['run', 'desk'], true);
  assert.match(refused, /桌面B.*还在干活.*先交接/);
  const h = s.relay(['handoff']);
  assert.match(h, /没有改动/);
  assert.equal(lastOf(s, 'handoff')?.empty, true);
  s.relay(['run', 'desk']);
  assert.ok(s.exists('app.txt', 'wt'));
});

test('同一个桌面工人再点一次打开：只重开窗口，不算新的一段', () => {
  const s = sandbox('reopen');
  s.relay(['init']);
  workers(s);
  s.relay(['start', 'reopen']);
  s.relay(['run', 'desk2']);
  const again = s.relay(['run', 'desk2']);
  assert.match(again, /又打开了一次/);
  assert.equal(s.journal().filter((e) => e.type === 'open').length, 1);
});

test('没交接就换人：拒绝；--force 强行接替并记账', () => {
  const s = sandbox('switch');
  s.relay(['init']);
  workers(s);
  s.relay(['start', 'switch']);
  s.relay(['run', 'weakcli']); // 终端工人退出了，但改动没交接
  const refused = s.relay(['run', 'desk2'], true);
  assert.match(refused, /弱终端.*1 个改动还没交接/);
  s.relay(['run', 'desk2', '--force']);
  assert.equal(lastOf(s, 'open')?.overrode, 'weakcli');
});

test('桌面工人没交接时：合回、放弃、退回都拒绝；强制合回 / 强制放弃可以', () => {
  const s = sandbox('softlock');
  s.relay(['init']);
  workers(s);
  s.relay(['start', 'soft lock']);
  s.relay(['run', 'desk']); // 写了 app.txt，但没交接
  assert.match(s.relay(['merge'], true), /先交接/);
  assert.ok(!s.exists('app.txt'), '拒绝时正式文件夹没有任何变化');
  assert.match(s.relay(['abandon'], true), /强制放弃/);
  assert.match(s.relay(['rollback', s.session()!.startCommit], true), /先交接/);
  const r = s.relay(['abandon', '--force']);
  assert.match(r, /存进接力分支留底/);
  assert.equal(s.session(), null);
  // 留底：接力分支里有那个没交接的 app.txt
  const branch = s.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/relay/']);
  assert.equal(s.git(['show', `${branch}:app.txt`]), 'app edit');
});

test('AI 开错了文件夹：正式文件夹里的改动能「收进任务」；开始前就有的改动不算', () => {
  const s = sandbox('stray');
  s.relay(['init']);
  workers(s);
  s.write('mine.txt', '我自己原来的改动\n');
  s.write('README.md', 'demo\n我改了 README\n');
  const st = s.relay(['start', 'stray']);
  assert.match(st, /2 个没提交的改动，它们不会带进这个任务/);
  s.relay(['run', 'desk2']);
  // AI 在正式文件夹里干活了
  s.write('result.xmp', '<xmp/>\n');
  s.write('mine.txt', '我自己原来的改动\n');
  const status = s.relay(['status']);
  assert.match(status, /正式文件夹在任务期间被改了：result\.xmp/);
  assert.ok(!status.includes('mine.txt（'), '开始前就有、之后没变的不算');
  const t = s.relay(['take']);
  assert.match(t, /收进任务：result\.xmp/);
  assert.ok(!s.exists('result.xmp'), '正式文件夹恢复原样');
  assert.ok(s.exists('result.xmp', 'wt'));
  assert.equal(s.read('mine.txt'), '我自己原来的改动\n', '用户自己的改动不动');
  s.relay(['handoff']);
  const shown = s.relay(['status']);
  assert.match(shown, /result\.xmp/);
  assert.match(shown, /可以合回/);
});

test('正式文件夹后来有新提交：不冲突就直接合回；冲突就退回原样，同步后由工人解决', () => {
  const s = sandbox('drift');
  s.relay(['init']);
  workers(s);
  s.write('shared.txt', 'line1\n');
  s.git(['add', '-A']);
  s.git(['commit', '-q', '-m', 'shared']);

  // 1) 不冲突
  s.relay(['start', 'no conflict']);
  s.relay(['run', 'desk']);
  s.relay(['handoff']);
  s.write('other.txt', 'main side\n');
  s.git(['add', '-A']);
  s.git(['commit', '-q', '-m', 'main moved']);
  const m1 = s.relay(['merge']);
  assert.match(m1, /合回完成/);
  assert.ok(s.exists('app.txt') && s.exists('other.txt'));

  // 2) 冲突
  const fixer = s.script('fix.sh', 'printf "line1\\ntask\\n" > shared.txt');
  s.relay(['workers', 'add', 'fixer', '--cmd', fixer, '--tier', 'strong']);
  s.relay(['start', 'conflict']);
  s.relay(['run', 'fixer']);
  s.relay(['handoff']);
  s.write('shared.txt', 'line1\nmain\n');
  s.git(['commit', '-q', '-am', 'main edits shared']);
  const head = s.git(['rev-parse', 'HEAD']);
  const refused = s.relay(['merge'], true);
  assert.match(refused, /冲突：shared\.txt/);
  assert.equal(s.git(['rev-parse', 'HEAD']), head, '冲突时正式文件夹原样不动');
  assert.equal(s.git(['status', '--porcelain']), '');

  const sync = s.relay(['sync']);
  assert.match(sync, /有冲突：shared\.txt/);
  assert.match(s.relay(["status"]), /同步正式文件夹时有冲突/);
  assert.match(s.relay(['handoff'], true), /还有合并冲突没解决/);
  // 让一个工人上岗解决：上岗说明写清楚了冲突
  const resolver = s.script('resolve.sh', 'printf "line1\\nmain\\ntask\\n" > shared.txt');
  s.relay(['workers', 'add', 'resolver', '--cmd', resolver, '--tier', 'strong']);
  s.relay(['run', 'resolver']);
  assert.ok(s.read('.relay/ONBOARD.md', 'wt').includes('先解决合并冲突'));
  s.relay(['handoff']);
  s.relay(['merge']);
  assert.equal(s.read('shared.txt'), 'line1\nmain\ntask\n');
  assert.equal(s.git(['status', '--porcelain']), '');
});

test('退回：不改写历史，文件回到检查点的样子，之后的审计报告还在', () => {
  const s = sandbox('rollback');
  s.relay(['init']);
  workers(s);
  s.relay(['start', 'rollback']);
  s.relay(['run', 'weakcli']);
  s.relay(['handoff']);
  const cp1 = lastOf(s, 'handoff')!.checkpoint as string;
  s.relay(['run', 'desk']);
  s.write('extra.txt', 'x', 'wt');
  s.relay(['handoff']);
  s.write('junk.txt', 'uncommitted', 'wt');
  const list = s.relay(['rollback']);
  assert.ok(list.includes(cp1.slice(0, 9)));
  s.relay(['rollback', cp1.slice(0, 9)]);
  assert.equal(s.read('app.txt', 'wt'), 'cli edit\n');
  assert.ok(!s.exists('extra.txt', 'wt'));
  assert.ok(!s.exists('junk.txt', 'wt'));
  const wt = s.session()!.worktree;
  assert.equal(fs.readdirSync(path.join(wt, '.relay', 'audits')).length, 2, '第二段的审计报告还在');
  assert.equal(s.journal().filter((e) => e.type === 'handoff').length, 2, '交接记录一条不少');
  assert.equal(s.git(['status', '--porcelain'], wt), '');
  // 退回后可以直接合回（内容等于第一个检查点）
  s.relay(['merge']);
  assert.equal(s.read('app.txt'), 'cli edit\n');
  assert.ok(!s.exists('extra.txt'));
});

test('检查命令没过 / 改了保护文件：合回被拒，强制合回可以', () => {
  const s = sandbox('gate');
  s.relay(['init']);
  const cfgPath = path.join(s.repo, '.relay', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.gate.command = 'grep -q ok app.txt';
  cfg.protectedPaths = ['secret/'];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  s.git(['commit', '-q', '-am', 'config']);
  workers(s);
  s.relay(['start', 'gate']);
  s.relay(['run', 'desk']);
  const h = s.relay(['handoff']);
  assert.match(h, /检查：没通过/);
  assert.match(s.relay(['merge'], true), /检查没通过/);
  s.write('app.txt', 'ok\n', 'wt');
  s.write('secret/key.txt', 'k', 'wt');
  s.relay(['run', 'desk2', '--force']);
  s.relay(['handoff']);
  assert.match(s.relay(['merge'], true), /不许改的文件：secret\/key\.txt/);
  s.relay(['merge', '--force']);
  assert.ok(s.exists('secret/key.txt'));
});

test('交接记录坏了：状态说清楚；强制放弃能收场，之后能开新任务', () => {
  const s = sandbox('broken');
  s.relay(['init']);
  s.relay(['start', 'broken']);
  fs.appendFileSync(path.join(s.session()!.worktree, '.relay', 'journal.jsonl'), '{bad json\n');
  assert.match(s.relay(['status']), /第 \d+ 行坏了/);
  s.relay(['abandon', '--force']);
  s.relay(['start', 'again']);
  assert.ok(s.session());
});

test('隔离副本被人删了：状态提示只能放弃；放弃能收场', () => {
  const s = sandbox('lost');
  s.relay(['init']);
  s.relay(['start', 'lost']);
  fs.rmSync(s.session()!.worktree, { recursive: true, force: true });
  assert.match(s.relay(['status']), /隔离副本不见了/);
  assert.match(s.relay(['handoff'], true), /隔离副本不见了/);
  s.relay(['abandon']);
  assert.equal(s.session(), null);
});

test('工人管理：预设、修改、改名、删除；名单里的命令能检查', () => {
  const s = sandbox('workers');
  s.relay(['workers', 'add', 'claude', '--preset', 'claude', '--model', 'opus']);
  s.relay(['workers', 'add', 'ds', '--preset', 'deepseek']);
  assert.match(s.relay(['workers', 'add', 'claude', '--preset', 'claude'], true), /已经有叫「claude」/);
  s.relay(['workers', 'edit', 'claude', '--tier', 'weak', '--rename', 'cc']);
  const list = s.relay(['workers', 'list']);
  assert.match(list, /cc\s+Claude Code（终端，弱，opus，全自动：claude，能讨论）/);
  assert.match(list, /ds\s+DeepSeek（接口，弱，deepseek-v4-pro，能讨论）/);
  s.relay(['workers', 'remove', 'ds']);
  assert.ok(!s.relay(['workers', 'list']).includes('DeepSeek'));
  const bad = s.relay(['workers', 'add', 'x', '--cmd', 'definitely-not-a-command-xyz']);
  assert.match(bad, /找不到命令「definitely-not-a-command-xyz」/);
  assert.match(s.relay(['run', 'ds'], true), /没有「ds」|不能手动上岗/);
});

test('上岗说明：弱模型干了活、强模型空交班后，第三位审的仍是弱模型那段', () => {
  const s = sandbox('review');
  s.relay(['init']);
  workers(s);
  s.relay(['start', 'review chain']);
  s.relay(['run', 'weakcli']);
  s.relay(['handoff']);
  s.relay(['run', 'desk2']);
  s.relay(['handoff']);
  s.relay(['run', 'desk2']);
  const ob = s.read('.relay/ONBOARD.md', 'wt');
  assert.ok(ob.includes('上一位是 **弱终端**'), ob);
  assert.ok(ob.includes('（必须）'));
});
