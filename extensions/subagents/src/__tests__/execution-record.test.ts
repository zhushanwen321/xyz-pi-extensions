// src/__tests__/execution-record.test.ts
import { describe, expect, it } from "vitest";

import {
  completeRecord,
  computeElapsedSeconds,
  createRecord,
  extractLabelFromArgs,
  getAllToolCalls,
  getEventLog,
  getFullText,
  getTotalUsage,
  project,
  snapshot,
  tryTransition,
  updateFromEvent,
} from "../core/execution-record.ts";
import type { AgentResult, ExecutionRecord, Turn, TurnContentBlock } from "../types.ts";

// ── 常量（与源码 module-private 值对齐，测试用字面量）──
const TURN_SUMMARY_MAX = 80;

// ── 工厂 ──
function emptyTurn(): Turn {
  return { content: [], usageDelta: undefined, closed: false, closedTs: undefined };
}

/** 构造 text block helper（测试用）。 */
function textBlock(text: string): TurnContentBlock {
  return { type: "text", text };
}

/** 构造 thinking block helper（测试用）。 */
function thinkingBlock(thinking: string): TurnContentBlock {
  return { type: "thinking", thinking };
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
    expect(r.turns[0]).toMatchObject({ content: [], closed: false });
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
  // message_update → turn.content（单源：SDK message.content 快照整体覆盖）
  // ============================================================
  describe("message_update (content snapshot)", () => {
    it("message_update 整体覆盖 currentTurn.content（text/thinking 直接来自快照）", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "message_update", content: [textBlock("Hello world")] });
      expect(r.turns[0]?.content).toEqual([textBlock("Hello world")]);
    });

    it("message_update 后续覆盖前一次（流式进度，整体替换非累积）", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "message_update", content: [textBlock("Hello ")] });
      updateFromEvent(r, { type: "message_update", content: [textBlock("Hello world")] });
      // 整体覆盖：最终是最后一次快照的完整 text
      expect(r.turns[0]?.content).toEqual([textBlock("Hello world")]);
    });

    it("text 长内容不切片（完整存储）", () => {
      const r = makeRecord();
      const longText = "y".repeat(350);
      updateFromEvent(r, { type: "message_update", content: [textBlock(longText)] });
      expect(r.turns[0]?.content).toEqual([textBlock(longText)]);
      expect(r.turns).toHaveLength(1);
    });

    it("thinking block 进 content", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "message_update", content: [thinkingBlock("Analyzing the problem")] });
      expect(r.turns[0]?.content).toEqual([thinkingBlock("Analyzing the problem")]);
    });

    it("message_update 保留已有 toolCall block 的 _status/result（按 id 合并）", () => {
      // tool_start 先创建 running toolCall block，之后 message_update 快照含同 id toolCall 骨架
      // → 应保留 running _status，不被快照覆盖回默认。
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolCallId: "tc-1", toolName: "read", args: { path: "/a.ts" } });
      updateFromEvent(r, {
        type: "message_update",
        content: [{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "/a.ts" } }],
      });
      const block = r.turns[0]?.content[0];
      expect(block?.type).toBe("toolCall");
      if (block?.type === "toolCall") {
        expect(block._status).toBe("running"); // 保留 running，未丢失
        expect(block.startedTs).toBeGreaterThan(0);
      }
    });
  });

  describe("turn boundary", () => {
    it("turn_end closes current turn; next message_update opens new turn", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "message_update", content: [textBlock("turn 1 text")] });
      updateFromEvent(r, { type: "turn_end" });
      expect(r.turns[0]?.closed).toBe(true);
      expect(r.turnCount).toBe(1);

      // 新 message_update 开新 turn
      updateFromEvent(r, { type: "message_update", content: [textBlock("turn 2 text")] });
      expect(r.turns).toHaveLength(2);
      expect(r.turns[1]?.closed).toBe(false);
      expect(r.turns[1]?.content).toEqual([textBlock("turn 2 text")]);
      // turn 1 不受影响
      expect(r.turns[0]?.content).toEqual([textBlock("turn 1 text")]);
    });

    it("turn_end closes turn and records closedTs (real wall-clock)", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "message_update", content: [textBlock("partial")] });
      const before = Date.now();
      updateFromEvent(r, { type: "turn_end" });
      const after = Date.now();
      expect(r.turns[0]?.closed).toBe(true);
      expect(r.turns[0]?.closedTs).toBeGreaterThanOrEqual(before);
      expect(r.turns[0]?.closedTs).toBeLessThanOrEqual(after);
      expect(r.turns[0]?.content).toEqual([textBlock("partial")]);
      expect(r.turnCount).toBe(1);
    });

    it("turn_end clears lastError (transient error recovery → success)", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "error", message: "transient" });
      expect(r.lastError).toBe("transient");
      updateFromEvent(r, { type: "turn_end" });
      expect(r.lastError).toBeUndefined();
    });

    it("turn_end after turn_end: next message_update opens 3rd turn (not mutate 2nd)", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "message_update", content: [textBlock("t1")] });
      updateFromEvent(r, { type: "turn_end" });
      updateFromEvent(r, { type: "turn_end" }); // 第 2 个空 turn 立即 closed
      updateFromEvent(r, { type: "message_update", content: [textBlock("t3")] });
      expect(r.turns).toHaveLength(3);
      expect(r.turns[0]?.content).toEqual([textBlock("t1")]);
      expect(r.turns[1]?.content).toEqual([]); // 第 2 个空 turn 未被回填
      expect(r.turns[2]?.content).toEqual([textBlock("t3")]);
    });
  });

  // ============================================================
  // tool events → turn.content 的 toolCall block
  // ============================================================
  describe("tool events", () => {
    it("tool_start pushes a running toolCall block into current turn content", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolCallId: "tc-1", toolName: "read", args: { path: "/a/b/foo.ts" } });
      const block = r.turns[0]?.content[0];
      expect(block).toMatchObject({ type: "toolCall", name: "read", _status: "running" });
    });

    it("tool_end matches running toolCall block by id and sets result/status", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolCallId: "tc-1", toolName: "bash", args: { command: "ls" } });
      const result = { content: [{ type: "text", text: "file.ts" }] };
      updateFromEvent(r, { type: "tool_end", toolCallId: "tc-1", toolName: "bash", args: { command: "ls" }, result });
      const block = r.turns[0]?.content[0];
      expect(block).toMatchObject({ type: "toolCall", name: "bash", _status: "done", isError: false });
      if (block?.type === "toolCall") expect(block.result).toBe(result);
    });

    it("tool_end sets failed status when isError", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolCallId: "tc-1", toolName: "bash", args: { command: "rm" } });
      updateFromEvent(r, { type: "tool_end", toolCallId: "tc-1", toolName: "bash", args: { command: "rm" }, isError: true });
      const block = r.turns[0]?.content[0];
      expect(block).toMatchObject({ _status: "failed", isError: true });
    });

    it("tool_end without matching tool_start pushes a completed toolCall block", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_end", toolCallId: "ext-1", toolName: "external", args: {} });
      const block = r.turns[0]?.content[0];
      expect(block).toMatchObject({ type: "toolCall", name: "external", _status: "done" });
    });

    it("LIFO matching: same-name tool twice, tool_end matches by id (not name)", () => {
      // 单源后按 id 精确匹配——同名无歧义。两个 bash 用不同 id，tool_end 按 id 命中。
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolCallId: "tc-a", toolName: "bash", args: { command: "cmd-a" } });
      updateFromEvent(r, { type: "tool_start", toolCallId: "tc-b", toolName: "bash", args: { command: "cmd-b" } });
      const resultB = { content: [{ type: "text", text: "B" }] };
      updateFromEvent(r, { type: "tool_end", toolCallId: "tc-b", toolName: "bash", args: { command: "cmd-b" }, result: resultB });
      const calls = r.turns[0]?.content.filter((b): b is Extract<TurnContentBlock, { type: "toolCall" }> => b.type === "toolCall") ?? [];
      expect(calls).toHaveLength(2);
      // tc-b 命中（按 id），done + result=B
      expect(calls[1]?._status).toBe("done");
      expect(calls[1]?.result).toBe(resultB);
      // tc-a 仍 running
      expect(calls[0]?._status).toBe("running");
      expect(calls[0]?.result).toBeUndefined();
    });

    it("tool_end without result leaves result undefined (SDK may omit result)", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolCallId: "tc-1", toolName: "read", args: { path: "/a.ts" } });
      updateFromEvent(r, { type: "tool_end", toolCallId: "tc-1", toolName: "read", args: { path: "/a.ts" } });
      const block = r.turns[0]?.content[0];
      if (block?.type === "toolCall") {
        expect(block.result).toBeUndefined();
        expect(block._status).toBe("done");
      }
      const log = getEventLog(r);
      expect(log.map((e) => e.type)).toEqual(["tool_start", "tool_end"].slice(0, 2));
    });

    it("tool_end matches running toolCall across turns (lagged SDK event, by id)", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolCallId: "tc-1", toolName: "read", args: { path: "/a.ts" } });
      updateFromEvent(r, { type: "turn_end" }); // turn[0] closed，read 仍 running
      updateFromEvent(r, { type: "tool_end", toolCallId: "tc-1", toolName: "read", args: { path: "/a.ts" } });
      expect(r.turns).toHaveLength(1);
      const block = r.turns[0]?.content[0];
      expect(block).toMatchObject({ _status: "done" });
      expect(r.turns[0]?.content).toHaveLength(1);
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

  it("derives tool_start/tool_end pairs from content toolCall blocks", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "tool_start", toolCallId: "tc-1", toolName: "read", args: { path: "/x.ts" } });
    updateFromEvent(r, { type: "tool_end", toolCallId: "tc-1", toolName: "read", args: { path: "/x.ts" } });
    const log = getEventLog(r);
    expect(log.map((e) => e.type)).toEqual(["tool_start", "tool_end"]);
    expect(log[0]).toMatchObject({ type: "tool_start", label: "read x.ts", status: "running" });
    expect(log[1]).toMatchObject({ type: "tool_end", label: "read x.ts", status: "done" });
  });

  it("running toolCall (no tool_end yet) derives only tool_start", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "tool_start", toolCallId: "tc-1", toolName: "read", args: { path: "/x.ts" } });
    const log = getEventLog(r);
    expect(log.map((e) => e.type)).toEqual(["tool_start"]);
  });

  it("derives thinking/text entry for running turn (单源：实时进度进 eventLog)", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "message_update", content: [thinkingBlock("pondering")] });
    const log = getEventLog(r);
    // running turn 末尾 thinking block → thinking 条目（问题 3 核心：text/thinking 可见）
    expect(log.some((e) => e.type === "thinking" && e.label === "pondering")).toBe(true);
  });

  it("derives text entry for running turn when thinking empty", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "message_update", content: [textBlock("writing output")] });
    const log = getEventLog(r);
    expect(log.some((e) => e.type === "text" && e.label === "writing output")).toBe(true);
  });

  it("closed turn: no thinking/text entry (历史不重复展示)", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "message_update", content: [textBlock("done")] });
    updateFromEvent(r, { type: "turn_end" });
    const log = getEventLog(r);
    // 闭合 turn 不派生 text 条目（只有 turn_end summary）
    expect(log.some((e) => e.type === "text")).toBe(false);
    expect(log.some((e) => e.type === "turn_end")).toBe(true);
  });

  it("derives turn_end after turn closes (label from turn text)", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "message_update", content: [textBlock("Result is 42")] });
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
    updateFromEvent(r, { type: "message_update", content: [textBlock(longText)] });
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
    // turn 1: tool A（真实 SDK 流程：tool_start → tool_end，message_update 的 content
    // 快照会含已完成 toolCall block——此处用 tool 事件 + turn_end 验 ordering，不掺 text 覆盖）
    updateFromEvent(r, { type: "tool_start", toolCallId: "tc-1", toolName: "read", args: { path: "/a.ts" } });
    updateFromEvent(r, { type: "tool_end", toolCallId: "tc-1", toolName: "read", args: { path: "/a.ts" } });
    updateFromEvent(r, { type: "turn_end" });
    // turn 2: tool B
    updateFromEvent(r, { type: "tool_start", toolCallId: "tc-2", toolName: "edit", args: { path: "/b.ts" } });
    updateFromEvent(r, { type: "turn_end" });
    const types = getEventLog(r).map((e) => e.type);
    expect(types).toEqual([
      "tool_start", "tool_end", "turn_end",  // turn 1
      "tool_start", "turn_end",               // turn 2 (tool_start only, no tool_end)
    ]);
  });

  it("uses real wall-clock ts (tool: startedTs, turn_end: closedTs)", () => {
    const before = Date.now();
    const r = makeRecord({ startedAt: before });
    updateFromEvent(r, { type: "tool_start", toolCallId: "tc-1", toolName: "read", args: { path: "/a.ts" } });
    const afterToolStart = Date.now();
    updateFromEvent(r, { type: "tool_end", toolCallId: "tc-1", toolName: "read", args: { path: "/a.ts" } });
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
// getFullText — 聚合文本（从 content text block 派生）
// ============================================================
describe("getFullText", () => {
  it("returns empty string for fresh record", () => {
    const r = makeRecord();
    expect(getFullText(r)).toBe("");
  });

  it("returns single turn text", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "message_update", content: [textBlock("Hello world")] });
    expect(getFullText(r)).toBe("Hello world");
  });

  it("joins multiple turns with double newline", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "message_update", content: [textBlock("Turn 1")] });
    updateFromEvent(r, { type: "turn_end" });
    updateFromEvent(r, { type: "message_update", content: [textBlock("Turn 2")] });
    expect(getFullText(r)).toBe("Turn 1\n\nTurn 2");
  });

  it("skips empty turns", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "message_update", content: [textBlock("Turn 1")] });
    updateFromEvent(r, { type: "turn_end" });
    updateFromEvent(r, { type: "turn_end" }); // 空 turn 2
    updateFromEvent(r, { type: "message_update", content: [textBlock("Turn 3")] });
    expect(getFullText(r)).toBe("Turn 1\n\nTurn 3");
  });

  it("aggregates multiple text blocks within a single turn", () => {
    // SDK message 可能含多个 text block（罕见），getFullText 拼接同 turn 内所有 text
    const r = makeRecord();
    updateFromEvent(r, { type: "message_update", content: [textBlock("Hello "), textBlock("world!")] });
    expect(getFullText(r)).toBe("Hello world!");
  });
});

// ============================================================
// getAllToolCalls / getTotalUsage — 聚合派生
// ============================================================
describe("getAllToolCalls", () => {
  it("flattens toolCall blocks across turns", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "tool_start", toolCallId: "tc-1", toolName: "read", args: { path: "/a.ts" } });
    updateFromEvent(r, { type: "tool_end", toolCallId: "tc-1", toolName: "read", args: { path: "/a.ts" } });
    updateFromEvent(r, { type: "turn_end" });
    updateFromEvent(r, { type: "tool_start", toolCallId: "tc-2", toolName: "edit", args: { path: "/b.ts" } });
    const calls = getAllToolCalls(r);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.toolName)).toEqual(["read", "edit"]);
  });

  it("strips internal _status / startedTs (exported shape is clean ToolCall)", () => {
    const r = makeRecord();
    updateFromEvent(r, { type: "tool_start", toolCallId: "tc-1", toolName: "read", args: { path: "/a.ts" } });
    const calls = getAllToolCalls(r);
    const tc = calls[0];
    expect(tc).toBeDefined();
    expect(Object.keys(tc!).sort()).toEqual(["args", "isError", "result", "toolName"]);
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
      updateFromEvent(r, { type: "tool_start", toolCallId: "tc-1", toolName: "read", args: { path: "/x.ts" } });
      const d = project(r);
      expect(d.status).toBe("running");
      expect(d.agent).toBe("worker");
      expect(d.model).toBe("test-model");
      expect(d.turns).toBe(3);
      expect(d.totalTokens).toBe(100);
      expect(d.eventLog).toHaveLength(1); // tool_start derived
    });

    it("eventLog is a fresh array each call (派生，非存储引用)", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolCallId: "tc-1", toolName: "read" });
      const d1 = project(r);
      const d2 = project(r);
      expect(d1.eventLog).not.toBe(d2.eventLog); // 不同数组实例
      expect(d1.eventLog).toEqual(d2.eventLog);   // 内容相同
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

    it("running turn 的 thinking/text 进 eventLog（单源，无 currentActivity 字段）", () => {
      // getEventLog 取 running turn 末尾最新非 tool block 作为活动行。
      // 场景 A：turn 末尾是 thinking block → thinking 条目
      const rA = makeRecord();
      updateFromEvent(rA, { type: "message_update", content: [thinkingBlock("pondering")] });
      const dA = project(rA);
      expect("currentActivity" in dA).toBe(false);
      expect(dA.eventLog.some((e) => e.type === "thinking" && e.label === "pondering")).toBe(true);

      // 场景 B：turn 末尾是 text block → text 条目
      const rB = makeRecord();
      updateFromEvent(rB, { type: "message_update", content: [textBlock("writing output")] });
      const dB = project(rB);
      expect(dB.eventLog.some((e) => e.type === "text" && e.label === "writing output")).toBe(true);
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
