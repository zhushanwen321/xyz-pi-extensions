// src/__tests__/fork-context.test.ts
import { describe, expect,it } from "vitest";

import { forkContext } from "../resolution/fork-context.ts";

function makeEntry(role: string, text: string) {
  return { type: role === "assistant" ? "assistantMessage" : "userMessage", content: text } as never;
}

describe("forkContext", () => {
  it("extracts last 5 exchanges by default", () => {
    const branch: never[] = [];
    for (let i = 0; i < 8; i++) {
      branch.push(makeEntry("user", `user msg ${i}`));
      branch.push(makeEntry("assistant", `assistant reply ${i}`));
    }
    const result = forkContext(branch, {});
    expect(result.exchangeCount).toBe(5);
    expect(result.context).toContain("user msg 3");
    expect(result.context).not.toContain("user msg 2");
  });

  it("respects maxExchanges override", () => {
    const branch: never[] = [];
    for (let i = 0; i < 5; i++) {
      branch.push(makeEntry("user", `u${i}`));
      branch.push(makeEntry("assistant", `a${i}`));
    }
    const result = forkContext(branch, { maxExchanges: 2 });
    expect(result.exchangeCount).toBe(2);
  });

  it("handles fewer than 5 exchanges", () => {
    const branch = [makeEntry("user", "hi"), makeEntry("assistant", "hello")];
    const result = forkContext(branch, {});
    expect(result.exchangeCount).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("truncates by token estimate", () => {
    const branch: never[] = [];
    for (let i = 0; i < 20; i++) {
      branch.push(makeEntry("user", "x".repeat(500)));
      branch.push(makeEntry("assistant", "y".repeat(500)));
    }
    const result = forkContext(branch, { maxTokens: 400 });
    expect(result.truncated).toBe(true);
  });

  it("formats as Parent Conversation Context", () => {
    const branch = [makeEntry("user", "hello"), makeEntry("assistant", "hi there")];
    const result = forkContext(branch, {});
    expect(result.context).toContain("# Parent Conversation Context");
    expect(result.context).toContain("hello");
    expect(result.context).toContain("hi there");
  });

  // ── extractText edge cases ─────────────────────────────────────────────────

  it("extractText: content=undefined → empty string, entry skipped in output", () => {
    const branch = [{ type: "userMessage", content: undefined }];
    const result = forkContext(branch, {});
    expect(result.exchangeCount).toBe(1);
    // empty string is falsy, so forkContext skips the line
    expect(result.context).not.toContain("**User:**");
  });

  it("extractText: content=null → empty string, entry skipped in output", () => {
    const branch = [{ type: "userMessage", content: null }];
    const result = forkContext(branch, {});
    expect(result.exchangeCount).toBe(1);
    expect(result.context).not.toContain("**User:**");
  });

  it("extractText: content=[] → empty string, entry skipped in output", () => {
    const branch = [{ type: "userMessage", content: [] }];
    const result = forkContext(branch, {});
    expect(result.exchangeCount).toBe(1);
    expect(result.context).not.toContain("**User:**");
  });

  it("extractText: content array with non-string elements uses .text", () => {
    const branch = [{ type: "userMessage", content: [{ text: "hello" }, { text: " world" }] }];
    const result = forkContext(branch, {});
    expect(result.context).toContain("hello world");
  });

  it("extractText: content array with mixed types", () => {
    const branch = [{ type: "assistantMessage", content: ["plain", { text: "structured" }, 42] }];
    const result = forkContext(branch, {});
    expect(result.context).toContain("plainstructured");
  });

  it("extractText: content array with elements missing .text → empty", () => {
    const branch = [{ type: "userMessage", content: [{}] }];
    const result = forkContext(branch, {});
    expect(result.exchangeCount).toBe(1);
  });

  it("toolResult entries are skipped", () => {
    const branch = [
      { type: "userMessage", content: "q1" },
      { type: "toolResult", content: "tool output" },
      { type: "assistantMessage", content: "a1" },
    ];
    const result = forkContext(branch, {});
    expect(result.exchangeCount).toBe(1);
    expect(result.context).toContain("q1");
    expect(result.context).toContain("a1");
    expect(result.context).not.toContain("tool output");
  });
});
