/**
 * @zhushanwen/pi-vision — Image analysis tool using multimodal vision models.
 *
 * Spawns a dedicated Pi child process with a vision-capable model to analyze images.
 * Supports fork context: inherits parent session for context-aware analysis.
 * Reads model configuration from ~/.pi/agent/vision-models.json.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, type Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "typebox";
import {
	VISION_ALLOWED_TOOLS,
	VISION_SYSTEM_PROMPT,
	FORK_PREAMBLE,
	loadVisionModels,
	resolveVisionModelSync,
} from "./vision-model.js";
import {
	type OnUpdateCallback,
	
	cleanupOldTempFiles,
	getFinalOutput,
	runSingleVisionAgent,
} from "./spawn.js";

// ──────────────────────── Parameters ────────────────────────

const AnalyzeImageParams = Type.Object({
	image_path: Type.String({ description: "Image file path. Relative paths resolved via cwd." }),
	question: Type.String({ description: "The question to answer about the image" }),
	context: Type.Optional(Type.String({
		enum: ["fresh", "fork"],
		description: "Context mode: 'fork' inherits parent session so the vision agent understands prior discussion (e.g. what bug you're investigating). 'fresh' starts clean. Default: 'fresh'.",
	})),
});

// ──────────────────────── Types ────────────────────────

interface VisionDetails {
	mode: "vision";
	resolvedModel: string;
	context: "fresh" | "fork";
	usage?: {
		input: number;
		output: number;
		turns: number;
		cost: number;
	};
	durationMs?: number;
}

/**
 * Copy parent session file to a temp location for fork context.
 * Simple approach: file copy + pass as --session to child process.
 * The child Pi process will resume from the copied session.
 */
function createForkSessionFile(parentSessionFile: string): string | undefined {
	try {
		if (!fs.existsSync(parentSessionFile)) return undefined;
		const dir = path.join(os.tmpdir(), "pi-vision");
		fs.mkdirSync(dir, { recursive: true });
		const forkFile = path.join(dir, `fork-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
		fs.copyFileSync(parentSessionFile, forkFile);
		return forkFile;
	} catch {
		return undefined;
	}
}

// ──────────────────────── Extension ────────────────────────

export default function visionExtension(pi: ExtensionAPI) {
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
			"Context modes:",
			"- 'fresh' (default): clean session, no prior context.",
			"- 'fork': inherits parent session so the vision agent understands what you've been discussing (e.g. which bug, what code change, what error). Use this when the image analysis needs context from the current conversation.",
		].join("\n"),
		parameters: AnalyzeImageParams,
		promptSnippet: "Analyze images using a multimodal vision model",
		promptGuidelines: [
			"Provide image_path and question — the tool handles model selection internally",
			"Relative paths are resolved via cwd",
			"Use context: 'fork' when the image analysis needs to understand prior discussion (e.g. analyzing a screenshot of an error the user just described)",
		],

		async execute(_toolCallId: string, params: Static<typeof AnalyzeImageParams>, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
			cleanupOldTempFiles();

			// ── Validate image path ──
			const rawPath = params.image_path as string;
			const absoluteImagePath = path.isAbsolute(rawPath)
				? rawPath
				: path.resolve(ctx.cwd, rawPath);

			if (!fs.existsSync(absoluteImagePath)) {
				return {
					content: [{ type: "text" as const, text: `Image file not found: ${absoluteImagePath}` }],
					details: { mode: "vision" as const, resolvedModel: "", context: "fresh" as const },
					isError: true,
				};
			}

			// ── Resolve vision model ──
			const modelResult = resolveVisionModelSync();
			if (!modelResult.ok) {
				return {
					content: [{ type: "text" as const, text: modelResult.error }],
					details: { mode: "vision" as const, resolvedModel: "", context: "fresh" as const },
					isError: true,
				};
			}

			const resolvedModel = modelResult.ref;
			const resolvedThinking = modelResult.thinkingLevel;

			// ── Resolve context mode ──
			const contextMode: "fresh" | "fork" = params.context === "fork" ? "fork" : "fresh";
			let forkSessionFile: string | undefined;
			let forkDegraded = false;

			if (contextMode === "fork") {
				const parentSessionFile = ctx.sessionManager.getSessionFile();

				if (parentSessionFile) {
					forkSessionFile = createForkSessionFile(parentSessionFile);
				}
				if (!forkSessionFile) {
					forkDegraded = true;
				}
			}

			// ── Build task ──
			const question = params.question as string;
			const effectiveContext = contextMode === "fork" && !forkDegraded ? "fork" : "fresh";
			const task = effectiveContext === "fork"
				? `${FORK_PREAMBLE}\n\nTask:\n读取图片 ${absoluteImagePath}，结合之前讨论的上下文，分析以下问题：${question}。仅输出分析结论。`
				: `读取图片 ${absoluteImagePath}，分析以下问题：${question}。仅输出分析结论。`;

			// ── Spawn vision subagent ──
			const result = await runSingleVisionAgent({
				task,
				systemPrompt: VISION_SYSTEM_PROMPT,
				resolvedModel,
				thinkingLevel: resolvedThinking,
				cwd: ctx.cwd,
				tools: VISION_ALLOWED_TOOLS,
				signal,
				onUpdate: onUpdate as OnUpdateCallback | undefined,
				forkSessionFile,
			});

			const isError = result.exitCode !== 0
				|| result.stopReason === "error"
				|| result.stopReason === "aborted";

			const details: VisionDetails = {
				mode: "vision",
				resolvedModel,
				context: effectiveContext,
				usage: {
					input: result.usage.input,
					output: result.usage.output,
					turns: result.usage.turns,
					cost: result.usage.cost,
				},
				durationMs: result.durationMs,
			};

			const degradation = forkDegraded && contextMode === "fork"
				? "\n[Warning: Fork session unavailable — fell back to fresh context.]"
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

		renderCall(args: any, theme: Theme) {
			const rawPath = args.image_path as string;
			const home = os.homedir();
			const shortPath = rawPath.startsWith(home) ? `~${rawPath.slice(home.length)}` : rawPath;
			const modelDisplay = theme.fg("dim", ` ${loadVisionModels()?.models?.[0]?.id ?? "vision"}`);
			const ctxLabel = args.context === "fork" ? theme.fg("accent", " [fork]") : "";

			return new Text(
				`${theme.fg("warning", "⏳")} ${theme.fg("toolTitle", theme.bold("analyze_image"))}${modelDisplay}${ctxLabel}\n  ${theme.fg("accent", shortPath)}`,
				0, 0,
			);
		},

		renderResult(result: any, { expanded }: any, theme: Theme) {
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
				const forkLabel = details.context === "fork" ? ` ${theme.fg("dim", "· forked")}` : "";
				lines.push(`  ${theme.fg("dim", `${secs}s`)}${forkLabel}`);
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
}
