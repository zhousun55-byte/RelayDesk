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
 * - 只读（群聊 / 投票）：按提示词回答（投票时不投自己）。
 * 行为用环境变量控制：FAKE_<名字>_MODE = work / quota / nohandoff / blip-once / fail，FAKE_<名字>_WHO = 交接里写的身份。
 */
function fakeScript(name: 'claude' | 'codex'): string {
  const NAME = name.toUpperCase();
  const BT = '`';
  return [
    '#!/bin/sh',
    `NAME=${name}`,
    'case "$1" in',
    '  --version) [ "$NAME" = claude ] && echo "9.9.9 (Claude Code)" || echo "codex-cli 9.9.9"; exit 0 ;;',
    `  auth) echo '{"loggedIn":true,"authMethod":"fake"}'; exit 0 ;;`,
    '  login) echo "Logged in using ChatGPT"; exit 0 ;;',
    'esac',
    'ro=0; out=""; prev=""',
    'for a in "$@"; do',
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
    'say() {',
    '  if [ "$NAME" = claude ]; then',
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
    "  elif grep -q '各自先想' \"$P\"; then",
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
    '  blip-once)',
    '    if [ ! -f "$FAKE_DIR/$NAME-blipped" ]; then',
    '      touch "$FAKE_DIR/$NAME-blipped"',
    '      echo "API Error: Connection error (ECONNRESET)" >&2',
    '      exit 1',
    '    fi ;;',
    'esac',
    `H=$(sed -n 's/.*交接写在 ${BT}\\([^${BT}]*\\)${BT}.*/\\1/p' "$P" | head -1)`,
    "if grep -q '派来复核' \"$P\"; then",
    "  for n in $(grep '要复核的是' \"$P\" | grep -o '第 [0-9]* 棒' | grep -o '[0-9][0-9]*'); do",
    '    mkdir -p .relay/复核',
    `    printf '# 复核：第 %s 棒\\n\\n- 复核人：%s\\n- 结论：%s\\n\\n## 发现的问题和怎么处理的\\n\\n- 看过了，对得上\\n' "$n" "$WHO" "\${FAKE_REVIEW_VERDICT:-没问题}" > ".relay/复核/第$n棒.md"`,
    '  done',
    `  [ -n "$H" ] && printf '# 交接：%s\\n\\n- 状态：已交接\\n\\n## 做了什么\\n\\n- 复核了\\n' "$WHO" > "$H"`,
    '  say "复核完了"',
    '  exit 0',
    'fi',
    "if grep -q '派来做终审' \"$P\"; then",
    `  R=$(sed -n 's/.*结论写到 ${BT}\\([^${BT}]*\\)${BT}.*/\\1/p' "$P" | head -1)`,
    `  [ -n "$R" ] && printf '# 终审\\n\\n- 复核人：%s\\n- 结论：没问题\\n' "$WHO" > "$R"`,
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
    `[ "$NAME" = claude ] && printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"work.txt"}}]}}'`,
    'say "做完一步了"',
    '',
  ].join('\n');
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

/** 假的 OpenAI 接口：带工具时先写一个文件、再写交接、再 finish；不带工具时按群聊 / 投票回答。 */
export function mockLlm(): Promise<{ url: string; calls: { tools: boolean }[]; close: () => void }> {
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
        const j = JSON.parse(body) as { tools?: unknown[]; messages: { role: string; content?: string }[] };
        calls.push({ tools: !!j.tools });
        if (j.tools) {
          const first = String(j.messages.find((m) => m.role === 'user')?.content ?? '');
          const handoff = first.match(/交接写在 `([^`]+)`/)?.[1] ?? '.relay/交接/mock.md';
          const turns = j.messages.filter((m) => m.role === 'tool').length;
          const call =
            turns === 0
              ? { id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'notes/llm.txt', content: '模型写的\n' }) } }
              : turns === 1
                ? { id: 'c2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: handoff, content: '# 交接：DeepSeek 接口 · mock-coder\n\n- 状态：已交接\n\n## 做了什么\n\n- 写了 notes/llm.txt\n' }) } }
                : { id: 'c3', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ summary: '写好了' }) } };
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: turns === 0 ? '先写文件。' : '', tool_calls: [call] } }] }));
        } else {
          const text = String(j.messages.at(-1)?.content ?? '');
          const answer = /投票：<方案字母>/.test(text) ? '投票：A\n理由：简单' : /请给出你的方案/.test(text) ? '接口的方案：换个思路\n理由：试试' : '接口的看法';
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const a = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${a.port}/v1`, calls, close: () => server.close() });
    });
  });
}
