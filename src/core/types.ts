// relay 锁定协议类型。改这里的字段语义 = 改协议，须重新评审，不要随手加字段。

export type Tier = 'strong' | 'weak';

/** 上岗词喂入方式。默认 file：每次 run 先写 .relay/ONBOARD.md，启动只喂一句「先读这份文件」。 */
export type PromptMode = 'arg' | 'stdin' | 'file';

/**
 * 客人类型。cli = 终端阻塞 spawn（relay run）；
 * app = 桌面 App 客人（relay open，cmd 是「打开文件夹」模板，须含 {{worktree}} 占位符）。
 * 缺省 cli——旧注册表没有该字段，一律按 cli 处理（向后兼容）。
 */
export type AgentKind = 'cli' | 'app';

/** 全局注册表 ~/.relay/agents.json 中的一条 agent 配置。 */
export interface AgentConfig {
  /** 唯一名，relay run <name> / relay open <name> 用。 */
  name: string;
  /** 启动命令（含参数，在 worktree 内执行）。kind=app 时是打开模板，{{worktree}} 会被代入 worktree 路径。 */
  cmd: string;
  /** 能力分级：strong | weak。只影响提示词与流程强调，绝不自动切人。 */
  tier: Tier;
  /** 上岗词喂入方式。 */
  prompt: { mode: PromptMode };
  /** 客人类型。缺省 cli（旧注册表兼容）。 */
  kind?: AgentKind;
  /** 备注（可选），如「Claude 会员，额度易耗尽」。 */
  note?: string;
}

export interface AgentsRegistry {
  agents: AgentConfig[];
}

/**
 * 目标项目 .relay/config.json（协议三：可进主线；禁止写入 API key）。
 * task.md / handoff.md / journal.jsonl / audits/ 不在这里管——它们只活在 relay/* 分支。
 */
export interface RelayConfig {
  /** 项目自定义门禁命令。空字符串 = 未配置。 */
  gate: { command: string };
  /** 弱 agent 不得改动的路径；handoff/merge 扫描，命中标红并拒绝 merge（除非 --force）。 */
  protectedPaths: string[];
  /** 审计用 LLM（OpenAI 兼容）。密钥只放环境变量，apiKeyEnv 只存变量名。 */
  audit: { baseUrl: string; model: string; apiKeyEnv: string };
}

// ---- journal.jsonl 事件（只追加，不改写历史）----

/** 每条事件的公共字段。 */
export interface JournalEventBase {
  /** ISO 8601 时间戳。 */
  ts: string;
  type: JournalEventType;
  agent?: string;
  /** 同一窗口里正在用的模型。可选；旧 journal 没有此字段。 */
  llm?: string;
  tier?: Tier;
  /** 相关 commit SHA。handoff=检查点；merge=squash 落点；start=主线基准（首提交在会话指针 startCommit）。 */
  commit?: string;
  /** worktree 绝对路径。 */
  worktree?: string;
}

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
  | 'abandon';

export interface StartEvent extends JournalEventBase {
  type: 'start';
  /** 任务全文（完整标题只写 task.md，这里存原文即可）。 */
  task: string;
  /** relay/<slug>-<id> 分支名。 */
  branch: string;
}

export interface RunEvent extends JournalEventBase {
  type: 'run';
  /** --force 接管另一 App 客人未释放的软锁时，记录被覆盖的 agent 名（审计痕迹）。 */
  overrode?: string;
}

/** App 客人上岗（relay open）。没有配对的 exit 事件：App 段的结束方式只有 relay handoff。 */
export interface OpenEvent extends JournalEventBase {
  type: 'open';
  /** --force 覆盖另一 App 客人未释放的软锁时，记录被覆盖的 agent 名（审计痕迹）。 */
  overrode?: string;
}

export interface ExitEvent extends JournalEventBase {
  type: 'exit';
  /** agent 进程退出码。 */
  code: number;
  /** 额度报错迹象。尽力而为的启发式，供人判断，不作自动切人依据。 */
  quotaHint: boolean;
}

export interface AuditEvent extends JournalEventBase {
  type: 'audit';
  /** 审计报告在 .relay/audits/ 下的相对路径。 */
  report: string;
  /** ok = 事实报告 + 阅读面齐全；failed = LLM 阅读面失败，只有事实报告。 */
  status: 'ok' | 'failed';
}

export interface GateEvent extends JournalEventBase {
  type: 'gate';
  status: 'pass' | 'fail';
  /** 实际执行的门禁命令。 */
  command: string;
  /** 失败时的输出摘要（可选；旧 journal 没有此字段）。 */
  detail?: string;
}

export interface HandoffEvent extends JournalEventBase {
  type: 'handoff';
  /** 本次检查点 commit SHA。 */
  checkpoint: string;
}

export interface RollbackEvent extends JournalEventBase {
  type: 'rollback';
  /** 回滚到的检查点 SHA。 */
  to: string;
}

export interface MergeEvent extends JournalEventBase {
  type: 'merge';
  /** squash 后落在主线的 commit SHA。 */
  squashCommit: string;
}

export interface AbandonEvent extends JournalEventBase {
  type: 'abandon';
  /** 保留备查的 relay/* 分支名。 */
  branch: string;
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
  | AbandonEvent;
