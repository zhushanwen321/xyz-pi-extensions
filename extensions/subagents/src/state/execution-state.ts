// src/state/execution-state.ts
//
// AgentExecutionState：统一的 agent 执行状态对象。
// 所有执行路径（sync / background / poll）的唯一数据源。
//
// 架构设计见 .xyz-harness/2026-06-15-subagent-architecture-consolidation/architecture.md
//
// 核心原则：
//   - 唯一创建入口：createExecutionState（model 创建时必填，消灭 poll 路径 model 丢失）
//   - 唯一事件更新入口：updateStateFromEvent（消灭 eventLog 双构建 + sink reset bug）
//   - 唯一完成入口：completeState
//   - 唯一投影入口：executionStateToDetails（消灭 6 个手工构造点）

import { extractLabelFromArgs } from "../tui/format.ts";
import type { SubagentToolDetails } from "../tui/subagent-render.ts";
import {
  type AgentEvent,
  type AgentEventLogEntry,
  type AgentResult,
  EVENT_LOG_LABEL_MAX,
  MAX_EVENT_LOG_ENTRIES,
  TEXT_OUTPUT_CHUNK,
  THINKING_CHUNK,
  TURN_SUMMARY_MAX,
} from "../types.ts";

/**
 * Bug #2 根因修复：判断事件是否应触发 onUpdate（→ tool block 重绘 → requestRender）。
 *
 * 背景：pi-tui 的 doRender 在 chatContainer 末尾内容变化时，通过
 * previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1)
 * 无条件把 viewport 锚定到底部。subagent tool block 位于 chatContainer 末尾，
 * 每次 onUpdate 都会触发这个锚定。
 *
 * 对比 pi-subagents（execution.ts）：onUpdate 只在 tool 边界
 * (tool_execution_start/end) 和 message 边界 (message_end) 触发，
 * streaming delta（text/thinking）不触发。我们在 text_delta/thinking_delta
 * 上也触发了 onUpdate（每 token 一次），导致 streaming 期间 ~6/s 拉回底部。
 *
 * 此函数让 text_delta/thinking_delta 只累积 eventLog 文本（updateStateFromEvent
 * 仍处理它们），但不触发 onUpdate。离散边界事件才触发 UI 刷新。
 */
export function shouldTriggerUpdate(event: AgentEvent): boolean {
  switch (event.type) {
    case "tool_start":
    case "tool_end":
    case "turn_end":
    case "message_end":
    case "error":
      return true;
    case "text_delta":
    case "thinking_delta":
    case "compaction":
      return false;
  }
}

/** ms → s 换算 */
const MS_PER_SECOND = 1000;

/**
 * 统一的 agent 执行状态。核心层的唯一状态对象。
 *
 * sync: 存于 runtime._runningAgents（Map<id, AgentExecutionState>）
 * background: 内嵌于 BgRecord（BgRecord 持有此对象的引用）
 * poll: getBackground 返回的 BackgroundStatus 内含此对象的展平字段
 *
 * 生命周期：createExecutionState 创建 → updateStateFromEvent 实时更新 → completeState 冻结
 */
export interface AgentExecutionState {
  /** 唯一 ID（sync: "run-N"，bg: "bg-N-xxx"） */
  readonly id: string;

  // ── 身份（创建时确定，不可变）──
  /** agent 名（来自 opts.agent ?? "default"） */
  readonly agent: string;
  /** "provider/modelId"（来自 resolveModelForAgent，创建时必填） */
  readonly model: string;
  /** thinking level（来自 resolveModelForAgent） */
  readonly thinkingLevel: string | undefined;

  // ── 状态（实时更新）──
  /** 当前状态 */
  status: "running" | "done" | "failed" | "cancelled";
  /** 事件日志（ring buffer，max MAX_EVENT_LOG_ENTRIES） */
  eventLog: AgentEventLogEntry[];
  /** 已完成 turn 数 */
  turns: number;
  /** 累计 token 数 */
  totalTokens: number;

  // ── 时间（存时间戳，不存 elapsedSeconds——投影时统一算）──
  readonly startedAt: number;
  endedAt: number | undefined;

  // ── 结果（完成时填）──
  result: string | undefined;
  error: string | undefined;
  /** 完整 AgentResult（done/failed 时，含 usage/toolCalls 详情） */
  agentResult: AgentResult | undefined;

  // ── eventLog chunking 缓冲（持久，跨事件累积——修复 sink reset bug）──
  _currentTurnText: string;
  _currentThinking: string;
}

// ============================================================
// 创建
// ============================================================

/**
 * 唯一创建入口。model **必须提供**——这是 poll 路径 model 丢失的架构修复。
 */
export function createExecutionState(
  id: string,
  opts: {
    agent: string;
    model: string;
    thinkingLevel?: string;
    startedAt: number;
  },
): AgentExecutionState {
  return {
    id,
    agent: opts.agent,
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    status: "running",
    eventLog: [],
    turns: 0,
    totalTokens: 0,
    startedAt: opts.startedAt,
    endedAt: undefined,
    result: undefined,
    error: undefined,
    agentResult: undefined,
    _currentTurnText: "",
    _currentThinking: "",
  };
}

// ============================================================
// 事件更新（唯一更新点——替代 updateWidgetFromEvent + updateRecordEventLog）
// ============================================================

/**
 * 从 AgentEvent 更新 state（eventLog 追加 + turns/tokens 累积）。
 *
 * 关键修复：_currentTurnText/_currentThinking 是 state 的持久字段，
 * 跨事件累积（不再每次创建新 sink）。这修复了 background 路径
 * text_output/thinking 条目丢失的 bug。
 */
export function updateStateFromEvent(state: AgentExecutionState, event: AgentEvent): void {
  // 1. eventLog 构建（复用 appendEventLogEntries 逻辑，读写持久缓冲）
  appendEventLogEntries(state, event);

  // 2. turns 累积
  if (event.type === "turn_end") {
    state.turns += 1;
  }

  // 3. tokens 累积
  if (event.type === "message_end" && event.usage) {
    state.totalTokens +=
      event.usage.input + event.usage.output + event.usage.cacheRead + event.usage.cacheWrite;
  }
}

/**
 * eventLog 追加的核心逻辑（从 event-log-builder.ts 的 appendEventLogEntries 移植）。
 * 直接 mutate state.eventLog + state._currentTurnText/_currentThinking。
 */
function appendEventLogEntries(state: AgentExecutionState, event: AgentEvent): void {
  const log = state.eventLog;
  switch (event.type) {
    case "tool_start": {
      const label = extractLabelFromArgs(event.toolName, event.args);
      log.push({ type: "tool_start", label, ts: Date.now(), status: "running" });
      break;
    }
    case "tool_end": {
      const label = extractLabelFromArgs(event.toolName, undefined);
      log.push({ type: "tool_end", label, ts: Date.now(), status: event.isError ? "failed" : "done" });
      break;
    }
    case "text_delta": {
      state._currentTurnText += event.delta;
      while (state._currentTurnText.length >= TEXT_OUTPUT_CHUNK) {
        log.push({ type: "text_output", label: state._currentTurnText.slice(0, EVENT_LOG_LABEL_MAX), ts: Date.now() });
        state._currentTurnText = state._currentTurnText.slice(EVENT_LOG_LABEL_MAX);
      }
      break;
    }
    case "thinking_delta": {
      state._currentThinking += event.delta;
      while (state._currentThinking.length >= THINKING_CHUNK) {
        log.push({ type: "thinking", label: state._currentThinking.slice(0, EVENT_LOG_LABEL_MAX), ts: Date.now() });
        state._currentThinking = state._currentThinking.slice(EVENT_LOG_LABEL_MAX);
      }
      break;
    }
    case "turn_end": {
      // flush 残留的 text/thinking 缓冲
      const turnSummary = state._currentTurnText.slice(0, TURN_SUMMARY_MAX);
      if (state._currentTurnText) {
        log.push({ type: "text_output", label: state._currentTurnText.slice(0, EVENT_LOG_LABEL_MAX), ts: Date.now() });
        state._currentTurnText = "";
      }
      if (state._currentThinking) {
        log.push({ type: "thinking", label: state._currentThinking.slice(0, EVENT_LOG_LABEL_MAX), ts: Date.now() });
        state._currentThinking = "";
      }
      log.push({ type: "turn_end", label: turnSummary, ts: Date.now() });
      break;
    }
    default:
      break;
  }
  // Ring buffer: 超上限移除最旧
  while (log.length > MAX_EVENT_LOG_ENTRIES) {
    log.shift();
  }
}

// ============================================================
// 完成
// ============================================================

/**
 * 唯一完成入口。冻结状态（写 endedAt + agentResult）。
 */
export function completeState(
  state: AgentExecutionState,
  result: AgentResult,
  status: "done" | "failed" | "cancelled",
): void {
  state.status = status;
  state.endedAt = Date.now();
  state.agentResult = result;
  state.result = result.text;
  state.error = result.error;
}

// ============================================================
// 投影（唯一投影入口——消灭 6 个手工构造点）
// ============================================================

/**
 * 投影到 SubagentToolDetails（核心层→展示层唯一桥梁）。
 *
 * elapsedSeconds 在此**唯一计算**（Math.floor），消灭历史 6 个计算点
 * 的 floor/round 不一致。
 */
export function executionStateToDetails(state: AgentExecutionState): SubagentToolDetails {
  const elapsedSeconds = state.endedAt
    ? Math.floor((state.endedAt - state.startedAt) / MS_PER_SECOND)
    : Math.floor((Date.now() - state.startedAt) / MS_PER_SECOND);

  return {
    eventLog: state.eventLog,
    status: state.status,
    agent: state.agent,
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    turns: state.turns,
    totalTokens: state.totalTokens,
    elapsedSeconds,
    result: state.result,
    error: state.error,
  };
}
