import fs from 'node:fs';
import path from 'node:path';
import { defaultRelayConfig, relayConfigPath } from './config';
import { RELAY_IDENTITY, git, repoRootAt } from './git';
import { ensureRelayGitignore } from './side';

export function adoptProject(root: string): string {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error('找不到这个文件夹');
  }

  try {
    repoRootAt(abs);
  } catch {
    const init = git(abs, ['init']);
    if (init.code !== 0) throw new Error(`做不成项目：${init.stderr || init.stdout}`);
    const empty = git(abs, ['status', '--porcelain']).stdout === '';
    if (empty) {
      fs.writeFileSync(path.join(abs, 'README.md'), `# ${path.basename(abs)}\n`);
    }
    ensureRelayGitignore(abs);
    const add = git(abs, ['add', '-A']);
    if (add.code !== 0) throw new Error(`做不成项目：${add.stderr || add.stdout}`);
    const commit = git(abs, [...RELAY_IDENTITY, 'commit', '-m', 'relay: 做成项目']);
    if (commit.code !== 0) throw new Error(`第一笔提交没做成：${commit.stderr || commit.stdout}`);
  }

  const gitRoot = repoRootAt(abs);
  const configPath = relayConfigPath(gitRoot);
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(defaultRelayConfig(), null, 2) + '\n');
  }
  ensureRelayGitignore(gitRoot);
  const watch = ['.relay/config.json', '.gitignore'];
  const porcelain = git(gitRoot, ['status', '--porcelain']).stdout;
  const pending = watch.filter((name) => porcelain.split('\n').some((line) => line.slice(3).trim() === name));
  if (pending.length > 0) {
    const add = git(gitRoot, ['add', '--', ...pending]);
    if (add.code !== 0) throw new Error(`配置没放进仓库：${add.stderr || add.stdout}`);
    const commit = git(gitRoot, [...RELAY_IDENTITY, 'commit', '-m', 'relay: init']);
    if (commit.code !== 0) throw new Error(`配置没提交：${commit.stderr || commit.stdout}`);
  }
  return gitRoot;
}
