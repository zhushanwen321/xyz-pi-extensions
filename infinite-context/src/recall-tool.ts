/**
 * Recall Tool — 检索被压缩的历史对话内容
 *
 * 职责：
 * - 在压缩树中递归搜索 nodeId
 * - mode=structure: 返回子树结构描述（不含原始内容）
 * - mode=content: 返回原始段文件内容
 * - 通过 register() 注册为 Pi 工具
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry, CustomEntry } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import type { TreeNode, CompactTree } from "./types";

// ── 类型 ──────────────────────────────────────────────

/** Recall 工具返回的 details 结构 */
export interface RecallDetails {
	nodeId: string;
	mode: "structure" | "content";
	found: boolean;
}

/** recall 工具的参数 schema */
const RecallParams = Type.Object({
	nodeId: Type.String({ description: "树节点 ID（如 g0, seg_0）" }),
	mode: StringEnum(["structure", "content"], {
		description: "'structure' 查看子树结构，'content' 获取原始内容",
		default: "structure",
	}),
});

// ── helpers ───────────────────────────────────────────

/** 在树中递归搜索 nodeId */
const MAX_FIND_DEPTH = 20;
function findNode(node: TreeNode, nodeId: string, depth = 0): TreeNode | undefined {
	if (depth > MAX_FIND_DEPTH) return undefined;
	if (node.nodeId === nodeId) return node;
	for (const child of node.children) {
		const found = findNode(child, nodeId, depth + 1);
		if (found) return found;
	}
	return undefined;
}

/** 收集节点及其子孙的所有 segId */
const MAX_COLLECT_DEPTH = 20;
function collectSegIds(node: TreeNode): string[] {
	const result: string[] = [];
	function walk(n: TreeNode, depth: number): void {
		if (depth > MAX_COLLECT_DEPTH) return;
		if (n.segId) {
			result.push(n.segId);
		}
		for (const child of n.children) {
			walk(child, depth + 1);
		}
	}
	walk(node, 0);
	return result;
}

/** 从 segId 提取段索引数字（seg_0 → 0, seg_12 → 12） */
function segIndexFromId(segId: string): number | undefined {
	const match = segId.match(/^seg_(\d+)$/);
	if (!match) return undefined;
	return parseInt(match[1], 10);
}

/** 构建子树结构描述文本 */
const MAX_FORMAT_DEPTH = 20;
function formatStructure(node: TreeNode, indent: number, depth = 0): string {
	if (depth > MAX_FORMAT_DEPTH) return "";
	const prefix = "  ".repeat(indent);
	const leafMarker = node.segId ? ` [leaf: ${node.segId}]` : " [group]";
	const tokenInfo = ` (${node.tokenCount} tokens)`;

	let result = `${prefix}- ${node.nodeId}: ${node.summary}${leafMarker}${tokenInfo}\n`;

	if (node.children.length > 0) {
		for (const child of node.children) {
			result += formatStructure(child, indent + 1, depth + 1);
		}
	}

	return result;
}

/** 读取段文件的 JSON 内容 */
function readSegmentFile(
	sessionId: string,
	segId: string,
	ctx: ExtensionContext,
): string | undefined {
	const segIndex = segIndexFromId(segId);
	if (segIndex === undefined) return undefined;

	// 路径必须与 segment-tracker.ts 的 writeSegmentFile 一致:
	// ctx.cwd/.pi/infinite-context/<sessionId>/seg_N.json
	const segPath = join(
		ctx.cwd,
		".pi",
		"infinite-context",
		sessionId,
		`seg_${segIndex}.json`,
	);

	if (!existsSync(segPath)) return undefined;

	try {
		const raw = readFileSync(segPath, "utf-8");
		return raw;
	} catch {
		return undefined;
	}
}

/** 从 session entries 恢复最新的压缩树 */
function loadTreeFromEntries(ctx: ExtensionContext): CompactTree | undefined {
	const entries: SessionEntry[] = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (
			entry.type === "custom"
			&& (entry as CustomEntry).customType === "ic-compact-tree"
		) {
			return (entry as CustomEntry<CompactTree>).data;
		}
	}
	return undefined;
}

// ── RecallTool ────────────────────────────────────────

export class RecallTool {
	/**
	 * 执行 recall 查询
	 *
	 * @param nodeId    - 目标节点 ID
	 * @param mode      - "structure" 或 "content"
	 * @param tree      - 当前压缩树
	 * @param sessionId - 当前 session ID
	 * @param ctx       - Pi ExtensionContext（用于构建文件路径）
	 */
	executeRecall(
		nodeId: string,
		mode: "structure" | "content",
		tree: CompactTree | undefined,
		sessionId: string,
		ctx: ExtensionContext,
	): { content: Array<{ type: "text"; text: string }>; details: RecallDetails } {
		// 树不存在 → 无法 recall
		if (!tree) {
			return {
				content: [{
					type: "text" as const,
					text: "无可用的压缩树。尚未进行任何压缩操作。",
				}],
				details: { nodeId, mode, found: false },
			};
		}

		// 在树中搜索节点
		const node = findNode(tree.root, nodeId);

		if (!node) {
			return {
				content: [{
					type: "text" as const,
					text: `未找到节点 "${nodeId}"。使用 /context-status 查看可用节点。`,
				}],
				details: { nodeId, mode, found: false },
			};
		}

		// 根据模式执行不同逻辑
		if (mode === "structure") {
			return recallStructure(node, nodeId, mode);
		}
		return recallContent(node, nodeId, mode, sessionId, ctx);
	}

	/**
	 * 注册 recall 工具到 Pi
	 */
	register(pi: ExtensionAPI): void {
		// 捕获 this 以便在闭包中使用
		const self = this;

		pi.registerTool({
			name: "recall",
			label: "Recall",
			description:
				"检索被压缩的历史对话内容。两次调用模式: "
				+ "先用 structure 查看子树，再用 content 获取原始内容。",
			promptSnippet: "recall(nodeId, mode) - 检索被压缩的历史内容",
			parameters: RecallParams,

			async execute(
				_toolCallId: string,
				params: { nodeId: string; mode: "structure" | "content" },
				_signal: AbortSignal | undefined,
				_onUpdate: unknown,
				ctx: ExtensionContext,
			): Promise<{ content: Array<{ type: "text"; text: string }>; details: RecallDetails }> {
				const sessionId = ctx.sessionManager.getSessionId();
				const tree = loadTreeFromEntries(ctx);
				return self.executeRecall(params.nodeId, params.mode, tree, sessionId, ctx);
			},

			renderCall(args, theme) {
				return new Text(
					theme.fg("toolTitle", theme.bold("recall "))
					+ theme.fg("muted", args.nodeId)
					+ theme.fg("dim", ` (${args.mode})`),
					0, 0,
				);
			},

			renderResult(result, _options, theme) {
				const textEntry = result.content[0];
				const content = textEntry?.type === "text" && textEntry.text ? textEntry.text : "";
				const status = result.details.found ? "✓" : "✗";
				const header = theme.fg(
					result.details.found ? "success" : "error",
					`[${status}]`,
				);

				// 截断过长的内容显示
				const maxLen = 200;
				const display = content.length > maxLen
					? content.slice(0, maxLen) + "..."
					: content;

				return new Text(
					header + " " + theme.fg("dim", display),
					0, 0,
				);
			},
		});
	}
}

// ── 内部函数 ──────────────────────────────────────────

/** Structure 模式：返回子树结构描述（不含原始内容） */
function recallStructure(
	node: TreeNode,
	nodeId: string,
	mode: "structure",
): { content: Array<{ type: "text"; text: string }>; details: RecallDetails } {
	const structureText = formatStructure(node, 0);
	const header = `子树结构 [${nodeId}]:\n`;

	return {
		content: [{
			type: "text" as const,
			text: header + structureText.trimEnd(),
		}],
		details: { nodeId, mode, found: true },
	};
}

/** Content 模式：返回原始段文件内容 */
function recallContent(
	node: TreeNode,
	nodeId: string,
	mode: "content",
	sessionId: string,
	ctx: ExtensionContext,
): { content: Array<{ type: "text"; text: string }>; details: RecallDetails } {
	const segIds = collectSegIds(node);

	if (segIds.length === 0) {
		return {
			content: [{
				type: "text" as const,
				text: `节点 "${nodeId}" 无关联的段内容。`,
			}],
			details: { nodeId, mode, found: true },
		};
	}

	// 读取所有段文件内容
	const parts: string[] = [];
	for (const segId of segIds) {
		const raw = readSegmentFile(sessionId, segId, ctx);
		if (raw !== undefined) {
			parts.push(`--- ${segId} ---\n${raw}`);
		} else {
			parts.push(`--- ${segId} ---\n(段文件不存在或无法读取)`);
		}
	}

	if (parts.length === 0) {
		return {
			content: [{
				type: "text" as const,
				text: "无内容",
			}],
			details: { nodeId, mode, found: true },
		};
	}

	return {
		content: [{
			type: "text" as const,
			text: parts.join("\n\n"),
		}],
		details: { nodeId, mode, found: true },
	};
}
