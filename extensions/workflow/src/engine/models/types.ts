/**
 * Workflow Extension — Engine 共享类型
 *
 * Engine 层全局基础类型。零 infra 依赖——不 import 任何 infra 文件，
 * 可独立编译测试（D-12 三层架构，AC-1）。
 *
 * 核心内容：
 * - 状态机：RunStatus = "running" | "paused" | "done"（3 态，FR-3）
 * + DoneReason（completed/failed/aborted/budget_limited/time_limited）
 * - AgentCallOpts / AgentResult / AgentUsage（单次 agent 调用的输入/输出）
 * - ExecutionTraceNode / TracePatch / ToolCallEntry / WorkerLogEntry（trace 数据）
 *
 * 层归属：Engine（数据结构 + 不变式守卫）。
 */

import type { ExecutionRecord } from "../live/types.ts";

// ── 状态机 ────────────────────────────────────────────────────

/**
 * 状态机：3 态（D-12 / FR-3）。
 *
 * running ↔ paused → done
 *
 * `done` 是唯一终态，具体原因由 DoneReason 区分。
 */
export type RunStatus = "running" | "paused" | "done";

/** 终态原因。done 时必有（WorkflowRun 不变式）。 */
export type DoneReason =
  | "completed"
  | "failed"
  | "aborted"
  | "budget_limited"
  | "time_limited";

/** 合法的状态转换。空数组 = 无出边（done 终态）。 */
export const VALID_RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  running: ["paused", "done"] as const,
  paused: ["running", "done"] as const,
  done: [] as const,
};

export const ALL_RUN_STATUSES: readonly RunStatus[] = ["running", "paused", "done"] as const;

export const ALL_DONE_REASONS: readonly DoneReason[] = [
  "completed",
  "failed",
  "aborted",
  "budget_limited",
  "time_limited",
] as const;

/** done 为终态，无出边。 */
export function isDone(status: RunStatus): boolean {
  return status === "done";
}

export function canRunTransition(from: RunStatus, to: RunStatus): boolean {
  return (VALID_RUN_TRANSITIONS[from] as readonly RunStatus[]).includes(to);
}

// ── Agent 调用 ────────────────────────────────────────────────

/**
 * 单次 agent 调用的输入选项。
 *
 * D-12 仅重组执行编排，AgentCallOpts 形状保持兼容。
 */
export interface AgentCallOpts {
 /** The task prompt to send to the agent. */
  prompt: string;
 /**
 * Optional JSON schema for structured output.
 * When provided, the schema is passed via PI_WORKFLOW_SCHEMA env to the subprocess,
 * which activates the structured-output tool + turn_end hook.
 * The tool's execute validates model output against the schema.
 * On success, `parsedOutput` on the result is set to `tool_execution_end.result.details`
 * (the validated, parsed data object — not the raw tool call args).
 */
  schema?: Record<string, unknown>;
 /**
 * Model to use (e.g. "router-openai/glm-5.1").
 * When omitted, pi's default model is used.
 */
  model?: string;
 /** Scene name for model-switch advisor recommendation. */
  scene?: string;
 /**
 * Wall-clock timeout in milliseconds. When > 0, aborts the subprocess
 * if it runs longer than this, regardless of external signal.
 * Per-call，归 AgentCall 实体（G-027）。
 */
  timeoutMs?: number;
 /**
 * Skill name to load (e.g. "code-review"). Resolved to SKILL.md path
 * and injected via --skill flag in the subprocess.
 */
  skill?: string;
 /**
 * Resolved absolute path to the skill directory or SKILL.md file.
 * Set by agent-opts-resolver when opts.skill is present.
 */
  skillPath?: string;
 /** Human-readable description for logging and debugging. */
  description?: string;
 /**
 * Agent name to resolve from AgentRegistry. When set, the resolved
 * agent's systemPrompt is injected via --append-system-prompt.
 */
  agent?: string;
 /**
 * Absolute paths to temp files containing system prompt injections.
 * Set by agent-opts-resolver: agent systemPrompt + schema injection files.
 * buildArgs injects each via --append-system-prompt.
 */
  systemPromptFiles?: string[];
 /**
 * Schema JSON for PI_WORKFLOW_SCHEMA env var.
 * Set by agent-opts-resolver when opts.schema is present; passed as env var
 * to activate the structured-output tool + hook.
 */
  schemaEnv?: string;
}

/**
 * 单次 agent 调用的资源用量（FR-7 跨 turn 累积）。
 */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/**
 * 单次 tool 调用记录（FR-7 从 agent JSONL 流采）。
 */
export interface ToolCallEntry {
 /** Tool name. */
  name: string;
 /** Args preview string. */
  input: string;
}

/**
 * 单次 agent 调用的结果（统一形态）。
 *
 * Engine 直接消费 SubprocessAgentRunner 返回值；callCache replay 时 worker
 * 取 parsedOutput ?? content（见 worker-script-builder.ts 消息处理）。
 */
export interface AgentResult {
 /** Raw text output from the agent. */
  content: string;
 /**
 * Parsed structured output.
 * Present when `schema` was provided and the output was valid JSON.
 * Source: tool_execution_end.result.details（validated data object）。
 */
  parsedOutput?: unknown;
 /** Token and cost usage accumulated across all assistant turns. */
  usage?: AgentUsage;
 /** Wall-clock duration in milliseconds. */
  durationMs?: number;
 /** True when the pi process exited with code 0. */
  error?: string;
 /**
 * Pi session ID for the subagent process (uuidv7).
 * Present when pi emits a session header (default in --mode json).
 * Can be used to locate the session JSONL file for post-run inspection (G-017)。
 */
  sessionId?: string;
 /** All tool calls collected from JSONL stream (FR-7). */
  toolCalls?: ToolCallEntry[];
}

// ── Trace ─────────────────────────────────────────────────────

/**
 * 执行追踪节点（事件流 D-10 单一来源）。
 */
export interface ExecutionTraceNode {
  stepIndex: number;
  agent: string;
  task: string;
  model: string;
  status: "pending" | "running" | "completed" | "failed";
 /** Phase name for TUI grouping. Set from explicit opts.phase or global _currentPhase. */
  phase?: string;
  startedAt?: string;
  completedAt?: string;
  result?: AgentResult;
  error?: string;
 /**
 * Pi session ID (uuidv7) for the subagent process.
 * Used to locate the session JSONL for post-run inspection.
 */
  sessionId?: string;
 /**
 * Live 执行进度对象（running 时存在，done 时由 dispatchAgentCall 清除）。
 *
 * 挂在 node 上（D-10 单源延伸：AgentCall.traceNode 与 Trace.nodes 共享同一引用）。
 * TUI 通过 trace.toArray() 读 node.live，派生 getEventLog/getCurrentActivity 实时展示。
 * 不持久化（pause/resume 时为 undefined，重跑时重建）。
 */
  live?: ExecutionRecord;
}

/**
 * Trace.update 用的 patch（字段全可选）。
 *
 * 不变式：只改单个 node 的 status/result/error/completedAt/sessionId。
 * callId 不存在时 update 为 no-op（D-10）。
 */
export interface TracePatch {
  status?: "pending" | "running" | "completed" | "failed";
  result?: AgentResult;
  error?: string;
  completedAt?: string;
  sessionId?: string;
}

// ── Worker 诊断 ───────────────────────────────────────────────

/**
 * Worker console.* 捕获条目（run 级诊断，仅展示在 TUI widget，不泄漏到 input area）。
 */
export interface WorkerLogEntry {
  level: "log" | "warn" | "error" | "info";
  message: string;
}
