/**
 * 树压缩引擎（TreeCompactor）
 *
 * 职责：
 * - 将历史段压缩为树结构摘要（通过 Pi 子进程调用 LLM）
 * - 校验 LLM 输出的树结构
 * - 降级：rule-based fallback（所有段为独立 leaf）
 * - 持久化压缩树到 session entries
 * - 从 session entries 恢复压缩树
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, CustomEntry, SessionEntry } from "@mariozechner/pi-coding-agent";
import type { Segment, TreeNode, CompactTree } from "./types";
import { COMPRESSION_CONFIG } from "./types";
import { estimateTokens } from "./token-estimator";

// ── 常量 ──────────────────────────────────────────────

const COMPACT_TREE_ENTRY_TYPE = "ic-compact-tree";
const COMPRESSION_TIMEOUT_MS = 30_000;
const MAX_RETRY_COUNT = 1;

/** 叶节点 summary 最小长度（chars），低于此值校验不通过 */
const MIN_LEAF_SUMMARY_LENGTH = 120;
/** 分组节点 summary 最小长度（chars） */
const MIN_GROUP_SUMMARY_LENGTH = 80;

// ── 类型 ──────────────────────────────────────────────

/** 压缩结果 */
export interface CompactResult {
	tree: CompactTree;
	fallbackUsed: boolean;
	retryCount: number;
}

/** 校验错误 */
interface ValidateError {
	reason: string;
}

// ── helpers ───────────────────────────────────────────

function isCompactTreeEntry(entry: SessionEntry): entry is CustomEntry<CompactTree> {
	return entry.type === "custom"
		&& (entry as CustomEntry).customType === COMPACT_TREE_ENTRY_TYPE;
}

/** 提取段摘要（用于降级压缩）：userMessage + assistant 摘要拼接 */
function fallbackSummary(seg: Segment, digest?: SegmentDigest): string {
	const parts: string[] = [];
	if (seg.userMessage) {
		parts.push(truncate(seg.userMessage, USER_MESSAGE_MAX));
	}
	if (digest && digest.assistantSummaries.length > 0) {
		parts.push(`Assistant: ${digest.assistantSummaries.slice(0, 3).join("; ")}`);
	}
	if (digest && digest.toolNames.length > 0) {
		const unique = [...new Set(digest.toolNames)];
		parts.push(`Tools: ${unique.slice(0, 5).join(", ")}`);
	}
	return parts.length > 0 ? parts.join(" | ") : "(empty)";
}

/** 计算节点的 tokenCount（chars/4，模拟注入上下文时的实际格式） */
function computeNodeTokens(nodeId: string, summary: string): number {
	return estimateTokens(`[${nodeId}] ${summary}`);
}

/** 递归重算整棵树的 tokenCount，返回整棵树的总 tokens */
function recomputeTreeTokens(node: TreeNode): number {
	node.tokenCount = computeNodeTokens(node.nodeId, node.summary);
	let sum = node.tokenCount;
	for (const child of node.children) {
		sum += recomputeTreeTokens(child);
	}
	return sum;
}

/** 计算树的深度 */
function treeDepth(node: TreeNode): number {
	if (node.children.length === 0) return 1;
	return 1 + Math.max(...node.children.map(treeDepth));
}

/** 计算树的总 token 数（递归求和已有 tokenCount） */
function sumTreeTokens(node: TreeNode): number {
	let sum = node.tokenCount;
	for (const child of node.children) {
		sum += sumTreeTokens(child);
	}
	return sum;
}

// ── validateTreeOutput ────────────────────────────────

/**
 * 校验 LLM 输出的树结构 JSON
 *
 * 规则：
 * - JSON 解析成功
 * - 顶层为数组（children）
 * - 每个节点有 nodeId、summary、tokenCount、children
 * - segId（叶节点）必须存在于原始段中
 * - nodeId 无重复、无环（用 Set 追踪）
 * - group 节点（无 segId）的 summary 非空
 */
/**
 * 从 LLM 输出中提取 JSON 内容
 *
 * 支持两阶段输出格式：
 * - <analysis>...</analysis><summary>[...]</summary>
 * - <analysis>...</analysis> [...]
 * - 纯 JSON 数组 [...]
 */
function extractJsonFromOutput(output: string): string {
	// 1. 尝试提取 <summary> 标签内容
	const summaryMatch = output.match(/<summary>([\s\S]*?)<\/summary>/);
	if (summaryMatch) {
		return summaryMatch[1].trim();
	}

	// 2. 如果有 <analysis> 标签，取其后面的内容
	const analysisEnd = output.lastIndexOf("</analysis>");
	if (analysisEnd !== -1) {
		const afterAnalysis = output.slice(analysisEnd + "</analysis>".length).trim();
		if (afterAnalysis) return afterAnalysis;
	}

	// 3. 尝试直接找 JSON 数组
	const jsonStart = output.indexOf("[");
	const jsonEnd = output.lastIndexOf("]");
	if (jsonStart !== -1 && jsonEnd > jsonStart) {
		return output.slice(jsonStart, jsonEnd + 1);
	}

	return output.trim();
}

export function validateTreeOutput(
	output: string,
	segments: readonly Segment[],
): TreeNode[] | ValidateError {
	// 0. 提取 JSON（支持两阶段输出）
	const jsonStr = extractJsonFromOutput(output);

	// 1. JSON 解析
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		return { reason: `JSON parse failed: ${jsonStr.slice(0, 200)}` };
	}

	// 2. 顶层必须为数组
	if (!Array.isArray(parsed)) {
		return { reason: "Top-level output must be an array of TreeNode" };
	}

	const validSegIds = new Set(segments.map((s) => s.segId));
	const seenNodeIds = new Set<string>();

	// 3. 递归校验（tokenCount 可选，校验后由 recomputeTreeTokens 统一填充）
	function validateNode(node: unknown): TreeNode | ValidateError {
		if (typeof node !== "object" || node === null) {
			return { reason: "Each node must be an object" };
		}

		const n = node as Record<string, unknown>;

		// 必需字段
		if (typeof n.nodeId !== "string" || n.nodeId.length === 0) {
			return { reason: "Each node must have a non-empty string nodeId" };
		}
		if (typeof n.summary !== "string" || n.summary.length === 0) {
			return { reason: `Node ${String(n.nodeId)}: summary must be non-empty` };
		}
		if (!Array.isArray(n.children)) {
			return { reason: `Node ${String(n.nodeId)}: children must be an array` };
		}

		// nodeId 唯一性
		if (seenNodeIds.has(n.nodeId as string)) {
			return { reason: `Duplicate nodeId: ${n.nodeId}` };
		}
		seenNodeIds.add(n.nodeId as string);

		// segId 存在性（叶节点）
		const isLeaf = n.segId !== undefined;
		if (isLeaf) {
			if (typeof n.segId !== "string") {
				return { reason: `Node ${String(n.nodeId)}: segId must be a string` };
			}
			if (!validSegIds.has(n.segId)) {
				return { reason: `Node ${String(n.nodeId)} references unknown segId: ${n.segId}` };
			}
			// 叶节点 summary 最小长度校验
			if ((n.summary as string).length < MIN_LEAF_SUMMARY_LENGTH) {
				return { reason: `Node ${String(n.nodeId)}: leaf summary too short (${(n.summary as string).length} chars, minimum ${MIN_LEAF_SUMMARY_LENGTH}). Summary: ${(n.summary as string).slice(0, 100)}` };
			}
		} else {
			// 分组节点 summary 最小长度校验
			if ((n.summary as string).length < MIN_GROUP_SUMMARY_LENGTH) {
				return { reason: `Node ${String(n.nodeId)}: group summary too short (${(n.summary as string).length} chars, minimum ${MIN_GROUP_SUMMARY_LENGTH}). Summary: ${(n.summary as string).slice(0, 100)}` };
			}
		}

		// 递归校验子节点
		const validatedChildren: TreeNode[] = [];
		for (const child of n.children as unknown[]) {
			const result = validateNode(child);
			if ("reason" in result) return result;
			validatedChildren.push(result);
		}

		return {
			nodeId: n.nodeId as string,
			summary: n.summary as string,
			tokenCount: 0, // 占位，后续由 recomputeTreeTokens 用 chars/4 统一填充
			children: validatedChildren,
			...(n.segId !== undefined ? { segId: n.segId as string } : {}),
		};
	}

	const validatedRoot: TreeNode[] = [];
	for (const item of parsed) {
		const result = validateNode(item);
		if ("reason" in result) return result;
		validatedRoot.push(result);
	}

	// 校验通过后，用 chars/4 统一重算所有节点的 tokenCount
	// （LLM 输出的 tokenCount 不可靠，由我们自行计算摘要文本的实际 token 开销）
	for (const node of validatedRoot) {
		recomputeTreeTokens(node);
	}

	return validatedRoot;
}

// ── ruleBasedFallback ─────────────────────────────────

/**
 * 降级压缩：所有历史段为独立 leaf 节点
 * tokenCount 用 chars/4 计算摘要文本的实际 token 开销
 */
export function ruleBasedFallback(segments: readonly Segment[], digests?: SegmentDigest[]): CompactTree {
	const children: TreeNode[] = segments.map((seg, idx) => {
		const digest = digests?.[idx];
		let summary = fallbackSummary(seg, digest);
		// 兜底：如果 summary 太短，补充段范围信息
		if (summary.length < MIN_LEAF_SUMMARY_LENGTH) {
			summary = `Segment ${seg.segId} (turns ${seg.turnRange.start}-${seg.turnRange.end}): ${summary}`;
		}
		return {
			nodeId: `node_${seg.segId}`,
			summary,
			tokenCount: computeNodeTokens(`node_${seg.segId}`, summary),
			children: [] as TreeNode[],
			segId: seg.segId,
		};
	});

	const rootSummary = `Fallback compression of ${segments.length} segments`;
	const root: TreeNode = {
		nodeId: "root",
		summary: rootSummary,
		tokenCount: computeNodeTokens("root", rootSummary),
		children,
	};

	return {
		treeId: `tree_${Date.now()}`,
		root,
		totalTokens: sumTreeTokens(root),
		createdAt: Date.now(),
		depth: treeDepth(root),
	};
}

// ── Segment Digest（从段文件提取丰富摘要） ──────────

/** 段摘要中单条 assistant text 的截断阈值 */
const ASSISTANT_TEXT_MAX = 800;
/** 每个 segment 的 assistant text 条数上限 */
const ASSISTANT_SUMMARY_LIMIT = 15;
/** userMessage 截断阈值（buildCompressionPrompt 中使用） */
const USER_MESSAGE_MAX = 500;

/** 段丰富摘要，用于压缩 prompt */
interface SegmentDigest {
	segId: string;
	userMessage: string;
	assistantSummaries: string[];
	toolNames: string[];
	/** API 返回的 input tokens 之和（用于信息展示，不参与 tokenCount 计算） */
	apiInputTokens: number;
}

/**
 * 从段文件提取丰富摘要信息。
 *
 * 包含：
 * - 完整 userMessage
 * - 每个 assistant turn 的 text 回复摘要（截断）
 * - 工具调用名称列表
 * - API 返回的 input tokens 总和
 *
 * 不包含：完整的 thinking、tool 调用参数、tool result 全文
 * （这些信息量太大，压缩 prompt 应保持精简）
 */
function buildSegmentDigests(
	segments: readonly Segment[],
	ctxCwd: string,
): SegmentDigest[] {
	return segments.map((seg) => {
		const digest: SegmentDigest = {
			segId: seg.segId,
			userMessage: seg.userMessage,
			assistantSummaries: [],
			toolNames: [],
			apiInputTokens: 0,
		};

		// 尝试读取段文件获取丰富信息
		const segFilePath = join(ctxCwd, ".pi", seg.filePath);
		if (!existsSync(segFilePath)) {
			// 文件不存在时降级：只使用 userMessage
			return digest;
		}

		try {
			const raw = readFileSync(segFilePath, "utf-8");
			const data = JSON.parse(raw) as {
				turns?: Array<{
					message?: {
						role?: string;
						content?: unknown[];
						usage?: { input?: number; output?: number };
					};
					toolResults?: Array<{ toolName?: string }>;
				}>;
			};

			for (const turn of data.turns ?? []) {
				const msg = turn.message;
				if (!msg || msg.role !== "assistant") continue;

				// 累加 API 返回的 input tokens
				if (msg.usage?.input) {
					digest.apiInputTokens += msg.usage.input;
				}

				const content = Array.isArray(msg.content) ? msg.content : [];
				for (const part of content) {
					const p = part as Record<string, unknown>;

					// 提取 text 回复（截断）
					if (p.type === "text" && typeof p.text === "string" && p.text.length > 0) {
						if (digest.assistantSummaries.length < ASSISTANT_SUMMARY_LIMIT) {
							digest.assistantSummaries.push(
								truncate(p.text, ASSISTANT_TEXT_MAX),
							);
						}
					}

					// 提取工具调用名称
					if (p.type === "toolCall" && typeof p.name === "string") {
						digest.toolNames.push(p.name);
					}
				}
			}
		} catch (err) {
			// 文件读取或解析失败，降级为空摘要
			console.error("[infinite-context] buildSegmentDigests file read error:", err);
		}

		return digest;
	});
}

/** 截断文本并添加省略标记 */
function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen) + "...";
}

// ── buildCompressionPrompt ────────────────────────────

/**
 * 构建发送给 Pi 子进程的 prompt
 *
 * 设计原则（学习自 Claude Code / Codex CLI / Pi Mono）：
 * - 交接文档视角（为后续 LLM 生成 context checkpoint）
 * - 两阶段输出：analysis 草稿 + summary JSON
 * - 增量压缩：已有旧树时用 previous-summary 增量更新
 * - 结构化输出：叶节点包含「用户请求→助手行动→关键结果」
 * - 用户消息原文保留
 * - 工具调用防护
 */
function buildCompressionPrompt(
	segments: readonly Segment[],
	existingTree: CompactTree | undefined,
	previousError?: string,
	ctxCwd?: string,
): string {
	// 构建段摘要
	const digests = ctxCwd
		? buildSegmentDigests(segments, ctxCwd)
		: segments.map((seg) => ({
			segId: seg.segId,
			userMessage: seg.userMessage,
			assistantSummaries: [] as string[],
			toolNames: [] as string[],
			apiInputTokens: 0,
		}));

	const segLines = digests.map((d) => {
		const parts: string[] = [];
		parts.push(`- ${d.segId}:`);
		parts.push(`  user: ${truncate(d.userMessage, USER_MESSAGE_MAX)}`);
		if (d.assistantSummaries.length > 0) {
			for (const summary of d.assistantSummaries) {
				parts.push(`  asst: ${summary}`);
			}
		}
		if (d.toolNames.length > 0) {
			const unique = [...new Set(d.toolNames)];
		parts.push(`  tools: ${unique.join(", ")}`);
		}
		if (d.apiInputTokens > 0) {
			parts.push(`  context: ~${d.apiInputTokens.toLocaleString()} tokens consumed`);
		}
		return parts.join("\n");
	}).join("\n\n");

	// 已有旧树时，传递旧组信息给 LLM
	const existingGroupsContext = existingTree
		? buildExistingGroupsSection(existingTree)
		: "";

	const errorContext = previousError
		? `\nIMPORTANT: Previous attempt failed with error: ${previousError}\nPlease fix the issue and output valid JSON.\n`
		: "";

	// 总是使用初始提示词（不再使用增量提示词）
	const taskPrompt = buildInitialPrompt(segLines, existingGroupsContext, errorContext);

	return TOOL_CALL_GUARD_PREAMBLE + taskPrompt + TOOL_CALL_GUARD_TRAILER;
}

// ── 工具调用防护（学习自 Claude Code） ────────────────

/** 工具调用防护前导 */
const TOOL_CALL_GUARD_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need above.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block containing a JSON array.

`;

/** 工具调用防护尾部 */
const TOOL_CALL_GUARD_TRAILER = `

REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block containing the JSON array.`;

// ── 构建旧摘要段落（增量压缩，学习自 Pi Mono） ────────

function _buildPreviousSummarySection(existingTree: CompactTree): string {
	const flatNodes: Array<{ nodeId: string; summary: string; segId?: string }> = [];
	function collectNodes(node: TreeNode): void {
		if (node.nodeId !== "root") {
			flatNodes.push({
				nodeId: node.nodeId,
				summary: node.summary,
				segId: node.segId,
			});
		}
		for (const child of node.children) {
			collectNodes(child);
		}
	}
	collectNodes(existingTree.root);

	const nodeLines = flatNodes.map((n) => {
		const suffix = n.segId ? ` [${n.segId}]` : "";
		return `  ${n.nodeId}${suffix}: ${n.summary}`;
	}).join("\n");

	return `\n<previous-summary>\n${nodeLines}\n</previous-summary>\n`;
}

// ── 构建已有组段落（追加模式） ──────────────────

function buildExistingGroupsSection(existingTree: CompactTree): string {
	const groups = existingTree.root.children;
	if (groups.length === 0) return "";

	const lines = groups.map((g) => {
		const leafSegIds = g.children
			.filter((c) => c.segId)
			.map((c) => c.segId!)
			.join(", ");
		return `  ${g.nodeId} [${leafSegIds}]: ${g.summary}`;
	});

	return `\n<existing-groups>\nThe tree already contains the following groups from previous compressions:\n${lines.join("\n")}\n</existing-groups>\n`;
}

// ── 初始压缩提示词 ───────────────────────────────────

function buildInitialPrompt(segLines: string, existingGroupsContext: string, errorContext: string): string {
	return `You are creating a CONTEXT CHECKPOINT for another AI that will continue this work.
Your job is to produce a tree-structured compression that preserves MAXIMUM useful information.
Another AI will use your output to seamlessly continue the conversation.

First, analyze each segment in <analysis> tags:
- What was the user's request?
- What did the assistant do? (specific files, functions, changes)
- What decisions were made?
- What errors occurred and how were they fixed?
- What were the outcomes?

Then produce the compressed tree in <summary> tags as a JSON array.
${existingGroupsContext}
Segments:
${segLines}
${errorContext}
Output a JSON array of tree nodes. Each node has:
- nodeId: string (unique, e.g. "group_1" or "node_seg_0")
- summary: string (DETAILED, 150-400 chars per leaf, aim for 200+ chars average)
- children: array of child nodes (empty for leaf nodes)
- segId: string (only for leaf nodes, must match one of the segment IDs above)

STRUCTURED SUMMARY FORMAT for each leaf node — cover ALL of these:
  1. What the user asked for (their exact request or intent)
  2. What the assistant did (specific actions, files read/edited, tools used)
  3. Key results or outcomes (files created/modified, functions added, errors fixed)
  4. Important decisions (chose X over Y because Z)
  5. Files involved (exact paths: src/auth/login.ts, config/eslint.config.js)

CRITICAL RULES:
1. Group related segments under parent nodes. Each segment must appear exactly once as a leaf.
2. Leaf summaries MUST be 150-400 chars. This is a HARD requirement. Short summaries WILL BE REJECTED.
3. Group summaries MUST be 100-250 chars. Synthesize their children: common theme + key deliverables.
4. NEVER write vague summaries like "User discussed project setup". Instead: "User initialized Vue 3 + TS project with Vite: added ESLint with typescript-eslint parser + vue plugin, Prettier with 2-space indent/single quotes, configured vite.config.ts with API proxy to localhost:3000/api, created vitest setup with jsdom environment".
5. Preserve important details: variable names, configuration values, API endpoints, error messages, file paths, function signatures.
6. Preserve exact user messages — include key user feedback and corrections in the summary.
7. When errors were encountered, document BOTH the error AND the fix.
8. TARGET: your total JSON output should be 2000-4000 chars. Do NOT artificially shorten summaries.

Output format:
<analysis>
[Your analysis of each segment — be thorough, this helps you write better summaries]
</analysis>
<summary>
[JSON array of tree nodes]
</summary>

Example:
<analysis>
seg_0: User asked to set up a new Vue 3 + TypeScript project. Assistant scaffolded with create-vue, added ESLint with typescript-eslint parser and vue plugin, configured Prettier with 2-space indent and single quotes, set up vite.config.ts with API proxy to localhost:3000. Key decision: chose Vite over Webpack for faster HMR.
seg_1: User asked for authentication module. Assistant built JWT access+refresh token flow, created axios interceptor for automatic token refresh on 401, added useAuth composable with login/logout/refresh methods, configured httpOnly cookies for refresh token storage. Error encountered: CORS issue on /api/auth/refresh — fixed by adding credentials: 'include' to axios config.
</analysis>
<summary>
[
  {
    "nodeId": "group_1",
    "summary": "Project setup and authentication: scaffolded Vue 3 + TS with Vite, configured ESLint/Prettier, implemented JWT auth module with refresh token flow",
    "children": [
      { "nodeId": "node_seg_0", "summary": "Project initialization: scaffolded Vue 3 + TS via create-vue with Vite bundler. Added ESLint with typescript-eslint parser + vue plugin, Prettier with 2-space indent/single quotes. Configured vite.config.ts with API proxy (/api → localhost:3000). Set up vitest with jsdom. Key decision: Vite over Webpack for faster HMR.", "children": [], "segId": "seg_0" },
      { "nodeId": "node_seg_1", "summary": "Auth module implementation: built JWT access+refresh token flow with 15min access / 7day refresh expiry. Created axios interceptor for auto-refresh on 401. Added useAuth composable (src/composables/useAuth.ts) with login/logout/refresh methods. Configured httpOnly cookies for refresh tokens. Fixed CORS issue on /api/auth/refresh by adding credentials: 'include' to axios config.", "children": [], "segId": "seg_1" }
    ]
  }
]
</summary>`;
}

// ── 增量压缩提示词（学习自 Pi Mono） ────────────────

function _buildIncrementalPrompt(segLines: string, previousSummary: string, errorContext: string): string {
	return `You are updating a CONTEXT CHECKPOINT for another AI that will continue this work.
New conversation segments have been added since the last checkpoint.

First, analyze the new segments in <analysis> tags:
- What new work was done since the last checkpoint?
- What decisions changed or were added?
- What new errors occurred and how were they fixed?

Then produce an UPDATED tree in <summary> tags.

RULES:
- PRESERVE all information from the previous summary
- ADD new segments as new leaf nodes (group with existing siblings if related, or create new groups)
- UPDATE group summaries if their children changed
- REMOVE information that is no longer relevant
- Keep the same nodeId for unchanged nodes (helps maintain continuity)
- Leaf summaries MUST be 150-400 chars with specific details
- Group summaries MUST be 100-250 chars
- TARGET: total JSON output should be 2000-4000 chars

Previous checkpoint:
${previousSummary}

New segments to incorporate:
${segLines}
${errorContext}
Output a JSON array of ALL tree nodes (both old and new, fully merged).
Each node has: nodeId, summary (150-400 chars for leaves), children, segId (leaf only).

Output format:
<analysis>
[Your analysis of new segments and how they integrate with existing checkpoint]
</analysis>
<summary>
[JSON array of ALL tree nodes]
</summary>`;
}

// ── TreeCompactor ────────────────────────────────────

export class TreeCompactor {
	private compressing = false;
	private tree: CompactTree | undefined;
	private currentProcess: ChildProcess | undefined;
	/** 当前压缩任务的段摘要缓存（用于 fallback 时复用） */
	private currentDigests: SegmentDigest[] = [];
	/** 当前压缩任务的工作目录（用于读取段文件） */
	private ctxCwd = "";
	private compressedSegIds: Set<string> = new Set();

	/** BFS 收集树中所有 leaf segIds */
	private collectCompressedSegIds(node: TreeNode): void {
		if (node.segId) {
			this.compressedSegIds.add(node.segId);
		}
		for (const child of node.children) {
			this.collectCompressedSegIds(child);
		}
	}

	/** 返回已压缩段的 segId 集合的拷贝 */
	getCompressedSegIds(): Set<string> {
		return new Set(this.compressedSegIds);
	}


	computeCompressionScope(
		retentionSegs: readonly Segment[],
		historySegs: readonly Segment[],
		existingTree: CompactTree | undefined,
	): { targetSegs: Segment[]; estimatedAfterTokens: number } {
		const { ratioMin, ratioMax, perSegmentTokens } = COMPRESSION_CONFIG;
		const existingTreeSize = existingTree?.totalTokens ?? 0;

		// 分母：树 + 保留段 digest + 历史段 digest + 系统提示词
		const systemPromptEstimate = 4000;
		const retentionMsgSize = retentionSegs.reduce((sum, s) => sum + s.userMessage.length, 0) / 4;
		const historyTotalDigest = historySegs.reduce((sum, s) => sum + s.userMessage.length, 0) / 4;
		const denominator = existingTreeSize + retentionMsgSize + historyTotalDigest + systemPromptEstimate;

		if (denominator <= 0) return { targetSegs: [...historySegs], estimatedAfterTokens: 0 };

		// 按 segId 排序（最旧在前）
		const sorted = [...historySegs].sort((a, b) => a.segId.localeCompare(b.segId));

		for (let i = 1; i <= sorted.length; i++) {
			const segs = sorted.slice(0, i);
			const estimatedAfter = segs.length * perSegmentTokens + existingTreeSize;
			const ratio = estimatedAfter / denominator;

			if (ratio >= ratioMin) {
				if (ratio <= ratioMax) {
					return { targetSegs: segs, estimatedAfterTokens: estimatedAfter };
				}
				// 超出上限 → 减一段
				if (i > 1) {
					const prev = sorted.slice(0, i - 1);
					const prevEstimated = (i - 1) * perSegmentTokens + existingTreeSize;
					return { targetSegs: prev, estimatedAfterTokens: prevEstimated };
				}
				return { targetSegs: segs, estimatedAfterTokens: estimatedAfter };
			}
		}

		// 所有段加完仍未达标 → 接受小于 ratioMin
		const allEstimated = sorted.length * perSegmentTokens + existingTreeSize;
		return { targetSegs: sorted, estimatedAfterTokens: allEstimated };
	}

	/**
	 * 触发树压缩（fire-and-forget + 回调模式）
	 *
	 * 1. 检查 isCompressing 守卫
	 * 2. 过滤掉 retention window 内的段
	 * 3. 异步 spawn Pi 子进程调用 LLM
	 * 4. 校验输出 → 成功则持久化，失败则重试或降级
	 */
	triggerCompression(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		segments: readonly Segment[],
		existingTree: CompactTree | undefined,
		onComplete?: (result: CompactResult) => void,
	): void {
		// 1. 守卫：已在压缩中
		if (this.compressing) return;
		this.compressing = true;
		this.ctxCwd = ctx.cwd;

		// 2. 过滤 retention window：最近 maxSegments 个已完成段 + 当前活跃段
		const completedSegments = segments.filter((s) => s.completed);
		// 保留窗口: min(2 个已完成段, 覆盖最近 8 turns 的段)
		const byCount = completedSegments.slice(-2);
		const latestTurnEnd = Math.max(
			...completedSegments.map((s) => s.turnRange.end),
		);
		const cutoffTurn = latestTurnEnd - 8 + 1;
		const byTurns = completedSegments.filter(
			(s) => s.turnRange.end >= cutoffTurn,
		);
		// 取更严格的窗口（段数较少的），保留更多历史段给压缩
		const retentionSegs = byCount.length <= byTurns.length ? byCount : byTurns;
		const retentionIds = new Set(retentionSegs.map((s) => s.segId));
		// 也排除当前活跃段（未完成的）
		const activeIds = new Set(
			segments.filter((s) => !s.completed).map((s) => s.segId),
		);

		const historySegments = segments.filter(
			(s) => !retentionIds.has(s.segId) && !activeIds.has(s.segId),
		);

		// 3. 无历史段需要压缩
		if (historySegments.length === 0) {
			this.compressing = false;
			return;
		}

		// 4. 预构建段摘要（缓存，用于 fallback 复用）
		this.currentDigests = buildSegmentDigests(historySegments, this.ctxCwd);

		// 5. 启动异步压缩流程
		this.runCompression(
			pi,
			ctx,
			historySegments,
			existingTree,
			0, // retryCount
			onComplete,
		);
	}

	/**
	 * 取消正在进行的 Pi 压缩子进程
	 */
	cancelPiCompaction(): { cancel: boolean } {
		if (this.currentProcess && !this.currentProcess.killed) {
			this.currentProcess.kill("SIGTERM");
			this.currentProcess = undefined;
			this.compressing = false;
			return { cancel: true };
		}
		return { cancel: false };
	}

	/**
	 * 返回当前压缩树
	 */
	getTree(): CompactTree | undefined {
		return this.tree;
	}

	/**
	 * 查询是否正在压缩
	 */
	isCompressing(): boolean {
		return this.compressing;
	}

	/**
	 * 从 session entries 恢复压缩树
	 */
	restoreState(entries: SessionEntry[]): void {
		this.tree = undefined;
		this.compressedSegIds.clear();

		// 取最后一个 ic-compact-tree entry
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (isCompactTreeEntry(entry) && entry.data) {
				this.tree = entry.data as CompactTree;
				this.collectCompressedSegIds(this.tree.root);
				return;
			}
		}
	}

	// ── 内部方法 ──────────────────────────────────────

	/**
	 * 异步执行压缩：spawn Pi 子进程 → 收集输出 → 校验 → 回调
	 */
	private runCompression(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		segments: readonly Segment[],
		existingTree: CompactTree | undefined,
		retryCount: number,
		onComplete?: (result: CompactResult) => void,
	): void {
		const prompt = buildCompressionPrompt(segments, existingTree, undefined, this.ctxCwd);
		const sessionId = ctx.sessionManager.getSessionId();

		// spawn Pi 子进程
		const child = spawn("pi", ["--mode", "json", "-p", prompt], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: false,
		});

		this.currentProcess = child;
		let stdout = "";
		let timedOut = false;

		// 收集 stdout
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});

		// 30 秒超时
		const timer = setTimeout(() => {
			timedOut = true;
			if (!child.killed) {
				child.kill("SIGTERM");
			}
		}, COMPRESSION_TIMEOUT_MS);

		child.on("close", (code) => {
			clearTimeout(timer);
			this.currentProcess = undefined;

			// 超时或非零退出码 → 视为失败
			if (timedOut || code !== 0) {
				const errorReason = timedOut
					? "Compression timed out after 30s"
					: `Process exited with code ${code}`;

				this.handleCompressionFailure(
					pi,
					segments,
					errorReason,
					retryCount,
					onComplete,
				);
				return;
			}

			// 校验输出
			const result = validateTreeOutput(stdout.trim(), segments);

			if ("reason" in result) {
				this.handleCompressionFailure(
					pi,
					segments,
					result.reason,
					retryCount,
					onComplete,
				);
				return;
			}

			// 校验通过 → 构建树（tokenCount 已由 validateTreeOutput 中的 recomputeTreeTokens 填充）
			const newGroups = result; // validated TreeNode[]

			if (existingTree) {
				// 追加模式：保留旧 groups，追加新 groups
				const rootSummary = `Compressed ${segments.length} segments (appended, session ${sessionId})`;
				const root: TreeNode = {
					nodeId: "root",
					summary: rootSummary,
					tokenCount: computeNodeTokens("root", rootSummary),
					children: [...existingTree.root.children, ...newGroups],
				};

				const tree: CompactTree = {
					treeId: existingTree.treeId,
					root,
					totalTokens: sumTreeTokens(root),
					createdAt: Date.now(),
					depth: treeDepth(root),
				};

				this.tree = tree;
				this.compressing = false;
				for (const seg of segments) {
					this.compressedSegIds.add(seg.segId);
				}
				pi.appendEntry(COMPACT_TREE_ENTRY_TYPE, tree);
				onComplete?.({ tree, fallbackUsed: false, retryCount });
			} else {
				// 首次压缩：新树
				const rootSummary = `Compressed ${segments.length} segments (session ${sessionId})`;
				const root: TreeNode = {
					nodeId: "root",
					summary: rootSummary,
					tokenCount: computeNodeTokens("root", rootSummary),
					children: newGroups,
				};

				const tree: CompactTree = {
					treeId: `tree_${Date.now()}`,
					root,
					totalTokens: sumTreeTokens(root),
					createdAt: Date.now(),
					depth: treeDepth(root),
				};

				this.tree = tree;
				this.compressing = false;
				for (const seg of segments) {
					this.compressedSegIds.add(seg.segId);
				}
				pi.appendEntry(COMPACT_TREE_ENTRY_TYPE, tree);
				onComplete?.({ tree, fallbackUsed: false, retryCount });
			}
		});

		// 处理 spawn 错误
		child.on("error", (err) => {
			clearTimeout(timer);
			this.currentProcess = undefined;
			this.handleCompressionFailure(
				pi,
				segments,
				`Spawn error: ${err.message}`,
				retryCount,
				onComplete,
			);
		});
	}

	/**
	 * 处理压缩失败：重试或降级
	 */
	private handleCompressionFailure(
		pi: ExtensionAPI,
		segments: readonly Segment[],
		errorReason: string,
		retryCount: number,
		onComplete?: (result: CompactResult) => void,
	): void {
		// 尝试重试（最多 MAX_RETRY_COUNT 次）
		if (retryCount < MAX_RETRY_COUNT) {
			// 重试时附带错误信息
			const prompt = buildCompressionPrompt(segments, this.tree, errorReason, this.ctxCwd);
			const child = spawn("pi", ["--mode", "json", "-p", prompt], {
				stdio: ["ignore", "pipe", "pipe"],
				detached: false,
			});

			this.currentProcess = child;
			let stdout = "";
			let timedOut = false;

			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf-8");
			});

			const timer = setTimeout(() => {
				timedOut = true;
				if (!child.killed) {
					child.kill("SIGTERM");
				}
			}, COMPRESSION_TIMEOUT_MS);

			child.on("close", (code) => {
				clearTimeout(timer);
				this.currentProcess = undefined;

				if (timedOut || code !== 0) {
					// 重试也失败 → 降级
					this.applyFallback(pi, segments, retryCount + 1, onComplete);
					return;
				}

				const result = validateTreeOutput(stdout.trim(), segments);
				if ("reason" in result) {
					this.applyFallback(pi, segments, retryCount + 1, onComplete);
					return;
				}

				// 重试成功（tokenCount 已由 validateTreeOutput 中的 recomputeTreeTokens 用 chars/4 填充）
				const rootSummary = `Compressed ${segments.length} segments`;
				const root: TreeNode = {
					nodeId: "root",
					summary: rootSummary,
					tokenCount: computeNodeTokens("root", rootSummary),
					children: result,
				};

				const tree: CompactTree = {
					treeId: `tree_${Date.now()}`,
					root,
					totalTokens: sumTreeTokens(root),
					createdAt: Date.now(),
					depth: treeDepth(root),
				};

				this.tree = tree;
				this.compressing = false;
				for (const seg of segments) {
					this.compressedSegIds.add(seg.segId);
				}
				pi.appendEntry(COMPACT_TREE_ENTRY_TYPE, tree);

				onComplete?.({
					tree,
					fallbackUsed: false,
					retryCount: retryCount + 1,
				});
			});

			child.on("error", () => {
				clearTimeout(timer);
				this.currentProcess = undefined;
				this.applyFallback(pi, segments, retryCount + 1, onComplete);
			});

			return;
		}

		// 超过重试次数 → 降级
		this.applyFallback(pi, segments, retryCount, onComplete);
	}

	/**
	 * 应用 rule-based 降级
	 */
	private applyFallback(
		pi: ExtensionAPI,
		segments: readonly Segment[],
		retryCount: number,
		onComplete?: (result: CompactResult) => void,
	): void {
		const tree = ruleBasedFallback(segments, this.currentDigests.length > 0 ? this.currentDigests : undefined);
		this.tree = tree;
		this.compressing = false;
		for (const seg of segments) {
			this.compressedSegIds.add(seg.segId);
		}

		console.error("[infinite-context] LLM compression failed, using rule-based fallback");

		pi.appendEntry(COMPACT_TREE_ENTRY_TYPE, tree);

		onComplete?.({
			tree,
			fallbackUsed: true,
			retryCount,
		});
	}
}
