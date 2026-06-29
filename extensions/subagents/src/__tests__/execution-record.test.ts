// src/__tests__/execution-record.test.ts
import { describe, expect, it } from "vitest";

import {
  completeRecord,
  computeElapsedSeconds,
  createRecord,
  extractLabelFromArgs,
  getAllToolCalls,
  getCurrentActivity,
  getEventLog,
  getFullText,
  getTotalUsage,
  markReconstructedStatus,
  project,
  snapshot,
  tryTransition,
  updateFromEvent,
} from "../core/execution-record.ts";
import type { AgentResult, ExecutionRecord, Turn } from "../types.ts";

// ── 常量（与源码 module-private 值对齐，测试用字面量）──
const TURN_SUMMARY_MAX = 80;

// ── 工厂 ──
function emptyTurn(): Turn {
  return { text: "", thinking: "", toolCalls: [], usageDelta: undefined, closed: false, closedTs: undefined };
}

function makeRecord(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "test-1",
    agent: "worker",
    model: "test-model",
    thinkingLevel: undefined,
    mode: "sync",
    task: "test task",
    startedAt: 1000,
    status: "running",
    turns: [emptyTurn()],
    turnCount: 0,
    totalTokens: 0,
    lastError: undefined,
    endedAt: undefined,
    result: undefined,
    error: undefined,
    agentResult: undefined,
    controller: undefined,
    ...over,
  };
}

const SAMPLE_RESULT: AgentResult = {
  text: "done",
  turns: 1,
  durationMs: 500,
  success: true,
  sessionId: "sess-1",
  toolCalls: [],
};

// ============================================================
// createRecord
// ============================================================
describe("createRecord", () => {
  it("creates a record with identity fields frozen and defaults", () => {
    const r = createRecord("r1", {
      agent: "reviewer",
      model: "m1",
      thinkingLevel: "high",
      mode: "background",
      task: "review PR",
      startedAt: 2000,
    });
    expect(r.id).toBe("r1");
    expect(r.agent).toBe("reviewer");
    expect(r.model).toBe("m1");
    expect(r.thinkingLevel).toBe("high");
    expect(r.mode).toBe("background");
    expect(r.task).toBe("review PR");
    expect(r.startedAt).toBe(2000);

    // defaults——turns[] 初始化为 [空 turn]，turnCount=0
    expect(r.status).toBe("running");
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]).toMatchObject({ text: "", thinking: "", toolCalls: [], closed: false });
    expect(r.turnCount).toBe(0);
    expect(r.totalTokens).toBe(0);
    expect(r.lastError).toBeUndefined();
    expect(r.endedAt).toBeUndefined();
    expect(r.result).toBeUndefined();
    expect(r.error).toBeUndefined();
    expect(r.agentResult).toBeUndefined();
  });

  it("stores controller when provided (background)", () => {
    const controller = new AbortController();
    const r = createRecord("r1", {
      agent: "w", model: "m", mode: "background", task: "t", startedAt: 0, controller,
    });
    expect(r.controller).toBe(controller);
  });

  it("stores parentSessionId when provided", () => {
    const r = createRecord("r1", {
      agent: "w", model: "m", mode: "sync", task: "t", startedAt: 0, parentSessionId: "sess-A",
    });
    expect(r.parentSessionId).toBe("sess-A");
  });

  it("defaults parentSessionId to undefined when omitted", () => {
    const r = createRecord("r1", {
      agent: "w", model: "m", mode: "sync", task: "t", startedAt: 0,
    });
    expect(r.parentSessionId).toBeUndefined();
  });
});

// ============================================================
// updateFromEvent — turns accumulation
// ============================================================
describe("updateFromEvent", () => {
  describe("turnCount accumulation", () => {
    it("increments turnCount on turn_end", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "turn_end", summary: "done" });
      expect(r.turnCount).toBe(1);
      updateFromEvent(r, { type: "turn_end" });
      expect(r.turnCount).toBe(2);
    });

    it("does not increment turnCount on other events", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "text_delta", delta: "hi" });
      updateFromEvent(r, { type: "tool_start", toolName: "read" });
      updateFromEvent(r, { type: "message_end" });
      expect(r.turnCount).toBe(0);
    });
  });

  describe("totalTokens accumulation", () => {
    it("sums all usage fields on message_end", () => {
      const r = makeRecord();
      updateFromEvent(r, {
        type: "message_end",
        usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 3 },
      });
      expect(r.totalTokens).toBe(38);
    });

    it("accumulates across multiple message_end events", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "message_end", usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } });
      updateFromEvent(r, { type: "message_end", usage: { input: 2, output: 2, cacheRead: 2, cacheWrite: 2 } });
      expect(r.totalTokens).toBe(12);
    });

    it("ignores message_end without usage", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "message_end" });
      expect(r.totalTokens).toBe(0);
    });

    it("stores usageDelta on current turn", () => {
      const r = makeRecord();
      updateFromEvent(r, {
        type: "message_end",
        usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 3 },
      });
      expect(r.turns[0]?.usageDelta).toEqual({ input: 10, output: 20, cacheRead: 5, cacheWrite: 3 });
    });
  });

  // ============================================================
  // text / thinking accumulation (替代旧 chunking)
  // ============================================================
  describe("text accumulation", () => {
    it("accumulates text_delta into current turn.text (完整内容，非切片)", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "text_delta", delta: "Hello " });
      updateFromEvent(r, { type: "text_delta", delta: "world" });
      expect(r.turns[0]?.text).toBe("Hello world");
    });

    it("text accumulation survives long delta (>100 chars, no chunking)", () => {
      const r = makeRecord();
      const longText = "y".repeat(350);
      updateFromEvent(r, { type: "text_delta", delta: longText });
      // 完整存储，不切片——这是收口设计的核心
      expect(r.turns[0]?.text).toBe(longText);
      expect(r.turns).toHaveLength(1);
    });
  });

  describe("thinking accumulation", () => {
    it("accumulates thinking_delta into current turn.thinking (完整内容)", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "thinking_delta", delta: "Analyzing " });
      updateFromEvent(r, { type: "thinking_delta", delta: "the problem" });
      expect(r.turns[0]?.thinking).toBe("Analyzing the problem");
    });
  });

  describe("turn boundary", () => {
    it("turn_end closes current turn; next delta opens new turn", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "text_delta", delta: "turn 1 text" });
      updateFromEvent(r, { type: "turn_end" });
      expect(r.turns[0]?.closed).toBe(true);
      expect(r.turnCount).toBe(1);

      // 新 delta 开新 turn
      updateFromEvent(r, { type: "text_delta", delta: "turn 2 text" });
      expect(r.turns).toHaveLength(2);
      expect(r.turns[1]?.closed).toBe(false);
      expect(r.turns[1]?.text).toBe("turn 2 text");
      // turn 1 不受影响
      expect(r.turns[0]?.text).toBe("turn 1 text");
    });

    it("turn_end closes turn and records closedTs (real wall-clock)", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "text_delta", delta: "partial" });
      const before = Date.now();
      updateFromEvent(r, { type: "turn_end" });
      const after = Date.now();
      expect(r.turns[0]?.closed).toBe(true);
      expect(r.turns[0]?.closedTs).toBeGreaterThanOrEqual(before);
      expect(r.turns[0]?.closedTs).toBeLessThanOrEqual(after);
      // turn_end 不再覆盖已累积的 text（旧 dead branch 已移除）
      expect(r.turns[0]?.text).toBe("partial");
      expect(r.turnCount).toBe(1);
    });

    it("turn_end clears lastError (transient error recovery → success)", () => {
      // 瞬态 error 到达后，若 turn 正常闭合，lastError 应清空——
      // 否则 session-runner 会据残留 lastError 把成功误判为 success=false。
      const r = makeRecord();
      updateFromEvent(r, { type: "error", message: "transient" });
      expect(r.lastError).toBe("transient");
      updateFromEvent(r, { type: "turn_end" });
      expect(r.lastError).toBeUndefined();
    });

    it("turn_end after turn_end: next delta opens 3rd turn (not mutate 2nd)", () => {
      // 连续两次 turn_end 后再发 text_delta，应 push 第 3 个 turn，
      // 而非回填已 closed 的第 2 个空 turn。
      const r = makeRecord();
      updateFromEvent(r, { type: "text_delta", delta: "t1" });
      updateFromEvent(r, { type: "turn_end" });
      updateFromEvent(r, { type: "turn_end" }); // 第 2 个空 turn 立即 closed
      updateFromEvent(r, { type: "text_delta", delta: "t3" });
      expect(r.turns).toHaveLength(3);
      expect(r.turns[0]?.text).toBe("t1");
      expect(r.turns[1]?.text).toBe(""); // 第 2 个空 turn 未被回填
      expect(r.turns[2]?.text).toBe("t3");
    });
  });

  // ============================================================
  // tool events → turn.toolCalls
  // ============================================================
  describe("tool events", () => {
    it("tool_start pushes a running ToolCall into current turn", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolName: "read", args: { path: "/a/b/foo.ts" } });
      expect(r.turns[0]?.toolCalls).toHaveLength(1);
      expect(r.turns[0]?.toolCalls[0]).toMatchObject({
        toolName: "read",
        _status: "running",
      });
    });

    it("tool_end matches back running toolCall and sets result/status", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolName: "bash", args: { command: "ls" } });
      const result = { content: [{ type: "text", text: "file.ts" }] };
      updateFromEvent(r, { type: "tool_end", toolName: "bash", args: { command: "ls" }, result });
      const tc = r.turns[0]?.toolCalls[0];
      expect(tc).toMatchObject({ toolName: "bash", _status: "done", isError: false });
      expect(tc?.result).toBe(result);
    });

    it("tool_end sets failed status when isError", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolName: "bash", args: { command: "rm" } });
      updateFromEvent(r, { type: "tool_end", toolName: "bash", args: { command: "rm" }, isError: true });
      expect(r.turns[0]?.toolCalls[0]?._status).toBe("failed");
      expect(r.turns[0]?.toolCalls[0]?.isError).toBe(true);
    });

    it("tool_end without matching tool_start pushes a completed ToolCall", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_end", toolName: "external", args: {} });
      expect(r.turns[0]?.toolCalls).toHaveLength(1);
      expect(r.turns[0]?.toolCalls[0]?._status).toBe("done");
    });

    it("LIFO matching: same-name tool twice, tool_end matches last running", () => {
      // 同 turn 内两次 tool_start: bash → tool_end: bash 倒序匹配最后一个 running。
      // 正序匹配会错误地把 result 填到第一个 bash，留下第二个 running。
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolName: "bash", args: { command: "cmd-a" } });
      updateFromEvent(r, { type: "tool_start", toolName: "bash", args: { command: "cmd-b" } });
      const resultA = { content: [{ type: "text", text: "A" }] };
      updateFromEvent(r, { type: "tool_end", toolName: "bash", args: { command: "cmd-b" }, result: resultA });
      const calls = r.turns[0]?.toolCalls ?? [];
      expect(calls).toHaveLength(2);
      // 第二个 bash（cmd-b）命中 LIFO，标记 done + result=A
      expect(calls[1]?._status).toBe("done");
      expect(calls[1]?.result).toBe(resultA);
      // 第一个 bash（cmd-a）仍未匹配，仍 running
      expect(calls[0]?._status).toBe("running");
      expect(calls[0]?.result).toBeUndefined();
    });

    it("tool_end without result leaves result undefined (SDK may omit result)", () => {
      // SDK 契约下 tool_end 的 result 可为 undefined——不应抛错，getEventLog 仍正常派生。
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolName: "read", args: { path: "/a.ts" } });
      updateFromEvent(r, { type: "tool_end", toolName: "read", args: { path: "/a.ts" } });
      expect(r.turns[0]?.toolCalls[0]?.result).toBeUndefined();
      expect(r.turns[0]?.toolCalls[0]?._status).toBe("done");
      // getEventLog 仍能派生 tool_start/tool_end 对
      const log = getEventLog(r);
      expect(log.map((e) => e.type)).toEqual(["tool_start", "tool_end", "turn_end"].slice(0, 2));
    });

    it("tool_end matches running toolCall across turns (lagged SDK event)", () => {
      // SDK 在 turn_end 后仍可能补发滞后的 tool_end——跨 turn 扫描兜底，
      // 不误 push 幽灵 ToolCall。
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolName: "read", args: { path: "/a.ts" } });
      updateFromEvent(r, { type: "turn_end" }); // turn[0] closed，read 仍 running
      updateFromEvent(r, { type: "tool_end", toolName: "read", args: { path: "/a.ts" } });
      // 匹配到 turn[0] 的 read（跨 turn 扫描命中），未产生幽灵 ToolCall
      expect(r.turns).toHaveLength(1); // 没有 turn[1]——tool_end 单独不开新 turn
      expect(r.turns[0]?.toolCalls[0]?._status).toBe("done");
      expect(r.turns[0]?.toolCalls).toHaveLength(1);
    });
  });

  // ============================================================
  // error event → record.lastError
  // ============================================================
  describe("error event", () => {
    it("stores error message in record.lastError", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "error", message: "boom" });
      expect(r.lastError).toBe("boom");
    });

    it("message_end with error field also sets lastError", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "message_end", error: "provider error" });
      expect(r.lastError).toBe("provider error");
    });
  });

  // ============================================================
  // compaction (no-op)
  // ============================================================
  describe("compaction", () => {
    it("compaction is a no-op", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "compaction" });
      expect(r.turns).toHaveLength(1);
      expect(r.turnCount).toBe(0);
      expect(r.totalTokens).toBe(0);
    });
  });
});

// ============================================================
// getEventLog — 派生事件序列
// ============================================================
describe("getEventLog", () => {
  it("returns empty array for fresh record (empty turn, not closed)", () => {
    const r = makeRecord();
    expect(getEventLog(r)).toEqual([]);
  });

  it("derives tool_start/tool_end pairs from turns[].toolCalls", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "tool_start", toolName: "read", args: { path: "/x.ts" } });
    updateFromEvent(r, { type: "tool_end", toolName: "read", args: { path: "/x.ts" } });
    const log = getEventLog(r);
    expect(log.map((e) => e.type)).toEqual(["tool_start", "tool_end"]);
    expect(log[0]).toMatchObject({ type: "tool_start", label: "read x.ts", status: "running" });
    expect(log[1]).toMatchObject({ type: "tool_end", label: "read x.ts", status: "done" });
  });

  it("running toolCall (no tool_end yet) derives only tool_start", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "tool_start", toolName: "read", args: { path: "/x.ts" } });
    const log = getEventLog(r);
    expect(log.map((e) => e.type)).toEqual(["tool_start"]);
  });

  it("derives turn_end after turn closes (label from turn text)", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "text_delta", delta: "Result is 42" });
    updateFromEvent(r, { type: "turn_end" });
    const log = getEventLog(r);
    const turnEntry = log.find((e) => e.type === "turn_end");
    expect(turnEntry?.label).toBe("Result is 42");
  });

  it("turn_end label defaults to 'turn' when turn has no text", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "turn_end" });
    const log = getEventLog(r);
    const turnEntry = log.find((e) => e.type === "turn_end");
    expect(turnEntry?.label).toBe("turn");
  });

  it("truncates long turn text to TURN_SUMMARY_MAX in turn_end label", () => {
    const r = makeRecord();
    const longText = "s".repeat(TURN_SUMMARY_MAX + 20);
    updateFromEvent(r, { type: "text_delta", delta: longText });
    updateFromEvent(r, { type: "turn_end" });
    const log = getEventLog(r);
    const turnEntry = log.find((e) => e.type === "turn_end");
    expect(turnEntry?.label.length).toBe(TURN_SUMMARY_MAX);
  });

  it("appends error entry when record.lastError is set", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "error", message: "crashed" });
    const log = getEventLog(r);
    expect(log[log.length - 1]).toMatchObject({ type: "error", label: "crashed" });
  });

  it("multi-turn: events ordered across turns", () => {
    const r = makeRecord();
    // turn 1: tool A + text
    updateFromEvent(r, { type: "tool_start", toolName: "read", args: { path: "/a.ts" } });
    updateFromEvent(r, { type: "tool_end", toolName: "read", args: { path: "/a.ts" } });
    updateFromEvent(r, { type: "text_delta", delta: "done turn 1" });
    updateFromEvent(r, { type: "turn_end" });
    // turn 2: tool B
    updateFromEvent(r, { type: "tool_start", toolName: "edit", args: { path: "/b.ts" } });
    updateFromEvent(r, { type: "turn_end" });
    const types = getEventLog(r).map((e) => e.type);
    expect(types).toEqual([
      "tool_start", "tool_end", "turn_end",  // turn 1
      "tool_start", "turn_end",               // turn 2 (tool_start only, no tool_end)
    ]);
  });

  it("uses real wall-clock ts (tool: startedTs, turn_end: closedTs)", () => {
    // ts 不再是合成 +1，而是真实 Date.now()——消费方可按时序/时长分析。
    const before = Date.now();
    const r = makeRecord({ startedAt: before });
    updateFromEvent(r, { type: "tool_start", toolName: "read", args: { path: "/a.ts" } });
    const afterToolStart = Date.now();
    updateFromEvent(r, { type: "tool_end", toolName: "read", args: { path: "/a.ts" } });
    updateFromEvent(r, { type: "turn_end" });
    const afterTurnEnd = Date.now();
    const log = getEventLog(r);
    const toolStartTs = log[0]?.ts;
    const turnEndTs = log[2]?.ts;
    expect(toolStartTs).toBeGreaterThanOrEqual(before);
    expect(toolStartTs).toBeLessThanOrEqual(afterToolStart);
    expect(turnEndTs).toBeGreaterThanOrEqual(afterToolStart);
    expect(turnEndTs).toBeLessThanOrEqual(afterTurnEnd);
  });
});

// ============================================================
// getCurrentActivity — 派生活动行
// ============================================================
describe("getCurrentActivity", () => {
  it("returns undefined when status is not running", () => {
    const r = makeRecord({ status: "done" });
    expect(getCurrentActivity(r)).toBeUndefined();
  });

  it("returns undefined when turn is closed", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "turn_end" });
    expect(getCurrentActivity(r)).toBeUndefined();
  });

  it("prefers running tool over thinking/text", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "tool_start", toolName: "edit", args: { path: "/a.ts" } });
    r.turns[0]!.thinking = "thinking...";
    r.turns[0]!.text = "text...";
    expect(getCurrentActivity(r)).toEqual({ type: "tool", label: "edit a.ts" });
  });

  it("falls back to thinking when no running tool", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "tool_start", toolName: "read", args: { path: "/a.ts" } });
    updateFromEvent(r, { type: "tool_end", toolName: "read", args: { path: "/a.ts" } });
    r.turns[0]!.thinking = "pondering";
    expect(getCurrentActivity(r)).toEqual({ type: "thinking", label: "pondering" });
  });

  it("falls back to text when no tool/thinking", () => {
    const r = makeRecord();
    r.turns[0]!.text = "writing output";
    expect(getCurrentActivity(r)).toEqual({ type: "text", label: "writing output" });
  });

  it("text label takes START not tail fragment (regression: text: } bug)", () => {
    // 原始 bug：compact view 显示流式文本的末尾碎片（如 "text: }"）而非开头。
    // getCurrentActivity 必须取 turn.text 开头——本测试在 bug 回归时会失败。
    const r = makeRecord();
    updateFromEvent(r, { type: "text_delta", delta: "Hello world this is the response start" });
    updateFromEvent(r, { type: "text_delta", delta: " ... more content ... }" });
    const activity = getCurrentActivity(r);
    expect(activity?.type).toBe("text");
    // label 以开头而非尾巴开始
    expect(activity?.label.startsWith("Hello world")).toBe(true);
    // 绝不以尾巴碎片开头
    expect(activity?.label.startsWith("}")).toBe(false);
    expect(activity?.label.startsWith(" ... more")).toBe(false);
  });

  it("truncates text label to ACTIVITY_LABEL_MAX (60)", () => {
    const r = makeRecord();
    const longText = "y".repeat(120);
    r.turns[0]!.text = longText;
    const activity = getCurrentActivity(r);
    expect(activity?.label.length).toBe(60);
    expect(activity?.label).toBe(longText.slice(0, 60));
  });

  it("returns undefined when idle (empty turn)", () => {
    const r = makeRecord();
    expect(getCurrentActivity(r)).toBeUndefined();
  });
});

// ============================================================
// getFullText — 聚合文本
// ============================================================
describe("getFullText", () => {
  it("returns empty string for fresh record", () => {
    const r = makeRecord();
    expect(getFullText(r)).toBe("");
  });

  it("returns single turn text", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "text_delta", delta: "Hello world" });
    expect(getFullText(r)).toBe("Hello world");
  });

  it("joins multiple turns with double newline", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "text_delta", delta: "Turn 1" });
    updateFromEvent(r, { type: "turn_end" });
    updateFromEvent(r, { type: "text_delta", delta: "Turn 2" });
    expect(getFullText(r)).toBe("Turn 1\n\nTurn 2");
  });

  it("skips empty turns", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "text_delta", delta: "Turn 1" });
    updateFromEvent(r, { type: "turn_end" });
    updateFromEvent(r, { type: "turn_end" }); // 空 turn 2
    updateFromEvent(r, { type: "text_delta", delta: "Turn 3" });
    expect(getFullText(r)).toBe("Turn 1\n\nTurn 3");
  });

  it("aggregates multiple text_deltas within a single turn", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "text_delta", delta: "Hello " });
    updateFromEvent(r, { type: "text_delta", delta: "world" });
    updateFromEvent(r, { type: "text_delta", delta: "!" });
    expect(getFullText(r)).toBe("Hello world!");
  });
});

// ============================================================
// getAllToolCalls / getTotalUsage — 聚合派生
// ============================================================
describe("getAllToolCalls", () => {
  it("flattens toolCalls across turns", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "tool_start", toolName: "read", args: { path: "/a.ts" } });
    updateFromEvent(r, { type: "tool_end", toolName: "read", args: { path: "/a.ts" } });
    updateFromEvent(r, { type: "turn_end" });
    updateFromEvent(r, { type: "tool_start", toolName: "edit", args: { path: "/b.ts" } });
    const calls = getAllToolCalls(r);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.toolName)).toEqual(["read", "edit"]);
  });

  it("strips internal _status / startedTs (exported shape is clean ToolCall)", () => {
    // 导出的 ToolCall 不应泄漏内部状态机字段（_status / startedTs）——
    // 这些是 execution-record 内部实现细节。
    const r = makeRecord();
    updateFromEvent(r, { type: "tool_start", toolName: "read", args: { path: "/a.ts" } });
    const calls = getAllToolCalls(r);
    const tc = calls[0];
    expect(tc).toBeDefined();
    // 导出形状只有 4 个语义字段
    expect(Object.keys(tc!).sort()).toEqual(["args", "isError", "result", "toolName"]);
    // 内部字段不存在
    expect((tc as Record<string, unknown>)._status).toBeUndefined();
    expect((tc as Record<string, unknown>).startedTs).toBeUndefined();
  });
});

describe("getTotalUsage", () => {
  it("returns undefined when no usage", () => {
    const r = makeRecord();
    expect(getTotalUsage(r)).toBeUndefined();
  });

  it("aggregates usageDelta across turns", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "message_end", usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 3 } });
    updateFromEvent(r, { type: "turn_end" });
    updateFromEvent(r, { type: "message_end", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
    const usage = getTotalUsage(r);
    expect(usage).toEqual({ input: 11, output: 22, cacheRead: 5, cacheWrite: 3, total: 41, cost: 0 });
  });

  it("accumulates cost from message_end usage.cost", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "message_end", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.5 } });
    updateFromEvent(r, { type: "message_end", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.25 } });
    const usage = getTotalUsage(r);
    expect(usage?.cost).toBe(0.75);
  });

  it("accumulates multiple message_end within same turn (no usage loss)", () => {
    // 同 turn 内多次 message_end——usageDelta 按 field 累加（非覆盖），不丢 usage。
    const r = makeRecord();
    updateFromEvent(r, { type: "message_end", usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 3 } });
    updateFromEvent(r, { type: "message_end", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
    const usage = getTotalUsage(r);
    expect(usage).toEqual({ input: 11, output: 22, cacheRead: 5, cacheWrite: 3, total: 41, cost: 0 });
  });
});

// ============================================================
// tryTransition — CAS lock
// ============================================================
describe("tryTransition", () => {
  it("returns true and sets status when transitioning from running", () => {
    const r = makeRecord({ status: "running" });
    expect(tryTransition(r, "done")).toBe(true);
    expect(r.status).toBe("done");
  });

  it("returns false when already terminal (done)", () => {
    const r = makeRecord({ status: "done" });
    expect(tryTransition(r, "failed")).toBe(false);
    expect(r.status).toBe("done");
  });

  it("returns false when already terminal (cancelled)", () => {
    const r = makeRecord({ status: "cancelled" });
    expect(tryTransition(r, "done")).toBe(false);
  });

  it("returns false when already terminal (failed)", () => {
    const r = makeRecord({ status: "failed" });
    expect(tryTransition(r, "done")).toBe(false);
  });

  it("first transition wins in concurrent race (running → done beats running → cancelled)", () => {
    const r = makeRecord({ status: "running" });
    expect(tryTransition(r, "done")).toBe(true);
    expect(tryTransition(r, "cancelled")).toBe(false);
    expect(r.status).toBe("done");
  });

  it("returns false when trying to transition from crashed to done", () => {
    const r = makeRecord({ status: "crashed" });
    expect(tryTransition(r, "done")).toBe(false);
    expect(r.status).toBe("crashed");
  });
});

describe("markReconstructedStatus", () => {
  it("directly sets status without CAS check", () => {
    const r = makeRecord({ status: "running" });
    markReconstructedStatus(r, "crashed");
    expect(r.status).toBe("crashed");
  });

  it("can overwrite terminal status (bypass CAS)", () => {
    // 重建场景：旧 record 可能已有终态，重建时需要直接覆盖
    const r = makeRecord({ status: "done" });
    markReconstructedStatus(r, "crashed");
    expect(r.status).toBe("crashed");
  });

  it("can overwrite running status", () => {
    const r = makeRecord({ status: "running" });
    markReconstructedStatus(r, "failed");
    expect(r.status).toBe("failed");
  });

  it("can set crashed on running record", () => {
    const r = makeRecord({ status: "running" });
    markReconstructedStatus(r, "crashed");
    expect(r.status).toBe("crashed");
  });

  it("can set crashed on done record (reconstruction override)", () => {
    const r = makeRecord({ status: "done" });
    markReconstructedStatus(r, "crashed");
    expect(r.status).toBe("crashed");
  });
});

// ============================================================
// completeRecord
// ============================================================
describe("completeRecord", () => {
  it("writes outcome fields without resetting turnCount/totalTokens", () => {
    const r = makeRecord({ turnCount: 5, totalTokens: 42 });
    r.status = "done";
    completeRecord(r, SAMPLE_RESULT, "done");
    expect(r.status).toBe("done");
    expect(r.endedAt).toBeTypeOf("number");
    expect(r.agentResult).toBe(SAMPLE_RESULT);
    expect(r.result).toBe("done");
    expect(r.error).toBeUndefined();
    expect(r.turnCount).toBe(5);
    expect(r.totalTokens).toBe(42);
  });

  it("stores error from result", () => {
    const r = makeRecord();
    r.status = "failed";
    const failedResult: AgentResult = { ...SAMPLE_RESULT, success: false, error: "oops" };
    completeRecord(r, failedResult, "failed");
    expect(r.error).toBe("oops");
  });
});

// ============================================================
// project / snapshot — projections
// ============================================================
describe("projections", () => {
  describe("project", () => {
    it("returns SubagentToolDetails with all fields", () => {
      const r = makeRecord({ turnCount: 3, totalTokens: 100 });
      updateFromEvent(r, { type: "tool_start", toolName: "read", args: { path: "/x.ts" } });
      const d = project(r);
      expect(d.status).toBe("running");
      expect(d.agent).toBe("worker");
      expect(d.model).toBe("test-model");
      expect(d.turns).toBe(3);
      expect(d.totalTokens).toBe(100);
      expect(d.eventLog).toHaveLength(1); // tool_start derived
      expect(d.currentActivity).toEqual({ type: "tool", label: "read x.ts" });
    });

    it("eventLog is a fresh array each call (派生，非存储引用)", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolName: "read" });
      const d1 = project(r);
      const d2 = project(r);
      expect(d1.eventLog).not.toBe(d2.eventLog); // 不同数组实例
      expect(d1.eventLog).toEqual(d2.eventLog);   // 内容相同
    });

    it("currentActivity is undefined when status is not running", () => {
      const r = makeRecord({ status: "done" });
      expect(project(r).currentActivity).toBeUndefined();
    });

    it("outputs mode + sessionFile", () => {
      const r = makeRecord({ mode: "background", turnCount: 2 });
      r.sessionFile = "bg-1-abc.jsonl";
      const d = project(r);
      expect(d.mode).toBe("background");
      expect(d.sessionFile).toBe("bg-1-abc.jsonl");
    });

    it("sessionFile is undefined when record.sessionFile unset", () => {
      const r = makeRecord();
      expect(project(r).sessionFile).toBeUndefined();
    });

    it("currentActivity prefers tool over thinking over text", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolName: "edit", args: { path: "/a.ts" } });
      r.turns[0]!.thinking = "thinking...";
      r.turns[0]!.text = "text...";
      expect(project(r).currentActivity).toEqual({ type: "tool", label: "edit a.ts" });
    });

    it("currentActivity falls back to thinking when no running tool", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolName: "read", args: { path: "/a.ts" } });
      updateFromEvent(r, { type: "tool_end", toolName: "read", args: { path: "/a.ts" } });
      r.turns[0]!.thinking = "pondering";
      expect(project(r).currentActivity).toEqual({ type: "thinking", label: "pondering" });
    });

    it("currentActivity falls back to text when no tool/thinking", () => {
      const r = makeRecord();
      r.turns[0]!.text = "writing output";
      expect(project(r).currentActivity).toEqual({ type: "text", label: "writing output" });
    });

    it("currentActivity is undefined when idle", () => {
      const r = makeRecord();
      expect(project(r).currentActivity).toBeUndefined();
    });
  });

  describe("snapshot", () => {
    it("returns a readonly snapshot with identity + status fields", () => {
      const r = makeRecord({ turnCount: 2, status: "done", endedAt: 5000, result: "ok" });
      const s = snapshot(r);
      expect(s.id).toBe("test-1");
      expect(s.agent).toBe("worker");
      expect(s.mode).toBe("sync");
      expect(s.task).toBe("test task");
      expect(s.status).toBe("done");
      expect(s.turns).toBe(2);
      expect(s.endedAt).toBe(5000);
      expect(s.result).toBe("ok");
    });

    it("outputs sessionFile", () => {
      const r = makeRecord();
      r.sessionFile = "s.jsonl";
      expect(snapshot(r).sessionFile).toBe("s.jsonl");
    });

    it("sessionFile is undefined when unset", () => {
      const r = makeRecord();
      expect(snapshot(r).sessionFile).toBeUndefined();
    });
  });
});

// ============================================================
// extractLabelFromArgs
// ============================================================
describe("extractLabelFromArgs", () => {
  it("returns bare toolName for non-object args", () => {
    expect(extractLabelFromArgs("read", undefined)).toBe("read");
    expect(extractLabelFromArgs("read", null)).toBe("read");
    expect(extractLabelFromArgs("read", "string")).toBe("read");
  });

  it("returns bare toolName when no recognized field", () => {
    expect(extractLabelFromArgs("custom", { foo: "bar" })).toBe("custom");
  });

  it("extracts basename from path", () => {
    expect(extractLabelFromArgs("read", { path: "/home/user/foo.ts" })).toBe("read foo.ts");
    expect(extractLabelFromArgs("edit", { file_path: "C:\\proj\\bar.js" })).toBe("edit bar.js");
    expect(extractLabelFromArgs("write", { filePath: "baz.py" })).toBe("write baz.py");
  });

  it("extracts first line of command for bash", () => {
    expect(extractLabelFromArgs("bash", { command: "ls -la\necho done" })).toBe("bash ls -la");
  });

  it("extracts query for web_search", () => {
    expect(extractLabelFromArgs("web_search", { query: "hello world" })).toBe("web_search hello world");
  });

  it("extracts url for web_fetch", () => {
    expect(extractLabelFromArgs("web_fetch", { url: "https://example.com" })).toBe("web_fetch https://example.com");
  });

  it("truncates long labels to TOOL_LABEL_MAX (TUI column-width stability)", () => {
    // 设计意图：保持 TUI 列宽稳定，避免 10KB bash 命令撑爆 compact view。
    const longCmd = "x".repeat(200);
    const label = extractLabelFromArgs("bash", { command: longCmd });
    // label = "bash " + 截断到 100 的 command
    const expectedCmd = "x".repeat(100);
    expect(label).toBe(`bash ${expectedCmd}`);
    expect(label.length).toBe("bash ".length + 100);
  });

  it("truncates long path basename", () => {
    const longName = "f".repeat(150) + ".ts";
    const label = extractLabelFromArgs("read", { path: `/dir/${longName}` });
    // basename 截断到 100
    expect(label.length).toBe("read ".length + 100);
  });

  it("truncates long query and url", () => {
    const longQuery = "q".repeat(150);
    expect(extractLabelFromArgs("web_search", { query: longQuery }).length).toBe("web_search ".length + 100);
    const longUrl = "u".repeat(150);
    expect(extractLabelFromArgs("web_fetch", { url: longUrl }).length).toBe("web_fetch ".length + 100);
  });
});

// ============================================================
// computeElapsedSeconds — 共享 helper
// ============================================================
describe("computeElapsedSeconds", () => {
  it("computes floor((endedAt - startedAt) / 1000)", () => {
    expect(computeElapsedSeconds({ startedAt: 0, endedAt: 1500 })).toBe(1);
    expect(computeElapsedSeconds({ startedAt: 1000, endedAt: 1599 })).toBe(0);
    expect(computeElapsedSeconds({ startedAt: 1000, endedAt: 2600 })).toBe(1);
  });

  it("uses Date.now() when endedAt is undefined (running state)", () => {
    const startedAt = Date.now() - 3000;
    const secs = computeElapsedSeconds({ startedAt });
    // 至少 2 秒（允许调度延迟），不超过 10 秒（防止假死）
    expect(secs).toBeGreaterThanOrEqual(2);
    expect(secs).toBeLessThan(10);
  });

  it("handles identical startedAt/endedAt (0 seconds)", () => {
    expect(computeElapsedSeconds({ startedAt: 5000, endedAt: 5000 })).toBe(0);
  });
});
