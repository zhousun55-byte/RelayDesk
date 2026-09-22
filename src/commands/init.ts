import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { repoRootAt } from '../core/git';
import { defaultRelayConfig } from '../core/config';
import { ensureRelayGitignore } from '../core/side';

export function initCommand(): Command {
  const cmd = new Command('init');
  cmd.description('在目标项目仓库初始化 .relay/config.json');
  cmd.action(() => {
    const root = repoRootAt(process.cwd());
    const relayDir = path.join(root, '.relay');
    const configPath = path.join(relayDir, 'config.json');
    if (fs.existsSync(configPath)) {
      throw new Error(`已初始化：${configPath} 已存在。如需重置请手工删除后重跑。`);
    }
    fs.mkdirSync(relayDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(defaultRelayConfig(), null, 2) + '\n');
    ensureRelayGitignore(root);
    console.log(`已创建 ${configPath}`);
    console.log('');
    console.log('接下来：');
    console.log('  1. 编辑 config.json：填写 gate.command（如 npm test）与 protectedPaths');
    console.log('  2. 把 .relay/config.json 提交进主线（协议三：只有它进主线）');
    console.log('  3. audit.apiKeyEnv 指向的 API key 只放环境变量，绝不写入仓库');
  });
  return cmd;
}
