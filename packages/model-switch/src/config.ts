/**
 * Model Switch — 配置文件加载 + 类型定义
 *
 * 从 ~/.pi/agent/model-policy.json 加载配置。
 * 文件不存在或格式错误时返回 null（降级模式）。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── 类型定义 ────────────────────────────────────────────

export interface ModelEntry {
	/** Pi provider 名（如 "zhipu"） */
	provider: string;
	/** Pi model ID（如 "glm-5.1-plus"） */
	modelId: string;
	/** 套餐标识（关联 plans 中的 key） */
	plan: string;
	/** 模型能力标记 */
	capabilities: string[];
}

export interface PlanConfig {
	/** 优先级（越小越优先） */
	priority: number;
	/** 高峰期配置 */
	peak?: {
		/** 开始小时（24h，含） */
		start: number;
		/** 结束小时（24h，不含） */
		end: number;
		/** 倍率 */
		multiplier: number;
	};
	/** 预算目标百分比（如 80 = 用完 80% 后考虑切换） */
	budgetTarget?: number;
}

export interface StickinessConfig {
	/** 连续 turn 数阈值 */
	minTurns: number;
	/** 累积 input tokens 阈值 */
	minInputTokens: number;
}

export interface ModelPolicy {
	version: number;
	models: Record<string, ModelEntry>;
	scenes: Record<string, string[]>;
	plans: Record<string, PlanConfig>;
	stickiness: StickinessConfig;
}

// ── 配置加载 ─────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".pi", "agent", "model-policy.json");

/**
 * 加载模型策略配置文件。
 * 文件不存在、JSON 解析失败、或 version 不为 1 时返回 null。
 */
export function loadConfig(): ModelPolicy | null {
	if (!existsSync(CONFIG_PATH)) {
		return null;
	}

	let raw: unknown;
	try {
		const content = readFileSync(CONFIG_PATH, "utf-8");
		raw = JSON.parse(content);
	} catch (err) {
		console.warn(`[model-switch] Failed to parse ${CONFIG_PATH}:`, err);
		return null;
	}

	if (typeof raw !== "object" || raw === null) {
		console.warn(`[model-switch] Invalid config: expected object`);
		return null;
	}

	const config = raw as Record<string, unknown>;

	if (config.version !== 1) {
		console.warn(`[model-switch] Unsupported config version: ${String(config.version)}`);
		return null;
	}

	// 浅校验必要字段
	if (!config.models || typeof config.models !== "object") {
		console.warn(`[model-switch] Config missing "models"`);
		return null;
	}
	if (!config.scenes || typeof config.scenes !== "object") {
		console.warn(`[model-switch] Config missing "scenes"`);
		return null;
	}
	if (!config.plans || typeof config.plans !== "object") {
		console.warn(`[model-switch] Config missing "plans"`);
		return null;
	}
	if (!config.stickiness || typeof config.stickiness !== "object") {
		console.warn(`[model-switch] Config missing "stickiness"`);
		return null;
	}

	return config as unknown as ModelPolicy;
}
