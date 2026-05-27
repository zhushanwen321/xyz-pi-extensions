/**
 * Vision model configuration and resolution for image analysis.
 *
 * Handles loading vision model entries from ~/.pi/agent/vision-models.json,
 * selecting the best available model with fallback chain, and generating
 * memory session identifiers for vision subagent calls.
 *
 * Separated from model.ts because vision models have a different config file,
 * different selection criteria (no taskComplexity), and a fixed tool set.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ModelResolutionContext, ThinkingLevel } from "./model.js";
import { resolveModel } from "./model.js";
import { sanitizeMemoryId } from "./spawn.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("subagent");

// ──────────────────────── Types ────────────────────────

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

/** Fixed system prompt restricting vision subagent to read-only analysis. */
export const VISION_SYSTEM_PROMPT = [
	"你是图片分析助手。你的唯一任务是：读取指定图片，根据用户的问题给出分析结论。",
	"",
	"约束：",
	"- 仅输出分析结论，不要修改任何文件",
	"- 不要执行任何写入操作（edit、write 等）",
	"- 如果图片无法读取，直接说明原因",
	"- 回答使用中文",
].join("\n");

/** Example config shown in error messages when vision-models.json is missing. */
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

// ──────────────────────── Internal cache ────────────────────────

const CACHE_TTL_MS = 60 * 1000; // 1 minute
let _cachedConfig: VisionModelsConfig | null | undefined = undefined;
let _cachedConfigTimestamp = 0;

// ──────────────────────── Config loader ────────────────────────

/**
 * Load and parse vision-models.json with 1-minute cache TTL.
 * Returns null if file is missing, unreadable, or contains invalid JSON.
 * Warns on entries with missing fields.
 */
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
					log.warn(`Vision model entry "${m.id}" has no provider field, will be skipped.`);
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
 * Select the best available vision model from config.
 * Tries entries in order, falling back to each entry's fallback chain.
 * Validates against the Pi model registry via resolveModel().
 */
export async function resolveVisionModel(
	ctx: ModelResolutionContext,
): Promise<{ ok: true; ref: string; thinkingLevel?: ThinkingLevel } | { ok: false; error: string }> {
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

	for (const candidate of candidates) {
		const modelRef = `${candidate.provider}/${candidate.id}`;
		const result = await resolveModel(modelRef, ctx);
		if (result.ok) {
			return { ok: true, ref: result.ref, thinkingLevel: candidate.thinkingLevel };
		}
		// Try fallbacks for this candidate
		if (candidate.fallbacks?.length) {
			for (const fb of candidate.fallbacks) {
				if (!fb.provider) continue;
				const fbRef = `${fb.provider}/${fb.id}`;
				const fbResult = await resolveModel(fbRef, ctx);
				if (fbResult.ok) {
					return { ok: true, ref: fbResult.ref, thinkingLevel: candidate.thinkingLevel };
				}
			}
		}
	}

	const tried = candidates.map((c) => `${c.provider}/${c.id}`).join(", ");
	return {
		ok: false,
		error: `All vision models unavailable. Tried: ${tried}`,
	};
}

// ──────────────────────── Memory ID ────────────────────────

/**
 * Generate a memory session identifier from an image path.
 * Uses SHA-256 hash (first 8 chars) for collision resistance,
 * then sanitizes for safe filename generation.
 */
export function buildVisionMemoryId(imagePath: string): string {
	const hash = createHash("sha256").update(imagePath).digest("hex").slice(0, 8);
	return sanitizeMemoryId(`vision-${hash}`);
}
