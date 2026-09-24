import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLI = path.join(__dirname, '..', 'src', 'cli.js');

export interface Sandbox {
  base: string;
  home: string;
  repo: string;
  env: NodeJS.ProcessEnv;
  /** 跑 relay；expectFail=true 时失败才算对。返回合并后的输出。 */
  relay(args: string[], expectFail?: boolean): string;
  /** 异步跑 relay（测试里要同时开 mock 服务器时用，spawnSync 会卡住事件循环）。 */
  relayAsync(args: string[], extraEnv?: NodeJS.ProcessEnv): Promise<{ code: number; out: string }>;
  git(args: string[], cwd?: string): string;
  /** 写一个可执行的假脚本，返回路径。 */
  script(name: string, body: string): string;
  /** 账本里的所有事件。 */
  journal(): Record<string, unknown>[];
  /** 按编号折好的每一棒（取最后一条）。 */
  stints(): Record<string, any>[];
  write(rel: string, text: string): void;
  read(rel: string): string;
  exists(rel: string): boolean;
}

export function testEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    RELAY_HOME: path.join(home, '.relay'),
    RELAY_CLIPBOARD: 'off',
    RELAY_TERMINAL: 'off',
    RELAY_LOGIN_PATH: 'off',
    RELAY_SCAN_APPS: 'off',
    RELAY_AUTODETECT: 'off',
    GIT_CONFIG_NOSYSTEM: '1',
    NO_COLOR: '1',
  };
  delete env.DEEPSEEK_API_KEY;
  // 测试可能是在某个 AI 工具里跑的：去掉它注入的会话变量，结果不随在哪儿跑而变。
  for (const k of Object.keys(env)) if (/^(CLAUDECODE$|CLAUDE_|ANTHROPIC_|CODEX_|CURSOR_)/.test(k)) delete env[k];
  return env;
}

/** 一个干净的临时环境：假 HOME + 一个项目文件夹（默认是有一次提交的 git 仓库；git=false 时只是普通文件夹）。 */
export function sandbox(name: string, opts: { git?: boolean } = {}): Sandbox {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-${name}-`)));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(home);
  fs.mkdirSync(repo);
  const env = testEnv(home);
  const g = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
  fs.writeFileSync(path.join(repo, 'README.md'), 'demo\n');
  if (opts.git !== false) {
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 'test@example.com']);
    g(['config', 'user.name', 'test']);
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'init']);
  }
  const sb: Sandbox = {
    base,
    home,
    repo,
    env,
    relay(args, expectFail = false) {
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: 'utf8', env });
      const out = (r.stdout ?? '') + (r.stderr ?? '');
      if (!expectFail && r.status !== 0) throw new Error(`relay ${args.join(' ')} 失败：\n${out}`);
      if (expectFail && r.status === 0) throw new Error(`relay ${args.join(' ')} 应该失败却成功了：\n${out}`);
      return out;
    },
    relayAsync(args, extraEnv = {}) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [CLI, ...args], { cwd: repo, env: { ...env, ...extraEnv } });
        let out = '';
        child.stdout.on('data', (c) => (out += c));
        child.stderr.on('data', (c) => (out += c));
        child.on('close', (code) => resolve({ code: code ?? -1, out }));
      });
    },
    git: g,
    script(fileName, body) {
      const p = path.join(base, fileName);
      fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
      fs.chmodSync(p, 0o755);
      return p;
    },
    journal() {
      const p = path.join(repo, '.relay', 'journal.jsonl');
      if (!fs.existsSync(p)) return [];
      return fs
        .readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    },
    stints() {
      const byId = new Map<number, Record<string, any>>();
      for (const e of sb.journal()) if (e.type === 'stint') byId.set((e.stint as { id: number }).id, e.stint as Record<string, any>);
      for (const e of sb.journal()) {
        if (e.type !== 'rollback') continue;
        for (const id of (e.dropped as number[]) ?? []) if (byId.get(id)) byId.get(id)!.rolledBack = true;
        for (const id of (e.restored as number[]) ?? []) if (byId.get(id)) delete byId.get(id)!.rolledBack;
      }
      return [...byId.values()].sort((a, b) => a.id - b.id);
    },
    write(rel, text) {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), text);
    },
    read(rel) {
      return fs.readFileSync(path.join(repo, rel), 'utf8');
    },
    exists(rel) {
      return fs.existsSync(path.join(repo, rel));
    },
  };
  return sb;
}

export async function until(ms: number, fn: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待超时：${what}`);
}
