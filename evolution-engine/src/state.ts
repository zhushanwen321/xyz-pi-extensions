/**
 * Evolution Engine — 状态持久化
 *
 * 管理 suggestions/pending.json 和 history.jsonl。
 * 所有路径基于传入的 evolutionDir 参数，不硬编码。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingFile, HistoryEntry, MetricsSnapshot, EvolutionSuggestion } from "./types.js";

// ── 内部路径 ─────────────────────────────────────────

function suggestionsPath(dir: string): string {
	return join(dir, "suggestions", "pending.json");
}

function historyPath(dir: string): string {
	return join(dir, "history.jsonl");
}

function metricsHistoryPath(dir: string): string {
	return join(dir, "metrics-history.json");
}

// ── 公共 API ─────────────────────────────────────────

/**
 * 读取 pending.json。
 * 文件不存在或 JSON 损坏时返回 null。
 */
export function loadPending(dir: string): PendingFile | null {
	const filePath = suggestionsPath(dir);
	if (!existsSync(filePath)) return null;

	try {
		const raw = readFileSync(filePath, "utf-8");
		const pending = JSON.parse(raw) as PendingFile;

		// Migration: 旧格式有 diff 字段而无 instruction，自动迁移
		for (const sug of pending.suggestions) {
			if (!sug.instruction && (sug as unknown as Record<string, unknown>).diff) {
				sug.instruction = String((sug as unknown as Record<string, unknown>).diff);
				delete (sug as unknown as Record<string, unknown>).diff;
			}
		}

		return pending;
	} catch {
		return null;
	}
}

/**
 * 写入 pending.json。
 * 目录不存在时递归创建。
 */
export function savePending(dir: string, pending: PendingFile): void {
	const filePath = suggestionsPath(dir);
	const dirName = join(dir, "suggestions");

	if (!existsSync(dirName)) {
		mkdirSync(dirName, { recursive: true });
	}

	writeFileSync(filePath, JSON.stringify(pending, null, 2), "utf-8");
}

/**
 * 追加一条 JSON 行到 history.jsonl。
 * 文件不存在时创建。
 */
export function appendHistory(dir: string, entry: HistoryEntry): void {
	const filePath = historyPath(dir);

	appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * 读取 history.jsonl 最后 N 条记录。
 * 文件不存在返回空数组。
 */
// ── Metrics Snapshot 持久化 ─────────────────────────

/** metrics-history.json 的文件结构 */
interface MetricsHistoryFile {
	snapshots: MetricsSnapshot[];
}

const MAX_METRICS_SNAPSHOTS = 30;

/**
 * 读取 metrics 历史。文件不存在或损坏时返回空数组。
 */
export function loadMetricsHistory(dir: string): MetricsSnapshot[] {
	const filePath = metricsHistoryPath(dir);
	if (!existsSync(filePath)) return [];

	try {
		const raw = readFileSync(filePath, "utf-8");
		const data = JSON.parse(raw) as MetricsHistoryFile;
		return Array.isArray(data.snapshots) ? data.snapshots : [];
	} catch {
		return [];
	}
}

/**
 * 追加一条 snapshot，滑动窗口保留最近 30 条。
 */
export function saveMetricsSnapshot(dir: string, snapshot: MetricsSnapshot): void {
	const history = loadMetricsHistory(dir);
	history.push(snapshot);

	// 滑动窗口：超出上限时删除最老的
	if (history.length > MAX_METRICS_SNAPSHOTS) {
		history.splice(0, history.length - MAX_METRICS_SNAPSHOTS);
	}

	const filePath = metricsHistoryPath(dir);
	writeFileSync(
		filePath,
		JSON.stringify({ snapshots: history }, null, 2),
		"utf-8",
	);
}

// ── History JSONL ────────────────────────────────────

// ── Daily Report 状态 ──────────────────────────────

/** pending.json 中 pending 状态建议的最大数量 */
const MAX_PENDING_SUGGESTIONS = 30;

/**
 * 增量合并新建议到 pending.json。
 * - title 精确匹配去重：已有 pending 建议的 title 与新建议相同时跳过
 * - 容量保护：pending 状态的建议不超过 MAX_PENDING_SUGGESTIONS 条
 * - 无现有文件时创建新 PendingFile
 */
export function mergePending(dir: string, newSuggestions: EvolutionSuggestion[]): void {
	if (newSuggestions.length === 0) return;

	const existing = loadPending(dir);
	if (!existing) {
		const pending: PendingFile = {
			generatedAt: new Date().toISOString(),
			reportUsed: "daily-report",
			suggestions: newSuggestions,
		};
		savePending(dir, pending);
		return;
	}

	// title 去重：跳过与已有 pending 建议同名的
	const pendingTitles = new Set(
		existing.suggestions
			.filter(s => s.status === "pending")
			.map(s => s.title),
	);
	const unique = newSuggestions.filter(s => !pendingTitles.has(s.title));

	if (unique.length > 0) {
		existing.suggestions.push(...unique);
	}

	// 容量保护：超出时按数组顺序驱逐最早的 pending（先入先出）
	const pendingCount = existing.suggestions.filter(s => s.status === "pending").length;
	if (pendingCount > MAX_PENDING_SUGGESTIONS) {
		const overflow = pendingCount - MAX_PENDING_SUGGESTIONS;
		let evicted = 0;
		for (const sug of existing.suggestions) {
			if (sug.status === "pending" && evicted < overflow) {
				sug.status = "rejected";
				evicted++;
			}
		}
		console.warn(
			`[evolve] Auto-evicted ${evicted} pending suggestion(s) to maintain capacity cap of ${MAX_PENDING_SUGGESTIONS}`,
		);
	}

	savePending(dir, existing);
}

/**
 * 写入每日运行状态文件，供诊断。
 * 文件路径: {dailyReportsDir}/.last-run-status
 */
export function saveLastRunStatus(
	dailyReportsDir: string,
	status: "success" | "failed",
	errorSummary?: string,
): void {
	const filePath = join(dailyReportsDir, ".last-run-status");
	const data = {
		status,
		timestamp: new Date().toISOString(),
		...(errorSummary ? { errorSummary } : {}),
	};
	writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ── History JSONL ────────────────────────────────────

export function loadHistory(dir: string, limit: number = 10): HistoryEntry[] {
	const filePath = historyPath(dir);
	if (!existsSync(filePath)) return [];

	try {
		const raw = readFileSync(filePath, "utf-8").trim();
		if (raw.length === 0) return [];

		const lines = raw.split("\n");
		const tail = lines.slice(-limit);

		const entries: HistoryEntry[] = [];
		for (const line of tail) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			try {
				const entry = JSON.parse(trimmed) as HistoryEntry;
				// Migration: 旧格式有 diff 字段而无 instruction
				if (!entry.instruction && (entry as unknown as Record<string, unknown>).diff) {
					entry.instruction = String((entry as unknown as Record<string, unknown>).diff);
					delete (entry as unknown as Record<string, unknown>).diff;
				}
				entries.push(entry);
			} catch {
				// 损坏行跳过
			}
		}
		return entries;
	} catch {
		return [];
	}
}
