/**
 * Recall Tool — 检索被压缩的历史对话内容
 *
 * 职责：
 * - 在压缩树中递归搜索 nodeId
 * - mode=structure: 返回子树结构描述（不含原始内容）
 * - mode=content: 返回原始段文件内容
 * - 通过 register(pi, compactor) 注册为 Pi 工具
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import type { TreeNode, CompactTree } from "./types";
import type { TreeCompactor } from "./tree-compactor";
import { getDataDir } from "./types";

// ── 类型 ──────────────────────────────────────────────

export interface RecallDetails {
	nodeId: string;
	mode: "structure" | "content";
	found: boolean;
}

const RecallParams = Type.Object({
	nodeId: Type.String({ description: "树节点 ID（如 g0, seg_0）" }),
	mode: StringEnum(["structure", "content"], {
		description: "'structure' 查看子树结构，'content' 获取原始内容",
		default: "structure",
	}),
});

// ── helpers ───────────────────────────────────────────

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

function collectSegIds(node: TreeNode): string[] {
	const result: string[] = [];
	function walk(n: TreeNode, depth: number): void {
		if (depth > 20) return;
		if (n.segId) result.push(n.segId);
		for (const child of n.children) walk(child, depth + 1);
	}
	walk(node, 0);
	return result;
}

function segIndexFromId(segId: string): number | undefined {
	const match = segId.match(/^seg_(\d+)$/);
	if (!match) return undefined;
	return parseInt(match[1], 10);
}

function formatStructure(node: TreeNode, indent: number, depth = 0): string {
	if (depth > 20) return "";
	const prefix = "  ".repeat(indent);
	const leafMarker = node.segId ? ` [leaf: ${node.segId}]` : " [group]";
	const tokenInfo = ` (${node.tokenCount} tokens)`;
	let result = `${prefix}- ${node.nodeId}: ${node.summary}${leafMarker}${tokenInfo}\n`;
	for (const child of node.children) {
		result += formatStructure(child, indent + 1, depth + 1);
	}
	return result;
}

function readSegmentFile(sessionId: string, segId: string): string | undefined {
	const segIndex = segIndexFromId(segId);
	if (segIndex === undefined) return undefined;
	const segPath = join(getDataDir(), sessionId, `seg_${segIndex}.json`);
	if (!existsSync(segPath)) return undefined;
	try {
		return readFileSync(segPath, "utf-8");
	} catch {
		return undefined;
	}
}

function recallStructure(
	node: TreeNode,
	nodeId: string,
): { content: Array<{ type: "text"; text: string }>; details: RecallDetails } {
	const structureText = formatStructure(node, 0);
	return {
		content: [{ type: "text" as const, text: `子树结构 [${nodeId}]:\n${structureText.trimEnd()}` }],
		details: { nodeId, mode: "structure", found: true },
	};
}

function recallContent(
	node: TreeNode,
	nodeId: string,
	sessionId: string,
): { content: Array<{ type: "text"; text: string }>; details: RecallDetails } {
	const segIds = collectSegIds(node);
	if (segIds.length === 0) {
		return {
			content: [{ type: "text" as const, text: `节点 "${nodeId}" 无关联的段内容。` }],
			details: { nodeId, mode: "content", found: true },
		};
	}
	const parts: string[] = [];
	for (const segId of segIds) {
		const raw = readSegmentFile(sessionId, segId);
		parts.push(raw !== undefined ? `--- ${segId} ---\n${raw}` : `--- ${segId} ---\n(段文件不存在)`);
	}
	return {
		content: [{ type: "text" as const, text: parts.join("\n\n") }],
		details: { nodeId, mode: "content", found: true },
	};
}

type RecallExecuteResult = Promise<{ content: Array<{ type: "text"; text: string }>; details: RecallDetails }>;

	// ── RecallTool ────────────────────────────────────────

export class RecallTool {
	private compactor: TreeCompactor | undefined;

	/**
	 * 注册 recall 工具，绑定 compactor 实例
	 */
	register(pi: ExtensionAPI, compactor: TreeCompactor): void {
		this.compactor = compactor;

		pi.registerTool({
			name: "recall",
			label: "Recall",
			description: "检索被压缩的历史对话内容。两次调用模式: 先用 structure 查看子树，再用 content 获取原始内容。",
			promptSnippet: "recall(nodeId, mode) - 检索被压缩的历史内容",
			parameters: RecallParams,

			execute: async (
				_toolCallId: string,
				params: { nodeId: string; mode: "structure" | "content" },
				_signal: unknown,
				_onUpdate: unknown,
				ctx: ExtensionContext,
			): RecallExecuteResult => {
				const sessionId = ctx.sessionManager.getSessionId();
				const tree = this.compactor?.getTree();
				return this.executeRecall(params.nodeId, params.mode, tree, sessionId);
			},

			renderCall(args, theme) {
				return new Text(theme.fg("toolTitle", theme.bold("recall ")) + theme.fg("muted", args.nodeId) + theme.fg("dim", ` (${args.mode})`), 0, 0);
			},

			renderResult(result, _options, theme) {
				const textEntry = result.content[0];
				const content = textEntry?.type === "text" && textEntry.text ? textEntry.text : "";
				const status = result.details.found ? "\u2713" : "\u2717";
				const header = theme.fg(result.details.found ? "success" : "error", `[${status}]`);
				const maxLen = 200;
				const display = content.length > maxLen ? content.slice(0, maxLen) + "..." : content;
				return new Text(header + " " + theme.fg("dim", display), 0, 0);
			},
		});
	}

	executeRecall(
		nodeId: string,
		mode: "structure" | "content",
		tree: CompactTree | undefined,
		sessionId: string,
	): { content: Array<{ type: "text"; text: string }>; details: RecallDetails } {
		if (!tree) {
			return {
				content: [{ type: "text" as const, text: "无可用的压缩树。尚未进行任何压缩操作。" }],
				details: { nodeId, mode, found: false },
			};
		}

		const node = findNode(tree.root, nodeId);
		if (!node) {
			return {
				content: [{ type: "text" as const, text: `未找到节点 "${nodeId}"。使用 /context-status 查看可用节点。` }],
				details: { nodeId, mode, found: false },
			};
		}

		if (mode === "structure") {
			return recallStructure(node, nodeId);
		}
		return recallContent(node, nodeId, sessionId);
	}
}
