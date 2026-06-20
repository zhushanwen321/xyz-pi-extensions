/**
 * Model Switch — 数据提取层
 *
 * 从 cache 和 session entries 中提取结构化数据供 prompt 注入。
 * 从 provider-plan 映射计算实时推荐。
 */

import type { CacheData } from "@zhushanwen/pi-quota-providers";
import { readCache } from "@zhushanwen/pi-quota-providers";

import { loadConfig } from "./config";
import type {
	ModelPolicy,
	PlanConfig,
	PlanQuota,
	QuotaSnapshot,
	RecommendInfo,
	SessionEntries,
	StickinessInfo,
} from "./types";

// ── 时间常量 ────────────────────────────────────────────

const SECONDS_PER_DAY = 86400;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SEC = 1000;

// ── 业务阈值常�� ─────────────────────────────────────────

/** Z.ai rolling 窗口安全阀：超过此百分比时，即使在非 peak 也禁用 */
const ZAI_SAFETY_VALVE = 95;

/** peak 时段窗口使用率阈值：超过此值时，若 peak 与窗口前半段重叠则禁用 */
const PEAK_WINDOW_THRESHOLD = 50;

/** rollingWindowHours 默认值 */
const DEFAULT_ROLLING_WINDOW_HOURS = 5;

/** 未配置 priority 时的回退值 */
const FALLBACK_PRIORITY = 99;

/** 百分比上限（用于 minimax remaining → used 转换） */
const PERCENT_FULL = 100;

/** 窗口二等分除数 */
const HALF = 2;

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

	if (quota.pct > ZAI_SAFETY_VALVE) {
		return { result: "avoid", reason: `Peak hours, ${quota.pct}% used (near limit)` };
	}

	const winHours = planCfg.rollingWindowHours ?? DEFAULT_ROLLING_WINDOW_HOURS;
	const winSec = winHours * SECONDS_PER_HOUR;

	if (quota.resetSec === null || quota.resetSec <= 0 || quota.resetSec >= winSec) {
		// 无法确定窗口位置，保守处理
		return { result: quota.pct > PEAK_WINDOW_THRESHOLD ? "avoid" : "ok", reason: inPeak ? `Peak hours, ${quota.pct}% used` : "Off-peak" };
	}

	const elapsedSec = winSec - quota.resetSec;
	const windowStartMs = now.getTime() - elapsedSec * MS_PER_SEC;
	const windowMidMs = windowStartMs + (winSec / HALF) * MS_PER_SEC;

	const peakStartMs = new Date(now).setHours(peak.start, 0, 0, 0);
	const peakEndMs = new Date(now).setHours(peak.end, 0, 0, 0);

	const peakInFirstHalf = peakStartMs < windowMidMs && peakEndMs > windowStartMs;

	if (peakInFirstHalf && quota.pct > PEAK_WINDOW_THRESHOLD) {
		return { result: "avoid", reason: `Peak hours, >50% window (${quota.pct}%), peak overlaps early window` };
	}

	return { result: "ok", reason: `Peak hours, ${!peakInFirstHalf ? "peak overlaps late window" : `${quota.pct}% used, within budget`}` };
}

// ── Scene-based Model Resolution ───────────────────────

interface Candidate {
	alias: string;
	providerKey: string;
	modelId: string;
	plan: string;
	priority: number;
	isPeakAvoid: boolean;
}

/**
 * 根据 scene 名推荐最优模型。
 * 优先级排序：非 peak avoid 优先 → priority 数值小优先。
 * 返回 "providerKey/modelId" 或 undefined。
 */
export function resolveModelForScene(scene: string, now?: Date): string | undefined {
	const config = loadConfig();
	if (!config) {
		console.warn(`[model-switch] resolveModelForScene: no config loaded`);
		return undefined;
	}

	const aliases = config.scenes[scene];
	if (!aliases || aliases.length === 0) {
		console.warn(`[model-switch] resolveModelForScene: scene "${scene}" not found`);
		return undefined;
	}

	// Global quota + peak state (computed once)
	const cache = readCache();
	const snapshot = computeQuotaSnapshot(cache, config);
	const peakRecommend = computePeakRecommend(now ?? new Date(), config, snapshot);

	// Find the peak plan name (only one peak plan exists per config)
	const peakPlan = findPeakPlan(config);
	const peakPlanName = peakPlan ? peakPlan[0] : null;

	// Collect candidates with metadata
	const candidates: Candidate[] = [];

	for (const alias of aliases) {
		// Find which provider has this alias
		for (const [providerKey, pcfg] of Object.entries(config.models)) {
			const entry = pcfg.models[alias];
			if (!entry) continue;

			const planCfg = config.plans[pcfg.plan];
			const priority = planCfg?.priority ?? FALLBACK_PRIORITY;

			// Only mark as peak avoid if THIS candidate's plan matches the peak plan
			const isPeakAvoid = pcfg.plan === peakPlanName && peakRecommend.result === "avoid";

			candidates.push({
				alias,
				providerKey,
				modelId: entry.modelId,
				plan: pcfg.plan,
				priority,
				isPeakAvoid,
			});
		}
	}

	if (candidates.length === 0) {
		console.warn(`[model-switch] resolveModelForScene: no candidates found for scene "${scene}"`);
		return undefined;
	}

	// Sort: non-avoid first, then by priority (ascending = higher priority first)
	candidates.sort((a, b) => {
		if (a.isPeakAvoid !== b.isPeakAvoid) return a.isPeakAvoid ? 1 : -1;
		return a.priority - b.priority;
	});

	// Return first non-avoid candidate
	const best = candidates[0];
	if (best.isPeakAvoid) {
		// All candidates are in peak-avoid — fall back to default model silently.
		// The caller (workflow/model-resolver) handles undefined by using the
		// default model, so no user-visible notification is needed.
		return undefined;
	}

	return `${best.providerKey}/${best.modelId}`;
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
			const used = remPct !== undefined ? Math.max(0, Math.min(PERCENT_FULL, PERCENT_FULL - remPct)) : null;
			const remainsMs = general.remains_time as number | undefined;
			if (used !== null) {
				return { pct: used, resetSec: remainsMs ? Math.ceil(remainsMs / MS_PER_SEC) : null, label: planName };
			}
		}
	}

	return null;
}

/** 查找配置中 priority 最高的有 peak 设置的 plan */
function findPeakPlan(config: ModelPolicy): [string, PlanConfig] | null {
	const entries = Object.entries(config.plans).filter(([, p]) => p.peak);
	if (entries.length === 0) return null;
	entries.sort(([, a], [, b]) => a.priority - b.priority);
	return entries[0]!;
}

/** 解析 Z.ai 的 resetTime（"3h48m" → 秒） */
function parseZaiResetTime(label: string): number {
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
	return Math.max(0, Math.ceil((target - now) / MS_PER_SEC));
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

