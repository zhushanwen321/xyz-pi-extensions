/**
 * 树压缩引擎（TreeCompactor）
 *
 * 提供 async（不阻塞事件循环）和 sync（阻塞等待）两种模式。
 * - async 模式：用于 turn_end 自动触发（fire-and-forget）
 * - sync 模式：用于 /tree-compact 命令（用户期待等待完成）
 *
 * 核心逻辑 shared，只在 spawn/child_process 调用方式上区分。
 */

import { spawn, spawnSync } from "node:child_process";
import type { ExtensionAPI, CustomEntry, SessionEntry } from "@mariozechner/pi-coding-agent";
import type { Segment, TreeNode, CompactTree } from "./types";
import { IC_CONFIG } from "./types";
import { estimateTokens } from "./token-estimator";

const COMPACT_TREE_ENTRY_TYPE = "ic-compact-tree";

// ── 类型 ──────────────────────────────────────────────

export interface CompactResult {
	tree: CompactTree;
	fallbackUsed: boolean;
	retryCount: number;
	errorReason?: string;
	rawOutput?: string;
}

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
		tokenCount: estimateTokens(firstSentence(seg.userMessage)),
		children: [],
		segId: seg.segId,
	}));
	const root: TreeNode = {
		nodeId: "root",
		summary: `Fallback compression of ${segments.length} segments`,
		tokenCount: 0,
		children,
	};
	return {
		treeId: `tree_${Date.now()}`,
		root,
		totalTokens: treeTotalTokens(root),
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

function extractAssistantText(stdout: string): string | undefined {
	const lines = stdout.split("\n");
	let lastAssistantText: string | undefined;

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

function makeTree(
	validated: TreeNode[],
	segments: readonly Segment[],
): CompactTree {
	const root: TreeNode = {
		nodeId: "root",
		summary: `Compressed ${segments.length} segments`,
		tokenCount: 0,
		children: validated,
	};
	return {
		treeId: `tree_${Date.now()}`,
		root,
		totalTokens: treeTotalTokens(root),
		createdAt: Date.now(),
		depth: treeDepth(root),
	};
}

function applyFallback(
	pi: ExtensionAPI,
	segments: readonly Segment[],
	retryCount: number,
	errorReason?: string,
	rawOutput?: string,
): CompactResult {
	const tree = ruleBasedFallback(segments);
	pi.appendEntry(COMPACT_TREE_ENTRY_TYPE, tree);
	return { tree, fallbackUsed: true, retryCount, errorReason, rawOutput };
}

// ── TreeCompactor ─────────────────────────────────────

export class TreeCompactor {
	private tree: CompactTree | undefined;

	/**
	 * 异步压缩（不阻塞事件循环）
	 * 用于 turn_end 自动触发。返回 Promise，完成时自动更新内部 tree 状态。
	 */
	async triggerCompressionAsync(
		pi: ExtensionAPI,
		segments: readonly Segment[],
		existingTree: CompactTree | undefined,
		onUpdate?: (result: CompactResult) => void,
	): Promise<CompactResult> {
		const result = await this.runAsyncCompression(pi, segments, existingTree);
		onUpdate?.(result);
		return result;
	}

	/**
	 * 同步压缩（阻塞等待）
	 * 用于 /tree-compact 命令
	 */
	triggerCompressionSync(
		pi: ExtensionAPI,
		segments: readonly Segment[],
		existingTree: CompactTree | undefined,
	): CompactResult {
		return this.runSyncCompression(pi, segments, existingTree);
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

	// ── Async implementation ──────────────────────────

	private async runAsyncCompression(
		pi: ExtensionAPI,
		segments: readonly Segment[],
		existingTree: CompactTree | undefined,
	): Promise<CompactResult> {
		if (segments.length === 0) {
			return applyFallback(pi, segments, 0);
		}

		for (let attempt = 0; attempt <= IC_CONFIG.maxRetryCount; attempt++) {
			const prompt = buildCompressionPrompt(segments, existingTree, undefined);
			console.error(`[infinite-context] async spawn (attempt ${attempt}, ${segments.length} segments)`);

			const result = await this.asyncSpawnPi(prompt);
			const validated = this.processSpawnResult(result, segments, attempt);

			if (validated) {
				const tree = makeTree(validated, segments);
				this.tree = tree;
				pi.appendEntry(COMPACT_TREE_ENTRY_TYPE, tree);
				console.error(`[infinite-context] tree compression succeeded: ${tree.root.children.length} groups, depth ${tree.depth}, ${tree.totalTokens} tokens`);
				return { tree, fallbackUsed: false, retryCount: attempt, rawOutput: result.stdout.slice(0, IC_CONFIG.maxStdoutLogLength) };
			}

			// 失败，继续重试
			console.error(`[infinite-context] async compression failed (attempt ${attempt}): ${result.errorReason}`);
		}

		console.error(`[infinite-context] async compression all attempts failed`);
		return applyFallback(pi, segments, IC_CONFIG.maxRetryCount, "All attempts failed");
	}

	private async asyncSpawnPi(prompt: string): Promise<{ stdout: string; stderr: string; errorReason?: string }> {
		return new Promise((resolve) => {
			const child = spawn("pi", ["--mode", "json", "-p", prompt], {
				stdio: ["ignore", "pipe", "pipe"],
				detached: false,
			});

			let stdout = "";
			let stderr = "";
			const timer = setTimeout(() => {
				if (!child.killed) child.kill("SIGTERM");
			}, IC_CONFIG.compressionTimeoutMs);

			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf-8");
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf-8");
			});

			child.on("close", (code) => {
				clearTimeout(timer);
				const killed = code === null;
				if (killed) {
					resolve({ stdout, stderr, errorReason: `Process timed out (${IC_CONFIG.compressionTimeoutMs}ms)` });
				} else if (code !== 0) {
					if (stderr) console.error(`[infinite-context] stderr: ${stderr.slice(0, IC_CONFIG.maxStderrLogLength)}`);
					resolve({ stdout, stderr, errorReason: `Process exited with code ${code}` });
				} else {
					resolve({ stdout, stderr });
				}
			});

			child.on("error", (err) => {
				clearTimeout(timer);
				console.error(`[infinite-context] spawn error: ${err.message}`);
				resolve({ stdout, stderr, errorReason: `Spawn error: ${err.message}` });
			});
		});
	}

	// ── Sync implementation ───────────────────────────

	private runSyncCompression(
		pi: ExtensionAPI,
		segments: readonly Segment[],
		existingTree: CompactTree | undefined,
	): CompactResult {
		if (segments.length === 0) {
			return applyFallback(pi, segments, 0);
		}

		let lastError: string | undefined;

		for (let attempt = 0; attempt <= IC_CONFIG.maxRetryCount; attempt++) {
			const prompt = buildCompressionPrompt(segments, existingTree, lastError);
			console.error(`[infinite-context] sync spawn (attempt ${attempt}, ${segments.length} segments)`);

			const result = spawnSync("pi", ["--mode", "json", "-p", prompt], {
				stdio: ["ignore", "pipe", "pipe"],
				timeout: IC_CONFIG.compressionTimeoutMs,
				encoding: "utf-8",
			});

			const { stdout, stderr, errorReason } = this.parseSpawnSyncResult(result);
			if (stderr) {
				console.error(`[infinite-context] pi stderr: ${stderr.slice(0, IC_CONFIG.maxStderrLogLength)}`);
			}

			if (errorReason) {
				lastError = errorReason;
				console.error(`[infinite-context] spawn/exit failed (attempt ${attempt}): ${errorReason}`);
				const partial = extractAssistantText(stdout);
				if (partial) {
					const validated = this.tryValidate(partial, segments);
					if (validated) {
						console.error(`[infinite-context] recovered from partial output (${partial.length} chars)`);
						return this.makeValidatedResult(pi, validated, segments, attempt, stdout);
					}
				}
				continue;
			}

			// spawn OK, process output
			const assistantText = extractAssistantText(stdout);
			if (!assistantText) {
				const lines = stdout.split("\n").length;
				lastError = `No assistant text in pi output (${stdout.length}B, ${lines} lines)`;
				console.warn(`[infinite-context] ${lastError}. Check if pi --mode json format changed.`);
				continue;
			}

			if (assistantText.length > 0) {
				console.error(`[infinite-context] assistant text ${assistantText.length}B (${assistantText.split("\n").length} lines)`);
			}

			const validated = validateTreeOutput(assistantText.trim(), segments);
			if ("reason" in validated) {
				lastError = validated.reason;
				console.error(`[infinite-context] tree validation failed (attempt ${attempt}): ${validated.reason}`);
				continue;
			}

			// 成功
			return this.makeValidatedResult(pi, validated, segments, attempt, stdout);
		}

		console.error(`[infinite-context] sync compression all attempts failed. Last error: ${lastError}`);
		return applyFallback(pi, segments, IC_CONFIG.maxRetryCount, lastError);
	}

	private makeValidatedResult(
		pi: ExtensionAPI,
		validated: TreeNode[],
		segments: readonly Segment[],
		attempt: number,
		stdout: string,
	): CompactResult {
		const tree = makeTree(validated, segments);
		this.tree = tree;
		pi.appendEntry(COMPACT_TREE_ENTRY_TYPE, tree);
		console.error(`[infinite-context] tree compression succeeded: ${tree.root.children.length} groups, depth ${tree.depth}, ${tree.totalTokens} tokens`);
		return { tree, fallbackUsed: false, retryCount: attempt, rawOutput: stdout.slice(0, IC_CONFIG.maxStdoutLogLength) };
	}

	private parseSpawnSyncResult(result: ReturnType<typeof spawnSync>): {
		stdout: string;
		stderr: string;
		errorReason?: string;
	} {
		const stdout = (result.stdout ?? "") as string;
		const stderr = (result.stderr ?? "") as string;

		if (result.error) {
			const spawnErr = result.error as { code?: string; message: string } | undefined;
			const msg = spawnErr?.code === "ETIMEDOUT"
				? "Compression timed out"
				: `Spawn error: ${spawnErr?.message ?? "unknown"}`;
			console.error(`[infinite-context] ${msg}`);
			// 超时时 stdout 可能有部分输出
			if (stdout) {
				const partial = extractAssistantText(stdout);
				if (partial) {
					console.error(`[infinite-context] found partial assistant text in timed-out output (${partial.length} chars)`);
				}
			}
			if (stderr) console.error(`[infinite-context] stderr: ${stderr.slice(0, IC_CONFIG.maxStderrLogLength)}`);
			return { stdout, stderr, errorReason: msg };
		}
		if (result.status !== 0) {
			const msg = `Process exited with code ${result.status}`;
			console.error(`[infinite-context] ${msg}`);
			if (stderr) console.error(`[infinite-context] stderr: ${stderr.slice(0, IC_CONFIG.maxStderrLogLength)}`);
			return { stdout, stderr, errorReason: msg };
		}
		return { stdout, stderr };
	}

	// ── Shared pipe ───────────────────────────────────

	private processSpawnResult(
		spawnResult: { stdout: string; stderr: string; errorReason?: string },
		segments: readonly Segment[],
		_attempt: number,
	): TreeNode[] | undefined {
		const { stdout, errorReason } = spawnResult;

		if (errorReason) {
			// Error occurred (timeout/spawn), but try partial output
			if (stdout) {
				const partial = extractAssistantText(stdout);
				if (partial) {
					const validated = this.tryValidate(partial, segments);
					if (validated) {
						console.error(`[infinite-context] recovered valid tree from partial output (${partial.length} chars)`);
						return validated;
					}
				}
			}
			return undefined;
		}

		const assistantText = extractAssistantText(stdout);
		if (!assistantText) {
			const lines = stdout.split("\n").length;
			console.warn(`[infinite-context] no assistant text in pi output (${stdout.length}B, ${lines} lines). Check if pi --mode json output format changed.`);
			return undefined;
		}

		console.error(`[infinite-context] assistant text ${assistantText.length}B (${assistantText.split("\n").length} lines)`);

		const result = validateTreeOutput(assistantText.trim(), segments);
		if ("reason" in result) {
			console.error(`[infinite-context] tree validation failed: ${result.reason}`);
			return undefined;
		}
		return result;
	}

	/** 尝试校验文本作为树结构，失败返回 undefined */
	private tryValidate(text: string, segments: readonly Segment[]): TreeNode[] | undefined {
		const result = validateTreeOutput(text.trim(), segments);
		if ("reason" in result) {
			return undefined;
		}
		return result;
	}
}
