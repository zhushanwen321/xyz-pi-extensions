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

// ── 常量 ──────────────────────────────────────────────

const COMPACT_TREE_ENTRY_TYPE = "ic-compact-tree";
const COMPRESSION_TIMEOUT_MS = 30_000;
const MAX_RETRY_COUNT = 1;
const MAX_STDERR_LOG_LENGTH = 500;
const MAX_STDOUT_LOG_LENGTH = 1000;

// ── 类型 ──────────────────────────────────────────────

/** 压缩结果 */
export interface CompactResult {
	tree: CompactTree;
	fallbackUsed: boolean;
	retryCount: number;
	errorReason?: string;
	/** LLM 原始 stdout（调试用） */
	rawOutput?: string;
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

		if (seenNodeIds.has(n.nodeId as string)) {
			return { reason: `Duplicate nodeId: ${n.nodeId}` };
		}
		seenNodeIds.add(n.nodeId as string);

		if (n.segId !== undefined) {
			if (typeof n.segId !== "string") {
				return { reason: `Node ${String(n.nodeId)}: segId must be a string` };
			}
			if (!validSegIds.has(n.segId)) {
				return { reason: `Node ${String(n.nodeId)} references unknown segId: ${n.segId}` };
			}
		}

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

	const totalTokens = children.length;

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
	 * 2. 使用所有段（不再过滤 retention window）— 只要触发就执行
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
		if (this.compressing) return;
		this.compressing = true;

		// 只要触发就压缩所有段，不做 retention window 过滤
		if (segments.length === 0) {
			this.compressing = false;
			return;
		}

		this.runCompression(
			pi,
			ctx,
			segments,
			existingTree,
			0,
			onComplete,
		);
	}

	cancelPiCompaction(): { cancel: boolean } {
		if (this.currentProcess && !this.currentProcess.killed) {
			this.currentProcess.kill("SIGTERM");
			this.currentProcess = undefined;
			this.compressing = false;
			return { cancel: true };
		}
		return { cancel: false };
	}

	getTree(): CompactTree | undefined {
		return this.tree;
	}

	isCompressing(): boolean {
		return this.compressing;
	}

	restoreState(entries: SessionEntry[]): void {
		this.tree = undefined;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (isCompactTreeEntry(entry) && entry.data) {
				this.tree = entry.data as CompactTree;
				return;
			}
		}
	}

	// ── 内部方法 ──────────────────────────────────────

	private runCompression(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		segments: readonly Segment[],
		existingTree: CompactTree | undefined,
		retryCount: number,
		onComplete?: (result: CompactResult) => void,
		previousError?: string,
	): void {
		const prompt = buildCompressionPrompt(segments, existingTree, previousError);
		const sessionId = ctx.sessionManager.getSessionId();

		console.log(`[infinite-context] spawning pi subprocess for tree compression (${segments.length} segments, retry=${retryCount})`);

		const child = spawn("pi", ["--mode", "json", "-p", prompt], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: false,
		});

		this.currentProcess = child;
		let stdout = "";
		let stderr = "";
		let timedOut = false;

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
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

			// 记录 LLM 原始输出（无论成功失败）
			console.log(`[infinite-context] pi subprocess exited (code=${code}, stdout=${stdout.length}B, stderr=${stderr.length}B)`);

			if (timedOut || code !== 0) {
				const errorReason = timedOut
					? "Compression timed out after 30s"
					: `Process exited with code ${code}`;

				if (stderr) {
					console.error(`[infinite-context] pi subprocess stderr: ${stderr.slice(0, MAX_STDERR_LOG_LENGTH)}`);
				}

				this.handleCompressionFailure(
					pi, ctx, segments, existingTree,
					errorReason, retryCount, onComplete, stdout,
				);
				return;
			}

			// 记录 LLM 返回的原始内容
			console.log(`[infinite-context] LLM raw output (first ${MAX_STDOUT_LOG_LENGTH} chars): ${stdout.slice(0, MAX_STDOUT_LOG_LENGTH)}`);

			const result = validateTreeOutput(stdout.trim(), segments);

			if ("reason" in result) {
				console.error(`[infinite-context] tree validation failed: ${result.reason}`);
				if (stderr) {
					console.error(`[infinite-context] pi subprocess stderr: ${stderr.slice(0, MAX_STDERR_LOG_LENGTH)}`);
				}
				this.handleCompressionFailure(
					pi, ctx, segments, existingTree,
					result.reason, retryCount, onComplete, stdout,
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
			pi.appendEntry(COMPACT_TREE_ENTRY_TYPE, tree);

			console.log(`[infinite-context] tree compression succeeded: ${tree.root.children.length} groups, depth ${tree.depth}, ${tree.totalTokens} tokens`);

			onComplete?.({
				tree,
				fallbackUsed: false,
				retryCount,
				rawOutput: stdout.slice(0, MAX_STDOUT_LOG_LENGTH),
			});
		});

		child.on("error", (err) => {
			clearTimeout(timer);
			this.currentProcess = undefined;
			console.error(`[infinite-context] spawn "pi" failed: ${err.message}`);
			this.handleCompressionFailure(
				pi, ctx, segments, existingTree,
				`Spawn error: ${err.message}`, retryCount, onComplete, "",
			);
		});
	}

	private handleCompressionFailure(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		segments: readonly Segment[],
		existingTree: CompactTree | undefined,
		errorReason: string,
		retryCount: number,
		onComplete?: (result: CompactResult) => void,
		rawOutput?: string,
	): void {
		if (retryCount < MAX_RETRY_COUNT) {
			console.error(`[infinite-context] compression failed (retry ${retryCount + 1}/${MAX_RETRY_COUNT}): ${errorReason}`);
			this.runCompression(pi, ctx, segments, existingTree, retryCount + 1, onComplete, errorReason);
			return;
		}
		console.error(`[infinite-context] compression failed, using fallback: ${errorReason}`);
		this.applyFallback(pi, segments, retryCount, onComplete, errorReason, rawOutput);
	}

	private applyFallback(
		pi: ExtensionAPI,
		segments: readonly Segment[],
		retryCount: number,
		onComplete?: (result: CompactResult) => void,
		errorReason?: string,
		rawOutput?: string,
	): void {
		const tree = ruleBasedFallback(segments);
		this.tree = tree;
		this.compressing = false;
		pi.appendEntry(COMPACT_TREE_ENTRY_TYPE, tree);

		onComplete?.({
			tree,
			fallbackUsed: true,
			retryCount,
			errorReason,
			rawOutput,
		});
	}
}
