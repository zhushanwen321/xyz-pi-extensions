/**
 * Vision model configuration and resolution for image analysis.
 *
 * Loads vision model entries from ~/.pi/agent/vision-models.json,
 * selects the best available model with fallback chain.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ──────────────────────── Types ────────────────────────

export type ThinkingLevel = "high" | "max";

export interface VisionModelEntry {
	id: string;
	provider: string;
	order: number;
	thinkingLevel?: ThinkingLevel;
	fallbacks?: Array<{ id: string; provider: string }>;
}

export interface VisionModelsConfig {
	models: VisionModelEntry[];
}

// ──────────────────────── Constants ────────────────────────

export const VISION_MODELS_PATH = path.join(os.homedir(), ".pi", "agent", "vision-models.json");
export const VISION_ALLOWED_TOOLS = "read,bash,grep";

export const VISION_SYSTEM_PROMPT = [
	"You are an image analysis assistant. Your sole task: read the specified image and provide analysis conclusions based on the user's question.",
	"",
	"Constraints:",
	"- Output analysis conclusions only — do not modify any files",
	"- Do not perform any write operations (edit, write, etc.)",
	"- If the image cannot be read, state the reason directly",
	"- Respond in the same language as the user's question",
].join("\n");

const EXAMPLE_CONFIG = JSON.stringify({
	models: [
		{
			id: "glm-4.6v",
			provider: "router-openai",
			order: 1,
			thinkingLevel: "high",
			fallbacks: [{ id: "qwen-vl-max", provider: "router-openai" }],
		},
	],
}, null, 2);

/** Map vision ThinkingLevel to Pi CLI --thinking flag values. */
const _THINKING_TO_PI: Record<ThinkingLevel, string> = {
	high: "high",
	max: "xhigh",
};

// ──────────────────────── Internal cache ────────────────────────

const CACHE_TTL_MS = 60 * 1000;
let _cachedConfig: VisionModelsConfig | null | undefined = undefined;
let _cachedConfigTimestamp = 0;

// ──────────────────────── Config loader ────────────────────────

export function loadVisionModels(): VisionModelsConfig | null {
	if (_cachedConfig !== undefined && Date.now() - _cachedConfigTimestamp < CACHE_TTL_MS) {
		return _cachedConfig;
	}
	try {
		const content = fs.readFileSync(VISION_MODELS_PATH, "utf-8");
		const parsed = JSON.parse(content) as VisionModelsConfig;
		if (parsed.models) {
			for (const m of parsed.models) {
				if (!m.provider) {
					console.warn(`[vision] Model entry "${m.id}" has no provider field, will be skipped.`);
				}
			}
		}
		_cachedConfig = parsed;
		_cachedConfigTimestamp = Date.now();
		return parsed;
	} catch {
		_cachedConfig = null;
		_cachedConfigTimestamp = Date.now();
		return null;
	}
}

// ──────────────────────── Model resolution ────────────────────────

/**
 * Select the first available vision model from config.
 * Returns the model ref and its thinking level.
 */
export function resolveVisionModelSync(): { ok: true; ref: string; thinkingLevel?: ThinkingLevel } | { ok: false; error: string } {
	const config = loadVisionModels();
	if (!config?.models?.length) {
		return {
			ok: false,
			error: [
				`vision-models.json not found or empty at ${VISION_MODELS_PATH}`,
				"Create the file with vision model entries. Example format:",
				EXAMPLE_CONFIG,
			].join("\n\n"),
		};
	}

	const candidates = [...config.models]
		.filter((m) => m.provider)
		.sort((a, b) => a.order - b.order);

	if (candidates.length === 0) {
		return {
			ok: false,
			error: `No valid vision model entries in ${VISION_MODELS_PATH}. All entries are missing provider field.`,
		};
	}

	// Return first candidate (runtime will validate availability)
	const best = candidates[0]!;
	return {
		ok: true,
		ref: `${best.provider}/${best.id}`,
		thinkingLevel: best.thinkingLevel,
	};
}
// ──────────────────────── Fork ────────────────────────

export const FORK_PREAMBLE =
	"You are a delegated vision analysis agent running from a fork of the parent session. " +
	"Treat the inherited conversation as reference-only context, not a live thread to continue. " +
	"Do not continue or answer prior messages as if they are waiting for a reply. " +
	"Your sole job is to analyze the specified image and return focused conclusions using your tools.";
