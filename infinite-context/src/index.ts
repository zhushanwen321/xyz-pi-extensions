import type { ExtensionAPI, ExtensionContext, ContextEvent } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { SegmentTracker } from "./segment-tracker";
import { TreeCompactor, type CompactResult } from "./tree-compactor";
import { ContextAssembler, type MinimalAgentMessage, type AssembleResult, IC_SUMMARY_CUSTOM_TYPE, IC_RECALL_PROMPT_TYPE } from "./context-handler";
import { RecallTool } from "./recall-tool";
import { registerTreeCompactCommand, registerContextStatusCommand } from "./commands";

const recallTool = new RecallTool();

const IC_COMPACT_START_TYPE = "ic-compact-start";
const IC_COMPACT_END_TYPE = "ic-compact-end";
const IC_COMPACT_STATS_TYPE = "ic-compact-stats";

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
				const segments = tracker.getSegments();
				runCompressionSync(pi, ctx, segments, compactor);
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

// ── 同步压缩 + UI ──────────────────────────────────

/** 同步执行压缩，包含完整 UI 反馈和统计记录 */
function runCompressionSync(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	segments: Parameters<TreeCompactor["triggerCompression"]>[1],
	compactor: TreeCompactor,
): CompactResult {
	const segmentCount = segments.length;

	// ── 压缩前：记录 + UI ──
	const contextUsage = ctx.getContextUsage();
	const tokensBefore = contextUsage?.tokens ?? null;

	pi.appendEntry(IC_COMPACT_STATS_TYPE, {
		phase: "before",
		segmentCount,
		tokensBefore,
		contextWindow: contextUsage?.contextWindow ?? null,
		timestamp: Date.now(),
	});

	ctx.ui.setWorkingVisible(true);
	ctx.ui.setWorkingMessage(`IC Tree Compact: compressing ${segmentCount} segments...`);
	ctx.ui.setStatus("ic-compact", `IC compressing ${segmentCount} segments...`);

	const tokenInfo = tokensBefore !== null ? ` (${tokensBefore.toLocaleString()} tokens)` : "";
	pi.sendMessage({
		customType: IC_COMPACT_START_TYPE,
		content: `compressing ${segmentCount} segments${tokenInfo}...`,
		display: true,
	});

	// ── 同步压缩（阻塞） ──
	const result = compactor.triggerCompression(pi, segments, compactor.getTree());

	// ── 压缩后：清除 UI + 记录 + 气泡 ──
	ctx.ui.setWorkingVisible(false);
	ctx.ui.setWorkingMessage(undefined);
	ctx.ui.setStatus("ic-compact", undefined);

	const tree = result.tree;
	pi.appendEntry(IC_COMPACT_STATS_TYPE, {
		phase: "after",
		fallbackUsed: result.fallbackUsed,
		treeGroups: tree.root.children.length,
		treeDepth: tree.depth,
		treeTokens: tree.totalTokens,
		treeId: tree.treeId,
		errorReason: result.errorReason,
		retryCount: result.retryCount,
		timestamp: Date.now(),
	});

	if (ctx.hasUI) {
		const summary = `${tree.root.children.length} groups, depth ${tree.depth}, ${tree.totalTokens} tokens`;
		pi.sendMessage({
			customType: IC_COMPACT_END_TYPE,
			content: `${summary} | tree: ${tree.totalTokens} tokens`,
			display: true,
			details: {
				fallbackUsed: result.fallbackUsed,
				errorReason: result.errorReason,
			},
		});
	}

	return result;
}

// ── Renderers ──────────────────────────────────────────

function registerRenderers(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(IC_SUMMARY_CUSTOM_TYPE, (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		return new Text(theme.fg("accent", "[IC] ") + theme.fg("dim", content), 0, 0);
	});

	pi.registerMessageRenderer(IC_RECALL_PROMPT_TYPE, (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		return new Text(theme.fg("warning", "[IC Recall] ") + theme.fg("dim", content), 0, 0);
	});

	pi.registerMessageRenderer(IC_COMPACT_START_TYPE, (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		return new Text(
			theme.fg("warning", "\u23F3 ") + theme.fg("toolTitle", "IC Tree Compact") + theme.fg("dim", ` ${content}`),
			0, 0,
		);
	});

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

function createBeforeCompactHandler(tracker: SegmentTracker, compactor: TreeCompactor) {
	return () => {
		// 压缩树已存在 → 由树压缩接管，跳过原生 compact
		// 否则 → 放行原生 compact
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
	recallTool.register(pi);
	registerRenderers(pi);
}
