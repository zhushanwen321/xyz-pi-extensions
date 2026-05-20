/**
 * Subagent Tool v2 — Delegate tasks with explicit model selection
 *
 * Changes from original:
 * - model is REQUIRED ("provider/model" format, exact match from scoped models)
 * - No timeout — subagents run until completion or Ctrl+C
 * - background mode: detached spawn, collect results later
 * - Agent .md files provide systemPrompt + tools; model is always caller-specified
 *
 * Tools registered:
 *   subagent         — foreground (blocking) or background mode
 *   collect_subagent — collect background job results
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getMarkdownTheme, type Theme, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";

// ──────────────────────── Constants ────────────────────────

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

// ──────────────────────── Model config & complexity routing ────────────────────────

type TaskComplexity = "low" | "medium" | "high";
type ThinkingLevel = "high" | "max";

// Map subagent ThinkingLevel to Pi CLI --thinking flag values
const THINKING_TO_PI: Record<ThinkingLevel, string> = {
	high: "high",
	max: "xhigh",
};

interface SubagentModelEntry {
	id: string;
	provider?: string;
	"task-complexity"?: TaskComplexity[];
	order: number;
	fallbacks?: Array<{ id: string; provider?: string }>;
}

interface SubagentModelsConfig {
	models: SubagentModelEntry[];
}

const SUBAGENT_MODELS_PATH = path.join(os.homedir(), ".pi", "agent", "subagent-models.json");
const VALID_COMPLEXITIES = new Set<TaskComplexity>(["low", "medium", "high"]);

// Lazy singleton: load once per process, avoid repeated readFile on every call
let _cachedModels: SubagentModelsConfig | null | undefined = undefined;

function loadSubagentModels(): SubagentModelsConfig | null {
	if (_cachedModels !== undefined) return _cachedModels;
	try {
		const content = fs.readFileSync(SUBAGENT_MODELS_PATH, "utf-8");
		const parsed = JSON.parse(content) as SubagentModelsConfig;
		// Validate entries: warn on invalid complexity values, skip entries without provider
		if (parsed.models) {
			for (const m of parsed.models) {
				if (m["task-complexity"]) {
					const invalid = m["task-complexity"].filter((c) => !VALID_COMPLEXITIES.has(c));
					if (invalid.length > 0) {
						console.warn(`[subagent] Invalid complexity values in subagent-models.json for ${m.id}: ${invalid.join(", ")}. Valid: low, medium, high.`);
					}
				}
				if (!m.provider) {
					console.warn(`[subagent] Model entry "${m.id}" has no provider field, will be skipped during complexity routing.`);
				}
			}
		}
		_cachedModels = parsed;
		return parsed;
	} catch {
		_cachedModels = null;
		return null;
	}
}

const COMPLEXITY_DEFAULT_THINKING: Record<TaskComplexity, ThinkingLevel> = {
	low: "high",
	medium: "high",
	high: "max",
};

// ──────────────────────── Formatting helpers ────────────────────────

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M}`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: string, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

// ──────────────────────── Interfaces ────────────────────────

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	startTime: number;
	endTime?: number;
	durationMs?: number;
	lastActivityTime: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain" | "background";
	resolvedModel: string;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m${seconds}s`;
}

function formatTimestamp(epochMs: number): string {
	const d = new Date(epochMs);
	return d.toTimeString().slice(0, 8); // HH:MM:SS
}

interface DurationInfo {
	startTime: number;
	endTime?: number;
	durationMs?: number;
	lastActivityTime: number;
}

interface AgentResultView {
	name: string;
	source: string;
	status: "running" | "succeeded" | "failed";
	duration: DurationInfo;
	turns: number;
	tokens: { input: number; output: number };
	cost: number;
	model?: string;
	task: string;
	toolCalls: DisplayItem[];
	finalOutput: string;
	errorMessage?: string;
	stopReason?: string;
}

interface ParallelSummaryView {
	total: number;
	succeeded: number;
	failed: number;
	running: number;
	isDone: boolean;
	agents: AgentResultView[];
	aggregateTokens: { input: number; output: number };
	aggregateCost: number;
	totalDurationMs?: number;
}

// ──────────────────────── View model builders ────────────────────────

function buildAgentResultView(r: SingleResult, _now?: number): AgentResultView {
	let status: AgentResultView["status"];
	if (r.exitCode === -1) status = "running";
	else if (r.exitCode === 0) status = "succeeded";
	else status = "failed";

	return {
		name: r.agent,
		source: r.agentSource,
		status,
		duration: {
			startTime: r.startTime,
			endTime: r.endTime,
			durationMs: r.durationMs,
			lastActivityTime: r.lastActivityTime,
		},
		turns: r.usage.turns,
		tokens: { input: r.usage.input, output: r.usage.output },
		cost: r.usage.cost,
		model: r.model,
		task: r.task,
		toolCalls: getDisplayItems(r.messages),
		finalOutput: getFinalOutput(r.messages),
		errorMessage: r.errorMessage,
		stopReason: r.stopReason,
	};
}

function buildParallelSummaryView(results: SingleResult[]): ParallelSummaryView {
	const agents = results.map((r) => buildAgentResultView(r));
	const succeeded = agents.filter((a) => a.status === "succeeded").length;
	const failed = agents.filter((a) => a.status === "failed").length;
	const running = agents.filter((a) => a.status === "running").length;
	const isDone = running === 0;

	const aggregateTokens = agents.reduce(
		(acc, a) => ({ input: acc.input + a.tokens.input, output: acc.output + a.tokens.output }),
		{ input: 0, output: 0 },
	);
	const aggregateCost = agents.reduce((acc, a) => acc + a.cost, 0);

	const durations = agents
		.filter((a) => a.duration.durationMs !== undefined)
		.map((a) => a.duration.durationMs!);
	const totalDurationMs = durations.length > 0 ? Math.max(...durations) : undefined;

	return {
		total: results.length,
		succeeded,
		failed,
		running,
		isDone,
		agents,
		aggregateTokens,
		aggregateCost,
		totalDurationMs,
	};
}

// ──────────────────────── Message helpers ────────────────────────

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text.trim()) return part.text;
			}
		}
	}
	return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

// ──────────────────────── Utility ────────────────────────

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

class ThrottleState {
	private lastEmitTime = 0;
	private readonly intervalMs: number;

	constructor(intervalMs = 500) {
		this.intervalMs = intervalMs;
	}

	shouldEmit(): boolean {
		const now = Date.now();
		if (now - this.lastEmitTime >= this.intervalMs) {
			this.lastEmitTime = now;
			return true;
		}
		return false;
	}

	forceEmit(): void {
		this.lastEmitTime = 0;
	}
}

const TEMP_SUBDIR = "pi-subagent";
const MAX_TEMP_AGE_MS = 60 * 60 * 1000; // 1 hour

function getTempDir(): string {
	return path.join(os.tmpdir(), TEMP_SUBDIR);
}

function cleanupOldTempFiles(): void {
	const dir = getTempDir();
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
		return;
	}
	const now = Date.now();
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const filePath = path.join(dir, entry.name);
		try {
			const stat = fs.statSync(filePath);
			if (now - stat.mtimeMs > MAX_TEMP_AGE_MS) fs.unlinkSync(filePath);
		} catch { /* ignore */ }
	}
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = getTempDir();
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `prompt-${safeName}-${randomUUID().slice(0, 8)}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

// ──────────────────────── Model resolution ────────────────────────

function getFallbackRefsForModel(modelRef: string): string[] {
	const config = loadSubagentModels();
	if (!config) return [];
	for (const entry of config.models) {
		if (!entry.provider) continue;
		const entryRef = `${entry.provider}/${entry.id}`;
		if (entryRef === modelRef && entry.fallbacks?.length) {
			return entry.fallbacks
				.filter((fb) => fb.provider)
				.map((fb) => `${fb.provider!}/${fb.id}`);
		}
	}
	return [];
}

interface ModelResolutionContext {
	modelRegistry?: {
		getAvailable?: () => Promise<Array<{ id: string; provider: string }>>;
	};
}

async function resolveModelByComplexity(
	complexity: TaskComplexity,
	ctx: ModelResolutionContext,
): Promise<{ ok: true; ref: string } | { ok: false; error: string }> {
	const config = loadSubagentModels();
	if (!config || !config.models?.length) {
		return { ok: false, error: `subagent-models.json not found or empty at ${SUBAGENT_MODELS_PATH}` };
	}

	const candidates = config.models
		.filter((m) => m["task-complexity"]?.includes(complexity))
		.sort((a, b) => a.order - b.order);

	if (candidates.length === 0) {
		return { ok: false, error: `No models configured for complexity "${complexity}" in subagent-models.json` };
	}

	for (const candidate of candidates) {
		if (!candidate.provider) continue;
		const modelRef = `${candidate.provider}/${candidate.id}`;
		const result = await resolveModel(modelRef, ctx);
		if (result.ok) return result;
	}

	const tried = candidates.map((c) => `${c.provider ?? "?"}/${c.id}`).join(", ");
	return { ok: false, error: `All candidate models unavailable for complexity "${complexity}": ${tried}` };
}

async function resolveModel(
	modelRef: string,
	ctx: ModelResolutionContext,
): Promise<{ ok: true; ref: string } | { ok: false; error: string }> {
	const slashIndex = modelRef.indexOf("/");
	if (slashIndex <= 0 || slashIndex === modelRef.length - 1) {
		return {
			ok: false,
			error: `Model must be in "provider/model" format. Got: "${modelRef}".`,
		};
	}

	const provider = modelRef.substring(0, slashIndex);
	const modelId = modelRef.substring(slashIndex + 1);

	let models: Array<{ id: string; provider: string }>;
	try {
		models = (await ctx.modelRegistry?.getAvailable?.()) ?? [];
	} catch {
		models = [];
	}

	if (models.length === 0) {
		// Cannot validate — pass through to CLI
		return { ok: true, ref: modelRef };
	}

	const match = models.find((m) => m.provider === provider && m.id === modelId);
	if (match) {
		return { ok: true, ref: `${match.provider}/${match.id}` };
	}

	// Try fallback models from subagent-models.json config
	const fallbackRefs = getFallbackRefsForModel(modelRef);
	for (const fallbackRef of fallbackRefs) {
		const fbSlash = fallbackRef.indexOf("/");
		if (fbSlash <= 0) continue;
		const fbProvider = fallbackRef.substring(0, fbSlash);
		const fbModelId = fallbackRef.substring(fbSlash + 1);
		const fbMatch = models.find((m) => m.provider === fbProvider && m.id === fbModelId);
		if (fbMatch) {
			return { ok: true, ref: `${fbMatch.provider}/${fbMatch.id}` };
		}
	}

	const lines = models.map((m) => `  - ${m.id} (${m.provider})`).join("\n");
	return {
		ok: false,
		error: `Model "${modelRef}" not found in scoped models (fallbacks also unavailable).\nAvailable models:\n${lines}\n\nTip: Use taskComplexity instead of model for automatic selection.`,
	};
}

// ──────────────────────── Background job management ────────────────────────

interface JobInfo {
	id: string;
	agent: string;
	task: string;
	model: string;
	pid: number;
	startedAt: number;
	status: "running" | "done" | "failed" | "aborted";
	outFile: string;
	errFile: string;
	promptFile: string | null;
	promptDir: string | null;
	// Set when proc.on("error") fires (spawn failure)
	spawnError: string | null;
}

const jobs = new Map<string, JobInfo>();

// Persisted pi instance for use in background job callbacks
let piInstance: ExtensionAPI;

// Track all job output files for cleanup on session shutdown
const sessionJobFiles = new Set<string>();

// Emitted as `done:${jobId}` when a background job finishes (close/error/abort)
const jobEvents = new EventEmitter();

function getJobDir(): string {
	const dir = path.join(os.tmpdir(), "pi-subagent-jobs");
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Check if a stopReason indicates the LLM has finished its agentic loop.
 * "tool_use" means the LLM wants to call a tool (agentic loop continues).
 * Any other defined stopReason ("end_turn", "max_tokens", "stop", "error", etc.)
 * means the task is complete.
 */
function isTerminalStopReason(stopReason: string | undefined): boolean {
	return stopReason !== undefined && stopReason !== "tool_use";
}

function parseOutputFile(filePath: string): {
	output: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
} {
	const empty = {
		output: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};

	if (!fs.existsSync(filePath)) return empty;

	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return empty;
	}

	const lines = content.split("\n").filter((l) => l.trim());
	const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	let output = "";
	let model: string | undefined;
	let stopReason: string | undefined;
	let errorMessage: string | undefined;

	for (const line of lines) {
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}

		if (event.type === "message_end" && event.message) {
			const msg = event.message as Message;
			if (msg.role === "assistant") {
				usage.turns++;
				const u = msg.usage;
				if (u) {
					usage.input += u.input || 0;
					usage.output += u.output || 0;
					usage.cacheRead += u.cacheRead || 0;
					usage.cacheWrite += u.cacheWrite || 0;
					usage.cost += u.cost?.total || 0;
					usage.contextTokens = u.totalTokens || 0;
				}
				if (msg.model) model = msg.model;
				if (msg.stopReason) stopReason = msg.stopReason;
				if (msg.errorMessage) errorMessage = msg.errorMessage;
				for (const part of msg.content) {
					if (part.type === "text") output = part.text;
				}
			}
		}
	}

	return { output, usage, model, stopReason, errorMessage };
}

// ──────────────────────── Process spawning ────────────────────────

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	resolvedModel: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	thinkingLevel?: ThinkingLevel,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
			startTime: Date.now(),
			endTime: Date.now(),
			durationMs: 0,
			lastActivityTime: Date.now(),
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	args.push("--model", resolvedModel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (thinkingLevel) args.push("--thinking", THINKING_TO_PI[thinkingLevel]);

	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: resolvedModel,
		step,
		startTime: Date.now(),
		lastActivityTime: Date.now(),
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line) as Record<string, unknown>;
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
					currentResult.lastActivityTime = Date.now();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
					currentResult.lastActivityTime = Date.now();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		currentResult.endTime = Date.now();
		currentResult.durationMs = currentResult.endTime - currentResult.startTime;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
	
	}
}

async function startBackgroundJob(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	resolvedModel: string,
	cwd: string | undefined,
	thinkingLevel?: ThinkingLevel,
): Promise<{ ok: true; jobId: string } | { ok: false; error: string }> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return { ok: false, error: `Unknown agent: "${agentName}". Available agents: ${available}.` };
	}

	const jobId = `subagent-bg-${randomUUID().slice(0, 8)}`;
	const outFile = path.join(getJobDir(), `${jobId}.out`);
	const errFile = path.join(getJobDir(), `${jobId}.err`);
	sessionJobFiles.add(outFile);
	sessionJobFiles.add(errFile);

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	args.push("--model", resolvedModel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (thinkingLevel) args.push("--thinking", THINKING_TO_PI[thinkingLevel]);

	let promptFile: string | null = null;
	let promptDir: string | null = null;

	if (agent.systemPrompt.trim()) {
		const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
		promptDir = tmp.dir;
		promptFile = tmp.filePath;
		args.push("--append-system-prompt", promptFile);
	}

	args.push(`Task: ${task}`);

	const invocation = getPiInvocation(args);
	const proc = spawn(invocation.command, invocation.args, {
		cwd: cwd ?? defaultCwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});

	const outStream = fs.createWriteStream(outFile);
	const errStream = fs.createWriteStream(errFile);
	proc.stdout.pipe(outStream);
	proc.stderr.pipe(errStream);

	const job: JobInfo = {
		id: jobId,
		agent: agentName,
		task,
		model: resolvedModel,
		pid: proc.pid ?? 0,
		startedAt: Date.now(),
		status: "running",
		outFile,
		errFile,
		promptFile,
		promptDir,
	};
	jobs.set(jobId, job);

	proc.on("close", (code) => {
		job.status = code === 0 ? "done" : "failed";
		outStream.end();
		errStream.end();
		if (promptFile) {
			try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
		}
		job.promptFile = null;
		job.promptDir = null;
		jobEvents.emit(`done:${jobId}`);

		// Push results into the session automatically
		injectBackgroundResult(job);
	});

	proc.on("error", (err) => {
		job.status = "failed";
		job.spawnError = err.message;
		outStream.end();
		errStream.end();
		jobEvents.emit(`done:${jobId}`);

		injectBackgroundResult(job);
	});

	proc.unref();
	return { ok: true, jobId };
}

function injectBackgroundResult(job: JobInfo) {
	if (!piInstance) return;

	// Guard: if collect_subagent already collected this job, skip injection
	if (!jobs.has(job.id)) return;

	const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);
	const parsed = parseOutputFile(job.outFile);

	const isFailed = job.status === "failed" || parsed.stopReason === "error" || parsed.stopReason === "aborted";
	const label = isFailed ? "FAILED" : "completed";
	const outputPreview = parsed.output.length > 2000
		? parsed.output.slice(0, 2000) + "\n... (truncated, read the JSONL file for full output)"
		: parsed.output;

	const parts: string[] = [
		`[Background subagent ${label}]`,
		`  Job ID: ${job.id}`,
		`  Agent:  ${job.agent}`,
		`  Model:  ${job.model}`,
	];

	if (parsed.usage.turns) parts.push(`  Turns:  ${parsed.usage.turns}`);
	const usageStr = formatUsageStats(parsed.usage, parsed.model);
	if (usageStr) parts.push(`  Usage:  ${usageStr}`);
	if (parsed.errorMessage) parts.push(`  Error:  ${parsed.errorMessage}`);
	if (job.spawnError) parts.push(`  Spawn error: ${job.spawnError}`);

	// Read stderr for failed jobs
	if (isFailed) {
		try {
			if (fs.existsSync(job.errFile)) {
				const stderr = fs.readFileSync(job.errFile, "utf-8").trim();
				if (stderr) parts.push(`  stderr: ${stderr.slice(0, 500)}`);
			}
		} catch { /* ignore */ }
	}

	parts.push("");
	parts.push(outputPreview || "(no output)");

	if (!isFailed) {
		parts.push("");
		parts.push("---");
		parts.push("To review full execution trace, read the JSONL file:");
		parts.push(`  Path: ${job.outFile}`);
		parts.push("");
		parts.push("Each line is a JSON object:");
		parts.push('  - {"type":"message_end","message":{...}} — assistant turn (role, content[], usage, stopReason)');
		parts.push('  - {"type":"tool_result_end","message":{...}} — tool result');
	}

	const content = parts.join("\n");

	try {
		piInstance.sendMessage(
			{
				customType: "subagent-background-result",
				content,
				display: true,
				details: {
					jobId: job.id,
					agent: job.agent,
					task: job.task,
					status: job.status,
					elapsed,
					usage: parsed.usage,
				},
			},
			{
				deliverAs: "followUp",
				triggerTurn: true,
			},
		);
	} catch {
		// sendMessage may fail if session is shutting down
	}

	// Remove from active jobs map but keep .out file for history access
	jobs.delete(job.id);
}

function cleanupJob(job: JobInfo) {
	if (job.status === "running") {
		try {
			process.kill(job.pid, "SIGTERM");
		} catch {
			/* already dead */
		}
		job.status = "aborted";
	}
	jobEvents.emit(`done:${job.id}`);
	for (const f of [job.outFile, job.errFile, job.promptFile]) {
		if (f) {
			try { fs.unlinkSync(f); } catch { /* ignore */ }
		}
	}
}

// ──────────────────────── Render helper functions ────────────────────────

function aggregateUsageFromViews(views: AgentResultView[]): string {
	const total = views.reduce(
		(acc, v) => ({
			input: acc.input + v.tokens.input,
			output: acc.output + v.tokens.output,
			cost: acc.cost + v.cost,
			turns: acc.turns + v.turns,
		}),
		{ input: 0, output: 0, cost: 0, turns: 0 },
	);
	return formatUsageStats({
		input: total.input,
		output: total.output,
		cacheRead: 0,
		cacheWrite: 0,
		cost: total.cost,
		turns: total.turns,
	});
}

function renderAgentDetail(
	view: AgentResultView,
	theme: Theme,
	mdTheme: MarkdownTheme,
	opts: { label?: string; showTask: boolean },
): Container {
	const container = new Container();
	const isError = view.status === "failed";
	const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");

	const durationStr = view.duration.durationMs !== undefined
		? formatDuration(view.duration.durationMs)
		: "";

	let header = `${icon} ${theme.fg("toolTitle", theme.bold(view.name))}`;
	if (opts.label) header += theme.fg("muted", ` (${opts.label})`);
	header += theme.fg("muted", ` (${view.source})`);
	if (durationStr) header += ` ${theme.fg("dim", durationStr)}`;
	if (view.model) header += ` ${theme.fg("dim", view.model)}`;
	if (isError && view.stopReason) header += ` ${theme.fg("error", `[${view.stopReason}]`)}`;

	container.addChild(new Text(header, 0, 0));

	if (isError && view.errorMessage) {
		container.addChild(new Text(theme.fg("error", `Error: ${view.errorMessage}`), 0, 0));
	}

	container.addChild(new Spacer(1));

	if (opts.showTask) {
		container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
		container.addChild(new Text(theme.fg("dim", view.task), 0, 0));
		container.addChild(new Spacer(1));
	}

	container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));

	if (view.toolCalls.length === 0 && !view.finalOutput) {
		container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
	} else {
		for (const item of view.toolCalls) {
			if (item.type === "toolCall") {
				container.addChild(
					new Text(
						theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
						0, 0,
					),
				);
			}
		}
		if (view.finalOutput) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(view.finalOutput.trim(), 0, 0, mdTheme));
		}
	}

	const usageParts: string[] = [];
	if (view.turns) usageParts.push(`${view.turns} turn${view.turns > 1 ? "s" : ""}`);
	if (view.tokens.input) usageParts.push(`↑${formatTokens(view.tokens.input)}`);
	if (view.tokens.output) usageParts.push(`↓${formatTokens(view.tokens.output)}`);
	if (view.cost) usageParts.push(`$${view.cost.toFixed(4)}`);
	if (usageParts.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", usageParts.join("  ")), 0, 0));
	}

	return container;
}

function renderSingleCollapsedText(view: AgentResultView, theme: Theme): string {
	const isError = view.status === "failed";
	const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const durationStr = view.duration.durationMs !== undefined ? ` ${formatDuration(view.duration.durationMs)}` : "";

	let text = `${icon} ${theme.fg("toolTitle", theme.bold(view.name))}${theme.fg("muted", ` (${view.source})`)}`;
	if (view.model) text += ` ${theme.fg("dim", view.model)}`;
	text += ` ${theme.fg("dim", durationStr)}`;
	if (isError && view.stopReason) text += ` ${theme.fg("error", `[${view.stopReason}]`)}`;
	if (isError && view.errorMessage) {
		text += `\n${theme.fg("error", `Error: ${view.errorMessage}`)}`;
	} else if (view.toolCalls.length === 0) {
		text += `\n${theme.fg("muted", "(no output)")}`;
	} else {
		const toShow = view.toolCalls.slice(-COLLAPSED_ITEM_COUNT);
		const skipped = view.toolCalls.length > COLLAPSED_ITEM_COUNT ? view.toolCalls.length - COLLAPSED_ITEM_COUNT : 0;
		if (skipped > 0) text += `\n${theme.fg("muted", `... ${skipped} earlier items`)}`;
		for (const item of toShow) {
			if (item.type === "text") {
				const preview = item.text.split("\n").slice(0, 3).join("\n");
				text += `\n${theme.fg("toolOutput", preview)}`;
			} else {
				text += `\n${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}`;
			}
		}
		if (view.toolCalls.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}
	const usageParts: string[] = [];
	if (view.turns) usageParts.push(`${view.turns} turn${view.turns > 1 ? "s" : ""}`);
	if (view.tokens.input) usageParts.push(`↑${formatTokens(view.tokens.input)}`);
	if (view.tokens.output) usageParts.push(`↓${formatTokens(view.tokens.output)}`);
	if (view.cost) usageParts.push(`$${view.cost.toFixed(4)}`);
	if (usageParts.length > 0) text += `\n${theme.fg("dim", usageParts.join("  "))}`;
	return text;
}

function renderChainCollapsedText(
	views: AgentResultView[],
	details: SubagentDetails,
	icon: string,
	theme: Theme,
): Text {
	let text = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${views.filter((v) => v.status === "succeeded").length}/${views.length} steps`)}`;
	for (let i = 0; i < views.length; i++) {
		const view = views[i];
		const stepNum = details.results[i].step ?? i + 1;
		const rIcon = view.status === "succeeded" ? theme.fg("success", "✓") : theme.fg("error", "✗");
		const durationStr = view.duration.durationMs !== undefined ? ` ${formatDuration(view.duration.durationMs)}` : "";
		text += `\n\n${theme.fg("muted", `─── Step ${stepNum}: `)}${theme.fg("accent", view.name)} ${rIcon}${durationStr}`;
		if (view.toolCalls.length === 0) {
			text += `\n${theme.fg("muted", "(no output)")}`;
		} else {
			const toShow = view.toolCalls.slice(-5);
			const skipped = view.toolCalls.length > 5 ? view.toolCalls.length - 5 : 0;
			if (skipped > 0) text += `\n${theme.fg("muted", `... ${skipped} earlier items`)}`;
			for (const item of toShow) {
				if (item.type === "text") {
					text += `\n${theme.fg("toolOutput", item.text.split("\n").slice(0, 3).join("\n"))}`;
				} else {
					text += `\n${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}`;
				}
			}
		}
	}
	const totalUsage = aggregateUsageFromViews(views);
	if (totalUsage) text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
	text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

function renderParallelTable(view: ParallelSummaryView, theme: Theme): Text {
	const isRunning = view.running > 0;
	const hasFailures = view.failed > 0;

	const headerIcon = isRunning
		? theme.fg("warning", "⏳")
		: hasFailures
			? theme.fg("error", "✗")
			: theme.fg("success", "✓");

	const durationStr = view.totalDurationMs !== undefined
		? ` (${formatDuration(view.totalDurationMs)})`
		: "";

	let statusText: string;
	if (isRunning) {
		const elapsedStr = view.totalDurationMs !== undefined
			? formatDuration(view.totalDurationMs)
			: "...";
		statusText = `${view.succeeded + view.failed}/${view.total} done, ${view.running} running (${elapsedStr} elapsed)`;
	} else if (hasFailures) {
		statusText = `${view.succeeded}/${view.total} succeeded${durationStr}`;
	} else {
		statusText = `${view.succeeded}/${view.total} succeeded${durationStr}`;
	}

	let text = `${headerIcon} parallel ${statusText}`;

	for (const agent of view.agents) {
		// Inline agent row rendering (cannot call this.renderAgentRow from standalone function)
		const statusIcon =
			agent.status === "running"
				? theme.fg("warning", "⏳")
				: agent.status === "succeeded"
					? theme.fg("success", "✓")
					: theme.fg("error", "✗");
		const agentDuration = agent.duration.durationMs !== undefined
			? formatDuration(agent.duration.durationMs)
			: formatDuration(Date.now() - agent.duration.startTime);
		let agentLine = `  ${agent.name.padEnd(12)} ${statusIcon}  ${agentDuration.padStart(5)}  ${agent.turns} turn${agent.turns !== 1 ? "s" : ""}`;
		if (agent.status === "running") {
			agentLine += `  last @ ${formatTimestamp(agent.duration.lastActivityTime)}`;
		} else {
			if (agent.tokens.input) agentLine += `  ↑${formatTokens(agent.tokens.input)}`;
			if (agent.tokens.output) agentLine += ` ↓${formatTokens(agent.tokens.output)}`;
			if (agent.cost) agentLine += `  $${agent.cost.toFixed(4)}`;
			if (agent.errorMessage) agentLine += `  ${theme.fg("error", `Error: ${agent.errorMessage.slice(0, 50)}`)}`;
		}
		text += `\n${agentLine}`;
	}

	if (view.isDone) {
		const totalLine: string[] = [];
		if (view.aggregateTokens.input > 0 || view.aggregateTokens.output > 0) {
			totalLine.push(`Total: ↑${formatTokens(view.aggregateTokens.input)} ↓${formatTokens(view.aggregateTokens.output)}`);
		}
		if (view.aggregateCost > 0) {
			totalLine.push(`$${view.aggregateCost.toFixed(4)}`);
		}
		if (totalLine.length > 0) {
			text += `\n${theme.fg("dim", totalLine.join("  "))}`;
		}
	}

	text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

function renderParallelDetail(view: ParallelSummaryView, theme: Theme, mdTheme: MarkdownTheme): Container {
	const hasFailures = view.failed > 0;
	const headerIcon = hasFailures ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const durationStr = view.totalDurationMs !== undefined ? ` (${formatDuration(view.totalDurationMs)})` : "";

	const container = new Container();
	container.addChild(
		new Text(
			`${headerIcon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", `${view.succeeded}/${view.total} succeeded`)}${durationStr}`,
			0, 0,
		),
	);

	for (const agent of view.agents) {
		container.addChild(new Spacer(1));
		const detail = renderAgentDetail(agent, theme, mdTheme, { showTask: true });
		for (const child of detail.children) {
			container.addChild(child);
		}
	}

	const totalParts: string[] = [];
	if (view.aggregateTokens.input > 0 || view.aggregateTokens.output > 0) {
		totalParts.push(`↑${formatTokens(view.aggregateTokens.input)} ↓${formatTokens(view.aggregateTokens.output)}`);
	}
	if (view.aggregateCost > 0) {
		totalParts.push(`$${view.aggregateCost.toFixed(4)}`);
	}
	if (totalParts.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", `Total: ${totalParts.join("  ")}`), 0, 0));
	}

	return container;
}

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

export default function (pi: ExtensionAPI) {
	piInstance = pi;
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

			// Mutual exclusion: model and taskComplexity cannot both be set
			if (modelParam && taskComplexity) {
				return {
					content: [{ type: "text", text: "Parameters 'model' and 'taskComplexity' are mutually exclusive. Provide exactly one." }],
					details: { mode: "single" as const, resolvedModel: "", agentScope: "user" as AgentScope, projectAgentsDir: null, results: [] },
					isError: true,
				};
			}
			if (!modelParam && !taskComplexity) {
				return {
					content: [{ type: "text", text: "Either 'model' or 'taskComplexity' is required. Use taskComplexity (low/medium/high) for automatic model selection, or model for explicit selection." }],
					details: { mode: "single" as const, resolvedModel: "", agentScope: "user" as AgentScope, projectAgentsDir: null, results: [] },
					isError: true,
				};
			}

			// Resolve model
			let resolvedModel: string;
			let resolvedThinking: ThinkingLevel | undefined;
			if (taskComplexity) {
				const result = await resolveModelByComplexity(taskComplexity, ctx);
				if (!result.ok) {
					return {
						content: [{ type: "text", text: (result as { ok: false; error: string }).error }],
						details: { mode: "single" as const, resolvedModel: "", agentScope: "user" as AgentScope, projectAgentsDir: null, results: [] },
						isError: true,
					};
				}
				resolvedModel = result.ref;
				resolvedThinking = thinkingParam ?? COMPLEXITY_DEFAULT_THINKING[taskComplexity];
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
					.filter((a): a is AgentConfig => a?.source === "project");

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

				const bgResult = await startBackgroundJob(
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

					const result = await runSingleAgent(
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
					const result = await runSingleAgent(
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
				const result = await runSingleAgent(
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
			const thinkingLabel = thinking ? theme.fg("dim", ` thinking:${thinking}`) : "";
			const bg = args.background ? theme.fg("warning", " [bg]") : "";

			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`) +
					theme.fg("dim", ` ${model}`) +
					thinkingLabel +
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
					theme.fg("dim", ` ${model}`) +
					thinkingLabel +
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
				theme.fg("dim", ` ${model}`) +
				thinkingLabel +
				bg;
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		// ── Render helper functions ──

		renderAgentRow(view: AgentResultView, theme: Theme): string {
			const statusIcon =
				view.status === "running"
					? theme.fg("warning", "⏳")
					: view.status === "succeeded"
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");

			const durationStr = view.duration.durationMs !== undefined
				? formatDuration(view.duration.durationMs)
				: formatDuration(Date.now() - view.duration.startTime);

			let line = `  ${view.name.padEnd(12)} ${statusIcon}  ${durationStr.padStart(5)}  ${view.turns} turn${view.turns !== 1 ? "s" : ""}`;

			if (view.status === "running") {
				line += `  last @ ${formatTimestamp(view.duration.lastActivityTime)}`;
			} else {
				if (view.tokens.input) line += `  ↑${formatTokens(view.tokens.input)}`;
				if (view.tokens.output) line += ` ↓${formatTokens(view.tokens.output)}`;
				if (view.cost) line += `  $${view.cost.toFixed(4)}`;
				if (view.errorMessage) line += `  ${theme.fg("error", `Error: ${view.errorMessage.slice(0, 50)}`)}`;
			}

			return line;
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			// ── Single mode ──
			if (details.mode === "single" && details.results.length === 1) {
				const view = buildAgentResultView(details.results[0]);
				if (expanded) {
					return renderAgentDetail(view, theme, mdTheme, { showTask: true });
				}
				return new Text(renderSingleCollapsedText(view, theme), 0, 0);
			}

			// ── Chain mode ──
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

			// ── Parallel mode ──
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

			// ── List all jobs (no jobId) ──
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
					isError: true,
				};
			}

			// ── Event-driven wait with output file fallback ──
			// Primary detection: proc.on("close") → jobEvents
			// Secondary detection: parse output file for terminal stopReason
			//   (LLM finished but process hasn't exited yet)
			const POLL_INTERVAL_SEC = 10;
			let outputComplete = false;

			while (job.status === "running" && !outputComplete) {
				const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);

				// Check output file for completion before waiting
				if (fs.existsSync(job.outFile)) {
					try {
						const parsed = parseOutputFile(job.outFile);
						if (isTerminalStopReason(parsed.stopReason)) {
							outputComplete = true;
							const elapsedNow = ((Date.now() - job.startedAt) / 1000).toFixed(1);
							onUpdate?.({
								content: [{
									type: "text",
									text: `[Job ${jobId.slice(0, 8)}... output complete (${elapsedNow}s), finalizing...]`,
								}],
							});
						break;
						}
					} catch {
						/* output file not ready yet */
					}
				}

				onUpdate?.({
					content: [{
						type: "text",
						text: `[Job ${jobId.slice(0, 8)}... still running (${elapsed}s), polling...]`,
					}],
				});

				// Three-way race: event (instant) vs timeout (fallback) vs abort
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

					const onDone = () => settle(false);   // job completed → not aborted
					const onAbort = () => settle(true);   // user abort

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
						isError: true,
					};
				}
			}

			// Kill lingering subprocess if output is complete but process hasn't exited
			if (outputComplete && job.status === "running") {
				try {
					process.kill(job.pid, "SIGTERM");
					// Give it 2s to exit gracefully, then force kill
					setTimeout(() => {
						try { process.kill(job.pid, "SIGKILL"); } catch { /* already dead */ }
					}, 2000);
				} catch {
					/* already dead */
				}
			}

			// ── Job finished — parse and return result ──
			const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);
			const parsed = parseOutputFile(job.outFile);
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

			// Clean up output files after successful collect
			for (const f of [job.outFile, job.errFile]) {
				try { fs.unlinkSync(f); } catch { /* ignore */ }
				sessionJobFiles.delete(f);
			}
			jobs.delete(jobId);

			return {
				content: [{ type: "text", text: parts.join("\n") }],
			};
		},
	});

	// ── Cleanup on session shutdown ──
	pi.on("session_shutdown", async () => {
		for (const [_id, job] of jobs) {
			cleanupJob(job);
		}
		jobs.clear();

		// Clean up all job output files from this session
		for (const f of sessionJobFiles) {
			try { fs.unlinkSync(f); } catch { /* ignore */ }
		}
		sessionJobFiles.clear();
	});
}
