import type { ExtensionAPI, ExtensionContext, ContextEvent } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { SegmentTracker } from "./segment-tracker";
import { TreeCompactor, type CompactResult } from "./tree-compactor";
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
	compactor: TreeCompactor,
	assembler: ContextAssembler,
	needsCompressionRef: { value: boolean },
) {
	return (event: { turnIndex: number; message: unknown; toolResults: unknown[] }, ctx: ExtensionContext) => {
		try {
			tracker.handleTurnEnd(pi, ctx, event.turnIndex, event.message, event.toolResults);

			if (!compactor.isCompressing() && needsCompressionRef.value) {
				needsCompressionRef.value = false;
				const segments = tracker.getSegments();
				const ctxUsage = ctx.getContextUsage();
				const usagePercent = ctxUsage?.percent ?? 50;
				compactor.triggerCompression(
					pi, ctx, segments, compactor.getTree(),
					usagePercent, onCompleteFactory(ctx),
				);
			}
		} catch (err) {
			console.error("[infinite-context] turn_end error:", err);
		}
	};
}

function onCompleteFactory(ctx: ExtensionContext) {
	return (result: CompactResult) => {
		if (!ctx.hasUI) return;
		if (result.fallbackUsed) {
			ctx.ui.notify("Tree compression degraded: using rule-based fallback");
		} else {
			const tree = result.tree;
			ctx.ui.notify(
				`Tree compression complete: ${tree.totalTokens} tokens, `
				+ `${tree.root.children.length} groups, depth ${tree.depth}`,
			);
		}
	};
}

function createContextHandler(
	tracker: SegmentTracker,
	compactor: TreeCompactor,
	assembler: ContextAssembler,
	needsCompressionRef: { value: boolean },
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

// -- Extension Factory -------------------------------------------------------

export default function infiniteContextExtension(pi: ExtensionAPI): void {
	const tracker = new SegmentTracker();
	const compactor = new TreeCompactor();
	const assembler = new ContextAssembler();
	const needsCompression = { value: false };

	// Event handlers
	pi.on("session_start", createSessionStartHandler(tracker, compactor));
	pi.on("turn_end", createTurnEndHandler(pi, tracker, compactor, assembler, needsCompression));
	pi.on("context", createContextHandler(tracker, compactor, assembler, needsCompression));
	// 只在 tree compactor 有有效压缩树时取消 Pi 原生 compact，否则让原生 compact 正常执行
	pi.on("session_before_compact", () => {
		if (compactor.getTree()) {
			return { cancel: true };
		}
		return undefined;
	});

	// Commands + tools + renderers
	registerTreeCompactCommand(pi, compactor, tracker);
	registerContextStatusCommand(pi, assembler, compactor, tracker);
	recallTool.register(pi);
	registerRenderers(pi);
}
