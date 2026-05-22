/**
 * Subagent Tool v2 — Delegate tasks with explicit model selection
 *
 * This file is the thin facade: tool registration, parameter schemas,
 * mode dispatch, and renderCall/renderResult wiring.
 *
 * All substantial logic lives in extracted modules:
 *   model.ts  — config loading, complexity routing, fallback
 *   spawn.ts  — process spawning, background jobs, session-scoped state
 *   render.ts — view models, TUI rendering, formatting helpers
 *   agents.ts — agent discovery from .md files
 */

import * as fs from "node:fs";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { type AgentScope, discoverAgents } from "./agents.js";
import {
	type TaskComplexity,
	type ThinkingLevel,
	buildModelsHintFromConfig,
	COMPLEXITY_DEFAULT_THINKING,
	resolveModel,
	resolveModelByComplexity,
} from "./model.js";
import type {
	SingleResult,
	SubagentDetails,
} from "./render.js";
import {
	aggregateUsageFromViews,
	buildAgentResultView,
	buildParallelSummaryView,
	formatDuration,
	formatUsageStats,
	getFinalOutput,
	renderAgentDetail,
	renderChainCollapsedText,
	renderParallelDetail,
	renderParallelTable,
	renderSingleCollapsedText,
} from "./render.js";
import {
	ThrottleState,
	cleanupOldTempFiles,
	createSpawnManager,
	mapWithConcurrencyLimit,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	type OnUpdateCallback,
	type SpawnManager,
} from "./spawn.js";
import { Container, Spacer } from "@mariozechner/pi-tui";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";

// ──────────────────────── Tool parameters ────────────────────────

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke (REQUIRED). Must match an available agent name." }),
	task: Type.String({ description: "Task description to delegate to the agent (REQUIRED)." }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke (REQUIRED). Must match an available agent name." }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output (REQUIRED)." }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user".',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (REQUIRED for single mode). Must match an available agent name exactly." })),
	task: Type.Optional(Type.String({ description: "Task description to delegate (REQUIRED for single mode). Use with 'agent'." })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution. Each item MUST have 'agent' and 'task'." })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution. Each item MUST have 'agent' and 'task'. Use {previous} placeholder." })),
	model: Type.Optional(Type.String({
		description: 'Model in "provider/model" format. Mutually exclusive with taskComplexity. Use taskComplexity for automatic model selection.',
	})),
	taskComplexity: Type.Optional(StringEnum(["low", "medium", "high"] as const, {
		description: "Task complexity for automatic model selection. PREFERRED over manual model — reads ~/.pi/agent/subagent-models.json and picks the best available model. Mutually exclusive with model.",
	})),
	thinkingLevel: Type.Optional(StringEnum(["high", "max"] as const, {
		description: "Thinking level for the subagent. Only \"high\" and \"max\" are available. Defaults by complexity: low→high, medium→high, high→max.",
	})),
	background: Type.Optional(Type.Boolean({
		description: "Run in background (single mode only). Returns job ID immediately. Default: false.",
		default: false,
	})),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

const CollectSubagentParams = Type.Object({
	jobId: Type.Optional(Type.String({
		description: "Job ID from background subagent. Omit to list all active jobs.",
	})),
});

// ──────────────────────── Extension entry ────────────────────────

export default function subagentExtension(pi: ExtensionAPI) {
	const spawnManager: SpawnManager = createSpawnManager(pi);

	// ── Tool: subagent ──
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"",
			"IMPORTANT: Provide exactly ONE mode:",
			'  - Single mode: { agent: "agent-name", task: "..." } \u2014 one agent, one task',
			'  - Parallel mode: { tasks: [{ agent: "name", task: "..." }, ...] } \u2014 run multiple agents concurrently',
			'  - Chain mode: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] } \u2014 sequential with output passing',
			"",
			'Each mode REQUIRES "agent" field(s) specifying which agent to invoke.',
			"",
			"MODEL SELECTION \u2014 provide exactly one of:",
			'  - taskComplexity: "low" | "medium" | "high" \u2014 PREFERRED. Auto-selects model + thinking level from ~/.pi/agent/subagent-models.json.',
			'  - model: "provider/model" format (e.g. "router-openai/glm-5.1"). For when you need a specific model.',
			"These are mutually exclusive. When both are omitted, an error is returned.",
			"",
			"TASK COMPLEXITY GUIDE:",
			'  "low" \u2192 fast model + high thinking. Use for:',
			"    - File search/grep/find, simple text extraction",
			"    - Batch find-and-replace with known rules (rename, import path update)",
			"    - Code formatting, lint auto-fix",
			"    - Reading 1-3 files and summarizing",
			'    - Factual Q&A ("where is this function?", "what does this export?")',
			"",
			'  "medium" \u2192 balanced model + high thinking. Use for:',
			"    - Code review, bug localization from error messages",
			"    - Single-module refactoring, writing tests for known behavior",
			"    - Call chain / data flow analysis",
			"    - Generating documentation, moderate bug fixes",
			"",
			'  "high" \u2192 strongest model + max thinking. Use for:',
			"    - Architecture design, multi-file/cross-module refactoring",
			"    - Complex debugging (race conditions, performance issues)",
			"    - End-to-end feature implementation from spec",
			"    - Code generation with test verification, security audit",
			"",
			"THINKING LEVEL: Optional. Only \"high\" and \"max\" are available.",
			"  Defaults by complexity: low\u2192high, medium\u2192high, high\u2192max.",
			"  All models always have thinking enabled. \"high\" = standard reasoning, \"max\" = maximum reasoning.",
			"",
			"BACKGROUND MODE: Set background: true (single mode only) to run a subagent without blocking.",
			"  - Returns a Job ID immediately; the main agent can continue working on other tasks.",
			"  - Results are automatically injected when the subagent completes.",
			"  - collect_subagent is only for listing active jobs or checking status.",
			"",
			buildModelsHintFromConfig(),
			"",
			"QUICK EXAMPLES:",
			'  { agent: "general-purpose", task: "analyze X", taskComplexity: "medium" }',
			'  { tasks: [{ agent: "a", task: "..." }, { agent: "b", task: "..." }], taskComplexity: "low" }',
			'  { chain: [{ agent: "a", task: "..." }, { agent: "b", task: "refine: {previous}" }], taskComplexity: "high" }',
			'  { agent: "general-purpose", task: "...", model: "router-openai/glm-5.1" }  // explicit, use sparingly',
		].join("\n"),
		parameters: SubagentParams,
		promptSnippet: "Delegate independent work to sub-agents with automatic model selection based on task complexity",
		promptGuidelines: [
			"PREFERRED: Use taskComplexity (low/medium/high) for automatic model selection \u2014 it reads ~/.pi/agent/subagent-models.json and picks the best available model",
			"'model' and 'taskComplexity' are mutually exclusive \u2014 provide exactly one, never both",
			"Only use explicit 'model' when you need a specific model for a known reason (e.g. testing a particular provider)",
			"thinkingLevel is optional \u2014 when omitted with taskComplexity, defaults are: low\u2192high, medium\u2192high, high\u2192max",
			"thinkingLevel only accepts \"high\" or \"max\" \u2014 all models always think",
			"background: true runs a subagent non-blocking \u2014 the main agent can continue other work immediately",
			"Background results are automatically injected into the conversation when the subagent completes \u2014 no collect needed",
			"Use collect_subagent only to list active background jobs or check on a running job's status",
			"",
			"IMPORTANT for parallel mode: isError=true means at least one task failed.",
			"Check each agent's individual status to identify which failed and decide",
			"whether to retry, skip, or handle. Do not treat partial failure as total failure.",
		],

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			cleanupOldTempFiles();
			const isBackground = (params.background as boolean) ?? false;

			// ── Step 1: Resolve model + thinking level ──
			const modelParam = params.model as string | undefined;
			const taskComplexity = params.taskComplexity as TaskComplexity | undefined;
			const thinkingParam = params.thinkingLevel as ThinkingLevel | undefined;

			if (modelParam && taskComplexity) {
				return {
					content: [{ type: "text", text: "ERROR: 'model' and 'taskComplexity' are mutually exclusive. Remove one.\nRecommended: remove 'model' and keep 'taskComplexity' for automatic selection.\nOnly use 'model' when you need a specific provider for a known reason." }],
					details: { mode: "single" as const, resolvedModel: "", agentScope: "user" as AgentScope, projectAgentsDir: null, results: [] },
					isError: true,
				};
			}

			let effectiveComplexity: TaskComplexity | undefined = taskComplexity;
			if (!modelParam && !taskComplexity) {
				effectiveComplexity = "medium";
			}

			let resolvedModel: string;
			let resolvedThinking: ThinkingLevel | undefined;
			if (effectiveComplexity) {
				const result = await resolveModelByComplexity(effectiveComplexity, ctx);
				if (!result.ok) {
					return {
						content: [{ type: "text", text: (result as { ok: false; error: string }).error }],
						details: { mode: "single" as const, resolvedModel: "", agentScope: "user" as AgentScope, projectAgentsDir: null, results: [] },
						isError: true,
					};
				}
				resolvedModel = result.ref;
				resolvedThinking = thinkingParam ?? COMPLEXITY_DEFAULT_THINKING[effectiveComplexity];
			} else {
				const result = await resolveModel(modelParam!, ctx);
				if (!result.ok) {
					return {
						content: [{ type: "text", text: (result as { ok: false; error: string }).error }],
						details: { mode: "single" as const, resolvedModel: modelParam!, agentScope: "user" as AgentScope, projectAgentsDir: null, results: [] },
						isError: true,
					};
				}
				resolvedModel = result.ref;
				resolvedThinking = thinkingParam;
			}

			// ── Step 2: Discover agents ──
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			// ── Step 3: Determine mode ──
			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain" | "background") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					resolvedModel,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` }],
					details: makeDetails("single")([]),
				};
			}

			// ── Step 4: Confirm project agents ──
			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is typeof agents[number] => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			// ── Step 5: Background single mode ──
			if (isBackground) {
				if (!hasSingle) {
					return {
						content: [{ type: "text", text: "Background mode only supports single mode (agent + task)." }],
						details: makeDetails("background")([]),
						isError: true,
					};
				}

				const bgResult = await spawnManager.startBackgroundJob(
					ctx.cwd, agents, params.agent as string, params.task as string, resolvedModel, params.cwd as string | undefined, resolvedThinking,
				);

				if (!bgResult.ok) {
					return {
						content: [{ type: "text", text: (bgResult as { ok: false; error: string }).error }],
						details: makeDetails("background")([]),
						isError: true,
					};
				}

				return {
					content: [{
						type: "text",
						text: [
							`[Background subagent started]`,
							`  Job ID: ${bgResult.jobId}`,
							`  Agent:  ${params.agent}`,
							`  Model:  ${resolvedModel}`,
							`  Task:   ${(params.task as string).slice(0, 100)}`,
							``,
							`Results will be injected automatically when the subagent completes.`,
					`Use collect_subagent to check status or list active jobs.`,
						].join("\n"),
					}],
					details: makeDetails("background")([]),
				};
			}

			// ── Step 6: Foreground chain mode ──
			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await spawnManager.runSingleAgent(
						ctx.cwd, agents, step.agent, taskWithContext,
						resolvedModel, step.cwd, i + 1, signal, chainUpdate, makeDetails("chain"), resolvedThinking,
					);
					results.push(result);

					const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			// ── Step 7: Foreground parallel mode ──
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
						details: makeDetails("parallel")([]),
					};

				const allResults: SingleResult[] = new Array(params.tasks.length);
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						startTime: Date.now(),
						lastActivityTime: Date.now(),
					};
				}

				const throttle = new ThrottleState(500);

				const emitParallelUpdate = () => {
					if (onUpdate && throttle.shouldEmit()) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await spawnManager.runSingleAgent(
						ctx.cwd, agents, t.agent, t.task,
						resolvedModel, t.cwd, undefined, signal,
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"), resolvedThinking,
					);
					allResults[index] = result;
					throttle.forceEmit();
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages);
					const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
					return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
				});
				return {
					content: [{
						type: "text",
						text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
					}],
					details: makeDetails("parallel")(results),
					isError: results.some((r) => r.exitCode !== 0),
				};
			}

			// ── Step 8: Foreground single mode ──
			if (params.agent && params.task) {
				const result = await spawnManager.runSingleAgent(
					ctx.cwd, agents, params.agent, params.task,
					resolvedModel, params.cwd, undefined, signal, onUpdate, makeDetails("single"), resolvedThinking,
				);
				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			const complexity = args.taskComplexity as string | undefined;
			const model = args.model || (complexity ? `auto:${complexity}` : "?");
			const thinking = args.thinkingLevel as string | undefined;
			const modelDisplay = thinking ? theme.fg("dim", ` ${model}/${thinking}`) : theme.fg("dim", ` ${model}`);
			const bg = args.background ? theme.fg("warning", " [bg]") : "";

			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`) +
					modelDisplay +
					bg;
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text += "\n  " + theme.fg("muted", `${i + 1}.`) + " " + theme.fg("accent", step.agent) + theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`) +
					modelDisplay +
					bg;
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`) +
				modelDisplay +
				bg;
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			if (details.mode === "single" && details.results.length === 1) {
				const view = buildAgentResultView(details.results[0]);
				if (expanded) {
					return renderAgentDetail(view, theme, mdTheme, { showTask: true });
				}
				return new Text(renderSingleCollapsedText(view, theme), 0, 0);
			}

			if (details.mode === "chain") {
				const views = details.results.map((r) => buildAgentResultView(r));
				const successCount = views.filter((v) => v.status === "succeeded").length;
				const icon = successCount === views.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					const durations = views
						.filter((v) => v.duration.durationMs !== undefined)
						.map((v) => v.duration.durationMs!);
					const totalMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) : undefined;
					const durationStr = totalMs !== undefined ? ` (${formatDuration(totalMs)})` : "";

					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${views.length} steps`)}${durationStr}`,
							0, 0,
						),
					);

					for (let i = 0; i < views.length; i++) {
						const stepView = views[i];
						const stepLabel = `Step ${details.results[i].step ?? i + 1}`;
						container.addChild(new Spacer(1));
						const detail = renderAgentDetail(stepView, theme, mdTheme, { label: stepLabel, showTask: true });
						for (const child of detail.children) {
							container.addChild(child);
						}
					}

					const totalUsage = aggregateUsageFromViews(views);
					if (totalUsage) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
					}
					return container;
				}

				return renderChainCollapsedText(views, details, icon, theme);
			}

			if (details.mode === "parallel") {
				const summary = buildParallelSummaryView(details.results);
				if (expanded && summary.isDone) {
					return renderParallelDetail(summary, theme, mdTheme);
				}
				return renderParallelTable(summary, theme);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// ── Tool: collect_subagent ──
	pi.registerTool({
		name: "collect_subagent",
		label: "Collect Subagent",
		description: "Collect results from a background subagent. Omit jobId to list all active background jobs.",
		parameters: CollectSubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const jobId = params.jobId as string | undefined;
			const jobs = spawnManager.getActiveJobs();
			const jobEvents = spawnManager.getJobEvents();
			const sessionJobFiles = spawnManager.getSessionJobFiles();

			if (!jobId) {
				const lines: string[] = ["[Active background jobs]"];
				for (const [id, job] of jobs) {
					const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);
					lines.push(`  ${id} | ${job.status} | ${job.model} | ${elapsed}s | "${job.task.slice(0, 50)}..."`);
				}
				if (lines.length === 1) lines.push("  (none)");
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { count: jobs.size },
				};
			}

			const job = jobs.get(jobId);
			if (!job) {
				return {
					content: [{ type: "text", text: `[Job not found: ${jobId}]` }],
					details: undefined,
					isError: true,
				};
			}

			const POLL_INTERVAL_SEC = 10;
			let outputComplete = false;

			while (job.status === "running" && !outputComplete) {
				const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);

				const stopReason = job.parseResult.stopReason;
				if (stopReason !== undefined && stopReason !== "tool_use") {
					outputComplete = true;
					const elapsedNow = ((Date.now() - job.startedAt) / 1000).toFixed(1);
					onUpdate?.({
						content: [{
							type: "text",
							text: `[Job ${jobId.slice(0, 8)}... output complete (${elapsedNow}s), finalizing...]`,
						}],
						details: undefined,
					});
					break;
				}

				onUpdate?.({
					content: [{
						type: "text",
						text: `[Job ${jobId.slice(0, 8)}... still running (${elapsed}s), polling...]`,
					}],
					details: undefined,
				});

				const eventName = `done:${jobId}`;
				const aborted = await new Promise<boolean>((resolve) => {
					let settled = false;

					const settle = (value: boolean) => {
						if (settled) return;
						settled = true;
						jobEvents.off(eventName, onDone);
						clearTimeout(timer);
						if (signal) signal.removeEventListener("abort", onAbort);
						resolve(value);
					};

					const onDone = () => settle(false);
					const onAbort = () => settle(true);

					const timer = setTimeout(() => settle(false), POLL_INTERVAL_SEC * 1000);

					jobEvents.on(eventName, onDone);
					if (signal) {
						if (signal.aborted) { settle(true); return; }
						signal.addEventListener("abort", onAbort, { once: true });
					}
				});

				if (aborted) {
					return {
						content: [{ type: "text", text: `[Job ${jobId.slice(0, 8)}... collection aborted by user]` }],
						details: undefined,
						isError: true,
					};
				}
			}

			if (outputComplete && job.status === "running") {
				try {
					process.kill(job.pid, "SIGTERM");
					setTimeout(() => {
						try { process.kill(job.pid, "SIGKILL"); } catch { /* already dead */ }
					}, 2000);
				} catch {
					/* already dead */
				}
			}

			const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);
			const parsed = job.parseResult;
			let stderr = "";
			try {
				if (fs.existsSync(job.errFile)) stderr = fs.readFileSync(job.errFile, "utf-8").trim();
			} catch { /* ignore */ }

			const label = job.status === "done" ? "completed" : job.status;
			const usageStr = formatUsageStats(parsed.usage, parsed.model);
			const parts = [
				`[Background job ${jobId.slice(0, 8)}... ${label} (${elapsed}s)]`,
				`  Agent: ${job.agent}`,
				`  Model: ${job.model}`,
			];
			if (usageStr) parts.push(`  Usage: ${usageStr}`);
			if (parsed.errorMessage) parts.push(`  Error: ${parsed.errorMessage}`);
			parts.push("", parsed.output || "(no output)");
			if (stderr) parts.push("", `[stderr]`, stderr);

			for (const f of [job.outFile, job.errFile]) {
				try { fs.unlinkSync(f); } catch { /* ignore */ }
				sessionJobFiles.delete(f);
			}
			jobs.delete(jobId);

			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: undefined,
			};
		},
	});

	// ── Cleanup on session shutdown ──
	pi.on("session_shutdown", async () => {
		spawnManager.cleanupAllJobs();
	});
}
