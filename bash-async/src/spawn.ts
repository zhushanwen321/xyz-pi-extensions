import * as child_process from "node:child_process";
import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateTail } from "@mariozechner/pi-coding-agent";
import type { BashAsyncConfig, BashAsyncToolDetails, Job, ShellContext } from "./types.js";
import {
	createOutFilePath,
	findJob,
	generateJobId,
	killProcessGroup,
	readOutputFile,
	registerJob,
	removeOutputFile,
	runningJobCount,
	updateJobStatus,
} from "./jobs.js";

// ── Internal types ──

interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: BashAsyncToolDetails;
	isError?: boolean;
}

type OnUpdate = ((details: BashAsyncToolDetails, text: string) => void) | undefined;

// ── Helpers ──

function validateCwd(cwd: string): void {
	try {
		const stat = fs.statSync(cwd);
		if (!stat.isDirectory()) {
			throw new Error(`Working directory is not a directory: ${cwd}`);
		}
	} catch (err: unknown) {
		if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`Working directory does not exist: ${cwd}`);
		}
		throw err;
	}
}

function makeResult(
	text: string,
	details: BashAsyncToolDetails,
	isError = false,
): ToolResult {
	return {
		content: [{ type: "text" as const, text }],
		details,
		isError: isError || undefined,
	};
}

function makeErrorResult(text: string, details: BashAsyncToolDetails): ToolResult {
	return makeResult(text, details, true);
}

// ── Spawn helper ──

interface SpawnResult {
	child: child_process.ChildProcess;
	outFile: string;
	writeStream: fs.WriteStream;
	exitPromise: Promise<number | null>;
	/** Remove only the in-memory capture listener, keep pipe intact */
	removeCapture: () => void;
}

/**
 * Spawn a shell process with output captured to temp file.
 * stdout/stderr are piped to both a WriteStream (temp file) and in-memory chunks.
 */
function spawnCommand(
	command: string,
	shellCtx: ShellContext,
	cwd: string,
	chunks: Buffer[],
	signal?: AbortSignal,
): SpawnResult {
	const fullCommand = shellCtx.commandPrefix
		? `${shellCtx.commandPrefix} && ${command}`
		: command;

	const outFile = createOutFilePath(generateJobId());

	const child = child_process.spawn(shellCtx.shell, [...shellCtx.args, fullCommand], {
		cwd,
		env: shellCtx.env,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});

	// Write to temp file
	const writeStream = fs.createWriteStream(outFile, { flags: "w" });
	child.stdout?.pipe(writeStream);
	child.stderr?.pipe(writeStream);

	// Also capture in memory for sync mode
	const capture = (data: Buffer): void => { chunks.push(data); };
	child.stdout?.on("data", capture);
	child.stderr?.on("data", capture);

	// Exit/error promise — resolves with exit code, rejects on spawn error
	const exitPromise = new Promise<number | null>((resolve, reject) => {
		child.on("exit", (code) => {
			// Unpipe before destroy to avoid ERR_STREAM_DESTROYED
			child.stdout?.unpipe(writeStream);
			child.stderr?.unpipe(writeStream);
			writeStream.destroy();
			resolve(code);
		});
		child.on("error", (err) => {
			child.stdout?.unpipe(writeStream);
			child.stderr?.unpipe(writeStream);
			writeStream.destroy();
			removeOutputFile(outFile);
			reject(err);
		});
	});

	// Handle abort signal
	if (signal) {
		const onAbort = (): void => {
			killProcessGroup(child.pid ?? 0).catch((e: unknown) => {
				console.error("[bash-async] abort kill error:", e instanceof Error ? e.message : e);
			});
		};
		signal.addEventListener("abort", onAbort, { once: true });
		exitPromise.finally(() => signal.removeEventListener("abort", onAbort));
	}

	const removeCapture = (): void => {
		child.stdout?.removeListener("data", capture);
		child.stderr?.removeListener("data", capture);
	};

	return { child, outFile, writeStream, exitPromise, removeCapture };
}

function getBufferContent(chunks: Buffer[]): string {
	return Buffer.concat(chunks).toString("utf-8");
}

// ── Public: Sync mode with timeout detach ──

export async function executeSync(
	cmd: string,
	cwd: string,
	timeout: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdate,
	jobs: Map<string, Job>,
	shellCtx: ShellContext,
	config: BashAsyncConfig,
): Promise<ToolResult> {
	validateCwd(cwd);

	const effectiveTimeout = timeout ?? config.defaultTimeout;
	const chunks: Buffer[] = [];

	let spawnResult: SpawnResult;
	try {
		spawnResult = spawnCommand(cmd, shellCtx, cwd, chunks, signal);
	} catch (err: unknown) {
		// Spawn-time error (bad shell path, etc.)
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to spawn command: ${msg}`);
	}
	const { child, outFile, exitPromise, removeCapture } = spawnResult;
	if (onUpdate) {
		const forwardData = (): void => {
			onUpdate({ action: "sync" }, getBufferContent(chunks));
		};
		child.stdout?.on("data", () => forwardData());
		child.stderr?.on("data", () => forwardData());
	}

	// Race exit vs timeout
	let timedOut = false;
	const timeoutPromise: Promise<null> =
		effectiveTimeout > 0
			? new Promise((resolve) => {
					const handle = setTimeout(() => {
						timedOut = true;
						resolve(null);
					}, effectiveTimeout * 1000);
					handle.unref();
				})
			: NEVER_RESOLVES;

	let exitCode: number | null;
	try {
		exitCode = await Promise.race([exitPromise, timeoutPromise]);
	} catch (err: unknown) {
		// spawn error (ENOENT, EACCES) — FR-11
		const msg = err instanceof Error ? err.message : String(err);
		return makeErrorResult(
			`Command not found or permission denied: ${msg}`,
			{ action: "sync" },
		);
	}

	// Check if aborted
	if (signal?.aborted) {
		throw new Error("Command aborted");
	}

	if (timedOut) {
		return detachJob(cmd, cwd, effectiveTimeout, child, outFile, exitPromise, chunks, removeCapture, jobs);
	}

	// Normal completion
	removeOutputFile(outFile);
	const output = getBufferContent(chunks);
	const truncated = truncateTail(output);

	if (exitCode !== 0) {
		const suffix = truncated.truncated ? "\n[Output truncated]" : "";
		throw new Error(`Command exited with code ${exitCode}\n${truncated.text}${suffix}`);
	}

	return makeResult(truncated.text, {
		action: "sync",
		exitCode: 0,
		truncated: truncated.truncated,
	});
}

const NEVER_RESOLVES: Promise<null> = new Promise(() => {});

/**
 * Detach from a timed-out process: register as job and return partial output.
 */
function detachJob(
	cmd: string,
	cwd: string,
	timeout: number,
	child: child_process.ChildProcess,
	outFile: string,
	exitPromise: Promise<number | null>,
	chunks: Buffer[],
	removeCapture: () => void,
	jobs: Map<string, Job>,
): ToolResult {
	const jobId = generateJobId();
	const job: Job = {
		jobId,
		pid: child.pid ?? 0,
		command: cmd,
		cwd,
		startTime: Date.now(),
		status: "running",
		exitCode: null,
		outFile,
		child,
		mode: "sync-detach",
	};
	registerJob(jobs, job);

	// Stop in-memory capture — output continues to WriteStream/file only
	removeCapture();

	// When process eventually exits, update job status
	exitPromise.then((code) => {
		updateJobStatus(jobs, jobId, code === 0 ? "done" : "failed", code ?? undefined);
	}).catch((e: unknown) => {
		console.error("[bash-async] sync-detach exit handler error:", e instanceof Error ? e.message : e);
	});

	const partialOutput = getBufferContent(chunks);
	const truncated = truncateTail(partialOutput);
	const hint = `\n\n⏱ Timeout reached (${timeout}s). Job ${jobId} is still running.\nUse pollJobId: "${jobId}" to check status or killJobId: "${jobId}" to terminate.`;

	return makeResult(truncated.text + hint, {
		action: "sync-detach",
		jobId,
		status: "running",
		truncated: truncated.truncated,
		outFile,
	});
}

// ── Public: Background mode ──

export async function executeBackground(
	cmd: string,
	cwd: string,
	pi: ExtensionAPI,
	jobs: Map<string, Job>,
	shellCtx: ShellContext,
	config: BashAsyncConfig,
): Promise<ToolResult> {
	validateCwd(cwd);

	if (runningJobCount(jobs) >= config.maxBackgroundJobs) {
		return makeErrorResult(
			`Max concurrent background jobs reached (${config.maxBackgroundJobs}). Kill an existing job first.`,
			{ action: "background" },
		);
	}

	const chunks: Buffer[] = [];
	let spawnResult: SpawnResult;
	try {
		spawnResult = spawnCommand(cmd, shellCtx, cwd, chunks);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return makeErrorResult(`Failed to spawn command: ${msg}`, { action: "background" });
	}
	const { child, outFile, exitPromise, removeCapture } = spawnResult;

	const jobId = generateJobId();
	const job: Job = {
		jobId,
		pid: child.pid ?? 0,
		command: cmd,
		cwd,
		startTime: Date.now(),
		status: "running",
		exitCode: null,
		outFile,
		child,
		mode: "background",
	};
	registerJob(jobs, job);

	// Stop in-memory capture for background jobs — output goes to file only
	removeCapture();

	// Handle process exit
	exitPromise.then((code) => {
		updateJobStatus(jobs, jobId, code === 0 ? "done" : "failed", code ?? undefined);
		// Only inject result if job wasn't killed
		const currentJob = findJob(jobs, jobId);
		if (currentJob && currentJob.status !== "killed") {
			injectBackgroundResult(pi, job, code, outFile);
		}
	}).catch((e: unknown) => {
		console.error("[bash-async] bg exit handler error:", e instanceof Error ? e.message : e);
	});

	return makeResult(
		`🔄 Background job started.\nJobId: ${jobId}\nCommand: ${cmd}\nWorking directory: ${cwd}\n\nResults will be injected when the job completes.`,
		{ action: "background", jobId, status: "running" },
	);
}

/**
 * Inject background job results via pi.sendMessage.
 * Errors are silently ignored (session may be shutting down).
 */
function injectBackgroundResult(
	pi: ExtensionAPI,
	job: Job,
	exitCode: number | null,
	outFile: string,
): void {
	const output = readOutputFile(outFile);
	const truncated = truncateTail(output);
	const status = exitCode === 0 ? "✅ DONE" : "❌ FAILED";
	const elapsed = Math.round((Date.now() - job.startTime) / 1000);
	const text = `${status} — Background job ${job.jobId}\nCommand: ${job.command}\nDuration: ${elapsed}s\nExit code: ${exitCode}\n\n${truncated.text}${truncated.truncated ? "\n[Output truncated]" : ""}`;

	try {
		pi.sendMessage(
			{
				customType: "bash-async-background-result",
				content: text,
				display: true,
			},
			{
				deliverAs: "followUp",
				triggerTurn: true,
			},
		);
	} catch (e: unknown) {
		console.error("[bash-async] sendMessage error:", e instanceof Error ? e.message : e);
	}
}

// ── Public: Poll job status ──

export async function executePoll(
	jobId: string,
	jobs: Map<string, Job>,
): Promise<ToolResult> {
	const job = findJob(jobs, jobId);
	if (!job) {
		return makeErrorResult(
			`Job not found: ${jobId}`,
			{ action: "poll" },
		);
	}

	const output = readOutputFile(job.outFile);
	const truncated = truncateTail(output);
	const elapsed = Math.round((Date.now() - job.startTime) / 1000);
	const statusIcon = job.status === "running" ? "⏳" : job.status === "done" ? "✅" : job.status === "failed" ? "❌" : "⛔";

	const header = `${statusIcon} Job ${jobId}\nStatus: ${job.status}\nCommand: ${job.command}\nDuration: ${elapsed}s${job.exitCode !== null ? `\nExit code: ${job.exitCode}` : ""}\n`;

	return makeResult(header + "\n" + truncated.text, {
		action: "poll",
		jobId,
		status: job.status,
		exitCode: job.exitCode,
		duration: elapsed,
		truncated: truncated.truncated,
		outFile: job.outFile,
	});
}

// ── Public: Kill job ──

export async function executeKill(
	jobId: string,
	jobs: Map<string, Job>,
): Promise<ToolResult> {
	const job = findJob(jobs, jobId);
	if (!job) {
		return makeErrorResult(
			`Job not found: ${jobId}`,
			{ action: "kill" },
		);
	}

	if (job.status !== "running") {
		const output = readOutputFile(job.outFile);
		const truncated = truncateTail(output);
		return makeResult(
			`Job ${jobId} already finished (status: ${job.status}, exit code: ${job.exitCode})\n\n${truncated.text}`,
			{ action: "kill", jobId, status: job.status, exitCode: job.exitCode },
		);
	}

	// Register exit listener BEFORE killing to avoid race condition
	const exitPromise = new Promise<number | null>((resolve) => {
		if (job.child.exitCode !== null) {
			resolve(job.child.exitCode);
			return;
		}
		job.child.once("exit", (code) => resolve(code));
	});

	// Mark as killed BEFORE killing to prevent bg exit handler from injecting result
	job.status = "killed";

	// Kill the process group
	await killProcessGroup(job.pid);

	// Wait for exit with timeout
	const exitCode = await Promise.race([
		exitPromise,
		new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
	]);

	updateJobStatus(jobs, jobId, "killed", exitCode ?? undefined);

	const output = readOutputFile(job.outFile);
	const truncated = truncateTail(output);
	const elapsed = Math.round((Date.now() - job.startTime) / 1000);

	return makeResult(
		`⛔ Job ${jobId} killed.\nCommand: ${job.command}\nDuration: ${elapsed}s\nExit code: ${exitCode}\n\n${truncated.text}${truncated.truncated ? "\n[Output truncated]" : ""}`,
		{ action: "kill", jobId, status: "killed", exitCode, duration: elapsed, truncated: truncated.truncated },
	);
}
