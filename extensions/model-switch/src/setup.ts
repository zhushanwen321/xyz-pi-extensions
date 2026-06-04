/**
 * Model Switch — 配置自动生成（v2）
 *
 * /setup-model-policy 命令流程：
 * 1. 读取 enabledModels 或降级到全部可用模型
 * 2. 按 provider 分组（使用 models.json 的 provider 名）
 * 3. 推断场景偏好和套餐规则
 * 4. 展示给用户确认
 *
 * 输出配置格式（v2）：
 *   models: 以 models.json provider 名为 key，内嵌 plan + models 表
 *   plans: 以计划名为 key（对应 quota-provider cache key）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SetupResult } from "./types";

/** JSON 输出缩进 */
const JSON_INDENT_SIZE = 2;

// ── Provider → Plan 映射 ───────────────────────────────
// models.json provider → quota-provider cache key

const PROVIDER_TO_PLAN: Record<string, string> = {
	"zhipu-coding-plan": "zhipu",
	"zhipu-coding-plan-router": "zhipu",
	"opencode-go": "opencode-go",
	"opencode-go-router": "opencode-go",
	"kimi-coding-plan": "kimi-coding",
	"kimi-coding-plan-router": "kimi-coding",
	"minimax-token-plan": "minimax",
	"minimax-token-plan-router": "minimax",
};

const PLAN_PRIORITY: Record<string, number> = {
	zhipu: 1,
	"opencode-go": 2,
	"kimi-coding": 3,
	minimax: 4,
};

// ── 模型信息提取 ───────────────────────────────────────

interface ModelInfo {
	provider: string;   // models.json provider key（不含 -router）
	plan: string;       // quota-provider cache key
	modelId: string;
	name: string;
	reasoning: boolean;
	vision: boolean;
	input: readonly string[];
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

	const enabledSet = enabledModels?.length
		? new Set(enabledModels.map((m) => m.toLowerCase()))
		: null;

	const result: ModelInfo[] = [];
	for (const m of all) {
		if (enabledSet && !enabledSet.has(`${m.provider}/${m.id}`.toLowerCase())) continue;

		const plan = PROVIDER_TO_PLAN[m.provider];
		if (!plan) continue; // Unknown provider, skip

		// 去掉 -router 后缀作为配置中的 provider key
		const providerKey = m.provider.replace(/-router$/, "");

		result.push({
			provider: providerKey,
			plan,
			modelId: m.id,
			name: m.name ?? m.id,
			reasoning: m.reasoning ?? false,
			vision: m.input?.includes("image") ?? false,
			input: m.input ?? ["text"],
		});
	}

	return result;
}

// ── 场景推断 ────────────────────────────────────────────

function inferCapabilities(m: ModelInfo): string[] {
	const caps: string[] = [...m.input];
	if (m.reasoning && !caps.includes("reasoning")) caps.push("reasoning");
	caps.push("coding");
	caps.push("chat");
	return [...new Set(caps)];
}

function inferScenes(modelAliases: Record<string, ModelInfo>): Record<string, string[]> {
	const visionAliases: string[] = [];
	const reasoningAliases: string[] = [];
	const codingAliases: string[] = [];

	for (const [alias, info] of Object.entries(modelAliases)) {
		if (info.input.includes("image")) visionAliases.push(alias);
		if (info.reasoning) reasoningAliases.push(alias);
		codingAliases.push(alias);
	}

	const scenes: Record<string, string[]> = {};

	if (visionAliases.length > 0) scenes.vision = visionAliases;
	if (reasoningAliases.length > 0) scenes.planning = reasoningAliases;
	scenes.coding = codingAliases;
	scenes.chat = codingAliases;

	return scenes;
}

// ── 主生成函数 ──────────────────────────────────────────

export function generatePolicyConfig(
	modelRegistry: ModelRegistryLike,
	enabledModels?: string[],
): SetupResult {
	const models = extractModels(modelRegistry, enabledModels);

	// 按 provider 分组
	const providerGroups = groupByProvider(models);

	// 构建 models 段
	const policyModels: Record<string, { plan: string; models: Record<string, { modelId: string; capabilities: string[] }> }> = {};
	const allAliases: Record<string, ModelInfo> = {};

	for (const group of providerGroups) {
		const providerModels: Record<string, { modelId: string; capabilities: string[] }> = {};
		for (const m of group.models) {
			const alias = inferAlias(m);
			providerModels[alias] = {
				modelId: m.modelId,
				capabilities: inferCapabilities(m),
			};
			allAliases[alias] = m;
		}
		policyModels[group.provider] = {
			plan: group.plan,
			models: providerModels,
		};
	}

	const scenes = inferScenes(allAliases);

	// 构建 plans 段
	const policyPlans: Record<string, { priority: number; peak?: { start: number; end: number; multiplier: number }; peakStrategy: string; rollingWindowHours: number; thresholds: { rollingLimitPct: number; weeklyLimitPct: number } }> = {};
	const seenPlans = new Set<string>();

	for (const group of providerGroups) {
		if (seenPlans.has(group.plan)) continue;
		seenPlans.add(group.plan);

		const plan: { priority: number; peak?: { start: number; end: number; multiplier: number }; peakStrategy: string; rollingWindowHours: number; thresholds: { rollingLimitPct: number; weeklyLimitPct: number } } = {
			priority: PLAN_PRIORITY[group.plan] ?? seenPlans.size,
			peakStrategy: "conserve",
			rollingWindowHours: 5,
			thresholds: { rollingLimitPct: 80, weeklyLimitPct: 80 },
		};

		if (group.plan === "zhipu") {
			plan.peak = { start: 14, end: 18, multiplier: 3 };
		}

		policyPlans[group.plan] = plan;
	}

	const config = {
		version: 2,
		models: policyModels,
		scenes,
		plans: policyPlans,
		stickiness: { minTurns: 3, minInputTokens: 20_000 },
	};

	const json = JSON.stringify(config, null, JSON_INDENT_SIZE);
	const summary = buildSummary(providerGroups, scenes, policyPlans);

	return { json, summary };
}

function buildSummary(
	groups: ProviderGroup[],
	scenes: Record<string, string[]>,
	plans: Record<string, { priority: number; peak?: { start: number; end: number; multiplier: number }; peakStrategy: string; rollingWindowHours: number; thresholds: { rollingLimitPct: number; weeklyLimitPct: number } }>,
): string {
	const lines: string[] = ["Model Policy v2 — Auto-generated Config:", "", "Providers:"];

	for (const group of groups) {
		const planCfg = plans[group.plan];
		lines.push(`  ${group.provider} (plan: ${group.plan}, priority: ${planCfg?.priority ?? "?"})`);
		for (const m of group.models) {
			const caps = inferCapabilities(m).join(", ");
			lines.push(`    ${inferAlias(m)} → ${m.modelId} [${caps}]`);
		}
	}

	lines.push("", "Scenes:");
	for (const [scene, aliases] of Object.entries(scenes)) {
		lines.push(`  ${scene}: ${aliases.join(", ")}`);
	}

	lines.push("", "Plans:");
	for (const [key, plan] of Object.entries(plans)) {
		const peak = plan.peak ? ` peak ${plan.peak.start}:00-${plan.peak.end}:00 (${plan.peak.multiplier}x)` : "";
		const strategy = ` strategy=${plan.peakStrategy}`;
		const window = ` window=${plan.rollingWindowHours}h`;
		const thresholds = ` thresholds=rolling:${plan.thresholds.rollingLimitPct}%,weekly:${plan.thresholds.weeklyLimitPct}%`;
		lines.push(`  ${key}: priority ${plan.priority}${peak}${strategy}${window}${thresholds}`);
	}

	lines.push("", "Review the config above. Tell me to adjust anything, or say 'confirm' to write it.");
	return lines.join("\n");
}

// ── Provider 分组 ──────────────────────────────────────

interface ProviderGroup {
	provider: string;
	plan: string;
	models: ModelInfo[];
}

function groupByProvider(models: ModelInfo[]): ProviderGroup[] {
	const map = new Map<string, ProviderGroup>();
	for (const m of models) {
		let group = map.get(m.provider);
		if (!group) {
			group = { provider: m.provider, plan: m.plan, models: [] };
			map.set(m.provider, group);
		}
		group.models.push(m);
	}
	return [...map.values()];
}

// ── 推断辅助 ────────────────────────────────────────────

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

// ── 文件操作 ────────────────────────────────────────────

const PI_AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_DIR = join(PI_AGENT_DIR, "extensions", "model-switch");
const CONFIG_PATH = join(CONFIG_DIR, "model-policy.json");

export function getConfigPath(): string {
	return CONFIG_PATH;
}

export function writePolicyConfig(json: string, overwrite = false): { ok: true; path: string } | { ok: false; error: string } {
	if (!overwrite && existsSync(CONFIG_PATH)) {
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

export function deletePolicyConfig(): { ok: true; path: string } | { ok: false; error: string } {
	if (!existsSync(CONFIG_PATH)) {
		return { ok: false, error: `No config file at ${CONFIG_PATH}.` };
	}
	try {
		unlinkSync(CONFIG_PATH);
		return { ok: true, path: CONFIG_PATH };
	} catch (err) {
		return { ok: false, error: `Failed to delete: ${(err as Error).message}` };
	}
}

export function readPolicyConfigContent(): { ok: true; content: string; path: string } | { ok: false; error: string } {
	if (!existsSync(CONFIG_PATH)) {
		return { ok: false, error: `No config file at ${CONFIG_PATH}. Run /setup-model-policy to generate one.` };
	}
	try {
		const content = readFileSync(CONFIG_PATH, "utf-8");
		JSON.parse(content);
		return { ok: true, content, path: CONFIG_PATH };
	} catch (err) {
		return { ok: false, error: `Failed to read config: ${(err as Error).message}` };
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
