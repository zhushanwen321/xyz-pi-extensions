// src/types.ts
//
// 跨层共享的核心类型契约。Core/Runtime/TUI 三层均可 import 本文件。
//
// 分层铁律：
//   - Core 不 import Runtime/TUI（零 Pi 依赖，可单测）
//   - Runtime 编排 Core，产出 Details/Record 给 TUI
//   - TUI 只读 Record/Details 快照，永不持有可变引用

import type { AgentConfig, ResolvedModel } from "./core/model-resolver.ts";

// ============================================================
// 执行状态机
// ============================================================

/** 唯一执行状态。所有路径（sync/bg/poll）共用。 */
export type ExecutionStatus = "running" | "done" | "failed" | "cancelled";

/** 执行模式。sync = 调用方 await；background = 调用方立即拿 handle 返回。 */
export type ExecutionMode = "sync" | "background";

// ============================================================
// Agent 事件流（Core → Record 的唯一更新驱动）
// ============================================================

/** Pi session.subscribe 上报的事件。Runtime 把它喂给 updateFromEvent。 */
export type AgentEvent =
  | { type: "tool_start"; toolName: string; args?: unknown }
  | { type: "tool_end"; toolName: string; args?: unknown; isError?: boolean }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "turn_end"; summary?: string }
  | { type: "message_end"; usage?: AgentUsage; error?: string }
  | { type: "compaction" }
  | { type: "error"; message: string };

/** token 用量（message_end 时由 Core 累加进 record.totalTokens）。 */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface AgentUsageTotal extends AgentUsage {
  /** 上述四项之和。投影时不再手工求和。 */
  total: number;
}

/** eventLog 条目（Record.eventLog 的元素）。所有字段 readonly。 */
export interface AgentEventLogEntry {
  readonly type: "tool_start" | "tool_end" | "text_output" | "thinking" | "turn_end" | "error";
  readonly label: string;
  readonly ts: number;
  readonly status?: "running" | "done" | "failed";
}

// ============================================================
// Agent 结果（一次执行的 outcome）
// ============================================================

/** tool 调用结果（tool_execution_end 时 bridge 累积，含 structured-output 的 details）。 */
export interface ToolCallResult {
  content?: unknown[];
  details?: unknown;
}

export interface ToolCall {
  toolName: string;
  args?: unknown;
  result?: ToolCallResult;
  isError?: boolean;
}

/** 一次 session 执行的完整结果。collectResult 产出，写入 Record.outcome。 */
export interface AgentResult {
  text: string;
  turns: number;
  durationMs: number;
  success: boolean;
  error?: string;
  sessionId: string;
  toolCalls: ToolCall[];
  usage?: AgentUsageTotal;
  /** /resume /fork 可恢复的 session 文件名（不含目录）。 */
  sessionFile?: string;
  /** worktree 隔离执行时的变更信息。 */
  worktree?: WorktreeOutcome;
}

export interface WorktreeOutcome {
  branch?: string;
  hasChanges: boolean;
  /** preserveOnFailure 保留的物理目录（branch 缺失但 hasChanges 时透传）。 */
  workPath?: string;
  baseSha?: string;
}

// ============================================================
// ExecutionRecord —— 唯一状态对象（Core 拥有，Runtime 引用）
// ============================================================

/**
 * 所有执行路径的唯一状态源。
 *
 * 生命周期：createRecord() 创建 → updateFromEvent() 实时更新 →
 *           completeRecord() 冻结 → archive/history 持久化。
 *
 * TUI 永远拿 RecordSnapshot（.slice() 快照），不直接持此可变对象。
 */
export interface ExecutionRecord {
  /** 唯一 ID（sync: "run-N"，bg: "bg-N-xxx"）。 */
  readonly id: string;

  // ── 身份（创建时确定，不可变）──
  readonly agent: string;
  readonly model: string;
  readonly thinkingLevel: string | undefined;
  readonly mode: ExecutionMode;
  readonly task: string;
  readonly startedAt: number;

  // ── 状态（实时更新）──
  status: ExecutionStatus;
  eventLog: AgentEventLogEntry[];
  turns: number;
  totalTokens: number;

  // ── 完成 ──
  endedAt: number | undefined;
  result: string | undefined;
  error: string | undefined;
  /** 完整 AgentResult（含 usage/toolCalls，完成时填）。 */
  agentResult: AgentResult | undefined;

  // ── 控制（仅 background 持有）──
  controller: AbortController | undefined;

  // ── eventLog chunking 缓冲（跨事件持久，修复 sink reset bug）──
  _currentTurnText: string;
  _currentThinking: string;
}

// ============================================================
// Runtime → TUI 的投影契约
// ============================================================

/**
 * Tool 返回的 details（renderResult 消费）。
 * 由 project(record) 唯一产出——sync/bg/poll 三路径字段一致。
 */
export interface SubagentToolDetails {
  status: ExecutionStatus;
  agent: string;
  model: string;
  thinkingLevel: string | undefined;
  turns: number;
  totalTokens: number;
  elapsedSeconds: number;
  eventLog: AgentEventLogEntry[];
  result?: string;
  error?: string;
  /** running 时的当前活动行（tool/thinking/text 优先级）。 */
  currentActivity?: { type: "tool" | "text" | "thinking"; label: string };
  /** 仅 background 模式返回，供 LLM 后续 poll。 */
  backgroundId?: string;
}

// ============================================================
// Runtime 公共 API 的入参/出参
// ============================================================

/** Runtime.execute 的入参（sync/bg 共用，mode 决定分叉点）。 */
export interface ExecuteOptions {
  task: string;
  agent?: string;
  mode: ExecutionMode;
  model?: string;
  thinkingLevel?: string;
  skillPath?: string;
  appendSystemPrompt?: string[];
  schema?: Record<string, unknown>;
  maxTurns?: number;
  graceTurns?: number;
  /** sync 模式来自 Pi tool 框架；background 模式 hub 忽略，自建 controller。 */
  signal?: AbortSignal;
  /** live 状态回流（对话流 block 实时刷新）。 */
  onUpdate?: (details: SubagentToolDetails) => void;
  /** background 完成回调（sync 不调）。 */
  onComplete?: (record: RecordSnapshot) => void;
  /**
   * 首次 category 确认回调。hub.execute 内部首次调用且未确认时触发。
   * 无 UI 场景（headless/测试）省略——hub 跳过确认直接用 fallback 解析。
   * 类型与 ModelConfigHub.ConfirmCategoryCallback 结构兼容（duck-typed）。
   */
  onConfirmCategory?: (input: {
    categories: { name: string; model: string }[];
    currentModels: Record<string, { model: string; thinkingLevel?: string }>;
    available: unknown[];
  }) => Promise<CategoryConfirmResult>;
}

/**
 * execute 返回值。
 *   sync:    { mode:"sync", record } —— 调用方 await，record 已 settled。
 *   background: { mode:"background", backgroundId } —— 立即返回。
 */
export type ExecutionHandle =
  | { mode: "sync"; record: RecordSnapshot }
  | { mode: "background"; backgroundId: string };

/** poll(backgroundId) 返回。record 的只读视图。 */
export interface QueryResult {
  id: string;
  status: ExecutionStatus;
  agent: string;
  model: string;
  thinkingLevel: string | undefined;
  turns: number;
  totalTokens: number;
  startedAt: number;
  endedAt: number | undefined;
  elapsedSeconds: number;
  result?: string;
  error?: string;
  eventLog: AgentEventLogEntry[];
  mode: ExecutionMode;
}

// ============================================================
// TUI list 视图的合并 record（4 源 merge 后的形状）
// ============================================================

/** /subagents list 左列展示单元。合并自 live/completed/bg/history 四源。 */
export interface SubagentRecord {
  id: string;
  agent: string;
  status: ExecutionStatus;
  mode: ExecutionMode;
  startedAt: number;
  endedAt: number | undefined;
  turns: number;
  totalTokens: number;
  model: string;
  thinkingLevel: string | undefined;
  eventLog: AgentEventLogEntry[];
  result?: string;
  error?: string;
  sessionFile?: string;
}

// ============================================================
// 持久化（history.jsonl 一行）
// ============================================================

export interface PersistedAgentRecord {
  id: string;
  agent: string;
  status: ExecutionStatus;
  mode: ExecutionMode;
  taskPreview: string;
  startedAt: number;
  endedAt?: number;
  turns?: number;
  totalTokens?: number;
  error?: string;
  resultPreview?: string;
  sessionFile?: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  thinkingLevel?: string;
}

// ============================================================
// ManagedSession（长生命周期变体，支持多次 prompt/steer/abort）
// ============================================================

/** createManagedSession 的入参（身份字段，session 创建时确定）。 */
export interface ManagedSessionOptions {
  agent?: string;
  model?: string;
  thinkingLevel?: string;
  skillPath?: string;
  appendSystemPrompt?: string[];
  onEvent?: (event: AgentEvent) => void;
}

/** ManagedSession.prompt 的单轮入参。每轮 turn 计数独立（bridge.resetForPrompt 清零）。 */
export interface ManagedPromptOptions {
  /** 本轮 hard turn limit。 */
  maxTurns?: number;
  /** soft limit 后宽限轮数（默认 2）。 */
  graceTurns?: number;
  /** 本轮中断信号。 */
  signal?: AbortSignal;
}

/**
 * 长生命周期 session。首次 prompt() 懒创建 Pi session，之后复用。
 *   - prompt() 串行化（Pi session 不支持并发 prompt）
 *   - steer() 在 session 就绪前缓存到 pendingSteers，ensureSession 时 flush
 *   - abort() / dispose() 委托 Pi session
 */
export interface ManagedSession {
  /** Pi session 的稳定 ID（session 创建前为 ""）。 */
  readonly sessionId: string;
  /** 是否未 dispose。 */
  readonly alive: boolean;
  /** 执行一轮（串行化，复用 session）。bridge 在每轮前 resetForPrompt。 */
  prompt(task: string, opts?: ManagedPromptOptions): Promise<AgentResult>;
  /** 注入消息（运行中=中途 steer；session 未就绪=入队下次 prompt）。 */
  steer(message: string): void;
  /** 中断当前 prompt（若在运行）。 */
  abort(): void;
  /** 显式销毁（unsubscribe + session.dispose）。幂等。 */
  dispose(): void;
}

// ============================================================
// 配置（global + session）
// ============================================================

export interface SubagentsGlobalConfig {
  version: number;
  yoloByDefault: boolean;
  maxConcurrent: number;
  categories: Record<string, CategoryDefinition>;
  agentCategoryOverrides: Record<string, string>;
  fallback: { model: string; thinkingLevel?: string };
}

export interface CategoryDefinition {
  label: string;
  model: string;
  thinkingLevel?: string;
}

/** 首次 category 模型确认后的 per-session 覆盖。 */
export interface SessionModelState {
  yoloMode: boolean;
  categoryConfirmed: boolean;
  categoryModels: Record<string, { model: string; thinkingLevel?: string }>;
  agentModels: Record<string, { model: string; thinkingLevel?: string }>;
}

export interface CategoryConfirmResult {
  action: "confirmed" | "cancelled";
  overrides: Record<string, { model: string; thinkingLevel?: string }>;
}

// ============================================================
// 只读快照（TUI 消费，永不 mutate）
// ============================================================

/**
 * Record 的只读视图。store.snapshot() 返回。
 * TUI 拿到此类型，保证不会回写 Core 状态。
 */
export interface RecordSnapshot {
  readonly id: string;
  readonly agent: string;
  readonly model: string;
  readonly thinkingLevel: string | undefined;
  readonly mode: ExecutionMode;
  readonly task: string;
  readonly status: ExecutionStatus;
  readonly eventLog: readonly AgentEventLogEntry[];
  readonly turns: number;
  readonly totalTokens: number;
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly result: string | undefined;
  readonly error: string | undefined;
}

// Re-export 用于 ExecuteOptions 的 agent/model 契约
export type { AgentConfig, ResolvedModel };
