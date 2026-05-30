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

// ── Helper: accumulate compression stats ──

function accumulateStats(target: CompressionStats, delta: CompressionStats): void {
  target.l0Expired += delta.l0Expired;
  target.l0Truncated += delta.l0Truncated;
  target.l0ThinkingCleared += delta.l0ThinkingCleared;
  target.l1Condensed += delta.l1Condensed;
  if (delta.l2Triggered) target.l2Triggered = true;
  if (delta.validationFailed) target.validationFailed = true;
}

// ── Helper: register recall_context tool ──

function registerRecallTool(pi: ExtensionAPI, store: RecallStore): void {
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
}

// ── Helper: register commands ──

function registerCommands(
  pi: ExtensionAPI,
  config: ContextEngineeringConfig,
  stats: CompressionStats,
): void {
  pi.registerCommand("context-engineering", {
    description: "View/modify context compression settings",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const output = handleContextEngineeringCommand(_args || undefined, config, stats);
      ctx.ui.notify(output, "info");
    },
  });

  pi.registerCommand("context-stats", {
    description: "View context compression statistics",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const output = handleContextStatsCommand(stats);
      ctx.ui.notify(output, "info");
    },
  });
}

// ── Extension entry ──

export default function contextEngineeringExtension(pi: ExtensionAPI): void {
  // Session-scoped state (rebuilt on session_start)
  let config: ContextEngineeringConfig = loadConfig();
  let store: RecallStore = createRecallStore();
  let cumulativeStats: CompressionStats = zeroStats();

  // session_start: reset state
  pi.on("session_start", () => {
    config = loadConfig();
    store = createRecallStore();
    cumulativeStats = zeroStats();
  });

  // context: compression core
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
        ctx.getContextUsage() as unknown as
          Parameters<typeof compressContext>[3],
      );
      accumulateStats(cumulativeStats, result.stats);
      return {
        messages: result.messages as unknown as (typeof event.messages)[number][],
      };
    } catch {
      // Safety: never modify messages on unexpected error
      return {};
    }
  });

  registerRecallTool(pi, store);
  registerCommands(pi, config, cumulativeStats);
}
