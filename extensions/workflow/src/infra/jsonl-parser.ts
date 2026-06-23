/**
 * Workflow Extension — JSONL Parser
 *
 * Pure functions for parsing pi --mode json JSONL events.
 * No side effects, no runtime state dependency.
 * Mutates a ParsedPipelineEvent accumulator in place for O(1) memory per event.
 */

import type { ToolCallEntry } from "../engine/models/types.js";

// ── Pipeline accumulator ──────────────────────────────────────

export interface ParsedPipelineEvent {
  output: string;
  usage: PipelineUsage;
  model?: string;
  stopReason?: string;
 /**
 * Structured output from successful structured-output tool call.
 * Source: `tool_execution_end.result.details` — the validated & parsed data object
 * returned by the extension's execute. NOT the raw tool call args (which may contain
 * JSON strings for schema/data that models sometimes pass).
 */
  parsedOutput?: unknown;
 /** Pending args from tool_execution_start, awaiting tool_execution_end confirmation. */
  pendingStructuredArgs?: unknown;
 /** Pending toolCallId to match against tool_execution_end. */
  pendingStructuredCallId?: string;
 /** Whether any tool_execution_start event was seen (for schema failure detection). */
  hasToolCall?: boolean;
 /** Session ID extracted from the first JSONL event (type=session header). */
  sessionId?: string;
 /** All tool calls collected from JSONL stream (FR-7). */
  toolCalls: ToolCallEntry[];
}

export interface PipelineUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

// ── Factory ───────────────────────────────────────────────────

export function makeEmptyPipeline(): ParsedPipelineEvent {
  return {
    output: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    sessionId: undefined,
    toolCalls: [],
  };
}

// ── JSONL line processor ──────────────────────────────────────

/**
 * Process a single JSONL event from pi --mode json stdout.
 * Mutates `pipeline` in place with O(1) memory overhead per event.
 */
export function processJsonlEvent(event: Record<string, unknown>, pipeline: ParsedPipelineEvent): void {
 // First event in --mode json stdout: session header with ID for locating session JSONL
  if (event.type === "session") {
    if (typeof event.id === "string") {
      pipeline.sessionId = event.id;
    }
    return;
  }

  if (event.type === "tool_execution_start") {
    if (event.toolName === "structured-output") {
      pipeline.pendingStructuredArgs = event.args;
      pipeline.pendingStructuredCallId = event.toolCallId as string | undefined;
    }
    const input = typeof event.args === "object" && event.args !== null
      ? JSON.stringify(event.args)
      : String(event.args ?? "");
    pipeline.toolCalls.push({ name: String(event.toolName ?? "unknown"), input });
    pipeline.hasToolCall = true;
    return;
  }

  if (event.type === "tool_execution_end") {
    if (event.toolName === "structured-output" && !event.isError) {
      const result = event.result as Record<string, unknown> | undefined;
      const details = result?.details;
      if (details && typeof details === "object") {
        pipeline.parsedOutput = details as Record<string, unknown>;
      } else {
        pipeline.parsedOutput = pipeline.pendingStructuredArgs;
      }
    }
    pipeline.pendingStructuredArgs = undefined;
    pipeline.pendingStructuredCallId = undefined;
    return;
  }

  if (event.type === "message_end" && event.message) {
    const msg = event.message as Record<string, unknown>;
    if (msg.role === "assistant") {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text") {
            const text = (part as Record<string, unknown>).text;
            if (typeof text === "string") {
              pipeline.output += text;
            }
          }
        }
      }

      const u = msg.usage as Record<string, number> | undefined;
      if (u) {
        pipeline.usage.input += u.input ?? 0;
        pipeline.usage.output += u.output ?? 0;
        pipeline.usage.cacheRead += u.cacheRead ?? 0;
        pipeline.usage.cacheWrite += u.cacheWrite ?? 0;
        pipeline.usage.cost += Number(u.cost) || 0;
        pipeline.usage.contextTokens = u.totalTokens ?? u.contextTokens ?? 0;
        pipeline.usage.turns++;
      }

      if (typeof msg.model === "string") pipeline.model = msg.model;
      if (typeof msg.stopReason === "string") pipeline.stopReason = msg.stopReason;
    }
  }
}
