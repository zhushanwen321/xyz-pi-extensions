/**
 * Evolution data persistence module.
 *
 * 目录结构:
 *   ~/.pi/agent/evolution-data/
 *   ├── daily/          # 每日汇总 JSON
 *   ├── tool-stats.json # 工具执行累积统计
 *   ├── skill-triggers.json # Skill 触发累积统计
 *   └── session-manifest.json # Session 清单
 *
 * 写入策略：内存 buffer 累积 → session 结束时 flush
 * （每日汇总在每日切换时重写，采用 read-merge-write 模式）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
	type DailySummary,
	type SessionManifest,
	type SessionManifestEntry,
	type SkillTriggerStats,
	type ToolStats,
	emptyDailySummary,
	emptySessionManifest,
	emptySkillTriggerStats,
	emptyToolStats,
} from "./types.js";

// ── 常量 ────────────────────────────────────────────

const EVOLUTION_DIR = join(homedir(), ".pi", "agent", "evolution-data");
const DAILY_DIR = join(EVOLUTION_DIR, "daily");
const TOOL_STATS_FILE = join(EVOLUTION_DIR, "tool-stats.json");
const SKILL_TRIGGERS_FILE = join(EVOLUTION_DIR, "skill-triggers.json");
const SESSION_MANIFEST_FILE = join(EVOLUTION_DIR, "session-manifest.json");

const JSON_INDENT = 2;

// ── 目录初始化 ──────────────────────────────────────

function ensureDir(path: string): void {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true });
	}
}

export function ensureEvolutionDirs(): void {
	ensureDir(EVOLUTION_DIR);
	ensureDir(DAILY_DIR);
}

// ── 通用 read-before-write ──────────────────────────

function readJSON<T>(filePath: string, fallback: () => T): T {
	try {
		if (!existsSync(filePath)) return fallback();
		const raw = readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as T;
	} catch {
		return fallback();
	}
}

function writeJSON<T>(filePath: string, data: T): void {
	ensureDir(dirname(filePath));
	writeFileSync(filePath, JSON.stringify(data, null, JSON_INDENT), "utf-8");
}

// ── 每日汇总 ─────────────────────────────────────────

function dailyFilePath(date: string): string {
	return join(DAILY_DIR, `${date}.json`);
}

/** 读取或创建今日汇总 */
export function readDailySummary(date: string): DailySummary {
	return readJSON(dailyFilePath(date), () => emptyDailySummary(date));
}

/** 写入每日汇总（全量覆盖） */
export function writeDailySummary(summary: DailySummary): void {
	writeJSON(dailyFilePath(summary.date), summary);
}

// ── 工具统计 ─────────────────────────────────────────

/** 更新工具执行计数（累积） */
export function updateToolStats(
	toolName: string,
	success: boolean,
): void {
	const stats = readJSON(TOOL_STATS_FILE, emptyToolStats);

	if (!stats.byTool[toolName]) {
		stats.byTool[toolName] = { calls: 0, failures: 0 };
	}
	stats.byTool[toolName].calls += 1;
	if (!success) {
		stats.byTool[toolName].failures += 1;
	}
	stats.updatedAt = new Date().toISOString();

	writeJSON(TOOL_STATS_FILE, stats);
}

// ── Skill 触发统计 ───────────────────────────────────

/** 更新 skill 触发计数（累积） */
export function updateSkillTrigger(skillName: string): void {
	const stats = readJSON(SKILL_TRIGGERS_FILE, emptySkillTriggerStats);

	if (!stats.bySkill[skillName]) {
		stats.bySkill[skillName] = { triggers: 0, lastTriggered: "" };
	}
	stats.bySkill[skillName].triggers += 1;
	stats.bySkill[skillName].lastTriggered = new Date().toISOString();
	stats.updatedAt = new Date().toISOString();

	writeJSON(SKILL_TRIGGERS_FILE, stats);
}

// ── Session 清单 ─────────────────────────────────────

/** 记录 session 启动 */
export function recordSessionStart(sessionId: string, cwd: string): void {
	const manifest = readJSON(SESSION_MANIFEST_FILE, emptySessionManifest);

	const entry: SessionManifestEntry = {
		sessionId,
		cwd,
		startTime: new Date().toISOString(),
		turns: 0,
		totalTokens: 0,
	};
	manifest.entries.push(entry);
	manifest.updatedAt = new Date().toISOString();

	writeJSON(SESSION_MANIFEST_FILE, manifest);
}

/** 更新 session 的最终状态 */
export function updateSessionEnd(sessionId: string, turns: number, totalTokens: number): void {
	const manifest = readJSON(SESSION_MANIFEST_FILE, emptySessionManifest);

	const entry = manifest.entries.find((e) => e.sessionId === sessionId);
	if (!entry) return;

	entry.endTime = new Date().toISOString();
	entry.turns = turns;
	entry.totalTokens = totalTokens;
	manifest.updatedAt = new Date().toISOString();

	writeJSON(SESSION_MANIFEST_FILE, manifest);
}
