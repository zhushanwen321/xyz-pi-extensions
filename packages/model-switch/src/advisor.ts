/**
 * Model Switch — 数据提取层
 *
 * 从 cache 和 session entries 中提取结构化数据供 prompt 注入。
 * 纯函数，无副作用。不包含推荐逻辑。
 */

import type { CacheData } from "@zhushanwen/pi-quota-providers";
import type { ModelPolicy, QuotaSnapshot, SessionEntries, StickinessInfo } from "./types";

// ── 时间常量 ────────────────────────────────────────────

const SECONDS_PER_DAY = 86400;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;

// ── 公共 API ────────────────────────────────────────────

/**
 * 从缓存数据中计算套餐快照。
 */
export function computeQuotaSnapshot(cache: CacheData): QuotaSnapshot {
	const cacheRec = cache as Record<string, unknown>;
	const zaiData = cacheRec["zhipu"] as Record<string, unknown> | undefined;
	const ocgData = cacheRec["opencodeGo"] as Record<string, unknown> | undefined;

	return {
		zai: zaiData
			? {
					pct: (zaiData.tokensPct as number) ?? 0,
					resetSec: parseZaiResetTime((zaiData.resetTime as string) ?? ""),
				}
			: null,
		ocg: ocgData
			? {
					rollingPct: ((ocgData.rolling as Record<string, unknown> | undefined)?.usagePercent as number) ?? 0,
					rollingResetSec: ((ocgData.rolling as Record<string, unknown> | undefined)?.resetInSec as number) ?? 0,
					weeklyPct: ((ocgData.weekly as Record<string, unknown> | undefined)?.usagePercent as number) ?? 0,
					weeklyResetSec: ((ocgData.weekly as Record<string, unknown> | undefined)?.resetInSec as number) ?? 0,
					monthlyPct: ((ocgData.monthly as Record<string, unknown> | undefined)?.usagePercent as number) ?? 0,
					monthlyResetSec: ((ocgData.monthly as Record<string, unknown> | undefined)?.resetInSec as number) ?? 0,
				}
			: null,
	};
}

/**
 * 从 session entries 中提取粘性信息。
 */
export function computeStickiness(
	entries: SessionEntries,
	_config?: ModelPolicy,
): StickinessInfo {
	let lastModelChangeIdx = -1;
	let lastCompactionIdx = -1;

	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]!;
		if (e.type === "model_change" && lastModelChangeIdx === -1) lastModelChangeIdx = i;
		if (e.type === "compaction" && lastCompactionIdx === -1) lastCompactionIdx = i;
		if (lastModelChangeIdx !== -1 && lastCompactionIdx !== -1) break;
	}

	const justCompacted = lastCompactionIdx >= 0 && countTurnsAfter(entries, lastCompactionIdx) <= 1;

	if (justCompacted) {
		return { turns: 0, inputTokens: 0, justCompacted: true };
	}

	const stickStartIdx = Math.max(lastModelChangeIdx, lastCompactionIdx);

	let turns = 0;
	let inputTokens = 0;
	for (let i = stickStartIdx + 1; i < entries.length; i++) {
		const e = entries[i]!;
		if (e.type === "message") {
			const msg = e.message as { role?: string; usage?: { input?: number } } | undefined;
			if (msg?.role === "assistant") {
				turns++;
				inputTokens += msg.usage?.input ?? 0;
			}
		}
	}

	return { turns, inputTokens, justCompacted: false };
}

/**
 * 解析 Z.ai 的 resetTime 人类可读格式为秒数。
 */
export function parseZaiResetTime(label: string): number {
	if (!label) return 0;
	const dM = label.match(/(\d+)d/);
	const hM = label.match(/(\d+)h/);
	const mM = label.match(/(\d+)m/);
	let sec = 0;
	if (dM) sec += Number(dM[1]) * SECONDS_PER_DAY;
	if (hM) sec += Number(hM[1]) * SECONDS_PER_HOUR;
	if (mM) sec += Number(mM[1]) * SECONDS_PER_MINUTE;
	return sec;
}

// ── 内部工具 ────────────────────────────────────────────

function countTurnsAfter(entries: SessionEntries, startIdx: number): number {
	let count = 0;
	for (let i = startIdx + 1; i < entries.length; i++) {
		const e = entries[i]!;
		if (e.type === "message") {
			const msg = e.message as { role?: string } | undefined;
			if (msg?.role === "assistant") count++;
		}
	}
	return count;
}
