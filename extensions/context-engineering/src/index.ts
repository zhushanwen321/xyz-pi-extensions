import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { handleContextEngineeringCommand, handleContextStatsCommand } from "./commands";
import {
  type AgentMessage as CompressorMessage,
  compressContext,
  type CompressionStats,
  type ContextUsage as CompressorContextUsage,
} from "./compressor";
import { type ContextEngineeringConfig,loadConfig } from "./config";
import { createFrozenFreshState, type FrozenFreshState } from "./frozen-fresh";
import { createRecallStore, type RecallStore } from "./recall-store";

const RecallParams = Type.Object({
  id: Type.String({ description: "Context ID (ctx-xxxxxxxx) to recall" }),
});

function zeroStats(): CompressionStats {
  return { l0Expired: 0, l0Truncated: 0, l0ThinkingCleared: 0, l1Condensed: 0, l2Triggered: false, validationFailed: false, mcTriggered: false, mcCleared: 0, budgetPersisted: 0 };
}

function addStats(target: CompressionStats, delta: CompressionStats): void {
  target.l0Expired += delta.l0Expired;
  target.l0Truncated += delta.l0Truncated;
  target.l0ThinkingCleared += delta.l0ThinkingCleared;
  target.l1Condensed += delta.l1Condensed;
  target.mcCleared += delta.mcCleared;
  target.budgetPersisted += delta.budgetPersisted;
  if (delta.l2Triggered) target.l2Triggered = true;
  if (delta.validationFailed) target.validationFailed = true;
  if (delta.mcTriggered) target.mcTriggered = true;
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
  let frozenFreshState: FrozenFreshState = createFrozenFreshState();

  pi.on("session_start", () => {
    config = loadConfig();
    store = createRecallStore();
    cumulativeStats = zeroStats();
    frozenFreshState = createFrozenFreshState();
  });

  pi.on("context", (event: { messages: unknown[] }, ctx: { getContextUsage(): unknown }) => {
    try {
      // Pi Extension API types differ from our internal message types.
      // Both sides define the same shape but TypeScript can't verify across packages.
      // If Pi's message format changes, compressContext will gracefully fail via the catch below.
      const msgs = event.messages as unknown as CompressorMessage[];
      const result = compressContext(msgs, config, store, ctx.getContextUsage() as unknown as CompressorContextUsage, frozenFreshState);
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

  pi.on("session_tree", async () => {
    // 切换分支后，cumulativeStats 将在下次 context 事件时自然更新
  });

  pi.registerTool({
    name: "recall_context",
    label: "Recall Compressed Context",
    description: "Recall original content compressed by context engineering. Use when you need the full content of an expired, truncated, or condensed tool result.",
    promptSnippet: "recall_context(id) — retrieve original content compressed by context engineering",
    parameters: RecallParams,
    execute: async (_tcId: string, params: { id: string }, _sig: unknown, _upd: unknown, _ctx: unknown) => recallResult(params.id, store),
  });

  pi.registerCommand("context-engineering", {
    description: "View/modify context compression settings",
    getArgumentCompletions(prefix: string) {
      const parts = prefix.trimStart().split(/\s+/).filter(Boolean);
      // 第一级：target 选择
      if (parts.length <= 1) {
        const trimmed = (parts[0] ?? "").toLowerCase();
        const targets = [
          { label: "global", value: "global ", description: "整个插件开关" },
          { label: "mc", value: "mc ", description: "微压缩（microcompact）" },
          { label: "budget", value: "budget ", description: "工具结果预算" },
          { label: "l0", value: "l0 ", description: "零成本清理" },
          { label: "l1", value: "l1 ", description: "规则压缩" },
          { label: "l2", value: "l2 ", description: "紧急压缩" },
        ];
        return trimmed === "" ? targets : targets.filter((t) => t.label.startsWith(trimmed));
      }
      // 第二级：on/off（仅当 parts[0] 是合法 target 时）
      const validTargets = ["global", "l0", "l1", "l2", "mc", "budget"];
      if (validTargets.includes(parts[0]!.toLowerCase())) {
        const trimmed = (parts[1] ?? "").toLowerCase();
        const actions = [
          { label: "on", value: "on", description: "开启" },
          { label: "off", value: "off", description: "关闭" },
        ];
        return trimmed === "" ? actions : actions.filter((a) => a.label.startsWith(trimmed));
      }
      return null;
    },
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
