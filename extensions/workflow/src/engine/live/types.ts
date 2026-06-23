// engine/live/types.ts
//
// Live agent 执行进度的核心类型契约。复制自 extensions/subagents/src/types.ts
// 的子集（去掉 subagent 特有的 model-resolver / TUI 投影 / Runtime 编排类型）。
//
// 这些类型随 execution-record.ts 一起从 subagents 复制过来——它们是零依赖叶子原语
// （代码自述"零 Pi/Runtime/TUI 依赖"），专为可移植设计。两份代码手动同步。
//
// 作用：承载 agent 执行过程中的实时状态（text/thinking/toolCalls/usage 按 turn 收口），
// 供 workflow TUI 在 agent 运行期间显示进度（而非只在完成后显示 outcome）。
//
// 分层：live 模块是 Engine 子层，被 dispatchAgentCall 创建/更新、被 WorkflowsView 只读消费。

// ============================================================
// 执行状态机
// ============================================================

/** 唯一执行状态。workflow 路径只用 running → done/failed（无 cancelled）。 */
export type ExecutionStatus = "running" | "done" | "failed" | "cancelled";

/** 执行模式。workflow agent 调用恒为 sync（调用方 await 结果）。 */
export type ExecutionMode = "sync" | "background";

// ============================================================
// Agent 事件流（live record 的唯一更新驱动）
// ============================================================

/**
 * Agent 执行事件。由 jsonl-to-agent-event.ts 从 subprocess JSONL 事件翻译而来，
 * 喂给 updateFromEvent 收口进 record.turns[]。
 *
 * 与 subagents 的 AgentEvent 完全一致——事件源同构（pi --mode json 的 stdout
 * 就是 SDK session.subscribe 事件的 JSON 序列化，见 pi print-mode.ts）。
 */
export type AgentEvent =
  | { type: "tool_start"; toolName: string; args?: unknown }
  | { type: "tool_end"; toolName: string; args?: unknown; result?: ToolCallResult; isError?: boolean }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "turn_end"; summary?: string }
  | { type: "message_end"; usage?: AgentUsage; error?: string }
  | { type: "compaction" }
  | { type: "error"; message: string };

/** token 用量（message_end 时由 updateFromEvent 累加进 record.totalTokens）。 */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 本 message 的成本（USD）。可选——无成本数据时缺省。 */
  cost?: number;
}

export interface AgentUsageTotal extends AgentUsage {
  /** 上述四项之和。投影时不再手工求和。 */
  total: number;
  /** 累计成本（USD）。无成本数据时为 0。 */
  cost: number;
}

/**
 * eventLog 条目（getEventLog 派生产出的元素）。所有字段 readonly。
 *
 * 只承载离散语义事件（tool 调用 / turn 边界 / error）——
 * 完整 text/thinking 内容收口在 record.turns[]，不进 eventLog。
 */
export interface AgentEventLogEntry {
  readonly type: "tool_start" | "tool_end" | "turn_end" | "error";
  readonly label: string;
  /** 事件发生的墙钟时间戳（Date.now()，ms）。由 getEventLog 从 turns[] 派生时记录。 */
  readonly ts: number;
  readonly status?: "running" | "done" | "failed";
}

// ============================================================
// Tool 调用相关
// ============================================================

/** tool 调用结果（tool_execution_end 时累积，含 structured-output 的 details）。 */
export interface ToolCallResult {
  content?: unknown[];
  details?: unknown;
}

/**
 * tool 调用（导出的纯净数据形状，不含内部状态）。
 *
 * 进行中状态由 execution-record 内部的 InternalToolCall（= ToolCall + _status）承载，
 * 只存在于 record.turns[].toolCalls，跨边界导出时由 getAllToolCalls strip _status。
 */
export interface ToolCall {
  toolName: string;
  args?: unknown;
  result?: ToolCallResult;
  isError?: boolean;
}

/**
 * 内部 ToolCall：在 ToolCall 基础上追加 _status 进行中状态标记与 startedTs 时间戳。
 *
 *   running = tool_start 已收到但 tool_end 未到；
 *   done/failed = tool_end 已到。
 *
 * 仅存在于 ExecutionRecord.turns[].toolCalls（live 模块内部可变状态）。
 * 跨边界导出由 getAllToolCalls 映射回 ToolCall（丢弃 _status / startedTs）。
 */
export interface InternalToolCall extends ToolCall {
  _status: "running" | "done" | "failed";
  /** tool_start 到达时的墙钟时间戳（Date.now()，ms）。getEventLog 派生 tool 条目 ts 用。 */
  startedTs: number;
}

/**
 * 一个 turn 的完整内容（ExecutionRecord.turns[] 的元素）。
 *
 * text/thinking 流式累积完整内容（非切片），toolCalls 存完整 ToolCall（含 result + _status）。
 * turn_end 到达后 closed=true，下次 text/thinking/tool 时开新 turn。
 */
export interface Turn {
  /** 本 turn assistant 正文（text_delta 流式累积，完整）。 */
  text: string;
  /** 本 turn 推理（thinking_delta 流式累积，完整）。 */
  thinking: string;
  /** 本 turn 工具调用（InternalToolCall：含完整 result + _status 进行中标记）。 */
  toolCalls: InternalToolCall[];
  /** 本 turn message_end 的 token 增量（聚合得 totalUsage）。 */
  usageDelta?: AgentUsage;
  /** turn_end 是否已到达。false=正在进行；true=已闭合，下次内容开新 turn。 */
  closed: boolean;
  /** turn_end 到达时的墙钟时间戳（Date.now()，ms）。getEventLog 派生 turn_end 条目 ts 用。 */
  closedTs?: number;
}

// ============================================================
// ExecutionRecord —— 唯一 live 状态对象
// ============================================================

/**
 * 单个 agent 执行的实时状态对象。挂在 ExecutionTraceNode.live 上。
 *
 * 收口设计：一次执行的完整内容（text/thinking/toolCalls/usage）按 turn 收口在 turns[]。
 * eventLog / currentActivity 均从 turns[] 派生（getEventLog / getCurrentActivity），不独立存储。
 *
 * 生命周期（workflow 路径）：
 *   dispatchAgentCall 时 createRecord() → onEvent 回调 updateFromEvent() 实时更新 →
 *   finalizeCall 时清除 node.live（终态由 node.result 承载）。
 *
 * workflow 不调 completeRecord（那是 subagents 的终态收口；workflow 用现有 finalizeCall）。
 */
export interface ExecutionRecord {
  /** 唯一 ID（workflow 用 String(callId)）。 */
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
  /** 完整执行内容，按 turn 组织。createRecord 初始化为 [空 turn]。 */
  turns: Turn[];
  /** turn 计数（= turns.filter(closed).length，冗余存储供投影直接读）。 */
  turnCount: number;
  totalTokens: number;
  /** 运行期最近一次 error 事件的消息（getEventLog 派生 error 条目用）。 */
  lastError: string | undefined;

  // ── 完成 ──
  endedAt: number | undefined;
  result: string | undefined;
  error: string | undefined;
  /** 完整 AgentResult（subagents 完成时填；workflow 不用此字段，用 node.result）。 */
  agentResult: unknown;

  /** session jsonl 文件名（subagents 回填；workflow 不用）。保留以保持与 subagents 类型一致。 */
  sessionFile?: string;

  // ── 控制（仅 subagents background 持有；workflow 恒 undefined）──
  controller: AbortController | undefined;
}
