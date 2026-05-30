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
import { createRecallStore, type RecallStore } from "../recall-store";
import { DEFAULT_CONFIG, parseLevelArgs, type ContextEngineeringConfig } from "../config";
import { handleContextEngineeringCommand, handleContextStatsCommand } from "../commands";

// ── Helpers ──

const MINUTE = 60 * 1000;

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
  if (thinking) content.push({ type: "thinking" as const, thinking });
  content.push(...toolCalls);
  if (toolCalls.length === 0 && !thinking) content.push({ type: "text" as const, text: "ok" });
  return {
    role: "assistant", content, api: "anthropic-messages", provider: "anthropic",
    model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now() - ageMs,
  };
}

function makeUser(text: string, ageMs: number = 0): UserMessage {
  return { role: "user", content: text, timestamp: Date.now() - ageMs };
}

function makeBashExecution(output: string, ageMs: number = 0): BashExecutionMessage {
  return {
    role: "bashExecution", command: "cat file.txt", output, exitCode: 0,
    cancelled: false, truncated: false, timestamp: Date.now() - ageMs,
  };
}

function tc(id: string): ToolCall {
  return { type: "toolCall" as const, id, name: "read", arguments: { path: "f.ts" } as Record<string, unknown> };
}

function extractCtxId(text: string): string | null {
  const m = text.match(/ctx-[a-f0-9]{8}/);
  return m ? m[0] : null;
}

// ── Integration Tests ──

describe("Integration: TC-1 Tool Result 过期清理", () => {
  it("TC-1-01: 超过30分钟的toolResult被替换", () => {
    const store = createRecallStore();
    // 3 turns: Turn 1 toolResult(35min) outside protectRecentTurns=2
    const messages: AgentMessage[] = [
      makeUser("task0", 45 * MINUTE),
      makeAssistant([tc("c0")], undefined, 45 * MINUTE),
      makeToolResult("old-result", 44 * MINUTE, "c0"),
      makeUser("task1", 40 * MINUTE),
      makeAssistant([tc("c1")], undefined, 40 * MINUTE),
      makeToolResult("original content A", 35 * MINUTE, "c1"),
      makeUser("task2", 1 * MINUTE),
    ];

    const result = compressContext(messages, DEFAULT_CONFIG, store, undefined);
    // c0's toolResult at index 2 is in Turn 0 (before user@40min), outside protected 2 turns
    // c1's toolResult at index 5 is in Turn 1, inside protected 2 turns
    const expired = result.messages[2] as ToolResultMessage;
    // c0's toolResult at index 2 is expired (outside protected 2 turns)
    const text = getToolResultText(expired);

    expect(text).toContain("[Tool result expired");
    const id = extractCtxId(text);
    expect(id).not.toBeNull();

    // Recall store 中有原始内容
    const stored = store.recall(id!);
    expect(stored).toBeDefined();
    expect(stored!.original).toContain("old-result");
    expect(stored!.level).toBe("l0-expired");
  });

  it("TC-1-02: 最近N轮内的toolResult不被过期", () => {
    const store = createRecallStore();
    const messages: AgentMessage[] = [
      makeUser("old", 40 * MINUTE),
      makeAssistant([tc("c1")], undefined, 35 * MINUTE),
      makeToolResult("should-be-protected", 35 * MINUTE, "c1"),
      makeUser("recent", 1 * MINUTE),
    ];

    const result = compressContext(messages, DEFAULT_CONFIG, store, undefined);
    const kept = result.messages[2] as ToolResultMessage;
    // protectRecentTurns=2 → turn boundary at user(1min) → toolResult(35min) is in protected turn
    expect(getToolResultText(kept)).toBe("should-be-protected");
    expect(result.stats.l0Expired).toBe(0);
  });
});

describe("Integration: TC-2 Bash 输出截断", () => {
  it("TC-2-01: 超过阈值的bash输出被截断", () => {
    const store = createRecallStore();
    const longOutput = "A".repeat(10000);
    const messages: AgentMessage[] = [makeBashExecution(longOutput)];

    const result = compressContext(messages, DEFAULT_CONFIG, store, undefined);
    expect(result.stats.l0Truncated).toBe(1);

    const bash = result.messages[0] as BashExecutionMessage;
    expect(bash.output.length).toBeLessThan(longOutput.length);
    expect(bash.output).toContain("[truncated");

    // Recall store 中有完整原始输出
    const id = extractCtxId(bash.output);
    expect(id).not.toBeNull();
    const stored = store.recall(id!);
    expect(stored).toBeDefined();
    expect(stored!.original).toBe(longOutput);
  });

  it("TC-2-02: 低于阈值的bash输出不被截断", () => {
    const store = createRecallStore();
    const shortOutput = "B".repeat(3000);
    const messages: AgentMessage[] = [makeBashExecution(shortOutput)];

    const result = compressContext(messages, DEFAULT_CONFIG, store, undefined);
    expect(result.stats.l0Truncated).toBe(0);

    const bash = result.messages[0] as BashExecutionMessage;
    expect(bash.output).toBe(shortOutput);
  });
});

describe("Integration: TC-3 Thinking 清理", () => {
  it("TC-3-01: 超过空闲时间的thinking被清空", () => {
    const store = createRecallStore();
    const messages: AgentMessage[] = [
      makeAssistant([], "deep analysis content here", 6 * MINUTE),
    ];

    const result = compressContext(messages, DEFAULT_CONFIG, store, undefined);
    expect(result.stats.l0ThinkingCleared).toBe(1);

    const asst = result.messages[0] as AssistantMessage;
    const thinking = asst.content.find((c) => c.type === "thinking") as ThinkingContent | undefined;
    expect(thinking).toBeDefined();
    expect(thinking!.thinking).toBe("[thinking expired]");
  });
});

describe("Integration: TC-4 配对校验", () => {
  it("TC-4-01: 正常序列压缩后配对完整", () => {
    const store = createRecallStore();
    const messages: AgentMessage[] = [
      makeUser("do it"),
      makeAssistant([tc("c1")]),
      makeToolResult("result content", 0, "c1"),
      makeUser("next"),
    ];

    const result = compressContext(messages, DEFAULT_CONFIG, store, undefined);
    expect(result.stats.validationFailed).toBe(false);
    // toolResult 紧随 toolCall
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[2].role).toBe("toolResult");
  });

  it("TC-4-02: 校验失败时返回原始消息", () => {
    // 通过构造让 validateToolPairing 失败的场景很难在正常 pipeline 中触发
    // 直接测试 validateToolPairing 函数
    const orphaned: AgentMessage[] = [
      makeToolResult("orphan result", 0, "c-missing"),
    ];
    expect(validateToolPairing(orphaned)).toBe(false);

    // compressContext 对孤儿消息应安全降级
    const store = createRecallStore();
    const result = compressContext(orphaned, DEFAULT_CONFIG, store, undefined);
    expect(result.stats.validationFailed).toBe(true);
    // 返回原始消息
    expect(result.messages).toBe(orphaned);
  });
});

describe("Integration: TC-5 Recall 完整性", () => {
  it("TC-5-01: 存在的ID返回完整原始内容", () => {
    const store = createRecallStore();
    const id = store.store("original full content here", "l0-expired");
    const stored = store.recall(id);
    expect(stored).toBeDefined();
    expect(stored!.original).toBe("original full content here");
    expect(stored!.level).toBe("l0-expired");
    expect(typeof stored!.compressedAt).toBe("number");
  });

  it("TC-5-02: 不存在的ID返回undefined", () => {
    const store = createRecallStore();
    expect(store.recall("ctx-nonexist")).toBeUndefined();
  });
});

describe("Integration: TC-7 L1 规则化摘要", () => {
  it("TC-7-01: TypeScript代码保留关键行", () => {
    const store = createRecallStore();
    const headLines = Array.from({ length: 10 }, (_, i) => `// head line ${i}`);
    const imports = ["import { read } from 'fs';", "import { join } from 'path';"];
    const defs = ["function process(d: string): void {", "export class Handler {"];
    const filler = Array.from({ length: 600 }, () => "  return x + y + z + someVeryLongVariableNamePadding();");
    const tailLines = Array.from({ length: 5 }, (_, i) => `// tail ${i}`);
    const longContent = [...headLines, ...imports, ...filler.slice(0, 150), ...defs, ...filler.slice(150), ...tailLines].join("\n");
    expect(longContent.length).toBeGreaterThan(8000);

    const messages: AgentMessage[] = [
      makeUser("read"),
      makeAssistant([tc("c1")]),
      makeToolResult(longContent, 0, "c1"),
    ];

    const result = compressContext(messages, DEFAULT_CONFIG, store, undefined);
    expect(result.stats.l1Condensed).toBe(1);

    const condensed = result.messages[2] as ToolResultMessage;
    const text = getToolResultText(condensed);

    expect(text).toContain("[Condensed (ID: ctx-");
    expect(text).toContain("import { read }");
    expect(text).toContain("function process");
    expect(text).toContain("export class Handler");
    expect(text.length).toBeLessThan(longContent.length);

    // Recall store 有原始内容
    const id = extractCtxId(text);
    expect(store.recall(id!)).toBeDefined();
  });

  it("TC-7-02: 非代码内容fallback到截断", () => {
    const store = createRecallStore();
    // 纯 JSON 内容，无 import/function/class 行
    const jsonContent = JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ id: i, value: `item-${i}` })));
    expect(jsonContent.length).toBeGreaterThan(8000);

    const messages: AgentMessage[] = [
      makeUser("read json"),
      makeAssistant([tc("c1")]),
      makeToolResult(jsonContent, 0, "c1"),
    ];

    const result = compressContext(messages, DEFAULT_CONFIG, store, undefined);
    expect(result.stats.l1Condensed).toBe(1);

    const condensed = result.messages[2] as ToolResultMessage;
    const text = getToolResultText(condensed);
    expect(text).toContain("[Condensed (ID: ctx-");
    // 非代码内容走 fallback 截断，不会包含 import 行
    expect(text).not.toContain("import");
  });
});

describe("Integration: TC-8 L2 紧急压缩", () => {
  it("TC-8-01: 91%使用率触发紧急压缩", () => {
    const store = createRecallStore();
    const contextUsage: ContextUsage = { tokens: null, contextWindow: 200000, percent: 0.91 };

    // 4 个 turn，L2 protectRecentTurns=3，Turn 1 不在保护范围
    const messages: AgentMessage[] = [
      makeUser("t1", 20 * MINUTE),
      makeAssistant([tc("c1")], undefined, 20 * MINUTE),
      makeToolResult("old-content", 20 * MINUTE, "c1"),
      makeUser("t2", 10 * MINUTE),
      makeAssistant([tc("c2")], undefined, 10 * MINUTE),
      makeToolResult("mid-content", 10 * MINUTE, "c2"),
      makeUser("t3", 5 * MINUTE),
      makeAssistant([tc("c3")], undefined, 5 * MINUTE),
      makeToolResult("recent-content", 5 * MINUTE, "c3"),
      makeUser("t4", 1 * MINUTE),
    ];

    const result = compressContext(messages, DEFAULT_CONFIG, store, contextUsage);
    expect(result.stats.l2Triggered).toBe(true);

    // Turn 1 toolResult 被强制过期
    const forced = result.messages[2] as ToolResultMessage;
    expect(getToolResultText(forced)).toContain("[Tool result expired");

    // Turn 2 toolResult 保留
    const kept = result.messages[5] as ToolResultMessage;
    expect(getToolResultText(kept)).toBe("mid-content");
  });

  it("TC-8-02: 85%使用率不触发L2", () => {
    const store = createRecallStore();
    const contextUsage: ContextUsage = { tokens: null, contextWindow: 200000, percent: 0.85 };

    const messages: AgentMessage[] = [
      makeUser("t1", 20 * MINUTE),
      makeAssistant([tc("c1")], undefined, 20 * MINUTE),
      makeToolResult("content", 20 * MINUTE, "c1"),
    ];

    const result = compressContext(messages, DEFAULT_CONFIG, store, contextUsage);
    expect(result.stats.l2Triggered).toBe(false);
  });
});

describe("Integration: TC-9 统计命令", () => {
  it("TC-9-01: /context-stats输出正确统计", () => {
    const stats = {
      l0Expired: 3,
      l0Truncated: 2,
      l0ThinkingCleared: 1,
      l1Condensed: 1,
      l2Triggered: false,
      validationFailed: false,
    };

    const output = handleContextStatsCommand(stats);
    expect(output).toContain("3");    // expired
    expect(output).toContain("2");    // truncated
    expect(output).toContain("1");    // thinking
    expect(output).toContain("1");    // condensed
  });
});

describe("Integration: TC-10 配置启停", () => {
  it("TC-10-01: 全局启停", () => {
    const config = { ...DEFAULT_CONFIG, enabled: true };
    const store = createRecallStore();

    // 执行 /context-engineering global off
    const offResult = handleContextEngineeringCommand("global off", config, {
      l0Expired: 0, l0Truncated: 0, l0ThinkingCleared: 0,
      l1Condensed: 0, l2Triggered: false, validationFailed: false,
    });
    expect(config.enabled).toBe(false);

    // 禁用时不压缩
    const messages: AgentMessage[] = [
      makeUser("hi"),
      makeAssistant([tc("c1")]),
      makeToolResult("big content", 60 * MINUTE, "c1"),
    ];
    const result = compressContext(messages, config, store, undefined);
    expect(result.messages).toBe(messages);

    // 执行 /context-engineering global on
    const onResult = handleContextEngineeringCommand("global on", config, {
      l0Expired: 0, l0Truncated: 0, l0ThinkingCleared: 0,
      l1Condensed: 0, l2Triggered: false, validationFailed: false,
    });
    expect(config.enabled).toBe(true);
  });

  it("TC-10-02: 独立级别启停", () => {
    const config: ContextEngineeringConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

    // /context-engineering l1 off
    const result = handleContextEngineeringCommand("l1 off", config, {
      l0Expired: 0, l0Truncated: 0, l0ThinkingCleared: 0,
      l1Condensed: 0, l2Triggered: false, validationFailed: false,
    });
    expect(result).toContain("L1");
    expect(config.l1.enabled).toBe(false);
    // L0 和 L2 不受影响
    expect(config.l0.enabled).toBe(true);
    expect(config.l2.enabled).toBe(true);
  });
});
