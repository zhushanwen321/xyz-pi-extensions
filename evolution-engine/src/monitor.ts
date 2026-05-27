/**
 * Evolution Engine — 自动触发规则监控
 *
 * 监控 usage 数据，检测 token 效率下降、skill 沉睡、错误率突升，
 * 产出自触发 flag 文件供主循环消费。
 */
import fs from "node:fs";
import path from "node:path";
import type { AutoTriggerFlag } from "./types";
import { createLogger } from "../../shared/logger.js";
const log = createLogger("evolution-monitor");

// ── 常量 ─────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;
/** 滑动窗口：读取最近多少天的 daily 文件 */
const DAILY_WINDOW = 14;
/** token-decline 前半窗口 */
const DECLINE_BASELINE_DAYS = 7;
/** token-decline 近期窗口 */
const DECLINE_RECENT_DAYS = 3;
/** skill-dormant 阈值 */
const DORMANT_THRESHOLD_DAYS = 30;
/** error-spike 近期窗口 */
const ERROR_SPIKE_RECENT_DAYS = 3;
/** error-spike 基线窗口 */
const ERROR_SPIKE_BASELINE_DAYS = 30;
/** error-spike 相对增长率阈值 */
const ERROR_SPIKE_RATE = 0.5;
/** flag 有效期：同规则多久内不重复触发 */
const FLAG_COOLDOWN_MS = MS_PER_DAY;
/** flag 过期清理阈值 */
const FLAG_EXPIRY_MS = 7 * MS_PER_DAY;

const FLAGS_DIR = "auto-trigger.flags";

// ── 类型 ─────────────────────────────────────────────

/** daily/YYYY-MM-DD.json 的结构 */
interface DailyFile {
	date: string;
	sessions: number;
	toolCalls: {
		total: number;
		byTool: Record<string, number>;
		failures: Record<string, number>;
		editRetries: number;
	};
	tokenUsage: {
		totalInput: number;
		totalOutput: number;
		turns: number;
	};
	skillTriggers: Record<string, unknown>;
	agentCalls: Record<string, unknown>;
}

/** skill-triggers.json 的条目 */
interface SkillTriggerEntry {
	count: number;
	lastTriggered: string;
}

type RuleName = AutoTriggerFlag["rule"];

// ── 工具函数 ─────────────────────────────────────────

function ensureDir(dir: string): void {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function readJsonSafe<T>(filePath: string): T | undefined {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

function flagFilePath(flagsDir: string, rule: RuleName): string {
	return path.join(flagsDir, `${rule}.json`);
}

function readFlag(flagsDir: string, rule: RuleName): AutoTriggerFlag | undefined {
	return readJsonSafe<AutoTriggerFlag>(flagFilePath(flagsDir, rule));
}

function writeFlag(flagsDir: string, flag: AutoTriggerFlag): void {
	ensureDir(flagsDir);
	fs.writeFileSync(flagFilePath(flagsDir, flag.rule), JSON.stringify(flag, null, 2), "utf-8");
}

function removeFlag(flagsDir: string, rule: RuleName): void {
	const fp = flagFilePath(flagsDir, rule);
	try {
		fs.unlinkSync(fp);
	} catch {
		// 文件不存在，忽略
	}
}

function listFlagFiles(flagsDir: string): string[] {
	try {
		return fs.readdirSync(flagsDir).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
}

function parseDateFromFilename(filename: string): Date | undefined {
	const base = filename.replace(/\.json$/, "");
	const d = new Date(`${base}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return undefined;
	return d;
}

/** 从 now 往回取 N 天的 daily 文件，按日期升序排列 */
function loadRecentDaily(dailyDir: string, now: Date, days: number): DailyFile[] {
	if (!fs.existsSync(dailyDir)) return [];

	const cutoff = new Date(now.getTime() - days * MS_PER_DAY);
	const files: DailyFile[] = [];

	for (const entry of fs.readdirSync(dailyDir)) {
		if (!entry.endsWith(".json")) continue;
		const d = parseDateFromFilename(entry);
		if (!d || d < cutoff || d > now) continue;
		const data = readJsonSafe<DailyFile>(path.join(dailyDir, entry));
		if (data) files.push(data);
	}

	files.sort((a, b) => a.date.localeCompare(b.date));
	return files;
}

/** 从 daily 数组中取最后 N 条的切片 */
function tailN<T>(arr: T[], n: number): T[] {
	if (arr.length <= n) return arr;
	return arr.slice(arr.length - n);
}

/** 从 daily 数组中取倒数 [end-N, end) 的切片 */
function sliceBeforeLast<T>(arr: T[], totalLast: number, sliceLen: number): T[] {
	if (arr.length <= totalLast) return [];
	const start = arr.length - totalLast;
	const end = start + sliceLen;
	return arr.slice(start, end);
}

// ── 规则检查 ─────────────────────────────────────────

function checkTokenDecline(daily: DailyFile[]): { hit: boolean; detail: string } {
	// baseline: 前 7 天（day 0-6），不与 recent（最后 3 天）重叠
	const baseline = daily.slice(0, DECLINE_BASELINE_DAYS);
	const recent = tailN(daily, DECLINE_RECENT_DAYS);

	if (baseline.length === 0) return { hit: false, detail: "" };

	const baselineSessions = baseline.reduce((s, d) => s + d.sessions, 0);
	if (baselineSessions === 0) return { hit: false, detail: "" };

	const baselineAvg =
		baseline.reduce((s, d) => s + d.tokenUsage.totalInput, 0) / baselineSessions;

	// 逐天检查：最近 3 天每一天的 token/session 都 > baseline
	const perDayTokens: number[] = [];
	for (const day of recent) {
		if (day.sessions === 0) return { hit: false, detail: "" };
		const dayAvg = day.tokenUsage.totalInput / day.sessions;
		perDayTokens.push(Math.round(dayAvg));
		if (dayAvg <= baselineAvg) return { hit: false, detail: "" };
	}

	if (perDayTokens.length === 0) return { hit: false, detail: "" };

	const detail = `Token per session above baseline for ${perDayTokens.length} consecutive days: ${perDayTokens.join(", ")} (baseline: ${Math.round(baselineAvg)})`;
	return { hit: true, detail };
}

function checkSkillDormant(
	evolutionDir: string,
	now: Date
): { hit: boolean; detail: string } {
	const triggersPath = path.join(evolutionDir, "skill-triggers.json");
	const triggers = readJsonSafe<Record<string, SkillTriggerEntry>>(triggersPath);
	if (!triggers) return { hit: false, detail: "" };

	const dormantThreshold = now.getTime() - DORMANT_THRESHOLD_DAYS * MS_PER_DAY;
	const dormant: string[] = [];

	for (const [name, entry] of Object.entries(triggers)) {
		const lastTime = new Date(entry.lastTriggered).getTime();
		if (Number.isNaN(lastTime)) continue;
		if (lastTime < dormantThreshold) {
			dormant.push(name);
		}
	}

	if (dormant.length === 0) return { hit: false, detail: "" };

	return {
		hit: true,
		detail: `Skills dormant >${DORMANT_THRESHOLD_DAYS}d: ${dormant.join(", ")}`,
	};
}

function checkErrorSpike(daily: DailyFile[]): { hit: boolean; detail: string } {
	const recent = tailN(daily, ERROR_SPIKE_RECENT_DAYS);

	// baseline: 所有数据中排除最近 3 天的部分（避免与 recent 重叠）
	const baseline = daily.slice(0, Math.max(0, daily.length - ERROR_SPIKE_RECENT_DAYS));

	const baselineTotal = baseline.reduce((s, d) => s + d.toolCalls.total, 0);
	if (baselineTotal === 0) return { hit: false, detail: "" };

	const baselineFailures = baseline.reduce(
		(s, d) => s + Object.values(d.toolCalls.failures).reduce((sum, v) => sum + v, 0),
		0,
	);
	const baselineRate = baselineFailures / baselineTotal;

	const recentTotal = recent.reduce((s, d) => s + d.toolCalls.total, 0);
	const recentFailures = recent.reduce(
		(s, d) => s + Object.values(d.toolCalls.failures).reduce((sum, v) => sum + v, 0),
		0,
	);

	if (recentTotal === 0) return { hit: false, detail: "" };

	const recentRate = recentFailures / recentTotal;

	// 避免 baselineRate 为 0 时除零
	if (baselineRate === 0) {
		// 基线无错误，任何错误都是突升
		if (recentFailures > 0) {
			return {
				hit: true,
				detail: `Error rate: ${(recentRate * 100).toFixed(1)}% (last ${ERROR_SPIKE_RECENT_DAYS}d) vs 0.0% (baseline)`,
			};
		}
		return { hit: false, detail: "" };
	}

	const relativeIncrease = (recentRate - baselineRate) / baselineRate;
	if (relativeIncrease > ERROR_SPIKE_RATE) {
		return {
			hit: true,
			detail: `Error rate: ${(recentRate * 100).toFixed(1)}% (last ${ERROR_SPIKE_RECENT_DAYS}d) vs ${(baselineRate * 100).toFixed(1)}% (baseline)`,
		};
	}

	return { hit: false, detail: "" };
}

// ── 导出函数 ─────────────────────────────────────────

/**
 * 检查所有自动触发规则，管理 flag 文件，返回当前有效 flags。
 */
export function checkAutoTriggerRules(evolutionDir: string): AutoTriggerFlag[] {
	const now = new Date();
	const dailyDir = path.join(evolutionDir, "daily");
	const flagsDir = path.join(evolutionDir, FLAGS_DIR);
	const daily = loadRecentDaily(dailyDir, now, DAILY_WINDOW);
	log.info(`Auto-trigger check: ${daily.length} daily files loaded`);

	const rules: Array<{ name: RuleName; result: { hit: boolean; detail: string } }> = [
		{ name: "token-decline", result: checkTokenDecline(daily) },
		{ name: "skill-dormant", result: checkSkillDormant(evolutionDir, now) },
		{ name: "error-spike", result: checkErrorSpike(daily) },
	];

	for (const { name, result } of rules) {
		if (result.hit) {
			log.info(`Rule "${name}" triggered: ${result.detail}`);
			const existing = readFlag(flagsDir, name);
			// 已有 flag 且在 24h 冷却期内，跳过
			if (existing) {
				const age = now.getTime() - new Date(existing.triggeredAt).getTime();
				if (age < FLAG_COOLDOWN_MS) continue;
			}
			// 写入新 flag
			const flag: AutoTriggerFlag = {
				rule: name,
				triggeredAt: now.toISOString(),
				detail: result.detail,
			};
			writeFlag(flagsDir, flag);
		} else {
			// 条件不再满足，删除 flag
			removeFlag(flagsDir, name);
		}
	}

	// 收集所有当前有效 flags
	const flags: AutoTriggerFlag[] = [];
	for (const { name } of rules) {
		const flag = readFlag(flagsDir, name);
		if (flag) flags.push(flag);
	}

	return flags;
}

/**
 * 清理过期 flag 文件（> 7 天）。
 */
export function cleanExpiredFlags(evolutionDir: string): void {
	const flagsDir = path.join(evolutionDir, FLAGS_DIR);
	const files = listFlagFiles(flagsDir);
	if (files.length === 0) return;

	const cutoff = Date.now() - FLAG_EXPIRY_MS;

	for (const file of files) {
		const flag = readJsonSafe<AutoTriggerFlag>(path.join(flagsDir, file));
		if (!flag) continue;
		const triggeredMs = new Date(flag.triggeredAt).getTime();
		if (Number.isNaN(triggeredMs)) continue;
		if (triggeredMs < cutoff) {
			try {
				fs.unlinkSync(path.join(flagsDir, file));
			} catch {
				// 竞争条件，忽略
			}
		}
	}
}
