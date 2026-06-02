/**
 * @zhushanwen/pi-vision — Image analysis tool using multimodal vision models.
 *
 * Spawns a dedicated Pi child process with a vision-capable model to analyze images.
 * Supports memory sessions for multi-turn follow-up questions on the same image.
 * Reads model configuration from ~/.pi/agent/vision-models.json.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionAPI, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
	VISION_ALLOWED_TOOLS,
	VISION_SYSTEM_PROMPT,
	loadVisionModels,
	resolveVisionModelSync,
	buildVisionMemoryId,
	resolveMemorySessionFile,
} from "./vision-model.js";
import {
	type OnUpdateCallback,
	type VisionResult,
	cleanupOldTempFiles,
	getFinalOutput,
	runSingleVisionAgent,
} from "./spawn.js";

// ──────────────────────── Parameters ────────────────────────

const AnalyzeImageParams = Type.Object({
	image_path: Type.String({ description: "Image file path. Relative paths resolved via cwd." }),
	question: Type.String({ description: "The question to answer about the image" }),
});

// ──────────────────────── Types ────────────────────────

interface VisionDetails {
	mode: "vision";
	resolvedModel: string;
	memoryId?: string;
	memoryAction?: "create" | "resume";
	memoryFile?: string;
	usage?: {
		input: number;
		output: number;
		turns: number;
		cost: number;
	};
	durationMs?: number;
}

// ──────────────────────── Extension ────────────────────────

export default function visionExtension(pi: ExtensionAPI) {
	// Session-scoped state for memory file tracking
	const sessionMemoryFiles = new Map<string, Set<string>>();
	let lastSessionId = "";

	function getMemoryFiles(sessionId: string): Set<string> {
		let files = sessionMemoryFiles.get(sessionId);
		if (!files) {
			files = new Set();
			sessionMemoryFiles.set(sessionId, files);
		}
		return files;
	}

	pi.registerTool({
		name: "analyze_image",
		label: "Analyze Image",
		description: [
			"Analyze images using a multimodal vision model.",
			"",
			"Spawns a vision subagent with a multimodal model to analyze the specified image.",
			"The image is processed by the vision model only — it never enters the main session context.",
			"Returns text-only analysis conclusions.",
			"",
			"Requires ~/.pi/agent/vision-models.json with at least one vision model entry.",
			"",
			"Supports memory sessions: same image path reuses prior context for follow-up questions.",
		].join("\n"),
		parameters: AnalyzeImageParams,
		promptSnippet: "Analyze images using a multimodal vision model",
		promptGuidelines: [
			"Provide image_path and question — the tool handles model selection and memory internally",
			"Relative paths are resolved via cwd",
			"Same image reuses memory context; different images get independent sessions",
		],

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			cleanupOldTempFiles();

			const sessionId = ctx.sessionManager.getSessionId();
			lastSessionId = sessionId;

			// ── Validate image path ──
			const rawPath = params.image_path as string;
			const absoluteImagePath = path.isAbsolute(rawPath)
				? rawPath
				: path.resolve(ctx.cwd, rawPath);

			if (!fs.existsSync(absoluteImagePath)) {
				return {
					content: [{ type: "text" as const, text: `Image file not found: ${absoluteImagePath}` }],
					details: { mode: "vision" as const, resolvedModel: "" },
					isError: true,
				};
			}

			// ── Resolve vision model ──
			const modelResult = resolveVisionModelSync();
			if (!modelResult.ok) {
				return {
					content: [{ type: "text" as const, text: modelResult.error }],
					details: { mode: "vision" as const, resolvedModel: "" },
					isError: true,
				};
			}

			const resolvedModel = modelResult.ref;
			const resolvedThinking = modelResult.thinkingLevel;

			// ── Build memory session ──
			const memoryId = buildVisionMemoryId(absoluteImagePath);
			const mainSessionFile = ctx.sessionManager.getSessionFile();
			let memorySession: { filePath: string; mainSessionFile: string; action: "create" | "resume" } | undefined;
			let memoryDegraded = false;

			if (mainSessionFile) {
				const filePath = resolveMemorySessionFile(mainSessionFile, memoryId);
				if (filePath) {
					const action = fs.existsSync(filePath) ? "resume" as const : "create" as const;
					memorySession = { filePath, mainSessionFile, action };
					getMemoryFiles(sessionId).add(filePath);
				}
			} else {
				memoryDegraded = true;
			}

			// ── Spawn vision subagent ──
			const question = params.question as string;
			const task = `读取图片 ${absoluteImagePath}，分析以下问题：${question}。仅输出分析结论。`;

			const result = await runSingleVisionAgent({
				task,
				systemPrompt: VISION_SYSTEM_PROMPT,
				resolvedModel,
				thinkingLevel: resolvedThinking,
				cwd: ctx.cwd,
				tools: VISION_ALLOWED_TOOLS,
				signal,
				onUpdate: onUpdate as OnUpdateCallback | undefined,
				memorySession,
			});

			const isError = result.exitCode !== 0
				|| result.stopReason === "error"
				|| result.stopReason === "aborted";

			const details: VisionDetails = {
				mode: "vision",
				resolvedModel,
				usage: {
					input: result.usage.input,
					output: result.usage.output,
					turns: result.usage.turns,
					cost: result.usage.cost,
				},
				durationMs: result.durationMs,
			};

			if (memorySession) {
				details.memoryId = memoryId;
				details.memoryAction = memorySession.action;
				details.memoryFile = memorySession.filePath;
			}

			const degradation = memoryDegraded
				? "\n[Warning: Memory session unavailable — in-memory session, vision context will not persist across calls.]"
				: "";

			if (isError) {
				const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
				return {
					content: [{ type: "text" as const, text: `Vision analysis failed: ${errorMsg}${degradation}` }],
					details,
					isError: true,
				};
			}

			return {
				content: [{ type: "text" as const, text: (getFinalOutput(result.messages) || "(no output)") + degradation }],
				details,
			};
		},

		renderCall(args, theme) {
			const rawPath = args.image_path as string;
			const home = os.homedir();
			const shortPath = rawPath.startsWith(home) ? `~${rawPath.slice(home.length)}` : rawPath;
			const modelDisplay = theme.fg("dim", ` ${loadVisionModels()?.models?.[0]?.id ?? "vision"}`);

			return new Text(
				`${theme.fg("warning", "⏳")} ${theme.fg("toolTitle", theme.bold("analyze_image"))}${modelDisplay}\n  ${theme.fg("accent", shortPath)}`,
				0, 0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const text = result.content[0];
			if (!text || text.type !== "text") return new Text("(no output)", 0, 0);

			const details = result.details as VisionDetails | undefined;

			if (result.isError) {
				return new Text(theme.fg("error", `✗ analyze_image failed\n  ${text.text}`), 0, 0);
			}

			const lines: string[] = [];
			const icon = theme.fg("success", "✓");
			const model = details?.resolvedModel ?? "vision";
			lines.push(`${icon} ${theme.fg("toolTitle", theme.bold("analyze_image"))} ${theme.fg("dim", model)}`);

			if (details?.durationMs) {
				const secs = (details.durationMs / 1000).toFixed(1);
				lines.push(`  ${theme.fg("dim", `${secs}s`)}${details.memoryAction === "resume" ? ` ${theme.fg("dim", "· memory resumed")}` : ""}`);
			}

			if (expanded) {
				lines.push("");
				lines.push(text.text);
			} else {
				const firstLine = text.text.split("\n", 2)[0] ?? "";
				lines.push(`  ${theme.fg("dim", `⎿  ${firstLine.slice(0, 120)}`)}`);
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// ── Cleanup on session shutdown ──
	pi.on("session_shutdown", () => {
		const sessionId = lastSessionId;
		const files = sessionMemoryFiles.get(sessionId);
		if (files) {
			for (const f of files) {
				try { fs.unlinkSync(f); } catch { /* already gone */ }
			}
			files.clear();
			sessionMemoryFiles.delete(sessionId);
		}
	});
}
