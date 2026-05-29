/**
 * 树压缩引擎（TreeCompactor）
 *
 * 职责：
 * - 将历史段压缩为树结构摘要（通过 Pi 子进程调用 LLM）
 * - 校验 LLM 输出的树结构
 * - 降级：rule-based fallback（所有段为独立 leaf）
 * - 持久化压缩树到 session entries
 * - 从 session entries 恢复压缩树
 *
 * 压缩是同步的：调用 triggerCompression 会阻塞直到完成。
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI, CustomEntry, SessionEntry } from "@mariozechner/pi-coding-agent";
import type { Segment, TreeNode, CompactTree } from "./types";

// ── 常量 ──────────────────────────────────────────────

const COMPACT_TREE_ENTRY_TYPE = "ic-compact-tree";
const COMPRESSION_TIMEOUT_MS = 60_000;
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

function firstSentence(text: string): string {
	if (!text) return "(empty)";
	const idx = text.search(/[。.\n]/);
	if (idx === -1) return text.slice(0, 80);
	return text.slice(0, idx).trim();
}

function treeDepth(node: TreeNode): number {
	if (node.children.length === 0) return 1;
	return 1 + Math.max(...node.children.map(treeDepth));
}

function treeTotalTokens(node: TreeNode): number {
	let sum = node.tokenCount;
	for (const child of node.children) {
		sum += treeTotalTokens(child);
	}
	return sum;
}

// ── validateTreeOutput ────────────────────────────────

export function validateTreeOutput(
	output: string,
	segments: readonly Segment[],
): TreeNode[] | ValidateError {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return { reason: `JSON parse failed: ${output.slice(0, 200)}` };
	}

	if (!Array.isArray(parsed)) {
		return { reason: "Top-level output must be an array of TreeNode" };
	}

	const validSegIds = new Set(segments.map((s) => s.segId));
	const seenNodeIds = new Set<string>();

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

// ── Pi JSON mode stdout parser ───────────────────────

function extractAssistantText(stdout: string): string {
	const lines = stdout.split("\n");
	let lastAssistantText = "";

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}

		const type = parsed.type as string | undefined;
		if (type !== "message_end" && type !== "message_update" && type !== "message_start") continue;

		const message = parsed.message as Record<string, unknown> | undefined;
		if (!message || message.role !== "assistant") continue;

		const content = message.content;
		if (typeof content === "string") {
			lastAssistantText = content;
		} else if (Array.isArray(content)) {
			for (const part of content) {
				if (typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string") {
					lastAssistantText = part.text;
				}
			}
		}
	}

	return lastAssistantText;
}

// ── 同步执行单次压缩 ────────────────────────────────

/** 同步 spawn pi 子进程，提取 assistant 文本，返回结果 */
function runSyncCompression(
	segments: readonly Segment[],
	existingTree: CompactTree | undefined,
	previousError?: string,
): { assistantText: string; rawStdout: string } | { error: string; rawStdout: string } {
	const prompt = buildCompressionPrompt(segments, existingTree, previousError);

	console.log(`[infinite-context] spawning pi subprocess (sync, ${segments.length} segments)`);

	const result = spawnSync("pi", ["--mode", "json", "-p", prompt], {
		stdio: ["ignore", "pipe", "pipe"],
		timeout: COMPRESSION_TIMEOUT_MS,
		encoding: "utf-8",
	});

	if (result.error) {
		const msg = `Spawn error: ${result.error.message}`;
		console.error(`[infinite-context] ${msg}`);
		return { error: msg, rawStdout: "" };
	}

	if (result.status !== 0) {
		const stderr = (result.stderr ?? "").slice(0, MAX_STDERR_LOG_LENGTH);
		const msg = result.signal === "SIGTERM"
			? "Compression timed out"
			: `Process exited with code ${result.status}`;
		console.error(`[infinite-context] pi subprocess failed: ${msg}`);
		if (stderr) console.error(`[infinite-context] stderr: ${stderr}`);
		return { error: msg, rawStdout: result.stdout ?? "" };
	}

	const stdout = result.stdout ?? "";
	console.log(`[infinite-context] pi subprocess done (${stdout.length}B)`);

	const assistantText = extractAssistantText(stdout);
	if (!assistantText) {
		console.error(`[infinite-context] no assistant text in pi output`);
		return { error: "No assistant text in pi output", rawStdout: stdout };
	}

	console.log(`[infinite-context] assistant text (first ${MAX_STDOUT_LOG_LENGTH} chars): ${assistantText.slice(0, MAX_STDOUT_LOG_LENGTH)}`);

	return { assistantText, rawStdout: stdout };
}

// ── TreeCompactor ─────────────────────────────────────

export class TreeCompactor {
	private tree: CompactTree | undefined;

	/**
	 * 同步触发树压缩
	 *
	 * 调用会阻塞直到压缩完成（或超时/失败后降级）。
	 * 返回压缩结果。持久化到 session entries。
	 */
	triggerCompression(
		pi: ExtensionAPI,
		segments: readonly Segment[],
		existingTree: CompactTree | undefined,
	): CompactResult {
		if (segments.length === 0) {
			return this.applyFallback(pi, segments, 0);
		}

		const sessionId = "sync"; // 不再需要 ctx
		let lastError: string | undefined;
		let rawStdout = "";

		for (let attempt = 0; attempt <= MAX_RETRY_COUNT; attempt++) {
			const output = runSyncCompression(segments, existingTree, lastError);

			if ("error" in output) {
				lastError = output.error;
				rawStdout = output.rawStdout;
				continue;
			}

			const validated = validateTreeOutput(output.assistantText.trim(), segments);

			if ("reason" in validated) {
				console.error(`[infinite-context] tree validation failed: ${validated.reason}`);
				lastError = validated.reason;
				rawStdout = output.rawStdout;
				continue;
			}

			// 成功
			const root: TreeNode = {
				nodeId: "root",
				summary: `Compressed ${segments.length} segments (${sessionId})`,
				tokenCount: 0,
				children: validated,
			};

			const tree: CompactTree = {
				treeId: `tree_${Date.now()}`,
				root,
				totalTokens: treeTotalTokens(root),
				createdAt: Date.now(),
				depth: treeDepth(root),
			};

			this.tree = tree;
			pi.appendEntry(COMPACT_TREE_ENTRY_TYPE, tree);

			console.log(`[infinite-context] tree compression succeeded: ${tree.root.children.length} groups, depth ${tree.depth}, ${tree.totalTokens} tokens`);

			return {
				tree,
				fallbackUsed: false,
				retryCount: attempt,
				rawOutput: rawStdout.slice(0, MAX_STDOUT_LOG_LENGTH),
			};
		}

		// 所有尝试失败 → 降级
		console.error(`[infinite-context] all compression attempts failed, using fallback: ${lastError}`);
		return this.applyFallback(pi, segments, MAX_RETRY_COUNT, lastError, rawStdout);
	}

	getTree(): CompactTree | undefined {
		return this.tree;
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

	private applyFallback(
		pi: ExtensionAPI,
		segments: readonly Segment[],
		retryCount: number,
		errorReason?: string,
		rawOutput?: string,
	): CompactResult {
		const tree = ruleBasedFallback(segments);
		this.tree = tree;
		pi.appendEntry(COMPACT_TREE_ENTRY_TYPE, tree);

		return {
			tree,
			fallbackUsed: true,
			retryCount,
			errorReason,
			rawOutput,
		};
	}
}
