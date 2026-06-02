/**
 * Model Switch — 配置文件加载
 *
 * 从 ~/.pi/agent/extensions/model-switch/model-policy.json 加载配置。
 * 文件不存在或格式错误时返回 null（降级模式）。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelPolicy } from "./types";

const CONFIG_DIR = join(homedir(), ".pi", "agent", "extensions", "model-switch");
const CONFIG_PATH = join(CONFIG_DIR, "model-policy.json");

export { CONFIG_PATH };

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
		console.warn("[model-switch] Invalid config: expected object");
		return null;
	}

	const config = raw as Record<string, unknown>;

	if (config.version !== 1) {
		console.warn(`[model-switch] Unsupported config version: ${String(config.version)}`);
		return null;
	}

	if (!config.models || typeof config.models !== "object") {
		console.warn('[model-switch] Config missing "models"');
		return null;
	}
	if (!config.scenes || typeof config.scenes !== "object") {
		console.warn('[model-switch] Config missing "scenes"');
		return null;
	}
	if (!config.plans || typeof config.plans !== "object") {
		console.warn('[model-switch] Config missing "plans"');
		return null;
	}
	if (!config.stickiness || typeof config.stickiness !== "object") {
		console.warn('[model-switch] Config missing "stickiness"');
		return null;
	}

	const typed = config as unknown as ModelPolicy;
	applyDefaults(typed);
	return typed;
}

/** 向后兼容：为旧配置填充新字段默认值 */
function applyDefaults(config: ModelPolicy): void {
	for (const plan of Object.values(config.plans)) {
		if (plan.peakStrategy === undefined) plan.peakStrategy = "conserve";
		if (plan.rollingWindowHours === undefined) plan.rollingWindowHours = 5;
		if (plan.thresholds === undefined) {
			plan.thresholds = { rollingLimitPct: 80, weeklyLimitPct: 80 };
		} else {
			if (plan.thresholds.rollingLimitPct === undefined) plan.thresholds.rollingLimitPct = 80;
			if (plan.thresholds.weeklyLimitPct === undefined) plan.thresholds.weeklyLimitPct = 80;
		}
	}
}
