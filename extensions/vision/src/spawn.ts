/**
 * Pi subprocess spawning for vision analysis.
 *
 * Minimal single-agent foreground executor.
 * Supports fresh and fork context modes.
 */

import { type ChildProcess,spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Message } from "@mariozechner/pi-ai";

import type { ThinkingLevel } from "./vision-model.js";

// ──────────────────────── Types ────────────────────────

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface VisionResult {
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	startTime: number;
	endTime?: number;
	durationMs?: number;
}


export type OnUpdateCallback = (partial: {
	content: Array<{ type: string; text: string }>;
	usage?: UsageStats;
}) => void;

// ──────────────────────── Temp file management ────────────────────────

const SEC_PER_MIN = 60;
const MIN_PER_HOUR = 60;
const MS_PER_SEC = 1000;
const TEMP_SUBDIR = "pi-vision";
const MAX_TEMP_AGE_MS = SEC_PER_MIN * MIN_PER_HOUR * MS_PER_SEC; // 1 hour
const RANDOM_ID_SLICE = 8;
const SIGKILL_DELAY_MS = 5000;

function getTempDir(): string {
	return path.join(os.tmpdir(), TEMP_SUBDIR);
}

export function cleanupOldTempFiles(): void {
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
		// eslint-disable-next-line taste/no-silent-catch
		} catch { /* ignore */ }
	}
}

async function writePromptToTempFile(prompt: string): Promise<string> {
	const dir = getTempDir();
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `vision-prompt-${randomUUID().slice(0, RANDOM_ID_SLICE)}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return filePath;
}

// ──────────────────────── Pi invocation ────────────────────────

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

// ──────────────────────── Helpers ────────────────────────

export function getFinalOutput(messages: Message[]): string {
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

// ──────────────────────── Arg builder ────────────────────────

/** Build the CLI args shared across all invocations. */
function buildVisionBaseArgs(input: {
	resolvedModel: string;
	tools: string;
}): string[] {
	return [
		"--mode", "json", "-p", "--no-session",
		"--model", input.resolvedModel,
		"--tools", input.tools,
	];
}

/** Append optional flags (thinking, fork session) to the base args. */
function appendVisionOptionalArgs(args: string[], input: {
	thinkingLevel?: ThinkingLevel;
	forkSessionFile?: string;
}): void {
	if (input.thinkingLevel) {
		const THINKING_TO_PI: Record<ThinkingLevel, string> = { high: "high", max: "xhigh" };
		args.push("--thinking", THINKING_TO_PI[input.thinkingLevel]);
	}
	if (input.forkSessionFile) {
		args.push("--session", input.forkSessionFile);
	}
}

// ──────────────────────── Event parsing ────────────────────────

/**
 * Parse a single JSON event line from the child stdout and apply it
 * to the accumulated result. Emits an update via `emitUpdate` for
 * recognized message events.
 */
function processVisionEventLine(
	line: string,
	result: VisionResult,
	emitUpdate: () => void,
): void {
	if (!line.trim()) return;
	let event: Record<string, unknown>;
	try {
		event = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return;
	}

	if (event.type === "message_end" && event.message) {
		const msg = event.message as Message;
		result.messages.push(msg);

		if (msg.role === "assistant") {
			result.usage.turns++;
			const usage = msg.usage;
			if (usage) {
				result.usage.input += usage.input || 0;
				result.usage.output += usage.output || 0;
				result.usage.cacheRead += usage.cacheRead || 0;
				result.usage.cacheWrite += usage.cacheWrite || 0;
				result.usage.cost += usage.cost?.total || 0;
				const ctx = usage.totalTokens || 0;
				if (ctx > result.usage.contextTokens) result.usage.contextTokens = ctx;
			}
			if (msg.model) result.model = msg.model;
			if (msg.stopReason) result.stopReason = msg.stopReason;
			if (msg.errorMessage) result.errorMessage = msg.errorMessage;
		}
		emitUpdate();
		return;
	}

	if (event.type === "tool_result_end" && event.message) {
		result.messages.push(event.message as Message);
		emitUpdate();
	}
}

/** Try to flush a trailing partial line as a message_end event. */
function flushTrailingStdout(stdout: string, result: VisionResult): void {
	if (!stdout.trim()) return;
	try {
		const event = JSON.parse(stdout) as Record<string, unknown>;
		if (event.type === "message_end" && event.message) {
			result.messages.push(event.message as Message);
		}
	// eslint-disable-next-line taste/no-silent-catch
	} catch { /* ignore partial line */ }
}

// ──────────────────────── Process lifecycle ────────────────────────

/** Wire stdout/stderr/close/error/abort handlers and resolve when the child exits. */
function spawnAndAwaitVision(
	invocation: { command: string; args: string[] },
	cwd: string,
	signal: AbortSignal | undefined,
	result: VisionResult,
	emitUpdate: () => void,
): Promise<void> {
	return new Promise<void>((resolve) => {
		const proc: ChildProcess = spawn(invocation.command, invocation.args, {
			cwd,
			env: { ...process.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			// Process complete lines; keep the trailing partial in `stdout`.
			const lines = stdout.split("\n");
			stdout = lines.pop() ?? "";
			for (const line of lines) {
				processVisionEventLine(line, result, emitUpdate);
			}
		});

		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		proc.on("close", (code) => {
			flushTrailingStdout(stdout, result);
			result.exitCode = code ?? 0;
			result.stderr = stderr;
			result.endTime = Date.now();
			result.durationMs = result.endTime - result.startTime;
			resolve();
		});

		proc.on("error", (err) => {
			result.exitCode = 1;
			result.stderr = err.message;
			result.endTime = Date.now();
			result.durationMs = result.endTime - result.startTime;
			resolve();
		});

		if (signal) {
			signal.addEventListener("abort", () => {
				proc.kill("SIGTERM");
				setTimeout(() => { try { proc.kill("SIGKILL"); } catch { void 0 /* already dead */; } }, SIGKILL_DELAY_MS);
			}, { once: true });
		}
	});
}

// ──────────────────────── Single agent spawn ────────────────────────

function buildEmptyResult(resolvedModel: string): VisionResult {
	return {
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: {
			input: 0, output: 0, cacheRead: 0,
			cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0,
		},
		model: resolvedModel,
		startTime: Date.now(),
	};
}

function buildEmitUpdate(
	result: VisionResult,
	onUpdate?: OnUpdateCallback,
): () => void {
	return () => {
		if (onUpdate) {
			onUpdate({
				content: [{
					type: "text",
					text: getFinalOutput(result.messages) || "(running...)",
				}],
				usage: result.usage,
			});
		}
	};
}

export async function runSingleVisionAgent(params: {
	task: string;
	systemPrompt: string;
	resolvedModel: string;
	thinkingLevel?: ThinkingLevel;
	cwd: string;
	tools?: string;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	forkSessionFile?: string;
}): Promise<VisionResult> {
	const {
		task,
		systemPrompt,
		resolvedModel,
		thinkingLevel,
		cwd,
		tools = "read,bash,grep",
		signal,
		onUpdate,
		forkSessionFile,
	} = params;

	const result = buildEmptyResult(resolvedModel);
	const emitUpdate = buildEmitUpdate(result, onUpdate);

	const args = buildVisionBaseArgs({ resolvedModel, tools });
	appendVisionOptionalArgs(args, { thinkingLevel, forkSessionFile });

	let tmpPromptPath: string | null = null;

	try {
		if (systemPrompt.trim()) {
			tmpPromptPath = await writePromptToTempFile(systemPrompt);
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);

		const invocation = getPiInvocation(args);
		await spawnAndAwaitVision(invocation, cwd, signal, result, emitUpdate);

		return result;
	} finally {
		if (tmpPromptPath) {
			// eslint-disable-next-line taste/no-silent-catch
			try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
		}
	}
}
