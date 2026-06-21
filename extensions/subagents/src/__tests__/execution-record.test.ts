// src/__tests__/execution-record.test.ts
import { describe, expect, it } from "vitest";

import {
  completeRecord,
  createRecord,
  extractLabelFromArgs,
  project,
  snapshot,
  toPersisted,
  tryTransition,
  updateFromEvent,
} from "../core/execution-record.ts";
import type { AgentResult, ExecutionRecord } from "../types.ts";

// ── 常量（与源码 module-private 值对齐，测试用字面量）──
const TEXT_OUTPUT_CHUNK = 100;
const THINKING_CHUNK = 100;
const MAX_EVENT_LOG_ENTRIES = 20;
const TURN_SUMMARY_MAX = 80;
const EVENT_LOG_LABEL_MAX = 100;

// ── 工厂 ──
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
    eventLog: [],
    turns: 0,
    totalTokens: 0,
    endedAt: undefined,
    result: undefined,
    error: undefined,
    agentResult: undefined,
    controller: undefined,
    _currentTurnText: "",
    _currentThinking: "",
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

    // defaults
    expect(r.status).toBe("running");
    expect(r.eventLog).toEqual([]);
    expect(r.turns).toBe(0);
    expect(r.totalTokens).toBe(0);
    expect(r.endedAt).toBeUndefined();
    expect(r.result).toBeUndefined();
    expect(r.error).toBeUndefined();
    expect(r.agentResult).toBeUndefined();
    expect(r._currentTurnText).toBe("");
    expect(r._currentThinking).toBe("");
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
// updateFromEvent — turns / totalTokens accumulation
// ============================================================
describe("updateFromEvent", () => {
  describe("turns accumulation", () => {
    it("increments turns on turn_end", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "turn_end", summary: "done" });
      expect(r.turns).toBe(1);
      updateFromEvent(r, { type: "turn_end" });
      expect(r.turns).toBe(2);
    });

    it("does not increment turns on other events", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "text_delta", delta: "hi" });
      updateFromEvent(r, { type: "tool_start", toolName: "read" });
      updateFromEvent(r, { type: "message_end" });
      expect(r.turns).toBe(0);
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
  });

  // ============================================================
  // eventLog — text_delta chunking
  // ============================================================
  describe("text_delta chunking", () => {
    it("accumulates text and flushes at TEXT_OUTPUT_CHUNK boundary", () => {
      const r = makeRecord();
      const chunk = "x".repeat(TEXT_OUTPUT_CHUNK);
      updateFromEvent(r, { type: "text_delta", delta: chunk });
      // exactly chunkSize → one text_output entry pushed, buffer cleared
      const textEntries = r.eventLog.filter((e) => e.type === "text_output");
      expect(textEntries).toHaveLength(1);
      expect(textEntries[0].label).toBe(chunk);
      expect(r._currentTurnText).toBe("");
    });

    it("leaves remainder in buffer below chunk size", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "text_delta", delta: "ab" });
      expect(r.eventLog.filter((e) => e.type === "text_output")).toHaveLength(0);
      expect(r._currentTurnText).toBe("ab");
    });

    it("handles super-long delta (multiple chunks via while loop)", () => {
      const r = makeRecord();
      const longDelta = "y".repeat(TEXT_OUTPUT_CHUNK * 3 + 10);
      updateFromEvent(r, { type: "text_delta", delta: longDelta });
      const textEntries = r.eventLog.filter((e) => e.type === "text_output");
      expect(textEntries).toHaveLength(3);
      expect(r._currentTurnText).toBe("y".repeat(10));
    });
  });

  // ============================================================
  // eventLog — thinking_delta chunking
  // ============================================================
  describe("thinking_delta chunking", () => {
    it("accumulates thinking and flushes at THINKING_CHUNK boundary", () => {
      const r = makeRecord();
      const chunk = "z".repeat(THINKING_CHUNK);
      updateFromEvent(r, { type: "thinking_delta", delta: chunk });
      const entries = r.eventLog.filter((e) => e.type === "thinking");
      expect(entries).toHaveLength(1);
      expect(r._currentThinking).toBe("");
    });
  });

  // ============================================================
  // eventLog — tool events
  // ============================================================
  describe("tool events", () => {
    it("tool_start pushes a running entry", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolName: "read", args: { path: "/a/b/foo.ts" } });
      expect(r.eventLog).toHaveLength(1);
      expect(r.eventLog[0]).toMatchObject({ type: "tool_start", label: "read foo.ts", status: "running" });
    });

    it("tool_end pushes a done entry when not error", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_end", toolName: "bash", args: { command: "ls" } });
      expect(r.eventLog[0]).toMatchObject({ type: "tool_end", label: "bash ls", status: "done" });
    });

    it("tool_end pushes a failed entry when isError", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_end", toolName: "bash", args: { command: "rm" }, isError: true });
      expect(r.eventLog[0].status).toBe("failed");
    });
  });

  // ============================================================
  // eventLog — turn_end
  // ============================================================
  describe("turn_end", () => {
    it("flushes residual text/thinking buffers then pushes turn_end", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "text_delta", delta: "partial" });
      updateFromEvent(r, { type: "thinking_delta", delta: "thought" });
      updateFromEvent(r, { type: "turn_end", summary: "summary text" });
      // thinking flushed, text flushed, turn_end pushed
      const types = r.eventLog.map((e) => e.type);
      expect(types).toContain("thinking");
      expect(types).toContain("text_output");
      expect(types).toContain("turn_end");
      expect(r._currentTurnText).toBe("");
      expect(r._currentThinking).toBe("");
    });

    it("turn_end label comes from event.summary", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "turn_end", summary: "completed refactor" });
      const turnEntry = r.eventLog.find((e) => e.type === "turn_end");
      expect(turnEntry?.label).toBe("completed refactor");
    });

    it("truncates long summary to TURN_SUMMARY_MAX", () => {
      const r = makeRecord();
      const longSummary = "s".repeat(TURN_SUMMARY_MAX + 20);
      updateFromEvent(r, { type: "turn_end", summary: longSummary });
      const turnEntry = r.eventLog.find((e) => e.type === "turn_end");
      expect(turnEntry?.label.length).toBe(TURN_SUMMARY_MAX);
    });

    it("turn_end label defaults to 'turn' when no summary", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "turn_end" });
      const turnEntry = r.eventLog.find((e) => e.type === "turn_end");
      expect(turnEntry?.label).toBe("turn");
    });
  });

  // ============================================================
  // eventLog — error event (NEW: appends entry, opposite of old)
  // ============================================================
  describe("error event", () => {
    it("appends an error entry to eventLog", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "error", message: "boom" });
      expect(r.eventLog).toHaveLength(1);
      expect(r.eventLog[0]).toMatchObject({ type: "error", label: "boom" });
    });
  });

  // ============================================================
  // ring buffer
  // ============================================================
  describe("ring buffer", () => {
    it("keeps at most MAX_EVENT_LOG_ENTRIES, dropping oldest", () => {
      const r = makeRecord();
      for (let i = 0; i < MAX_EVENT_LOG_ENTRIES + 5; i++) {
        updateFromEvent(r, { type: "tool_start", toolName: `tool${i}` });
      }
      expect(r.eventLog.length).toBe(MAX_EVENT_LOG_ENTRIES);
      // oldest 5 dropped
      expect(r.eventLog[0].label).toBe("tool5");
      expect(r.eventLog[r.eventLog.length - 1].label).toBe(`tool${MAX_EVENT_LOG_ENTRIES + 4}`);
    });
  });

  // ============================================================
  // message_end / compaction do not produce eventLog entries
  // ============================================================
  describe("non-eventLog events", () => {
    it("message_end and compaction produce no eventLog entries", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "message_end", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
      updateFromEvent(r, { type: "compaction" });
      expect(r.eventLog).toHaveLength(0);
    });
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
    // second call sees status !== running
    expect(tryTransition(r, "cancelled")).toBe(false);
    expect(r.status).toBe("done");
  });
});

// ============================================================
// completeRecord
// ============================================================
describe("completeRecord", () => {
  it("writes outcome fields without resetting turns/totalTokens", () => {
    const r = makeRecord({ turns: 5, totalTokens: 42 });
    r.status = "done"; // simulate tryTransition already ran
    completeRecord(r, SAMPLE_RESULT, "done");
    expect(r.status).toBe("done");
    expect(r.endedAt).toBeTypeOf("number");
    expect(r.agentResult).toBe(SAMPLE_RESULT);
    expect(r.result).toBe("done");
    expect(r.error).toBeUndefined();
    // turns/totalTokens not reset
    expect(r.turns).toBe(5);
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
// project / snapshot / toPersisted — projections
// ============================================================
describe("projections", () => {
  describe("project", () => {
    it("returns SubagentToolDetails with all fields", () => {
      const r = makeRecord({ turns: 3, totalTokens: 100 });
      updateFromEvent(r, { type: "tool_start", toolName: "read", args: { path: "/x.ts" } });
      const d = project(r);
      expect(d.status).toBe("running");
      expect(d.agent).toBe("worker");
      expect(d.model).toBe("test-model");
      expect(d.turns).toBe(3);
      expect(d.totalTokens).toBe(100);
      expect(d.eventLog).toHaveLength(1);
      expect(d.currentActivity).toEqual({ type: "tool", label: "read x.ts" });
    });

    it("eventLog is a defensive copy (mutating projection does not affect record)", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolName: "read" });
      const d = project(r);
      d.eventLog.push({ type: "error", label: "x", ts: 0 });
      expect(r.eventLog).toHaveLength(1);
    });

    it("currentActivity is undefined when status is not running", () => {
      const r = makeRecord({ status: "done" });
      const d = project(r);
      expect(d.currentActivity).toBeUndefined();
    });

    it("outputs mode + sessionFile (T2: action refactor 投影)", () => {
      const r = makeRecord({ mode: "background", turns: 2 });
      r.sessionFile = "bg-1-abc.jsonl";
      const d = project(r);
      expect(d.mode).toBe("background");
      expect(d.sessionFile).toBe("bg-1-abc.jsonl");
    });

    it("sessionFile is undefined when record.sessionFile unset (窗口期)", () => {
      const r = makeRecord();
      const d = project(r);
      expect(d.sessionFile).toBeUndefined();
    });

    it("currentActivity prefers tool over thinking over text", () => {
      const r = makeRecord();
      // tool_start (running) → tool wins
      updateFromEvent(r, { type: "tool_start", toolName: "edit", args: { path: "/a.ts" } });
      r._currentThinking = "thinking...";
      r._currentTurnText = "text...";
      expect(project(r).currentActivity).toEqual({ type: "tool", label: "edit a.ts" });
    });

    it("currentActivity falls back to thinking when no running tool", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolName: "read", args: { path: "/a.ts" } });
      updateFromEvent(r, { type: "tool_end", toolName: "read", args: { path: "/a.ts" } });
      r._currentThinking = "pondering";
      expect(project(r).currentActivity).toEqual({ type: "thinking", label: "pondering" });
    });

    it("currentActivity falls back to text when no tool/thinking", () => {
      const r = makeRecord();
      r._currentTurnText = "writing output";
      expect(project(r).currentActivity).toEqual({ type: "text", label: "writing output" });
    });

    it("currentActivity is undefined when idle", () => {
      const r = makeRecord();
      expect(project(r).currentActivity).toBeUndefined();
    });
  });

  describe("snapshot", () => {
    it("returns a readonly snapshot with identity + status fields", () => {
      const r = makeRecord({ turns: 2, status: "done", endedAt: 5000, result: "ok" });
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

    it("eventLog is a defensive copy", () => {
      const r = makeRecord();
      updateFromEvent(r, { type: "tool_start", toolName: "x" });
      const s = snapshot(r);
      s.eventLog.length = 0;
      expect(r.eventLog).toHaveLength(1);
    });

    it("outputs sessionFile (T2)", () => {
      const r = makeRecord();
      r.sessionFile = "s.jsonl";
      const s = snapshot(r);
      expect(s.sessionFile).toBe("s.jsonl");
    });

    it("sessionFile is undefined when unset (T2)", () => {
      const r = makeRecord();
      expect(snapshot(r).sessionFile).toBeUndefined();
    });
  });

  describe("toPersisted", () => {
    it("returns PersistedAgentRecord with truncated previews", () => {
      const longTask = "t".repeat(300);
      const longText = "r".repeat(300);
      const r = makeRecord({ task: longTask, turns: 1, status: "done" });
      r.status = "done";
      // sessionFile 由 session-runner 写入 record.sessionFile（规范源，早于 agentResult 冠结）。
      r.sessionFile = "sess.jsonl";
      completeRecord(r, { ...SAMPLE_RESULT, text: longText, sessionFile: "sess.jsonl" }, "done");
      const p = toPersisted(r, "/cwd", "session-xyz");
      expect(p.id).toBe("test-1");
      expect(p.taskPreview.length).toBe(200);
      expect(p.resultPreview?.length).toBe(200);
      expect(p.cwd).toBe("/cwd");
      expect(p.sessionId).toBe("session-xyz");
      expect(p.sessionFile).toBe("sess.jsonl");
      expect(p.status).toBe("done");
    });

    it("resultPreview is undefined when no result", () => {
      const r = makeRecord();
      const p = toPersisted(r, "/cwd");
      expect(p.resultPreview).toBeUndefined();
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

  it("truncates long labels to EVENT_LOG_LABEL_MAX", () => {
    const longQuery = "q".repeat(EVENT_LOG_LABEL_MAX + 50);
    const label = extractLabelFromArgs("web_search", { query: longQuery });
    expect(label.length).toBe("web_search ".length + EVENT_LOG_LABEL_MAX);
  });
});
