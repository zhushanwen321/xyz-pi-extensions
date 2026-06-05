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

import { type AgentToolResult, type ExtensionAPI, type ExtensionContext, type Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static,Type } from "typebox";

import {
	cleanupOldTempFiles,
	getFinalOutput,
	type OnUpdateCallback,
	runSingleVisionAgent,
	type VisionResult,
} from "./spawn.js";
import {
	createVisionModelApi,
	FORK_PREAMBLE,
	VISION_ALLOWED_TOOLS,
	VISION_SYSTEM_PROMPT,
} from "./vision-model.js";

// ── Constants ───────────────────────────────────────

const FORK_ID_RADIX = 36;
const FORK_ID_SLICE_START = 2;
const FORK_ID_SLICE_END = 8;
const MS_PER_SEC = 1000;
const OUTPUT_PREVIEW_SLICE_LIMIT = 120;
const TEXT_SPLIT_FIRST_N = 2;
const EMPTY_MODEL_DETAILS: VisionDetails = {
	mode: "vision",
	resolvedModel: "",
	context: "fresh",
};
const FORK_DEGRADED_WARNING = "\n[Warning: Fork session unavailable — fell back to fresh context.]";

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

type VisionToolResult = AgentToolResult<VisionDetails> & { isError?: boolean };

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
		const forkFile = path.join(dir, `fork-${Date.now()}-${Math.random().toString(FORK_ID_RADIX).slice(FORK_ID_SLICE_START, FORK_ID_SLICE_END)}.jsonl`);
		fs.copyFileSync(parentSessionFile, forkFile);
		return forkFile;
	} catch (forkErr) {
		console.warn("[vision] createForkSessionFile failed:", forkErr);
		return undefined;
	}
}

// ──────────────────────── Execute helpers ────────────────────────

/** Validate image path; returns either the resolved absolute path or an error result. */
function validateImagePath(
	params: Static<typeof AnalyzeImageParams>,
	cwd: string,
): { ok: true; path: string } | { ok: false; result: VisionToolResult } {
	const absoluteImagePath = path.isAbsolute(params.image_path)
		? params.image_path
		: path.resolve(cwd, params.image_path);

	if (!fs.existsSync(absoluteImagePath)) {
		return {
			ok: false,
			result: {
				content: [{ type: "text" as const, text: `Image file not found: ${absoluteImagePath}` }],
				details: { ...EMPTY_MODEL_DETAILS },
				isError: true,
			},
		};
	}
	return { ok: true, path: absoluteImagePath };
}

/** Build the "no vision model configured" error result. */
function buildMissingModelResult(error: string): VisionToolResult {
	return {
		content: [{ type: "text" as const, text: error }],
		details: { ...EMPTY_MODEL_DETAILS },
		isError: true,
	};
}

/** Resolve fork session file for `fork` mode, recording whether fallback occurred. */
function resolveForkContext(
	contextMode: "fresh" | "fork",
	ctx: ExtensionContext,
): { forkSessionFile: string | undefined; forkDegraded: boolean } {
	if (contextMode !== "fork") {
		return { forkSessionFile: undefined, forkDegraded: false };
	}
	const parentSessionFile = ctx.sessionManager.getSessionFile();
	const forkSessionFile = parentSessionFile
		? createForkSessionFile(parentSessionFile)
		: undefined;
	return { forkSessionFile, forkDegraded: !forkSessionFile };
}

/** Build the task prompt sent to the vision subagent. */
function buildVisionTask(
	question: string,
	absoluteImagePath: string,
	effectiveContext: "fresh" | "fork",
): string {
	return effectiveContext === "fork"
		? `${FORK_PREAMBLE}\n\nTask:\nRead image ${absoluteImagePath}, considering the prior discussion context, analyze: ${question}. Output analysis conclusions only.`
		: `Read image ${absoluteImagePath}, analyze: ${question}. Output analysis conclusions only.`;
}

/** Build the structured details payload attached to the tool result. */
function buildVisionDetails(
	result: VisionResult,
	resolvedModel: string,
	effectiveContext: "fresh" | "fork",
): VisionDetails {
	return {
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
}

/** Build the final tool result (error or success) with optional degradation warning. */
function buildVisionResult(
	result: VisionResult,
	details: VisionDetails,
	degradation: string,
): VisionToolResult {
	const isError = result.exitCode !== 0
		|| result.stopReason === "error"
		|| result.stopReason === "aborted";

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
}

// ──────────────────────── Extension ────────────────────────

export default function visionExtension(pi: ExtensionAPI) {
	// Per-instance state: vision-model cache is owned by the factory closure.
	const visionModel = createVisionModelApi();

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

		async execute(_toolCallId: string, params: Static<typeof AnalyzeImageParams>, signal: AbortSignal | undefined, onUpdate: ((update: unknown) => void) | undefined, ctx: ExtensionContext) {
			cleanupOldTempFiles();

			const pathCheck = validateImagePath(params, ctx.cwd);
			if (!pathCheck.ok) return pathCheck.result;
			const absoluteImagePath = pathCheck.path;

			const modelResult = visionModel.resolveVisionModelSync();
			if (!modelResult.ok) return buildMissingModelResult(modelResult.error);
			const resolvedModel = modelResult.ref;
			const resolvedThinking = modelResult.thinkingLevel;

			const contextMode: "fresh" | "fork" = params.context === "fork" ? "fork" : "fresh";
			const { forkSessionFile, forkDegraded } = resolveForkContext(contextMode, ctx);

			const effectiveContext: "fresh" | "fork" = contextMode === "fork" && !forkDegraded ? "fork" : "fresh";
			const task = buildVisionTask(params.question, absoluteImagePath, effectiveContext);

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

			const details = buildVisionDetails(result, resolvedModel, effectiveContext);
			const degradation = forkDegraded && contextMode === "fork" ? FORK_DEGRADED_WARNING : "";
			return buildVisionResult(result, details, degradation);
		},

		renderCall(args: Record<string, unknown>, theme: Theme) {
			const rawPath = args.image_path as string;
			const home = os.homedir();
			const shortPath = rawPath.startsWith(home) ? `~${rawPath.slice(home.length)}` : rawPath;
			const modelDisplay = theme.fg("dim", ` ${visionModel.loadVisionModels()?.models?.[0]?.id ?? "vision"}`);
			const ctxLabel = args.context === "fork" ? theme.fg("accent", " [fork]") : "";

			return new Text(
				`${theme.fg("warning", "⏳")} ${theme.fg("toolTitle", theme.bold("analyze_image"))}${modelDisplay}${ctxLabel}\n  ${theme.fg("accent", shortPath)}`,
				0, 0,
			);
		},

		renderResult(result: { content: Array<{ type: string; text: string }>; details?: VisionDetails; isError?: boolean }, { expanded }: { expanded?: boolean }, theme: Theme) {
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
				const secs = (details.durationMs / MS_PER_SEC).toFixed(1);
				const forkLabel = details.context === "fork" ? ` ${theme.fg("dim", "· forked")}` : "";
				lines.push(`  ${theme.fg("dim", `${secs}s`)}${forkLabel}`);
			}

			if (expanded) {
				lines.push("");
				lines.push(text.text);
			} else {
				const firstLine = text.text.split("\n", TEXT_SPLIT_FIRST_N)[0] ?? "";
				lines.push(`  ${theme.fg("dim", `⎿  ${firstLine.slice(0, OUTPUT_PREVIEW_SLICE_LIMIT)}`)}`);
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
