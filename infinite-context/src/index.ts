import type { ExtensionAPI, ExtensionContext, ContextEvent } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Text } from "@mariozechner/pi-tui";

import { SegmentTracker } from "./segment-tracker";
import { TreeCompactor } from "./tree-compactor";
import { ContextAssembler, type MinimalAgentMessage, type AssembleResult, IC_SUMMARY_CUSTOM_TYPE, IC_RECALL_PROMPT_TYPE } from "./context-handler";
import { RecallTool } from "./recall-tool";
import { registerTreeCompactCommand, registerContextStatusCommand } from "./commands";
import { compressAsync } from "./compression-runner";
import { IC_COMPACT_START_TYPE, IC_COMPACT_END_TYPE, IC_CONFIG } from "./types";

const recallTool = new RecallTool();

// -- Named event handlers -----------------------------------------------------

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
	compactor: TreeCompactor,
	assembler: ContextAssembler,
	needsCompressionRef: { value: boolean },
) {
	return (event: { turnIndex: number; message: unknown; toolResults: unknown[] }, ctx: ExtensionContext) => {
		try {
			tracker.handleTurnEnd(pi, ctx, event.turnIndex, event.message, event.toolResults);

			if (needsCompressionRef.value) {
				needsCompressionRef.value = false;
				void compressAsync(pi, ctx, tracker.getSegments(), compactor);
			}
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
	needsCompressionRef: { value: boolean },
) {
	return (event: ContextEvent, ctx: ExtensionContext) => {
		try {
			tracker.syncFromMessages(pi, ctx, event.messages);

			const segments = tracker.getSegments();
			const retentionWindow = tracker.getRetentionWindow();
			const tree = compactor.getTree();

			const contextUsage = ctx.getContextUsage();
			const contextWindow = contextUsage?.contextWindow ?? IC_CONFIG.defaultContextWindow;

			const result: AssembleResult = assembler.assembleMessages(
				event.messages as unknown as MinimalAgentMessage[],
				tree, segments, retentionWindow,
				contextWindow,
			);

			if (contextUsage) {
				needsCompressionRef.value = assembler.shouldCompress(result.treeContextTokens, contextUsage.contextWindow);
			}

			return { messages: result.messages as ContextEvent["messages"] };
		} catch (err) {
			console.error("[infinite-context] context error:", err);
			return undefined;
		}
	};
}

// ── Renderers ──────────────────────────────────────────

function registerRenderers(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(IC_SUMMARY_CUSTOM_TYPE, (message, _options, theme) => {
		const c = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		return new Text(theme.fg("accent", "[IC] ") + theme.fg("dim", c), 0, 0) as unknown as Component;
	});
	pi.registerMessageRenderer(IC_RECALL_PROMPT_TYPE, (message, _options, theme) => {
		const c = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		return new Text(theme.fg("warning", "[IC Recall] ") + theme.fg("dim", c), 0, 0) as unknown as Component;
	});
	pi.registerMessageRenderer(IC_COMPACT_START_TYPE, (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		return new Text(theme.fg("warning", "\u23F3 ") + theme.fg("toolTitle", "IC Tree Compact") + theme.fg("dim", ` ${content}`), 0, 0) as unknown as Component;
	});
	pi.registerMessageRenderer(IC_COMPACT_END_TYPE, (message, _options, theme) => {
		const details = message.details as { fallbackUsed?: boolean; errorReason?: string } | undefined;
		const content = typeof message.content === "string" ? message.content : "";
		const icon = details?.fallbackUsed ? "\u26A0\uFE0F" : "\u2705";
		return new Text(theme.fg(details?.fallbackUsed ? "error" : "success", `${icon} `) + theme.fg("toolTitle", "IC Tree Compact") + theme.fg("dim", ` ${content}`), 0, 0) as unknown as Component;
	});
}

// ── session_before_compact handler ─────────────────────────

function createBeforeCompactHandler(_tracker: SegmentTracker, compactor: TreeCompactor) {
	return () => {
		if (compactor.getTree()) {
			return { cancel: true };
		}
		return { cancel: false };
	};
}

// -- Extension Factory -------------------------------------------------------

export default function infiniteContextExtension(pi: ExtensionAPI): void {
	const tracker = new SegmentTracker();
	const compactor = new TreeCompactor();
	const assembler = new ContextAssembler();
	const needsCompression = { value: false };

	pi.on("session_start", createSessionStartHandler(tracker, compactor));
	pi.on("turn_end", createTurnEndHandler(pi, tracker, compactor, assembler, needsCompression));
	pi.on("context", createContextHandler(pi, tracker, compactor, assembler, needsCompression));
	pi.on("session_before_compact", createBeforeCompactHandler(tracker, compactor));

	registerTreeCompactCommand(pi, compactor, tracker);
	registerContextStatusCommand(pi, assembler, compactor, tracker);
	recallTool.register(pi, compactor);
	registerRenderers(pi);
}
