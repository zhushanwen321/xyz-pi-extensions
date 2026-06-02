/**
 * Model Switch — 配置自动生成
 *
 * /setup-model-policy 命令流程：
 * 1. 读取 enabledModels 或降级到全部可用模型
 * 2. 按 provider 分组
 * 3. 推断场景偏好和套餐规则
 * 4. 展示给用户确认
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SetupResult } from "./types";

const PI_AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_DIR = join(PI_AGENT_DIR, "extensions", "model-switch");
const CONFIG_PATH = join(CONFIG_DIR, "model-policy.json");

// ── 模型信息提取 ───────────────────────────────────────

interface ModelInfo {
	provider: string;
	modelId: string;
	name: string;
	reasoning: boolean;
	vision: boolean;
}

type ModelRegistryLike = {
	getAvailable(): Array<{
		provider: string;
		id: string;
		name?: string;
		reasoning?: boolean;
		input?: readonly string[];
	}>;
};

function extractModels(registry: ModelRegistryLike, enabledModels?: string[]): ModelInfo[] {
	const all = registry.getAvailable();

	if (enabledModels && enabledModels.length > 0) {
		const enabled = new Set(enabledModels.map((m) => m.toLowerCase()));
		return all
			.filter((m) => enabled.has(`${m.provider}/${m.id}`.toLowerCase()))
			.map(toModelInfo);
	}

	return all.map(toModelInfo);
}

function toModelInfo(m: { provider: string; id: string; name?: string; reasoning?: boolean; input?: readonly string[] }): ModelInfo {
	return {
		provider: m.provider,
		modelId: m.id,
		name: m.name ?? m.id,
		reasoning: m.reasoning ?? false,
		vision: m.input?.includes("image") ?? false,
	};
}

// ── Provider 分组 ──────────────────────────────────────

interface ProviderGroup {
	provider: string;
	models: ModelInfo[];
}

function groupByProvider(models: ModelInfo[]): ProviderGroup[] {
	const map = new Map<string, ModelInfo[]>();
	for (const m of models) {
		let group = map.get(m.provider);
		if (!group) {
			group = [];
			map.set(m.provider, group);
		}
		group.push(m);
	}
	const result: ProviderGroup[] = [];
	for (const [provider, groupModels] of map) {
		result.push({ provider, models: groupModels });
	}
	return result;
}

// ── 场景推断 ────────────────────────────────────────────

function inferCapabilities(m: ModelInfo): string[] {
	const caps: string[] = [];
	if (m.vision) caps.push("vision");
	if (m.reasoning) caps.push("reasoning");
	caps.push("coding");
	caps.push("chat");
	return caps;
}

function inferScenes(
	modelEntries: Record<string, { provider: string; modelId: string; plan: string; capabilities: string[] }>,
): Record<string, string[]> {
	const visionAliases: string[] = [];
	const planningAliases: string[] = [];
	const codingAliases: string[] = [];
	const chatAliases: string[] = [];

	for (const [alias, entry] of Object.entries(modelEntries)) {
		if (entry.capabilities.includes("vision")) visionAliases.push(alias);
		if (entry.capabilities.includes("reasoning")) planningAliases.push(alias);
		if (!entry.capabilities.includes("vision") && !entry.capabilities.includes("reasoning")) {
			codingAliases.push(alias);
			chatAliases.push(alias);
		}
	}

	if (codingAliases.length === 0) {
		for (const [alias, entry] of Object.entries(modelEntries)) {
			if (entry.capabilities.includes("reasoning")) codingAliases.push(alias);
		}
	}

	const scenes: Record<string, string[]> = {
		vision: visionAliases,
		planning: planningAliases,
		coding: codingAliases.length > 0 ? codingAliases : planningAliases,
		chat: chatAliases.length > 0 ? chatAliases : codingAliases,
	};

	for (const key of Object.keys(scenes)) {
		if (scenes[key]!.length === 0) delete scenes[key];
	}

	return scenes;
}

// ── 主生成函数 ──────────────────────────────────────────

export function generatePolicyConfig(
	modelRegistry: ModelRegistryLike,
	enabledModels?: string[],
): SetupResult {
	const models = extractModels(modelRegistry, enabledModels);
	const groups = groupByProvider(models);

	const modelEntries: Record<string, { provider: string; modelId: string; plan: string; capabilities: string[] }> = {};

	for (const group of groups) {
		const planKey = inferPlanKey(group.provider);
		for (const m of group.models) {
			const alias = inferAlias(m);
			modelEntries[alias] = {
				provider: group.provider,
				modelId: m.modelId,
				plan: planKey,
				capabilities: inferCapabilities(m),
			};
		}
	}

	const scenes = inferScenes(modelEntries);
	const plans = inferPlans(groups);

	const config = {
		version: 1,
		models: modelEntries,
		scenes,
		plans,
		stickiness: { minTurns: 3, minInputTokens: 20000 },
	};

	const json = JSON.stringify(config, null, 2);
	const summary = buildSummary(groups, scenes, plans);

	return { json, summary };
}

function buildSummary(
	groups: ProviderGroup[],
	scenes: Record<string, string[]>,
	plans: Record<string, { priority: number; peak?: { start: number; end: number; multiplier: number }; budgetTarget?: number; peakStrategy?: "conserve" | "normal"; rollingWindowHours?: number; thresholds?: { rollingLimitPct?: number; weeklyLimitPct?: number } }>,
): string {
	const lines: string[] = ["Model Policy Auto-Generated Config:", "", "Providers:"];

	for (const group of groups) {
		const planKey = inferPlanKey(group.provider);
		lines.push(`  ${group.provider} (plan: ${planKey}, priority: ${plans[planKey]?.priority ?? "?"})`);
		for (const m of group.models) {
			const caps = inferCapabilities(m).join(", ");
			lines.push(`    ${inferAlias(m)} \u2192 ${m.modelId} [${caps}]`);
		}
	}

	lines.push("", "Scenes:");
	for (const [scene, aliases] of Object.entries(scenes)) {
		lines.push(`  ${scene}: ${aliases.join(", ")}`);
	}

	lines.push("", "Plans:");
	for (const [key, plan] of Object.entries(plans)) {
		const peak = plan.peak ? ` peak ${plan.peak.start}:00-${plan.peak.end}:00 (${plan.peak.multiplier}x)` : "";
		const budget = plan.budgetTarget ? ` budget ${plan.budgetTarget}%` : "";
		const strategy = plan.peakStrategy ? ` strategy=${plan.peakStrategy}` : "";
		const window = plan.rollingWindowHours ? ` window=${plan.rollingWindowHours}h` : "";
		const thresholds = plan.thresholds ? ` thresholds=rolling:${plan.thresholds.rollingLimitPct}%,weekly:${plan.thresholds.weeklyLimitPct}%` : "";
		lines.push(`  ${key}: priority ${plan.priority}${peak}${budget}${strategy}${window}${thresholds}`);
	}

	lines.push("", "Review the config above. Tell me to adjust anything, or say 'confirm' to write it.");
	return lines.join("\n");
}

// ── 推断辅助 ────────────────────────────────────────────

function inferPlanKey(provider: string): string {
	if (provider.includes("zhipu") || provider.includes("zai")) return "zai";
	if (provider.includes("opencode")) return "opencode-go";
	if (provider.includes("kimi")) return "kimi-coding";
	if (provider.includes("minimax") || provider.includes("deepseek")) return "opencode-go";
	return provider;
}

function inferAlias(m: ModelInfo): string {
	const id = m.modelId.toLowerCase();
	if (id.includes("glm-5.1")) return "glm-5.1";
	if (id.includes("glm-turbo") || id.includes("glm-4")) return "glm-turbo";
	if (id.includes("deepseek-r1") || id.includes("ds-pro")) return "ds-pro";
	if (id.includes("deepseek-chat") || id.includes("deepseek-v3") || id.includes("ds-flash")) return "ds-flash";
	if (id.includes("mimo-vl-pro") || id.includes("mimo-v2.5-pro")) return "mimo-v2.5-pro";
	if (id.includes("mimo-vl") || id.includes("mimo-v2.5")) return "mimo-v2.5";
	if (id.includes("kimi")) return "kimi";
	if (id.includes("minimax-m3")) return "minimax-m3";
	if (id.includes("minimax-m2")) return "minimax-m2";
	return m.modelId.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
}

function inferPlans(groups: ProviderGroup[]): Record<string, { priority: number; peak?: { start: number; end: number; multiplier: number }; budgetTarget?: number; peakStrategy?: "conserve" | "normal"; rollingWindowHours?: number; thresholds?: { rollingLimitPct?: number; weeklyLimitPct?: number } }> {
	const plans: Record<string, { priority: number; peak?: { start: number; end: number; multiplier: number }; budgetTarget?: number; peakStrategy?: "conserve" | "normal"; rollingWindowHours?: number; thresholds?: { rollingLimitPct?: number; weeklyLimitPct?: number } }> = {};
	let priority = 1;

	for (const group of groups) {
		const planKey = inferPlanKey(group.provider);
		if (plans[planKey]) continue;

		const plan: { priority: number; peak?: { start: number; end: number; multiplier: number }; budgetTarget?: number; peakStrategy?: "conserve" | "normal"; rollingWindowHours?: number; thresholds?: { rollingLimitPct?: number; weeklyLimitPct?: number } } = {
			priority,
			peakStrategy: "conserve",
			rollingWindowHours: 5,
			thresholds: { rollingLimitPct: 80, weeklyLimitPct: 80 },
		};
		if (planKey === "zai") {
			plan.peak = { start: 14, end: 18, multiplier: 3 };
			plan.budgetTarget = 85;
		}

		plans[planKey] = plan;
		priority++;
	}

	return plans;
}

// ── 文件操作 ────────────────────────────────────────────

export function getConfigPath(): string {
	return CONFIG_PATH;
}

export function writePolicyConfig(json: string): { ok: true; path: string } | { ok: false; error: string } {
	if (existsSync(CONFIG_PATH)) {
		return { ok: false, error: `Config already exists at ${CONFIG_PATH}. Delete it first to regenerate.` };
	}

	try {
		JSON.parse(json);
	} catch {
		return { ok: false, error: "Invalid JSON." };
	}

	try {
		mkdirSync(CONFIG_DIR, { recursive: true });
		writeFileSync(CONFIG_PATH, json, "utf-8");
		return { ok: true, path: CONFIG_PATH };
	} catch (err) {
		return { ok: false, error: `Failed to write: ${(err as Error).message}` };
	}
}

export function readEnabledModels(): string[] | undefined {
	const settingsPath = join(PI_AGENT_DIR, "settings.json");
	try {
		if (!existsSync(settingsPath)) return undefined;
		const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
		const models = raw.enabledModels;
		if (Array.isArray(models) && models.length > 0) return models as string[];
		return undefined;
	} catch {
		return undefined;
	}
}
