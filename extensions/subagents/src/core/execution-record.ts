// src/core/execution-record.ts
//
// 唯一执行状态对象 + 唯一创建/更新/完成/投影入口。
//
// 架构原则（见 .xyz-harness/.../core-state.md）：
//   - createRecord   唯一创建入口（model 创建时必填，消灭 poll 路径 model 丢失）
//   - updateFromEvent 唯一事件更新入口（消灭 eventLog 双构建 + sink reset bug）
//   - completeRecord 唯一完成入口（冻结状态）
//   - project(record) 唯一投影入口 → SubagentToolDetails（三路径字段一致）

import type {
  AgentEvent,
  AgentResult,
  ExecutionMode,
  ExecutionRecord,
  RecordSnapshot,
  SubagentToolDetails,
} from "../types.ts";

/** ms → s 换算 */


// ============================================================
// 创建
// ============================================================

/**
 * 唯一创建入口。identity 字段（agent/model/thinkingLevel/mode/task）一次确定不可变。
 */
export function createRecord(
  id: string,
  identity: {
    agent: string;
    model: string;
    thinkingLevel?: string;
    mode: ExecutionMode;
    task: string;
    startedAt: number;
    controller?: AbortController;
  },
): ExecutionRecord {
  //  1. 用 identity 字段初始化 record（status:running, eventLog:[], turns:0, totalTokens:0）
  //  2. background 模式存入 identity.controller；sync 模式 controller=undefined
  //  3. _currentTurnText/_currentThinking 初始化为 ""（跨事件持久缓冲）
  void id; void identity;
  throw new Error("not implemented");
}

// ============================================================
// 事件更新（唯一更新点）
// ============================================================

/**
 * 从 AgentEvent 更新 record。
 *   - eventLog 追加（tool_start/tool_end/text_output/thinking/turn_end）
 *   - turns 累积（turn_end++）
 *   - totalTokens 累积（message_end.usage 求和）
 *   - chunking 缓冲跨事件持久（修复 background text/thinking 丢失）
 *
 *   ╔══════════════════════════════════════════════════════════════╗
//   ║   record（唯一状态源）                                        ║
//   ║      ▲                                                        ║
//   ║      │ mutate（push/shift/累加）                              ║
//   ║      │                                                        ║
//   ║   updateFromEvent(record, event)   ◄── EventBridge 唯一调用   ║
//   ╚══════════════════════════════════════════════════════════════╝
 */
export function updateFromEvent(record: ExecutionRecord, event: AgentEvent): void {
  //  1. appendEventLog：tool_start/tool_end 推条目；text_delta/thinking_delta 累积到
  //     _currentTurnText/_currentThinking，达 chunk 阈值推 text_output/thinking 条目
  //  2. turn_end：flush 残留缓冲 + turns++
  //  3. message_end：totalTokens += input+output+cacheRead+cacheWrite
  //  4. ring buffer：超 MAX_EVENT_LOG_ENTRIES 移除最旧
  void record; void event;
  throw new Error("not implemented");
}

// ============================================================
// 完成
// ============================================================

/**
 * 唯一完成入口。冻结状态（写 endedAt/agentResult/result/error）。
 * 不修改 turns/totalTokens（已由 updateFromEvent 累积）。
 */
export function completeRecord(
  record: ExecutionRecord,
  result: AgentResult,
  status: "done" | "failed" | "cancelled",
): void {
  //  1. record.status = status
  //  2. record.endedAt = Date.now()
  //  3. record.agentResult = result
  //  4. record.result = result.text
  //  5. record.error = result.error
  void record; void result; void status;
  throw new Error("not implemented");
}

// ============================================================
// 投影（唯一 → Details / Snapshot）
// ============================================================

/**
 * 投影到 SubagentToolDetails。elapsedSeconds 唯一计算点（Math.floor）。
 * eventLog 必须 .slice() 快照——record.eventLog 是被 push/shift mutate 的可变数组。
 */
export function project(record: ExecutionRecord): SubagentToolDetails {
  //  1. elapsedSeconds = Math.floor((endedAt ?? Date.now() - startedAt) / 1000)
  //  2. eventLog = record.eventLog.slice()
  //  3. currentActivity = running 时按优先级算（tool > thinking > text）
  void record;
  throw new Error("not implemented");
}

/**
 * 投影到只读快照（TUI list / poll 消费）。
 * 浅拷贝 eventLog，字段标 readonly 阻止 TUI 回写。
 */
export function snapshot(record: ExecutionRecord): RecordSnapshot {
  //  1. 展平 record 字段到 RecordSnapshot
  //  2. eventLog = record.eventLog.slice()
  void record;
  throw new Error("not implemented");
}

// ============================================================
// 持久化投影
// ============================================================

/** 投影到 PersistedAgentRecord（history.jsonl 一行）。预览字段截断。 */
export function toPersisted(record: ExecutionRecord, cwd: string, sessionId?: string): import("../types.ts").PersistedAgentRecord {
  //  1. status/mode/agent/model/thinkingLevel/turns/totalTokens 直取
  //  2. task/result/error 截断为 preview
  //  3. startedAt/endedAt/sessionFile/sessionId/cwd 透传
  void record; void cwd; void sessionId;
  throw new Error("not implemented");
}
