/**
 * Turn Timing — 类型定义
 *
 * 每个 turn 分为多个 phase，记录起止时间戳和持续时间。
 */

/** 单个阶段的计时记录 */
export interface PhaseTiming {
  /** 阶段名称 */
  phase: "thinking" | "text" | "toolcall" | "tool_execution";
  /** 开始时间 (epoch ms) */
  start: number;
  /** 结束时间 (epoch ms)，未结束时为 undefined */
  end?: number;
  /** 持续时间 (ms)，未结束时为 undefined */
  duration?: number;
  /** tool_execution 阶段关联的 toolCallId */
  toolCallId?: string;
  /** tool_execution 阶段关联的工具名称 */
  toolName?: string;
}

/** 写入 session entry 的 timing 数据 */
export interface TurnTimingData {
  phases: PhaseTiming[];
}

/** AssistantMessageEvent 的 type 联合（只关心计时的子集） */
export type TimingEventType =
  | "start"
  | "thinking_start"
  | "thinking_end"
  | "text_start"
  | "text_end"
  | "toolcall_start"
  | "toolcall_end"
  | "done";

/** assistantMessageEvent 中需要识别的阶段边界 */
const PHASE_START_SUFFIX = "_start" as const;
const PHASE_END_SUFFIX = "_end" as const;

/**
 * 从事件类型中提取阶段名称
 * "thinking_start" → "thinking", "text_end" → "text"
 * 返回 null 表示不是阶段边界事件
 */
export function extractPhaseName(
  eventType: string,
): { phase: PhaseTiming["phase"]; boundary: "start" | "end" } | null {
  if (eventType === "start" || eventType === "done") return null;

  if (eventType.endsWith(PHASE_END_SUFFIX)) {
    const raw = eventType.slice(0, -PHASE_END_SUFFIX.length);
    if (isPhase(raw)) return { phase: raw, boundary: "end" };
  }

  if (eventType.endsWith(PHASE_START_SUFFIX)) {
    const raw = eventType.slice(0, -PHASE_START_SUFFIX.length);
    if (isPhase(raw)) return { phase: raw, boundary: "start" };
  }

  return null;
}

function isPhase(value: string): value is PhaseTiming["phase"] {
  return value === "thinking" || value === "text" || value === "toolcall" || value === "tool_execution";
}

/** 计算并填充 duration 字段 */
export function finalizePhase(phase: PhaseTiming): PhaseTiming {
  if (phase.end !== undefined && phase.duration === undefined) {
    return { ...phase, duration: phase.end - phase.start };
  }
  return phase;
}
