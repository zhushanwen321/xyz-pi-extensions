/**
 * Evolution Engine — 每日自动分析触发器
 *
 * 在 session_start 中异步触发，每天最多运行一次完整的分析流程。
 * Fire-and-forget：不阻塞 session 初始化。
 *
 * 流程：检查报告 → 获取锁 → 运行 analyzer → summarizer → Judge
 *       → 生成 Markdown 报告 → 合并 pending → 释放锁
 */

import {
	existsSync,
	writeFileSync,
	readFileSync,
	unlinkSync,
	statSync,
	renameSync,
	mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

import type { Dirs, JudgeInput, EvolutionSuggestion } from "./types";
import {
	mergePending,
	saveLastRunStatus,
	loadMetricsHistory,
	loadHistory,
} from "./state";
import { generateDailyReport } from "./report-generator";
import { summarizeReport } from "./summarizer.js";
import { buildEffectReview } from "./effect-tracker.js";
import { runJudge } from "./judge";
import { runGc } from "./gc.js";

// ── 常量 ─────────────────────────────────────────────

/** analyzer 脚本执行超时 */
const ANALYZER_TIMEOUT_MS = 60_000;

const ANALYZER_SCRIPT = join(
	homedir(),
	".pi/agent/scripts/pi-session-analyzer/analyze.py",
);

// ── Lock 管理 ────────────────────────────────────────

interface LockData {
	pid: number;
	timestamp: string;
}

/**
 * 尝试获取锁文件。
 * - 已有锁但 PID 已死 → 清理 stale lock，获取新锁
 * - 已有锁且 PID 存活 → 返回 false
 * - 无锁文件 → 创建并返回 true
 *
 * 注意：existsSync → writeFileSync 存在理论上的 TOCTOU 竞态窗口，
 * 但 Pi 多 session 并发不常见，实际风险可接受。
 */
function acquireLock(lockPath: string): boolean {
	if (existsSync(lockPath)) {
		try {
			const raw = readFileSync(lockPath, "utf-8");
			const lock = JSON.parse(raw) as LockData;

			// 检查 PID 是否仍然存活
			// process.kill(pid, 0) 不发送信号，只检查进程存在性
			try {
				process.kill(lock.pid, 0);
				// PID 仍然存活 → 另一个进程在运行
				return false;
			} catch {
				// PID 已死 → stale lock，清理
				unlinkSync(lockPath);
			}
		} catch {
			// 锁文件损坏 → 清理
			unlinkSync(lockPath);
		}
	}

	// 创建新锁
	const data: LockData = { pid: process.pid, timestamp: new Date().toISOString() };
	writeFileSync(lockPath, JSON.stringify(data, null, 2), "utf-8");
	return true;
}

/** 释放锁文件 */
function releaseLock(lockPath: string): void {
	try {
		unlinkSync(lockPath);
	} catch {
		// 锁文件可能已被其他进程清理
	}
}

// ── Pipeline 步骤 ────────────────────────────────────

/** 运行 Python analyzer 生成原始报告 */
function runAnalyzer(outputPath: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		if (!existsSync(ANALYZER_SCRIPT)) {
			reject(new Error(`Session analyzer not found at ${ANALYZER_SCRIPT}`));
			return;
		}

		execFile(
			"python3",
			[ANALYZER_SCRIPT, "--since", "1d", "--format", "json", "--output", outputPath],
			{ timeout: ANALYZER_TIMEOUT_MS },
			(err: Error | null) => {
				if (err) {
					reject(err);
				} else {
					resolve(outputPath);
				}
			},
		);
	});
}

/**
 * 执行完整分析 pipeline（analyzer → summarizer → judge）。
 * 调用方负责 lock 管理。
 */
async function executePipeline(
	dirs: Dirs,
	today: string,
	reportPath: string,
): Promise<void> {
	// 确保 tmp 目录存在
	if (!existsSync(dirs.tmpDir)) {
		mkdirSync(dirs.tmpDir, { recursive: true });
	}

	// 1. 运行 analyzer
	const tmpReportPath = join(dirs.tmpDir, `daily-raw-${today}.json`);
	await runAnalyzer(tmpReportPath);

	// 2. 读取原始报告
	const rawReport = readFileSync(tmpReportPath, "utf-8");
	const report = JSON.parse(rawReport) as Record<string, unknown>;

	// 3. Summarizer pipeline
	const metricsHistory = loadMetricsHistory(dirs.evolutionDir);
	const signalReport = summarizeReport(
		report,
		metricsHistory,
		dirs.evolutionDir,
		tmpReportPath,
	);
	metricsHistory.push(signalReport.metricsSnapshot);

	// 3b. Effect review
	const recentHistory = loadHistory(dirs.evolutionDir, 30);
	const effectReview = buildEffectReview(recentHistory, metricsHistory);
	if (effectReview.length > 0) {
		signalReport.effectReview = effectReview;
		// 写回信号文件，确保 Judge 从文件读取时也能看到 effectReview
		const effectSignalPath = join(
			dirs.signalsDir,
			`signal-${signalReport.metricsSnapshot.date}.json`,
		);
		writeFileSync(effectSignalPath, JSON.stringify(signalReport, null, 2), "utf-8");
	}

	// 4. 运行 LLM Judge（在 GC 之前，避免新信号文件被删除）
	const signalPath = join(
		dirs.signalsDir,
		`signal-${signalReport.metricsSnapshot.date}.json`,
	);
	const judgeInput: JudgeInput = {
		target: "all",
		reportPath: signalPath,
		promptFilePath: "",
	};

	let suggestions: EvolutionSuggestion[];
	try {
		suggestions = await runJudge(judgeInput, dirs.templateDir);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`LLM Judge failed: ${msg}`);
	}

	// 5. GC（在 Judge 成功后执行，避免误删）
	runGc(dirs.evolutionDir);

	// 6. 生成 Markdown 报告 + 原子写入
	const markdown = generateDailyReport(signalReport, suggestions, effectReview);
	const tmpReport = `${reportPath}.tmp`;
	writeFileSync(tmpReport, markdown, "utf-8");
	renameSync(tmpReport, reportPath);

	// 7. 合并建议到 pending.json
	mergePending(dirs.evolutionDir, suggestions);

	// 8. 记录成功状态
	saveLastRunStatus(dirs.dailyReportsDir, "success");

	// 9. 清理临时原始报告
	try {
		unlinkSync(tmpReportPath);
	} catch {
		// 临时文件清理失败不影响主流程
	}
}

// ── 公共 API ─────────────────────────────────────────

/**
 * 每日自动分析入口。
 * 在 session_start 中调用，fire-and-forget。
 * 同一天只运行一次（通过文件存在性判断）。
 */
export async function checkAndRunDailyAnalysis(dirs: Dirs): Promise<void> {
	const today = new Date().toISOString().slice(0, 10);
	const reportPath = join(dirs.dailyReportsDir, `${today}.md`);

	// AC-2: 同一天不重复生成
	if (existsSync(reportPath) && statSync(reportPath).size > 0) {
		return;
	}

	// 获取锁
	const lockPath = join(dirs.dailyReportsDir, ".daily-report.lock");
	if (!acquireLock(lockPath)) {
		return;
	}

	try {
		await executePipeline(dirs, today, reportPath);
	} catch (err) {
		// AC-8: 失败不阻塞
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[evolve] Daily analysis failed: ${msg}`);
		saveLastRunStatus(dirs.dailyReportsDir, "failed", msg);
	} finally {
		releaseLock(lockPath);
	}
}
