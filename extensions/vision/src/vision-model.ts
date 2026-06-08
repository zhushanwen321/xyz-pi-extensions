/**
 * Vision model configuration and resolution for image analysis.
 *
 * Loads vision model entries from ~/.pi/agent/vision-models.json,
 * selects the best available model with fallback chain.
 *
 * State (cached config + timestamp) is encapsulated in the
 * `createVisionModelApi()` factory closure so multiple extension
 * instances do not share cache state.
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

export interface ResolvedModelEntry {
	ref: string;
	thinkingLevel?: ThinkingLevel;
}

export interface VisionModelApi {
	loadVisionModels: () => VisionModelsConfig | null;
	resolveVisionModelsSync: () => ResolvedModelEntry[];
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

// ── Constants ───────────────────────────────────────

const SEC_PER_MIN = 60;
const MS_PER_SEC = 1000;

// ──────────────────────── Fork ────────────────────────

export const FORK_PREAMBLE =
	"You are a delegated vision analysis agent running from a fork of the parent session. " +
	"Treat the inherited conversation as reference-only context, not a live thread to continue. " +
	"Do not continue or answer prior messages as if they are waiting for a reply. " +
	"Your sole job is to analyze the specified image and return focused conclusions using your tools.";

// ──────────────────────── Factory ────────────────────────

/**
 * Create a stateful vision-model API bound to a single extension instance.
 * Cache state lives in the closure to avoid cross-instance pollution.
 */
export function createVisionModelApi(): VisionModelApi {
	const CACHE_TTL_MS = SEC_PER_MIN * MS_PER_SEC;
	let cachedConfig: VisionModelsConfig | null | undefined = undefined;
	let cachedConfigTimestamp = 0;

	function loadVisionModels(): VisionModelsConfig | null {
		if (cachedConfig !== undefined && Date.now() - cachedConfigTimestamp < CACHE_TTL_MS) {
			return cachedConfig;
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
			cachedConfig = parsed;
			cachedConfigTimestamp = Date.now();
			return parsed;
		} catch {
			cachedConfig = null;
			cachedConfigTimestamp = Date.now();
			return null;
		}
	}

	/**
	 * Resolve all vision model candidates from config, ordered by priority.
	 * Caller should try each in order, falling back on failure.
	 */
	function resolveVisionModelsSync(): ResolvedModelEntry[] {
		const config = loadVisionModels();
		if (!config?.models?.length) return [];

		return [...config.models]
			.filter((m) => m.provider)
			.sort((a, b) => a.order - b.order)
			.map((m) => ({
				ref: `${m.provider}/${m.id}`,
				thinkingLevel: m.thinkingLevel,
			}));
	}

	return { loadVisionModels, resolveVisionModelsSync };
}
