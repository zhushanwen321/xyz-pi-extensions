/**
 * Evolution Engine — 数据垃圾回收
 *
 * 清理过期的 reports、signals、daily 数据文件，防止磁盘无限膨胀。
 * 由 /evolve 命令在每次运行后自动调用。
 */

import { existsSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";

// ── GC 策略常量 ──────────────────────────────────────

/** reports/*.json 保留最新 N 个 */
const MAX_REPORTS = 3;

/** signals/*.json 保留最新 N 个 */
const MAX_SIGNALS = 30;

/** daily/*.json 保留天数 */
const MAX_DAILY_DAYS = 90;

// ── 辅助函数 ─────────────────────────────────────────

/** 安全地按修改时间降序排列目录中的 .json 文件 */
function listJsonByMtime(dir: string): string[] {
	if (!existsSync(dir)) return [];

	try {
		const entries = readdirSync(dir);
		return entries
			.filter(name => name.endsWith(".json"))
			.map(name => ({
				name,
				path: join(dir, name),
				mtime: statSync(join(dir, name)).mtimeMs,
			}))
			.sort((a, b) => b.mtime - a.mtime)
			.map(e => e.path);
	} catch {
		return [];
	}
}

/** 删除指定文件路径列表 */
function removeFiles(paths: string[]): number {
	let removed = 0;
	for (const p of paths) {
		try {
			unlinkSync(p);
			removed++;
		} catch {
			// 权限或并发删除导致失败，静默跳过
		}
	}
	return removed;
}

/** 从 daily 文件名提取日期并过滤超过 N 天的 */
function listExpiredDaily(dir: string, maxDays: number): string[] {
	if (!existsSync(dir)) return [];

	const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;

	try {
		const entries = readdirSync(dir);
		const expired: string[] = [];

		for (const name of entries) {
			if (!name.endsWith(".json")) continue;

			// daily 文件名格式: 2026-05-27.json
			const dateStr = name.replace(".json", "");
			const fileTime = new Date(dateStr).getTime();

			// 文件名无法解析为日期时，用 mtime 兜底
			const effectiveTime = Number.isNaN(fileTime)
				? statSync(join(dir, name)).mtimeMs
				: fileTime;

			if (effectiveTime < cutoff) {
				expired.push(join(dir, name));
			}
		}

		return expired;
	} catch {
		return [];
	}
}

// ── 公共 API ─────────────────────────────────────────

/** GC 清理结果 */
export interface GcResult {
	reportsRemoved: number;
	signalsRemoved: number;
	dailyRemoved: number;
}

/**
 * 执行数据垃圾回收。
 * 目录不存在时静默跳过，不报错。
 */
export function runGc(evolutionDir: string): GcResult {
	const reportsDir = join(evolutionDir, "reports");
	const signalsDir = join(evolutionDir, "signals");
	const dailyDir = join(evolutionDir, "daily");

	// reports: 保留最新 MAX_REPORTS 个
	const reportFiles = listJsonByMtime(reportsDir);
	const reportsToRemove = reportFiles.slice(MAX_REPORTS);
	const reportsRemoved = removeFiles(reportsToRemove);

	// signals: 保留最新 MAX_SIGNALS 个
	const signalFiles = listJsonByMtime(signalsDir);
	const signalsToRemove = signalFiles.slice(MAX_SIGNALS);
	const signalsRemoved = removeFiles(signalsToRemove);

	// daily: 保留 MAX_DAILY_DAYS 天内
	const expiredDaily = listExpiredDaily(dailyDir, MAX_DAILY_DAYS);
	const dailyRemoved = removeFiles(expiredDaily);

	return { reportsRemoved, signalsRemoved, dailyRemoved };
}
