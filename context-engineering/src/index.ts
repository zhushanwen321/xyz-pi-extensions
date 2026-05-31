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
import { handleContextEngineeringCommand, handleContextStatsCommand } from "./commands";

const RecallParams = Type.Object({
  id: Type.String({ description: "Context ID (ctx-xxxxxxxx) to recall" }),
});

function zeroStats(): CompressionStats {
  return { l0Expired: 0, l0Truncated: 0, l0ThinkingCleared: 0, l1Condensed: 0, l2Triggered: false, validationFailed: false };
}

function addStats(target: CompressionStats, delta: CompressionStats): void {
  target.l0Expired += delta.l0Expired;
  target.l0Truncated += delta.l0Truncated;
  target.l0ThinkingCleared += delta.l0ThinkingCleared;
  target.l1Condensed += delta.l1Condensed;
  if (delta.l2Triggered) target.l2Triggered = true;
  if (delta.validationFailed) target.validationFailed = true;
}

function recallResult(id: string, store: RecallStore) {
  const stored = store.recall(id);
  if (!stored) return {
    content: [{ type: "text" as const, text: `[recall_context] ID "${id}" not found. Content may have been lost on session reload.` }],
    details: { found: false, id },
  };
  return {
    content: [{ type: "text" as const, text: `[Recalled content (${stored.level}, ${new Date(stored.compressedAt).toISOString()})]\n\n${stored.original}` }],
    details: { found: true, id, level: stored.level },
  };
}

// Extension entry — handlers close over mutable `config`/`store`/`cumulativeStats`
// so session_start reassignment is visible to every registered handler.

export default function contextEngineeringExtension(pi: ExtensionAPI): void {
  let config: ContextEngineeringConfig = loadConfig();
  let store: RecallStore = createRecallStore();
  let cumulativeStats: CompressionStats = zeroStats();

  pi.on("session_start", () => {
    config = loadConfig();
    store = createRecallStore();
    cumulativeStats = zeroStats();
  });

  pi.on("context", (event, ctx) => {
    try {
      // Pi Extension API types differ from our internal message types.
      // Both sides define the same shape but TypeScript can't verify across packages.
      // If Pi's message format changes, compressContext will gracefully fail via the catch below.
      const msgs = event.messages as unknown as CompressorMessage[];
      const result = compressContext(msgs, config, store, ctx.getContextUsage() as unknown as Parameters<typeof compressContext>[3]);
      addStats(cumulativeStats, result.stats);
      return { messages: result.messages as unknown as (typeof event.messages)[number][] };
    } catch (err) {
      // Silently degrade to original messages, but log for debuggability
      if (process.env.DEBUG_CONTEXT_ENGINEERING) {
        console.error("[context-engineering] compressContext failed:", err);
      }
      return {};
    }
  });

  pi.registerTool({
    name: "recall_context",
    label: "Recall Compressed Context",
    description: "Recall original content compressed by context engineering. Use when you need the full content of an expired, truncated, or condensed tool result.",
    promptSnippet: "recall_context(id) — retrieve original content compressed by context engineering",
    parameters: RecallParams,
    execute: async (_tcId, params, _sig, _upd, _ctx) => recallResult(params.id, store),
  });

  pi.registerCommand("context-engineering", {
    description: "View/modify context compression settings",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.notify(handleContextEngineeringCommand(_args || undefined, config, cumulativeStats), "info");
    },
  });

  pi.registerCommand("context-stats", {
    description: "View context compression statistics",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.notify(handleContextStatsCommand(cumulativeStats), "info");
    },
  });
}
