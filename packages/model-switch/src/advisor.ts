/**
 * Model Switch — 数据提取层
 *
 * 从 cache 和 session entries 中提取结构化数据供 prompt 注入。
 * 从 provider-plan 映射计算实时推荐。
 */

import type { CacheData } from "@zhushanwen/pi-quota-providers";
import type {
	ModelPolicy,
	PlanQuota,
	QuotaSnapshot,
	SessionEntries,
	StickinessInfo,
	RecommendInfo,
} from "./types";

// ── 时间常量 ────────────────────────────────────────────

const SECONDS_PER_DAY = 86400;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;

// ── 公共 API ────────────────────────────────────────────

/**
 * 从缓存数据中计算所有 plan 的用量快照。
 * 通过 plan 名匹配 cache key（quota-provider 的 id）。
 */
export function computeQuotaSnapshot(cache: CacheData, config: ModelPolicy): QuotaSnapshot {
	const cacheRec = cache as Record<string, unknown>;
	const plans: Record<string, PlanQuota> = {};

	for (const planName of Object.keys(config.plans)) {
		const quota = extractSingleQuota(planName, cacheRec);
		if (quota) plans[planName] = quota;
	}

	return { plans };
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
 * 计算高峰期推荐结论（仅针对有 peak 配置的 plan）。
 * 当前专用于 zhipu 的 peak 时段判断。
 *
 * 规则：
 * - 非高峰期 → ok
 * - 高峰期，且 5h 窗口后半段与 peak 重叠 → ok（即将 reset）
 * - 高峰期，且 5h 窗口前半段与 peak 重叠，用量 >50% → avoid
 */
export function computePeakRecommend(
	now: Date,
	config: ModelPolicy,
	snapshot: QuotaSnapshot,
): RecommendInfo {
	// 找到有 peak 配置的 plan
	const peakPlan = findPeakPlan(config);
	if (!peakPlan) return { result: "ok", reason: "Off-peak" };

	const [planName, planCfg] = peakPlan;
	const peak = planCfg.peak!;
	const h = now.getHours();
	const inPeak = h >= peak.start && h < peak.end;

	if (!inPeak) return { result: "ok", reason: "Off-peak" };

	const quota = snapshot.plans[planName];
	if (!quota || quota.pct === null) {
		return { result: "avoid", reason: "Peak hours, no quota data" };
	}

	if (quota.pct > 95) {
		return { result: "avoid", reason: `Peak hours, ${quota.pct}% used (near limit)` };
	}

	const winHours = planCfg.rollingWindowHours ?? 5;
	const winSec = winHours * SECONDS_PER_HOUR;

	if (quota.resetSec === null || quota.resetSec <= 0 || quota.resetSec >= winSec) {
		// 无法确定窗口位置，保守处理
		return { result: quota.pct > 50 ? "avoid" : "ok", reason: inPeak ? `Peak hours, ${quota.pct}% used` : "Off-peak" };
	}

	const elapsedSec = winSec - quota.resetSec;
	const windowStartMs = now.getTime() - elapsedSec * 1000;
	const windowMidMs = windowStartMs + (winSec / 2) * 1000;

	const peakStartMs = new Date(now).setHours(peak.start, 0, 0, 0);
	const peakEndMs = new Date(now).setHours(peak.end, 0, 0, 0);

	const peakInFirstHalf = peakStartMs < windowMidMs && peakEndMs > windowStartMs;

	if (peakInFirstHalf && quota.pct > 50) {
		return { result: "avoid", reason: `Peak hours, >50% window (${quota.pct}%), peak overlaps early window` };
	}

	return { result: "ok", reason: `Peak hours, ${!peakInFirstHalf ? "peak overlaps late window" : `${quota.pct}% used, within budget`}` };
}

// ── 内部工具 ────────────────────────────────────────────

/**
 * 从 cache 中提取单个 plan 的用量快照。
 * 自动适配各 provider 的不同原始数据格式。
 */
function extractSingleQuota(planName: string, cacheRec: Record<string, unknown>): PlanQuota | null {
	const raw = cacheRec[planName];
	if (!raw || typeof raw !== "object") return null;
	const d = raw as Record<string, unknown>;

	// Pattern 1: zhipu 风格 { tokensPct, resetTime: "3h48m" }
	if (typeof d.tokensPct === "number") {
		return {
			pct: d.tokensPct as number,
			resetSec: parseZaiResetTime((d.resetTime as string) ?? ""),
			label: planName,
		};
	}

	// Pattern 2: opencode-go 风格 { rolling: { usagePercent, resetInSec } }
	const rolling = d.rolling as Record<string, unknown> | undefined;
	if (rolling && typeof rolling.usagePercent === "number") {
		return {
			pct: rolling.usagePercent as number,
			resetSec: (rolling.resetInSec as number) ?? null,
			label: planName,
		};
	}

	// Pattern 3: kimi 风格 { rollingWindow: { usedPct, resetTime: ISO } }
	const rw = d.rollingWindow as Record<string, unknown> | undefined;
	if (rw && typeof rw.usedPct === "number") {
		return {
			pct: rw.usedPct as number,
			resetSec: parseIsoRemaining((rw.resetTime as string) ?? ""),
			label: planName,
		};
	}

	// Pattern 4: minimax 风格 { models: [{ model_name, remains_time, current_interval_remaining_percent }] }
	const models = d.models as Array<Record<string, unknown>> | undefined;
	if (models && Array.isArray(models)) {
		const general = models.find((m) => m.model_name === "general") as Record<string, unknown> | undefined;
		if (general) {
			const remPct = general.current_interval_remaining_percent as number | undefined;
			const used = remPct !== undefined ? Math.max(0, Math.min(100, 100 - remPct)) : null;
			const remainsMs = general.remains_time as number | undefined;
			if (used !== null) {
				return { pct: used, resetSec: remainsMs ? Math.ceil(remainsMs / 1000) : null, label: planName };
			}
		}
	}

	return null;
}

/** 查找配置中 priority 最高的有 peak 设置的 plan */
function findPeakPlan(config: ModelPolicy): [string, import("./types").PlanConfig] | null {
	const entries = Object.entries(config.plans).filter(([, p]) => p.peak);
	if (entries.length === 0) return null;
	entries.sort(([, a], [, b]) => a.priority - b.priority);
	return entries[0]!;
}

/** 解析 Z.ai 的 resetTime（"3h48m" → 秒） */
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

/** 解析 ISO 剩余时间 → 秒 */
function parseIsoRemaining(iso: string): number {
	if (!iso) return 0;
	const target = new Date(iso).getTime();
	const now = Date.now();
	return Math.max(0, Math.ceil((target - now) / 1000));
}

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
