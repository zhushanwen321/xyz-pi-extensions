/**
 * Turn Timing — 核心 hook 逻辑
 *
 * 监听 message_update / tool_execution_start / tool_execution_end / turn_end，
 * 收集每个阶段的起止时间，turn 结束时写入 custom entry。
 */

import type { PhaseTiming, TurnTimingData } from "./types.ts";
import { extractPhaseName, finalizePhase } from "./types.ts";

/**
 * 创建一个 per-turn 的计时收集器。
 * 返回事件处理函数和 flush 方法。
 *
 * 设计为纯逻辑，不依赖 Pi API，便于测试。
 */
export function createTimingCollector() {
  const phases: PhaseTiming[] = [];

  /** 处理 message_update 事件中的 assistantMessageEvent */
  function onMessageUpdate(eventType: string, now: number): void {
    const extracted = extractPhaseName(eventType);
    if (!extracted) return;

    if (extracted.boundary === "start") {
      phases.push({ phase: extracted.phase, start: now });
    } else {
      closePhase(extracted.phase, now);
    }
  }

  /** 处理 tool_execution_start */
  function onToolExecutionStart(toolCallId: string, toolName: string, now: number): void {
    phases.push({
      phase: "tool_execution",
      start: now,
      toolCallId,
      toolName,
    });
  }

  /** 处理 tool_execution_end */
  function onToolExecutionEnd(toolCallId: string, now: number): void {
    // findLast 语义：从后往前找第一个未关闭的匹配 toolCallId
    for (let i = phases.length - 1; i >= 0; i--) {
      const p = phases[i];
      if (p && p.phase === "tool_execution" && p.toolCallId === toolCallId && p.end === undefined) {
        phases[i] = finalizePhase({ ...p, end: now });
        return;
      }
    }
  }

  /** 关闭一个 LLM phase（thinking/text/toolcall） */
  function closePhase(phase: PhaseTiming["phase"], now: number): void {
    for (let i = phases.length - 1; i >= 0; i--) {
      const p = phases[i];
      if (p && p.phase === phase && p.end === undefined) {
        phases[i] = finalizePhase({ ...p, end: now });
        return;
      }
    }
  }

  /** 收集结果并重置状态 */
  function flush(): TurnTimingData {
    // 对未关闭的 phase 做 finalize（理论上不应出现）
    const result: TurnTimingData = {
      phases: phases.map((p) =>
        p.end !== undefined ? finalizePhase(p) : p,
      ),
    };
    phases.length = 0;
    return result;
  }

  /** 获取当前累计的 phases（用于调试/测试） */
  function getPhases(): readonly PhaseTiming[] {
    return phases;
  }

  return {
    onMessageUpdate,
    onToolExecutionStart,
    onToolExecutionEnd,
    flush,
    getPhases,
  };
}

export type TimingCollector = ReturnType<typeof createTimingCollector>;
