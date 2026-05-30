import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { loadConfig, type ContextEngineeringConfig } from "./config";
import { createRecallStore, type RecallStore } from "./recall-store";
import {
  compressContext,
  type CompressionStats,
  type AgentMessage as CompressorMessage,
} from "./compressor";
import {
  handleContextEngineeringCommand,
  handleContextStatsCommand,
} from "./commands";

// ── Tool parameter schemas ──

const RecallParams = Type.Object({
  id: Type.String({ description: "Context ID (ctx-xxxxxxxx) to recall" }),
});

// ── Cumulative stats factory ──

function zeroStats(): CompressionStats {
  return {
    l0Expired: 0,
    l0Truncated: 0,
    l0ThinkingCleared: 0,
    l1Condensed: 0,
    l2Triggered: false,
    validationFailed: false,
  };
}

// ── Extension entry ──

export default function contextEngineeringExtension(
  pi: ExtensionAPI,
): void {
  // Session-scoped state (rebuilt on session_start)
  let config: ContextEngineeringConfig = loadConfig();
  let store: RecallStore = createRecallStore();
  let cumulativeStats: CompressionStats = zeroStats();

  // ── session_start: reset state ──

  pi.on("session_start", () => {
    config = loadConfig();
    store = createRecallStore();
    cumulativeStats = zeroStats();
  });

  // ── context: compression core ──

  // Compressor defines its own AgentMessage union (includes BashExecutionMessage).
  // Pi's ContextEvent.messages uses the agent-core AgentMessage type.
  // At runtime Pi's messages contain all message types our compressor handles.
  pi.on("context", (event, ctx) => {
    try {
      const messages = event.messages as unknown as CompressorMessage[];
      const result = compressContext(
        messages,
        config,
        store,
        ctx.getContextUsage() as unknown as Parameters<typeof compressContext>[3],
      );

      cumulativeStats.l0Expired += result.stats.l0Expired;
      cumulativeStats.l0Truncated += result.stats.l0Truncated;
      cumulativeStats.l0ThinkingCleared += result.stats.l0ThinkingCleared;
      cumulativeStats.l1Condensed += result.stats.l1Condensed;
      if (result.stats.l2Triggered) cumulativeStats.l2Triggered = true;
      if (result.stats.validationFailed) cumulativeStats.validationFailed = true;

      // ContextEventResult.messages expects Pi's AgentMessage[], not our local union
      return { messages: result.messages as unknown as (typeof event.messages)[number][] };
    } catch {
      // Safety: never modify messages on unexpected error
      return {};
    }
  });

  // ── Tool: recall_context ──

  pi.registerTool({
    name: "recall_context",
    label: "Recall Compressed Context",
    description:
      "Recall original content that was compressed by the context engineering plugin. " +
      "Use when you need the full content of an expired, truncated, or condensed tool result.",
    promptSnippet:
      "recall_context(id) — retrieve original content compressed by context engineering",
    parameters: RecallParams,
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const stored = store.recall(params.id);
      if (!stored) {
        return {
          content: [
            {
              type: "text" as const,
              text: `[recall_context] ID "${params.id}" not found. Content may have been lost on session reload.`,
            },
          ],
          details: { found: false, id: params.id },
        };
      }
      const timestamp = new Date(stored.compressedAt).toISOString();
      return {
        content: [
          {
            type: "text" as const,
            text: `[Recalled content (${stored.level}, compressed at ${timestamp})]\n\n${stored.original}`,
          },
        ],
        details: { found: true, id: params.id, level: stored.level },
      };
    },
  });

  // ── Command: /context-engineering ──

  pi.registerCommand("context-engineering", {
    description: "View/modify context compression settings",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const output = handleContextEngineeringCommand(
        _args || undefined,
        config,
        cumulativeStats,
      );
      ctx.ui.notify(output, "info");
    },
  });

  // ── Command: /context-stats ──

  pi.registerCommand("context-stats", {
    description: "View context compression statistics",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const output = handleContextStatsCommand(cumulativeStats);
      ctx.ui.notify(output, "info");
    },
  });
}
