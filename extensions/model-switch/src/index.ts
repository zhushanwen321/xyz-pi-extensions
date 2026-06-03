/**
 * Pi Model Switch — 上下文注入 + 模型切换扩展
 *
 * session_start/resume：注入 [Available Models] 能力表
 * before_agent_start 每轮注入：数据 + 推荐（[Model Context]）
 * switch_model tool：list/search/switch/recommend/setup
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { readCache } from "@zhushanwen/pi-quota-providers";

import { loadConfig } from "./config";
import { computeQuotaSnapshot, computeStickiness, computePeakRecommend } from "./advisor";
import { formatSessionModels, formatContextPrompt } from "./prompt";
import { generatePolicyConfig, readEnabledModels, getConfigPath, deletePolicyConfig, readPolicyConfigContent } from "./setup";
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
	/** 首次 before_agent_start 时注入 [Available Models] */
	injectedModelTable: boolean;
}

// ── 扩展入口 ────────────────────────────────────────────

export default function modelSwitchExtension(pi: ExtensionAPI) {
	const state: SessionState = { config: null, injectedModelTable: false };

	pi.on("session_start", async (_event: unknown, _ctx: ExtensionContext) => {
		state.config = loadConfig();
		state.injectedModelTable = false;
	});

	pi.on("before_agent_start", async (_event: unknown, ctx: ExtensionContext) => {
		if (!state.config) return;

		try {
			const currentModel = getCurrentModelId(ctx);
			const entries = asSessionEntries(ctx.sessionManager.getBranch());
			const cache = readCache();
			const config = state.config;

			// 计算快照 + 推荐
			const snapshot = computeQuotaSnapshot(cache, config);
			const stickiness = computeStickiness(entries, config);
			const recommend = computePeakRecommend(new Date(), config, snapshot);

			// 注入 [Model Context]（每轮）
			const injection = formatContextPrompt({
				currentModel,
				stickiness,
				snapshot,
				recommend,
				config,
				now: new Date(),
			});

			// 首次注入 [Available Models]（session_start / resume 后一次）
			let modelTable = "";
			if (!state.injectedModelTable) {
				modelTable = "\n" + formatSessionModels(config);
				state.injectedModelTable = true;
			}

			return { systemPrompt: `\n${injection}${modelTable}` };
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

function handleList(state: SessionState, ctx: ExtensionContext): ToolRes {
	if (!state.config) {
		return res("No model policy configured. Run /setup-model-policy to generate one.");
	}

	const currentModel = getCurrentModelId(ctx);
	const lines: string[] = [];

	for (const [provider, pcfg] of Object.entries(state.config.models)) {
		lines.push(`  ${provider} (plan: ${pcfg.plan}):`);
		for (const [alias, entry] of Object.entries(pcfg.models)) {
			const modelStr = `${pcfg.plan}/${entry.modelId}`;
			const caps = entry.capabilities.length > 0 ? ` [${entry.capabilities.join(", ")}]` : "";
			const current = modelStr === currentModel ? " ← current" : "";
			lines.push(`    ${alias} → ${modelStr}${current}${caps}`);
		}
	}

	const sceneInfo = Object.entries(state.config.scenes)
		.map(([s, aliases]) => `  ${s}: ${aliases.join(", ")}`)
		.join("\n");

	return res(`Configured models:\n\n${lines.join("\n")}\n\nScenes:\n${sceneInfo}`);
}

function handleSearch(state: SessionState, query: string): ToolRes {
	if (!state.config) return res("No model policy configured.");
	if (!query) return res("Please provide a search query.", { error: true });

	const matches: Array<{ provider: string; alias: string; entry: { modelId: string; capabilities: string[] } }> = [];

	for (const [provider, pcfg] of Object.entries(state.config.models)) {
		for (const [alias, entry] of Object.entries(pcfg.models)) {
			if (alias.toLowerCase().includes(query)
				|| entry.modelId.toLowerCase().includes(query)
				|| provider.toLowerCase().includes(query)) {
				matches.push({ provider, alias, entry });
			}
		}
	}

	if (matches.length === 0) return res(`No models matching "${query}".`);

	const lines = matches.map(
		(m) => `  ${m.alias} (${m.provider}) → ${m.entry.modelId} [${m.entry.capabilities.join(", ")}]`,
	);
	return res(`Models matching "${query}" (${matches.length}):\n\n${lines.join("\n")}`);
}

async function handleSwitch(state: SessionState, pi: ExtensionAPI, ctx: ExtensionContext, query: string): Promise<ToolRes> {
	if (!state.config) return res("No model policy configured. Cannot switch.", { error: true });
	if (!query) return res("Please specify a model alias to switch to (e.g., 'glm-5.1').", { error: true });

	// Search by alias
	for (const [, pcfg] of Object.entries(state.config.models)) {
		for (const [alias, entry] of Object.entries(pcfg.models)) {
			if (alias.toLowerCase() === query || entry.modelId.toLowerCase() === query) {
				return switchToModel(pi, ctx, pcfg.plan, entry.modelId, alias);
			}
		}
	}

	// Fuzzy search by modelId
	for (const [, pcfg] of Object.entries(state.config.models)) {
		for (const [alias, entry] of Object.entries(pcfg.models)) {
			if (alias.toLowerCase().includes(query) || entry.modelId.toLowerCase().includes(query)) {
				return switchToModel(pi, ctx, pcfg.plan, entry.modelId, alias);
			}
		}
	}

	return res(`No model matching "${query}". Use 'list' to see available models.`, { error: true });
}

function handleRecommend(state: SessionState, ctx: ExtensionContext): ToolRes {
	if (!state.config) return res("No model policy configured.");

	try {
		const currentModel = getCurrentModelId(ctx);
		const entries = asSessionEntries(ctx.sessionManager.getBranch());
		const cache = readCache();
		const config = state.config;

		const snapshot = computeQuotaSnapshot(cache, config);
		const stickiness = computeStickiness(entries, config);
		const recommend = computePeakRecommend(new Date(), config, snapshot);

		const formatted = formatContextPrompt({
			currentModel,
			stickiness,
			snapshot,
			recommend,
			config,
			now: new Date(),
		});

		return res(`Current model context:\n\n${formatted}`);
	} catch (err) {
		return res(`Failed to compute context: ${(err as Error).message}`, { error: true });
	}
}

function handleSetup(state: SessionState, ctx: ExtensionContext, query?: string): ToolRes {
	const subAction = (query ?? "").trim().toLowerCase();

	if (subAction === "delete") {
		const result = deletePolicyConfig();
		if (result.ok) {
			state.config = null;
			return res(`Config deleted: ${result.path}. Run /setup-model-policy to regenerate.`);
		}
		return res(result.error, { error: true });
	}

	if (subAction === "list") {
		const result = readPolicyConfigContent();
		if (!result.ok) return res(result.error, { error: true });
		return res(`Current model-policy.json (${result.path}):\n\n\`\`\`json\n${result.content}\n\`\`\``);
	}

	if (subAction === "edit") {
		const result = readPolicyConfigContent();
		if (!result.ok) return res(result.error, { error: true });
		return res([
			"Current model-policy.json for editing:\n",
			"```json",
			result.content,
			"```\n",
			"Tell me what you want to change. Examples:",
			'- "Change peak hours to 12-18"',
			'- "Add model X to coding scene"',
			'- "Set opencode-go rolling threshold to 90%"',
			'- "Remove minimax from the config"\n',
			"I'll modify the config and confirm with you before saving. Say 'save' when ready.",
		].join("\n"));
	}

	// No sub-action: generate new config
	if (state.config) {
		return res(`Config already exists at ${getConfigPath()}. Use 'setup delete' to remove, 'setup list' to view, or 'setup edit' to modify.`);
	}

	const enabledModels = readEnabledModels();
	const genResult = generatePolicyConfig(ctx.modelRegistry, enabledModels);

	return res([
		"Auto-generated model-policy.json (v2).",
		"Review the config below. If it looks correct, write it to " + getConfigPath() + " using the write tool.",
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
		// 尝试直接匹配 Pi 模型 registry（provider 可能含 -router 后缀）
		const match = ctx.modelRegistry.find(provider, modelId);
		if (!match) {
			return res(`Model ${provider}/${modelId} not available.`, { error: true });
		}

		pi.appendEntry("model_change", {
			provider,
			modelId,
			alias,
			timestamp: new Date().toISOString(),
		});

		return res(`Switched to ${alias} (${provider}/${modelId}).`);
	} catch (err) {
		return res(`Error switching: ${err instanceof Error ? err.message : String(err)}`, { error: true });
	}
}
