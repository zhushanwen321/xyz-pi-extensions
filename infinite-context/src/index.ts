/**
 * Pi infinite-context Extension -- Tree-structured context compression
 *
 * Features:
 * - Segment tracking (SegmentTracker): split conversation by user message boundaries
 * - Token estimation (TokenEstimator): chars/4 heuristic
 * - Tree compression (TreeCompactor): compress history segments into tree summaries
 * - Context assembly (ContextAssembler): reassemble messages before each LLM call
 * - Auto context management: trigger compression when approaching context window limit
 * - Replace Pi's native compaction with tree compression
 *
 * Commands:
 * - /tree-compact -- manually trigger tree compression
 * - /context-status -- display context usage status
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { SegmentTracker } from "./segment-tracker";
import { TreeCompactor, type CompactResult } from "./tree-compactor";
import { ContextAssembler, type AssembleResult, type MinimalAgentMessage, IC_SUMMARY_CUSTOM_TYPE, IC_RECALL_PROMPT_TYPE } from "./context-handler";
import { RecallTool } from "./recall-tool";
import {
	registerTreeCompactCommand,
	registerContextStatusCommand,
} from "./commands";

// -- RecallTool instance ---------------------------------------------------

const recallTool = new RecallTool();

// -- Extension Factory -------------------------------------------------------

export default function infiniteContextExtension(pi: ExtensionAPI): void {
	// -- Closure state --------------------------------------------------------
	const tracker = new SegmentTracker();
	const compactor = new TreeCompactor();
	const assembler = new ContextAssembler();
	let needsCompression = false;

	// -- Event: session_start (state restoration) -----------------------------
	pi.on("session_start", (_event, ctx) => {
		try {
			const entries = ctx.sessionManager.getEntries();
			tracker.restoreState(entries);
			compactor.restoreState(entries);
		} catch (err) {
			console.error("[infinite-context] session_start error:", err);
		}
	});

	// -- Event: turn_end (segment tracking + compression trigger) ------------
	pi.on("turn_end", (event, ctx) => {
		try {
			tracker.handleTurnEnd(
				pi,
				ctx,
				event.turnIndex,
				event.message,
				event.toolResults,
			);

			// Check if compression is needed (flagged in previous context event)
			if (!compactor.isCompressing() && needsCompression) {
				needsCompression = false;
				const segments = tracker.getSegments();
				compactor.triggerCompression(
					pi,
					ctx,
					segments,
					compactor.getTree(),
					(result: CompactResult) => {
						if (!ctx.hasUI) return;
						if (result.fallbackUsed) {
							ctx.ui.notify("Tree compression degraded: using rule-based fallback instead of LLM compression");
						} else {
							const tree = result.tree;
							ctx.ui.notify(
								`Tree compression complete: ${tree.totalTokens} tokens, `
								+ `${tree.root.children.length} top-level groups, `
								+ `depth ${tree.depth}`,
							);
						}
					},
				);
			}
		} catch (err) {
			console.error("[infinite-context] turn_end error:", err);
		}
	});

	// -- Event: context (reassemble messages) ---------------------------------
	pi.on("context", (event, ctx) => {
		try {
			const segments = tracker.getSegments();
			const retentionWindow = tracker.getRetentionWindow();
			const tree = compactor.getTree();

			const result: AssembleResult = assembler.assembleMessages(
				event.messages as unknown as MinimalAgentMessage[],
				tree,
				segments,
				retentionWindow,
			);

			// Update compression flag (will trigger on next turn_end)
			const contextUsage = ctx.getContextUsage();
			if (contextUsage) {
				const limit = contextUsage.contextWindow;
				needsCompression = assembler.shouldCompress(result.treeContextTokens, limit);
			}

			// result.messages is MinimalAgentMessage[], structurally compatible with AgentMessage
			return { messages: result.messages as typeof event.messages };
		} catch (err) {
			console.error("[infinite-context] context error:", err);
			return undefined;
		}
	});

	// -- Event: session_before_compact (cancel Pi native compaction) ----------
	pi.on("session_before_compact", (_event, _ctx) => {
		try {
			return compactor.cancelPiCompaction();
		} catch (err) {
			console.error("[infinite-context] session_before_compact error:", err);
			return { cancel: false };
		}
	});

	// -- Command registration -------------------------------------------------

	registerTreeCompactCommand(pi, compactor, tracker);
	registerContextStatusCommand(pi, assembler, compactor, tracker);

	// -- Tool registration: recall --------------------------------------------

	recallTool.register(pi);

	// -- Message renderer registration ----------------------------------------

	// ic-summary: tree node summaries
	pi.registerMessageRenderer(IC_SUMMARY_CUSTOM_TYPE, (message, _options, theme) => {
		const content = typeof message.content === "string"
			? message.content
			: JSON.stringify(message.content);
		return new Text(
			theme.fg("accent", "[IC] ")
			+ theme.fg("dim", content),
			0, 0,
		);
	});

	// ic-recall-prompt: recall usage prompt
	pi.registerMessageRenderer(IC_RECALL_PROMPT_TYPE, (message, _options, theme) => {
		const content = typeof message.content === "string"
			? message.content
			: JSON.stringify(message.content);
		return new Text(
			theme.fg("warning", "[IC Recall] ")
			+ theme.fg("dim", content),
			0, 0,
		);
	});
}
