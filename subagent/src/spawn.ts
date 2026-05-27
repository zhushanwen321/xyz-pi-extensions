/**
 * Subagent process spawning and background job management
 *
 * Handles:
 *   - Foreground agent execution (runSingleAgent)
 *   - Background job lifecycle (startBackgroundJob, inject, cleanup)
 *   - Temp file management for system prompts
 *   - Output file parsing for background job results
 *
 * Session isolation: all mutable state (jobs Map, sessionJobFiles Set, jobEvents)
 * is created inside createSpawnManager() factory closure, so each Pi session
 * gets its own independent job tracker.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AgentToolResult } from "@mariozechner/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import type { ThinkingLevel } from "./model.js";
import { THINKING_TO_PI } from "./model.js";
import type { SingleResult, SubagentDetails, UsageStats } from "./render.js";
import { getFinalOutput, formatUsageStats } from "./render.js";

// ──────────────────────── Constants ────────────────────────

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 6;
export const DEFAULT_CONCURRENCY = 4;

const TEMP_SUBDIR = "pi-subagent";
const MAX_TEMP_AGE_MS = 60 * 60 * 1000; // 1 hour

// ──────────────────────── Utility ────────────────────────

export async function mapWithConcurrencyLimit<TIn, TOut>(
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
	// Use allSettled to avoid losing results from other workers when one throws
	const settled = await Promise.allSettled(workers);
	const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
	if (rejected.length > 0) {
		// Re-throw the first rejection so callers know something failed,
		// but all other results are already populated in the results array.
		throw rejected[0].reason;
	}
	return results;
}

export class ThrottleState {
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

// ──────────────────────── Temp file management ────────────────────────

function getTempDir(): string {
	return path.join(os.tmpdir(), TEMP_SUBDIR);
}

// Throttle: only run cleanup once per 5 minutes to avoid blocking event loop
let lastCleanupTime = 0;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export function cleanupOldTempFiles(): void {
	const now = Date.now();
	if (now - lastCleanupTime < CLEANUP_INTERVAL_MS) return;
	lastCleanupTime = now;

	const dir = getTempDir();
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
		return;
	}
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
	try {
		await withFileMutationQueue(filePath, async () => {
			await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
		});
	} catch {
		// Clean up the empty file if write failed (e.g. disk full, permissions)
		try { fs.unlinkSync(filePath); } catch { /* ignore */ }
		throw new Error(`Failed to write temp prompt file for agent "${agentName}"`);
	}
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

// ──────────────────────── Job types ────────────────────────

export interface ParsedJobResult {
	output: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface JobInfo {
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
	spawnError: string | null;
	parseResult: ParsedJobResult;
}

// ──────────────────────── Output parsing ────────────────────────

/** Shared JSONL line parser. Mutates `result` in place, O(1) memory. */
function processJsonlLine(line: string, result: ParsedJobResult): void {
	if (!line.trim()) return;
	let event: Record<string, unknown>;
	try {
		event = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return;
	}

	if (event.type === "message_end" && event.message) {
		const msg = event.message as Message;
		if (msg.role === "assistant") {
			result.usage.turns++;
			const u = msg.usage;
			if (u) {
				result.usage.input += u.input || 0;
				result.usage.output += u.output || 0;
				result.usage.cacheRead += u.cacheRead || 0;
				result.usage.cacheWrite += u.cacheWrite || 0;
				result.usage.cost += u.cost?.total || 0;
				result.usage.contextTokens = u.totalTokens || 0;
			}
			if (msg.model) result.model = msg.model;
			if (msg.stopReason) result.stopReason = msg.stopReason;
			if (msg.errorMessage) result.errorMessage = msg.errorMessage;
			for (const part of msg.content) {
				if (part.type === "text" && part.text) result.output = part.text;
			}
		}
	}
}

function makeEmptyParsedResult(): ParsedJobResult {
	return {
		output: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
}

/** Synchronous small-file parser. Exported for external consumers if needed. */
export function parseOutputFileSmall(
	filePath: string,
	result: ParsedJobResult,
): ParsedJobResult {
	if (!fs.existsSync(filePath)) return result;
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		// read error (permissions, etc.)
		return result;
	}
	for (const line of content.split("\n")) {
		processJsonlLine(line, result);
	}
	return result;
}

// ──────────────────────── Callback type ────────────────────────

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

// ──────────────────────── Memory session types ────────────────────────

export interface MemorySession {
	/** Path to the memory session file (our naming convention) */
	filePath: string;
	/** Path to the main session file (source for first-time copy) */
	mainSessionFile: string;
	/** "create" = copy main file first, "resume" = file already exists */
	action: "create" | "resume";
}

/** Short hash of input for collision resistance (first 8 hex chars of sha256) */
function shortHash(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

/**
 * Sanitize memory identifier for use in filenames.
 * Replaces non-[a-zA-Z0-9_-] with _, truncates readable part to 56 chars,
 * then appends 8-char hash of original input for collision resistance.
 */
export function sanitizeMemoryId(memory: string): string {
	const sanitized = memory.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 56);
	return `${sanitized}_${shortHash(memory)}`;
}

/**
 * Compute memory session file path from main session file and memory identifier.
 * Convention: {mainBasename}.mem-{sanitized}.jsonl in the same directory.
 * Returns undefined if main session has no file (in-memory session).
 */
export function resolveMemorySessionFile(
	mainSessionFile: string | undefined,
	memory: string,
): string | undefined {
	if (!mainSessionFile) return undefined;
	const dir = path.dirname(mainSessionFile);
	const base = path.basename(mainSessionFile, ".jsonl");
	const sanitized = sanitizeMemoryId(memory);
	return path.join(dir, `${base}.mem-${sanitized}.jsonl`);
}

// ──────────────────────── Factory ────────────────────────

export interface SpawnManager {
	runSingleAgent: (
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
		memorySession?: MemorySession,
	) => Promise<SingleResult>;

	startBackgroundJob: (
		defaultCwd: string,
		agents: AgentConfig[],
		agentName: string,
		task: string,
		resolvedModel: string,
		cwd: string | undefined,
		thinkingLevel?: ThinkingLevel,
	) => Promise<{ ok: true; jobId: string } | { ok: false; error: string }>;

	cleanupJob: (job: JobInfo) => void;
	cleanupAllJobs: () => void;
	getActiveJobs: () => Map<string, JobInfo>;
	getJobEvents: () => EventEmitter;
	getSessionJobFiles: () => Set<string>;
}

function getJobDir(): string {
	const dir = path.join(os.tmpdir(), "pi-subagent-jobs");
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Create a session-scoped spawn manager.
 * All mutable state (jobs, sessionJobFiles, jobEvents) is scoped to this closure.
 */
export function createSpawnManager(pi: ExtensionAPI): SpawnManager {
	const jobs = new Map<string, JobInfo>();
	const sessionJobFiles = new Set<string>();
	const jobEvents = new EventEmitter();

	function cleanupJobLocal(job: JobInfo): void {
		if (job.status === "running") {
			// Guard: pid must be a valid positive integer — never call process.kill(0) or process.kill(-1)
			if (job.pid > 0) {
				try {
					process.kill(job.pid, "SIGTERM");
				} catch {
					/* already dead */
				}
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

	function injectBackgroundResult(job: JobInfo): void {
		// Guard: if collect_subagent already collected this job, skip injection
		if (!jobs.has(job.id)) return;

		const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);
		const parsed = job.parseResult; // streaming-parsed in real time, no file read

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
			pi.sendMessage(
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

	async function runSingleAgentImpl(
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
		memorySession?: MemorySession,
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

		const args: string[] = ["--mode", "json", "-p"];
		if (memorySession) {
			if (memorySession.action === "create") {
				fs.copyFileSync(memorySession.mainSessionFile, memorySession.filePath);
			}
			args.push("--session", memorySession.filePath);
		} else {
			args.push("--no-session");
		}
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
			thinkingLevel: thinkingLevel ?? undefined,
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
						const killTimer = setTimeout(() => {
							if (!proc.killed) proc.kill("SIGKILL");
						}, 5000);
						// Clean up SIGKILL timer when process closes to avoid retaining proc reference
						proc.on("close", () => clearTimeout(killTimer));
					};
					if (signal.aborted) killProc();
					else signal.addEventListener("abort", killProc, { once: true });
				}
			});

			currentResult.exitCode = exitCode;
			currentResult.endTime = Date.now();
			currentResult.durationMs = currentResult.endTime - currentResult.startTime;
			// Return structured result instead of throwing — callers can handle it uniformly
			if (wasAborted) {
				currentResult.exitCode = -1;
				currentResult.stopReason = "aborted";
			}
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

	async function startBackgroundJobImpl(
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

		const parseResult = makeEmptyParsedResult();
		let stdoutBuffer = "";

		const processStdoutChunk = (data: Buffer) => {
			const chunk = data.toString();
			outStream.write(data); // write raw bytes to audit file
			stdoutBuffer += chunk;
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() || "";
			for (const line of lines) processJsonlLine(line, parseResult);
		};

		const flushStdoutBuffer = () => {
			if (stdoutBuffer.trim()) processJsonlLine(stdoutBuffer, parseResult);
			stdoutBuffer = "";
		};

		proc.stdout.on("data", processStdoutChunk);
		proc.stdout.on("end", () => {
			flushStdoutBuffer();
			outStream.end();
		});
		proc.stderr.pipe(errStream);

		const job: JobInfo = {
			id: jobId,
			agent: agentName,
			task,
			model: resolvedModel,
			pid: proc.pid ?? -1,
			startedAt: Date.now(),
			status: "running",
			outFile,
			errFile,
			promptFile,
			promptDir,
			spawnError: null,
			parseResult,
		};
		jobs.set(jobId, job);

		proc.on("close", (code) => {
			flushStdoutBuffer(); // ensure last partial line is parsed before injection
			job.status = code === 0 ? "done" : "failed";
			if (promptFile) {
				try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
			}
			job.promptFile = null;
			job.promptDir = null;
			jobEvents.emit(`done:${jobId}`);
			injectBackgroundResult(job);
		});

		proc.on("error", (err) => {
			flushStdoutBuffer();
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

	function cleanupAllJobs(): void {
		for (const [_id, job] of jobs) {
			cleanupJobLocal(job);
		}
		jobs.clear();

		for (const f of sessionJobFiles) {
			try { fs.unlinkSync(f); } catch { /* ignore */ }
		}
		sessionJobFiles.clear();
	}

	return {
		runSingleAgent: runSingleAgentImpl,
		startBackgroundJob: startBackgroundJobImpl,
		cleanupJob: cleanupJobLocal,
		cleanupAllJobs,
		getActiveJobs: () => jobs,
		getJobEvents: () => jobEvents,
		getSessionJobFiles: () => sessionJobFiles,
	};
}
