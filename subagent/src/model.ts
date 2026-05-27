/**
 * Model resolution logic for the subagent extension.
 *
 * Handles model selection via two paths:
 *   1. taskComplexity (auto-routing from subagent-models.json)
 *   2. explicit model reference ("provider/model" format)
 *
 * Also provides human-readable hints for tool description and error messages.
 *
 * Extracted from index.ts to keep the main extension file focused on
 * tool registration and subprocess management.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("subagent");

// ──────────────────────── Types ────────────────────────

export type TaskComplexity = "low" | "medium" | "high";
export type ThinkingLevel = "high" | "max";

export interface SubagentModelEntry {
	id: string;
	provider?: string;
	"task-complexity"?: TaskComplexity[];
	order: number;
	fallbacks?: Array<{ id: string; provider?: string }>;
}

export interface SubagentModelsConfig {
	models: SubagentModelEntry[];
}

export interface ModelResolutionContext {
	modelRegistry?: {
		getAvailable?: () => Array<{ id: string; provider: string }>;
	};
}

// ──────────────────────── Constants ────────────────────────

/** Map subagent ThinkingLevel to Pi CLI --thinking flag values. */
export const THINKING_TO_PI: Record<ThinkingLevel, string> = {
	high: "high",
	max: "xhigh",
};

export const SUBAGENT_MODELS_PATH = path.join(os.homedir(), ".pi", "agent", "subagent-models.json");
export const VALID_COMPLEXITIES = new Set<TaskComplexity>(["low", "medium", "high"]);

export const COMPLEXITY_DEFAULT_THINKING: Record<TaskComplexity, ThinkingLevel> = {
	low: "high",
	medium: "high",
	high: "max",
};

// ──────────────────────── Internal cache ────────────────────────

/** Cached config with TTL — avoids stale data when users edit subagent-models.json. */
const CACHE_TTL_MS = 60 * 1000; // 1 minute
let _cachedModels: SubagentModelsConfig | null | undefined = undefined;
let _cachedModelsTimestamp = 0;

// ──────────────────────── Config loader ────────────────────────

export function loadSubagentModels(): SubagentModelsConfig | null {
	if (_cachedModels !== undefined && Date.now() - _cachedModelsTimestamp < CACHE_TTL_MS) return _cachedModels;
	try {
		const content = fs.readFileSync(SUBAGENT_MODELS_PATH, "utf-8");
		const parsed = JSON.parse(content) as SubagentModelsConfig;
		// Validate entries: warn on invalid complexity values, skip entries without provider
		if (parsed.models) {
			for (const m of parsed.models) {
				if (m["task-complexity"]) {
					const invalid = m["task-complexity"].filter((c) => !VALID_COMPLEXITIES.has(c));
					if (invalid.length > 0) {
						log.warn(
							`Invalid complexity values in subagent-models.json for ${m.id}: ${invalid.join(", ")}. Valid: low, medium, high.`,
						);
					}
				}
				if (!m.provider) {
					log.warn(
						`Model entry "${m.id}" has no provider field, will be skipped during complexity routing.`,
					);
				}
			}
		}
		_cachedModels = parsed;
		_cachedModelsTimestamp = Date.now();
		return parsed;
	} catch {
		_cachedModels = null;
		_cachedModelsTimestamp = Date.now();
		return null;
	}
}

// ──────────────────────── Hints ────────────────────────

/**
 * Synchronously resolve the first candidate model ref from subagent-models.json
 * for a given complexity level. No ctx / modelRegistry required — purely config-driven.
 * Returns undefined when config is missing, empty, or no candidate has a provider.
 */
export function resolveModelByComplexitySync(
	complexity: TaskComplexity,
): string | undefined {
	const config = loadSubagentModels();
	if (!config?.models?.length) return undefined;
	const candidates = config.models
		.filter((m) => m["task-complexity"]?.includes(complexity))
		.sort((a, b) => a.order - b.order);
	for (const c of candidates) {
		if (c.provider) {
			return `${c.provider}/${c.id}`;
		}
	}
	return undefined;
}

/**
 * Build a human-readable summary of models for tool description (sync).
 * Only reads subagent-models.json — no async model registry access.
 */
export function buildModelsHintFromConfig(): string {
	const config = loadSubagentModels();
	if (!config || !config.models?.length) {
		return [
			"No subagent-models.json configured.",
			"When taskComplexity is used without this file, you MUST specify 'model' explicitly.",
			"Create ~/.pi/agent/subagent-models.json to enable automatic model routing.",
		].join("\n");
	}

	const complexityLabels: Record<string, string> = {
		low: 'taskComplexity: "low"     (simple: grep, format, batch replace)',
		medium: 'taskComplexity: "medium"  (moderate: code review, tests, bug fix)',
		high: 'taskComplexity: "high"    (complex: architecture, multi-file refactor)',
	};
	const byComplexity: Record<string, string[]> = { low: [], medium: [], high: [] };
	const uncategorized: string[] = [];

	for (const m of config.models) {
		if (!m.provider) continue;
		const ref = `${m.provider}/${m.id}`;

		if (m["task-complexity"]?.length) {
			for (const c of m["task-complexity"]) {
				if (c in byComplexity) byComplexity[c].push(ref);
			}
		} else {
			uncategorized.push(ref);
		}
	}

	const lines: string[] = ["YOUR MODEL OPTIONS (from ~/.pi/agent/subagent-models.json):"];
	for (const [level, models] of Object.entries(byComplexity)) {
		if (models.length > 0) {
			lines.push("");
			lines.push(`  ${complexityLabels[level]}`);
			lines.push(`    → selects: ${models.join(", ")}`);
		}
	}
	if (uncategorized.length > 0) {
		lines.push("");
		lines.push(`  Explicit model: ${uncategorized.join(", ")}`);
	}
	return lines.join("\n");
}

/**
 * Build a dynamic models hint for error messages (async).
 * Three-tier fallback: subagent-models.json → scoped models → guidance.
 */
export async function buildModelsHintDynamic(ctx: ModelResolutionContext): Promise<string> {
	// Tier 1: subagent-models.json
	const config = loadSubagentModels();
	if (config?.models?.length) {
		return buildModelsHintFromConfig();
	}

	// Tier 2: scoped models from registry
	let scopedModels: Array<{ id: string; provider: string }> = [];
	try {
		scopedModels = ctx.modelRegistry?.getAvailable?.() ?? [];
	} catch {
		/* ignore */
	}

	if (scopedModels.length > 0) {
		const lines: string[] = [
			"No subagent-models.json configured — automatic taskComplexity routing is unavailable.",
			"You MUST specify 'model' explicitly using one of these scoped models:",
			"",
		];
		for (const m of scopedModels) {
			lines.push(`  model: "${m.provider}/${m.id}"`);
		}
		lines.push("");
		lines.push("Tip: Create ~/.pi/agent/subagent-models.json to enable taskComplexity auto-routing.");
		return lines.join("\n");
	}

	// Tier 3: nothing available
	return [
		"No models configured anywhere.",
		"1. Create ~/.pi/agent/subagent-models.json with model entries for taskComplexity routing.",
		"2. Or specify 'model: provider/model-id' explicitly if you know the model name.",
	].join("\n");
}

// ──────────────────────── Fallback resolution ────────────────────────

export function getFallbackRefsForModel(modelRef: string): string[] {
	const config = loadSubagentModels();
	if (!config) return [];
	for (const entry of config.models) {
		if (!entry.provider) continue;
		const entryRef = `${entry.provider}/${entry.id}`;
		if (entryRef === modelRef && entry.fallbacks?.length) {
			return entry.fallbacks
				.filter((fb) => fb.provider)
				.map((fb) => `${fb.provider!}/${fb.id}`);
		}
	}
	return [];
}

// ──────────────────────── Model resolution ────────────────────────

export async function resolveModelByComplexity(
	complexity: TaskComplexity,
	ctx: ModelResolutionContext,
): Promise<{ ok: true; ref: string } | { ok: false; error: string }> {
	const config = loadSubagentModels();
	if (!config || !config.models?.length) {
		return { ok: false, error: `subagent-models.json not found or empty at ${SUBAGENT_MODELS_PATH}` };
	}

	const candidates = config.models
		.filter((m) => m["task-complexity"]?.includes(complexity))
		.sort((a, b) => a.order - b.order);

	if (candidates.length === 0) {
		return { ok: false, error: `No models configured for complexity "${complexity}" in subagent-models.json` };
	}

	for (const candidate of candidates) {
		if (!candidate.provider) continue;
		const modelRef = `${candidate.provider}/${candidate.id}`;
		const result = await resolveModel(modelRef, ctx);
		if (result.ok) return result;
	}

	const tried = candidates.map((c) => `${c.provider ?? "?"}/${c.id}`).join(", ");
	return { ok: false, error: `All candidate models unavailable for complexity "${complexity}": ${tried}` };
}

export async function resolveModel(
	modelRef: string,
	ctx: ModelResolutionContext,
): Promise<{ ok: true; ref: string } | { ok: false; error: string }> {
	const slashIndex = modelRef.indexOf("/");
	if (slashIndex <= 0 || slashIndex === modelRef.length - 1) {
		return {
			ok: false,
			error: `Model must be in "provider/model" format. Got: "${modelRef}".`,
		};
	}

	const provider = modelRef.substring(0, slashIndex);
	const modelId = modelRef.substring(slashIndex + 1);

	let models: Array<{ id: string; provider: string }>;
	try {
		models = ctx.modelRegistry?.getAvailable?.() ?? [];
	} catch {
		models = [];
	}

	if (models.length === 0) {
		// Cannot validate — pass through to CLI
		return { ok: true, ref: modelRef };
	}

	const match = models.find((m) => m.provider === provider && m.id === modelId);
	if (match) {
		return { ok: true, ref: `${match.provider}/${match.id}` };
	}

	// Try fallback models from subagent-models.json config
	const fallbackRefs = getFallbackRefsForModel(modelRef);
	for (const fallbackRef of fallbackRefs) {
		const fbSlash = fallbackRef.indexOf("/");
		if (fbSlash <= 0) continue;
		const fbProvider = fallbackRef.substring(0, fbSlash);
		const fbModelId = fallbackRef.substring(fbSlash + 1);
		const fbMatch = models.find((m) => m.provider === fbProvider && m.id === fbModelId);
		if (fbMatch) {
			return { ok: true, ref: `${fbMatch.provider}/${fbMatch.id}` };
		}
	}

	const lines = models.map((m) => `  - ${m.id} (${m.provider})`).join("\n");
	return {
		ok: false,
		error: `Model "${modelRef}" not found in scoped models (fallbacks also unavailable).\nAvailable models:\n${lines}\n\nTip: Use taskComplexity instead of model for automatic selection.`,
	};
}
