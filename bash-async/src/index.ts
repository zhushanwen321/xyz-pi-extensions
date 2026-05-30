/**
 * bash-async Extension — Override built-in bash with background + timeout detach
 *
 * 4 modes:
 *   sync (default)       — execute command, detach on timeout
 *   background           — spawn and return immediately
 *   pollJobId            — query job status/output
 *   killJobId            — terminate a running job
 *
 * Session-scoped job map. Temp files in $TMPDIR/pi-bash-jobs/.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
// StringEnum available from @earendil-works/pi-ai if needed
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { BashAsyncParams, BashAsyncToolDetails, BashAsyncConfig, ShellContext } from "./types.js";
import { loadConfig } from "./jobs.js";
import { buildShellContext } from "./shell.js";
import { executeSync, executeBackground, executePoll, executeKill } from "./spawn.js";

// ── Tool description ──

const TOOL_DESCRIPTION = `Execute shell commands with background execution and timeout detach support.

## Modes

**Sync (default):** Execute command and return output. If command exceeds timeout, the process is detached (NOT killed) and a jobId is returned. Use pollJobId to check status later.
- Default timeout: 120 seconds (configurable via ~/.pi/agent/bash-async.json)
- Set timeout: 0 to disable timeout for this call

**Background:** Run command in background, return immediately with a jobId. Results are auto-injected when the job completes.
- Use for long-running commands (tests, builds, dev servers)
- Max concurrent: 10 (configurable)

**Poll:** Check status and output of a running or completed job.
- Recommended interval: 10-30 seconds

**Kill:** Terminate a running job by jobId.

## Important
- After timeout detach, the process is STILL RUNNING — use pollJobId, not re-execute
- Only one mode parameter (background, pollJobId, killJobId) per call`;

// ── Parameter schema ──

const bashAsyncSchema = Type.Object({
	command: Type.Optional(Type.String({
		description: "Shell command to execute (required for sync and background modes)",
	})),
	timeout: Type.Optional(Type.Number({
		description: "Override default timeout in seconds for sync mode (0 = no timeout)",
	})),
	background: Type.Optional(Type.Boolean({
		description: "Run command in background and return immediately",
	})),
	pollJobId: Type.Optional(Type.String({
		description: "Query status/output of an existing job",
	})),
	killJobId: Type.Optional(Type.String({
		description: "Terminate an existing job",
	})),
});

// ── Extension factory ──

export default function bashAsyncExtension(pi: ExtensionAPI): void {
	// Session-scoped state — rebuilt on each session_start
	let config: BashAsyncConfig;
	let shellCtx: ShellContext;
	let jobs: ReturnType<typeof import("./jobs.js").createJobMap>;

	pi.on("session_start", () => {
		config = loadConfig();
		shellCtx = buildShellContext();
		jobs = createJobMap();
	});

	pi.on("session_shutdown", async () => {
		if (jobs) {
			await import("./jobs.js").then((m) => m.cleanupJobs(jobs));
		}
	});

	pi.registerTool({
		name: "bash",
		label: "Bash (async)",
		description: TOOL_DESCRIPTION,
		parameters: bashAsyncSchema,
		renderShell: "self",

		async execute(
			_toolCallId: string,
			params: BashAsyncParams,
			signal: AbortSignal | undefined,
			onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: BashAsyncToolDetails }) => void) | undefined,
			_ctx: unknown,
		) {
			const onUpdateAdapter = onUpdate
				? (details: BashAsyncToolDetails, text: string) => {
						onUpdate({ content: [{ type: "text", text }], details });
					}
				: undefined;

			// Route to mode
			if (params.pollJobId) {
				if (params.killJobId || params.background || params.command) {
					throw new Error("Only one mode parameter allowed per call. Use pollJobId alone.");
				}
				return executePoll(params.pollJobId, jobs);
			}

			if (params.killJobId) {
				if (params.background || params.command) {
					throw new Error("Only one mode parameter allowed per call. Use killJobId alone.");
				}
				return executeKill(params.killJobId, jobs);
			}

			if (!params.command) {
				throw new Error("command is required for sync and background modes.");
			}

			if (params.background) {
				return executeBackground(params.command, process.cwd(), pi, jobs, shellCtx, config);
			}

			// Sync mode (default)
			return executeSync(
				params.command,
				process.cwd(),
				params.timeout,
				signal,
				onUpdateAdapter,
				jobs,
				shellCtx,
				config,
			);
		},

		renderCall(args: BashAsyncParams, theme: unknown): unknown {
			const t = theme as { fg: (token: string, text: string) => string };
			let icon: string;
			let detail: string;

			if (args.pollJobId) {
				icon = "📡";
				detail = `Poll ${args.pollJobId.slice(0, 12)}...`;
			} else if (args.killJobId) {
				icon = "⛔";
				detail = `Kill ${args.killJobId.slice(0, 12)}...`;
			} else if (args.background) {
				icon = "🔄";
				detail = (args.command ?? "").split("\n")[0].slice(0, 60);
			} else {
				icon = "⏳";
				const cmd = (args.command ?? "").split("\n")[0].slice(0, 60);
				const timeoutHint = args.timeout !== undefined ? ` (${args.timeout}s)` : "";
				detail = cmd + timeoutHint;
			}

			return new Text(`${icon} ${t.fg("toolTitle", "bash")} ${detail}`, 0, 0);
		},

		renderResult(
			result: { content: Array<{ type: "text"; text: string }>; details: BashAsyncToolDetails; isError?: boolean },
			options: { expanded: boolean },
			theme: unknown,
		): unknown {
			const t = theme as { fg: (token: string, text: string) => string; bold: (text: string) => string };
			const { details, isError } = result;
			const text = result.content[0]?.text ?? "";

			if (!options.expanded) {
				// Collapsed: show first 2 lines
				const lines = text.split("\n").slice(0, 2).join("\n");
				const statusIcon = isError ? "❌" : details.action === "sync-detach" ? "⏱" : details.action === "background" ? "🔄" : "✅";
				return new Text(`${statusIcon} ${lines}`, 0, 0);
			}

			// Expanded: full output
			const header = isError
				? t.fg("error", t.bold("Error"))
				: t.fg("success", t.bold(`[${details.action}]`));

			const meta: string[] = [];
			if (details.jobId) meta.push(`Job: ${details.jobId}`);
			if (details.exitCode !== undefined) meta.push(`Exit: ${details.exitCode}`);
			if (details.status) meta.push(`Status: ${details.status}`);
			if (details.duration) meta.push(`${details.duration}s`);

			const metaStr = meta.length > 0 ? t.fg("dim", meta.join(" | ")) + "\n" : "";
			const truncNote = details.truncated ? t.fg("warning", "[Output truncated]") + "\n" : "";

			return new Text(`${header}\n${metaStr}${truncNote}${text}`, 0, 0);
		},
	});
}

// Need createJobMap import at module level for session_start
import { createJobMap } from "./jobs.js";
