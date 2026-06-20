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
  /** schema 模式下，structured-output tool 的 result.details（已通过 schema 校验）。 */
  parsedOutput?: unknown;
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
  /** schema 模式下，structured-output tool 的 result.details（对齐 workflow agent-pool）。 */
  parsedOutput?: unknown;
}

// ============================================================
// Runtime 公共 API 的入参/出参
// ============================================================

/** Hub.execute 的入参（sync/bg 共用）。mode 由 Hub 内部判定，不暴露给调用方。 */
export interface ExecuteOptions {
  task: string;
  agent?: string;
  /**
   * 执行模式意图（不直接指定 mode）：
   *   false → background（用户显式要求异步）
   *   true → sync（用户显式要求同步）
   *   undefined → Hub 按 agentConfig.defaultBackground 判定
   * Hub 内部据此 + agent 配置解析出最终 ExecutionMode。
   */
  wait?: boolean;
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
}

/**
 * execute 返回值。
 *   sync:    { mode:"sync", record, details } —— 调用方 await，record 已 settled。
 *            record 是只读快照（持久化/poll 用），details 是 TUI 渲染投影（含 elapsedSeconds/currentActivity）。
 *   background: { mode:"background", backgroundId } —— 立即返回。
 */
export type ExecutionHandle =
  | { mode: "sync"; record: RecordSnapshot; details: SubagentToolDetails }
  | { mode: "background"; backgroundId: string; details: SubagentToolDetails };

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

/**
 * 资源发现契约（<agentDir>/subagents/discovery.json）。
 * 宿主（如 xyz-agent GUI）启动 pi 前写入，subagents 在 session_start 与 resources_discover 时读取。
 * 文件缺失/字段缺失时各数组视为空，走默认行为（零破坏）。详见 ADR-025。
 */
export interface DiscoveryConfig {
  version: number;
  /** skill 目录列表（靠前覆盖靠后）。空数组 = 不额外注入，走默认。 */
  skillDirs: string[];
  /** agent .md 目录列表（靠前覆盖靠后）。空数组 = 走默认 getAgentDir()。 */
  agentDirs: string[];
}

/** 首次 category 模型确认后的 per-session 覆盖。 */
export interface SessionModelState {
  yoloMode: boolean;
  /** @deprecated D-1：取消首次确认后此字段恒为 true，仅 restoreSessionState 保留读写以向后兼容。 */
  categoryConfirmed: boolean;
  categoryModels: Record<string, { model: string; thinkingLevel?: string }>;
  agentModels: Record<string, { model: string; thinkingLevel?: string }>;
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
