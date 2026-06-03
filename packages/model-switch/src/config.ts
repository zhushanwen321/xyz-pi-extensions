/**
 * Model Switch — 配置文件加载
 *
 * 从 ~/.pi/agent/extensions/model-switch/model-policy.json 加载配置。
 * v2 格式：models 以 provider 名为 key，内嵌 models 表；plans 以 plan 名为 key。
 * v1 格式不再兼容，运行 setup 重新生成。
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
 * 返回 null 表示无配置或不兼容版本。
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

	if (config.version === 1) {
		console.warn("[model-switch] v1 config format no longer supported. Run /setup-model-policy to generate v2.");
		return null;
	}

	if (config.version !== 2) {
		console.warn(`[model-switch] Unsupported config version: ${String(config.version)}`);
		return null;
	}

	// models — provider-keyed
	if (!config.models || typeof config.models !== "object") {
		console.warn('[model-switch] Config missing "models"');
		return null;
	}
	for (const [provider, pcfg] of Object.entries(config.models as Record<string, unknown>)) {
		if (typeof pcfg !== "object" || pcfg === null) {
			console.warn(`[model-switch] Invalid provider config for "${provider}"`);
			return null;
		}
		const pc = pcfg as Record<string, unknown>;
		if (typeof pc.plan !== "string") {
			console.warn(`[model-switch] Provider "${provider}" missing "plan"`);
			return null;
		}
		if (!pc.models || typeof pc.models !== "object") {
			console.warn(`[model-switch] Provider "${provider}" missing "models"`);
			return null;
		}
	}

	// scenes
	if (!config.scenes || typeof config.scenes !== "object") {
		console.warn('[model-switch] Config missing "scenes"');
		return null;
	}

	// plans
	if (!config.plans || typeof config.plans !== "object") {
		console.warn('[model-switch] Config missing "plans"');
		return null;
	}

	// stickiness
	if (!config.stickiness || typeof config.stickiness !== "object") {
		console.warn('[model-switch] Config missing "stickiness"');
		return null;
	}

	const typed = config as unknown as ModelPolicy;
	applyDefaults(typed);
	return typed;
}

/** 向后兼容：为缺失字段填充默认值 */
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
