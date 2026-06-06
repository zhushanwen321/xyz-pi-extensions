/**
 * Turn Timing — 单元测试
 *
 * 测试覆盖：
 * 1. extractPhaseName — 事件类型解析
 * 2. finalizePhase — duration 计算
 * 3. createTimingCollector — 完整流程（单 phase、多 phase、tool execution、flush 重置）
 */

import { describe, expect, it } from "vitest";

import { createTimingCollector } from "../collector.ts";
import { extractPhaseName, finalizePhase } from "../types.ts";
import type { PhaseTiming } from "../types.ts";

// ════════════════════════════════════════════════════════
// 1. extractPhaseName
// ════════════════════════════════════════════════════════

describe("extractPhaseName", () => {
  it("thinking_start → { phase: thinking, boundary: start }", () => {
    expect(extractPhaseName("thinking_start")).toEqual({
      phase: "thinking",
      boundary: "start",
    });
  });

  it("thinking_end → { phase: thinking, boundary: end }", () => {
    expect(extractPhaseName("thinking_end")).toEqual({
      phase: "thinking",
      boundary: "end",
    });
  });

  it("text_start → { phase: text, boundary: start }", () => {
    expect(extractPhaseName("text_start")).toEqual({
      phase: "text",
      boundary: "start",
    });
  });

  it("toolcall_start → { phase: toolcall, boundary: start }", () => {
    expect(extractPhaseName("toolcall_start")).toEqual({
      phase: "toolcall",
      boundary: "start",
    });
  });

  it("start → null（流开始，非阶段边界）", () => {
    expect(extractPhaseName("start")).toBeNull();
  });

  it("done → null（流结束，非阶段边界）", () => {
    expect(extractPhaseName("done")).toBeNull();
  });

  it("text_delta → null（非边界事件）", () => {
    expect(extractPhaseName("text_delta")).toBeNull();
  });

  it("unknown_event → null", () => {
    expect(extractPhaseName("unknown_event")).toBeNull();
  });
});

// ════════════════════════════════════════════════════════
// 2. finalizePhase
// ════════════════════════════════════════════════════════

describe("finalizePhase", () => {
  it("有 start + end 时计算 duration", () => {
    const phase: PhaseTiming = { phase: "thinking", start: 1000, end: 2500 };
    const result = finalizePhase(phase);
    expect(result.duration).toBe(1500);
  });

  it("已有 duration 时不变", () => {
    const phase: PhaseTiming = {
      phase: "text",
      start: 100,
      end: 200,
      duration: 100,
    };
    expect(finalizePhase(phase).duration).toBe(100);
  });

  it("缺少 end 时不变", () => {
    const phase: PhaseTiming = { phase: "thinking", start: 1000 };
    expect(finalizePhase(phase).duration).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════
// 3. createTimingCollector — 完整流程
// ════════════════════════════════════════════════════════

describe("createTimingCollector", () => {
  it("单 thinking 阶段", () => {
    const c = createTimingCollector();
    c.onMessageUpdate("thinking_start", 1000);
    c.onMessageUpdate("thinking_end", 3000);

    const data = c.flush();
    expect(data.phases).toHaveLength(1);
    expect(data.phases[0]).toEqual({
      phase: "thinking",
      start: 1000,
      end: 3000,
      duration: 2000,
    });
  });

  it("thinking + toolcall 两个阶段", () => {
    const c = createTimingCollector();
    c.onMessageUpdate("thinking_start", 1000);
    c.onMessageUpdate("thinking_end", 3000);
    c.onMessageUpdate("toolcall_start", 3001);
    c.onMessageUpdate("toolcall_end", 3050);

    const data = c.flush();
    expect(data.phases).toHaveLength(2);
    expect(data.phases[0]).toEqual(
      expect.objectContaining({ phase: "thinking", duration: 2000 }),
    );
    expect(data.phases[1]).toEqual(
      expect.objectContaining({ phase: "toolcall", duration: 49 }),
    );
  });

  it("thinking + text（无 toolCall 的 turn）", () => {
    const c = createTimingCollector();
    c.onMessageUpdate("thinking_start", 100);
    c.onMessageUpdate("thinking_end", 200);
    c.onMessageUpdate("text_start", 200);
    c.onMessageUpdate("text_end", 500);

    const data = c.flush();
    expect(data.phases).toHaveLength(2);
    expect(data.phases[0]!.phase).toBe("thinking");
    expect(data.phases[1]!.phase).toBe("text");
    expect(data.phases[1]!.duration).toBe(300);
  });

  it("tool_execution 阶段通过 onToolExecutionStart/End 记录", () => {
    const c = createTimingCollector();
    c.onToolExecutionStart("call_1", "bash", 1000);
    c.onToolExecutionEnd("call_1", 3500);

    const data = c.flush();
    expect(data.phases).toHaveLength(1);
    expect(data.phases[0]).toEqual({
      phase: "tool_execution",
      start: 1000,
      end: 3500,
      duration: 2500,
      toolCallId: "call_1",
      toolName: "bash",
    });
  });

  it("多个并行 tool execution", () => {
    const c = createTimingCollector();
    c.onToolExecutionStart("call_1", "bash", 1000);
    c.onToolExecutionStart("call_2", "read", 1001);
    c.onToolExecutionEnd("call_1", 2000);
    c.onToolExecutionEnd("call_2", 1500);

    const data = c.flush();
    expect(data.phases).toHaveLength(2);

    // 按 toolCallId 查找，不依赖顺序
    const bash = data.phases.find((p) => p.toolCallId === "call_1");
    const read = data.phases.find((p) => p.toolCallId === "call_2");

    expect(bash).toEqual(
      expect.objectContaining({
        toolName: "bash",
        duration: 1000,
      }),
    );
    expect(read).toEqual(
      expect.objectContaining({
        toolName: "read",
        duration: 499,
      }),
    );
  });

  it("完整 turn：thinking → toolcall → tool_execution", () => {
    const c = createTimingCollector();
    c.onMessageUpdate("thinking_start", 1000);
    c.onMessageUpdate("thinking_end", 2500);
    c.onMessageUpdate("toolcall_start", 2501);
    c.onMessageUpdate("toolcall_end", 2560);
    c.onToolExecutionStart("call_1", "bash", 2560);
    c.onToolExecutionEnd("call_1", 5000);

    const data = c.flush();
    expect(data.phases).toHaveLength(3);

    expect(data.phases[0]).toEqual(
      expect.objectContaining({ phase: "thinking", duration: 1500 }),
    );
    expect(data.phases[1]).toEqual(
      expect.objectContaining({ phase: "toolcall", duration: 59 }),
    );
    expect(data.phases[2]).toEqual(
      expect.objectContaining({
        phase: "tool_execution",
        toolName: "bash",
        duration: 2440,
      }),
    );
  });

  it("flush 后 collector 重置为空", () => {
    const c = createTimingCollector();
    c.onMessageUpdate("thinking_start", 100);
    c.onMessageUpdate("thinking_end", 200);
    c.flush();

    expect(c.flush().phases).toHaveLength(0);
  });

  it("getPhases 返回当前累计状态", () => {
    const c = createTimingCollector();
    c.onMessageUpdate("thinking_start", 100);
    c.onMessageUpdate("thinking_end", 200);

    expect(c.getPhases()).toHaveLength(1);
    c.flush();
    expect(c.getPhases()).toHaveLength(0);
  });

  it("未关闭的 phase 在 flush 时保留（无 duration）", () => {
    const c = createTimingCollector();
    c.onMessageUpdate("thinking_start", 1000);
    // 没有 thinking_end

    const data = c.flush();
    expect(data.phases).toHaveLength(1);
    expect(data.phases[0]!.phase).toBe("thinking");
    expect(data.phases[0]!.start).toBe(1000);
    expect(data.phases[0]!.end).toBeUndefined();
    expect(data.phases[0]!.duration).toBeUndefined();
  });

  it("忽略无法识别的事件类型", () => {
    const c = createTimingCollector();
    c.onMessageUpdate("start", 100);
    c.onMessageUpdate("text_delta", 150);
    c.onMessageUpdate("done", 200);

    expect(c.flush().phases).toHaveLength(0);
  });

  it("tool_execution_end 对不存在的 toolCallId 无副作用", () => {
    const c = createTimingCollector();
    c.onToolExecutionEnd("nonexistent", 1000);
    expect(c.flush().phases).toHaveLength(0);
  });
});
