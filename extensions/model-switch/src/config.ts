/**
 * Model Switch — 配置文件加载
 *
 * 从 ~/.pi/agent/model-policy.json 加载配置。
 * v2 格式：models 以 provider 名为 key，内嵌 models 表；plans 以 plan 名为 key。
 * v1 格式自动迁移为 v2 内存结构。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelPolicy, ProviderConfig, PlanConfig } from "./types";

const CONFIG_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(CONFIG_DIR, "model-policy.json");

export { CONFIG_PATH };

/**
 * 加载模型策略配置文件。
 * 返回 null 表示无配置或不兼容版本。
 */
const SUPPORTED_CONFIG_VERSION = 2;

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
		return migrateV1(config);
	}

	if (config.version !== SUPPORTED_CONFIG_VERSION) {
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

/** v1 配置中单个 model 条目的结构 */
interface V1ModelEntry {
	provider: string;
	modelId: string;
	plan: string;
	capabilities: string[];
}

/** v1 配置中 peakHours 的结构 */
interface V1PeakHours {
	schedule: string;
	costMultiplier: number;
}

/** v1 plan 条目的结构 */
interface V1PlanEntry {
	priority: number;
	budgetTarget?: number;
	peakHours?: V1PeakHours;
}

/**
 * 将 v1 格式配置迁移为 v2 内存结构。
 * v1: models 是 flat dict（alias → {provider, modelId, plan, capabilities}）
 * v2: models 是 provider-keyed dict（provider → {plan, models: {alias → {modelId, capabilities}}}）
 */
function migrateV1(raw: Record<string, unknown>): ModelPolicy | null {
	const models = raw.models as Record<string, V1ModelEntry> | undefined;
	if (!models || typeof models !== "object") {
		console.warn("[model-switch] v1 config missing \"models\"");
		return null;
	}

	const scenes = raw.scenes as Record<string, string[]> | undefined;
	const plans = raw.plans as Record<string, V1PlanEntry> | undefined;
	const stickiness = raw.stickiness as { minTurns?: number; minInputTokens?: number } | undefined;

	// v1 models → v2 provider-keyed models
	const v2Models: Record<string, ProviderConfig> = {};
	for (const [alias, entry] of Object.entries(models)) {
		// v1 provider 是 "router-openai" 等，去掉 "router-" 前缀
		const providerKey = entry.provider.replace(/^router-/, "");
		if (!v2Models[providerKey]) {
			v2Models[providerKey] = { plan: entry.plan, models: {} };
		}
		v2Models[providerKey].models[alias] = {
			modelId: entry.modelId,
			capabilities: entry.capabilities,
		};
	}

	// v1 plans → v2 plans
	const v2Plans: Record<string, PlanConfig> = {};
	if (plans) {
		for (const [planName, planEntry] of Object.entries(plans)) {
			const v2Plan: PlanConfig = {
				priority: planEntry.priority ?? 99,
				peakStrategy: "conserve",
				rollingWindowHours: 5,
				thresholds: { rollingLimitPct: 80, weeklyLimitPct: 80 },
			};
			if (planEntry.peakHours) {
				const match = planEntry.peakHours.schedule.match(/^(\d+):(\d+)-(\d+):(\d+)$/);
				if (match) {
					v2Plan.peak = {
						start: Number(match[1]),
						end: Number(match[3]),
						multiplier: planEntry.peakHours.costMultiplier,
					};
				}
			}
			v2Plans[planName] = v2Plan;
		}
	}

	const result: ModelPolicy = {
		version: 2,
		models: v2Models,
		scenes: scenes ?? {},
		plans: v2Plans,
		stickiness: {
			minTurns: stickiness?.minTurns ?? 3,
			minInputTokens: stickiness?.minInputTokens ?? 20_000,
		},
	};

	applyDefaults(result);
	return result;
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
