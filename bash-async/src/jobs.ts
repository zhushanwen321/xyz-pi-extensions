import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BashAsyncConfig, Job, JobStatus } from "./types.js";

// ── Job map factory ──

export function createJobMap(): Map<string, Job> {
	return new Map();
}

// ── ID generation ──

export function generateJobId(): string {
	const ts = Date.now().toString(36);
	const rand = crypto.randomBytes(2).toString("hex");
	return `ba-${ts}-${rand}`;
}

// ── Job lifecycle ──

export function registerJob(jobs: Map<string, Job>, job: Job): void {
	jobs.set(job.jobId, job);
}

export function findJob(jobs: Map<string, Job>, jobId: string): Job | undefined {
	return jobs.get(jobId);
}

export function updateJobStatus(
	jobs: Map<string, Job>,
	jobId: string,
	status: JobStatus,
	exitCode?: number,
): void {
	const job = jobs.get(jobId);
	if (!job) return;
	job.status = status;
	if (exitCode !== undefined) {
		job.exitCode = exitCode;
	}
}

export function runningJobCount(jobs: Map<string, Job>): number {
	let count = 0;
	for (const job of jobs.values()) {
		if (job.status === "running") count++;
	}
	return count;
}

/**
 * Kill all running jobs and remove temp files.
 * Called from session_shutdown.
 */
export async function cleanupJobs(jobs: Map<string, Job>): Promise<void> {
	const promises: Promise<void>[] = [];
	for (const job of jobs.values()) {
		if (job.status === "running") {
			promises.push(
				killProcessGroup(job.pid).catch((e: unknown) => {
					console.error("[bash-async] cleanup kill error:", e instanceof Error ? e.message : e);
				}),
			);
			job.status = "killed";
		}
		try {
			fs.unlinkSync(job.outFile);
		} catch (e: unknown) {
			// file may already be gone — expected
			void e;
		}
	}
	jobs.clear();
	await Promise.allSettled(promises);
}

/**
 * Kill a process group (sends SIGTERM, then SIGKILL after timeout).
 * On Windows, uses taskkill.
 */
export async function killProcessGroup(pid: number): Promise<void> {
	const isWin = process.platform === "win32";

	if (isWin) {
		const { exec } = await import("node:child_process");
		await new Promise<void>((resolve) => {
			exec(`taskkill /F /T /PID ${pid}`, (err) => {
				// ESRCH equivalent — process already dead
				void err;
				resolve();
			});
		});
		return;
	}

	try {
		// Negative pid = process group
		process.kill(-pid, "SIGTERM");
	} catch (err: unknown) {
		// ESRCH — process already dead
		if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ESRCH") {
			return;
		}
		throw err;
	}

	// Give process 5 seconds to exit gracefully
	await new Promise((resolve) => setTimeout(resolve, 5000));

	try {
		// Check if still alive, force kill
		process.kill(-pid, 0); // throws if dead
		process.kill(-pid, "SIGKILL");
	} catch (e: unknown) {
		// Already dead — expected
		void e;
	}
}

// ── Config loading ──

const DEFAULT_CONFIG: BashAsyncConfig = {
	defaultTimeout: 120,
	maxBackgroundJobs: 10,
};

export function loadConfig(): BashAsyncConfig {
	const configPath = path.join(os.homedir(), ".pi", "agent", "bash-async.json");
	try {
		const raw = fs.readFileSync(configPath, "utf-8");
		const data = JSON.parse(raw) as Record<string, unknown>;
		return {
			defaultTimeout:
				typeof data.defaultTimeout === "number" && data.defaultTimeout >= 0
					? data.defaultTimeout
					: DEFAULT_CONFIG.defaultTimeout,
			maxBackgroundJobs:
				typeof data.maxBackgroundJobs === "number" && data.maxBackgroundJobs > 0
					? data.maxBackgroundJobs
					: DEFAULT_CONFIG.maxBackgroundJobs,
		};
	} catch (e: unknown) {
		console.error("[bash-async] config load error:", e instanceof Error ? e.message : e);
		return { ...DEFAULT_CONFIG };
	}
}

// ── Temp file helpers ──

const JOBS_DIR_NAME = "pi-bash-jobs";

export function getJobsDir(): string {
	return path.join(os.tmpdir(), JOBS_DIR_NAME);
}

export function ensureJobsDir(): string {
	const dir = getJobsDir();
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function createOutFilePath(jobId: string): string {
	return path.join(ensureJobsDir(), `${jobId}.out`);
}

export function readOutputFile(filePath: string): string {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch (e: unknown) {
		console.error("[bash-async] read output error:", e instanceof Error ? e.message : e);
		return "";
	}
}

export function removeOutputFile(filePath: string): void {
	try {
		fs.unlinkSync(filePath);
	} catch (e: unknown) {
		// already gone — expected for killed/completed jobs
		void e;
	}
}
