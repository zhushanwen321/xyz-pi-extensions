// compressor.ts — L0/L1/L2 compression engine with tool pairing validation

import type { L0Config, L1Config, L2Config, ContextEngineeringConfig } from "./config.ts";
import type { RecallStore } from "./recall-store.ts";

// chars→tokens 估算因子和 fallback 上下文窗口大小
const CHARS_PER_TOKEN = 4;
const DEFAULT_CONTEXT_WINDOW = 200_000;

// ── Message types (structural subset of pi-ai + Pi coding agent) ──

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  timestamp: number;
  excludeFromContext?: boolean;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage;

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

// ── Exported data types ──

export interface TurnBoundary {
  startIndex: number;
  endIndex: number; // 不含
  timestamp: number;
}

export interface L0Stats {
  expired: number;
  truncated: number;
  thinkingCleared: number;
}

export interface CompressionStats {
  l0Expired: number;
  l0Truncated: number;
  l0ThinkingCleared: number;
  l1Condensed: number;
  l2Triggered: boolean;
  validationFailed: boolean;
}

// ── Turn boundary detection ──

export function findTurnBoundaries(messages: AgentMessage[]): TurnBoundary[] {
  if (messages.length === 0) return [];

  const boundaries: TurnBoundary[] = [];
  let turnStart = 0;

  for (let i = 1; i < messages.length; i++) {
    const role = messages[i].role;
    if (role === "user" || role === "bashExecution") {
      boundaries.push({
        startIndex: turnStart,
        endIndex: i,
        timestamp: messages[turnStart].timestamp,
      });
      turnStart = i;
    }
  }

  // 最后一个 turn
  boundaries.push({
    startIndex: turnStart,
    endIndex: messages.length,
    timestamp: messages[turnStart].timestamp,
  });

  return boundaries;
}

export function isInProtectedTurn(
  msgIndex: number,
  boundaries: TurnBoundary[],
  protectCount: number,
): boolean {
  if (protectCount <= 0 || boundaries.length === 0) return false;
  const protectedStart = Math.max(0, boundaries.length - protectCount);
  for (let i = protectedStart; i < boundaries.length; i++) {
    if (msgIndex >= boundaries[i].startIndex && msgIndex < boundaries[i].endIndex) {
      return true;
    }
  }
  return false;
}

// ── Message field accessors ──

export function getMessageTimestamp(msg: AgentMessage): number {
  return msg.timestamp;
}

export function getToolResultText(msg: ToolResultMessage): string {
  return msg.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
}

// ── L0 replacement formatters ──

export function expireToolResult(_originalText: string, id: string): string {
  return `[Tool result expired. ID: ${id}. Use recall_context(${id}) to retrieve the original content.]`;
}

export function truncateBashOutput(
  output: string,
  maxChars: number,
  id: string,
): string {
  if (output.length <= maxChars) return output;
  const headChars = Math.floor(maxChars / 2);
  const tailChars = Math.floor(maxChars / 2);
  return (
    output.slice(0, headChars) +
    `\n\n... [truncated. ID: ${id}. Use recall_context(${id}) to retrieve full output. Total: ${output.length} chars]\n\n` +
    output.slice(-tailChars)
  );
}

export function expireThinking(): string {
  return "[thinking expired]";
}

// ── L1 condensation ──

const IMPORT_EXPORT_RE = /^(import|export)\s/;
const DEFINITION_RE = /(function|class|interface|type|const|let|var)\s+\w+/;

function fallbackTruncate(content: string): string {
  const budget = Math.floor(content.length * 0.4);
  const headChars = Math.floor(budget / 2);
  const tailChars = Math.floor(budget / 2);
  return (
    content.slice(0, headChars) +
    "\n[... truncated for space]\n" +
    content.slice(-tailChars)
  );
}

export function condenseToolResult(
  content: string,
  keepHeadLines: number,
  keepTailLines: number,
): string {
  const lines = content.split("\n");

  // 行数不足以分 head/middle/tail → 直接 fallback
  if (lines.length <= keepHeadLines + keepTailLines) {
    return fallbackTruncate(content);
  }

  const head = lines.slice(0, keepHeadLines);
  const tail = lines.slice(-keepTailLines);
  const middle = lines.slice(keepHeadLines, lines.length - keepTailLines);

  const keptMiddle: string[] = [];
  let omitCount = 0;

  for (const line of middle) {
    if (IMPORT_EXPORT_RE.test(line) || DEFINITION_RE.test(line)) {
      if (omitCount > 0) {
        keptMiddle.push(`[... ${omitCount} lines omitted]`);
        omitCount = 0;
      }
      keptMiddle.push(line);
    } else {
      omitCount++;
    }
  }
  if (omitCount > 0) {
    keptMiddle.push(`[... ${omitCount} lines omitted]`);
  }

  const result = [...head, ...keptMiddle, ...tail].join("\n");

  // 压缩不够 → fallback 截断
  if (result.length > content.length * 0.4) {
    return fallbackTruncate(content);
  }

  return result;
}

// ── Tool pairing validation ──

export function validateToolPairing(messages: AgentMessage[]): boolean {
  const pendingToolCalls = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "toolCall") {
          pendingToolCalls.add(block.id);
        }
      }
    } else if (msg.role === "toolResult") {
      if (!pendingToolCalls.has(msg.toolCallId)) {
        return false;
      }
      pendingToolCalls.delete(msg.toolCallId);
    }
  }

  return pendingToolCalls.size === 0;
}

// ── Private helpers ──

function estimateMessageChars(msg: AgentMessage): number {
  switch (msg.role) {
    case "user": {
      if (typeof msg.content === "string") return msg.content.length;
      return msg.content
        .filter((c): c is TextContent => c.type === "text")
        .reduce((s, c) => s + c.text.length, 0);
    }
    case "assistant": {
      return msg.content.reduce((s, c) => {
        if (c.type === "text") return s + c.text.length;
        if (c.type === "thinking") return s + c.thinking.length;
        if (c.type === "toolCall") {
          return s + c.name.length + JSON.stringify(c.arguments).length;
        }
        return s;
      }, 0);
    }
    case "toolResult": {
      return msg.content
        .filter((c): c is TextContent => c.type === "text")
        .reduce((s, c) => s + c.text.length, 0);
    }
    case "bashExecution": {
      return msg.output.length;
    }
  }
}

function isToolResultExpired(msg: ToolResultMessage): boolean {
  return getToolResultText(msg).includes("[Tool result expired");
}

// ── L0: 基础过期/截断/思考清理 ──

export function processL0(
  messages: AgentMessage[],
  config: L0Config,
  store: RecallStore,
  now: number,
  turnBoundaries: TurnBoundary[],
): { messages: AgentMessage[]; stats: L0Stats } {
  const stats: L0Stats = { expired: 0, truncated: 0, thinkingCleared: 0 };
  const result: AgentMessage[] = [];

  // 预计算：每个位置之后是否有 user 消息
  const hasUserAfter = new Array<boolean>(messages.length).fill(false);
  let seenUser = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    hasUserAfter[i] = seenUser;
    if (messages[i].role === "user") seenUser = true;
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "toolResult") {
      const age = now - msg.timestamp;
      const expired = age > config.expireMinutes * 60000;
      const protected_ = isInProtectedTurn(i, turnBoundaries, config.protectRecentTurns);

      if (expired && !protected_) {
        const originalText = getToolResultText(msg);
        const id = store.store(originalText, "l0-expired");
        const expiredText = expireToolResult(originalText, id);
        result.push({
          ...msg,
          content: [{ type: "text" as const, text: expiredText }],
        });
        stats.expired++;
      } else {
        result.push(msg);
      }
    } else if (msg.role === "bashExecution") {
      if (msg.output.length > config.bashTruncateChars) {
        const id = store.store(msg.output, "l0-truncated");
        const truncatedOutput = truncateBashOutput(msg.output, config.bashTruncateChars, id);
        result.push({ ...msg, output: truncatedOutput });
        stats.truncated++;
      } else {
        result.push(msg);
      }
    } else if (msg.role === "assistant") {
      const age = now - msg.timestamp;
      const thinkingExpired = age > config.thinkingExpireMinutes * 60000;

      if (thinkingExpired && !hasUserAfter[i]) {
        const hasThinking = msg.content.some((c) => c.type === "thinking");
        if (hasThinking) {
          const newContent = msg.content.map((c) =>
            c.type === "thinking"
              ? ({ ...c, thinking: expireThinking() } as ThinkingContent)
              : c,
          );
          result.push({ ...msg, content: newContent });
          stats.thinkingCleared++;
          continue;
        }
      }
      result.push(msg);
    } else {
      result.push(msg);
    }
  }

  return { messages: result, stats };
}

// ── L1: 结构化摘要 ──

export function processL1(
  messages: AgentMessage[],
  config: L1Config,
  store: RecallStore,
): { messages: AgentMessage[]; stats: { condensed: number } } {
  const stats = { condensed: 0 };
  const result: AgentMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "toolResult") {
      if (isToolResultExpired(msg)) {
        result.push(msg);
        continue;
      }

      const text = getToolResultText(msg);
      if (text.length > config.summaryThresholdChars) {
        const summary = condenseToolResult(text, config.keepHeadLines, config.keepTailLines);
        const id = store.store(text, "l1-condensed");
        const condensedText = `[Condensed (ID: ${id}): ${summary}]`;
        result.push({
          ...msg,
          content: [{ type: "text" as const, text: condensedText }],
        });
        stats.condensed++;
      } else {
        result.push(msg);
      }
    } else {
      result.push(msg);
    }
  }

  return { messages: result, stats };
}

// ── L2: 紧急压缩 ──

export function processL2(
  messages: AgentMessage[],
  config: L2Config,
  store: RecallStore,
  contextUsage: ContextUsage | undefined,
  turnBoundaries: TurnBoundary[],
): { messages: AgentMessage[]; stats: { triggered: boolean } } {
  // 计算上下文使用率
  let usagePercent: number;
  if (contextUsage && contextUsage.percent != null) {
    usagePercent = contextUsage.percent;
  } else {
    let totalChars = 0;
    for (const msg of messages) {
      totalChars += estimateMessageChars(msg);
    }
    usagePercent = (totalChars / CHARS_PER_TOKEN) / DEFAULT_CONTEXT_WINDOW;
  }

  if (usagePercent < config.emergencyThreshold) {
    return { messages, stats: { triggered: false } };
  }

  const result: AgentMessage[] = [];
  let anyForceExpired = false;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (
      msg.role === "toolResult" &&
      !isToolResultExpired(msg) &&
      !isInProtectedTurn(i, turnBoundaries, config.protectRecentTurns)
    ) {
      const originalText = getToolResultText(msg);
      const id = store.store(originalText, "l2-emergency");
      const expiredText = expireToolResult(originalText, id);
      result.push({
        ...msg,
        content: [{ type: "text" as const, text: expiredText }],
      });
      anyForceExpired = true;
    } else {
      result.push(msg);
    }
  }

  return { messages: result, stats: { triggered: anyForceExpired } };
}

// ── 主入口 ──

export function compressContext(
  messages: AgentMessage[],
  config: ContextEngineeringConfig,
  store: RecallStore,
  contextUsage: ContextUsage | undefined,
): { messages: AgentMessage[]; stats: CompressionStats } {
  const zeroStats: CompressionStats = {
    l0Expired: 0,
    l0Truncated: 0,
    l0ThinkingCleared: 0,
    l1Condensed: 0,
    l2Triggered: false,
    validationFailed: false,
  };

  if (!config.enabled) {
    return { messages, stats: zeroStats };
  }

  const now = Date.now();
  const boundaries = findTurnBoundaries(messages);

  // L0
  let current = messages;
  const stats: CompressionStats = { ...zeroStats };
  if (config.l0.enabled) {
    const l0 = processL0(messages, config.l0, store, now, boundaries);
    current = l0.messages;
    stats.l0Expired = l0.stats.expired;
    stats.l0Truncated = l0.stats.truncated;
    stats.l0ThinkingCleared = l0.stats.thinkingCleared;
  }

  // L1
  if (config.l1.enabled) {
    const l1 = processL1(current, config.l1, store);
    current = l1.messages;
    stats.l1Condensed = l1.stats.condensed;
  }

  // L2
  if (config.l2.enabled) {
    const l2 = processL2(current, config.l2, store, contextUsage, boundaries);
    current = l2.messages;
    stats.l2Triggered = l2.stats.triggered;
  }

  // 配对校验
  if (!validateToolPairing(current)) {
    return { messages, stats: { ...stats, validationFailed: true } };
  }

  return { messages: current, stats };
}
