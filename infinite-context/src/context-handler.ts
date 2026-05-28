/**
 * Context Assembler（上下文组装器）
 *
 * 职责：
 * - 每次 LLM 调用前重组 messages
 * - 将压缩树摘要注入 context（CustomMessage 格式）
 * - 保留窗口管理（当前段 + 最近段保持原文）
 * - 预算感知裁剪（超限时按深度+年龄砍节点）
 * - recall 提示注入
 */

import type { Segment, TreeNode, CompactTree } from "./types";
import { estimateTokens } from "./token-estimator";

// ── 类型 ──────────────────────────────────────────────

/**
 * 最小化 AgentMessage 类型定义
 *
 * Pi 的 AgentMessage 是联合类型（UserMessage | AssistantMessage | ToolResultMessage | CustomMessage | ...）。
 * 此处仅定义本模块需要操作的字段。在 index.ts（扩展入口）中，
 * 会将实际的 Pi AgentMessage 传入，类型安全由调用方保证。
 */
interface MinimalAgentMessage {
	role: string;
	content?: string | ContentPart[];
	customType?: string;
	display?: boolean;
	details?: unknown;
	timestamp?: number;
	[key: string]: unknown;
}

/** 消息内容中的文本/图片部分 */
interface ContentPart {
	type: string;
	text?: string;
	[key: string]: unknown;
}

/** assembleMessages 的返回值 */
export interface AssembleResult {
	/** 组装后的 messages（浅拷贝，不修改原始） */
	messages: MinimalAgentMessage[];
	/** 独立 tree-context 估算值（仅树摘要部分占用） */
	treeContextTokens: number;
	/** 被压缩的节点数量 */
	compressedNodeCount: number;
}

// ── 常量 ──────────────────────────────────────────────

/** 默认 context window（未来由调用方传入） */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** context 使用率阈值（超过此比例触发压缩） */
const COMPRESSION_THRESHOLD = 0.7;

/** 预算使用上限（assemble 时最多使用 context window 的 80%） */
const BUDGET_RATIO = 0.8;

/** recall 提示模板 */
const RECALL_PROMPT = `历史对话已压缩为摘要树。使用 recall(nodeId, mode) 工具检索被压缩内容。
recall(nodeId, "structure") 查看子树结构（不含原始内容）。
recall(nodeId, "content") 获取原始完整内容。`;

/** CustomMessage 的 customType 标识 — 树节点摘要 */
const IC_SUMMARY_CUSTOM_TYPE = "ic-summary";

/** CustomMessage 的 customType 标识 — recall 提示 */
const IC_RECALL_PROMPT_TYPE = "ic-recall-prompt";

// ── helpers ───────────────────────────────────────────

/** 判断消息是否为本扩展注入的摘要 */
function isIcSummary(msg: MinimalAgentMessage): boolean {
	return msg.role === "custom" && msg.customType === IC_SUMMARY_CUSTOM_TYPE;
}

/** 判断消息是否为本扩展注入的 recall 提示 */
function isIcRecallPrompt(msg: MinimalAgentMessage): boolean {
	return msg.role === "custom" && msg.customType === IC_RECALL_PROMPT_TYPE;
}

/** 从消息中提取文本长度 */
function extractMessageTextLength(msg: MinimalAgentMessage): number {
	const content = msg.content;
	if (typeof content === "string") return content.length;
	if (Array.isArray(content)) {
		return content.reduce((sum: number, part: unknown) => {
			if (typeof part === "object" && part !== null && "text" in part) {
				const text = (part as { text?: string }).text;
				return sum + (typeof text === "string" ? text.length : 0);
			}
			return sum;
		}, 0);
	}
	return 0;
}

/** 创建摘要 CustomMessage */
function createSummaryMessage(nodeId: string, summary: string, timestamp: number): MinimalAgentMessage {
	return {
		role: "custom",
		customType: IC_SUMMARY_CUSTOM_TYPE,
		content: `[${nodeId}] ${summary}`,
		display: false,
		timestamp,
	};
}

/** 创建 recall 提示 CustomMessage */
function createRecallPromptMessage(timestamp: number): MinimalAgentMessage {
	return {
		role: "custom",
		customType: IC_RECALL_PROMPT_TYPE,
		content: RECALL_PROMPT,
		display: true,
		timestamp,
	};
}

/** 从树节点收集所有 segId */
function collectTreeSegIds(root: TreeNode): Set<string> {
	const segIds = new Set<string>();

	function walk(node: TreeNode): void {
		if (node.segId) {
			segIds.add(node.segId);
		}
		for (const child of node.children) {
			walk(child);
		}
	}

	walk(root);
	return segIds;
}

// ── ContextAssembler ──────────────────────────────────

export class ContextAssembler {
	/**
	 * 核心方法：每次 LLM 调用前重组 messages
	 *
	 * 1. 浅拷贝 messages
	 * 2. 清除旧注入的摘要和 recall 提示
	 * 3. 如果有 tree → 注入摘要
	 * 4. 预算检查与裁剪
	 * 5. 注入 recall 提示
	 */
	assembleMessages(
		messages: MinimalAgentMessage[],
		tree: CompactTree | undefined,
		segments: readonly Segment[],
		retentionWindow: readonly Segment[],
	): AssembleResult {
		// 1. 浅拷贝，不修改原始
		const result: MinimalAgentMessage[] = [...messages];

		// 2. 清除旧注入的摘要和 recall 提示（幂等安全）
		const filtered = result.filter(
			(msg) => !isIcSummary(msg) && !isIcRecallPrompt(msg),
		);

		// 3. 计算保留窗口段 ID 集合（当前段 + retentionWindow）
		const retentionSegIds = new Set(retentionWindow.map((s) => s.segId));
		const activeSegment = segments.find((s) => !s.completed);
		if (activeSegment) {
			retentionSegIds.add(activeSegment.segId);
		}

		let compressedNodeCount = 0;
		let treeContextTokens = 0;

		if (tree) {
			// 4. 确定树中已压缩的段 ID（用于调用方判断哪些段不使用原文）
			const _treeSegIds = collectTreeSegIds(tree.root);
			// treeSegIds 可在后续版本中用于标记 messages 中的段归属
			void _treeSegIds;

			// 5. BFS 展平树
			const flatNodes = this.bfsFlatten(tree);

			// 6. 为每个节点创建摘要消息
			const now = Date.now();
			const summaryMessages: MinimalAgentMessage[] = flatNodes.map(
				(node) => createSummaryMessage(node.nodeId, node.summary, now),
			);

			// 7. 预算检查
			treeContextTokens = summaryMessages.reduce(
				(sum, msg) => sum + estimateTokens(typeof msg.content === "string" ? msg.content : ""),
				0,
			);

			const existingTokens = this.estimateTreeContext(filtered);
			const totalBudget = DEFAULT_CONTEXT_WINDOW * BUDGET_RATIO;
			const availableForTree = totalBudget - existingTokens;

			let finalSummaryMessages: MinimalAgentMessage[];
			let finalFlatNodes: TreeNode[];

			if (availableForTree > 0 && treeContextTokens > availableForTree) {
				// 超限 → 裁剪
				const truncatedNodes = this.budgetTruncate(flatNodes, Math.max(0, availableForTree));
				finalFlatNodes = truncatedNodes;
				finalSummaryMessages = truncatedNodes.map(
					(node) => createSummaryMessage(node.nodeId, node.summary, now),
				);
				treeContextTokens = finalSummaryMessages.reduce(
					(sum, msg) => sum + estimateTokens(typeof msg.content === "string" ? msg.content : ""),
					0,
				);
			} else {
				finalSummaryMessages = summaryMessages;
				finalFlatNodes = flatNodes;
			}

			compressedNodeCount = finalFlatNodes.length;

			// 8. 注入 recall 提示 + 摘要消息到开头
			const recallMsg = createRecallPromptMessage(now);
			filtered.unshift(recallMsg, ...finalSummaryMessages);
		}

		return {
			messages: filtered,
			treeContextTokens,
			compressedNodeCount,
		};
	}

	/**
	 * 估算 messages 的 token 总数（chars/4 累加）
	 */
	estimateTreeContext(messages: MinimalAgentMessage[]): number {
		let totalChars = 0;
		for (const msg of messages) {
			totalChars += extractMessageTextLength(msg);
		}
		return Math.ceil(totalChars / 4);
	}

	/**
	 * 判断是否需要压缩
	 * treeContextTokens / contextWindow >= 0.7 → true
	 */
	shouldCompress(treeContextTokens: number, contextWindow: number): boolean {
		if (contextWindow <= 0) return false;
		return treeContextTokens / contextWindow >= COMPRESSION_THRESHOLD;
	}

	/**
	 * BFS 按层级遍历树
	 *
	 * - Level 1 → Level 2 → ...
	 * - 同层内 newest-to-oldest（children 数组最后添加的 = newest）
	 *
	 * 注意：root 节点是容器，不包含在输出中。
	 */
	bfsFlatten(tree: CompactTree): TreeNode[] {
		const result: TreeNode[] = [];

		// Level 1 = root 的直接子节点
		let currentLevel: TreeNode[] = tree.root.children;

		while (currentLevel.length > 0) {
			// 同层 newest-to-oldest：children 数组最后添加的 = newest
			// reverse 使 newest 排在前面
			const levelReversed = [...currentLevel].reverse();
			result.push(...levelReversed);

			// 收集下一层的所有子节点
			// 按照当前层的顺序（newest→oldest）收集子节点
			// 每个节点的 children 也是 newest 在最后
			const nextLevel: TreeNode[] = [];
			for (const node of currentLevel) {
				// 保持 children 原始顺序，下一轮再 reverse
				nextLevel.push(...node.children);
			}
			currentLevel = nextLevel;
		}

		return result;
	}

	/**
	 * 预算裁剪：从最深层最老节点开始砍
	 *
	 * 保护层级：
	 * 1. 保留窗口 → 永不可截断（不在这个函数中处理）
	 * 2. 树节点摘要 → 按深度裁剪（先砍最深层最老节点）
	 * 3. 极端情况：只保留 Level 1 全部 + recall 提示
	 */
	budgetTruncate(flatNodes: TreeNode[], budget: number): TreeNode[] {
		if (budget <= 0 || flatNodes.length === 0) return [];

		// 计算所有节点的总 token 开销
		let totalTokens = 0;
		const nodeCosts = new Map<string, number>();
		for (const node of flatNodes) {
			const text = `[${node.nodeId}] ${node.summary}`;
			const cost = estimateTokens(text);
			nodeCosts.set(node.nodeId, cost);
			totalTokens += cost;
		}

		// 预算充足，无需裁剪
		if (totalTokens <= budget) {
			return [...flatNodes];
		}

		// 裁剪策略：
		// flatNodes 来自 bfsFlatten，顺序为 Level 1→2→3..., 同层 newest→oldest
		// 要先砍最深层最老节点
		// reverse flatNodes → Level max→min, 同层 oldest→newest
		// 从头开始砍（最深层最老）
		const reversed = [...flatNodes].reverse();

		const removed = new Set<string>();
		for (const node of reversed) {
			if (totalTokens <= budget) break;
			const cost = nodeCosts.get(node.nodeId) ?? 0;
			totalTokens -= cost;
			removed.add(node.nodeId);
		}

		// 保留未被移除的节点（保持原始 BFS 顺序）
		let remaining = flatNodes.filter(
			(node) => !removed.has(node.nodeId),
		);

		// 极端情况：全砍了 → 回退到只保留 Level 1 节点
		// flatNodes 的 BFS 顺序中，Level 1 节点最先出现
		// 由于 reverse 后 Level 1 在末尾，它们最后被砍
		// 理论上不应全砍，但防御性处理
		if (remaining.length === 0 && flatNodes.length > 0) {
			// 回退：尝试只保留能放下的 Level 1 节点
			remaining = [];
			let fallbackBudget = budget;
			// flatNodes 的 Level 1 节点 = root 的直接子节点
			// 在 BFS 顺序中最先出现，找到第一个深度变化的节点
			// 由于我们没有深度信息，利用 BFS 特性：Level 1 节点在最前面
			// 无法确定边界时，至少放一个节点
			for (const node of flatNodes) {
				const text = `[${node.nodeId}] ${node.summary}`;
				const cost = estimateTokens(text);
				if (cost <= fallbackBudget) {
					remaining.push(node);
					fallbackBudget -= cost;
					break; // 极端情况只保留一个
				}
			}
		}

		return remaining;
	}
}
