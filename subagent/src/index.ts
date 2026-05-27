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
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentScope, discoverAgents } from "./agents.js";
import {
	type TaskComplexity,
	type ThinkingLevel,
	buildModelsHintFromConfig,
	COMPLEXITY_DEFAULT_THINKING,
	resolveModel,
	resolveModelByComplexity,
	resolveModelByComplexitySync,
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
	getFinalOutput,
	renderAgentDetail,
	renderChainCollapsedText,
	renderStatusIcon,
	renderParallelDetail,
	renderParallelTable,
	renderSingleCollapsedText,
} from "./render.js";
import {
	ThrottleState,
	cleanupOldTempFiles,
	createSpawnManager,
	DEFAULT_CONCURRENCY,
	mapWithConcurrencyLimit,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	type OnUpdateCallback,
	type SpawnManager,
	resolveMemorySessionFile,
} from "./spawn.js";
import {
	buildVisionMemoryId,
	loadVisionModels,
	resolveVisionModel,
	VISION_ALLOWED_TOOLS,
	VISION_SYSTEM_PROMPT,
} from "./vision.js";

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

const ConcurrencySchema = Type.Optional(Type.Number({
	description: [
		`Optional. Max simultaneous subagents in parallel mode. Default: ${DEFAULT_CONCURRENCY}, max: ${MAX_CONCURRENCY}.`,
		"Ignored in single/chain/background modes.",
		"Values outside [1, max] are clamped. Omit to use default.",
	].join(" "),
	minimum: 1,
	maximum: MAX_CONCURRENCY,
	default: DEFAULT_CONCURRENCY,
}));

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
	concurrency: ConcurrencySchema,
	memory: Type.Optional(Type.String({
		description: [
			"Persistent session identifier (single mode only). Same ID = same session across calls.",
			"",
			"How it works: first call copies main session as a snapshot, creating the subagent's session file.",
			"Subsequent calls with the same ID resume that file — the subagent keeps its own accumulated history.",
			"The subagent does NOT see the main agent's updates after the first call (it's a snapshot, not a live link).",
			"Memory files are deleted when the main Pi session ends.",
			"",
			"Use when: the subagent will be called multiple times and needs to build on its own prior output.",
			"Don't use when: one-shot tasks, or the task prompt already contains everything the subagent needs.",
		].join("\n"),
	})),
});

// ──────────────────────── analyze_image parameters ────────────────────────

const AnalyzeImageParams = Type.Object({
	image_path: Type.String({ description: "Image file path. Relative paths resolved via cwd." }),
	question: Type.String({ description: "The question to answer about the image" }),
});

export default function subagentExtension(pi: ExtensionAPI) {
	// Session-scoped state: each session gets its own SpawnManager and captured ID.
	// Using Map keyed by sessionId ensures Session A cannot affect Session B.
	const sessionStates = new Map<string, { spawnManager: SpawnManager; capturedSessionId: string; timerIntervals: Set<ReturnType<typeof setInterval>>; memoryFiles: Set<string> }>();
	// Track the most recent session ID for cleanup during session_shutdown
	// (SessionShutdownEvent doesn't carry sessionManager)
	let lastSessionId = "";

	function getSessionState(sessionId: string) {
	let state = sessionStates.get(sessionId);
		if (!state) {
			state = {
				spawnManager: createSpawnManager(pi),
				capturedSessionId: "",
				timerIntervals: new Set(),
				memoryFiles: new Set(),
			};
			sessionStates.set(sessionId, state);
		}
		return state;
	}

	// ── Tool: subagent ──
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"",
			"MODES — provide exactly ONE:",
			'  Single:   { agent, task }             — one agent, one task',
			'  Parallel: { tasks: [{agent, task}...] } — concurrent execution, control parallelism with concurrency param',
			'  Chain:    { chain: [{agent, task}...] }  — sequential, pass prior output via {previous} placeholder',
			"",
			"MODEL — provide taskComplexity (preferred) or model, never both:",
			'  taskComplexity: "low"    → fast model + high thinking. Grep/find, text extraction, formatting, Q&A.',
			'  taskComplexity: "medium" → balanced model + high thinking. Code review, single-module refactor, docs.',
			'  taskComplexity: "high"   → strongest model + max thinking. Architecture, multi-file refactor, complex bugs.',
			'  model: "provider/name"   — override when you need a specific model (use sparingly).',
			"  When neither is provided, taskComplexity defaults to \"medium\".",
			"  thinkingLevel: optional, \"high\" or \"max\". Defaults by complexity: low→high, medium→high, high→max.",
			"",
			"PARALLEL MODE CONTROLS:",
			`  concurrency: N — max simultaneous subagents. Default ${DEFAULT_CONCURRENCY}, max ${MAX_CONCURRENCY}. Omit to use default.`,
			"  Pass ALL tasks at once — the tool handles batching internally. Do NOT manually split into batches.",
			"",
			"BACKGROUND (single mode only): background: true returns Job ID immediately, result auto-injected on completion.",
			"",
			buildModelsHintFromConfig(),
			"",
			"MEMORY (single mode only): memory: \"id\" gives the subagent a persistent session across calls.",
			"  First call: snapshots main session. Subsequent calls: resumes subagent's own accumulated session.",
			"  The subagent does NOT see main agent updates after snapshot — include new info in task prompt.",
			"  Use for: multi-turn iteration (analysis→impl→fix→review), deep project context reuse.",
			"  Don't use for: one-shot tasks, tasks where the prompt already contains everything needed.",
			"",
			"TASK PROMPT CONSTRUCTION — subagents run in isolated processes with no conversation history.",
			"  A good task prompt includes:",
			"    1. Context: why this task exists and how it fits the overall goal",
			"    2. File paths: exact files to read/modify (don't make the subagent search for them)",
			"    3. Known facts: what you already discovered (entry points, data types, relevant APIs)",
			"    4. Constraints: files not to touch, conventions to follow, output format expected",
			"  For simple 1-2 file tasks, just file paths + what to do is sufficient.",
			"",
			"EXAMPLES:",
			'  { agent: "general-purpose", task: "analyze X", taskComplexity: "medium" }',
			'  { tasks: [{ agent: "a", task: "..." }, { agent: "b", task: "..." }], taskComplexity: "low", concurrency: 3 }',
			'  { chain: [{ agent: "a", task: "..." }, { agent: "b", task: "refine: {previous}" }], taskComplexity: "high" }',
			'  { agent: "general-purpose", task: "...", background: true, taskComplexity: "low" }',
		].join("\n"),
		parameters: SubagentParams,
		promptSnippet: "Delegate tasks to specialized subagents: single, parallel (with concurrency control), chain, or background mode. Auto-selects model via taskComplexity.",
		promptGuidelines: [
			"Always provide taskComplexity or model — never both, never neither (defaults to medium if omitted).",
			"Do NOT manually split parallel tasks into batches — pass ALL tasks at once, use concurrency to control parallelism.",
			"Subagents have no conversation history. Include context, file paths, known facts, and constraints in the task prompt.",
			"Parallel mode: isError=true means at least one task failed. Check each result individually — partial failure is not total failure.",
			"Each subagent is an independent process with its own token cost. Prefer lower taskComplexity when running many parallel tasks.",
		],

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			cleanupOldTempFiles();

			// Session-scoped state lookup
			const sessionId = ctx.sessionManager.getSessionId();
			lastSessionId = sessionId;
			const state = getSessionState(sessionId);
			state.capturedSessionId = sessionId;
			const spawnManager = state.spawnManager;

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
				// This branch is reached only when effectiveComplexity is falsy,
				// meaning modelParam must be set. Guard defensively anyway.
				if (!modelParam) {
					return {
						content: [{ type: "text", text: "ERROR: No model or taskComplexity specified." }],
						details: { mode: "single" as const, resolvedModel: "", agentScope: "user" as AgentScope, projectAgentsDir: null, results: [] },
						isError: true,
					};
				}
				const result = await resolveModel(modelParam, ctx);
				if (!result.ok) {
					return {
						content: [{ type: "text", text: (result as { ok: false; error: string }).error }],
						details: { mode: "single" as const, resolvedModel: modelParam, agentScope: "user" as AgentScope, projectAgentsDir: null, results: [] },
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
				(results: SingleResult[]): SubagentDetails => {
					const base: SubagentDetails = {
						mode,
						resolvedModel,
						agentScope,
						projectAgentsDir: discovery.projectAgentsDir,
						results,
					};

					if (mode === "parallel" && results.length > 0) {
						const successCount = results.filter((r) => r.exitCode === 0).length;
						const isDone = results.every((r) => r.exitCode !== -1);
						if (isDone) {
							base._render = {
								type: "summary-table" as const,
								summary: `${successCount}/${results.length} succeeded`,
								data: {
									columns: ["Agent", "Task", "Status", "Duration"],
									rows: results.map((r) => ({
										Agent: r.agent,
										Task: r.task.length > 60 ? `${r.task.slice(0, 60)}...` : r.task,
										Status: r.exitCode === 0 ? "completed" : "failed",
										Duration: r.durationMs !== undefined
											? formatDuration(r.durationMs)
											: r.endTime !== undefined
												? formatDuration(r.endTime - r.startTime)
												: formatDuration(r.lastActivityTime - r.startTime),
									})),
								},
							};
						}
					}

					if (mode === "chain" && results.length > 0) {
						const successCount = results.filter((r) => r.exitCode === 0).length;
						const isDone = results.every((r) => r.exitCode !== -1);
						if (isDone) {
							base._render = {
								type: "summary-table" as const,
								summary: `${successCount}/${results.length} succeeded`,
								data: {
									columns: ["Step", "Agent", "Task", "Status", "Duration"],
									rows: results.map((r, i) => ({
										Step: String(r.step ?? i + 1),
										Agent: r.agent,
										Task: r.task.length > 50 ? `${r.task.slice(0, 50)}...` : r.task,
										Status: r.exitCode === 0 ? "completed" : "failed",
										Duration: r.durationMs !== undefined
											? formatDuration(r.durationMs)
											: r.endTime !== undefined
												? formatDuration(r.endTime - r.startTime)
												: formatDuration(r.lastActivityTime - r.startTime),
									})),
								},
							};
						}
					}

					return base;
				};

			// ── Memory mode validation ──
			const memoryParam = params.memory?.trim();
			if (memoryParam) {
				if (isBackground) {
					return {
						content: [{ type: "text", text: "ERROR: 'memory' is not supported in background mode. Use single mode for persistent sessions." }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				if (hasTasks) {
					return {
						content: [{ type: "text", text: "ERROR: 'memory' is not supported in parallel mode. Use single mode for persistent sessions." }],
						details: makeDetails("parallel")([]),
						isError: true,
					};
				}
				if (hasChain) {
					return {
						content: [{ type: "text", text: "ERROR: 'memory' is not supported in chain mode. Use single mode for persistent sessions." }],
						details: makeDetails("chain")([]),
						isError: true,
					};
				}
			}

			// Compute memory session info
			let memorySession: { filePath: string; mainSessionFile: string; action: "create" | "resume" } | undefined;
			if (memoryParam) {
				const mainSessionFile = ctx.sessionManager.getSessionFile();
				if (!mainSessionFile) {
					return {
						content: [{ type: "text", text: "ERROR: 'memory' requires a file-backed session. Current session is in-memory." }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				const filePath = resolveMemorySessionFile(mainSessionFile, memoryParam);
				if (!filePath) {
					return {
						content: [{ type: "text", text: "ERROR: Failed to resolve memory session file path." }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				const action = fs.existsSync(filePath) ? "resume" : "create";
				memorySession = { filePath, mainSessionFile, action };
				// Track for cleanup on session_shutdown
				getSessionState(ctx.sessionManager.getSessionId()).memoryFiles.add(filePath);
			}

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

				const rawConcurrency = typeof params.concurrency === "number" ? params.concurrency : DEFAULT_CONCURRENCY;
				const effectiveConcurrency = Math.max(1, Math.min(rawConcurrency, MAX_CONCURRENCY));

				const results = await mapWithConcurrencyLimit(params.tasks, effectiveConcurrency, async (t, index) => {
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
					resolvedModel, params.cwd, undefined, signal, onUpdate, makeDetails("single"), resolvedThinking, memorySession,
				);
				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					const details = makeDetails("single")([result]);
					if (memorySession) {
						details.memoryId = memoryParam;
						details.memoryAction = memorySession.action;
						details.memoryFile = memorySession.filePath;
					}
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details,
						isError: true,
					};
				}
				const details = makeDetails("single")([result]);
				if (memorySession) {
					details.memoryId = memoryParam;
					details.memoryAction = memorySession.action;
					details.memoryFile = memorySession.filePath;
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details,
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},



		renderCall(args, theme, context) {
			const scope: AgentScope = args.agentScope ?? "user";
			const complexity = args.taskComplexity as string | undefined;
			const explicitModel = args.model as string | undefined;
			const thinking = args.thinkingLevel as string | undefined;

			// Resolve actual model name synchronously — no need to defer to execute().
			// taskComplexity path resolves from subagent-models.json here;
			// explicit model path just shows the model string directly.
			let modelDisplay: string;
			if (explicitModel) {
				modelDisplay = thinking
					? theme.fg("dim", ` ${explicitModel}/${thinking}`)
					: theme.fg("dim", ` ${explicitModel}`);
			} else if (complexity) {
				const resolved = resolveModelByComplexitySync(complexity as TaskComplexity);
				const thinkingStr = thinking ?? COMPLEXITY_DEFAULT_THINKING[complexity as TaskComplexity];
				if (resolved) {
					modelDisplay = theme.fg("dim", ` ${resolved}/${thinkingStr}`);
				} else {
					modelDisplay = theme.fg("muted", ` complexity:${complexity}/${thinkingStr} (no subagent-models.json)`);
				}
			} else {
				modelDisplay = theme.fg("dim", " (no model)");
			}
			const bg = args.background ? theme.fg("warning", " [bg]") : "";

			// Extract session short ID from render context for display
			const ctxSessionId = (context as { sessionManager?: { getSessionId?: () => string } }).sessionManager?.getSessionId?.() ?? "";
			const shortId = ctxSessionId.slice(0, 8);
			const ctxIdPart = shortId ? ` #${shortId}` : "";

			// Unified Line 1: ⏳ mode #sessionID
			const headerPrefix = `${theme.fg("warning", "\u23F3")} `;

			if (args.chain && args.chain.length > 0) {
				let text =
					headerPrefix +
					theme.fg("toolTitle", theme.bold("chain")) +
					theme.fg("accent", ctxIdPart) +
					theme.fg("muted", ` (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`) +
					modelDisplay +
					bg;
				// Line 2: agents + model
				const agents = args.chain.slice(0, 3).map((s) => s.agent).join(", ");
				text += "\n  " + theme.fg("accent", agents);
				if (args.chain.length > 3) text += theme.fg("muted", ` +${args.chain.length - 3} more`);
				// Line 3+: task previews
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text += "\n  " + theme.fg("muted", `${i + 1}.`) + " " + theme.fg("dim", preview);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					headerPrefix +
					theme.fg("toolTitle", theme.bold("parallel")) +
					theme.fg("accent", ctxIdPart) +
					theme.fg("muted", ` (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`) +
					modelDisplay +
					bg;
				// Line 2: agents
				const agents = args.tasks.slice(0, 3).map((t) => t.agent).join(", ");
				text += "\n  " + theme.fg("accent", agents);
				if (args.tasks.length > 3) text += theme.fg("muted", ` +${args.tasks.length - 3} more`);
				// Line 3+: task previews
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("dim", preview)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			// Single mode
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			const memory = args.memory as string | undefined;
			const memoryPart = memory ? theme.fg("accent", ` [mem:${memory.length > 20 ? memory.slice(0, 20) + "..." : memory}]`) : "";
			let text =
				headerPrefix +
				theme.fg("toolTitle", theme.bold("single")) +
				theme.fg("accent", ctxIdPart) +
				`  ${theme.fg("accent", agentName)}` +
				theme.fg("muted", ` [${scope}]`) +
				modelDisplay +
				bg +
				memoryPart;
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			// ── Live timer support: setInterval + context.invalidate() ──
			// Use feature detection instead of double type assertion for safe access.
			const ctxState = (context as { state?: Record<string, unknown> }).state;
			const ctxInvalidate = (context as { invalidate?: () => void }).invalidate;

			// Extract session ID from render context for display
			const ctxSessionId = (context as { sessionManager?: { getSessionId?: () => string } }).sessionManager?.getSessionId?.() ?? "";
			const sid = ctxSessionId.slice(0, 8);

			// Track timer in session state for cleanup on session_shutdown
			const sessionId = ctxSessionId;
			const sessState = sessionId ? getSessionState(sessionId) : undefined;

			const hasAnyRunning = details.results.some((r) => r.exitCode === -1);
			if (hasAnyRunning && ctxState && !ctxState.timerInterval && ctxInvalidate) {
				const timer = setInterval(() => ctxInvalidate(), 1000);
				ctxState.timerInterval = timer;
				// Track in session state for cleanup on session_shutdown (NF-6)
				sessState?.timerIntervals.add(timer);
			}
			if (!hasAnyRunning && ctxState?.timerInterval) {
				const timer = ctxState.timerInterval as ReturnType<typeof setInterval>;
				clearInterval(timer);
				ctxState.timerInterval = undefined;
				sessState?.timerIntervals.delete(timer);
			}

			const mdTheme = getMarkdownTheme();

			if (details.mode === "single" && details.results.length === 1) {
				const view = buildAgentResultView(details.results[0]);
				// Compute elapsed for running state
				const elapsed = view.status === "running" && view.duration.durationMs === undefined
					? formatDuration(Date.now() - view.duration.startTime)
					: undefined;

				// Memory indicator prefix
				let memoryPrefix = "";
				if (details.memoryId) {
					const action = details.memoryAction === "create" ? "created" : "resumed";
					const fileName = details.memoryFile ? path.basename(details.memoryFile) : details.memoryId;
					memoryPrefix = theme.fg("accent", `[memory: ${details.memoryId} → ${fileName} (${action})]`) + "\n";
				}

				if (expanded) {
					const detailContainer = renderAgentDetail(view, theme, mdTheme, { showTask: true, sessionShortId: sid });
					if (memoryPrefix) {
						const wrapper = new Container();
						wrapper.addChild(new Text(memoryPrefix, 0, 0));
						wrapper.addChild(new Spacer(1));
						for (const child of detailContainer.children) {
							wrapper.addChild(child);
						}
						return wrapper;
					}
					return detailContainer;
				}
				return new Text(memoryPrefix + renderSingleCollapsedText(view, theme, sid, elapsed), 0, 0);
			}

			if (details.mode === "chain") {
				const views = details.results.map((r) => buildAgentResultView(r));
				const hasFailure = views.some((v) => v.status === "failed");
				const isRunning = views.some((v) => v.status === "running");
				const overallStatus: "running" | "succeeded" | "failed" = isRunning ? "running" : hasFailure ? "failed" : "succeeded";
				const icon = renderStatusIcon(overallStatus, theme);

				if (expanded) {
					const container = new Container();
					const durations = views
						.filter((v) => v.duration.durationMs !== undefined)
						.map((v) => v.duration.durationMs!);
					const totalMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) : undefined;
					const durationStr = totalMs !== undefined ? ` (${formatDuration(totalMs)})` : "";

					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("chain"))}${theme.fg("accent", sid ? ` #${sid}` : "")}  ${theme.fg("accent", `${views.filter((v) => v.status === "succeeded").length}/${views.length} steps`)}${durationStr}`,
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

				return renderChainCollapsedText(views, details, icon, theme, sid);
			}

			if (details.mode === "parallel") {
				const summary = buildParallelSummaryView(details.results);
				if (expanded && summary.isDone) {
					return renderParallelDetail(summary, theme, mdTheme, sid);
				}
				return renderParallelTable(summary, theme, sid);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// ── Tool: analyze_image ──

	pi.registerTool({
		name: "analyze_image",
		label: "Analyze Image",
		description: [
			"Analyze images using a multimodal vision model.",
			"",
			"Spawns a vision subagent with a multimodal model to analyze the specified image.",
			"The image is processed by the vision model only — it never enters the main session context.",
			"Returns text-only analysis conclusions.",
			"",
			"Requires ~/.pi/agent/vision-models.json with at least one vision model entry.",
			"",
			"Supports memory sessions: same image path reuses prior context for follow-up questions.",
		].join("\n"),
		parameters: AnalyzeImageParams,
		promptSnippet: "Analyze images using a multimodal vision model",
		promptGuidelines: [
			"Provide image_path and question — the tool handles model selection and memory internally",
			"Relative paths are resolved via cwd",
			"Same image reuses memory context; different images get independent sessions",
		],

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			cleanupOldTempFiles();

			const sessionId = ctx.sessionManager.getSessionId();
			lastSessionId = sessionId;
			const state = getSessionState(sessionId);
			state.capturedSessionId = sessionId;

			// ── Validate image path ──
			const rawPath = params.image_path as string;
			const absoluteImagePath = path.isAbsolute(rawPath)
				? rawPath
				: path.resolve(ctx.cwd, rawPath);

			if (!fs.existsSync(absoluteImagePath)) {
				return {
					content: [{ type: "text", text: `Image file not found: ${absoluteImagePath}` }],
					details: { mode: "single" as const, resolvedModel: "", agentScope: "user" as AgentScope, projectAgentsDir: null, results: [] },
					isError: true,
				};
			}

			// ── Resolve vision model ──
			const modelResult = await resolveVisionModel(ctx);
			if (!modelResult.ok) {
				return {
					content: [{ type: "text", text: modelResult.error }],
					details: { mode: "single" as const, resolvedModel: "", agentScope: "user" as AgentScope, projectAgentsDir: null, results: [] },
					isError: true,
				};
			}

			const resolvedModel = modelResult.ref;
			const resolvedThinking = modelResult.thinkingLevel;

			// ── Build memory session ──
			const memoryId = buildVisionMemoryId(absoluteImagePath);
			const mainSessionFile = ctx.sessionManager.getSessionFile();
			let memorySession: { filePath: string; mainSessionFile: string; action: "create" | "resume" } | undefined;
			let memoryDegraded = false;

			if (mainSessionFile) {
				const filePath = resolveMemorySessionFile(mainSessionFile, memoryId);
				if (filePath) {
					const action = fs.existsSync(filePath) ? "resume" : "create";
					memorySession = { filePath, mainSessionFile, action };
					state.memoryFiles.add(filePath);
				}
			} else {
				memoryDegraded = true;
			}

			// ── Discover agents ──
			const discovery = discoverAgents(ctx.cwd, "user");
			let agent = discovery.agents.find((a) => a.name === "general-purpose");

			// Fallback: create an ad-hoc agent config if general-purpose is not found
			if (!agent) {
				agent = {
					name: "general-purpose",
					description: "General purpose agent (ad-hoc for vision)",
					tools: VISION_ALLOWED_TOOLS.split(","),
					systemPrompt: VISION_SYSTEM_PROMPT,
					source: "user",
					filePath: "",
				};
			} else {
				// Override with vision-specific config
				agent = {
					...agent,
					tools: VISION_ALLOWED_TOOLS.split(","),
					systemPrompt: VISION_SYSTEM_PROMPT,
				};
			}

			const agents = [agent];
			const question = params.question as string;
			const task = `读取图片 ${absoluteImagePath}，分析以下问题：${question}。仅输出分析结论。`;

			// ── Spawn vision subagent ──
			const makeDetails = (mode: "single" | "parallel" | "chain" | "background") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					resolvedModel,
					agentScope: "user" as AgentScope,
					projectAgentsDir: null,
					results,
				});

			const result = await state.spawnManager.runSingleAgent(
				ctx.cwd, agents, agent.name, task,
				resolvedModel, undefined, undefined, signal, onUpdate, makeDetails("single"),
				resolvedThinking, memorySession,
			);

			const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
			const details = makeDetails("single")([result]);

			// Attach memory session metadata (shared by both success and error paths)
			if (memorySession) {
				details.memoryId = memoryId;
				details.memoryAction = memorySession.action;
				details.memoryFile = memorySession.filePath;
			}

			const degradation = memoryDegraded ? "\n[Warning: Memory session unavailable — in-memory session, vision context will not persist across calls.]" : "";

			if (isError) {
				const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
				return {
					content: [{ type: "text", text: `Vision analysis failed: ${errorMsg}${degradation}` }],
					details,
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: (getFinalOutput(result.messages) || "(no output)") + degradation }],
				details,
			};
		},

		renderCall(args, theme) {
			const rawPath = args.image_path as string;
			const home = os.homedir();
			const shortPath = rawPath.startsWith(home) ? `~${rawPath.slice(home.length)}` : rawPath;
			const modelDisplay = theme.fg("dim", ` ${loadVisionModels()?.models?.[0]?.id ?? "vision"}`);

			const text = [
				`${theme.fg("warning", "\u23F3")} ${theme.fg("toolTitle", theme.bold("analyze_image"))}${modelDisplay}`,
				`  ${theme.fg("accent", shortPath)}`,
			].join("\n");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const ctxSessionId = (context as { sessionManager?: { getSessionId?: () => string } }).sessionManager?.getSessionId?.() ?? "";
			const sid = ctxSessionId.slice(0, 8);
			const view = buildAgentResultView(details.results[0]);

			let memoryPrefix = "";
			if (details.memoryId) {
				const action = details.memoryAction === "create" ? "created" : "resumed";
				memoryPrefix = theme.fg("accent", `[memory: ${details.memoryId} (${action})]`) + "\n";
			}

			if (expanded) {
				const mdTheme = getMarkdownTheme();
				const detailContainer = renderAgentDetail(view, theme, mdTheme, { showTask: false, sessionShortId: sid });
				if (memoryPrefix) {
					const wrapper = new Container();
					wrapper.addChild(new Text(memoryPrefix, 0, 0));
					wrapper.addChild(new Spacer(1));
					for (const child of detailContainer.children) {
						wrapper.addChild(child);
					}
					return wrapper;
				}
				return detailContainer;
			}
			return new Text(memoryPrefix + renderSingleCollapsedText(view, theme, sid), 0, 0);
		},
	});

	// ── Cleanup on session shutdown ──
	pi.on("session_shutdown", async () => {
		// SessionShutdownEvent doesn't carry sessionManager,
		// so use the last known session ID for cleanup.
		const sessionId = lastSessionId;
		const state = sessionStates.get(sessionId);
		if (state) {
			// Clean up all active timers for this session
			for (const timer of state.timerIntervals) {
				clearInterval(timer);
			}
			state.timerIntervals.clear();
			state.spawnManager.cleanupAllJobs();
			// Clean up memory session files
			for (const memoryFile of state.memoryFiles) {
				try { fs.unlinkSync(memoryFile); } catch { /* file may already be gone */ }
			}
			state.memoryFiles.clear();
			sessionStates.delete(sessionId);
		}
	});
}
