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
import type { ExtensionAPI, ExtensionContext, CustomEntry, SessionEntry } from "@mariozechner/pi-coding-agent";
import type { Segment, TreeNode, CompactTree } from "./types";
import { RETENTION_CONFIG } from "./types";

// ── 常量 ──────────────────────────────────────────────

const COMPACT_TREE_ENTRY_TYPE = "ic-compact-tree";
const COMPRESSION_TIMEOUT_MS = 30_000;
const MAX_RETRY_COUNT = 1;

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

/** 提取用户消息第一句话（截取第一个句号/换行之前） */
function firstSentence(text: string): string {
	if (!text) return "(empty)";
	const idx = text.search(/[。.\n]/);
	if (idx === -1) return text.slice(0, 80);
	return text.slice(0, idx).trim();
}

/** 计算树的深度 */
function treeDepth(node: TreeNode): number {
	if (node.children.length === 0) return 1;
	return 1 + Math.max(...node.children.map(treeDepth));
}

/** 计算树的总 token 数 */
function treeTotalTokens(node: TreeNode): number {
	let sum = node.tokenCount;
	for (const child of node.children) {
		sum += treeTotalTokens(child);
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
export function validateTreeOutput(
	output: string,
	segments: readonly Segment[],
): TreeNode[] | ValidateError {
	// 1. JSON 解析
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return { reason: `JSON parse failed: ${output.slice(0, 200)}` };
	}

	// 2. 顶层必须为数组
	if (!Array.isArray(parsed)) {
		return { reason: "Top-level output must be an array of TreeNode" };
	}

	const validSegIds = new Set(segments.map((s) => s.segId));
	const seenNodeIds = new Set<string>();

	// 3. 递归校验
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
		if (typeof n.tokenCount !== "number") {
			return { reason: `Node ${String(n.nodeId)}: tokenCount must be a number` };
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
		if (n.segId !== undefined) {
			if (typeof n.segId !== "string") {
				return { reason: `Node ${String(n.nodeId)}: segId must be a string` };
			}
			if (!validSegIds.has(n.segId)) {
				return { reason: `Node ${String(n.nodeId)} references unknown segId: ${n.segId}` };
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
			tokenCount: n.tokenCount as number,
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

	return validatedRoot;
}

// ── ruleBasedFallback ─────────────────────────────────

/**
 * 降级压缩：所有历史段为独立 leaf 节点
 */
export function ruleBasedFallback(segments: readonly Segment[]): CompactTree {
	const children: TreeNode[] = segments.map((seg) => ({
		nodeId: `node_${seg.segId}`,
		summary: firstSentence(seg.userMessage),
		tokenCount: 0,
		children: [],
		segId: seg.segId,
	}));

	const totalTokens = children.length; // 每个 leaf 至少 1 token

	const root: TreeNode = {
		nodeId: "root",
		summary: `Fallback compression of ${segments.length} segments`,
		tokenCount: 0,
		children,
	};

	return {
		treeId: `tree_${Date.now()}`,
		root,
		totalTokens,
		createdAt: Date.now(),
		depth: treeDepth(root),
	};
}

// ── buildCompressionPrompt ────────────────────────────

/**
 * 构建发送给 Pi 子进程的 prompt
 */
function buildCompressionPrompt(
	segments: readonly Segment[],
	existingTree: CompactTree | undefined,
	previousError?: string,
): string {
	const segSummaries = segments.map((seg) =>
		`- ${seg.segId}: ${firstSentence(seg.userMessage)}`,
	).join("\n");

	const existingContext = existingTree
		? `\nExisting tree summary: ${existingTree.root.summary} (${existingTree.root.children.length} groups)\n`
		: "";

	const errorContext = previousError
		? `\nIMPORTANT: Previous attempt failed with error: ${previousError}\nPlease fix the issue and output valid JSON.\n`
		: "";

	return `You are a context compression engine. Given the following conversation segment summaries, produce a tree-structured compression.

Segments:
${segSummaries}
${existingContext}${errorContext}
Output a JSON array of tree nodes. Each node has:
- nodeId: string (unique, e.g. "group_1" or "node_seg_0")
- summary: string (concise summary of the grouped content)
- tokenCount: number (estimated tokens for this node)
- children: array of child nodes (empty for leaf nodes)
- segId: string (only for leaf nodes, must match one of the segment IDs above)

Group related segments under parent nodes. Each segment must appear exactly once as a leaf.

Output ONLY the JSON array, no other text.

Example output:
[
  {
    "nodeId": "group_1",
    "summary": "User discussed feature design and implementation",
    "tokenCount": 50,
    "children": [
      { "nodeId": "node_seg_0", "summary": "Feature design discussion", "tokenCount": 30, "children": [], "segId": "seg_0" },
      { "nodeId": "node_seg_1", "summary": "Implementation planning", "tokenCount": 20, "children": [], "segId": "seg_1" }
    ]
  }
]`;
}

// ── TreeCompactor ─────────────────────────────────────

export class TreeCompactor {
	private compressing = false;
	private tree: CompactTree | undefined;
	private currentProcess: ChildProcess | undefined;

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

		// 2. 过滤 retention window：最近 maxSegments 个已完成段 + 当前活跃段
		const completedSegments = segments.filter((s) => s.completed);
		const retentionIds = new Set(
			completedSegments
				.slice(-RETENTION_CONFIG.maxSegments)
				.map((s) => s.segId),
		);
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

		// 4. 启动异步压缩流程
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

		// 取最后一个 ic-compact-tree entry
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (isCompactTreeEntry(entry) && entry.data) {
				this.tree = entry.data as CompactTree;
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
		const prompt = buildCompressionPrompt(segments, existingTree);
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

			// 校验通过 → 构建树
			const root: TreeNode = {
				nodeId: "root",
				summary: `Compressed ${segments.length} segments (session ${sessionId})`,
				tokenCount: 0,
				children: result,
			};

			const tree: CompactTree = {
				treeId: `tree_${Date.now()}`,
				root,
				totalTokens: treeTotalTokens(root),
				createdAt: Date.now(),
				depth: treeDepth(root),
			};

			this.tree = tree;
			this.compressing = false;

			// 持久化
			pi.appendEntry(COMPACT_TREE_ENTRY_TYPE, tree);

			onComplete?.({
				tree,
				fallbackUsed: false,
				retryCount,
			});
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
			const prompt = buildCompressionPrompt(segments, this.tree, errorReason);
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

				// 重试成功
				const root: TreeNode = {
					nodeId: "root",
					summary: `Compressed ${segments.length} segments`,
					tokenCount: 0,
					children: result,
				};

				const tree: CompactTree = {
					treeId: `tree_${Date.now()}`,
					root,
					totalTokens: treeTotalTokens(root),
					createdAt: Date.now(),
					depth: treeDepth(root),
				};

				this.tree = tree;
				this.compressing = false;
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
		const tree = ruleBasedFallback(segments);
		this.tree = tree;
		this.compressing = false;

		pi.appendEntry(COMPACT_TREE_ENTRY_TYPE, tree);

		onComplete?.({
			tree,
			fallbackUsed: true,
			retryCount,
		});
	}
}
