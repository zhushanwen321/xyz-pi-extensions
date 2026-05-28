/**
 * Evolution Engine — Command handler 函数
 *
 * 4 个 handler：handleEvolve, handleEvolveApply, handleEvolveStats, handleEvolveRollback
 * 每个 handler 返回 CommandResult（{ content, details }）。
 * 错误用 throw new Error() 抛出，正常路径返回 CommandResult。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import type {
	Dirs,
	CommandResult,
	EvolveCommandParams,
	EvolveApplyCommandParams,
	StatsData,
	PendingFile,
	EvolutionSuggestion,
	JudgeInput,
} from "./types";
import { runJudge } from "./judge";
import { applySuggestion, rollbackSuggestion } from "./applier";
import { loadPending, savePending, appendHistory, loadHistory, loadMetricsHistory } from "./state";
import { summarizeReport } from "./summarizer.js";
import { buildEffectReview } from "./effect-tracker.js";
import { runGc } from "./gc.js";

// ── 常量 ─────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;
/** analyzer 脚本执行超时 */
const ANALYZER_TIMEOUT_MS = 60_000;

const ANALYZER_SCRIPT = join(
	homedir(),
	".pi/agent/scripts/pi-session-analyzer/analyze.py",
);

// ── 工具函数 ─────────────────────────────────────────

function successResult(text: string, details: Record<string, unknown>): CommandResult {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

/** 检查 reportsDir 下最近 N 天内是否有 JSON 报告 */
function findRecentReport(reportsDir: string, sinceDays: number): string | null {
	if (!existsSync(reportsDir)) return null;

	const cutoff = Date.now() - sinceDays * MS_PER_DAY;
	const files: Array<{ name: string; mtime: number }> = [];

	for (const entry of readdirSync(reportsDir)) {
		if (!entry.endsWith(".json")) continue;
		const filePath = join(reportsDir, entry);
		try {
			const stat = { mtime: getMtimeMs(filePath) };
			if (stat.mtime >= cutoff) {
				files.push({ name: entry, mtime: stat.mtime });
			}
		} catch (err) {
			// 文件可能被其他进程删除，跳过
			if (process.env.NODE_ENV !== "test") console.warn(`[evolve] Failed to stat ${entry}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	if (files.length === 0) return null;

	// 取最新的
	files.sort((a, b) => b.mtime - a.mtime);
	return join(reportsDir, files[0].name);
}

function getMtimeMs(filePath: string): number {
	return statSync(filePath).mtimeMs;
}

function parseSinceDays(since: string): number {
	const match = since.match(/^(\d+)d$/);
	if (match) return parseInt(match[1], 10);
	// fallback: 尝试直接当数字
	const n = parseInt(since, 10);
	return Number.isFinite(n) && n > 0 ? n : 7;
}

// ── handleEvolve ─────────────────────────────────────

/**
 * /evolve handler:
 * 1. 查找近期报告（或运行 analyzer 生成）
 * 2. 构建 Judge 输入
 * 3. 运行 LLM Judge
 * 4. 保存 pending.json
 * 5. 返回建议摘要
 */
export async function handleEvolve(
	params: EvolveCommandParams,
	dirs: Dirs,
): Promise<CommandResult> {
	try {
		const sinceDays = parseSinceDays(params.since);

		// 1. 查找近期报告
		let reportPath = findRecentReport(dirs.reportsDir, sinceDays);

		if (!reportPath) {
			// 运行 analyzer 生成报告
			if (!existsSync(dirs.reportsDir)) {
				mkdirSync(dirs.reportsDir, { recursive: true });
			}

			const tmpReportPath = join(
				dirs.reportsDir,
				`phase2-${Date.now()}.json`,
			);

			if (!existsSync(ANALYZER_SCRIPT)) {
				throw new Error(
					`Session analyzer not found at ${ANALYZER_SCRIPT}. ` +
					`Please install pi-session-analyzer first.`
				);
			}

			try {
				execFileSync(
					"python3",
					[ANALYZER_SCRIPT, "--since", params.since, "--format", "json", "--output", tmpReportPath],
					{ timeout: ANALYZER_TIMEOUT_MS, stdio: "pipe" },
				);
				reportPath = tmpReportPath;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`Failed to run session analyzer: ${msg}`);
			}
		}

		// 2. 读取报告
		let report: Record<string, unknown>;
		try {
			const raw = readFileSync(reportPath, "utf-8");
			report = JSON.parse(raw) as Record<string, unknown>;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to read report: ${msg}`);
		}

		// 3. Signal Summarizer Pipeline
		if (!existsSync(dirs.tmpDir)) {
			mkdirSync(dirs.tmpDir, { recursive: true });
		}

		// 3a. 加载 metrics 历史
		const metricsHistory = loadMetricsHistory(dirs.evolutionDir);

		// 3b. 运行 summarizer（内部会 saveMetricsSnapshot + 写信号文件到 signalsDir）
		const signalReport = summarizeReport(report, metricsHistory, dirs.evolutionDir, reportPath);

		// 3b-2. 将新 snapshot 加入内存历史，让 effect review 看到最新数据
		metricsHistory.push(signalReport.metricsSnapshot);

		// 3c. 构建 effect review 并追加到信号文件
		const recentHistory = loadHistory(dirs.evolutionDir, 30);
		const effectReview = buildEffectReview(recentHistory, metricsHistory);
		if (effectReview.length > 0) {
			signalReport.effectReview = effectReview;
			const effectSignalPath = join(dirs.signalsDir, `signal-${signalReport.metricsSnapshot.date}.json`);
			writeFileSync(effectSignalPath, JSON.stringify(signalReport, null, 2), "utf-8");
		}

		// 3d. GC 清理旧信号文件
		runGc(dirs.evolutionDir);

		// 3e. 构建 Judge input（使用信号文件而非原始报告）
		const signalPath = join(dirs.signalsDir, `signal-${signalReport.metricsSnapshot.date}.json`);
		const judgeInput: JudgeInput = {
			target: params.target === "all" ? "all" : params.target,
			reportPath: signalPath,
			promptFilePath: "",
		};

		// 4. 运行 LLM Judge
		let suggestions: EvolutionSuggestion[];
		try {
			suggestions = await runJudge(judgeInput, dirs.templateDir);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`LLM Judge failed: ${msg}`);
		}

		// 5. 保存 pending.json
		const pending: PendingFile = {
			generatedAt: new Date().toISOString(),
			reportUsed: reportPath,
			suggestions,
		};
		savePending(dirs.evolutionDir, pending);

		// 6. 返回摘要（含 index + title + severity）
		const summaryLines = suggestions
			.map((s, i) => `  #${i} [${s.severity.toUpperCase()}] ${s.title}`)
			.join("\n");

		return successResult(
			`Generated ${suggestions.length} evolution suggestion(s):\n${summaryLines}\n\nUse /evolve-apply action=list to review details, then /evolve-apply action=apply index=<N> or action=skip index=<N> to decide per suggestion.`,
			{
				action: "evolve",
				count: suggestions.length,
				suggestions: suggestions.map((s, i) => ({
					index: i,
					id: s.id,
					title: s.title,
					severity: s.severity,
					confidence: s.confidence,
					target: s.target,
					targetPath: s.targetPath,
					status: s.status,
				})),
			},
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Unexpected error in /evolve: ${msg}`);
	}
}

// ── handleEvolveApply ────────────────────────────────

/**
 * /evolve-apply handler:
 * - "list" (默认): 显示所有 pending 建议，不做任何 apply
 * - "apply" + index: 对指定 index 的建议执行 apply（仅 status === "pending"）
 * - "skip" + index: 对指定 index 的建议标记为 rejected
 */
export async function handleEvolveApply(
	params: EvolveApplyCommandParams,
	dirs: Dirs,
): Promise<CommandResult> {
	try {
		const pending = loadPending(dirs.evolutionDir);
		if (!pending) {
			throw new Error("No pending suggestions found. Run /evolve first.");
		}

		const allSuggestions = pending.suggestions;

		// ── list: 显示所有 pending 建议 ─────────────────
		if (params.action === "list") {
			const pendingItems = allSuggestions
				.map((s, i) => ({ suggestion: s, index: i }))
				.filter(({ suggestion }) => suggestion.status === "pending");

			if (pendingItems.length === 0) {
				return successResult("No pending suggestions. All reviewed or none generated.", {
					action: "list",
				pendingCount: 0,
				suggestions: [],
				});
			}

			const contentLines = pendingItems.map(({ suggestion, index }) => {
				const header = `#${index} [${suggestion.severity.toUpperCase()}] ${suggestion.title}`;
				const desc = suggestion.description ? `  Description: ${suggestion.description}` : "";
				const rationale = suggestion.rationale ? `  Rationale: ${suggestion.rationale}` : "";
				const diff = suggestion.diff ? `  Diff target: ${suggestion.targetPath}` : "";
				const diffPreview = suggestion.diff
					? `  Diff preview:\n  ${suggestion.diff.split("\n").slice(0, 10).join("\n  ")}`
					: "";
				return [header, desc, rationale, diff, diffPreview].filter(Boolean).join("\n");
			}).join("\n\n");

			return successResult(
				`Pending suggestions (${pendingItems.length}):\n\n${contentLines}`,
				{
					action: "list",
					pendingCount: pendingItems.length,
					suggestions: pendingItems.map(({ suggestion, index }) => ({
						index,
						id: suggestion.id,
						title: suggestion.title,
						severity: suggestion.severity,
						confidence: suggestion.confidence,
						target: suggestion.target,
						targetPath: suggestion.targetPath,
						status: suggestion.status,
						description: suggestion.description,
						rationale: suggestion.rationale,
						diff: suggestion.diff,
					})),
				},
			);
		}

		// ── apply/skip: 需要 index 参数 ──────────────────
		if (params.index === undefined) {
			throw new Error(
				`Index is required for "${params.action}" action. Use /evolve-apply action=list first to see indices.`,
			);
		}

		if (params.index < 0 || params.index >= allSuggestions.length) {
			throw new Error(
				`Invalid index: ${params.index}. Valid range: 0-${allSuggestions.length - 1}`,
			);
		}

		const suggestion = allSuggestions[params.index];

		// ── skip: 标记为 rejected ──────────────────────
		if (params.action === "skip") {
			suggestion.status = "rejected";
			savePending(dirs.evolutionDir, pending);

			return successResult(
				`Skipped suggestion #${params.index}: ${suggestion.title}`,
				{
					action: "skip",
					index: params.index,
					suggestionId: suggestion.id,
					title: suggestion.title,
				},
			);
		}

		// ── apply: 只处理 pending 状态 ─────────────────
		if (suggestion.status !== "pending") {
			throw new Error(
				`Suggestion #${params.index} is "${suggestion.status}", not "pending". Only pending suggestions can be applied.`,
			);
		}

		const backupDir = join(dirs.evolutionDir, "backups");
		if (!existsSync(backupDir)) {
			mkdirSync(backupDir, { recursive: true });
		}

		const result = await applySuggestion(suggestion, backupDir);

		if (result.success) {
			suggestion.status = "applied";

			// 获取最新 snapshot 日期，用于后续效果追踪
			const metricsHistory = loadMetricsHistory(dirs.evolutionDir);
			const latestSnapshotDate = metricsHistory.length > 0
				? metricsHistory[metricsHistory.length - 1].date
				: undefined;

			appendHistory(dirs.evolutionDir, {
				timestamp: new Date().toISOString(),
				action: "apply",
				suggestionId: suggestion.id,
				targetPath: suggestion.targetPath,
				backupPath: result.backupPath ?? join(backupDir, `${suggestion.id}.bak`),
				diff: suggestion.diff,
				title: suggestion.title,
				commitSha: result.commitSha,
				metricsSnapshotDate: latestSnapshotDate,
			});
		} else {
			suggestion.status = "failed";
		}

		savePending(dirs.evolutionDir, pending);

		const status = result.success ? "Applied" : "Failed";
		return successResult(
			`${status} suggestion #${params.index}: ${suggestion.title}`,
			{
				action: "apply",
				index: params.index,
				suggestionId: suggestion.id,
				title: suggestion.title,
				success: result.success,
				reason: result.reason,
			},
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Unexpected error in /evolve-apply: ${msg}`);
	}
}

// ── handleEvolveStats ────────────────────────────────

/**
 * /evolve-stats handler:
 * 读取 daily/ 最近 7 天数据，聚合统计。
 */
export function handleEvolveStats(evolutionDir: string): CommandResult {
	try {
		const dailyDir = join(evolutionDir, "daily");
		if (!existsSync(dailyDir)) {
			return successResult("No usage data available yet.", {
				action: "stats",
				toolCalls: 0,
				tokenInput: 0,
				tokenOutput: 0,
				topSkills: [],
				topFailures: [],
			});
		}

		const cutoff = Date.now() - 7 * MS_PER_DAY;
		let toolCalls = 0;
		let tokenInput = 0;
		let tokenOutput = 0;
		const skillCounts: Record<string, number> = {};
		const toolFailures: Record<string, { calls: number; failures: number }> = {};

		for (const entry of readdirSync(dailyDir)) {
			if (!entry.endsWith(".json")) continue;
			const filePath = join(dailyDir, entry);

			// 检查文件日期
			const dateStr = entry.replace(".json", "");
			const fileDate = new Date(`${dateStr}T00:00:00Z`);
			if (Number.isNaN(fileDate.getTime()) || fileDate.getTime() < cutoff) continue;

			try {
				const raw = readFileSync(filePath, "utf-8");
				const day = JSON.parse(raw) as {
					toolCalls?: { total?: number; byTool?: Record<string, number>; failures?: Record<string, number> };
					tokenUsage?: { totalInput?: number; totalOutput?: number };
					skillTriggers?: Record<string, number>;
				};

				toolCalls += day.toolCalls?.total ?? 0;
				tokenInput += day.tokenUsage?.totalInput ?? 0;
				tokenOutput += day.tokenUsage?.totalOutput ?? 0;

				if (day.skillTriggers) {
					for (const [name, count] of Object.entries(day.skillTriggers)) {
						skillCounts[name] = (skillCounts[name] ?? 0) + count;
					}
				}

				if (day.toolCalls?.byTool) {
					for (const [tool, calls] of Object.entries(day.toolCalls.byTool)) {
						if (!toolFailures[tool]) toolFailures[tool] = { calls: 0, failures: 0 };
						toolFailures[tool].calls += calls;
					}
				}
				if (day.toolCalls?.failures) {
					for (const [tool, fails] of Object.entries(day.toolCalls.failures)) {
						if (!toolFailures[tool]) toolFailures[tool] = { calls: 0, failures: 0 };
						toolFailures[tool].failures += fails;
					}
				}
			} catch (err) {
				// 损坏文件跳过
				if (process.env.NODE_ENV !== "test") console.warn(`[evolve-stats] Failed to parse ${entry}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		// Top skills（按计数降序取前 5）
		const topSkills = Object.entries(skillCounts)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([name, count]) => ({ name, count }));

		// Top failures（按失败率降序取前 5，至少 3 次调用）
		const topFailures = Object.entries(toolFailures)
			.filter(([, v]) => v.calls >= 3)
			.sort((a, b) => (b[1].failures / b[1].calls) - (a[1].failures / a[1].calls))
			.slice(0, 5)
			.map(([tool, v]) => ({ tool, rate: v.failures / v.calls }));

		const stats: StatsData = {
			toolCalls,
			tokenInput,
			tokenOutput,
			topSkills,
			topFailures,
		};

		return successResult(
			`Stats: ${toolCalls} tool calls, ${tokenInput.toLocaleString()} tokens in`,
			{ action: "stats", ...stats },
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to read stats: ${msg}`);
	}
}

// ── handleEvolveRollback ─────────────────────────────

/**
 * /evolve-rollback handler:
 * 1. 加载历史
 * 2. 根据 index 选择记录
 * 3. 执行 rollback
 * 4. 记录到 history
 */
export async function handleEvolveRollback(
	index: number,
	dirs: Dirs,
): Promise<CommandResult> {
	try {
		const history = loadHistory(dirs.evolutionDir, 20);
		if (history.length === 0) {
			throw new Error("No evolution history to rollback.");
		}

		// index 是 1-based
		if (index < 1 || index > history.length) {
			throw new Error(`Invalid index: ${index}. Valid range: 1-${history.length}`);
		}

		// 只允许 rollback apply 类型的记录
		const entry = history[index - 1];
		if (!entry) {
			throw new Error(`No history entry at index ${index}.`);
		}

		if (entry.action !== "apply") {
			throw new Error(`Cannot rollback a "${entry.action}" action. Only "apply" actions can be rolled back.`);
		}

		const result = await rollbackSuggestion(entry);

		if (result.success) {
			// 记录 rollback 到 history
			appendHistory(dirs.evolutionDir, {
				timestamp: new Date().toISOString(),
				action: "rollback",
				suggestionId: entry.suggestionId,
				targetPath: entry.targetPath,
				backupPath: entry.backupPath,
				diff: entry.diff,
				title: entry.title,
			});

			return successResult(
				`Rolled back: ${entry.title}`,
				{
					action: "rollback",
					suggestionId: entry.suggestionId,
					targetPath: entry.targetPath,
				},
			);
		}

		throw new Error(`Rollback failed: ${result.reason ?? "unknown"}`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Unexpected error in /evolve-rollback: ${msg}`);
	}
}
