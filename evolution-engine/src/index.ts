/**
 * Evolution Engine — Extension 工厂函数
 *
 * 注册：
 *   - session_start 事件：检查自动触发规则，向 session 注入提示
 *   - evolve tool：分析 session 数据，生成进化建议
 *   - evolve-apply tool：应用 pending 建议
 *   - evolve-stats tool：查看统计仪表盘
 *   - evolve-rollback tool：回滚已应用的建议
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";

import type { Dirs } from "./types";
import { checkAutoTriggerRules, cleanExpiredFlags } from "./monitor";
import {
	handleEvolve,
	handleEvolveApply,
	handleEvolveStats,
	handleEvolveRollback,
	handleEvolveReport,
} from "./commands";
import {
	renderRollbackList,
	renderAutoTriggerHint,
} from "./widget";
import { loadHistory } from "./state";
import { checkAndRunDailyAnalysis } from "./daily-trigger";

// ── 常量 ─────────────────────────────────────────────

const EVOLUTION_DIR = join(homedir(), ".pi/agent/evolution-data");

/** 模板目录：本文件所在 src/ 下的 templates/ */
const TEMPLATE_DIR = (() => {
	// ESM 环境下用 import.meta.url，fallback 到 __dirname（后者在 bundler 模式中不可用）
	try {
		return join(dirname(fileURLToPath(import.meta.url)), "templates");
	} catch {
		// 这个 catch 理论上不会执行（bundler 模式下 import.meta.url 可用）
		return join(process.cwd(), "evolution-engine", "src", "templates");
	}
})();

/** 目录集合 */
function makeDirs(): Dirs {
	const evolutionDir = EVOLUTION_DIR;
	const reportsDir = join(evolutionDir, "reports");
	const tmpDir = join(evolutionDir, "tmp");
	const signalsDir = join(evolutionDir, "signals");
	const dailyReportsDir = join(evolutionDir, "daily-reports");

	// 确保 base 目录和子目录存在
	if (!existsSync(evolutionDir)) {
		mkdirSync(evolutionDir, { recursive: true });
	}
	for (const dir of [signalsDir, dailyReportsDir]) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	return {
		evolutionDir,
		reportsDir,
		tmpDir,
		signalsDir,
		dailyReportsDir,
		templateDir: TEMPLATE_DIR,
	};
}

// ── Tool 参数 schema ─────────────────────────────────

const EvolveParams = Type.Object({
	target: StringEnum(["all", "claude-md", "skills", "merge-reviewer"], {
		default: "all",
		description: "Analysis target scope",
	}),
	since: Type.String({
		default: "7d",
		description: 'Time range (e.g. "7d", "14d")',
	}),
	sample: Type.Optional(Type.Number({
		description: "Number of sessions to sample",
	})),
});

const EvolveApplyParams = Type.Object({
	action: StringEnum(["list", "apply", "skip"], {
		default: "list",
		description: "Action: list (default) shows pending suggestions, apply executes one, skip rejects one",
	}),
	index: Type.Optional(Type.Number({
		description: "Suggestion index (0-based). Required for apply/skip actions.",
	})),
});

const EvolveStatsParams = Type.Object({});

const EvolveRollbackParams = Type.Object({
	index: Type.Number({
		description: "History entry index to rollback (1-based)",
	}),
});

// ── Extension Factory ────────────────────────────────

export default function evolutionEngineExtension(pi: ExtensionAPI): void {
	const dirs = makeDirs();

	// ── Event: session_start ───────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const flags = checkAutoTriggerRules(dirs.evolutionDir);
		cleanExpiredFlags(dirs.evolutionDir);

		if (flags.length > 0) {
			const hint = renderAutoTriggerHint(flags);
			// 通过 session manager 追加提示（参考 usage-tracker 的模式）
			// ctx.ui.notify 在有 UI 时显示 toast
			if (ctx.hasUI) {
				ctx.ui.notify(hint, "info");
			}
		}

		// 每日自动分析：fire-and-forget，不阻塞 session 初始化
		checkAndRunDailyAnalysis(dirs).catch((err) => {
			console.error("[evolve] Daily analysis failed:", err instanceof Error ? err.message : String(err));
		});
	});

	// ── Tool: evolve ───────────────────────────────────

	pi.registerTool({
		name: "evolve",
		label: "Evolve",
		description:
			"Analyze session usage data and generate evolution suggestions. " +
			"Runs a session analyzer to produce a report, then uses an LLM Judge to generate suggestions. " +
			"Suggestions are saved to pending.json for later review via /evolve-apply.",
		promptSnippet: "Self-evolution: analyze usage patterns and suggest improvements",
		promptGuidelines: [
			"[/evolve] Runs analysis and generates suggestions. Does NOT apply anything automatically.",
			"[/evolve-apply] Applies all pending suggestions. Review evolve output first.",
			"[/evolve-stats] Shows usage statistics dashboard for the last 7 days.",
			"[/evolve-rollback N] Rolls back a previously applied suggestion by history index.",
		],
		parameters: EvolveParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			return await handleEvolve(
				{
					target: params.target as "all" | "claude-md" | "skills" | "merge-reviewer",
					since: params.since,
					sample: params.sample,
				},
				dirs,
			);
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("evolve ")) +
				theme.fg("muted", `target=${args.target} since=${args.since}`),
				0, 0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as {
				action?: string;
				count?: number;
				suggestions?: Array<{
					id: string;
					title: string;
					severity: string;
					confidence: number;
				}>;
				error?: boolean;
				message?: string;
			} | undefined;

			if (details?.error) {
				return new Text(
					theme.fg("error", `Error: ${details.message ?? "unknown"}`),
					0, 0,
				);
			}

			if (details?.suggestions && Array.isArray(details.suggestions)) {
				const lines: string[] = [
					theme.fg("toolTitle", `Generated ${details.suggestions.length} suggestion(s):`),
				];
				for (let i = 0; i < details.suggestions.length; i++) {
					const s = details.suggestions[i];
					const severity = s.severity.toUpperCase();
					const conf = s.confidence.toFixed(2);
					lines.push(
						`  ${theme.fg("accent", `#${i + 1}`)} [${severity} conf:${conf}] ${s.title}`,
					);
				}
				return new Text(lines.join("\n"), 0, 0);
			}

			// fallback
			const textPart = result.content[0];
			return new Text(
				textPart?.type === "text" ? textPart.text : "evolve completed",
				0, 0,
			);
		},
	});

	// ── Tool: evolve-apply ─────────────────────────────

	pi.registerTool({
		name: "evolve-apply",
		label: "Evolve Apply",
		description:
			"Review and manage evolution suggestions one by one. " +
			"action=list (default) shows all pending suggestions. " +
			"action=apply index=N applies suggestion #N. " +
			"action=skip index=N rejects suggestion #N. " +
			"Run /evolve first to generate suggestions.",
		promptSnippet: "Apply pending evolution suggestions",
		parameters: EvolveApplyParams,

		async execute(_toolCallId, params) {
			return await handleEvolveApply(
				{ action: params.action as "list" | "apply" | "skip", index: params.index },
				dirs,
			);
		},

		renderCall(_args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("evolve-apply")),
				0, 0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as {
				action?: string;
				pendingCount?: number;
				suggestions?: Array<{ index: number; title: string; severity: string; confidence: number; status: string }>;
				success?: boolean;
				reason?: string;
				suggestionId?: string;
				title?: string;
				error?: boolean;
				message?: string;
			} | undefined;

			if (details?.error) {
				return new Text(
					theme.fg("error", `Error: ${details.message ?? "unknown"}`),
					0, 0,
				);
			}

			const lines: string[] = [];

			if (details?.action === "list") {
				lines.push(theme.fg("toolTitle", `Pending suggestions (${details.pendingCount ?? 0}):`));
				if (details.suggestions) {
					for (const s of details.suggestions) {
						const severity = s.severity.toUpperCase();
						const conf = s.confidence.toFixed(2);
						lines.push(
							`  ${theme.fg("accent", `#${s.index}`)} [${severity} conf:${conf}] ${s.title}`,
						);
					}
				}
				if ((details.pendingCount ?? 0) > 0) {
					lines.push("");
					lines.push(theme.fg("dim", "Use /evolve-apply action=apply index=<N> or action=skip index=<N>"));
				}
			} else if (details?.action === "apply") {
				const icon = details.success
					? theme.fg("success", "\u2713")
					: theme.fg("error", "\u2717");
				const suffix = details.reason ? theme.fg("dim", ` (${details.reason})`) : "";
				lines.push(`${icon} Applied #${details.suggestionId ?? "?"} ${details.title ?? ""}${suffix}`);
			} else if (details?.action === "skip") {
				lines.push(theme.fg("dim", `\u2298 Skipped #${details.suggestionId ?? "?"} ${details.title ?? ""}`));
			}

			if (lines.length === 0) {
				const textPart = result.content[0];
				return new Text(
					textPart?.type === "text" ? textPart.text : "evolve-apply completed",
					0, 0,
				);
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// ── Tool: evolve-stats ─────────────────────────────

	pi.registerTool({
		name: "evolve-stats",
		label: "Evolve Stats",
		description:
			"Show usage statistics dashboard for the last 7 days. " +
			"Displays tool call counts, token usage, top skills, and high-failure-rate tools.",
		promptSnippet: "View evolution usage stats dashboard",
		parameters: EvolveStatsParams,

		async execute() {
			return handleEvolveStats(dirs.evolutionDir);
		},

		renderCall(_args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("evolve-stats")),
				0, 0,
			);
		},

		renderResult(result, _options, _theme) {
			const textPart = result.content[0];
			return new Text(
				textPart?.type === "text" ? textPart.text : "stats completed",
				0, 0,
			);
		},
	});

	// ── Tool: evolve-rollback ──────────────────────────

	pi.registerTool({
		name: "evolve-rollback",
		label: "Evolve Rollback",
		description:
			"Rollback a previously applied evolution suggestion by history index. " +
			"Use /evolve-rollback without index to list recent history first.",
		promptSnippet: "Rollback an applied evolution suggestion",
		parameters: EvolveRollbackParams,

		async execute(_toolCallId, params) {
			return await handleEvolveRollback(params.index, dirs);
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("evolve-rollback ")) +
				theme.fg("accent", `#${args.index}`),
				0, 0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as {
				action?: string;
				suggestionId?: string;
				targetPath?: string;
				error?: boolean;
				message?: string;
			} | undefined;

			if (details?.error) {
				return new Text(
					theme.fg("error", `Error: ${details.message ?? "unknown"}`),
					0, 0,
				);
			}

			const textPart = result.content[0];
			return new Text(
				textPart?.type === "text" ? textPart.text : "rollback completed",
				0, 0,
			);
		},
	});

	// ── Command: /evolve ───────────────────────────────

	pi.registerCommand("evolve", {
		description:
			"Analyze usage data and suggest improvements. " +
			"Supports natural language: /evolve, /evolve since=1d, /evolve analyze skills from last 3 days",
		handler: async (args, _ctx) => {
			pi.sendUserMessage(
				`Please call the evolve tool based on user intent: "${args.trim() || "target=all since=7d"}". Do not add any commentary, just call the tool directly.`,
			);
		},
	});

	// ── Command: /evolve-apply ──────────────────────────

	pi.registerCommand("evolve-apply", {
		description:
			"Review and manage evolution suggestions. " +
			"Supports natural language: /evolve-apply list, /evolve-apply apply 0, /evolve-apply skip the second one",
		handler: async (args, _ctx) => {
			pi.sendUserMessage(
				`Please call the evolve-apply tool based on user intent: "${args.trim() || "list pending suggestions"}". Do not add any commentary, just call the tool directly.`,
			);
		},
	});

	// ── Command: /evolve-stats ─────────────────────────

	pi.registerCommand("evolve-stats", {
		description: "Show usage statistics dashboard for the last 7 days.",
		handler: async (_args, _ctx) => {
			pi.sendUserMessage(
				"Please call the evolve-stats tool. Do not add any commentary, just call the tool directly.",
			);
		},
	});

	// ── Command: /evolve-rollback ──────────────────────

	pi.registerCommand("evolve-rollback", {
		description:
			"Rollback an applied evolution suggestion. " +
			"No index to list history, or provide an index to rollback. " +
			"Supports natural language: /evolve-rollback 3, /evolve-rollback the last one",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const index = parseInt(trimmed, 10);

			// 无有效 index 时，显示历史列表（tool schema 的 index 是必填，AI 无法调用无参版本）
			if (Number.isNaN(index) || index < 1) {
				const history = loadHistory(dirs.evolutionDir, 20);
				const text = renderRollbackList(history);
				if (ctx.hasUI) {
					ctx.ui.notify(text, "info");
				}
				return;
			}

			pi.sendUserMessage(
				`Please call the evolve-rollback tool with index=${index}. Do not add any commentary, just call the tool directly.`,
			);
		},
	});
	// ── Tool: evolve-report ────────────────────────────

	const EvolveReportParams = Type.Object({
		args: Type.String({
			default: "",
			description: "Date (YYYY-MM-DD) or --list",
		}),
	});

	pi.registerTool({
		name: "evolve-report",
		label: "Evolve Report",
		description:
			"View daily evolution reports. " +
			"No args shows today's report, YYYY-MM-DD shows a specific date, --list lists all reports.",
		promptSnippet: "View evolution daily report",
		parameters: EvolveReportParams,

		async execute(_toolCallId, params) {
			return handleEvolveReport(params.args, dirs);
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("evolve-report ")) +
				theme.fg("muted", args.args || "today"),
				0, 0,
			);
		},

		renderResult(result, _options, _theme) {
			const textPart = result.content[0];
			return new Text(
				textPart?.type === "text" ? textPart.text : "evolve-report completed",
				0, 0,
			);
		},
	});

	// ── Command: /evolve-report ────────────────────────

	pi.registerCommand("evolve-report", {
		description:
			"View daily evolution reports. " +
			"Usage: /evolve-report [YYYY-MM-DD] | --list",
		handler: async (args, _ctx) => {
			pi.sendUserMessage(
				`Please call the evolve-report tool with args="${args.trim()}". Do not add any commentary, just call the tool directly.`,
			);
		},
	});

}
