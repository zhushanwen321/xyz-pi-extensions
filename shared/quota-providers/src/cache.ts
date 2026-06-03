/**
 * Statusline 数据缓存层
 *
 * 架构（重构后）：
 *   - 各 provider 单独实现在 providers/*.ts，通过 PROVIDERS 注册表管理
 *   - cache.ts 只负责：TTL 缓存、并发控制、Promise.allSettled 拉取、磁盘持久化
 *   - 新增 provider：实现 QuotaProvider 接口 → 在 PROVIDERS 注册（零改动 cache.ts）
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { join } from "node:path";
import { PROVIDERS } from "./providers/index.js";
import { getCachePath, getSpeedDir } from "./paths.js";

// ── Paths ──────────────────────────────────────────────
const PI_DIR = getAgentDir();
const CACHE_PATH = getCachePath();
const SPEED_DIR = getSpeedDir();
const CACHE_TTL_MS = 300_000; // 5 分钟：套餐用量刷新间隔

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
	if (Date.now() - lastUpdateAt < CACHE_TTL_MS / 2) return;
	updating = true;
	lastUpdateAt = Date.now();
	doUpdate()
		.finally(() => {
			updating = false;
		})
		.catch(() => {});
}

async function doUpdate(): Promise<void> {
	const old = readCacheSync();
	const results = await Promise.allSettled(PROVIDERS.map((p) => p.fetch()));

	const cache: Record<string, unknown> = { updatedAt: Date.now() };
	for (let i = 0; i < PROVIDERS.length; i++) {
		const p = PROVIDERS[i]!;
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
		writeFileSync(tmpPath, JSON.stringify(cache, null, 2), "utf-8");
		renameSync(tmpPath, CACHE_PATH);
	} catch {
		// 写入失败不影响下次读取（保留旧缓存）
	}
}

function readCacheSync(): CacheData {
	try {
		const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
		if (typeof parsed !== "object" || parsed === null) return { ...EMPTY_CACHE };
		// 确保 updatedAt 存在，其余字段原样保留（由 provider 动态管理）
		return { ...parsed, updatedAt: parsed.updatedAt ?? 0 };
	} catch {
		return { ...EMPTY_CACHE };
	}
}

// ── Token Speed（与 provider 无关，保留在此）──────────────

// 每条记录存储 [outputTokens, durationMs]，用于正确计算加权平均速度
type SpeedRecord = [number, number];

export function trackSpeed(
	outputTokens: number,
	durationMs: number,
	model: string,
): SpeedData {
	const current =
		durationMs > 0 ? Math.round((outputTokens / durationMs) * 1000) : 0;
	if (!model || current <= 0) return { current, day: 0, d7: 0, d30: 0 };

	const safeName = model.replace(/[/\\\s:]/g, "_");
	const filePath = join(SPEED_DIR, `${safeName}.json`);
	const today = new Date().toISOString().slice(0, 10);

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
					(e): e is SpeedRecord => Array.isArray(e) && e.length >= 2,
				);
			}
		}
	} catch {
		/* istanbul ignore next — 文件损坏时回退到空记录 */
	}

	if (!records[today]) records[today] = [];
	records[today].push([outputTokens, durationMs]);

	// 清理 30 天前的数据
	const cutoff = new Date(Date.now() - 30 * 86_400_000)
		.toISOString()
		.slice(0, 10);
	for (const d of Object.keys(records)) {
		if (d < cutoff) delete records[d];
	}

	try {
		mkdirSync(SPEED_DIR, { recursive: true });
		writeFileSync(filePath, JSON.stringify(records));
	} catch {
		/* istanbul ignore next — 写入失败不影响功能 */
	}

	// 加权平均：sum(tokens) / sum(duration) * 1000
	const avgSpeed = (entries: SpeedRecord[]): number => {
		let totalTokens = 0;
		let totalDuration = 0;
		for (const entry of entries) {
			if (!Array.isArray(entry) || entry.length < 2) continue;
			totalTokens += entry[0];
			totalDuration += entry[1];
		}
		return totalDuration > 0
			? Math.round((totalTokens / totalDuration) * 1000)
			: 0;
	};

	const dayEntries: SpeedRecord[] = [];
	const d7Entries: SpeedRecord[] = [];
	const d30Entries: SpeedRecord[] = [];
	const now = Date.now();

	for (const [date, entries] of Object.entries(records)) {
		d30Entries.push(...entries);
		if ((now - new Date(date).getTime()) / 86_400_000 < 7) {
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
