// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）
// 运行命令：npx vitest run src/__tests__/jsonl-parser.test.ts

import { describe, expect, it } from "vitest";

import {
  makeEmptyPipeline,
  processJsonlEvent,
} from "../infra/jsonl-parser.js";

describe("jsonl-parser.ts", () => {
  describe("makeEmptyPipeline()", () => {
    it("returns pipeline with empty output, zero usage, no sessionId", () => {
      const p = makeEmptyPipeline();
      expect(p.output).toBe("");
      expect(p.usage).toEqual({
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        cost: 0, contextTokens: 0, turns: 0,
      });
      expect(p.sessionId).toBeUndefined();
      expect(p.parsedOutput).toBeUndefined();
      expect(p.hasToolCall).toBeUndefined();
      expect(p.toolCalls).toEqual([]);
    });
  });

  describe("processJsonlEvent()", () => {
    it("extracts sessionId from session header event", () => {
      const p = makeEmptyPipeline();
      processJsonlEvent({ type: "session", id: "sess-123" }, p);
      expect(p.sessionId).toBe("sess-123");
    });

    it("ignores session event without id", () => {
      const p = makeEmptyPipeline();
      processJsonlEvent({ type: "session" }, p);
      expect(p.sessionId).toBeUndefined();
    });

    it("captures tool_execution_start and sets hasToolCall", () => {
      const p = makeEmptyPipeline();
      processJsonlEvent({
        type: "tool_execution_start",
        toolName: "bash",
        args: { command: "ls" },
        toolCallId: "tc-1",
      }, p);
      expect(p.hasToolCall).toBe(true);
      expect(p.toolCalls).toHaveLength(1);
      expect(p.toolCalls[0]).toEqual({
        name: "bash",
        input: '{"command":"ls"}',
      });
    });

    it("stashes structured-output args on tool_execution_start", () => {
      const p = makeEmptyPipeline();
      processJsonlEvent({
        type: "tool_execution_start",
        toolName: "structured-output",
        args: { schema: {}, data: {} },
        toolCallId: "tc-2",
      }, p);
      expect(p.pendingStructuredArgs).toEqual({ schema: {}, data: {} });
      expect(p.pendingStructuredCallId).toBe("tc-2");
    });

    it("confirms structured output from tool_execution_end details", () => {
      const p = makeEmptyPipeline();
      processJsonlEvent({
        type: "tool_execution_start",
        toolName: "structured-output",
        args: "pending",
        toolCallId: "tc-3",
      }, p);
      processJsonlEvent({
        type: "tool_execution_end",
        toolName: "structured-output",
        isError: false,
        result: { details: { answer: 42 } },
      }, p);
      expect(p.parsedOutput).toEqual({ answer: 42 });
      expect(p.pendingStructuredArgs).toBeUndefined();
    });

    it("falls back to pending args when tool_execution_end has no details", () => {
      const p = makeEmptyPipeline();
      processJsonlEvent({
        type: "tool_execution_start",
        toolName: "structured-output",
        args: "fallback-value",
        toolCallId: "tc-4",
      }, p);
      processJsonlEvent({
        type: "tool_execution_end",
        toolName: "structured-output",
        isError: false,
        result: {},
      }, p);
      expect(p.parsedOutput).toBe("fallback-value");
    });

    it("does not set parsedOutput on error tool_execution_end", () => {
      const p = makeEmptyPipeline();
      processJsonlEvent({
        type: "tool_execution_start",
        toolName: "structured-output",
        args: "pending",
        toolCallId: "tc-5",
      }, p);
      processJsonlEvent({
        type: "tool_execution_end",
        toolName: "structured-output",
        isError: true,
        result: {},
      }, p);
      expect(p.parsedOutput).toBeUndefined();
    });

    it("extracts text and usage from message_end", () => {
      const p = makeEmptyPipeline();
      processJsonlEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }],
          usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.01, totalTokens: 160, turns: 1 },
          model: "gpt-4",
          stopReason: "end_turn",
        },
      }, p);
      expect(p.output).toBe("hello world");
      expect(p.usage.input).toBe(100);
      expect(p.usage.output).toBe(50);
      expect(p.usage.cacheRead).toBe(10);
      expect(p.usage.cacheWrite).toBe(5);
      expect(p.usage.cost).toBe(0.01);
      expect(p.usage.contextTokens).toBe(160);
      expect(p.usage.turns).toBe(1);
      expect(p.model).toBe("gpt-4");
      expect(p.stopReason).toBe("end_turn");
    });

    it("ignores non-assistant message_end", () => {
      const p = makeEmptyPipeline();
      processJsonlEvent({
        type: "message_end",
        message: { role: "user", content: "hello" },
      }, p);
      expect(p.output).toBe("");
      expect(p.usage.turns).toBe(0);
    });

    it("accumulates usage across multiple message_end events", () => {
      const p = makeEmptyPipeline();
      processJsonlEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "a" }],
          usage: { input: 10, output: 5 },
        },
      }, p);
      processJsonlEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "b" }],
          usage: { input: 20, output: 10 },
        },
      }, p);
      expect(p.output).toBe("ab");
      expect(p.usage.input).toBe(30);
      expect(p.usage.output).toBe(15);
      expect(p.usage.turns).toBe(2);
    });

    it("ignores unknown event types", () => {
      const p = makeEmptyPipeline();
      processJsonlEvent({ type: "unknown_event", data: "whatever" }, p);
      expect(p.output).toBe("");
      expect(p.usage.turns).toBe(0);
    });

    it("clears pendingStructuredArgs on non-structured tool_execution_end", () => {
      const p = makeEmptyPipeline();
      // Set up pending structured args from a prior structured-output start
      processJsonlEvent({
        type: "tool_execution_start",
        toolName: "structured-output",
        args: { schema: {}, data: {} },
        toolCallId: "tc-staged",
      }, p);
      expect(p.pendingStructuredArgs).toBeDefined();

      // A different tool ends — should clear pending args but NOT set parsedOutput
      processJsonlEvent({
        type: "tool_execution_end",
        toolName: "bash",
        isError: false,
        result: { content: "done" },
      }, p);
      expect(p.pendingStructuredArgs).toBeUndefined();
      expect(p.pendingStructuredCallId).toBeUndefined();
      expect(p.parsedOutput).toBeUndefined();
    });

    it("message_end with string content does not set output or parsedOutput", () => {
      const p = makeEmptyPipeline();
      processJsonlEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: "plain string",
          usage: { input: 10, output: 5 },
        },
      }, p);
      // String content is not an array, so no text is extracted into output
      expect(p.output).toBe("");
      // parsedOutput is never set by message_end (only by tool_execution_end)
      expect(p.parsedOutput).toBeUndefined();
      // Usage is still accumulated even when content is a string
      expect(p.usage.input).toBe(10);
      expect(p.usage.output).toBe(5);
      expect(p.usage.turns).toBe(1);
    });
  });
});
