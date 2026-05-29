import type { ExtensionAPI, ExtensionContext, ContextEvent } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { SegmentTracker } from "./segment-tracker";
import { TreeCompactor, type CompactResult } from "./tree-compactor";
import { ContextAssembler, type MinimalAgentMessage, type AssembleResult, IC_SUMMARY_CUSTOM_TYPE, IC_RECALL_PROMPT_TYPE } from "./context-handler";
import { RecallTool } from "./recall-tool";
import { registerTreeCompactCommand, registerContextStatusCommand } from "./commands";

const recallTool = new RecallTool();

/** 压缩状态气泡的 customType */
const IC_COMPACT_START_TYPE = "ic-compact-start";
const IC_COMPACT_END_TYPE = "ic-compact-end";

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
				startCompressionUI(pi, ctx, segments.length);
				compactor.triggerCompression(pi, ctx, segments, compactor.getTree(), onCompleteFactory(pi, ctx));
			}
		} catch (err) {
			console.error("[infinite-context] turn_end error:", err);
		}
	};
}

/** 启动压缩的 UI 反馈：working spinner + footer status + 气泡消息 */
function startCompressionUI(pi: ExtensionAPI, ctx: ExtensionContext, segmentCount: number): void {
	// 1. Working spinner — 模拟 agent 工作状态
	ctx.ui.setWorkingVisible(true);
	ctx.ui.setWorkingMessage(`IC Tree Compact: compressing ${segmentCount} segments...`);

	// 2. Footer status bar
	ctx.ui.setStatus("ic-compact", `IC compressing ${segmentCount} segments...`);

	// 3. 对话流气泡
	pi.sendMessage({
		customType: IC_COMPACT_START_TYPE,
		content: `compressing ${segmentCount} segments...`,
		display: true,
	});
}

/** 清除压缩的 UI 反馈 */
function clearCompressionUI(ctx: ExtensionContext): void {
	ctx.ui.setWorkingVisible(false);
	ctx.ui.setWorkingMessage(undefined);
	ctx.ui.setStatus("ic-compact", undefined);
}

function onCompleteFactory(pi: ExtensionAPI, ctx: ExtensionContext) {
	return (result: CompactResult) => {
		// 清除 working spinner + footer
		clearCompressionUI(ctx);

		if (!ctx.hasUI) return;

		const tree = result.tree;
		const summary = `${tree.root.children.length} groups, depth ${tree.depth}, ${tree.totalTokens} tokens`;

		// 完成气泡
		pi.sendMessage({
			customType: IC_COMPACT_END_TYPE,
			content: summary,
			display: true,
			details: {
				fallbackUsed: result.fallbackUsed,
				errorReason: result.errorReason,
				rawOutputPreview: result.rawOutput?.slice(0, 200),
			},
		});
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
	// 树摘要渲染
	pi.registerMessageRenderer(IC_SUMMARY_CUSTOM_TYPE, (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		return new Text(theme.fg("accent", "[IC] ") + theme.fg("dim", content), 0, 0);
	});

	// Recall 提示渲染
	pi.registerMessageRenderer(IC_RECALL_PROMPT_TYPE, (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		return new Text(theme.fg("warning", "[IC Recall] ") + theme.fg("dim", content), 0, 0);
	});

	// 压缩开始气泡：⏳ IC Tree Compact compressing N segments...
	pi.registerMessageRenderer(IC_COMPACT_START_TYPE, (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		return new Text(
			theme.fg("warning", "\u23F3 ") + theme.fg("toolTitle", "IC Tree Compact") + theme.fg("dim", ` ${content}`),
			0, 0,
		);
	});

	// 压缩完成气泡：✅ 或 ❌
	pi.registerMessageRenderer(IC_COMPACT_END_TYPE, (message, _options, theme) => {
		const details = message.details as { fallbackUsed?: boolean; errorReason?: string } | undefined;
		const content = typeof message.content === "string" ? message.content : "";

		if (details?.fallbackUsed) {
			const reason = details.errorReason ? ` — ${details.errorReason}` : "";
			return new Text(
				theme.fg("error", "\u274C ") + theme.fg("toolTitle", "IC Tree Compact") + theme.fg("dim", ` fallback${reason}`) + theme.fg("muted", ` | ${content}`),
				0, 0,
			);
		}
		return new Text(
			theme.fg("success", "\u2705 ") + theme.fg("toolTitle", "IC Tree Compact") + theme.fg("dim", ` done`) + theme.fg("muted", ` | ${content}`),
			0, 0,
		);
	});
}

// ── session_before_compact handler ─────────────────────────

/**
 * 有段时由树压缩接管，取消原生 compact
 * 无段时放行原生 compact
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
