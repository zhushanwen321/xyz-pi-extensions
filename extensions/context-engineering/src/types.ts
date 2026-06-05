// types.ts — Shared type definitions for context-engineering extension

// ── Message content block types ──

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

// ── Message types (structural subset of pi-ai + Pi coding agent) ──

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

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CompactionSummaryMessage;

// ── Domain types ──

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface TurnBoundary {
  startIndex: number;
  endIndex: number; // 不含
  timestamp: number;
}

// ── Stats types ──

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
  mcTriggered: boolean;
  mcCleared: number;
  budgetPersisted: number;
}

export interface McStats {
  triggered: boolean;
  cleared: number;
}

export interface BudgetStats {
  persisted: number;
}
