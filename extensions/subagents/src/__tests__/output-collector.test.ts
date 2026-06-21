// src/__tests__/output-collector.test.ts
//
// 锁定决定 AgentResult 字段来源的三个纯函数契约：toUsageTotal / extractParsedOutput /
// collectResponseText。这些函数被 collectResult 直接消费，漂移会改变 AgentResult 字段。
import { describe, expect, it } from "vitest";

import {
  collectResponseText,
  extractParsedOutput,
  toUsageTotal,
} from "../core/output-collector.ts";
import type { ToolCall } from "../types.ts";

// ============================================================
// toUsageTotal
// ============================================================

describe("toUsageTotal", () => {
  it("returns undefined when all counters and cost are zero", () => {
    expect(
      toUsageTotal({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
    ).toBeUndefined();
  });

  it("preserves usage when only cost > 0 (total stays 0)", () => {
    const result = toUsageTotal({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 5 });
    expect(result).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 5, total: 0 });
  });

  it("computes total correctly when only input > 0", () => {
    const result = toUsageTotal({ input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
    expect(result).toEqual({ input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, total: 10 });
  });

  it("sums all four token counters into total", () => {
    const result = toUsageTotal({ input: 10, output: 20, cacheRead: 5, cacheWrite: 5, cost: 1 });
    expect(result?.total).toBe(40);
    expect(result?.cost).toBe(1);
  });

  it("spreads original usage fields into result", () => {
    const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 6 };
    const result = toUsageTotal(usage);
    expect(result).toMatchObject(usage);
  });
});

// ============================================================
// extractParsedOutput
// ============================================================

describe("extractParsedOutput", () => {
  it("returns undefined for empty toolCalls", () => {
    expect(extractParsedOutput([])).toBeUndefined();
  });

  it("returns undefined when no structured-output call exists", () => {
    const calls: ToolCall[] = [
      { toolName: "bash", result: { details: "x" } },
      { toolName: "read", result: { details: "y" } },
    ];
    expect(extractParsedOutput(calls)).toBeUndefined();
  });

  it("returns undefined when structured-output has no result.details", () => {
    const calls: ToolCall[] = [
      { toolName: "structured-output", result: { content: [] } },
      { toolName: "structured-output", result: {} },
      { toolName: "structured-output" },
    ];
    expect(extractParsedOutput(calls)).toBeUndefined();
  });

  it("returns details when exactly one structured-output call has details", () => {
    const calls: ToolCall[] = [
      { toolName: "bash" },
      { toolName: "structured-output", result: { details: { answer: 42 } } },
    ];
    expect(extractParsedOutput(calls)).toEqual({ answer: 42 });
  });

  it("returns the LAST structured-output details (reverse iteration)", () => {
    const calls: ToolCall[] = [
      { toolName: "structured-output", result: { details: "first" } },
      { toolName: "bash" },
      { toolName: "structured-output", result: { details: "second" } },
    ];
    expect(extractParsedOutput(calls)).toBe("second");
  });

  it("ignores isError structured-output calls without details, picks one with details", () => {
    const calls: ToolCall[] = [
      { toolName: "structured-output", isError: true, result: { content: [{ type: "text", text: "bad" }] } },
      { toolName: "structured-output", result: { details: { ok: true } } },
    ];
    expect(extractParsedOutput(calls)).toEqual({ ok: true });
  });
});

// ============================================================
// collectResponseText
// ============================================================

describe("collectResponseText", () => {
  it("returns empty string when no assistant message exists", () => {
    expect(collectResponseText([{ role: "user", content: [{ type: "text", text: "hi" }] }])).toBe("");
  });

  it("returns empty string for empty messages array", () => {
    expect(collectResponseText([])).toBe("");
  });

  it("concatenates multiple text parts of the last assistant message", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "World" },
        ],
      },
    ];
    expect(collectResponseText(messages)).toBe("Hello World");
  });

  it("skips non-text parts (tool_use, thinking) within assistant message", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "internal" },
          { type: "text", text: "answer" },
          { type: "tool_use", name: "bash" },
          { type: "text", text: "!" },
        ],
      },
    ];
    expect(collectResponseText(messages)).toBe("answer!");
  });

  it("only considers the LAST assistant message", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "old" }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
      { role: "assistant", content: [{ type: "text", text: "new" }] },
    ];
    expect(collectResponseText(messages)).toBe("new");
  });

  it("returns empty string when last assistant has undefined content", () => {
    expect(collectResponseText([{ role: "assistant", content: undefined }])).toBe("");
  });

  it("returns empty string when last assistant has empty content array", () => {
    expect(collectResponseText([{ role: "assistant", content: [] }])).toBe("");
  });

  it("ignores text parts where text is not a string", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: undefined },
          { type: "text", text: "kept" },
        ],
      },
    ];
    expect(collectResponseText(messages)).toBe("kept");
  });
});
