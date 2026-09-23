// 接力台的数据格式。journal / agents.json / config.json 都要和旧版兼容：只加可选字段，不改旧字段语义。

export type Tier = 'strong' | 'weak';

/**
 * 终端工人的上岗词喂法：
 * - arg：把一句「先读 .relay/ONBOARD.md」当参数传给命令（claude / codex 这类都支持）；
 * - stdin：从标准输入喂这句话（非交互的脚本型工人）；
 * - file：什么都不喂，只在终端里提示人转告。
 */
export type PromptMode = 'arg' | 'stdin' | 'file';

/**
 * 工人类型：
 * - cli：终端工人。relay run 在隔离副本里启动它并等它退出；
 * - app：桌面工人（Cursor / ZCode …）。cmd 是「打开文件夹」模板，必须含 {{worktree}}；
 * - api：只接 API 的模型（DeepSeek …）。不能手动上岗；全自动里用内置小代理干活，也能审查、讨论。
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
  /** 唯一名（英文、数字、-、_），命令里用它：relay run claude。 */
  name: string;
  /** 显示名，如「Claude Code」。没有就用 name。 */
  label?: string;
  kind?: AgentKind;
  /** cli：在隔离副本里执行的命令；app：打开模板（含 {{worktree}}）；api：不用。 */
  cmd?: string;
  /** 能力分级。只影响上岗词（前任是 weak 时，下一位必须先自审），绝不自动换人。 */
  tier: Tier;
  prompt?: { mode: PromptMode };
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
   * 认得的 AI 编程工具（claude / codex / cursor-agent / zcode …）。有它就能全自动：
   * 接力台用这个工具的无人值守模式在隔离副本里干活、审查。
   */
  harness?: string;
  /** 全自动时要求的思考强度（如 codex 的 low）。不填用工具自己的默认。 */
  effort?: string;
  /** 这一条是「自动识别」加进来的。 */
  detected?: boolean;
}

export interface AgentsRegistry {
  agents: AgentConfig[];
}

/**
 * 项目配置 .relay/config.json（唯一进主线的接力文件；不许写密钥）。
 */
export interface RelayConfig {
  /** 检查命令（门禁），如 npm test。空 = 不检查。 */
  gate: { command: string };
  /** 不许改的路径（简易 glob）。改了会标红，合回时拒绝。 */
  protectedPaths: string[];
  /** 交接时写「阅读面」的便宜模型。可以不配，事实段照样有。 */
  audit: ApiSpec;
}

// ---- journal.jsonl 事件（只追加，不改写） ----

export type JournalEventType =
  | 'start'
  | 'run'
  | 'open'
  | 'exit'
  | 'audit'
  | 'gate'
  | 'handoff'
  | 'rollback'
  | 'merge'
  | 'abandon'
  | 'take'
  | 'sync'
  | 'review'
  | 'auto';

export interface JournalEventBase {
  ts: string;
  type: JournalEventType;
  agent?: string;
  /** 这一段用的模型。 */
  llm?: string;
  tier?: Tier;
  commit?: string;
  worktree?: string;
}

export interface StartEvent extends JournalEventBase {
  type: 'start';
  task: string;
  branch: string;
}

export interface RunEvent extends JournalEventBase {
  type: 'run';
  /** --force 接管了谁的锁（留痕）。 */
  overrode?: string;
  /** 全自动流水线派的活（无人值守）。 */
  auto?: boolean;
  /** 全自动：第几轮。 */
  round?: number;
}

/** 桌面工人上岗。没有 exit：桌面段只以交接收尾。 */
export interface OpenEvent extends JournalEventBase {
  type: 'open';
  overrode?: string;
}

export interface ExitEvent extends JournalEventBase {
  type: 'exit';
  code: number;
  /** 旧字段，恒为 false。 */
  quotaHint: boolean;
}

export interface AuditEvent extends JournalEventBase {
  type: 'audit';
  /** 审计报告在工作副本里的相对路径（.relay/audits/...）。 */
  report: string;
  /** ok = 事实 + 模型阅读面；failed = 只有事实（没配模型或模型失败）。 */
  status: 'ok' | 'failed';
}

export interface GateEvent extends JournalEventBase {
  type: 'gate';
  status: 'pass' | 'fail';
  command: string;
  detail?: string;
}

export interface HandoffEvent extends JournalEventBase {
  type: 'handoff';
  /** 检查点提交（退回目标）。 */
  checkpoint: string;
  /** 这一段没有任何业务改动。旧 journal 没有这个字段，按有改动算。 */
  empty?: boolean;
  files?: number;
  added?: number;
  removed?: number;
  /** 交接时人写的留言。 */
  note?: string;
  /** 上一位自己写在 .relay/NOTE.md 里的自述（不是事实）。 */
  selfNote?: string;
}

export interface RollbackEvent extends JournalEventBase {
  type: 'rollback';
  to: string;
}

export interface MergeEvent extends JournalEventBase {
  type: 'merge';
  squashCommit: string;
}

export interface AbandonEvent extends JournalEventBase {
  type: 'abandon';
  branch: string;
}

/** 把正式文件夹里被误改的文件收进了任务。 */
export interface TakeEvent extends JournalEventBase {
  type: 'take';
  files: string[];
}

/** 把正式文件夹的新提交同步进任务。有冲突时 commit 为空，由下一次交接收尾。 */
export interface SyncEvent extends JournalEventBase {
  type: 'sync';
  main: string;
  conflicts?: string[];
  aborted?: boolean;
}

/** 全自动流水线里，另一个 AI 对最近一次交接的审查结论。 */
export interface ReviewEvent extends JournalEventBase {
  type: 'review';
  /** pass = 可以合回；fix = 要改。 */
  verdict: 'pass' | 'fix';
  summary: string;
  issues: string[];
  /** 审的是哪个检查点。 */
  checkpoint: string;
  round: number;
  /** 审的是谁的活。 */
  implementer?: string;
}

/** 全自动流水线开始 / 结束。 */
export interface AutoEvent extends JournalEventBase {
  type: 'auto';
  phase: 'begin' | 'end';
  runId: string;
  status?: string;
  detail?: string;
}

export type JournalEvent =
  | StartEvent
  | RunEvent
  | OpenEvent
  | ExitEvent
  | AuditEvent
  | GateEvent
  | HandoffEvent
  | RollbackEvent
  | MergeEvent
  | AbandonEvent
  | TakeEvent
  | SyncEvent
  | ReviewEvent
  | AutoEvent;
