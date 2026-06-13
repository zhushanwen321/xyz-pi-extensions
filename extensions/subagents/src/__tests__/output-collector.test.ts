// src/__tests__/output-collector.test.ts
import { describe, it, expect } from "vitest";
import { collectResponseText } from "../core/output-collector.ts";

describe("collectResponseText", () => {
  it("extracts text from last assistant message content", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [
        { type: "text", text: "first " },
        { type: "text", text: "response" },
      ] },
    ];
    expect(collectResponseText(messages as never)).toBe("first response");
  });

  it("returns empty string if no assistant message", () => {
    expect(collectResponseText([{ role: "user", content: "hi" } as never])).toBe("");
  });

  it("skips thinking content and tool calls, only concatenates text", () => {
    const messages = [{
      role: "assistant",
      content: [
        { type: "thinking", text: "internal" },
        { type: "text", text: "visible" },
        { type: "tool_call", name: "read" },
      ],
    }];
    expect(collectResponseText(messages as never)).toBe("visible");
  });

  it("handles empty messages array", () => {
    expect(collectResponseText([])).toBe("");
  });
});
