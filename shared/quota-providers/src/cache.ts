/**
 * Statusline 数据缓存层
 *
 * 架构（重构后）：
 *   - 各 provider 单独实现在 providers/*.ts，通过 PROVIDERS 注册表管理
 *   - cache.ts 只负责：TTL 缓存、并发控制、Promise.allSettled 拉取、磁盘持久化
 *   - 新增 provider：实现 QuotaProvider 接口 → 在 PROVIDERS 注册（零改动 cache.ts）
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@mariozechner/pi-coding-agent";

import { getCachePath, getSpeedDir } from "./paths.js";
// 架构修复：doUpdate 用 buildRuntimeProviders() 替代静态 PROVIDERS，
// 使 providers.json 中 enabled=false 的 provider 不会被 fetch。
// registry.ts 内部 import PROVIDERS，此处不直接引用。
import { buildRuntimeProviders } from "./registry.js";
import { avgSpeed, type SpeedRecord } from "./speed.js";
import { MIN_PER_HOUR, MS_PER_SEC, SEC_PER_DAY, SEC_PER_MIN } from "./time.js";

const DAY_MS = SEC_PER_DAY * MS_PER_SEC;

// ── 缓存 / 统计常量 ─────────────────────────────────────

/** 套餐用量刷新间隔（2 分钟） */
const TTL_MINUTES = 2;
const CACHE_TTL_MS = TTL_MINUTES * MIN_PER_HOUR * SEC_PER_MIN * MS_PER_SEC;
/** cache JSON 写入的 pretty-print indent */
const JSON_INDENT = 2;
/** token 速度统计保留天数 */
const SPEED_RETENTION_DAYS = 30;
/** token 速度统计窗口（最近 7 天） */
const SPEED_D7_DAYS = 7;
/** ISO date 字符串长度（YYYY-MM-DD） */
const DATE_STR_LEN = 10;
/** 每日记录的最小元组长度 */
const RECORD_MIN_FIELDS = 2;

// ── Paths ──────────────────────────────────────────────

const PI_DIR = getAgentDir();
const CACHE_PATH = getCachePath();
const SPEED_DIR = getSpeedDir();

// ── CacheData（动态 schema，无需手动维护字段）───────
// provider 数据以 provider.id 为 key 存储，类型安全由 provider normalize 保证。
export interface CacheData {
	updatedAt: number;
	[providerId: string]: unknown;
}

const EMPTY_CACHE: CacheData = { updatedAt: 0 };

export interface SpeedData {
	current: number;
	day: number;
	d7: number;
	d30: number;
}

/** 缓存命中率数据 */
export interface CacheRatioData {
	/** 当前请求命中率 (0~100)，无缓存信息时为 null */
	current: number | null;
	/** 当天加权平均命中率 (0~100)，无数据时为 null */
	day: number | null;
}

// ── Cache 公共 API ─────────────────────────────────────

export function readCache(): CacheData {
	const cached = readCacheSync();
	if (Date.now() - cached.updatedAt > CACHE_TTL_MS) triggerUpdate();
	return cached;
}

let updating = false;
let lastUpdateAt = 0; // 上次实际发起网络请求的时间

export function triggerUpdate(): void {
	if (updating) return;
	if (Date.now() - lastUpdateAt < CACHE_TTL_MS) return;
	updating = true;
	lastUpdateAt = Date.now();
	doUpdate()
		.finally(() => {
			updating = false;
		})
		.catch((e) => {
			console.warn("[statusline] doUpdate failed:", e);
		});
}

async function doUpdate(): Promise<void> {
	const old = readCacheSync();
	const providers = buildRuntimeProviders();
	const results = await Promise.allSettled(providers.map((p) => p.fetch()));

	const cache: Record<string, unknown> = { updatedAt: Date.now() };
	for (let i = 0; i < providers.length; i++) {
		const p = providers[i]!;
		const r = results[i]!;
		const oldVal = (old as Record<string, unknown>)[p.id] ?? null;
		if (r.status === "rejected") {
			// 记录到 stderr 方便排查，不持久化
			console.error(`[statusline] ${p.id} fetch failed:`, r.reason?.message ?? r.reason);
		}
		cache[p.id] =
			r.status === "fulfilled" && r.value !== null ? r.value : oldVal;
	}

	// 原子写入：先写临时文件再 rename，防止半写损坏
	try {
		mkdirSync(PI_DIR, { recursive: true });
		const tmpPath = `${CACHE_PATH}.tmp`;
		writeFileSync(tmpPath, JSON.stringify(cache, null, JSON_INDENT), "utf-8");
		renameSync(tmpPath, CACHE_PATH);
	// eslint-disable-next-line taste/no-silent-catch -- 磁盘写失败属于容错路径：保留旧缓存，下次 triggerUpdate 会重试
	} catch (e) {
		console.warn(`[statusline] cache write failed (keeping old):`, e);
	}
}

function readCacheSync(): CacheData {
	try {
		const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
		if (typeof parsed !== "object" || parsed === null) return { ...EMPTY_CACHE };
		// 确保 updatedAt 存在，其余字段原样保留（由 provider 动态管理）
		return { ...parsed, updatedAt: parsed.updatedAt ?? 0 };
	} catch (e) {
		console.warn(`[statusline] cache read failed (using empty):`, e);
		return { ...EMPTY_CACHE };
	}
}

// ── 持久化工具 ───────────────────────────────────────

/**
 * 读取、追加、清理、写回按日期分组的记录文件。
 *
 * trackSpeed 和 trackCacheRatio 共享的
 * "读 JSON → filter → append → GC → write" 模式。
 */
function persistDailyRecord<T extends unknown[]>(
	dir: string,
	filePath: string,
	record: T,
	recordName: string,
): Record<string, T[]> {
	const today = new Date().toISOString().slice(0, DATE_STR_LEN);
	const records: Record<string, T[]> = {};

	// 读取已有数据
	try {
		if (existsSync(filePath)) {
			const raw = JSON.parse(readFileSync(filePath, "utf-8"));
			for (const [date, entries] of Object.entries(raw as Record<string, unknown>)) {
				if (!Array.isArray(entries)) continue;
				records[date] = entries.filter(
					(e): e is T => Array.isArray(e) && e.length >= RECORD_MIN_FIELDS,
				);
			}
		}
	// eslint-disable-next-line taste/no-silent-catch -- 文件损坏属于容错路径：fallback 到空 records
	} catch (e) {
		console.warn(`[statusline] ${recordName} record read failed (using empty):`, e);
	}

	// 追加今日记录
	if (!records[today]) records[today] = [];
	records[today].push(record);

	// 清理过期数据
	const cutoff = new Date(Date.now() - SPEED_RETENTION_DAYS * DAY_MS)
		.toISOString()
		.slice(0, DATE_STR_LEN);
	for (const d of Object.keys(records)) {
		if (d < cutoff) delete records[d];
	}

	// 写回
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(filePath, JSON.stringify(records));
	// eslint-disable-next-line taste/no-silent-catch -- 写入失败属于容错路径
	} catch (e) {
		console.warn(`[statusline] ${recordName} record write failed:`, e);
	}

	return records;
}

// ── Token Speed（与 provider 无关，保留在此）──────────────

// 每条记录存储 [outputTokens, durationMs]，用于正确计算加权平均速度
// SpeedRecord 类型已移至 speed.ts

export function trackSpeed(
	outputTokens: number,
	durationMs: number,
	model: string,
): SpeedData {
	const current =
		durationMs > 0 ? Math.round((outputTokens / durationMs) * MS_PER_SEC) : 0;
	if (!model || current <= 0) return { current, day: 0, d7: 0, d30: 0 };

	const safeName = model.replace(/[/\\\s:]/g, "_");
	const filePath = join(SPEED_DIR, `${safeName}.json`);

	const records = persistDailyRecord(
		SPEED_DIR, filePath, [outputTokens, durationMs] as SpeedRecord, "speed",
	);
	const today = new Date().toISOString().slice(0, DATE_STR_LEN);

	const dayEntries: SpeedRecord[] = [];
	const d7Entries: SpeedRecord[] = [];
	const d30Entries: SpeedRecord[] = [];
	const now = Date.now();

	for (const [date, entries] of Object.entries(records)) {
		d30Entries.push(...entries);
		if ((now - new Date(date).getTime()) / DAY_MS < SPEED_D7_DAYS) {
			d7Entries.push(...entries);
		}
		if (date === today) {
			dayEntries.push(...entries);
		}
	}

	return {
		current,
		day: avgSpeed(dayEntries),
		d7: avgSpeed(d7Entries),
		d30: avgSpeed(d30Entries),
	};
}

// ── Cache Ratio ─────────────────────────────────────────

const PERCENT_SCALE = 100;

/** 缓存命中率记录：[cacheRead, promptTotal=input+cacheRead+cacheWrite] */
type CacheRatioRecord = [number, number];

/** 缓存命中率统计目录 */
const CACHE_RATIO_DIR = join(getAgentDir(), "cache-ratio");

export function trackCacheRatio(
	usage: { input: number; cacheRead: number; cacheWrite: number },
	model: string,
): CacheRatioData {
	const { input, cacheRead, cacheWrite } = usage;
	const promptTotal = input + cacheRead + cacheWrite;

	// 无缓存信息时直接返回 null
	if (promptTotal <= 0) return { current: null, day: null };

	const current = Math.round((cacheRead / promptTotal) * PERCENT_SCALE);

	if (!model) return { current, day: null };

	const safeName = model.replace(/[/\\\s:]/g, "_");
	const filePath = join(CACHE_RATIO_DIR, `${safeName}.json`);

	const records = persistDailyRecord(
		CACHE_RATIO_DIR, filePath, [cacheRead, promptTotal] as CacheRatioRecord, "cache-ratio",
	);
	const today = new Date().toISOString().slice(0, DATE_STR_LEN);

	// 计算当天加权平均命中率
	const dayEntries = records[today] ?? [];
	let sumRead = 0;
	let sumTotal = 0;
	for (const [r, t] of dayEntries) {
		sumRead += r;
		sumTotal += t;
	}
	const day = sumTotal > 0 ? Math.round((sumRead / sumTotal) * PERCENT_SCALE) : null;

	return { current, day };
}

// avgSpeed 已移至 speed.ts，此处通过 import 使用
