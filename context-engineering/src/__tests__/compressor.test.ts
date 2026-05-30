import { describe, it, expect } from "vitest";
import {
  compressContext,
  validateToolPairing,
  getToolResultText,
  type AgentMessage,
  type ToolCall,
  type AssistantMessage,
  type ToolResultMessage,
  type BashExecutionMessage,
  type UserMessage,
  type TextContent,
  type ThinkingContent,
  type ContextUsage,
} from "../compressor";
import { createRecallStore } from "../recall-store";
import { DEFAULT_CONFIG } from "../config";

// ── Test helpers ──

function makeToolResult(text: string, ageMs: number, toolCallId: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text" as const, text }],
    isError: false,
    timestamp: Date.now() - ageMs,
  };
}

function makeAssistant(
  toolCalls: ToolCall[],
  thinking?: string,
  ageMs: number = 0,
): AssistantMessage {
  const content: (TextContent | ThinkingContent | ToolCall)[] = [];
  if (thinking) {
    content.push({ type: "thinking" as const, thinking });
  }
  content.push(...toolCalls);
  if (toolCalls.length === 0 && !thinking) {
    content.push({ type: "text" as const, text: "ok" });
  }
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now() - ageMs,
  };
}

function makeUser(text: string, ageMs: number = 0): UserMessage {
  return { role: "user", content: text, timestamp: Date.now() - ageMs };
}

function makeBashExecution(output: string, ageMs: number = 0): BashExecutionMessage {
  return {
    role: "bashExecution",
    command: "cat file.txt",
    output,
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: Date.now() - ageMs,
  };
}

function tc(id: string, name: string = "read"): ToolCall {
  return {
    type: "toolCall" as const,
    id,
    name,
    arguments: { path: "file.ts" } as Record<string, unknown>,
  };
}

// ── Tests ──

describe("compressor", () => {
  const MINUTE = 60 * 1000;

  it("AC-1: 过期清理 — 过期的 ToolResult 被替换，保护 turn 内的保留", () => {
    const store = createRecallStore();

    // Turn 1: user(40min) → assistant(tc1) → toolResult(35min, 应过期)
    // Turn 2: user(20min) → assistant(tc2) → toolResult(15min, 在保护 turn 内)
    // Turn 3: user(1min)  — 让 Turn 2+3 成为保护 turn (protectRecentTurns=2)
    const messages: AgentMessage[] = [
      makeUser("task 1", 40 * MINUTE),
      makeAssistant([tc("c1")], undefined, 40 * MINUTE),
      makeToolResult("content of file A", 35 * MINUTE, "c1"),
      makeUser("task 2", 20 * MINUTE),
      makeAssistant([tc("c2")], undefined, 20 * MINUTE),
      makeToolResult("content of file B", 15 * MINUTE, "c2"),
      makeUser("task 3", 1 * MINUTE),
    ];

    const result = compressContext(messages, DEFAULT_CONFIG, store, undefined);

    expect(result.stats.validationFailed).toBe(false);

    // Turn 1 的 toolResult 应被过期
    const expired = result.messages[2] as ToolResultMessage;
    expect(expired.role).toBe("toolResult");
    const expiredText = getToolResultText(expired);
    expect(expiredText).toContain("[Tool result expired");
    expect(expiredText).toContain("ID: ctx-");
    expect(expiredText).not.toContain("content of file A");
    expect(result.stats.l0Expired).toBe(1);

    // Turn 2 的 toolResult 应保留原文
    const kept = result.messages[5] as ToolResultMessage;
    expect(getToolResultText(kept)).toBe("content of file B");

    // store 中应有一条记录
    expect(store.size()).toBe(1);
  });

  it("AC-2: Bash 截断 — 超长 output 被截断", () => {
    const store = createRecallStore();
    const longOutput = "x".repeat(10000);

    const messages: AgentMessage[] = [makeBashExecution(longOutput)];

    const result = compressContext(messages, DEFAULT_CONFIG, store, undefined);

    expect(result.stats.validationFailed).toBe(false);
    expect(result.stats.l0Truncated).toBe(1);

    const bash = result.messages[0] as BashExecutionMessage;
    expect(bash.output.length).toBeLessThan(longOutput.length);
    expect(bash.output).toContain("[truncated");
    expect(bash.output).toContain("ID: ctx-");
    expect(bash.output).toContain(`Total: ${longOutput.length} chars`);

    // 首尾内容保留
    const headChars = Math.floor(DEFAULT_CONFIG.l0.bashTruncateChars * 0.4);
    expect(bash.output).toContain("x".repeat(headChars));

    expect(store.size()).toBe(1);
  });

  it("AC-3: Thinking 清理 — 过期的 thinking 被清空", () => {
    const store = createRecallStore();

    const messages: AgentMessage[] = [
      makeAssistant([], "deep analysis of the problem...", 6 * MINUTE),
    ];

    const result = compressContext(messages, DEFAULT_CONFIG, store, undefined);

    expect(result.stats.validationFailed).toBe(false);
    expect(result.stats.l0ThinkingCleared).toBe(1);

    const asst = result.messages[0] as AssistantMessage;
    const thinkingBlock = asst.content.find((c) => c.type === "thinking");
    expect(thinkingBlock).toBeDefined();
    expect((thinkingBlock as ThinkingContent).thinking).toBe("[thinking expired]");
  });

  it("AC-4: 配对校验 — 正常和损坏序列", () => {
    // 正常序列
    const good: AgentMessage[] = [
      makeAssistant([tc("c1")]),
      makeToolResult("ok", 0, "c1"),
    ];
    expect(validateToolPairing(good)).toBe(true);

    // 损坏序列: toolResult 没有对应的 toolCall
    const orphaned: AgentMessage[] = [
      makeToolResult("orphan", 0, "c-missing"),
    ];
    expect(validateToolPairing(orphaned)).toBe(false);

    // 损坏序列: toolCall 没有对应的 toolResult
    const unmatched: AgentMessage[] = [
      makeAssistant([tc("c-unmatched")]),
    ];
    expect(validateToolPairing(unmatched)).toBe(false);
  });

  it("AC-7: L1 摘要 — 长文本被结构化摘要", () => {
    const store = createRecallStore();

    // 构造 > 8000 chars 的内容，包含 import/definition 行
    const headLines = Array.from({ length: 10 }, (_, i) => `// head comment line ${i}`);
    const middleImportLines = [
      "import { readFile } from 'fs';",
      "import { parse } from 'path';",
    ];
    const middleDefLines = [
      "function processData(input: string): string {",
      "export type Config = { debug: boolean };",
    ];
    const junkLines = Array.from({ length: 400 }, () => "  return someValueWithALongerNameToPadLength();");
    const tailLines = Array.from({ length: 5 }, (_, i) => `// tail comment ${i}`);

    const allLines = [
      ...headLines,
      ...middleImportLines,
      ...junkLines.slice(0, 100),
      ...middleDefLines,
      ...junkLines.slice(100),
      ...tailLines,
    ];
    const longContent = allLines.join("\n");
    expect(longContent.length).toBeGreaterThan(8000);

    const messages: AgentMessage[] = [
      makeUser("read file"),
      makeAssistant([tc("c1")]),
      makeToolResult(longContent, 0, "c1"),
    ];

    const result = compressContext(messages, DEFAULT_CONFIG, store, undefined);

    expect(result.stats.validationFailed).toBe(false);
    expect(result.stats.l1Condensed).toBe(1);

    const condensed = result.messages[2] as ToolResultMessage;
    const text = getToolResultText(condensed);

    // 验证摘要格式
    expect(text).toContain("[Condensed (ID: ctx-");
    expect(text).toContain("import { readFile }");
    expect(text).toContain("function processData");
    expect(text).toContain("export type Config");
    expect(text).toContain("[...");

    // 摘要应比原文短
    expect(text.length).toBeLessThan(longContent.length);
    expect(store.size()).toBeGreaterThanOrEqual(1);
  });

  it("AC-8: L2 紧急 — 高使用率时强制过期保护 turn 外的 toolResult", () => {
    const store = createRecallStore();
    const contextUsage: ContextUsage = {
      tokens: null,
      contextWindow: 200000,
      percent: 0.91,
    };

    // Turn 1: 20min 前 — 不在 L2 保护范围内 (protectRecentTurns=3, 但有 4 个 turn)
    // Turn 2-4: 较新 — 保护范围内
    const messages: AgentMessage[] = [
      makeUser("t1", 20 * MINUTE),
      makeAssistant([tc("c1")], undefined, 20 * MINUTE),
      makeToolResult("content-1", 20 * MINUTE, "c1"), // 20min < 30min → L0 不处理
      makeUser("t2", 10 * MINUTE),
      makeAssistant([tc("c2")], undefined, 10 * MINUTE),
      makeToolResult("content-2", 10 * MINUTE, "c2"),
      makeUser("t3", 5 * MINUTE),
      makeAssistant([tc("c3")], undefined, 5 * MINUTE),
      makeToolResult("content-3", 5 * MINUTE, "c3"),
      makeUser("t4", 1 * MINUTE),
    ];

    const result = compressContext(messages, DEFAULT_CONFIG, store, contextUsage);

    expect(result.stats.validationFailed).toBe(false);
    expect(result.stats.l2Triggered).toBe(true);

    // Turn 1 的 toolResult (index 2) 应被 L2 强制过期
    const forced = result.messages[2] as ToolResultMessage;
    expect(getToolResultText(forced)).toContain("[Tool result expired");

    // Turn 2 的 toolResult (index 5) 应保留
    const kept = result.messages[5] as ToolResultMessage;
    expect(getToolResultText(kept)).toBe("content-2");
  });

  it("AC-10: 全局禁用 — enabled=false 返回原始消息", () => {
    const store = createRecallStore();
    const config = { ...DEFAULT_CONFIG, enabled: false };

    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant([tc("c1")]),
      makeToolResult("big content here", 60 * MINUTE, "c1"),
    ];

    const result = compressContext(messages, config, store, undefined);

    // 应返回同一引用
    expect(result.messages).toBe(messages);
    expect(result.stats.l0Expired).toBe(0);
    expect(result.stats.l0Truncated).toBe(0);
    expect(result.stats.l0ThinkingCleared).toBe(0);
    expect(result.stats.l1Condensed).toBe(0);
    expect(result.stats.l2Triggered).toBe(false);
    expect(result.stats.validationFailed).toBe(false);
    expect(store.size()).toBe(0);
  });
});
