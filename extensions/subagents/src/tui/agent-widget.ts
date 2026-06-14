// src/tui/agent-widget.ts
//
// FR-2.0: inline widget 渲染层已删除（renderWidget / renderStatusLine /
// AgentWidgetManager / WidgetUI 全部移除）。
// 仅保留 WidgetAgentState 作为 running agent 状态载体：
//   - runtime.ts 的 runAgent/startBackground 用它累积 eventLog（updateWidgetFromEvent）
//   - /subagents list 的 getAllRecords 从 runtime.listRunningAgents() 读取

import type { AgentEventLogEntry } from "../types.ts";

/** 单个 agent 的运行状态快照（running agent 状态载体，非渲染） */
export interface WidgetAgentState {
  readonly id: string;
  readonly agent: string;
  status: "running" | "done" | "failed" | "cancelled";
  /** 当前 turn 数 */
  turns?: number;
  /** 累计 token 数 */
  totalTokens?: number;
  /** 已运行秒数 */
  elapsedSeconds?: number;
  /** 当前工具动作描述 */
  activity?: string;
  /** 完成时的输出摘要（done/failed 时） */
  summary?: string;
  /** 完成时间戳（用于 linger 淡出） */
  finishedAt?: number;
  /** FR-1.1: 事件日志（ring buffer），由 updateWidgetFromEvent 追加 */
  eventLog?: AgentEventLogEntry[];
  /** FR-1.1b: 当前 turn 文本累加缓冲（turn_end 时切片后重置） */
  _currentTurnText?: string;
  /** FR-1.1a: thinking delta 累加缓冲（切片后重置） */
  _currentThinking?: string;
}
