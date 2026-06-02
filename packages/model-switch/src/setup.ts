/**
 * Model Switch — 配置自动生成
 *
 * /setup-model-policy 命令的交互流程：
 * 1. 读取 scoped models (enabledModels) 或降级到全部可用模型
 * 2. 按 provider 分组
 * 3. 推断场景偏好和套餐规则
 * 4. 展示给用户确认
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(CONFIG_DIR, "model-policy.json");

// ── 模型信息提取 ───────────────────────────────────────

interface ModelInfo {
	provider: string;
	modelId: string;
	name: string;
	reasoning: boolean;
	vision: boolean;
}

function extractModels(
	modelRegistry: { getAvailable(): Array<{ provider: string; id: string; name?: string; reasoning?: boolean; input?: readonly string[] }> },
	enabledModels?: string[],
): ModelInfo[] {
	const all = modelRegistry.getAvailable();

	// 如果有 enabledModels，只保留匹配的
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

/** 推断模型适合的场景标签 */
function inferCapabilities(m: ModelInfo): string[] {
	const caps: string[] = [];
	if (m.vision) caps.push("vision");
	if (m.reasoning) caps.push("reasoning");
	// 所有模型都能 chat/coding（默认能力）
	caps.push("coding");
	caps.push("chat");
	return caps;
}

/**
 * 推断场景偏好。
 * 规则：
 * - vision 模型 → vision 场景
 * - reasoning 模型 → planning 场景
 * - 其余 → coding 场景
 * 场景内按 provider 优先级排序
 */
function inferScenes(
	groups: ProviderGroup[],
	modelEntries: Record<string, { provider: string; modelId: string; plan: string; capabilities: string[] }>,
): Record<string, string[]> {
	const scenes: Record<string, string[]> = {
		coding: [],
		planning: [],
		vision: [],
		chat: [],
	};

	// 收集各场景的候选 alias
	const visionAliases: string[] = [];
	const planningAliases: string[] = [];
	const codingAliases: string[] = [];
	const chatAliases: string[] = [];

	for (const [alias, entry] of Object.entries(modelEntries)) {
		if (entry.capabilities.includes("vision")) visionAliases.push(alias);
		if (entry.capabilities.includes("reasoning")) planningAliases.push(alias);
		// coding 和 chat：排除已在 planning/vision 中的
		if (!entry.capabilities.includes("vision") && !entry.capabilities.includes("reasoning")) {
			codingAliases.push(alias);
			chatAliases.push(alias);
		}
	}

	// 如果没有 coding 专用的，把 planning 的也加进去
	if (codingAliases.length === 0) {
		for (const [alias, entry] of Object.entries(modelEntries)) {
			if (entry.capabilities.includes("reasoning")) codingAliases.push(alias);
		}
	}

	scenes.vision = visionAliases;
	scenes.planning = planningAliases;
	scenes.coding = codingAliases.length > 0 ? codingAliases : planningAliases;
	scenes.chat = chatAliases.length > 0 ? chatAliases : codingAliases;

	// 移除空场景
	for (const key of Object.keys(scenes)) {
		if (scenes[key]!.length === 0) delete scenes[key];
	}

	return scenes;
}

// ── 主生成函数 ──────────────────────────────────────────

export interface SetupResult {
	/** 生成的配置 JSON 字符串 */
	json: string;
	/** 格式化的可读摘要（用于 notify 展示） */
	summary: string;
	/** 提供给 AI 的提示（包含 JSON + schema + 写入指令） */
	aiPrompt: string;
}

/**
 * 自动生成 model-policy.json 配置。
 *
 * @param modelRegistry Pi 的 modelRegistry
 * @param enabledModels settings.json 中的 enabledModels（可选）
 */
export function generatePolicyConfig(
	modelRegistry: { getAvailable(): Array<{ provider: string; id: string; name?: string; reasoning?: boolean; input?: readonly string[] }> },
	enabledModels?: string[],
): SetupResult {
	const models = extractModels(modelRegistry, enabledModels);
	const groups = groupByProvider(models);

	// ── 1. 生成 models 映射 ──────────────────────────
	const modelEntries: Record<string, {
		provider: string;
		modelId: string;
		plan: string;
		capabilities: string[];
	}> = {};

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

	// ── 2. 生成 scenes ──────────────────────────────
	const scenes = inferScenes(groups, modelEntries);

	// ── 3. 生成 plans ───────────────────────────────
	const plans = inferPlans(groups);

	// ── 4. 组装完整配置 ─────────────────────────────
	const config = {
		version: 1,
		models: modelEntries,
		scenes,
		plans,
		stickiness: {
			minTurns: 3,
			minInputTokens: 20000,
		},
	};

	const json = JSON.stringify(config, null, 2);

	// ── 5. 生成可读摘要 ─────────────────────────────
	const summaryLines: string[] = [];
	summaryLines.push("Model Policy Auto-Generated Config:");
	summaryLines.push("");
	summaryLines.push("Providers:");
	for (const group of groups) {
		const planKey = inferPlanKey(group.provider);
		summaryLines.push(`  ${group.provider} (plan: ${planKey}, priority: ${plans[planKey]?.priority ?? "?"})`);
		for (const m of group.models) {
			const caps = inferCapabilities(m).join(", ");
			summaryLines.push(`    ${inferAlias(m)} → ${m.modelId} [${caps}]`);
		}
	}
	summaryLines.push("");
	summaryLines.push("Scenes:");
	for (const [scene, aliases] of Object.entries(scenes)) {
		summaryLines.push(`  ${scene}: ${aliases.join(", ")}`);
	}
	summaryLines.push("");
	summaryLines.push("Plans:");
	for (const [key, plan] of Object.entries(plans)) {
		const peak = plan.peak ? ` peak ${plan.peak.start}:00-${plan.peak.end}:00 (${plan.peak.multiplier}x)` : "";
		const budget = plan.budgetTarget ? ` budget ${plan.budgetTarget}%` : "";
		summaryLines.push(`  ${key}: priority ${plan.priority}${peak}${budget}`);
	}
	summaryLines.push("");
	summaryLines.push("Review the config above. Tell me to adjust anything, or say 'confirm' to write it.");

	// ── 6. 生成 AI prompt ───────────────────────────
	const aiPrompt = [
		"Auto-generated model-policy.json config. Present it to the user for review.",
		"Use the `write` tool to save it to " + CONFIG_PATH + " after user confirms.",
		"",
		"```json",
		json,
		"```",
	].join("\n");

	return { json, summary: summaryLines.join("\n"), aiPrompt };
}

// ── 推断辅助 ────────────────────────────────────────────

/** 从 provider 名推断 plan key */
function inferPlanKey(provider: string): string {
	// 常见映射
	if (provider.includes("zhipu") || provider.includes("zai")) return "zai";
	if (provider.includes("opencode")) return "opencode-go";
	if (provider.includes("kimi")) return "kimi-coding";
	if (provider.includes("minimax")) return "opencode-go";
	if (provider.includes("deepseek")) return "opencode-go";
	// 兜底：用 provider 名
	return provider;
}

/** 从模型信息推断短 alias */
function inferAlias(m: ModelInfo): string {
	const id = m.modelId.toLowerCase();
	// 常见模型 alias 映射
	if (id.includes("glm-5.1")) return "glm-5.1";
	if (id.includes("glm-turbo") || id.includes("glm-4")) return "glm-turbo";
	if (id.includes("deepseek-r1") || id.includes("ds-pro")) return "ds-pro";
	if (id.includes("deepseek-chat") || id.includes("deepseek-v3") || id.includes("ds-flash")) return "ds-flash";
	if (id.includes("mimo-vl-pro") || id.includes("mimo-v2.5-pro")) return "mimo-v2.5-pro";
	if (id.includes("mimo-vl") || id.includes("mimo-v2.5")) return "mimo-v2.5";
	if (id.includes("kimi")) return "kimi";
	if (id.includes("minimax-m3")) return "minimax-m3";
	if (id.includes("minimax-m2")) return "minimax-m2";
	// 兜底：用 modelId
	return m.modelId.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
}

/** 推断 plans 配置 */
function inferPlans(groups: ProviderGroup[]): Record<string, { priority: number; peak?: { start: number; end: number; multiplier: number }; budgetTarget?: number }> {
	const plans: Record<string, { priority: number; peak?: { start: number; end: number; multiplier: number }; budgetTarget?: number }> = {};
	let priority = 1;

	for (const group of groups) {
		const planKey = inferPlanKey(group.provider);
		if (plans[planKey]) continue; // 同一个 plan 不重复

		const plan: { priority: number; peak?: { start: number; end: number; multiplier: number }; budgetTarget?: number } = { priority };

		// zai 套餐默认配置高峰期和预算目标
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

	// 校验 JSON
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

/** 读取 settings.json 中的 enabledModels */
export function readEnabledModels(): string[] | undefined {
	const settingsPath = join(CONFIG_DIR, "settings.json");
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

/**
 * 未配置时的 system prompt 注入片段。
 */
export const SETUP_HINT = `[Model Advisor]
Status: NOT CONFIGURED — ~/.pi/agent/model-policy.json not found.
The model-switch extension is installed but has no configuration.
To set up: tell the user to run /setup-model-policy (auto-generates config from their models).
Or use switch_model with action="setup" for manual description-based generation.
Without configuration, only manual model switching (list/search/switch) is available.`;

/**
 * 从 modelRegistry 中获取所有可用模型的摘要信息。
 * 仅用于手动模式（setup action 带 user description 时）。
 */
export function getAvailableModelsSummary(
	modelRegistry: { getAvailable(): Array<{ provider: string; id: string; name?: string; reasoning?: boolean; input?: readonly string[] }> },
): string {
	const models = modelRegistry.getAvailable();
	if (models.length === 0) return "No models available (no API keys configured).";

	const lines: string[] = [];
	for (const m of models) {
		const caps: string[] = [];
		if (m.reasoning) caps.push("reasoning");
		if (m.input?.includes("image")) caps.push("vision");
		const capStr = caps.length > 0 ? ` [${caps.join(", ")}]` : "";
		lines.push(`  ${m.provider}/${m.id}${capStr}`);
	}
	return `Available models (${models.length}):\n${lines.join("\n")}`;
}
