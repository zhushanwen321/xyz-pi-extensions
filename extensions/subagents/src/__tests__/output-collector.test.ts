// src/__tests__/output-collector.test.ts
//
// 锁定 extractParsedOutput 纯函数契约——它被 collectResult 直接消费，决定
// AgentResult.parsedOutput 字段。toUsageTotal / collectResponseText 已删除
// （usage 收口进 getTotalUsage，text 收口进 getFullText，均在 execution-record.test 测）。
import { describe, expect, it } from "vitest";

import { extractParsedOutput } from "../core/output-collector.ts";
import type { ToolCall } from "../types.ts";

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
