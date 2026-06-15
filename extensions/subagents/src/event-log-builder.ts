// src/event-log-builder.ts
//
// S5 + FR-1.1b/1.1a: eventLog 构建的纯函数集。
// 从 runtime.ts 拆出（避免 runtime.ts 超 1000 行上限）。
// 三个导出：
//   - updateWidgetFromEvent: 给 WidgetAgentState 用（sync runAgent）
//   - updateRecordEventLog: 给 BgRecord.eventLog 用（background，G-005 闭包捕获）
//   - appendEventLogEntries: 共享底层（S5 抽取）

import { extractLabelFromArgs } from "./tui/format.ts";
import type { WidgetAgentState } from "./tui/agent-widget.ts";
import {
  type AgentEventLogEntry,
  EVENT_LOG_LABEL_MAX,
  MAX_EVENT_LOG_ENTRIES,
  TEXT_OUTPUT_CHUNK,
  THINKING_CHUNK,
  TURN_SUMMARY_MAX,
} from "./types.ts";

/**
 * S5: eventLog 追加的最小契约——只需 eventLog 数组 + _currentTurnText/_currentThinking 累积器。
 * WidgetAgentState 和 BgRecord.eventLog 都满足此形状，避免 as unknown as 断言。
 */
interface EventLogSink {
  eventLog?: AgentEventLogEntry[];
  _currentTurnText?: string;
  /** FR-1.1a: thinking delta 累加缓冲（切片后重置） */
  _currentThinking?: string;
}

/** S5: appendEventLogEntries 接受的事件形状 */
type EventLogSinkEvent = {
  type: string;
  toolName?: string;
  args?: unknown;
  delta?: string;
  isError?: boolean;
};

/**
 * 从 AgentEvent 更新 widget 状态（turns/tokens/activity + eventLog 追加 + 切片）。
 * FR-1.1b: text_delta 累加，turn_end 切片生成 text_output + summary。
 * FR-1.1a: thinking_delta 切片生成 thinking entry。
 * FR-1.3: tool_start/tool_end/turn_end push 到 eventLog（ring buffer）。
 */
/**
 * @deprecated Wave 4: 被 state/execution-state.ts 的 updateStateFromEvent 替代。
 * 保留仅为 runtime-eventlog.test.ts 兼容。新代码用 updateStateFromEvent。
 */
export function updateWidgetFromEvent(
  state: WidgetAgentState,
  event: {
    type: string;
    toolName?: string;
    args?: unknown;
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    delta?: string;
    isError?: boolean;
  },
  _startTime: number,
): void {
  // Wave 4: 委托给 appendEventLogEntries（与 updateStateFromEvent 共享核心逻辑）
  // activity/elapsedSeconds 字段已从 AgentExecutionState 移除（不再需要）
  appendEventLogEntries(state, event);
  if (event.type === "turn_end") {
    state.turns = (state.turns ?? 0) + 1;
  } else if (event.type === "message_end" && event.usage) {
    state.totalTokens = (state.totalTokens ?? 0) + event.usage.input + event.usage.output + event.usage.cacheRead + event.usage.cacheWrite;
  }
}

/**
 * S5: 从 updateWidgetFromEvent 抽取的纯 eventLog 追加逻辑（tool_start/tool_end/
 * text_delta/thinking_delta/turn_end 五种事件类型）。直接 mutate sink.eventLog
 * （push + ring buffer）。调用方（updateWidgetFromEvent / updateRecordEventLog）
 * 负责各自的附带字段更新。
 */
function appendEventLogEntries(sink: EventLogSink, event: EventLogSinkEvent): void {
  if (!sink.eventLog) sink.eventLog = [];
  const log = sink.eventLog;
  switch (event.type) {
    case "tool_start": {
      const label = extractLabelFromArgs(event.toolName ?? "working", event.args);
      log.push({ type: "tool_start", label, ts: Date.now(), status: "running" });
      break;
    }
    case "tool_end": {
      const label = extractLabelFromArgs(event.toolName ?? "working", event.args);
      log.push({ type: "tool_end", label, ts: Date.now(), status: event.isError ? "failed" : "done" });
      break;
    }
    case "text_delta": {
      sink._currentTurnText = (sink._currentTurnText ?? "") + (event.delta ?? "");
      // FR-1.1b: 节流切片——累计达 TEXT_OUTPUT_CHUNK 产生一条 text_output log entry。
      // 切片后保留余数继续累计（不丢弃），使长文本能产生多条 text_output 快照。
      while ((sink._currentTurnText ?? "").length >= TEXT_OUTPUT_CHUNK) {
        const buf: string = sink._currentTurnText ?? "";
        log.push({ type: "text_output", label: buf.slice(0, EVENT_LOG_LABEL_MAX), ts: Date.now() });
        sink._currentTurnText = buf.slice(EVENT_LOG_LABEL_MAX);
      }
      break;
    }
    case "thinking_delta": {
      sink._currentThinking = (sink._currentThinking ?? "") + (event.delta ?? "");
      // FR-1.1a: 节流切片——同 text_output 逻辑，保留余数
      while ((sink._currentThinking ?? "").length >= THINKING_CHUNK) {
        const buf: string = sink._currentThinking ?? "";
        log.push({ type: "thinking", label: buf.slice(0, EVENT_LOG_LABEL_MAX), ts: Date.now() });
        sink._currentThinking = buf.slice(EVENT_LOG_LABEL_MAX);
      }
      break;
    }
    case "turn_end": {
      // FR-1.1b: flush 残留的 text/thinking 缓冲。
      // 注意：先取 summary 再 flush——turn_end 的 label 用本 turn 的完整文本，
      // 同时 text_output entry 切片独立产出（与 summary 不互斥）。
      const turnSummary = (sink._currentTurnText ?? "").slice(0, TURN_SUMMARY_MAX);
      if (sink._currentTurnText) {
        log.push({ type: "text_output", label: sink._currentTurnText.slice(0, EVENT_LOG_LABEL_MAX), ts: Date.now() });
        sink._currentTurnText = "";
      }
      if (sink._currentThinking) {
        log.push({ type: "thinking", label: sink._currentThinking.slice(0, EVENT_LOG_LABEL_MAX), ts: Date.now() });
        sink._currentThinking = "";
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

// Wave 3: updateRecordEventLog 已删除（被 state/execution-state.ts 的 updateStateFromEvent 替代）。
// 历史问题：updateRecordEventLog 每次事件创建新 EventLogSink（_currentTurnText=""），
// 导致 text/thinking 缓冲永不累积——background 路径 eventLog chunking 坏。
// updateStateFromEvent 使用 state 上的持久缓冲（_currentTurnText/_currentThinking），修复此 bug。
