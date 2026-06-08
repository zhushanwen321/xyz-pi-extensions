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
import { MIN_PER_HOUR, MS_PER_SEC, SEC_PER_DAY,SEC_PER_MIN } from "./time.js";

const DAY_MS = SEC_PER_DAY * MS_PER_SEC;

// ── 缓存 / 统计常量 ─────────────────────────────────────

/** 套餐用量刷新间隔（5 分钟） */
const TTL_MINUTES = 5;
const CACHE_TTL_MS = TTL_MINUTES * MIN_PER_HOUR * SEC_PER_MIN * MS_PER_SEC;
/** cache JSON 写入的 pretty-print indent */
const JSON_INDENT = 2;
/** SpeedRecord 元组长度（[tokens, duration]） */
const SPEED_RECORD_FIELDS = 2;
/** 触发节流：实际请求频率不低于 TTL/2 */
const TTL_THROTTLE_DIVISOR = 2;
/** token 速度统计保留天数 */
const SPEED_RETENTION_DAYS = 30;
/** token 速度统计窗口（最近 7 天） */
const SPEED_D7_DAYS = 7;

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
	// 距上次实际请求不足 TTL 一半时跳过，避免 message_end 高频触发
	if (Date.now() - lastUpdateAt < CACHE_TTL_MS / TTL_THROTTLE_DIVISOR) return;
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
	const today = new Date().toISOString().slice(0, DATE_STR_LEN);

	const records: Record<string, SpeedRecord[]> = {};
	try {
		if (existsSync(filePath)) {
			const raw = JSON.parse(readFileSync(filePath, "utf-8"));
			for (const [date, entries] of Object.entries(raw)) {
				// 跳过旧格式（number[]）或混合格式
				if (!Array.isArray(entries)) continue;
				if (entries.length > 0 && !Array.isArray(entries[0])) continue;
				// 过滤掉同日期内混入的旧格式纯数字
				records[date] = entries.filter(
					(e): e is SpeedRecord => Array.isArray(e) && e.length >= SPEED_RECORD_FIELDS,
				);
			}
		}
	// eslint-disable-next-line taste/no-silent-catch -- 速度文件损坏属于容错路径：fallback 到空 records，重新积累
	} catch (e) {
		console.warn(`[statusline] speed record read failed (using empty):`, e);
	}

	if (!records[today]) records[today] = [];
	records[today].push([outputTokens, durationMs]);

	// 清理过期数据
	const cutoff = new Date(Date.now() - SPEED_RETENTION_DAYS * DAY_MS)
		.toISOString()
		.slice(0, DATE_STR_LEN);
	for (const d of Object.keys(records)) {
		if (d < cutoff) delete records[d];
	}

	try {
		mkdirSync(SPEED_DIR, { recursive: true });
		writeFileSync(filePath, JSON.stringify(records));
	// eslint-disable-next-line taste/no-silent-catch -- 速度文件写失败属于容错路径：本次速度不持久化，下次 trackSpeed 重新记录
	} catch (e) {
		console.warn(`[statusline] speed record write failed:`, e);
	}

// avgSpeed 已移至 speed.ts，此处通过 import 使用

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

/** ISO date 字符串长度（YYYY-MM-DD） */
const DATE_STR_LEN = 10;
