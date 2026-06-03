/**
 * Pi subprocess spawning for vision analysis.
 *
 * Minimal single-agent foreground executor.
 * Supports fresh and fork context modes.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
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

const TEMP_SUBDIR = "pi-vision";
const MAX_TEMP_AGE_MS = 60 * 60 * 1000; // 1 hour

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
		} catch { /* ignore */ }
	}
}

async function writePromptToTempFile(prompt: string): Promise<string> {
	const dir = getTempDir();
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `vision-prompt-${randomUUID().slice(0, 8)}.md`);
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

// ──────────────────────── Single agent spawn ────────────────────────

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

	const result: VisionResult = {
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

	const emitUpdate = () => {
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

	const args: string[] = [
		"--mode", "json", "-p", "--no-session",
		"--model", resolvedModel,
		"--tools", tools,
	];
	if (thinkingLevel) {
		const THINKING_TO_PI: Record<ThinkingLevel, string> = { high: "high", max: "xhigh" };
		args.push("--thinking", THINKING_TO_PI[thinkingLevel]);
	}
	// Fork context: reuse parent session branch
	if (forkSessionFile) {
		args.push("--session", forkSessionFile);
	}

	let tmpPromptPath: string | null = null;

	try {
		if (systemPrompt.trim()) {
			tmpPromptPath = await writePromptToTempFile(systemPrompt);
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);

		const invocation = getPiInvocation(args);

		await new Promise<void>((resolve, _reject) => {
			const proc: ChildProcess = spawn(invocation.command, invocation.args, {
				cwd,
				env: { ...process.env },
				stdio: ["pipe", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";

			proc.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
				// Process complete lines
				const lines = stdout.split("\n");
				stdout = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					let event: Record<string, unknown>;
					try {
						event = JSON.parse(line) as Record<string, unknown>;
					} catch {
						continue;
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
					}

					if (event.type === "tool_result_end" && event.message) {
						result.messages.push(event.message as Message);
						emitUpdate();
					}
				}
			});

			proc.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});

			proc.on("close", (code) => {
				// Process remaining stdout
				if (stdout.trim()) {
					try {
						const event = JSON.parse(stdout) as Record<string, unknown>;
						if (event.type === "message_end" && event.message) {
							result.messages.push(event.message as Message);
						}
					} catch { /* ignore partial line */ }
				}
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
					setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already dead */ } }, 5000);
				}, { once: true });
			}
		});

		return result;
	} finally {
		if (tmpPromptPath) {
			try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
		}
	}
}
