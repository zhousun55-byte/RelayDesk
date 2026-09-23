import type { AgentConfig } from './types';

export interface Preset {
  id: string;
  title: string;
  hint: string;
  agent: AgentConfig;
}

/**
 * 常用工人的现成配置。命令都按 macOS 写：桌面 App 用 `open -a`（不依赖各家命令行是否装好、有没有被改名），
 * 终端工具用它们自己的命令。只是起点，添加后都能改。
 */
export const PRESETS: Preset[] = [
  {
    id: 'claude',
    title: 'Claude Code（终端）',
    hint: '能全自动干活、审查、讨论；也能手动在终端里上岗。',
    agent: {
      name: 'claude',
      label: 'Claude Code',
      kind: 'cli',
      cmd: 'claude',
      tier: 'strong',
      prompt: { mode: 'arg' },
      harness: 'claude',
    },
  },
  {
    id: 'codex',
    title: 'Codex（终端）',
    hint: '能全自动干活、审查、讨论；也能手动在终端里上岗。',
    agent: {
      name: 'codex',
      label: 'Codex',
      kind: 'cli',
      cmd: 'codex',
      tier: 'strong',
      prompt: { mode: 'arg' },
      harness: 'codex',
    },
  },
  {
    id: 'cursor',
    title: 'Cursor（桌面）',
    hint: '用 Cursor 打开隔离副本，在它的 AI 对话里干活。',
    agent: { name: 'cursor', label: 'Cursor', kind: 'app', cmd: 'open -a Cursor {{worktree}}', tier: 'strong' },
  },
  {
    id: 'zcode',
    title: 'ZCode（桌面）',
    hint: '用 ZCode 打开隔离副本。',
    agent: { name: 'zcode', label: 'ZCode', kind: 'app', cmd: 'open -a ZCode {{worktree}}', tier: 'strong' },
  },
  {
    id: 'mimo',
    title: 'MiMo（桌面）',
    hint: '用小米 MiMo 打开隔离副本。',
    agent: { name: 'mimo', label: 'MiMo', kind: 'app', cmd: 'open -a "Xiaomi MiMo" {{worktree}}', tier: 'strong' },
  },
  {
    id: 'app',
    title: '其他桌面 App',
    hint: '把「应用名」换成 App 在「应用程序」里的名字。',
    agent: { name: 'myapp', label: '我的 App', kind: 'app', cmd: 'open -a "应用名" {{worktree}}', tier: 'strong' },
  },
  {
    id: 'deepseek',
    title: 'DeepSeek（接口）',
    hint: '走 API：能审查、讨论，也能用内置小代理干活。密钥放在环境变量 DEEPSEEK_API_KEY 里。',
    agent: {
      name: 'deepseek',
      label: 'DeepSeek',
      kind: 'api',
      tier: 'weak',
      api: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    },
  },
  {
    id: 'api',
    title: '其他 API 模型',
    hint: '任何 OpenAI 兼容接口（智谱、Kimi、通义……）；Anthropic 兼容的在表单里改协议。',
    agent: { name: 'myapi', label: '我的模型', kind: 'api', tier: 'weak', api: { baseUrl: 'https://', model: '', apiKeyEnv: 'MY_API_KEY' } },
  },
  {
    id: 'cli',
    title: '其他终端工具',
    hint: '任何能在终端里启动的 AI 工具。',
    agent: { name: 'mycli', label: '我的工具', kind: 'cli', cmd: '', tier: 'strong', prompt: { mode: 'file' } },
  },
];

export function findPreset(id: string): Preset | null {
  return PRESETS.find((p) => p.id === id) ?? null;
}
