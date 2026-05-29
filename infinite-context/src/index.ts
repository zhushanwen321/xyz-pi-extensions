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
				compactor.triggerCompression(pi, ctx, segments, compactor.getTree(), onCompleteFactory(ctx));
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
			const reason = result.errorReason ? `: ${result.errorReason}` : "";
			ctx.ui.notify(`[IC] 树压缩降级，使用规则分组${reason}`);
		} else {
			const tree = result.tree;
			ctx.ui.notify(
				`[IC] 树压缩完成: ${tree.totalTokens} tokens, `
				+ `${tree.root.children.length} 分组, 深度 ${tree.depth}`,
			);
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
			// 检测新 user message，创建段
			tracker.syncFromMessages(pi, ctx, event.messages);

			const segments = tracker.getSegments();
			const retentionWindow = tracker.getRetentionWindow();
			const tree = compactor.getTree();

			const contextUsage = ctx.getContextUsage();
			const contextWindow = contextUsage?.contextWindow ?? 200_000;

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

// ── session_before_compact handler ─────────────────────────

/**
 * 段数 >= 3 时由树压缩接管，取消原生 compact
 * 段数 < 3 时放行原生 compact（树压缩无法工作）
 */
function createBeforeCompactHandler(tracker: SegmentTracker) {
	return () => {
		const segments = tracker.getSegments();
		if (segments.length >= 1) {
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

	// Event handlers
	pi.on("session_start", createSessionStartHandler(tracker, compactor));
	pi.on("turn_end", createTurnEndHandler(pi, tracker, compactor, assembler, needsCompression));
	pi.on("context", createContextHandler(pi, tracker, compactor, assembler, needsCompression));
	pi.on("session_before_compact", createBeforeCompactHandler(tracker));

	// Commands + tools + renderers
	registerTreeCompactCommand(pi, compactor, tracker);
	registerContextStatusCommand(pi, assembler, compactor, tracker);
	recallTool.register(pi);
	registerRenderers(pi);
}
