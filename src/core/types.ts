// 接力台的数据格式。journal / agents.json / config.json 都要和旧版兼容：只加可选字段，不改旧字段语义。

export type Tier = 'strong' | 'weak';

/**
 * 工人类型：
 * - cli：终端里的编程工具（Claude Code、Codex……）。认得的（harness）接力台能替你调度；
 * - app：桌面程序（Cursor、ZCode、MiMo……）。cmd 是「打开文件夹」的命令，含 {{dir}}；接力台调度不了，你自己在里面接着做；
 * - api：只有接口的模型（DeepSeek……）。接力台用内置小代理让它干活，也能复核、群聊。
 * 旧名单没有 kind 字段，一律按 cli。
 */
export type AgentKind = 'cli' | 'app' | 'api';

export interface ApiSpec {
  /** 接口地址，如 https://api.deepseek.com */
  baseUrl: string;
  model: string;
  /** 放密钥的环境变量名。密钥本身永远不写进文件。 */
  apiKeyEnv: string;
  /** 接口协议：openai（/chat/completions，默认）或 anthropic（/v1/messages）。 */
  format?: 'openai' | 'anthropic';
  /**
   * 密钥不在环境变量里、而在别的工具的配置文件里（用户同意后才会这样配）。
   * 形如 mimocode:xiaomi-token-plan-cn。只在调用时读进内存，不复制到任何地方。
   */
  keyFrom?: string;
}

/** 全局工人名单 ~/.relay/agents.json 里的一条。 */
export interface AgentConfig {
  /** 唯一名（英文、数字、-、_），命令里用它：relay go claude。 */
  name: string;
  /** 显示名，如「Claude Code」。没有就用 name。 */
  label?: string;
  kind?: AgentKind;
  /** cli：终端里的命令；app：打开文件夹的命令（含 {{dir}}）；api：不用。 */
  cmd?: string;
  /** 强 / 弱。弱模型做的棒要等强模型复核。 */
  tier: Tier;
  /** 强弱是你在设置里定的（不再按模型名自动猜）。 */
  tierSet?: boolean;
  /** 正在用的模型（自己填，如 grok-4.6）。记进交接记录，方便区分同一个工具换了模型。 */
  model?: string;
  /**
   * 讨论用的命令：从标准输入读题目、把回答打到标准输出。例：claude -p。
   * 含 {{out}} 时改为从这个临时文件读回答（codex exec -o {{out}}）。
   */
  ask?: string;
  /** kind=api 时的接口配置。 */
  api?: ApiSpec;
  note?: string;
  /**
   * 认得的 AI 编程工具（claude / codex / cursor-agent / zcode …）。有它接力台就能替你调度：
   * 用这个工具的无人值守模式在项目文件夹里干活、复核、群聊。
   */
  harness?: string;
  /** 全自动时要求的思考强度（如 codex 的 low）。不填用工具自己的默认。 */
  effort?: string;
  /** 这一条是「自动识别」加进来的。 */
  detected?: boolean;
  /** 同一个模型的桌面程序（打开文件夹的命令，含 {{dir}}）：你自己接着做时打开它。和命令行 / 接口是同一家、同一个账号，所以并成一位。 */
  app?: string;
}

export interface AgentsRegistry {
  agents: AgentConfig[];
  /** 你删掉的（识别时认的记号：h:工具、api:接口地址、app:桌面程序）：再识别也不加回来。 */
  removed?: string[];
}

/**
 * 项目配置 .relay/config.json（会进你的 git；不许写密钥）。
 */
export interface RelayConfig {
  /** 检查命令（门禁），如 npm test。空 = 不检查。 */
  gate: { command: string };
  /** 不许改的路径（简易 glob）。改到了会记在那一棒上，接力本和复核里都会提醒。 */
  protectedPaths: string[];
}
