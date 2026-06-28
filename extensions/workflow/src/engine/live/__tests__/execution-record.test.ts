// execution-record 纯函数测试。
//
// 验证复制自 subagents 的核心逻辑在 workflow 上下文行为不变：
// createRecord → updateFromEvent 累积 → getEventLog/getCurrentActivity/project 派生。

import { describe, expect, it } from "vitest";
import {
  computeElapsedSeconds,
  createRecord,
  getAllToolCalls,
  getCurrentActivity,
  getEventLog,
  getFullText,
  getTotalUsage,
  projectLiveProgress,
  updateFromEvent,
} from "../execution-record.ts";
import type { AgentEvent, ExecutionRecord } from "../types.ts";

function newRecord(): ExecutionRecord {
  return createRecord("call-1", {
    agent: "reviewer",
    model: "glm-5.2",
    mode: "sync",
    task: "review diff",
    startedAt: 1000,
  });
}

describe("createRecord", () => {
  it("initializes with running status and one empty turn", () => {
    const r = newRecord();
    expect(r.status).toBe("running");
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.closed).toBe(false);
    expect(r.turnCount).toBe(0);
    expect(r.totalTokens).toBe(0);
    expect(r.lastError).toBeUndefined();
  });

  it("identity fields are immutable after creation", () => {
    const r = newRecord();
    expect(r.agent).toBe("reviewer");
    expect(r.model).toBe("glm-5.2");
    expect(r.task).toBe("review diff");
    expect(r.startedAt).toBe(1000);
  });
});

describe("updateFromEvent", () => {
  it("accumulates text_delta into current turn", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "text_delta", delta: "hello " });
    updateFromEvent(r, { type: "text_delta", delta: "world" });
    expect(r.turns[0]?.text).toBe("hello world");
  });

  it("accumulates thinking_delta into current turn", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "thinking_delta", delta: "let me think" });
    expect(r.turns[0]?.thinking).toBe("let me think");
  });

  it("pushes running toolCall on tool_start", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "tool_start", toolName: "bash", args: { command: "ls" } });
    expect(r.turns[0]?.toolCalls).toHaveLength(1);
    expect(r.turns[0]?.toolCalls[0]).toMatchObject({
      toolName: "bash",
      _status: "running",
    });
  });

  it("matches tool_end to running toolCall, fills result + status", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "tool_start", toolName: "bash", args: { command: "ls" } });
    updateFromEvent(r, {
      type: "tool_end",
      toolName: "bash",
      result: { content: [{ type: "text", text: "file.ts" }] },
      isError: false,
    });
    expect(r.turns[0]?.toolCalls[0]?._status).toBe("done");
    expect(r.turns[0]?.toolCalls[0]?.result).toEqual({ content: [{ type: "text", text: "file.ts" }] });
  });

  it("marks toolCall failed when tool_end isError=true", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "tool_start", toolName: "bash" });
    updateFromEvent(r, { type: "tool_end", toolName: "bash", isError: true });
    expect(r.turns[0]?.toolCalls[0]?._status).toBe("failed");
  });

  it("closes turn on turn_end and increments turnCount", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "text_delta", delta: "turn 1" });
    updateFromEvent(r, { type: "turn_end" });
    expect(r.turns[0]?.closed).toBe(true);
    expect(r.turnCount).toBe(1);
  });

  it("opens a new turn after turn_end", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "text_delta", delta: "turn 1" });
    updateFromEvent(r, { type: "turn_end" });
    updateFromEvent(r, { type: "text_delta", delta: "turn 2" });
    expect(r.turns).toHaveLength(2);
    expect(r.turns[0]?.text).toBe("turn 1");
    expect(r.turns[1]?.text).toBe("turn 2");
  });

  it("accumulates usage on message_end and sums totalTokens", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "message_end", usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0 } });
    updateFromEvent(r, { type: "message_end", usage: { input: 200, output: 30, cacheRead: 5, cacheWrite: 0 } });
    // totalTokens = (100+50+10+0) + (200+30+5+0) = 395
    expect(r.totalTokens).toBe(395);
    expect(getTotalUsage(r)?.input).toBe(300);
    expect(getTotalUsage(r)?.total).toBe(395);
  });

  it("clears lastError on turn_end (transient error recovery)", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "error", message: "transient" });
    expect(r.lastError).toBe("transient");
    updateFromEvent(r, { type: "turn_end" });
    expect(r.lastError).toBeUndefined();
  });

  it("records error from message_end stopReason", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "message_end", error: "rate limited" });
    expect(r.lastError).toBe("rate limited");
  });

  it("tool_end without matching tool_start pushes a completed toolCall (no data loss)", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "tool_end", toolName: "injected-tool", isError: false });
    expect(r.turns[0]?.toolCalls).toHaveLength(1);
    expect(r.turns[0]?.toolCalls[0]?._status).toBe("done");
  });

  it("compaction event is a no-op", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "compaction" });
    // No crash, state unchanged
    expect(r.turns).toHaveLength(1);
  });
});

describe("getEventLog", () => {
  it("derives tool_start/tool_end pairs + turn_end entries", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "tool_start", toolName: "bash", args: { command: "ls" } });
    updateFromEvent(r, { type: "tool_end", toolName: "bash" });
    updateFromEvent(r, { type: "text_delta", delta: "done" });
    updateFromEvent(r, { type: "turn_end" });

    const log = getEventLog(r);
    // tool_start, tool_end, turn_end
    expect(log).toHaveLength(3);
    expect(log[0]?.type).toBe("tool_start");
    expect(log[1]?.type).toBe("tool_end");
    expect(log[2]?.type).toBe("turn_end");
    expect(log[0]?.label).toContain("bash");
  });

  it("appends error entry when lastError set", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "error", message: "boom" });
    const log = getEventLog(r);
    const last = log[log.length - 1];
    expect(last?.type).toBe("error");
    expect(last?.label).toBe("boom");
  });
});

describe("getCurrentActivity", () => {
  it("returns running toolCall as current activity", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "tool_start", toolName: "bash", args: { command: "ls" } });
    const activity = getCurrentActivity(r);
    expect(activity?.type).toBe("tool");
    expect(activity?.label).toContain("bash");
  });

  it("returns thinking as activity when no running tool", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "thinking_delta", delta: "analyzing..." });
    expect(getCurrentActivity(r)?.type).toBe("thinking");
  });

  it("returns text as activity when no tool and no thinking", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "text_delta", delta: "output" });
    expect(getCurrentActivity(r)?.type).toBe("text");
  });

  it("returns undefined when nothing happening", () => {
    const r = newRecord();
    expect(getCurrentActivity(r)).toBeUndefined();
  });

  it("returns undefined for terminal status", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "tool_start", toolName: "bash" });
    r.status = "done";
    expect(getCurrentActivity(r)).toBeUndefined();
  });
});

describe("getFullText / getAllToolCalls", () => {
  it("joins all turns' text with blank line", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "text_delta", delta: "turn1" });
    updateFromEvent(r, { type: "turn_end" });
    updateFromEvent(r, { type: "text_delta", delta: "turn2" });
    expect(getFullText(r)).toBe("turn1\n\nturn2");
  });

  it("strips internal _status/startedTs from toolCalls on export", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "tool_start", toolName: "bash" });
    const calls = getAllToolCalls(r);
    expect(calls[0]).not.toHaveProperty("_status");
    expect(calls[0]).not.toHaveProperty("startedTs");
    expect(calls[0]?.toolName).toBe("bash");
  });
});

describe("computeElapsedSeconds", () => {
  it("computes from startedAt to endedAt", () => {
    expect(computeElapsedSeconds({ startedAt: 1000, endedAt: 61000 })).toBe(60);
  });

  it("uses Date.now() when endedAt missing (running)", () => {
    const r = { startedAt: Date.now() - 5000 };
    const secs = computeElapsedSeconds(r);
    expect(secs).toBeGreaterThanOrEqual(4);
    expect(secs).toBeLessThanOrEqual(6);
  });
});

describe("projectLiveProgress", () => {
  it("projects a running snapshot with derived fields", () => {
    const r = newRecord();
    updateFromEvent(r, { type: "tool_start", toolName: "bash", args: { command: "ls" } });
    updateFromEvent(r, { type: "message_end", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } });

    const snap = projectLiveProgress(r);
    expect(snap.status).toBe("running");
    expect(snap.totalTokens).toBe(150);
    expect(snap.eventLog.length).toBeGreaterThanOrEqual(1);
    expect(snap.currentActivity?.type).toBe("tool");
    expect(snap.elapsedSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe("full agent execution sequence (integration)", () => {
  it("simulates a multi-turn agent run with tools", () => {
    const r = newRecord();
    const events: AgentEvent[] = [
      { type: "thinking_delta", delta: "Let me review" },
      { type: "text_delta", delta: "Starting review" },
      { type: "tool_start", toolName: "bash", args: { command: "git diff" } },
      { type: "tool_end", toolName: "bash", result: { content: [{ type: "text", text: "diff" }] } },
      { type: "message_end", usage: { input: 500, output: 100, cacheRead: 200, cacheWrite: 0 } },
      { type: "turn_end" },
      { type: "tool_start", toolName: "write", args: { path: "/tmp/report.md" } },
      { type: "tool_end", toolName: "write", isError: false },
      { type: "message_end", usage: { input: 300, output: 50, cacheRead: 100, cacheWrite: 0 } },
      { type: "turn_end" },
    ];
    for (const e of events) updateFromEvent(r, e);

    expect(r.turnCount).toBe(2);
    expect(r.turns).toHaveLength(2);
    // getAllToolCalls flattens all turns: turn1=[bash], turn2=[write] → 2 total.
    expect(getAllToolCalls(r)).toHaveLength(2);
    expect(r.totalTokens).toBe(500 + 100 + 200 + 300 + 50 + 100); // 1250
    const log = getEventLog(r);
    // turn1: tool_start bash, tool_end bash, turn_end
    // turn2: tool_start write, tool_end write, turn_end
    expect(log.filter((e) => e.type === "tool_start")).toHaveLength(2);
    expect(log.filter((e) => e.type === "turn_end")).toHaveLength(2);
  });
});
