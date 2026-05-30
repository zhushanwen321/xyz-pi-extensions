import type { ChildProcess } from "node:child_process";

// ── Job lifecycle states ──

export type JobStatus = "running" | "done" | "failed" | "killed";

export type JobMode = "sync-detach" | "background";

// ── Job record ──

export interface Job {
	readonly jobId: string;
	pid: number;
	command: string;
	cwd: string;
	startTime: number;
	status: JobStatus;
	exitCode: number | null;
	outFile: string;
	child: ChildProcess;
	mode: JobMode;
}

// ── Configuration ──

export interface BashAsyncConfig {
	/** Sync mode timeout in seconds (0 = no timeout) */
	defaultTimeout: number;
	/** Max concurrent background jobs */
	maxBackgroundJobs: number;
}

// ── Shell context ──

export interface ShellContext {
	shell: string;
	args: string[];
	env: Record<string, string>;
	commandPrefix: string;
}

// ── Tool parameter types ──

export interface BashAsyncParams {
	command?: string;
	timeout?: number;
	background?: boolean;
	pollJobId?: string;
	killJobId?: string;
}

// ── Tool result details ──

export interface BashAsyncToolDetails {
	action: "sync" | "sync-detach" | "background" | "poll" | "kill";
	jobId?: string;
	exitCode?: number | null;
	status?: JobStatus;
	duration?: number;
	truncated?: boolean;
	outFile?: string;
}
