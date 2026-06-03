/**
 * Pi Model Switch — 上下文注入 + 模型切换扩展
 *
 * before_agent_start 注入数据+规则（不推荐具体模型） + switch_model 工具。
 * 配置文件不存在时降级为仅手动切换工具。
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { readCache } from "@zhushanwen/pi-quota-providers";

import { loadConfig } from "./config";
import { computeQuotaSnapshot, computeStickiness } from "./advisor";
import { formatContextPrompt } from "./prompt";
import { generatePolicyConfig, readEnabledModels, getConfigPath, deletePolicyConfig, readPolicyConfigContent, writePolicyConfig } from "./setup";
import { getCurrentModelId, asSessionEntries, type ModelPolicy } from "./types";

// ── Tool 返回值 helper ──────────────────────────────────

interface ToolRes {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, never>;
	isError?: boolean;
}

function res(text: string, opts?: { error?: boolean }): ToolRes {
	const r: ToolRes = { content: [{ type: "text" as const, text }], details: {} };
	if (opts?.error) r.isError = true;
	return r;
}

// ── 状态 ────────────────────────────────────────────────

interface SessionState {
	config: ModelPolicy | null;
}

// ── 扩展入口 ────────────────────────────────────────────

export default function modelSwitchExtension(pi: ExtensionAPI) {
	const state: SessionState = { config: null };

	pi.on("session_start", async (_event: unknown, _ctx: ExtensionContext) => {
		state.config = loadConfig();
	});

	pi.on("before_agent_start", async (_event: unknown, ctx: ExtensionContext) => {
		if (!state.config) return;

		try {
			const currentModel = getCurrentModelId(ctx);
			const entries = asSessionEntries(ctx.sessionManager.getBranch());
			const cache = readCache();

			const snapshot = computeQuotaSnapshot(cache);
			const stickiness = computeStickiness(entries, state.config);

			const injection = formatContextPrompt({
				currentModel,
				stickiness,
				snapshot,
				config: state.config,
				now: new Date(),
			});

			return { systemPrompt: `\n${injection}` };
		} catch (err) {
			console.warn("[model-switch] context injection failed:", err);
			return;
		}
	});

	pi.registerCommand("setup-model-policy", {
		description: "Auto-generate model-policy.json from your configured models",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (state.config) {
				ctx.ui.notify(`Config already exists at ${getConfigPath()}. Delete it first to regenerate.`, "info");
				return;
			}
			const enabledModels = readEnabledModels();
			const result = generatePolicyConfig(ctx.modelRegistry, enabledModels);
			ctx.ui.notify(result.summary, "info");
		},
	});

	registerSwitchTool(pi, state);
}

// ── Tool 注册 ──────────────────────────────────────────

function registerSwitchTool(pi: ExtensionAPI, state: SessionState): void {
	pi.registerTool({
		name: "switch_model",
		label: "Switch Model",
		description:
			"List configured models, search by alias/name, switch to another model, or show current data snapshot and rules. "
			+ "Configured models are defined in model-policy.json. "
			+ "Setup sub-actions: 'setup delete' (remove config), 'setup list' (show config), 'setup edit' (LLM-guided edit), 'setup' (generate new).",
		promptSnippet:
			"Use this tool when the user asks to list/search/switch models, requests a specific model/provider, "
			+ "or when you need to see the current model context data. "
			+ "For policy management: 'setup delete' to remove, 'setup list' to view, 'setup edit' to modify through conversation.",
		parameters: Type.Object({
			action: StringEnum(["list", "search", "switch", "recommend", "setup"], {
				description: "Action: list (show all), search (filter), switch (change), recommend (show data+rules), setup (generate config)",
			}),
			query: Type.Optional(
				Type.String({
					description: "Search term (search/switch) or user's model preferences description (setup)",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: { action: string; query?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<ToolRes> {
			const action = params.action;
			const query = (params.query ?? "").trim().toLowerCase();

			if (action === "list") return handleList(state, ctx);
			if (action === "search") return handleSearch(state, query);
			if (action === "switch") return handleSwitch(state, pi, ctx, query);
			if (action === "recommend") return handleRecommend(state, ctx);
			if (action === "setup") return handleSetup(state, ctx, params.query);

			return res(`Unknown action: ${action}. Supported: list, search, switch, recommend, setup.`, { error: true });
		},
	});
}

// ── Action Handlers ────────────────────────────────────

function handleList(state: { config: ModelPolicy | null }, ctx: ExtensionContext): ToolRes {
	if (!state.config) {
		return res("No model policy configured. Run /setup-model-policy to generate one.");
	}

	const currentModel = getCurrentModelId(ctx);
	const lines: string[] = [];

	for (const [alias, entry] of Object.entries(state.config.models)) {
		const modelStr = `${entry.provider}/${entry.modelId}`;
		const marker = modelStr === currentModel ? " \u2190 current" : "";
		const caps = entry.capabilities.length > 0 ? ` [${entry.capabilities.join(", ")}]` : "";
		lines.push(`  ${alias} \u2192 ${modelStr}${marker}${caps}`);
	}

	const sceneInfo = Object.entries(state.config.scenes)
		.map(([s, aliases]) => `  ${s}: ${aliases.join(", ")}`)
		.join("\n");

	return res(`Configured models (${Object.keys(state.config.models).length}):\n\n${lines.join("\n")}\n\nScenes:\n${sceneInfo}`);
}

function handleSearch(state: { config: ModelPolicy | null }, query: string): ToolRes {
	if (!state.config) {
		return res("No model policy configured.");
	}

	if (!query) {
		return res("Please provide a search query.", { error: true });
	}

	const matches = Object.entries(state.config.models).filter(
		([alias, entry]) =>
			alias.toLowerCase().includes(query)
			|| entry.provider.toLowerCase().includes(query)
			|| entry.modelId.toLowerCase().includes(query),
	);

	if (matches.length === 0) {
		return res(`No models matching "${query}".`);
	}

	const lines = matches.map(([alias, entry]) => `  ${alias} \u2192 ${entry.provider}/${entry.modelId} [${entry.capabilities.join(", ")}]`);
	return res(`Models matching "${query}" (${matches.length}):\n\n${lines.join("\n")}`);
}

async function handleSwitch(state: { config: ModelPolicy | null }, pi: ExtensionAPI, ctx: ExtensionContext, query: string): Promise<ToolRes> {
	if (!state.config) {
		return res("No model policy configured. Cannot switch.", { error: true });
	}

	if (!query) {
		return res("Please specify a model alias to switch to (e.g., 'glm-5.1') or use 'search' first.", { error: true });
	}

	const exactEntry = state.config.models[query];
	if (exactEntry) {
		return switchToModel(pi, ctx, exactEntry.provider, exactEntry.modelId, query);
	}

	const fuzzyEntry = Object.entries(state.config.models).find(
		([alias, entry]) =>
			alias.toLowerCase() === query
			|| entry.modelId.toLowerCase() === query
			|| `${entry.provider}/${entry.modelId}`.toLowerCase() === query,
	);

	if (!fuzzyEntry) {
		return res(`No model matching "${query}". Use 'list' to see available models or 'search' to find by keyword.`, { error: true });
	}

	const [matchedAlias, matchedEntry] = fuzzyEntry;
	return switchToModel(pi, ctx, matchedEntry.provider, matchedEntry.modelId, matchedAlias);
}

function handleRecommend(state: { config: ModelPolicy | null }, ctx: ExtensionContext): ToolRes {
	if (!state.config) {
		return res("No model policy configured. No data available.");
	}

	try {
		const currentModel = getCurrentModelId(ctx);
		const entries = asSessionEntries(ctx.sessionManager.getBranch());
		const cache = readCache();

		const snapshot = computeQuotaSnapshot(cache);
		const stickiness = computeStickiness(entries, state.config);

		const formatted = formatContextPrompt({
			currentModel,
			stickiness,
			snapshot,
			config: state.config,
			now: new Date(),
		});

		return res(`Current model context (what AI sees):\n\n${formatted}`);
	} catch (err) {
		return res(`Failed to compute context: ${(err as Error).message}`, { error: true });
	}
}

function handleSetup(state: { config: ModelPolicy | null }, ctx: ExtensionContext, query?: string): ToolRes {
	const subAction = (query ?? "").trim().toLowerCase();

	// --delete: 删除现有配置
	if (subAction === "delete") {
		const result = deletePolicyConfig();
		if (result.ok) {
			state.config = null;
			return res(`Config deleted: ${result.path}. Run /setup-model-policy to regenerate.`);
		}
		return res(result.error, { error: true });
	}

	// --list: 显示现有配置
	if (subAction === "list") {
		const result = readPolicyConfigContent();
		if (!result.ok) return res(result.error, { error: true });
		return res(`Current model-policy.json (${result.path}):\n\n\`\`\`json\n${result.content}\n\`\`\``);
	}

	// --edit: 进入 LLM 对话编辑模式
	if (subAction === "edit") {
		const result = readPolicyConfigContent();
		if (!result.ok) return res(result.error, { error: true });
		return res([
			"Current model-policy.json for editing:\n",
			"```json",
			result.content,
			"```\n",
			"Tell me what you want to change. Examples:",
			"- \"Change peak hours to 12-18\"",
			"- \"Add model X to coding scene\"",
			"- \"Set ocg rolling threshold to 90%\"",
			"- \"Remove minimax from the config\"\n",
			"I'll modify the config and confirm with you before saving. Say 'save' when ready.",
		].join("\n"));
	}

	// 无 query: 生成新配置（原有逻辑）
	if (state.config) {
		return res(`Config already exists at ${getConfigPath()}. Use 'setup delete' to remove, 'setup list' to view, or 'setup edit' to modify.`);
	}

	const enabledModels = readEnabledModels();
	const genResult = generatePolicyConfig(ctx.modelRegistry, enabledModels);

	return res([
		"Auto-generated model-policy.json based on your configured models.",
		"Review the config below. If it looks correct, write it to " + getConfigPath() + " using the write tool.",
		"Adjust any values before writing (e.g. peak hours, scene preferences, budget target).",
		"",
		"```json",
		genResult.json,
		"```",
	].join("\n"));
}

// ── 辅助函数 ────────────────────────────────────────────

async function switchToModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	provider: string,
	modelId: string,
	alias: string,
): Promise<ToolRes> {
	try {
		const currentModel = getCurrentModelId(ctx);

		if (currentModel === `${provider}/${modelId}`) {
			return res(`Already using ${alias} (${provider}/${modelId}).`);
		}

		const match = ctx.modelRegistry.find(provider, modelId);
		if (!match) {
			return res(`Model ${provider}/${modelId} not available (API key may not be configured).`, { error: true });
		}

		const success = await pi.setModel(match);
		if (!success) {
			return res(`Failed to switch to ${provider}/${modelId}.`, { error: true });
		}

		pi.appendEntry("model_change", {
			provider,
			modelId,
			alias,
			timestamp: new Date().toISOString(),
		});

		return res(`Switched to ${alias} (${provider}/${modelId}).`);
	} catch (err) {
		return res(`Error switching to ${provider}/${modelId}: ${err instanceof Error ? err.message : String(err)}`, { error: true });
	}
}
