/**
 * Context Assembler（上下文组装器）
 */

import type { Segment, TreeNode, CompactTree } from "./types";
import { IC_CONFIG } from "./types";
import { estimateTokens } from "./token-estimator";

export interface MinimalAgentMessage {
	role: string;
	content?: string | ContentPart[];
	customType?: string;
	display?: boolean;
	details?: unknown;
	timestamp?: number;
	[key: string]: unknown;
}

interface ContentPart {
	type: string;
	text?: string;
	[key: string]: unknown;
}

export interface AssembleResult {
	messages: MinimalAgentMessage[];
	treeContextTokens: number;
	compressedNodeCount: number;
}

const RECALL_PROMPT = `历史对话已压缩为摘要树。原始内容全部保留，通过 recall 工具随时检索。

## 树结构
- group_X: 非叶节点，摘要是子节点内容的归纳。调用 recall(group_X, "content") 会聚合底下所有叶子节点的原始内容。
- node_seg_Y: 叶子节点，每个对应一个对话段，保存完整原始内容。
- root: 整棵树的根节点。

## recall 工具用法
- recall(nodeId, "structure") → 查看节点子树结构，了解下面有哪些子节点
- recall(nodeId, "content") → 获取节点的完整原始内容（叶子节点返回原文，非叶节点返回所有子叶的聚合内容）

## 使用建议
- 需要完整的原始对话内容时，先 recall(nodeId, "structure") 确认结构，再 recall(nodeId, "content") 取内容
- 不确定某个话题在哪个节点时，从 root 或 group_X 开始查看结构
- 压缩不会删除任何原始内容，只是用摘要代替了原文出现在你的上下文中`;

export const IC_SUMMARY_CUSTOM_TYPE = "ic-summary";
export const IC_RECALL_PROMPT_TYPE = "ic-recall-prompt";

export function isIcSummary(msg: MinimalAgentMessage): boolean {
	return msg.role === "custom" && msg.customType === IC_SUMMARY_CUSTOM_TYPE;
}

export function isIcRecallPrompt(msg: MinimalAgentMessage): boolean {
	return msg.role === "custom" && msg.customType === IC_RECALL_PROMPT_TYPE;
}

function createSummaryMessage(nodeId: string, summary: string, timestamp: number): MinimalAgentMessage {
	return {
		role: "custom",
		customType: IC_SUMMARY_CUSTOM_TYPE,
		content: `[${nodeId}] ${summary}`,
		display: false,
		timestamp,
	};
}

function createRecallPromptMessage(timestamp: number): MinimalAgentMessage {
	return {
		role: "custom",
		customType: IC_RECALL_PROMPT_TYPE,
		content: RECALL_PROMPT,
		display: true,
		timestamp,
	};
}

export class ContextAssembler {

	assembleMessages(
		messages: MinimalAgentMessage[],
		tree: CompactTree | undefined,
		segments: readonly Segment[],
		retentionWindow: readonly Segment[],
		contextWindow: number = IC_CONFIG.defaultContextWindow,
	): AssembleResult {
		// 1. 清除旧注入
		const filtered = messages.filter((msg) => !isIcSummary(msg) && !isIcRecallPrompt(msg));

		if (!tree) {
			return { messages: filtered, treeContextTokens: this.estimateTreeContext(filtered), compressedNodeCount: 0 };
		}

		// 2. BFS 展平 → 摘要消息
		const flatNodes = this.bfsFlatten(tree);
		const now = Date.now();
		const summaryMessages: MinimalAgentMessage[] = flatNodes.map((n) => createSummaryMessage(n.nodeId, n.summary, now));

		// 3. 估算 tokens
		const rawTokens = this.estimateTreeContext(filtered);
		const summaryTokens = summaryMessages.reduce((s, m) => s + estimateTokens(typeof m.content === "string" ? m.content : ""), 0);
		const recallTokens = estimateTokens(RECALL_PROMPT);
		const totalWithSummary = rawTokens + summaryTokens + recallTokens;

		const totalBudget = contextWindow * IC_CONFIG.budgetRatio;

		let finalMessages: MinimalAgentMessage[];
		let compressedNodeCount: number;

		if (totalWithSummary > totalBudget) {
			// Context 膨胀 → 截断
			const availableForSummary = totalBudget * IC_CONFIG.summaryBudgetRatio;
			const availableForRetention = totalBudget * IC_CONFIG.retentionBudgetRatio;

			const finalFlatNodes = summaryTokens > availableForSummary
				? this.budgetTruncate(flatNodes, Math.max(0, availableForSummary))
				: flatNodes;

			const truncatedSummaries = finalFlatNodes.map((n) => createSummaryMessage(n.nodeId, n.summary, now));
			compressedNodeCount = finalFlatNodes.length;

			const retained = this.truncateFromStart(filtered, availableForRetention);
			const recallMsg = createRecallPromptMessage(now);
			finalMessages = [recallMsg, ...truncatedSummaries, ...retained];
		} else {
			const recallMsg = createRecallPromptMessage(now);
			finalMessages = [recallMsg, ...summaryMessages, ...filtered];
			compressedNodeCount = flatNodes.length;
		}

		return {
			messages: finalMessages,
			treeContextTokens: this.estimateTreeContext(finalMessages),
			compressedNodeCount,
		};
	}

	private truncateFromStart(messages: MinimalAgentMessage[], budget: number): MinimalAgentMessage[] {
		if (budget <= 0 || messages.length === 0) return [];
		let accumulated = 0;
		let cutoffIndex = messages.length;
		for (let i = messages.length - 1; i >= 0; i--) {
			const raw = messages[i].content;
			const text = typeof raw === "string" ? raw
				: Array.isArray(raw) ? raw.map((p: unknown) => (typeof p === "object" && p !== null && "text" in (p as Record<string, unknown>)) ? String((p as Record<string, unknown>).text) : "").join("")
				: "";
			accumulated += estimateTokens(text);
			if (accumulated > budget) {
				cutoffIndex = i + 1;
				break;
			}
		}
		return messages.slice(cutoffIndex);
	}

	estimateTreeContext(messages: MinimalAgentMessage[]): number {
		let totalChars = 0;
		for (const msg of messages) {
			const content = msg.content;
			if (typeof content === "string") totalChars += content.length;
			else if (Array.isArray(content)) {
				for (const part of content) {
					if (typeof part === "object" && part !== null && "text" in part) {
						totalChars += typeof (part as { text?: string }).text === "string" ? ((part as { text?: string }).text as string).length : 0;
					}
				}
			}
		}
		return Math.ceil(totalChars / 4);
	}

	shouldCompress(treeContextTokens: number, contextWindow: number): boolean {
		if (contextWindow <= 0) return false;
		return treeContextTokens / contextWindow >= IC_CONFIG.compressionThreshold;
	}

	bfsFlatten(tree: CompactTree): TreeNode[] {
		const result: TreeNode[] = [];
		const MAX_DEPTH = 20;
		let currentLevel: TreeNode[] = tree.root.children;
		let depth = 0;
		while (currentLevel.length > 0 && depth < MAX_DEPTH) {
			const levelReversed = [...currentLevel].reverse();
			result.push(...levelReversed);
			const nextLevel: TreeNode[] = [];
			for (const node of currentLevel) {
				nextLevel.push(...node.children);
			}
			currentLevel = nextLevel;
			depth++;
		}
		return result;
	}

	budgetTruncate(flatNodes: TreeNode[], budget: number): TreeNode[] {
		if (budget <= 0 || flatNodes.length === 0) return [];

		// 计算 cost
		const nodeCosts = new Map<string, number>();
		let totalTokens = 0;
		for (const node of flatNodes) {
			const cost = estimateTokens(`[${node.nodeId}] ${node.summary}`);
			nodeCosts.set(node.nodeId, cost);
			totalTokens += cost;
		}

		if (totalTokens <= budget) return [...flatNodes];

		// 砍最深层最老节点
		const reversed = [...flatNodes].reverse();
		const removed = new Set<string>();
		for (const node of reversed) {
			if (totalTokens <= budget) break;
			totalTokens -= nodeCosts.get(node.nodeId) ?? 0;
			removed.add(node.nodeId);
		}

		let remaining = flatNodes.filter((n) => !removed.has(n.nodeId));

		// 极端 case：全砍了 → 保留 recall prompt + Level 1（跟 Budget 走）
		if (remaining.length === 0) {
			remaining = [];
			let fbBudget = budget;
			// 优先保留 recall prompt 的预算
			const recallCost = estimateTokens(RECALL_PROMPT);
			if (recallCost <= fbBudget) {
				fbBudget -= recallCost;
			}
			// 保留尽可能多的 Level 1 节点（flatNodes 的前面部分，BFS 第一层）
			for (const node of flatNodes) {
				const cost = nodeCosts.get(node.nodeId) ?? 0;
				if (cost <= fbBudget) {
					remaining.push(node);
					fbBudget -= cost;
				} else {
					break;
				}
			}
		}

		return remaining;
	}
}
