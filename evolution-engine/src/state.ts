/**
 * Evolution Engine — 状态持久化
 *
 * 管理 suggestions/pending.json 和 history.jsonl。
 * 所有路径基于传入的 evolutionDir 参数，不硬编码。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingFile, HistoryEntry } from "./types.js";

// ── 内部路径 ─────────────────────────────────────────

function suggestionsPath(dir: string): string {
	return join(dir, "suggestions", "pending.json");
}

function historyPath(dir: string): string {
	return join(dir, "history.jsonl");
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
		return JSON.parse(raw) as PendingFile;
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
				entries.push(JSON.parse(trimmed) as HistoryEntry);
			} catch {
				// 损坏行跳过
			}
		}
		return entries;
	} catch {
		return [];
	}
}
