import type { ExtensionAPI, ExtensionContext, ContextEvent, SessionBeforeCompactEvent } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { SegmentTracker } from "./segment-tracker";
import { TreeCompactor, type CompactResult } from "./tree-compactor";
import type { CompactTree } from "./types";
import { ContextAssembler, type MinimalAgentMessage, type AssembleResult, IC_SUMMARY_CUSTOM_TYPE, IC_RECALL_PROMPT_TYPE } from "./context-handler";
import { RecallTool } from "./recall-tool";
import { registerTreeCompactCommand, registerContextStatusCommand } from "./commands";

const recallTool = new RecallTool();

// -- Named event handlers (extracted for readability) -------------------------

function createSessionStartHandler(tracker: SegmentTracker, compactor: TreeCompactor) {
	return (_event: unknown, ctx: ExtensionContext) => {
		try {
			const entries = ctx.sessionManager.getEntries();
			tracker.restoreState(entries);
			compactor.restoreState(entries);
		} catch (err) {
			console.error("[infinite-context] session_start error:", err);
		}
	};
}

function createTurnEndHandler(
	pi: ExtensionAPI,
	tracker: SegmentTracker,
	_compactor: TreeCompactor,
	_assembler: ContextAssembler,
) {
	return (event: { turnIndex: number; message: unknown; toolResults: unknown[] }, ctx: ExtensionContext) => {
		try {
			tracker.handleTurnEnd(pi, ctx, event.turnIndex, event.message, event.toolResults);
		} catch (err) {
			console.error("[infinite-context] turn_end error:", err);
		}
	};
}

function createContextHandler(
	pi: ExtensionAPI,
	tracker: SegmentTracker,
	compactor: TreeCompactor,
	assembler: ContextAssembler,
) {
	return (event: ContextEvent, ctx: ExtensionContext) => {
		try {
			const segments = tracker.getSegments();
			const tree = compactor.getTree();

			const contextUsage = ctx.getContextUsage();
			const contextWindow = contextUsage?.contextWindow ?? 200_000;
			const usagePercent = contextUsage?.percent ?? 50;
			const retentionWindow = tracker.getRetentionWindow(usagePercent);

			const result: AssembleResult = assembler.assembleMessages(
				event.messages as unknown as MinimalAgentMessage[],
				tree, segments, retentionWindow,
				compactor.getCompressedSegIds(),
				contextWindow,
			);

			return { messages: result.messages as ContextEvent["messages"] };
		} catch (err) {
			console.error("[infinite-context] context error:", err);
			return undefined;
		}
	};
}

function registerRenderers(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(IC_SUMMARY_CUSTOM_TYPE, (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		return new Text(theme.fg("accent", "[IC] ") + theme.fg("dim", content), 0, 0);
	});

	pi.registerMessageRenderer(IC_RECALL_PROMPT_TYPE, (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		return new Text(theme.fg("warning", "[IC Recall] ") + theme.fg("dim", content), 0, 0);
	});
}

// ── Tree summary builder ────────────────────────────────────────────────

function buildTreeSummary(tree: CompactTree): string {
	if (!tree.root.children.length) {
		return `[IC Tree Compact] empty tree (0 groups)`;
	}
	const groupSummaries = tree.root.children.map((group) => {
		const leafCount = group.children.length;
		return `- ${group.summary} (${leafCount} segments)`;
	}).join("\n");
	return `[IC Tree Compact] ${tree.root.children.length} groups, ${tree.totalTokens} tokens, depth ${tree.depth}\n${groupSummaries}`;
}

// ── session_before_compact handler ─────────────────────────────────────

function createBeforeCompactHandler(
	pi: ExtensionAPI,
	tracker: SegmentTracker,
	compactor: TreeCompactor,
) {
	return async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		const segments = tracker.getSegments();

		// Not enough segments for meaningful tree compression → let Pi handle
		if (segments.length < 3) {
			return { cancel: false };
		}

		try {
			// Wrap callback-based triggerCompression into a Promise
			const contextUsage = ctx.getContextUsage();
			const usagePercent = contextUsage?.percent ?? 50;
			const result: CompactResult = await new Promise((resolve, reject) => {
				compactor.triggerCompression(
					pi, ctx, segments, compactor.getTree(),
					usagePercent,
					(r) => resolve(r),
				);
				// triggerCompression is fire-and-forget with callback.
				// It guards against re-entry (isCompressing), so if already
				// compressing the callback won't fire. Set a timeout to avoid
				// hanging the handler indefinitely.
				setTimeout(() => reject(new Error("tree-compact timeout")), 120_000);
			});

			// If fallback was used, let Pi do native compact
			if (result.fallbackUsed) {
				return { cancel: false };
			}

			// Build text summary from tree for Pi's compaction entry
			const summary = buildTreeSummary(result.tree);

			return {
				compaction: {
					summary,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				},
			};
		} catch (err) {
			console.error("[infinite-context] before_compact compression error:", err);
			return { cancel: false };
		}
	};
}

// -- Extension Factory -------------------------------------------------------

export default function infiniteContextExtension(pi: ExtensionAPI): void {
	const tracker = new SegmentTracker();
	const compactor = new TreeCompactor();
	const assembler = new ContextAssembler();

	// Event handlers
	pi.on("session_start", createSessionStartHandler(tracker, compactor));
	pi.on("turn_end", createTurnEndHandler(pi, tracker, compactor, assembler));
	pi.on("context", createContextHandler(pi, tracker, compactor, assembler));
	pi.on("session_before_compact", createBeforeCompactHandler(pi, tracker, compactor));

	// Commands + tools + renderers
	registerTreeCompactCommand(pi, compactor, tracker);
	registerContextStatusCommand(pi, assembler, compactor, tracker);
	recallTool.register(pi);
	registerRenderers(pi);
}
