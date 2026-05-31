/**
 * Edit Stale Content Guard
 *
 * Intercepts edit tool calls that are doomed to fail because oldText
 * doesn't exist in the file. Returns the file's current content so the AI
 * can retry with correct text.
 *
 * Two layers of defense:
 *   1. tool_call: Pre-validate oldText before edit executes. Block + return file content.
 *   2. tool_result: If edit still fails, enrich the error message with file content.
 *
 * Why this exists: 113 edit errors analyzed over 3 days — 0 were whitespace issues,
 * 0 were fixable by fuzzy match. All were stale content (file changed since last read).
 * The previous "whitespace autofix" approach was solving the wrong problem.
 */

import type {
	ExtensionAPI,
	ToolCallEvent,
	ToolResultEvent,
	ToolCallEventResult,
} from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const MAX_FILE_SIZE_KB = 512;

interface ContentText {
	type: "text";
	text: string;
}

interface EditInput {
	path: string;
	edits: Array<{ oldText: string; newText: string }>;
}

function readFileContent(filePath: string): string | null {
	const absPath = resolve(filePath);
	if (!existsSync(absPath)) return null;

	try {
		const stat = statSync(absPath);
		if (stat.size > MAX_FILE_SIZE_KB * 1024) {
			return `[File too large: ${(stat.size / 1024).toFixed(0)}KB > ${MAX_FILE_SIZE_KB}KB limit]`;
		}
		return readFileSync(absPath, "utf-8");
	} catch {
		return null;
	}
}

function buildBlockMessage(filePath: string, failedEdits: number[], fileContent: string | null): string {
	const parts: string[] = [
		`edit 被拦截：oldText 在文件 ${filePath} 中未找到。`,
		`失败的 edits 索引: [${failedEdits.join(", ")}]`,
	];

	if (fileContent === null) {
		parts.push("文件不存在或无法读取。请先 read 确认文件状态。");
	} else {
		const lines = fileContent.split("\n");
		parts.push(`文件当前内容（${lines.length} 行）：`);
		parts.push("");
		for (let i = 0; i < lines.length; i++) {
			parts.push(`${i + 1}: ${lines[i]}`);
		}
		parts.push("");
		parts.push("请基于以上内容重新编辑。如果改动较大，考虑使用 write 工具。");
	}

	return parts.join("\n");
}

function getEditInput(event: ToolCallEvent | ToolResultEvent): EditInput | null {
	const input = ("input" in event ? event.input : {}) as Record<string, unknown>;
	if (!input || typeof input !== "object") return null;
	const path = input.path;
	const edits = input.edits;
	if (typeof path !== "string" || !Array.isArray(edits)) return null;
	return { path, edits: edits as EditInput["edits"] };
}

const EMPTY: ToolCallEventResult = {};

/**
 * Layer 1: Pre-validation — block doomed edits before they waste API tokens.
 */
function setupToolCallGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event): Promise<ToolCallEventResult> => {
		if (event.toolName !== "edit") return EMPTY;

		const input = getEditInput(event);
		if (!input) return EMPTY;

		const fileContent = readFileContent(input.path);
		if (fileContent === null) return EMPTY;

		const failedEdits: number[] = [];
		for (let i = 0; i < input.edits.length; i++) {
			const oldText = input.edits[i]?.oldText;
			if (typeof oldText !== "string") continue;
			if (!fileContent.includes(oldText)) {
				failedEdits.push(i);
			}
		}

		if (failedEdits.length === 0) return EMPTY;

		console.log(
			`[edit-stale-guard] Blocked edit for ${input.path}: edits[${failedEdits.join(",")}] oldText not found`
		);

		return {
			block: true,
			reason: buildBlockMessage(input.path, failedEdits, fileContent),
		};
	});
}

/**
 * Layer 2: Post-failure enrichment — if edit somehow still fails,
 * append file content to the error so the AI can self-correct.
 */
function setupToolResultFallback(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "edit" || !event.isError) return;

		// Check if error is "Could not find" type
		const textContents = event.content.filter(
			(c): c is ContentText => c.type === "text"
		);
		const errorText = textContents.map((c) => c.text).join("");

		if (!errorText.includes("Could not find")) return;

		const input = getEditInput(event);
		if (!input) return;

		const fileContent = readFileContent(input.path);
		if (fileContent === null) return;

		// Prepend file content to existing error message
		const lines = fileContent.split("\n");
		const fileDump = [
			`[edit-stale-guard] 文件当前内容（${lines.length} 行）：`,
			"",
			...lines.map((l, i) => `${i + 1}: ${l}`),
			"",
			"--- 以下是原始错误 ---",
		].join("\n");

		return {
			content: [{ type: "text" as const, text: fileDump }, ...event.content],
		};
	});
}

export function setupEditStaleContentGuard(pi: ExtensionAPI): void {
	setupToolCallGuard(pi);
	setupToolResultFallback(pi);
}
