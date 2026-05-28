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
export interface MinimalAgentMessage {
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
export const IC_SUMMARY_CUSTOM_TYPE = "ic-summary";

/** CustomMessage 的 customType 标识 — recall 提示 */
export const IC_RECALL_PROMPT_TYPE = "ic-recall-prompt";

// ── helpers ───────────────────────────────────────────

/** 判断消息是否为本扩展注入的摘要 */
export function isIcSummary(msg: MinimalAgentMessage): boolean {
	return msg.role === "custom" && msg.customType === IC_SUMMARY_CUSTOM_TYPE;
}

/** 判断消息是否为本扩展注入的 recall 提示 */
export function isIcRecallPrompt(msg: MinimalAgentMessage): boolean {
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


// ── ContextAssembler ──────────────────────────────────

export class ContextAssembler {
	/**
	 * 核心方法：每次 LLM 调用前重组 messages
	 *
	 * 策略：
	 * - 无树时：保留全部原文 messages
	 * - 有树且 context 膨胀（>70%）时：截断历史 messages，用摘要替换
	 * - 有树但 context 未膨胀时：在开头注入摘要（原文仍保留）
	 *
	 * 步骤：
	 * 1. 浅拷贝 messages，清除旧注入的摘要和 recall 提示
	 * 2. 如果有 tree:
	 *    a. BFS 展平 → 创建摘要消息
	 *    b. 估算 filtered messages 的总 tokens
	 *    c. 如果总 tokens > contextWindow * 0.7:
	 *       - 截断 filtered，只保留后 30% 的 messages（最近的对话）
	 *       - 在截断后的 messages 前面注入 recall 提示 + 摘要
	 *    d. 否则: 全部保留 + 注入摘要到开头
	 * 3. treeContextTokens = 最终 messages 的总 tokens（含摘要/原文）
	 */
	assembleMessages(
		messages: MinimalAgentMessage[],
		tree: CompactTree | undefined,
		segments: readonly Segment[],
		retentionWindow: readonly Segment[],
		contextWindow: number = DEFAULT_CONTEXT_WINDOW,
	): AssembleResult {
		// 1. 浅拷贝，不修改原始；清除旧注入（幂等安全）
		const filtered = messages.filter(
			(msg) => !isIcSummary(msg) && !isIcRecallPrompt(msg),
		);

		// 保留窗口段 ID（仅用于信息记录）
		const retentionSegIds = new Set(retentionWindow.map((s) => s.segId));
		const activeSegment = segments.find((s) => !s.completed);
		if (activeSegment) {
			retentionSegIds.add(activeSegment.segId);
		}

		// 无树时：全部原文发送
		if (!tree) {
			return {
				messages: filtered,
				treeContextTokens: this.estimateTreeContext(filtered),
				compressedNodeCount: 0,
			};
		}

		// 2. BFS 展平树 → 创建摘要消息
		const flatNodes = this.bfsFlatten(tree);
		const now = Date.now();
		const summaryMessages: MinimalAgentMessage[] = flatNodes.map(
			(node) => createSummaryMessage(node.nodeId, node.summary, now),
		);

		// 3. 估算当前 filtered messages 的 tokens
		const rawTokens = this.estimateTreeContext(filtered);
		const summaryTokens = summaryMessages.reduce(
			(sum, msg) => sum + estimateTokens(typeof msg.content === "string" ? msg.content : ""),
			0,
		);
		const recallTokens = estimateTokens(RECALL_PROMPT);
		const totalWithSummary = rawTokens + summaryTokens + recallTokens;

		// 4. 预算分配
		const totalBudget = contextWindow * BUDGET_RATIO;

		let finalMessages: MinimalAgentMessage[];
		let finalSummaryTokens: number;
		let compressedNodeCount: number;

		if (totalWithSummary > totalBudget) {
			// Context 膨胀 → 截断历史，用摘要替换
			//
			// 由于 AgentMessage 没有 turnIndex/segId 字段，
			// 无法精确知道哪条 message 属于哪个段。
			// 近似策略：保留后 RETENTION_RATIO 的 messages（最近的对话），
			// 前面的历史部分替换为摘要。

			// 先对摘要做预算裁剪
			const availableForSummary = totalBudget * 0.3; // 30% 给摘要
			const availableForRetention = totalBudget * 0.7; // 70% 给保留窗口

			let finalFlatNodes: TreeNode[];
			if (summaryTokens > availableForSummary) {
				finalFlatNodes = this.budgetTruncate(flatNodes, Math.max(0, availableForSummary));
			} else {
				finalFlatNodes = flatNodes;
			}

			const truncatedSummaries = finalFlatNodes.map(
				(node) => createSummaryMessage(node.nodeId, node.summary, now),
			);
			finalSummaryTokens = truncatedSummaries.reduce(
				(sum, msg) => sum + estimateTokens(typeof msg.content === "string" ? msg.content : ""),
				0,
			);
			compressedNodeCount = finalFlatNodes.length;

			// 从 filtered 末尾保留尽可能多的 messages，不超过 availableForRetention
			const retainedMessages = this.truncateFromStart(filtered, availableForRetention);

			// 组装: recall 提示 + 摘要 + 保留的原文
			const recallMsg = createRecallPromptMessage(now);
			finalMessages = [recallMsg, ...truncatedSummaries, ...retainedMessages];
		} else {
			// Context 未膨胀 → 全部保留原文 + 注入摘要到开头
			const recallMsg = createRecallPromptMessage(now);
			finalMessages = [recallMsg, ...summaryMessages, ...filtered];
			finalSummaryTokens = summaryTokens;
			compressedNodeCount = flatNodes.length;
		}

		// 5. treeContextTokens = 最终 messages 的总 tokens（用于 shouldCompress 判断）
		const treeContextTokens = this.estimateTreeContext(finalMessages);

		return {
			messages: finalMessages,
			treeContextTokens,
			compressedNodeCount,
		};
	}

	/**
	 * 从 messages 末尾保留尽可能多的 messages，
	 * 使保留部分的总 tokens 不超过 budget。
	 *
	 * 从后往前遍历，累加 tokens，直到超出 budget。
	 */
	private truncateFromStart(
		messages: MinimalAgentMessage[],
		budget: number,
	): MinimalAgentMessage[] {
		if (budget <= 0 || messages.length === 0) return [];

		let accumulated = 0;
		let cutoffIndex = messages.length; // 从末尾开始

		for (let i = messages.length - 1; i >= 0; i--) {
			const content = messages[i].content;
			const text = typeof content === "string" ? content : "";
			const msgTokens = estimateTokens(text);
			accumulated += msgTokens;
			if (accumulated > budget) {
				cutoffIndex = i + 1; // 保留这条及之后的
				break;
			}
		}

		return messages.slice(cutoffIndex);
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
		const MAX_DEPTH = 20;

		// Level 1 = root 的直接子节点
		let currentLevel: TreeNode[] = tree.root.children;
		let depth = 0;

		while (currentLevel.length > 0 && depth < MAX_DEPTH) {
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
			depth++;
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
