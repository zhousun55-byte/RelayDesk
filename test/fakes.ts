import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Sandbox } from './helpers';

/**
 * 假的 claude / codex：参数和输出格式跟真的一样（claude -p --output-format stream-json，提示词从标准输入；
 * codex exec --json -o 文件 -），照着接力台给的提示词干活：
 * - 干活：在 work.txt 里加一行，把任务清单里第一个没打勾的打上勾，按提示词里给的文件名写交接；
 * - 复核：给「要复核的是」里的每一棒写复核结论；
 * - 终审：写终审结论，交接状态写「全部完成」；
 * - 拆解（派活）：把任务清单换成 4 步；
 * - 只读（群聊 / 投票）：按提示词回答（投票时不投自己）。
 * 行为用环境变量控制：FAKE_<名字>_MODE = work / quota / nohandoff / blip-once / fail / slow（先把进程号写进 FAKE_DIR/<名字>.pid，
 * 睡 30 秒再干活），FAKE_<名字>_WHO = 交接里写的身份；FAKE_REVIEW_SAY = 复核完说的那句话。
 * claude 带 --setting-sources（跳过用户设置）时扮演「官方账号」：FAKE_CLAUDE_OFFICIAL=pro 算登录了，
 * 身份和行为看 FAKE_CLAUDE_OFFICIAL_WHO / FAKE_CLAUDE_OFFICIAL_MODE；这时环境里还带着 ANTHROPIC_* 就报错（说明接力台没去掉）。
 */
function fakeScript(name: 'claude' | 'codex'): string {
  const NAME = name.toUpperCase();
  const BT = '`';
  return [
    '#!/bin/sh',
    `NAME=${name}`,
    'OFFICIAL=0; AUTH=0',
    'for a in "$@"; do',
    '  [ "$a" = "--setting-sources" ] && OFFICIAL=1',
    '  [ "$a" = auth ] && AUTH=1',
    'done',
    'if [ $AUTH -eq 1 ]; then',
    '  if [ $OFFICIAL -eq 0 ]; then',
    `    echo '{"loggedIn":true,"authMethod":"fake"}'`,
    '  elif [ "$FAKE_CLAUDE_OFFICIAL" = pro ]; then',
    `    echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro","apiProvider":"firstParty"}'`,
    '  else',
    `    echo '{"loggedIn":false}'`,
    '  fi',
    '  exit 0',
    'fi',
    'case "$1" in',
    '  --version) [ "$NAME" = claude ] && echo "9.9.9 (Claude Code)" || echo "codex-cli 9.9.9"; exit 0 ;;',
    '  login) echo "Logged in using ChatGPT"; exit 0 ;;',
    'esac',
    'ro=0; out=""; prev=""; MARG=""',
    'for a in "$@"; do',
    '  [ "$prev" = "--model" ] && MARG="$a"',
    '  [ "$a" = "--tools" ] && ro=1',
    '  [ "$prev" = "-s" ] && [ "$a" = "read-only" ] && ro=1',
    '  [ "$prev" = "-o" ] && out="$a"',
    '  prev="$a"',
    'done',
    'P="$FAKE_DIR/prompt-$NAME-$$.txt"',
    'cat > "$P"',
    '[ -n "$FAKE_LOG" ] && echo "$NAME $*" >> "$FAKE_LOG"',
    `MODE="$FAKE_${NAME}_MODE"`,
    `WHO="$FAKE_${NAME}_WHO"`,
    '[ -z "$MODE" ] && MODE=work',
    '[ -z "$WHO" ] && WHO="$NAME"',
    'MODEL="${FAKE_CLAUDE_MODEL:-deepseek-v4-flash}"',
    // 真的 Claude Code：开头 init 报「deepseek-v4-flash[1m]」「claude-opus-5」这种，回复里才是准确的模型名。
    'INIT_MODEL="$MODEL[1m]"',
    'if [ $OFFICIAL -eq 1 ]; then',
    '  if [ -n "$ANTHROPIC_BASE_URL$ANTHROPIC_AUTH_TOKEN$ANTHROPIC_MODEL" ]; then echo "官方账号还带着 ANTHROPIC_* 变量，会被接到别家模型" >&2; exit 3; fi',
    '  MODE="${FAKE_CLAUDE_OFFICIAL_MODE:-work}"',
    '  WHO="${FAKE_CLAUDE_OFFICIAL_WHO:-Claude Code · claude-opus-5-5}"',
    '  MODEL="${FAKE_CLAUDE_OFFICIAL_MODEL:-claude-opus-5-5}"',
    '  INIT_MODEL=claude-opus-5',
    'fi',
    `[ "$NAME" = claude ] && printf '{"type":"system","subtype":"init","model":"%s"}\\n' "$INIT_MODEL"`,
    // 命令行太旧（2026-09-25 真实遇到的）：除了简称 opus，别的模型都说要更新的版本。
    'if [ "$MODE" = too-old ]; then',
    '  if [ "$MARG" != opus ]; then',
    '    T="API Error: 400 Claude Code 9.9.9 does not support this model; version 99.0.0 or newer is required. Run claude update, or update the Claude desktop app, then try again."',
    `    printf '{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"%s"}]}}\\n' "$T"`,
    `    printf '{"type":"result","subtype":"success","is_error":true,"result":"%s"}\\n' "$T"`,
    '    exit 1',
    '  fi',
    '  MODE=work',
    'fi',
    'say() {',
    '  if [ "$NAME" = claude ]; then',
    `    printf '{"type":"assistant","message":{"model":"%s","content":[{"type":"text","text":"%s"}]}}\\n' "$MODEL" "$1"`,
    `    printf '{"type":"result","subtype":"success","result":"%s"}\\n' "$1"`,
    '  else',
    `    printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\\n' "$1"`,
    '    [ -n "$out" ] && printf "$1" > "$out"',
    '  fi',
    '}',
    'if [ $ro -eq 1 ]; then',
    "  if grep -q '投票：<方案字母>' \"$P\"; then",
    "    own=$(sed -n 's/.*其中方案 \\([A-L]\\) 是你自己出的.*/\\1/p' \"$P\" | head -1)",
    '    pick=A; [ "$own" = A ] && pick=B',
    '    say "投票：$pick\\n理由：$NAME 觉得这个更稳"',
    "  elif grep -q '请给出你的方案' \"$P\"; then",
    '    say "$NAME 的方案：先做最小能用的版本\\n理由：快，出问题好退回"',
    "  elif grep -q '这一轮是「对比」' \"$P\"; then",
    '    say "$NAME 独立想了想：可以"',
    '  else',
    '    say "$NAME 的看法：同意"',
    '  fi',
    '  exit 0',
    'fi',
    'case "$MODE" in',
    '  quota)',
    '    if [ "$NAME" = claude ]; then',
    '      echo "Claude AI usage limit reached. Your limit will reset at 3pm." >&2',
    `      printf '%s\\n' '{"type":"result","subtype":"error","is_error":true,"result":"Claude AI usage limit reached"}'`,
    '    else',
    '      echo "ERROR: You have hit your usage limit. Upgrade to Pro or try again in 2 hours 5 minutes." >&2',
    '    fi',
    '    exit 1 ;;',
    '  fail) echo "something broke" >&2; exit 2 ;;',
    // 新版 Claude Code 额度用完：一句工具自己拼的话（模型是 <synthetic>），结果标出错，退出码 1。
    '  session-limit)',
    '    T="You\'ve hit your session limit · resets 3:50am (Asia/Shanghai)"',
    `    printf '{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"%s"}]}}\\n' "$T"`,
    `    printf '{"type":"result","subtype":"success","is_error":true,"result":"%s"}\\n' "$T"`,
    '    exit 1 ;;',
    '  slow) echo $$ > "$FAKE_DIR/$NAME.pid"; sleep 30 ;;',
    '  blip-once)',
    '    if [ ! -f "$FAKE_DIR/$NAME-blipped" ]; then',
    '      touch "$FAKE_DIR/$NAME-blipped"',
    '      echo "API Error: Connection error (ECONNRESET)" >&2',
    '      exit 1',
    '    fi ;;',
    'esac',
    `H=$(sed -n 's/.*交接写在 ${BT}\\([^${BT}]*\\)${BT}.*/\\1/p' "$P" | head -1)`,
    // 拆解：把「进度」换成 4 步（第一步下面带一行做法），交接写「拆成 4 步」。
    "if grep -q '派来拆解' \"$P\"; then",
    '  T=.relay/任务.md',
    "  awk '/^## 进度/{print; print \"\"; print \"- [ ] 第一步：建 a.txt\"; print \"  - 改 a.txt：写一行 a\"; print \"- [ ] 第二步：建 b.txt\"; print \"- [ ] 第三步：建 c.txt\"; print \"- [ ] 第四步：建 d.txt\"; print \"\"; skip=1; next} skip && /^## /{skip=0} !skip{print}' \"$T\" > \"$T.tmp\" && mv \"$T.tmp\" \"$T\"",
    `  [ -n "$H" ] && printf '# 交接：%s\\n\\n- 状态：已交接\\n\\n## 做了什么\\n\\n- 把任务拆成 4 步\\n' "$WHO" > "$H"`,
    '  say "拆好了"',
    '  exit 0',
    'fi',
    "if grep -q '派来复核' \"$P\"; then",
    "  for n in $(grep '要复核的是' \"$P\" | grep -o '第 [0-9]* 棒' | grep -o '[0-9][0-9]*'); do",
    '    mkdir -p .relay/复核',
    `    printf '# 复核：第 %s 棒\\n\\n- 复核人：%s\\n- 结论：%s\\n\\n## 发现的问题和怎么处理的\\n\\n- 看过了，对得上\\n' "$n" "$WHO" "\${FAKE_REVIEW_VERDICT:-没问题}" > ".relay/复核/第\${n}棒.md"`,
    '  done',
    `  [ -n "$H" ] && printf '# 交接：%s\\n\\n- 状态：已交接\\n\\n## 做了什么\\n\\n- 复核了\\n' "$WHO" > "$H"`,
    '  say "${FAKE_REVIEW_SAY:-复核完了}"',
    '  exit 0',
    'fi',
    "if grep -q '派来做终审' \"$P\"; then",
    '  [ "$MODE" = final-fail ] && { echo "终审的时候出错了" >&2; exit 2; }',
    `  R=$(sed -n 's/.*结论写到 ${BT}\\([^${BT}]*\\)${BT}.*/\\1/p' "$P" | head -1)`,
    // 真的 Codex 终审时标题写成了「复核：第 5 棒终审」（5 是终审自己这一棒）。
    `  SELF=$(echo "$H" | sed -n 's/.*第\\([0-9]*\\)棒.*/\\1/p')`,
    `  [ -n "$R" ] && printf '# 复核：第 %s 棒终审\\n\\n- 复核人：%s\\n- 结论：%s\\n' "$SELF" "$WHO" "\${FAKE_FINAL_VERDICT:-没问题}" > "$R"`,
    `  [ -n "$H" ] && printf '# 交接：%s\\n\\n- 状态：全部完成\\n\\n## 做了什么\\n\\n- 终审过了，整件事没问题\\n' "$WHO" > "$H"`,
    '  say "终审完了"',
    '  exit 0',
    'fi',
    'echo "$NAME 干了一步" >> work.txt',
    'T=.relay/任务.md',
    'if [ -f "$T" ]; then',
    `  awk '!d && /^- \\[ \\] / {sub(/- \\[ \\] /, "- [x] "); d=1} {print}' "$T" > "$T.tmp" && mv "$T.tmp" "$T"`,
    'fi',
    'state=已交接',
    "grep -q '^- \\[ \\] ' \"$T\" 2>/dev/null || state=全部完成",
    'if [ "$MODE" != nohandoff ] && [ -n "$H" ]; then',
    '  mkdir -p "$(dirname "$H")"',
    `  printf '# 交接：%s\\n\\n- 状态：%s\\n\\n## 做了什么\\n\\n- 在 work.txt 里加了一行，打了一个勾\\n\\n## 没做完 / 下一步\\n\\n- 接着做清单里没打勾的\\n' "$WHO" "$state" > "$H"`,
    'fi',
    `[ "$NAME" = claude ] && printf '{"type":"assistant","message":{"model":"%s","content":[{"type":"tool_use","name":"Write","input":{"file_path":"work.txt"}}]}}\\n' "$MODEL"`,
    'say "做完一步了"',
    '',
  ].join('\n');
}

/**
 * 假的 DeepSeek Harness 无界面模式（dsh --profile headless --patch 文件 --json -）：
 * 任务从标准输入读，按行吐 JSON 事件（session / tool_call / text / final）；干活方式和别的假工具一样。
 * FAKE_DSH_MODE=quota 时报「dsh: ACCOUNT_QUOTA」。调用参数、DSH_PERMISSION_MODE、带来的覆盖层都记下来。
 */
function fakeDsh(): string {
  const BT = '`';
  return [
    '#!/bin/sh',
    '[ -n "$FAKE_LOG" ] && echo "dsh $* PERM=$DSH_PERMISSION_MODE" >> "$FAKE_LOG"',
    '[ "$1" = --version ] && { echo "0.1.7-rc.2"; exit 0; }',
    'P="$FAKE_DIR/prompt-dsh-$$.txt"',
    'cat > "$P"',
    'prev=""; for a in "$@"; do [ "$prev" = "--patch" ] && cp "$a" "$FAKE_DIR/dsh-patch-seen.yml"; prev="$a"; done',
    `echo '{"type":"session","id":"session-fake"}'`,
    'if [ "$FAKE_DSH_MODE" = quota ]; then',
    `  echo '{"type":"error","code":"ACCOUNT_QUOTA","message":"账号余额不足"}'`,
    '  echo "dsh: ACCOUNT_QUOTA: 账号余额不足" >&2',
    '  exit 1',
    'fi',
    `H=$(sed -n 's/.*交接写在 ${BT}\\([^${BT}]*\\)${BT}.*/\\1/p' "$P" | head -1)`,
    'echo "dsh 干了一步" >> work.txt',
    'T=.relay/任务.md',
    `[ -f "$T" ] && awk '!d && /^- \\[ \\] / {sub(/- \\[ \\] /, "- [x] "); d=1} {print}' "$T" > "$T.tmp" && mv "$T.tmp" "$T"`,
    `[ -n "$H" ] && mkdir -p "$(dirname "$H")" && printf '# 交接：DeepSeek Harness · deepseek-flash\\n\\n- 状态：已交接\\n\\n## 做了什么\\n\\n- 在 work.txt 里加了一行\\n' > "$H"`,
    `echo '{"type":"tool_call","name":"write_file","args":{"path":"work.txt"}}'`,
    `echo '{"type":"text","text":"做完一步了"}'`,
    `echo '{"type":"final","text":"做完一步了"}'`,
    '',
  ].join('\n');
}

/** 装上假的 DeepSeek Harness：dsh 命令 + ~/.dsh 里桌面版的账号设置（DeepSeek 账号、deepseek-flash）。 */
export function withFakeDsh(s: Sandbox): void {
  const bin = path.join(s.base, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'dsh'), fakeDsh());
  fs.chmodSync(path.join(bin, 'dsh'), 0o755);
  const prof = path.join(s.home, '.dsh', 'profiles', 'desktop');
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(s.home, '.dsh', '.credentials.yaml'), '# 假的\n');
  fs.writeFileSync(
    path.join(prof, 'cordis.patch.yml'),
    ['# Your patch layer', '- id: agent-default-model', '  name: "@deepseek-ai/dsh-agent-default-model"', '  config:', '    provider: deepseek-account', '    model: deepseek-flash', '    reasoningEffort: high', '- id: ui-chat', '  config:', '    transcriptView: standard', ''].join('\n')
  );
}

/**
 * 装上假的「Claude 桌面版自带的 Claude Code」：一个新版本目录，里面的 claude 记一笔（带没带 DISABLE_AUTOUPDATER）再转给假 claude。
 */
export function withFakeDesktopClaude(s: Sandbox, version = '2.1.281'): string {
  const dir = path.join(s.base, 'claude-desktop');
  const exe = path.join(dir, version, 'claude.app', 'Contents', 'MacOS', 'claude');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, `#!/bin/sh\n[ -n "$FAKE_LOG" ] && [ "$1" != --version ] && echo "desktop-claude DISABLE_AUTOUPDATER=$DISABLE_AUTOUPDATER $*" >> "$FAKE_LOG"\n[ "$1" = --version ] && { echo "${version} (Claude Code)"; exit 0; }\nexec "${path.join(s.base, 'fakebin', 'claude')}" "$@"\n`);
  fs.chmodSync(exe, 0o755);
  s.env.RELAY_CLAUDE_DESKTOP_DIR = dir;
  return exe;
}

/**
 * 装好假工具：PATH 里只有假工具和系统命令。Claude Code 配成走 DeepSeek（弱），Codex 用 gpt-6（强）。
 */
export function withFakes(s: Sandbox, extra: NodeJS.ProcessEnv = {}): void {
  const bin = path.join(s.base, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['claude', 'codex'] as const) {
    fs.writeFileSync(path.join(bin, name), fakeScript(name));
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  fs.mkdirSync(path.join(s.home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(s.home, '.claude', 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'fake', ANTHROPIC_MODEL: 'deepseek-v4-flash' } })
  );
  fs.mkdirSync(path.join(s.home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(s.home, '.codex', 'config.toml'), 'model = "gpt-6"\nmodel_reasoning_effort = "low"\n');
  s.env.PATH = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
  s.env.FAKE_DIR = s.base;
  s.env.FAKE_LOG = path.join(s.base, 'fake.log');
  s.env.FAKE_CLAUDE_WHO = 'Claude Code · deepseek-v4-flash';
  s.env.FAKE_CODEX_WHO = 'Codex · gpt-6';
  s.env.RELAY_RETRY_MS = '50';
  Object.assign(s.env, extra);
}

/** 设好派活顺序（~/.relay/auto.json）。 */
export function setOrder(s: Sandbox, order: string[], extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(s.home, '.relay'), { recursive: true });
  fs.writeFileSync(path.join(s.home, '.relay', 'auto.json'), JSON.stringify({ order, ...extra }));
}

/** 假的 OpenAI 接口：带全套工具时先写一个文件、再写交接、再 finish；只带看的工具时（群聊）读 README 再回答；不带工具时按群聊 / 投票回答。 */
export function mockLlm(): Promise<{ url: string; calls: { tools: boolean }[]; toolResults: string[]; close: () => void }> {
  return new Promise((resolve) => {
    const calls: { tools: boolean }[] = [];
    /** 小代理交回来的工具结果（按顺序）。 */
    const toolResults: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url?.endsWith('/models')) {
          res.end(JSON.stringify({ data: [{ id: 'mock-coder' }] }));
          return;
        }
        const j = JSON.parse(body) as { tools?: { function?: { name?: string } }[]; messages: { role: string; content?: string }[] };
        calls.push({ tools: !!j.tools });
        if (j.tools) {
          const first = String(j.messages.find((m) => m.role === 'user')?.content ?? '');
          const handoff = first.match(/交接写在 `([^`]+)`/)?.[1] ?? '.relay/交接/mock.md';
          const results = j.messages.filter((m) => m.role === 'tool').map((m) => String(m.content ?? ''));
          toolResults.splice(0, toolResults.length, ...results);
          const turns = results.length;
          if (!j.tools.some((x) => x.function?.name === 'write_file')) {
            // 群聊：只给了看的工具。先硬要写一个文件（该被拒），再读 README.md，最后照读到的回答。
            const look =
              turns === 0
                ? { id: 'r0', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'hack.txt', content: 'x' }) } }
                : turns === 1
                  ? { id: 'r1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } }
                  : null;
            res.end(JSON.stringify({ choices: [{ message: look ? { role: 'assistant', content: '', tool_calls: [look] } : { role: 'assistant', content: `接口读到：${results[1]}` } }] }));
            return;
          }
          const call =
            turns === 0
              ? { id: 'c0', type: 'function', function: { name: 'search', arguments: JSON.stringify({ pattern: 'demo|笔记' }) } }
              : turns === 1
                ? { id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'notes/llm.txt', content: '模型写的\n' }) } }
                : turns === 2
                  ? { id: 'c2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: handoff, content: '# 交接：DeepSeek 接口 · mock-coder\n\n- 状态：已交接\n\n## 做了什么\n\n- 写了 notes/llm.txt\n' }) } }
                  : { id: 'c3', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ summary: '写好了' }) } };
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: turns === 0 ? '先搜一下。' : '', tool_calls: [call] } }] }));
        } else {
          const text = String(j.messages.at(-1)?.content ?? '');
          const answer = /投票：<方案字母>/.test(text) ? '投票：A\n理由：简单' : /请给出你的方案/.test(text) ? '接口的方案：换个思路\n理由：试试' : '接口的看法';
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const a = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${a.port}/v1`, calls, toolResults, close: () => server.close() });
    });
  });
}
