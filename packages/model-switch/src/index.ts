/**
 * Pi Model Switch — 智能模型推荐与切换扩展
 *
 * before_agent_start 注入推荐提示 + switch_model 工具。
 * 配置文件不存在时降级为仅手动切换工具。
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { readCache } from "@zhushanwen/pi-quota-providers";

import { loadConfig } from "./config";
import { computeRecommendation, computeQuotaSnapshot, detectScene } from "./advisor";
import { formatAdvisorPrompt } from "./prompt";
import { generatePolicyConfig, readEnabledModels, getConfigPath } from "./setup";
import { getCurrentModelId, type SessionEntries, type ModelPolicy } from "./types";

interface SessionState {
	config: ModelPolicy | null;
}

export default function modelSwitchExtension(pi: ExtensionAPI) {
	const state: SessionState = { config: null };

	// ── Session Start ────────────────────────────────────
	pi.on("session_start", async (_event: unknown, _ctx: ExtensionContext) => {
		state.config = loadConfig();
	});

	// ── Before Agent Start: 注入推荐 ────────────────────
	pi.on("before_agent_start", async (_event: unknown, ctx: ExtensionContext) => {
		if (!state.config) return;

		try {
			const prompt = ctx.getSystemPrompt();
			const currentModel = getCurrentModelId(ctx);
			const scene = detectScene(prompt);
			const entries = ctx.sessionManager.getBranch() as SessionEntries;

			const rec = computeRecommendation(state.config, scene, currentModel, entries);
			const snapshot = computeQuotaSnapshot(readCache());
			const injection = formatAdvisorPrompt(rec, snapshot, state.config, new Date());
			return { systemPrompt: `\n${injection}` };
		} catch {
			return;
		}
	});

	// ── /setup-model-policy 命令 ───────────────────────
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

	// ── switch_model 工具 ───────────────────────────────
	pi.registerTool({
		name: "switch_model",
		label: "Switch Model",
		description:
			"List configured models, search by alias/name, switch to another model, or show current recommendation. "
			+ "Configured models are defined in model-policy.json.",
		promptSnippet:
			"Use this tool when the user asks to list/search/switch models, requests a specific model/provider, "
			+ "or when you need to respond to the Model Advisor recommendation.",
		parameters: Type.Object({
			action: StringEnum(["list", "search", "switch", "recommend", "setup"], {
				description: "Action: list (show all), search (filter), switch (change), recommend (show advice), setup (generate config)",
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
		) {
			const action = params.action;
			const query = (params.query ?? "").trim().toLowerCase();

			if (action === "list") return handleList(state, ctx);
			if (action === "search") return handleSearch(state, query);
			if (action === "switch") return handleSwitch(state, pi, ctx, query);
			if (action === "recommend") return handleRecommend(state, ctx);
			if (action === "setup") return handleSetup(state, ctx);

			return {
				content: [{ type: "text" as const, text: `Unknown action: ${action}. Supported: list, search, switch, recommend, setup.` }],
				isError: true,
			};
		},
	});
}

// ── Action Handlers ────────────────────────────────────

function handleList(
	state: { config: ModelPolicy | null },
	ctx: ExtensionContext,
) {
	if (!state.config) {
		return { content: [{ type: "text" as const, text: "No model policy configured. Run /setup-model-policy to generate one." }] };
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

	return {
		content: [{
			type: "text" as const,
			text: `Configured models (${Object.keys(state.config.models).length}):\n\n${lines.join("\n")}\n\nScenes:\n${sceneInfo}`,
		}],
	};
}

function handleSearch(
	state: { config: ModelPolicy | null },
	query: string,
) {
	if (!state.config) {
		return { content: [{ type: "text" as const, text: "No model policy configured." }] };
	}

	if (!query) {
		return { content: [{ type: "text" as const, text: "Please provide a search query." }], isError: true };
	}

	const matches = Object.entries(state.config.models).filter(
		([alias, entry]) =>
			alias.toLowerCase().includes(query)
			|| entry.provider.toLowerCase().includes(query)
			|| entry.modelId.toLowerCase().includes(query),
	);

	if (matches.length === 0) {
		return { content: [{ type: "text" as const, text: `No models matching "${query}".` }] };
	}

	const lines = matches.map(([alias, entry]) => `  ${alias} \u2192 ${entry.provider}/${entry.modelId} [${entry.capabilities.join(", ")}]`);
	return {
		content: [{ type: "text" as const, text: `Models matching "${query}" (${matches.length}):\n\n${lines.join("\n")}` }],
	};
}

async function handleSwitch(
	state: { config: ModelPolicy | null },
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	query: string,
) {
	if (!state.config) {
		return { content: [{ type: "text" as const, text: "No model policy configured. Cannot switch." }], isError: true };
	}

	if (!query) {
		return {
			content: [{ type: "text" as const, text: "Please specify a model alias to switch to (e.g., 'glm-5.1') or use 'search' first." }],
			isError: true,
		};
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
		return {
			content: [{ type: "text" as const, text: `No model matching "${query}". Use 'list' to see available models or 'search' to find by keyword.` }],
			isError: true,
		};
	}

	const [matchedAlias, matchedEntry] = fuzzyEntry;
	return switchToModel(pi, ctx, matchedEntry.provider, matchedEntry.modelId, matchedAlias);
}

function handleRecommend(
	state: { config: ModelPolicy | null },
	ctx: ExtensionContext,
) {
	if (!state.config) {
		return { content: [{ type: "text" as const, text: "No model policy configured. No recommendation available." }] };
	}

	try {
		const currentModel = getCurrentModelId(ctx);
		const prompt = ctx.getSystemPrompt();
		const scene = detectScene(prompt);
		const entries = ctx.sessionManager.getBranch() as SessionEntries;

		const rec = computeRecommendation(state.config, scene, currentModel, entries);
		const snapshot = computeQuotaSnapshot(readCache());
		const formatted = formatAdvisorPrompt(rec, snapshot, state.config, new Date());

		return { content: [{ type: "text" as const, text: `Current recommendation:\n\n${formatted}` }] };
	} catch (err) {
		return {
			content: [{ type: "text" as const, text: `Failed to compute recommendation: ${(err as Error).message}` }],
			isError: true,
		};
	}
}

function handleSetup(
	state: { config: ModelPolicy | null },
	ctx: ExtensionContext,
) {
	if (state.config) {
		return {
			content: [{ type: "text" as const, text: `Config already exists at ${getConfigPath()}. Delete it first if you want to regenerate.` }],
		};
	}

	const enabledModels = readEnabledModels();
	const result = generatePolicyConfig(ctx.modelRegistry, enabledModels);

	return {
		content: [{
			type: "text" as const,
			text: [
				"Auto-generated model-policy.json based on your configured models.",
				"Review the config below. If it looks correct, write it to " + getConfigPath() + " using the write tool.",
				"Adjust any values before writing (e.g. peak hours, scene preferences, budget target).",
				"",
				"```json",
				result.json,
				"```",
			].join("\n"),
		}],
	};
}

// ── 辅助函数 ────────────────────────────────────────────

async function switchToModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	provider: string,
	modelId: string,
	alias: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
	try {
		const currentModel = getCurrentModelId(ctx);

		if (currentModel === `${provider}/${modelId}`) {
			return { content: [{ type: "text" as const, text: `Already using ${alias} (${provider}/${modelId}).` }] };
		}

		const match = ctx.modelRegistry.find(provider, modelId);
		if (!match) {
			return {
				content: [{ type: "text" as const, text: `Model ${provider}/${modelId} not available (API key may not be configured).` }],
				isError: true,
			};
		}

		const success = await pi.setModel(match);
		if (!success) {
			return {
				content: [{ type: "text" as const, text: `Failed to switch to ${provider}/${modelId}.` }],
				isError: true,
			};
		}

		ctx.sessionManager.appendCustomEntry?.("model_change", {
			provider,
			modelId,
			alias,
			timestamp: new Date().toISOString(),
		});

		return { content: [{ type: "text" as const, text: `Switched to ${alias} (${provider}/${modelId}).` }] };
	} catch (err) {
		return {
			content: [{ type: "text" as const, text: `Error switching to ${provider}/${modelId}: ${err instanceof Error ? err.message : String(err)}` }],
			isError: true,
		};
	}
}
