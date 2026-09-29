import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { saveUpload } from '../src/core/files';
import { withFakes } from './fakes';
import { CLI, sandbox, until, type Sandbox } from './helpers';

/** 起一个真的接力台（relay ui），用 HTTP 打它。 */
async function startUi(s: Sandbox): Promise<{ child: ChildProcess; port: number; call: (p: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: Record<string, any> }> }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [CLI, 'ui', s.repo, '--port', String(port), '--no-open'], { cwd: s.repo, env: { ...s.env, RELAY_WATCH_DEBOUNCE_MS: '150', RELAY_WATCH_TICK_MS: '400' } });
  let out = '';
  child.stdout?.on('data', (c) => (out += c));
  child.stderr?.on('data', (c) => (out += c));
  await until(15_000, () => /接力台已启动：http:\/\/127\.0\.0\.1:(\d+)/.test(out), `接力台启动（${out}）`);
  const actual = Number(out.match(/127\.0\.0\.1:(\d+)/)![1]);
  const base = `http://127.0.0.1:${actual}`;
  const call = async (p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${p}`, body === undefined ? { headers } : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { child, port: actual, call };
}

const q = (s: Sandbox) => `?dir=${encodeURIComponent(s.repo)}`;

test('网页接口：接入 → 写任务 → 派人接着做一棒 → 看交接和改动 → 退回再撤销', async () => {
  const s = sandbox('srv');
  withFakes(s);
  s.relay(['detect', '--offline']);
  const ui = await startUi(s);
  try {
    assert.equal((await ui.call('/api/ping')).json.app, 'relay');
    let st = await ui.call(`/api/state${q(s)}`);
    assert.equal(st.json.project.init, false);

    const init = await ui.call('/api/init', { dir: s.repo });
    assert.equal(init.status, 200, JSON.stringify(init.json));
    assert.ok(s.exists('.relay/接力本.md'));
    const task = await ui.call('/api/task', { dir: s.repo, text: '做两件事', steps: ['第一件', '第二件'] });
    assert.equal(task.status, 200, JSON.stringify(task.json));

    st = await ui.call(`/api/state${q(s)}`);
    assert.equal(st.json.project.init, true);
    assert.equal(st.json.project.task.total, 2);
    assert.deepEqual(
      st.json.members.map((m: { name: string; tier: string }) => [m.name, m.tier]),
      [
        ['codex', 'strong'],
        ['claude', 'weak'],
      ],
      '强的排在前面'
    );

    const go = await ui.call('/api/go', { dir: s.repo, who: 'claude' });
    assert.equal(go.status, 200, JSON.stringify(go.json));
    await until(15_000, async () => (await ui.call(`/api/state${q(s)}`)).json.project.go?.status === 'done', '这一棒做完');
    st = await ui.call(`/api/state${q(s)}`);
    assert.equal(st.json.project.stints.length, 1);
    assert.equal(st.json.project.pending.length, 1, '弱模型的棒待复核');
    assert.equal(st.json.project.task.done, 1);

    const detail = await ui.call(`/api/stint${q(s)}&id=1`);
    assert.match(detail.json.handoff, /在 work\.txt 里加了一行/);
    const diff = await ui.call(`/api/diff${q(s)}&id=1`);
    assert.deepEqual(
      diff.json.files.map((f: { path: string }) => f.path),
      ['work.txt']
    );

    const mark = await ui.call('/api/mark', { dir: s.repo, stint: 1 });
    assert.equal(mark.status, 200);
    st = await ui.call(`/api/state${q(s)}`);
    assert.equal(st.json.project.pending.length, 0, '你说不用复核就不用');
    const unmark = await ui.call('/api/mark', { dir: s.repo, stint: 1, review: 'needed' });
    assert.equal(unmark.status, 200);
    st = await ui.call(`/api/state${q(s)}`);
    assert.equal(st.json.project.pending.length, 1, '跳过复核可以撤销');
    await ui.call('/api/mark', { dir: s.repo, stint: 1 });

    const rb = await ui.call('/api/rollback', { dir: s.repo, stint: 1 });
    assert.equal(rb.status, 200, JSON.stringify(rb.json));
    assert.ok(!s.exists('work.txt'));
    const undo = await ui.call('/api/rollback/undo', { dir: s.repo });
    assert.equal(undo.status, 200, JSON.stringify(undo.json));
    assert.ok(s.exists('work.txt'));
  } finally {
    ui.child.kill();
  }
});

test('同一个工具加几个模型：列出工具能换的模型、勾选加成几位；每位用自己的模型干活（Opus 做完一棒，Sonnet 接着做）', async () => {
  const s = sandbox('models');
  withFakes(s, { FAKE_CLAUDE_OFFICIAL: 'pro' });
  fs.writeFileSync(
    path.join(s.home, '.codex', 'models_cache.json'),
    JSON.stringify({ models: [{ slug: 'gpt-6', visibility: 'list', priority: 1 }, { slug: 'gpt-6-luna', visibility: 'list', priority: 3 }, { slug: 'codex-auto-review', visibility: 'hide', priority: 43 }] })
  );
  s.relay(['detect', '--offline']);
  const ui = await startUi(s);
  try {
    await ui.call('/api/init', { dir: s.repo });
    await ui.call('/api/task', { dir: s.repo, text: '做两件事', steps: ['第一件', '第二件'] });
    let r = await ui.call('/api/models?name=codex');
    assert.deepEqual(
      r.json.models.map((m: { id: string; name: string; current: boolean; added: boolean; top: boolean }) => [m.id, m.name, m.current, m.added, m.top]),
      [
        ['gpt-6', 'GPT-6', true, false, true],
        ['gpt-6-luna', 'GPT-6 Luna', false, false, true],
      ],
      'Codex 自己缓存的列表，藏起来的不列，现在用的标上'
    );
    r = await ui.call('/api/models?name=claude');
    assert.deepEqual([r.json.listed, r.json.models], [false, []], '接了别家模型的 Claude Code 列不出来');
    r = await ui.call('/api/models?name=claude-official');
    assert.deepEqual(
      r.json.models.map((m: { id: string; current: boolean }) => [m.id, m.current]),
      [
        ['fable', false],
        ['opus', true],
        ['sonnet', false],
        ['haiku', false],
      ]
    );
    assert.equal((await ui.call('/api/models?name=nobody')).status, 400);

    r = await ui.call('/api/members/add-models', { from: 'claude-official', models: ['sonnet'] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.added, ['claude-official-sonnet']);
    const sonnet = r.json.members.find((m: { name: string }) => m.name === 'claude-official-sonnet');
    assert.deepEqual([sonnet.llm, sonnet.tier, sonnet.canWork, sonnet.tool], ['Claude Sonnet', 'strong', true, 'Claude Code']);
    assert.equal((await ui.call('/api/members/add-models', { from: 'codex', models: [] })).status, 400, '没选模型');
    assert.deepEqual((await ui.call('/api/members/add-models', { from: 'claude-official', models: ['sonnet'] })).json.added, [], '加过了不再加');
    r = await ui.call('/api/models?name=claude-official');
    assert.deepEqual(
      r.json.models.filter((m: { added: boolean }) => m.added).map((m: { id: string }) => m.id),
      ['sonnet'],
      '别的成员已在用的标上'
    );

    // Opus 做一棒，Sonnet 接着做：各用各的模型
    for (const who of ['claude-official', 'claude-official-sonnet']) {
      const go = await ui.call('/api/go', { dir: s.repo, who });
      assert.equal(go.status, 200, JSON.stringify(go.json));
      await until(15_000, async () => (await ui.call(`/api/state${q(s)}`)).json.project.go?.status === 'done', `${who} 这一棒做完`);
    }
    const runs = fs
      .readFileSync(s.env.FAKE_LOG!, 'utf8')
      .split('\n')
      .filter((l) => l.includes('"ANTHROPIC_BASE_URL":"https://api.anthropic.com"') && l.includes(' -p'))
      .map((l) => l.match(/--model (\S+)/)?.[1]);
    assert.deepEqual(runs, ['opus', 'sonnet']);
    // 派活选了谁指挥：它要复核、终审，原来算弱的改成强
    const lead = await ui.call('/api/settings', { settings: { lead: 'claude' } });
    assert.equal(lead.json.members.find((m: { name: string }) => m.name === 'claude').tier, 'strong');
    const st = await ui.call(`/api/state${q(s)}`);
    assert.equal(st.json.project.stints.length, 2);
    assert.equal(st.json.project.task.done, 2, '第二棒接着第一棒往下做');
  } finally {
    ui.child.kill();
  }
});

test('对话：每一棒记下在工具里的对话，网页能读；这个项目文件夹里自己在工具里开的对话列出来（接力台派的不列，设置里能关）；回到原工具接着说', async () => {
  const s = sandbox('sessions');
  withFakes(s);
  s.relay(['detect', '--offline']);
  const ui = await startUi(s);
  try {
    assert.equal((await ui.call(`/api/sessions${q(s)}`)).status, 400, '没接入的文件夹不读');
    await ui.call('/api/init', { dir: s.repo });
    await ui.call('/api/task', { dir: s.repo, text: '做一件事', steps: ['第一件'] });
    await ui.call('/api/go', { dir: s.repo, who: 'claude' });
    await until(15_000, async () => (await ui.call(`/api/state${q(s)}`)).json.project.go?.status === 'done', '这一棒做完');
    const st = await ui.call(`/api/state${q(s)}`);
    const sess = st.json.project.stints[0].session;
    assert.equal(sess.tool, 'claude');
    const read = await ui.call(`/api/session${q(s)}&tool=${sess.tool}&id=${sess.id}`);
    assert.equal(read.status, 200, JSON.stringify(read.json));
    assert.deepEqual(read.json.messages.map((m: { role: string; text: string }) => [m.role, m.text]), [['user', '接着做']]);

    // 自己在 Claude 桌面版里开的一段
    const real = fs.realpathSync(s.repo);
    const dir = path.join(s.home, '.claude', 'projects', real.replace(/[^A-Za-z0-9]/g, '-'));
    fs.writeFileSync(path.join(dir, 'desk-000001.jsonl'), JSON.stringify({ type: 'user', cwd: real, entrypoint: 'claude-desktop', message: { role: 'user', content: '自己问的' } }) + '\n');
    let list = await ui.call(`/api/sessions${q(s)}`);
    assert.deepEqual(
      list.json.sessions.map((x: { id: string; title: string }) => [x.id, x.title]),
      [['desk-000001', '自己问的']],
      '接力台派的那段不列'
    );
    await ui.call('/api/settings', { settings: { showSessions: false } });
    list = await ui.call(`/api/sessions${q(s)}`);
    assert.deepEqual(list.json.sessions, [], '设置里关掉就不列');

    const open = await ui.call('/api/session/open', { dir: s.repo, tool: 'codex', id: 'abc-123456' });
    assert.match(open.json.command, /codex resume abc-123456$/);
    assert.equal((await ui.call('/api/session/open', { dir: s.repo, tool: 'claude', id: sess.id })).status, 200);
    assert.equal((await ui.call('/api/session/open', { dir: s.repo, tool: 'dsh', id: 'abc-123456' })).status, 400);
    assert.equal((await ui.call(`/api/session${q(s)}&tool=claude&id=${encodeURIComponent('../../x')}`)).status, 400);
  } finally {
    ui.child.kill();
  }
});

test('网页开着时盯着文件夹：你在别的工具里改文件、写交接，接力台自动记上账', async () => {
  const s = sandbox('srv-watch');
  withFakes(s);
  s.relay(['detect', '--offline']);
  s.relay(['init', '做滤镜']);
  const ui = await startUi(s);
  try {
    await ui.call(`/api/state${q(s)}`);
    s.write('filter.xmp', '<x/>\n');
    s.write('.relay/交接/第1棒-0924-2100-codex.md', '# 交接：Codex · gpt-6\n\n- 状态：已交接\n\n## 做了什么\n\n- 写了 filter.xmp\n');
    await until(15_000, () => s.stints().some((x) => x.status === 'handed'), '自动记上第 1 棒');
    const st = s.stints()[0];
    assert.equal(st.who.member, 'codex');
    assert.equal(st.review, 'skip');
    assert.deepEqual(st.facts.paths, ['filter.xmp']);
  } finally {
    ui.child.kill();
  }
});

test('网页接口：右边的项目文件、读文件（出不了项目文件夹）、在网页上改任务、按任务分的对话', async () => {
  const s = sandbox('srv-files');
  withFakes(s);
  s.relay(['detect', '--offline']);
  s.write('src/a.ts', 'export const a = 1;\n');
  s.write('node_modules/x/index.js', '');
  const ui = await startUi(s);
  try {
    let tree = await ui.call(`/api/tree${q(s)}`);
    assert.ok(tree.json.files.includes('src/a.ts'), '没接入也能看文件');
    assert.ok(!tree.json.files.some((f: string) => f.startsWith('node_modules/') || f.startsWith('.git/')));
    await ui.call('/api/init', { dir: s.repo });
    await ui.call('/api/task', { dir: s.repo, text: '做两件事', steps: ['一', '二'] });
    tree = await ui.call(`/api/tree${q(s)}`);
    assert.ok(tree.json.files.includes('src/a.ts'));
    assert.ok(!tree.json.files.some((f: string) => f.startsWith('.relay/') || f.startsWith('node_modules/')), '接力台自己的东西、依赖都不列');

    const f = await ui.call(`/api/file${q(s)}&path=${encodeURIComponent('src/a.ts')}`);
    assert.equal(f.json.text, 'export const a = 1;\n');
    assert.equal(f.json.binary, false);
    fs.writeFileSync(path.join(s.base, 'secret.txt'), '项目外面的文件\n');
    fs.symlinkSync(s.base, path.join(s.repo, 'outside'));
    for (const bad of ['../secret.txt', path.join(s.base, 'secret.txt'), '.relay/snapshots/HEAD', '.git/config', 'outside/secret.txt']) {
      const r = await ui.call(`/api/file${q(s)}&path=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 400, `不能读 ${bad}`);
    }
    assert.equal((await ui.call('/api/reveal', { dir: s.repo, path: '../x' })).status, 400);

    const e = await ui.call('/api/task/edit', { dir: s.repo, op: 'toggle', index: 1 });
    assert.equal(e.status, 200, JSON.stringify(e.json));
    assert.deepEqual(
      e.json.task.items.map((i: { done: boolean }) => i.done),
      [false, true]
    );
    await ui.call('/api/task/edit', { dir: s.repo, op: 'add', text: '三' });
    await ui.call('/api/task/edit', { dir: s.repo, op: 'title', text: '做三件事' });
    assert.match(s.read('.relay/任务.md'), /做三件事[\s\S]*- \[x\] 二\n- \[ \] 三/);
    assert.match(s.read('.relay/接力本.md'), /- \[ \] 三/, '接力本跟着更新');
    assert.equal((await ui.call('/api/task/edit', { dir: s.repo, op: 'toggle', index: 9 })).status, 400);
    assert.equal((await ui.call('/api/task/edit', { dir: s.repo, op: 'bogus' })).status, 400);

    await ui.call('/api/task', { dir: s.repo, text: '下一件事' });
    const st = await ui.call(`/api/state${q(s)}`);
    assert.deepEqual(
      st.json.project.threads.map((t: { title: string; current: boolean }) => [t.title, t.current]),
      [
        ['做三件事', false],
        ['下一件事', true],
      ]
    );
  } finally {
    ui.child.kill();
  }
});

test('网页接口：强弱可以改；投票出结果后采纳，写进任务的约定', async () => {
  const s = sandbox('srv-vote');
  withFakes(s);
  s.relay(['detect', '--offline']);
  s.relay(['init', '做滤镜']);
  const ui = await startUi(s);
  try {
    // 重新识别在子进程里跑（接力台自己不卡）：结果照样带回来，名单照样更新，做完「正在识别」要复位。
    const d = await ui.call('/api/detect', { dir: s.repo, offline: true });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    assert.ok(d.json.report.harnesses.some((x: { id: string }) => x.id === 'claude'));
    assert.ok(Array.isArray(d.json.changes));
    assert.deepEqual(d.json.members.map((m: { name: string }) => m.name).sort(), ['claude', 'codex']);
    assert.equal((await ui.call(`/api/state${q(s)}`)).json.detecting, false);

    const t = await ui.call('/api/members/tier', { name: 'claude', tier: 'strong' });
    assert.equal(t.status, 200);
    const claude = t.json.members.find((m: { name: string }) => m.name === 'claude');
    assert.equal(claude.tier, 'strong');
    assert.equal(claude.tierSet, true);

    const v = await ui.call('/api/vote/start', { dir: s.repo, question: '导出什么格式？', voters: ['claude', 'codex'] });
    assert.equal(v.status, 200, JSON.stringify(v.json));
    const id = v.json.vote.id;
    await until(15_000, async () => (await ui.call(`/api/talk${q(s)}`)).json.votes.find((x: { id: string }) => x.id === id)?.status === 'done', '投完票');
    const done = (await ui.call(`/api/talk${q(s)}`)).json.votes.find((x: { id: string }) => x.id === id);
    assert.equal(done.options.length, 2);
    const mine = await ui.call('/api/vote/cast', { dir: s.repo, id, key: 'A' });
    assert.equal(mine.json.vote.ballots.length, 3, '你也投了一票');
    const ad = await ui.call('/api/vote/adopt', { dir: s.repo, id, key: done.leaders[0] });
    assert.equal(ad.status, 200, JSON.stringify(ad.json));
    assert.match(s.read('.relay/任务.md'), /导出什么格式？ → 采用方案/);
    assert.match(s.read('.relay/任务.md'), /票，[^）]*[A-Za-z0-9] 出的）/, '英文名后面空一格；中文名（「我出的」）不空');
    assert.match(s.read('.relay/接力本.md'), /采用方案/, '接力本里也能看到约定');
  } finally {
    ui.child.kill();
  }
});

test('网页接口：成员叫模型的名字、删掉的不再加回来；群聊分几段：新群聊把正在用的存档、看存档、接着存档的那段', async () => {
  const s = sandbox('srv-talks');
  withFakes(s);
  s.relay(['detect', '--offline']);
  s.relay(['init', '做滤镜']);
  // 工具报过的额度窗口：网页拿到的是现在的样子（过了恢复时间的从 0 算起）
  const at = new Date(Date.now() - 3600_000).toISOString();
  const later = new Date(Date.now() + 86_400_000).toISOString();
  fs.writeFileSync(path.join(s.home, '.relay', 'quota.json'), JSON.stringify({ members: {}, limits: { codex: { at, windows: [{ kind: '5h', used: 97, resetsAt: at }, { kind: '7d', used: 41, resetsAt: later }] } } }));
  const ui = await startUi(s);
  try {
    const st = await ui.call(`/api/state${q(s)}`);
    const codex = st.json.members.find((m: { name: string }) => m.name === 'codex');
    assert.deepEqual([codex.llm, codex.tool, codex.app], ['GPT-6', 'Codex', null]);
    assert.deepEqual([codex.limits, codex.limitsAt], [[{ kind: '5h', used: 0 }, { kind: '7d', used: 41, resetsAt: later }], at]);
    const claude = st.json.members.find((m: { name: string }) => m.name === 'claude');
    assert.ok(!('limits' in claude) && !('limitsAt' in claude), '没报过额度的不带这两个字段');
    assert.deepEqual([codex.tested, claude.tested], ['yes', 'yes'], '实测到什么程度（网页只写部分实测、没实测）');

    assert.equal((await ui.call('/api/talk/say', { dir: s.repo, text: '第一段', ask: ['codex'] })).status, 200);
    await until(15_000, async () => (await ui.call(`/api/talk${q(s)}`)).json.rows.some((r: { kind: string }) => r.kind === 'ai'), '回话');
    const ai = (await ui.call(`/api/talk${q(s)}`)).json.rows.find((r: { kind: string }) => r.kind === 'ai');
    assert.equal(ai.who, 'GPT-6', '群聊里的署名是模型的名字');
    let id = '';
    await until(10_000, async () => {
      const c = await ui.call('/api/talk/clear', { dir: s.repo });
      id = c.json.archived ?? '';
      return c.status === 200;
    }, '这一轮说完后存档');
    let t = await ui.call(`/api/talk${q(s)}`);
    assert.deepEqual(t.json.rows, []);
    assert.deepEqual(
      t.json.sessions.map((x: { id: string; title: string }) => [x.id, x.title]),
      [[id, '第一段']]
    );
    assert.equal((await ui.call(`/api/talk${q(s)}&id=${id}`)).json.rows[0].text, '第一段', '看存档的那段');
    assert.equal((await ui.call(`/api/talk${q(s)}&id=..%2F..%2Fetc`)).status, 400);

    await ui.call('/api/talk/say', { dir: s.repo, text: '第二段', ask: [] });
    assert.equal((await ui.call('/api/talk/resume', { dir: s.repo, id })).status, 200);
    t = await ui.call(`/api/talk${q(s)}`);
    assert.equal(t.json.rows[0].text, '第一段', '接着的那段换成了正在用的');
    assert.deepEqual(
      t.json.sessions.map((x: { title: string }) => x.title),
      ['第二段'],
      '原来正在用的存了档'
    );

    assert.equal((await ui.call('/api/workers/delete', { name: 'claude' })).status, 200);
    const d = await ui.call('/api/detect', { dir: s.repo, offline: true });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    assert.deepEqual(
      d.json.members.map((m: { name: string }) => m.name),
      ['codex'],
      '删掉的再识别也不加回来'
    );
  } finally {
    ui.child.kill();
  }
});

test('网页接口的安全检查：只认本机地址和本端口，POST 必须是 JSON；网页能关闭接力台', async () => {
  const s = sandbox('srv-sec');
  const ui = await startUi(s);
  let exited = false;
  ui.child.on('exit', () => (exited = true));
  try {
    // fetch 会忽略自定义的 Host，用原始 http 请求模拟 DNS 重绑定。
    const badHost = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: ui.port, path: '/api/ping', headers: { host: `evil.example:${ui.port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(badHost, 403);
    // 别的网站里的一张图片：不带 Origin，浏览器标明是从别的网站来的（Sec-Fetch-Site: cross-site）
    const fromOtherSite = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: ui.port, path: `/api/diff${q(s)}`, headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(fromOtherSite, 403);
    // 看改动要先存快照：没接入的文件夹不给建快照仓库
    const diff = await ui.call(`/api/diff${q(s)}`);
    assert.equal(diff.status, 400);
    assert.equal(diff.json.code, 'not-init');
    assert.ok(!s.exists('.relay'), '没给没接入的文件夹建快照仓库');
    assert.equal((await ui.call('/api/init', { dir: s.repo }, { Origin: 'http://evil.example.com' })).status, 403);
    assert.equal((await ui.call('/api/quit', {}, { Origin: 'http://evil.example.com' })).status, 403, '别的网站关不掉接力台');
    assert.ok(!s.exists('.relay'), '别的网站接入不了');
    const port = (await ui.call('/api/ping')).json;
    assert.equal(port.app, 'relay');
    // 原型污染：带 __proto__ 的请求体不能污染 Object.prototype
    await ui.call('/api/init', { dir: s.repo });
    await ui.call('/api/task/edit', { dir: s.repo, op: 'title', text: 'x', ['__proto__']: { polluted: 1 } });
    assert.equal(({} as Record<string, unknown>).polluted, undefined, '原型没被污染');
    // 超大请求体：回 413（不是砸断连接让网页只看到断线）
    const huge = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: ui.port, method: 'POST', path: '/api/task', headers: { 'content-type': 'application/json' } }, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      });
      req.on('error', reject);
      req.end(`{"dir":${JSON.stringify(s.repo)},"text":"${'x'.repeat(2_000_000)}"}`);
    });
    assert.equal(huge.status, 413, '超大请求体回 413');
    // 静态资源不能穿越出网页目录
    const stat = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: ui.port, path: '/../../../../etc/passwd' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.notEqual(stat, 200, '静态资源路径穿越拿不到系统文件');
    const res = await ui.call('/api/quit', {});
    assert.equal(res.json.quitting, true);
    await until(10_000, () => exited, '接力台退出');
  } finally {
    if (!exited) ui.child.kill();
  }
});

test('韧性：数据文件坏了、快照仓库被破坏、整个 .relay 被删，接力台都不崩，网页照常打开（坏了的顶上有提示）', async () => {
  const s = sandbox('srv-res');
  withFakes(s);
  s.relay(['detect', '--offline']);
  const ui = await startUi(s);
  const relayHome = path.join(s.home, '.relay');
  const alive = () => ui.child.exitCode === null && ui.child.signalCode === null;
  const state = () => ui.call(`/api/state${q(s)}`);
  try {
    await ui.call('/api/init', { dir: s.repo });
    await ui.call('/api/task', { dir: s.repo, text: '做一件事', steps: ['第一件'] });
    fs.writeFileSync(path.join(s.repo, '.relay', 'talk.jsonl'), JSON.stringify({ ts: new Date().toISOString(), kind: 'human', who: '我', text: '问题' }) + String.fromCharCode(10));

    // 一、每个数据文件写坏（坏 JSON、空文件、全是 0 字节）：state / talk 都不 500，服务不崩
    const files: [string, string, string?][] = [
      ['agents.json', path.join(relayHome, 'agents.json'), 'membersError'],
      ['auto.json', path.join(relayHome, 'auto.json'), 'settingsError'],
      ['detected.json', path.join(relayHome, 'detected.json')],
      ['quota.json', path.join(relayHome, 'quota.json')],
      ['journal.jsonl', path.join(s.repo, '.relay/journal.jsonl')],
      ['config.json', path.join(s.repo, '.relay/config.json')],
      ['hidden.json', path.join(s.repo, '.relay/hidden.json')],
      ['talk.jsonl', path.join(s.repo, '.relay/talk.jsonl')],
    ];
    for (const [name, p, banner] of files) {
      const had = fs.existsSync(p) ? fs.readFileSync(p) : null;
      for (const garbage of ['{ 坏 json ,,', '', String.fromCharCode(0, 0)]) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, garbage);
        const st = await state();
        const talk = await ui.call(`/api/talk${q(s)}`);
        assert.notEqual(st.status, 500, `${name} 坏了 state 不该 500`);
        assert.notEqual(talk.status, 500, `${name} 坏了 talk 不该 500`);
        if (banner && garbage.startsWith('{')) {
          assert.equal(st.status, 200, `${name} 坏了网页仍打开`);
          assert.ok(st.json[banner], `${name} 坏了顶上有提示（${banner}）`);
        }
      }
      if (had) fs.writeFileSync(p, had);
      else fs.rmSync(p, { force: true });
      assert.ok(alive(), `${name} 坏了接力台没崩`);
    }
    assert.equal((await state()).status, 200, '都改回来后 state 正常');

    // 二、破坏快照仓库（沙盒）：删掉、对象损坏、HEAD 指向不存在 —— 都不崩
    fs.rmSync(path.join(s.repo, '.relay/snapshots'), { recursive: true, force: true });
    assert.equal((await state()).status, 200, '删掉快照仓库后 state 仍 200');
    assert.ok(alive());
    s.relay(['init']); // 重新接入重建快照仓库
    fs.writeFileSync(path.join(s.repo, '.relay/snapshots/HEAD'), 'ref: refs/heads/nope');
    const snap = await ui.call('/api/snap', { dir: s.repo });
    assert.notEqual(snap.status, 500, '快照 HEAD 坏了对账不 500');
    assert.ok(alive(), '快照仓库坏了接力台没崩');

    // 三、整个 .relay 被删（误删）：回到「没接入」，网页照常打开
    fs.rmSync(path.join(s.repo, '.relay'), { recursive: true, force: true });
    const st = await state();
    assert.equal(st.status, 200, '.relay 被删后 state 仍 200');
    assert.equal(st.json.project.init, false, '回到没接入');
    assert.ok(alive());
  } finally {
    ui.child.kill();
  }
});

test('传文件：同一分钟同时传两个同名的，各存各的（以前两次共用一个临时文件：一个成功，另一个换名时报 ENOENT，内容还可能串）', async () => {
  const s = sandbox('up-race');
  // 一点一点地来：两次上传一定同时在写
  const slow = (text: string) =>
    Readable.from(
      (async function* () {
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 15));
          yield Buffer.from(text);
        }
      })()
    );
  const [a, b] = await Promise.all([saveUpload(s.repo, '同名.txt', slow('一')), saveUpload(s.repo, '同名.txt', slow('二'))]);
  assert.notEqual(a, b);
  assert.equal(s.read(a), '一一一一');
  assert.equal(s.read(b), '二二二二');
  // 传到一半出错（太大）：占的名字和临时文件都收掉，下一个同名的照样用这个名字
  await assert.rejects(saveUpload(s.repo, '大.bin', slow('xxxx'), 6), (e: { code?: string }) => e.code === 'too-large');
  assert.deepEqual(fs.readdirSync(path.join(s.repo, '.relay/uploads')).filter((f) => f.endsWith('.tmp') || f.includes('大')), []);
});

test('网页接口：传文件存进项目的 .relay/uploads（不进 git）；原样读回来给缩略图；别的网站传不了', async () => {
  const s = sandbox('srv-up');
  const ui = await startUi(s);
  const base = `http://127.0.0.1:${ui.port}`;
  const upload = (name: string, body: Buffer | string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; json: Record<string, any> }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: ui.port, method: 'POST', path: `/api/upload${q(s)}&name=${encodeURIComponent(name)}`, headers: { 'content-type': 'application/octet-stream', ...headers } }, (res) => {
        let t = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (t += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(t) }));
      });
      req.on('error', reject);
      req.end(body);
    });
  try {
    assert.equal((await upload('a.png', 'x')).json.code, 'not-init', '没接入的文件夹不收');
    await ui.call('/api/init', { dir: s.repo });
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const up = await upload('../截屏 1.png', png);
    assert.equal(up.status, 200, JSON.stringify(up.json));
    assert.match(up.json.path, /^\.relay\/uploads\/\d{4}-\d{4}-截屏 1\.png$/, '去掉了路径，前面加上时间');
    assert.deepEqual(fs.readFileSync(path.join(s.repo, up.json.path)), png);
    assert.equal(s.read('.relay/uploads/.gitignore'), '*\n', '整个 uploads 不进 git');
    const again = await upload('截屏 1.png', 'y');
    assert.notEqual(again.json.path, up.json.path, '同名不会盖掉');

    const raw = await fetch(`${base}/api/raw${q(s)}&path=${encodeURIComponent(up.json.path)}`);
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get('content-type'), 'image/png');
    assert.match(raw.headers.get('content-security-policy') ?? '', /sandbox/, '项目里的文件不能在接力台的网址下跑脚本');
    assert.deepEqual(Buffer.from(await raw.arrayBuffer()), png);
    assert.equal((await fetch(`${base}/api/raw${q(s)}&path=${encodeURIComponent('../x')}`)).status, 400, '出不了项目文件夹');

    // 只收 octet-stream（别的网站用表单发不了这种）；别的网站发来的一律不认
    assert.equal((await upload('b.txt', 'z', { 'content-type': 'text/plain' })).status, 403);
    assert.equal((await upload('b.txt', 'z', { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await ui.call(`/api/upload${q(s)}&name=b.txt`, { x: 1 })).status, 403, 'JSON 发到上传接口也不认');
    const big = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: ui.port, method: 'POST', path: `/api/upload${q(s)}&name=big.bin`, headers: { 'content-type': 'application/octet-stream', 'content-length': String(201 * 1024 * 1024) } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(big, 413, '太大的文件先看长度就拒绝');
    assert.deepEqual(fs.readdirSync(path.join(s.repo, '.relay', 'uploads')).filter((f) => f.endsWith('.tmp')), [], '没留下半截文件');
  } finally {
    ui.child.kill();
  }
});

test('还没有项目（从小程序启动，停在家目录）：网页请你选一个项目文件夹，不列家目录里的文件，也不把家目录放进项目列表', async () => {
  const s = sandbox('srv-pick');
  fs.writeFileSync(path.join(s.home, '私人笔记.txt'), '不该出现在网页上');
  const ui = await startUi(s);
  try {
    const home = `?dir=${encodeURIComponent(s.home)}`;
    const st = await ui.call(`/api/state${home}`);
    assert.equal(st.json.project.pick, true);
    assert.ok(!st.json.projects.some((p: { root: string }) => p.root === fs.realpathSync(s.home) || p.root === s.home), '家目录不进项目列表');
    assert.deepEqual((await ui.call(`/api/tree${home}`)).json.files, [], '不列家目录里的文件');
    const proj = await ui.call(`/api/state${q(s)}`);
    assert.equal(proj.json.project.pick, undefined, '真正的项目文件夹照常');
    assert.ok((await ui.call(`/api/tree${q(s)}`)).json.files.length > 0);
  } finally {
    ui.child.kill();
  }
});

test('不许接入整个家目录这种大文件夹', async () => {
  const s = sandbox('srv-home');
  const out = s.relay(['init'], false);
  assert.match(out, /接入了/);
  const bad = spawnRelay(s, ['init'], s.home);
  assert.match(bad, /太大了|不像是一个项目/);
});

function spawnRelay(s: Sandbox, args: string[], cwd: string): string {
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...s.env, HOME: s.home } });
  return (r.stdout ?? '') + (r.stderr ?? '');
}

