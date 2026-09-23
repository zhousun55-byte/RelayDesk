import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { repoKey } from '../src/core/paths';
import { sandbox, until, type Sandbox } from './helpers';

/**
 * 全自动流水线的端到端测试。用假的 claude / codex 程序代替真的 AI：参数和输出格式跟真的一样
 * （claude -p --output-format stream-json；codex exec --json -o 文件 -），行为由环境变量控制。
 */

const FAKE_CLAUDE = String.raw`#!/bin/sh
case "$1" in
  --version) echo "9.9.9 (Claude Code)"; exit 0 ;;
  auth) echo '{"loggedIn":true,"authMethod":"fake"}'; exit 0 ;;
esac
ro=0
for a in "$@"; do [ "$a" = "--tools" ] && ro=1; done
cat > /dev/null
[ -n "$FAKE_LOG" ] && echo "claude $*" >> "$FAKE_LOG"
if [ $ro -eq 1 ]; then
  if [ "\${FAKE_CLAUDE_VERDICT:-pass}" = pass ]; then
    printf '%s\n' '{"type":"result","subtype":"success","result":"{\"verdict\":\"pass\",\"summary\":\"可以合\",\"issues\":[]}"}'
  else
    printf '%s\n' '{"type":"result","subtype":"success","result":"{\"verdict\":\"fix\",\"summary\":\"不行\",\"issues\":[\"再改改\"]}"}'
  fi
  exit 0
fi
case "\${FAKE_CLAUDE_MODE:-work}" in
  noop) printf '%s\n' '{"type":"result","subtype":"error","is_error":true,"result":"额度用完了"}'; exit 1 ;;
  slow) sleep 30 ;;
esac
if grep -q "hello 而不是 hi" .relay/ONBOARD.md 2>/dev/null; then echo hello > hello.txt; else echo hi > hello.txt; fi
printf '做到哪了：写了 hello.txt\n下一步：无\n没验证的假设：无\n' > .relay/NOTE.md
printf '%s\n' '{"type":"system","subtype":"init","model":"fake-claude"}'
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"hello.txt"}}]}}'
printf '%s\n' '{"type":"result","subtype":"success","result":"写好了","num_turns":2,"duration_ms":1200}'
`.replace(/\\\$\{/g, '${');

const FAKE_CODEX = String.raw`#!/bin/sh
case "$1" in
  --version) echo "codex-cli 9.9.9"; exit 0 ;;
  login) echo "Logged in using ChatGPT"; exit 0 ;;
esac
out=""; mode=""; prev=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  [ "$prev" = "-s" ] && mode="$a"
  prev="$a"
done
cat > /dev/null
[ -n "$FAKE_LOG" ] && echo "codex $*" >> "$FAKE_LOG"
if [ "$mode" = "read-only" ]; then
  n=0
  [ -f "$FAKE_DIR/reviews" ] && n=$(cat "$FAKE_DIR/reviews")
  n=$((n+1)); echo $n > "$FAKE_DIR/reviews"
  v=$(echo "\${FAKE_REVIEW_SEQ:-pass}" | cut -d, -f$n)
  [ -z "$v" ] && v=pass
  if [ "$v" = fix ]; then
    printf '%s' '好的，结论如下：{"verdict":"fix","summary":"内容不对","issues":["hello.txt 里要写 hello 而不是 hi"]}' > "$out"
  else
    printf '%s' '{"verdict":"pass","summary":"符合要求","issues":[]}' > "$out"
  fi
  printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"审查完了"}}'
  exit 0
fi
echo "from codex" > codex.txt
printf '%s\n' '{"type":"item.started","item":{"type":"command_execution","command":"echo from codex > codex.txt"}}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"做完了"}}'
printf '做完了' > "$out"
`.replace(/\\\$\{/g, '${');

/** 装好假工具：PATH 里只有假工具和系统命令，找不到这台电脑上真装着的 AI 工具。 */
function withFakes(s: Sandbox, extra: NodeJS.ProcessEnv = {}): void {
  const bin = path.join(s.base, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  for (const [name, body] of [
    ['claude', FAKE_CLAUDE],
    ['codex', FAKE_CODEX],
  ]) {
    fs.writeFileSync(path.join(bin, name), body);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  s.env.PATH = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
  s.env.FAKE_DIR = s.base;
  s.env.FAKE_LOG = path.join(s.base, 'fake.log');
  Object.assign(s.env, extra);
}

function autoState(s: Sandbox): Record<string, unknown> & { status: string; steps: { kind: string; status: string; label: string; detail?: string }[] } {
  const dir = path.join(s.home, '.relay', 'projects');
  for (const d of fs.readdirSync(dir)) {
    const p = path.join(dir, d, 'auto.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error('没有 auto.json');
}

function branchJournal(s: Sandbox): Record<string, unknown>[] {
  const branch = s.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/relay/']).split('\n')[0];
  return s
    .git(['show', `${branch}:.relay/journal.jsonl`])
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('自动识别：找到 claude / codex，登录状态和版本都认出来，并进工人名单', () => {
  const s = sandbox('detect');
  withFakes(s);
  const out = s.relay(['detect', '--offline']);
  assert.match(out, /Claude Code 9\.9\.9/);
  assert.match(out, /Codex 9\.9\.9/);
  assert.match(out, /已登录/);
  const reg = JSON.parse(fs.readFileSync(path.join(s.home, '.relay', 'agents.json'), 'utf8')) as { agents: { name: string; harness?: string }[] };
  assert.deepEqual(
    reg.agents.map((a) => [a.name, a.harness]),
    [
      ['claude', 'claude'],
      ['codex', 'codex'],
    ]
  );
  assert.match(out, /干活：Claude Code → Codex/);
  // 再识别一次不重复加人
  const again = s.relay(['detect', '--offline']);
  assert.match(again, /工人名单不用改/);
});

test('全自动：Claude 干活 → Codex 审查通过 → 自动合回，全程不用人动手', () => {
  const s = sandbox('auto-pass');
  withFakes(s);
  s.relay(['init']);
  s.relay(['detect', '--offline']);
  const out = s.relay(['auto', '做一个', 'hello.txt', '--work', 'claude', '--review', 'codex']);
  assert.match(out, /全自动开始/);
  assert.match(out, /完成：已合回正式文件夹/);
  assert.equal(s.read('hello.txt'), 'hi\n');
  assert.equal(s.git(['status', '--porcelain']), '', '正式文件夹是干净的');
  assert.equal(s.session(), null, '任务已收尾');
  const st = autoState(s);
  assert.equal(st.status, 'done');
  assert.deepEqual(
    st.steps.map((x) => x.kind),
    ['start', 'work', 'handoff', 'review', 'merge']
  );
  const j = branchJournal(s);
  const review = j.find((e) => e.type === 'review')!;
  assert.equal(review.verdict, 'pass');
  assert.equal(review.agent, 'codex');
  const run = j.find((e) => e.type === 'run')!;
  assert.equal(run.auto, true);
  const hand = j.find((e) => e.type === 'handoff' && !e.empty)!;
  assert.match(String(hand.selfNote), /写了 hello\.txt/, 'NOTE.md 进了交接记录');
  // 真的是按无人值守的参数调用的
  const log = fs.readFileSync(s.env.FAKE_LOG!, 'utf8');
  assert.match(log, /claude -p --output-format stream-json --verbose --permission-mode acceptEdits --settings/);
  assert.match(log, /codex exec --skip-git-repo-check .* -s read-only --ephemeral -/);
});

test('全自动：审查要求修改 → 第二轮带着审查意见改 → 通过后合回', () => {
  const s = sandbox('auto-fix');
  withFakes(s, { FAKE_REVIEW_SEQ: 'fix,pass' });
  s.relay(['init']);
  s.relay(['detect', '--offline']);
  s.relay(['auto', '做一个 hello.txt', '--work', 'claude', '--review', 'codex']);
  assert.equal(s.read('hello.txt'), 'hello\n', '第二轮按审查意见改成了 hello');
  const j = branchJournal(s);
  const reviews = j.filter((e) => e.type === 'review');
  assert.deepEqual(
    reviews.map((r) => r.verdict),
    ['fix', 'pass']
  );
  assert.deepEqual(reviews[0].issues, ['hello.txt 里要写 hello 而不是 hi']);
  const runs = j.filter((e) => e.type === 'run');
  assert.deepEqual(
    runs.map((r) => r.round),
    [1, 2]
  );
});

test('全自动：审查一直不通过 → 到轮数上限停下，交给人', () => {
  const s = sandbox('auto-exhaust');
  withFakes(s, { FAKE_REVIEW_SEQ: 'fix,fix,fix,fix' });
  s.relay(['init']);
  s.relay(['detect', '--offline']);
  const out = s.relay(['auto', '做一个 hello.txt', '--work', 'claude', '--review', 'codex', '--rounds', '2'], true);
  assert.match(out, /需要你来看一下/);
  assert.match(out, /改了 2 轮/);
  assert.equal(autoState(s).status, 'needs-human');
  assert.ok(s.session(), '任务还在，没合回');
  assert.ok(!s.exists('hello.txt'), '正式文件夹没动');
});

test('全自动：主力没做出改动（比如额度用完）→ 自动换下一位', () => {
  const s = sandbox('auto-fallback');
  withFakes(s, { FAKE_CLAUDE_MODE: 'noop' });
  s.relay(['init']);
  s.relay(['detect', '--offline']);
  const out = s.relay(['auto', '随便做点什么', '--work', 'claude,codex', '--review', 'claude,codex']);
  assert.match(out, /完成/);
  assert.equal(s.read('codex.txt'), 'from codex\n');
  const st = autoState(s);
  const kinds = st.steps.map((x) => `${x.kind}:${x.status}`);
  assert.ok(kinds.includes('work:fail'), 'Claude 那一段记为失败');
  assert.ok(kinds.includes('handoff:skip'), '空交接让它下岗');
  const j = branchJournal(s);
  const review = j.find((e) => e.type === 'review')!;
  assert.equal(review.agent, 'claude', '审查员挑了和干活的人（codex）不同的');
});

test('全自动：中途叫停 → 工具被结束、状态是已停止；再「继续」就接着做完', async () => {
  const s = sandbox('auto-stop');
  withFakes(s, { FAKE_CLAUDE_MODE: 'slow' });
  s.relay(['init']);
  s.relay(['detect', '--offline']);
  const run = s.relayAsync(['auto', '做一个 hello.txt', '--work', 'claude', '--review', 'codex']);
  await until(15_000, () => {
    try {
      return autoState(s).steps.some((x) => x.kind === 'work' && x.status === 'running');
    } catch {
      return false;
    }
  }, '开始干活');
  const stop = await s.relayAsync(['auto', '--stop']);
  assert.match(stop.out, /停止请求/);
  const r = await run;
  assert.equal(r.code, 1);
  assert.match(r.out, /已停止/);
  assert.equal(autoState(s).status, 'stopped');
  assert.ok(!fs.existsSync(path.join(s.session()!.worktree, '.relay', 'session.lock')), '锁已释放');
  // 继续：这次正常干活
  s.env.FAKE_CLAUDE_MODE = 'work';
  const out = s.relay(['auto', '--work', 'claude', '--review', 'codex']);
  assert.match(out, /完成/);
  assert.equal(s.read('hello.txt'), 'hi\n');
});

test('全自动：已有进行中的任务时写新目标会被拒绝；没有工具时说清楚怎么办', () => {
  const s = sandbox('auto-guards');
  withFakes(s);
  s.relay(['init']);
  const none = s.relay(['auto', '做点什么', '--work', 'nobody'], true);
  assert.match(none, /不在工人名单里|没有能全自动干活的工人/);
  s.relay(['detect', '--offline']);
  s.relay(['start', '手动开的任务']);
  const dup = s.relay(['auto', '另一个目标'], true);
  assert.match(dup, /已经有一个进行中的任务/);
});

/** 假的 OpenAI 兼容接口：带工具时扮演干活的模型（先写文件、再 finish），不带工具时扮演审查员。 */
function mockLlm(): Promise<{ url: string; calls: { tools: boolean }[]; close: () => void }> {
  return new Promise((resolve) => {
    const calls: { tools: boolean }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url?.endsWith('/models')) {
          res.end(JSON.stringify({ data: [{ id: 'mock-coder' }] }));
          return;
        }
        const j = JSON.parse(body) as { tools?: unknown[]; messages: { role: string }[] };
        calls.push({ tools: !!j.tools });
        if (j.tools) {
          const toolTurns = j.messages.filter((m) => m.role === 'tool').length;
          const call =
            toolTurns === 0
              ? { id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'notes/llm.txt', content: '模型写的\n' }) } }
              : { id: 'c2', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ summary: '做到哪了：写好了\n下一步：无\n没验证的假设：无' }) } };
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: toolTurns === 0 ? '先写文件。' : '', tool_calls: [call] } }] }));
        } else {
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"verdict":"pass","summary":"没问题","issues":[]}' } }] }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const a = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${a.port}/v1`, calls, close: () => server.close() });
    });
  });
}

test('只有接口的模型也能全自动干活：内置小代理用工具写文件，接口模型审查', async () => {
  const s = sandbox('auto-llm');
  withFakes(s, { MOCK_KEY: 'k-test' });
  s.relay(['init']);
  const mock = await mockLlm();
  try {
    s.relay(['workers', 'add', 'mock', '--kind', 'api', '--api-base', mock.url, '--api-model', 'mock-coder', '--api-key-env', 'MOCK_KEY']);
    const r = await s.relayAsync(['auto', '写一条笔记', '--work', 'mock', '--review', 'mock']);
    assert.equal(r.code, 0, r.out);
    assert.equal(s.read('notes/llm.txt'), '模型写的\n');
    assert.ok(mock.calls.filter((c) => c.tools).length >= 2, '干活时带着工具调了至少两次');
    assert.ok(mock.calls.some((c) => !c.tools), '审查时不带工具');
    const j = branchJournal(s);
    assert.match(String(j.find((e) => e.type === 'handoff' && !e.empty)!.selfNote), /写好了/);
  } finally {
    mock.close();
  }
});

test('relay auto --status：列出步骤和最近的日志', () => {
  const s = sandbox('auto-status');
  withFakes(s);
  s.relay(['init']);
  s.relay(['detect', '--offline']);
  s.relay(['auto', '做一个 hello.txt', '--work', 'claude', '--review', 'codex']);
  const out = s.relay(['auto', '--status']);
  assert.match(out, /完成/);
  assert.match(out, /Claude Code.*干活/);
  assert.match(out, /Codex.*审查/);
  assert.match(out, /日志/);
});

test('上次接力台被关掉时还在跑的工具：再开始全自动前先把它结束掉，不会两个 AI 同时改', async () => {
  const s = sandbox('auto-leftover');
  withFakes(s);
  s.relay(['init']);
  s.relay(['detect', '--offline']);
  const orphan = spawn('sh', ['-c', 'sleep 60'], { detached: true, stdio: 'ignore' });
  orphan.unref();
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(orphan.pid && alive(orphan.pid));
  const dir = path.join(s.home, '.relay', 'projects', repoKey(s.repo));
  fs.mkdirSync(dir, { recursive: true });
  const t = new Date().toISOString();
  fs.writeFileSync(
    path.join(dir, 'auto.json'),
    JSON.stringify({
      id: 'old',
      root: s.repo,
      pid: 2147483646,
      goal: '上次的',
      status: 'running',
      phase: '',
      round: 1,
      maxRounds: 3,
      level: 'safe',
      autoMerge: true,
      team: { workers: [], reviewers: [] },
      startedAt: t,
      updatedAt: t,
      steps: [{ n: 1, kind: 'work', label: '上次的干活', status: 'running', startedAt: t, pid: orphan.pid }],
    })
  );
  const status = s.relay(['auto', '--status']);
  assert.match(status, /被中断/, '接力台不在了：显示为被中断，不算「还在跑」');
  s.relay(['auto', '做一个 hello.txt', '--work', 'claude', '--review', 'codex']);
  await until(5000, () => !alive(orphan.pid!), '残留的工具进程被结束');
  assert.equal(s.read('hello.txt'), 'hi\n');
});
