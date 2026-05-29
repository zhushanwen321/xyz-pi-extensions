/**
 * Compression Runner — 共享的压缩执行 + UI 反馈逻辑
 *
 * index.ts (turn_end 自动触发) 和 commands.ts (/tree-compact 命令) 都使用此模块。
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TreeCompactor, CompactResult } from "./tree-compactor";
import type { Segment } from "./types";
import { IC_COMPACT_START_TYPE, IC_COMPACT_END_TYPE, IC_COMPACT_STATS_TYPE } from "./types";

function beforeCompressionUI(pi: ExtensionAPI, ctx: ExtensionContext, segmentCount: number): { tokensBefore: number | null } {
	const contextUsage = ctx.getContextUsage();
	const tokensBefore = contextUsage?.tokens ?? null;
	pi.appendEntry(IC_COMPACT_STATS_TYPE, {
		phase: "before", segmentCount, tokensBefore,
		contextWindow: contextUsage?.contextWindow ?? null, timestamp: Date.now(),
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
	return { tokensBefore };
}

function afterCompressionUI(pi: ExtensionAPI, ctx: ExtensionContext, result: CompactResult): void {
	ctx.ui.setWorkingVisible(false);
	ctx.ui.setWorkingMessage(undefined);
	ctx.ui.setStatus("ic-compact", undefined);

	const tree = result.tree;
	pi.appendEntry(IC_COMPACT_STATS_TYPE, {
		phase: "after", fallbackUsed: result.fallbackUsed,
		treeGroups: tree.root.children.length, treeDepth: tree.depth,
		treeTokens: tree.totalTokens, treeId: tree.treeId,
		errorReason: result.errorReason, retryCount: result.retryCount,
		timestamp: Date.now(),
	});

	if (ctx.hasUI) {
		const summary = `${tree.root.children.length} groups, depth ${tree.depth}, ${tree.totalTokens} tokens`;
		pi.sendMessage({
			customType: IC_COMPACT_END_TYPE,
			content: `${summary} | tree: ${tree.totalTokens} tokens`,
			display: true,
			details: { fallbackUsed: result.fallbackUsed, errorReason: result.errorReason },
		});
	}
}

/**
 * Async compression — 用于 turn_end 自动触发，fire-and-forget，不阻塞事件循环
 */
export async function compressAsync(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	segments: readonly Segment[],
	compactor: TreeCompactor,
): Promise<void> {
	if (segments.length === 0) return;
	beforeCompressionUI(pi, ctx, segments.length);
	const result = await compactor.triggerCompressionAsync(pi, segments, compactor.getTree());
	afterCompressionUI(pi, ctx, result);
}

/**
 * Sync compression — 用于 /tree-compact 命令，阻塞等待完成
 */
export function compressSync(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	segments: readonly Segment[],
	compactor: TreeCompactor,
): CompactResult {
	if (segments.length === 0) {
		const fallback = { tree: { treeId: "empty", root: { nodeId: "root", summary: "no segments", tokenCount: 0, children: [] }, totalTokens: 0, createdAt: Date.now(), depth: 1 }, fallbackUsed: true, retryCount: 0, errorReason: "No segments" };
		return fallback;
	}
	beforeCompressionUI(pi, ctx, segments.length);
	const result = compactor.triggerCompressionSync(pi, segments, compactor.getTree());
	afterCompressionUI(pi, ctx, result);
	return result;
}
