/**
 * Infinite Context Engine — 命令注册
 *
 * 提供 /tree-compact 和 /context-status 两个命令。
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { SegmentTracker } from "./segment-tracker";
import type { TreeCompactor, CompactResult } from "./tree-compactor";
import type { ContextAssembler } from "./context-handler";
import { estimateTokens } from "./token-estimator";

/** 与 index.ts 中的常量保持同步 */
const IC_COMPACT_START_TYPE = "ic-compact-start";
const IC_COMPACT_END_TYPE = "ic-compact-end";
const IC_COMPACT_STATS_TYPE = "ic-compact-stats";

// ── /tree-compact ─────────────────────────────────────

/**
 * 注册 /tree-compact 命令
 *
 * 手动触发树压缩，适用于用户发现上下文膨胀时主动压缩。
 */
export function registerTreeCompactCommand(
	pi: ExtensionAPI,
	compactor: TreeCompactor,
	tracker: SegmentTracker,
): void {
	pi.registerCommand("tree-compact", {
		description: "手动触发树压缩（将历史段压缩为摘要树）",
		handler: async (_args, ctx) => {
			if (compactor.isCompressing()) {
				ctx.ui.notify("树压缩正在进行中，请稍候...");
				return;
			}

			const segments = tracker.getSegments();
			if (segments.length < 1) {
				// 段数为 0，尝试从 session entries 补建
				const entries = ctx.sessionManager.getEntries();
				const created = tracker.syncFromEntries(pi, ctx, entries);
				if (created > 0) {
					ctx.ui.notify(`从历史对话中补建了 ${created} 个段`);
				}
			}

			const allSegments = tracker.getSegments();
			if (allSegments.length < 1) {
				ctx.ui.notify("当前无对话内容可压缩。");
				return;
			}

			const completedCount = allSegments.filter((s) => s.completed).length;
			const activeCount = allSegments.filter((s) => !s.completed).length;
			const totalCount = completedCount + activeCount;

			// 记录压缩前上下文
			const contextUsage = ctx.getContextUsage();
			const tokensBefore = contextUsage?.tokens ?? null;
			pi.appendEntry(IC_COMPACT_STATS_TYPE, {
				phase: "before",
				segmentCount: totalCount,
				tokensBefore,
				contextWindow: contextUsage?.contextWindow ?? null,
				timestamp: Date.now(),
			});

			// UI: working spinner + footer + 气泡
			ctx.ui.setWorkingVisible(true);
			ctx.ui.setWorkingMessage(`IC Tree Compact: compressing ${totalCount} segments...`);
			ctx.ui.setStatus("ic-compact", `IC compressing ${totalCount} segments...`);
			const tokenInfo = tokensBefore !== null ? ` (${tokensBefore.toLocaleString()} tokens)` : "";
			pi.sendMessage({ customType: IC_COMPACT_START_TYPE, content: `compressing ${totalCount} segments${tokenInfo}...`, display: true });

			compactor.triggerCompression(
				pi,
				ctx,
				allSegments,
				compactor.getTree(),
				(result: CompactResult) => {
					// 清除 working spinner + footer
					ctx.ui.setWorkingVisible(false);
					ctx.ui.setWorkingMessage(undefined);
					ctx.ui.setStatus("ic-compact", undefined);

					// 记录压缩后统计
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

					if (!ctx.hasUI) return;

					const summary = `${tree.root.children.length} groups, depth ${tree.depth}, ${tree.totalTokens} tokens`;

					pi.sendMessage({
						customType: IC_COMPACT_END_TYPE,
						content: `${summary} | tree: ${tree.totalTokens} tokens`,
						display: true,
						details: { fallbackUsed: result.fallbackUsed, errorReason: result.errorReason },
					});
				},
			);
		},
	});
}

// ── /context-status ───────────────────────────────────

/**
 * 注册 /context-status 命令
 *
 * 显示上下文使用状态，包括：
 * - 原始上下文估算
 * - 树上下文（压缩摘要）估算
 * - 段数量统计
 */
export function registerContextStatusCommand(
	pi: ExtensionAPI,
	assembler: ContextAssembler,
	compactor: TreeCompactor,
	tracker: SegmentTracker,
): void {
	pi.registerCommand("context-status", {
		description: "显示上下文使用状态（原始 vs 树上下文）",
		handler: async (_args, ctx) => {
			const segments = tracker.getSegments();
			const retentionWindow = tracker.getRetentionWindow();
			const tree = compactor.getTree();
			const contextUsage = ctx.getContextUsage();

			const completedSegments = segments.filter((s) => s.completed).length;
			const activeSegments = segments.filter((s) => !s.completed).length;
			const totalSegments = segments.length;

			// 构建状态报告
			const lines: string[] = [];

			// 段统计
			lines.push("── 段统计 ──");
			lines.push(`总段数: ${totalSegments} (已完成: ${completedSegments}, 活跃: ${activeSegments})`);
			lines.push(`保留窗口: ${retentionWindow.length} 个段`);
			lines.push("");

			// 树压缩状态
			lines.push("── 树压缩 ──");
			if (tree) {
				lines.push(`树 ID: ${tree.treeId}`);
				lines.push(`顶层节点: ${tree.root.children.length}`);
				lines.push(`总 tokens: ${tree.totalTokens}`);
				lines.push(`深度: ${tree.depth}`);
				lines.push(`创建时间: ${new Date(tree.createdAt).toLocaleString()}`);
			} else {
				lines.push("尚未压缩");
			}

			if (compactor.isCompressing()) {
				lines.push("状态: 正在压缩中...");
			}
			lines.push("");

			// 上下文使用
			lines.push("── 上下文使用 ──");
			if (contextUsage) {
				const tokens = contextUsage.tokens ?? 0;
				const window = contextUsage.contextWindow;
				const percent = contextUsage.percent ?? Math.round((tokens / window) * 100);
				lines.push(`已使用: ${tokens.toLocaleString()} / ${window.toLocaleString()} tokens (${percent}%)`);

				// 估算树上下文开销
				if (tree) {
					const flatNodes = assembler.bfsFlatten(tree);
					let treeTokens = 0;
					for (const node of flatNodes) {
						treeTokens += estimateTokens(`[${node.nodeId}] ${node.summary}`);
					}
					lines.push(`树摘要: ${treeTokens.toLocaleString()} tokens (${flatNodes.length} 个节点)`);
					lines.push(`非树内容: ${Math.max(0, tokens - treeTokens).toLocaleString()} tokens`);
				}
			} else {
				lines.push("上下文使用信息不可用（当前无活跃 LLM 调用）");
			}

			const report = lines.join("\n");
			// 输出到 TUI
			if (ctx.hasUI) {
				ctx.ui.notify(report);
			}
		},
	});
}
