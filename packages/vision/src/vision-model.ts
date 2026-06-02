/**
 * Vision model configuration and resolution for image analysis.
 *
 * Loads vision model entries from ~/.pi/agent/vision-models.json,
 * selects the best available model with fallback chain,
 * and generates memory session identifiers.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

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
	"你是图片分析助手。你的唯一任务是：读取指定图片，根据用户的问题给出分析结论。",
	"",
	"约束：",
	"- 仅输出分析结论，不要修改任何文件",
	"- 不要执行任何写入操作（edit、write 等）",
	"- 如果图片无法读取，直接说明原因",
	"- 回答使用中文",
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
const THINKING_TO_PI: Record<ThinkingLevel, string> = {
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

// ──────────────────────── Thinking Level ────────────────────────

export function thinkingToPi(level: ThinkingLevel): string {
	return THINKING_TO_PI[level];
}

// ──────────────────────── Memory ID ────────────────────────

function sanitizeMemoryId(memory: string): string {
	const truncated = memory.length > 56 ? memory.slice(0, 56) : memory;
	const sanitized = truncated.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	const hash = createHash("sha256").update(memory).digest("hex").slice(0, 8);
	return `${sanitized}-${hash}`;
}

export function buildVisionMemoryId(imagePath: string): string {
	const hash = createHash("sha256").update(imagePath).digest("hex").slice(0, 8);
	return sanitizeMemoryId(`vision-${hash}`);
}

// ──────────────────────── Memory Session ────────────────────────

export function resolveMemorySessionFile(
	mainSessionFile: string,
	memoryId: string,
): string | null {
	if (!mainSessionFile) return null;
	const baseName = path.basename(mainSessionFile, ".jsonl");
	const dir = path.dirname(mainSessionFile);
	const sanitized = sanitizeMemoryId(memoryId);
	return path.join(dir, `${baseName}.mem-${sanitized}.jsonl`);
}
