/**
 * Model Switch — 推荐引擎
 *
 * 三层决策：
 * 1. 场景硬性需求（vision/planning → 固定模型，不受预算影响）
 * 2. KV Cache 粘性保护（连续 turn 数 + input tokens 阈值）
 * 3. 预算决策（高峰期 vs 非高峰期，套餐用量）
 */

import type { CacheData } from "@zhushanwen/pi-quota-providers";
import type { ModelPolicy, Recommendation, QuotaSnapshot, SessionEntries } from "./types";

// ── 时间常量 ────────────────────────────────────────────

const SECONDS_PER_DAY = 86400;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;

// ── 公共 API ────────────────────────────────────────────

/**
 * 计算推荐模型。
 */
export function computeRecommendation(
	config: ModelPolicy,
	scene: string,
	currentModel: string,
	sessionEntries: SessionEntries,
): Recommendation {
	const sceneAliases = config.scenes[scene];
	if (!sceneAliases || sceneAliases.length === 0) {
		const fallback = findFirstModel(config);
		if (!fallback) throw new Error("No models configured");
		return makeRec(config, fallback, "Default (no scene config)", fallback);
	}

	// 第 1 层：场景硬性需求
	if (isHardScene(scene)) {
		const alias = sceneAliases[0]!;
		return makeRec(config, alias, `Scene: ${scene}, fixed model`, alias);
	}

	// 第 3 层：预算决策
	const snapshot = computeQuotaSnapshotFromCache(sessionEntries);
	const now = new Date();
	const { planKey, planInfo } = findPrimaryPlan(config);
	const budgetResult = budgetDecision(snapshot, planInfo, now, planKey);

	const budgetAlias = sceneAliases.find((a) => config.models[a]?.plan === budgetResult.provider);
	const finalBudgetAlias = budgetAlias ?? sceneAliases[0]!;

	// 第 2 层：粘性检查
	const stickyInfo = computeStickiness(sessionEntries, config);
	const currentAlias = findAliasForModel(config, currentModel);
	const shouldSwitch = finalBudgetAlias !== currentAlias;

	if (shouldSwitch && currentAlias && stickyInfo.isSticky && !budgetResult.urgent) {
		const curEntry = config.models[currentAlias];
		return {
			model: currentAlias,
			provider: curEntry?.provider ?? currentModel.split("/")[0] ?? "",
			modelId: curEntry?.modelId ?? currentModel.split("/")[1] ?? "",
			reason: `Staying on ${currentModel} due to KV cache (${stickyInfo.turns} turns / ${stickyInfo.inputTokens} tokens). Switch cost > peak surcharge.`,
			stickyOverride: true,
			budgetModel: finalBudgetAlias,
		};
	}

	return makeRec(config, finalBudgetAlias, budgetReason(budgetResult, planInfo, now, planKey), finalBudgetAlias);
}

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
					weeklyPct: ((ocgData.weekly as Record<string, unknown> | undefined)?.usagePercent as number) ?? 0,
					resetSec: ((ocgData.rolling as Record<string, unknown> | undefined)?.resetInSec as number) ?? 0,
				}
			: null,
	};
}

/**
 * 检测当前场景。
 */
export function detectScene(prompt: string, toolName?: string): string {
	if (toolName === "analyze_image" || /\bimage\b/i.test(prompt)) return "vision";
	if (/\b(plan|architecture|design)\b/i.test(prompt)) return "planning";
	return "coding";
}

// ── 内部工具 ────────────────────────────────────────────

const HARD_SCENES = new Set(["vision", "planning"]);

function isHardScene(scene: string): boolean {
	return HARD_SCENES.has(scene);
}

/** 从 session entries 获取 cache 数据并计算 snapshot */
function computeQuotaSnapshotFromCache(_entries: SessionEntries): QuotaSnapshot {
	// readCache 需要从 quota-providers 动态导入
	// 当前直接返回空 snapshot，由 index.ts 调用时传入
	return { zai: null, ocg: null };
}

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

interface StickinessInfo {
	isSticky: boolean;
	turns: number;
	inputTokens: number;
}

function computeStickiness(
	entries: SessionEntries,
	config?: ModelPolicy,
): StickinessInfo {
	const minTurns = config?.stickiness?.minTurns ?? 3;
	const minInputTokens = config?.stickiness?.minInputTokens ?? 20_000;

	let lastModelChangeIdx = -1;
	let lastCompactionIdx = -1;

	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]!;
		if (e.type === "model_change" && lastModelChangeIdx === -1) lastModelChangeIdx = i;
		if (e.type === "compaction" && lastCompactionIdx === -1) lastCompactionIdx = i;
		if (lastModelChangeIdx !== -1 && lastCompactionIdx !== -1) break;
	}

	const stickStartIdx = Math.max(lastModelChangeIdx, lastCompactionIdx);

	if (lastCompactionIdx >= 0) {
		const compactionTurnCount = countTurnsAfter(entries, lastCompactionIdx);
		if (compactionTurnCount <= 1) {
			return { isSticky: false, turns: 0, inputTokens: 0 };
		}
	}

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

	return { isSticky: turns >= minTurns && inputTokens >= minInputTokens, turns, inputTokens };
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

interface PlanInfo {
	peak?: { start: number; end: number; multiplier: number };
	budgetTarget?: number;
}

interface BudgetResult {
	provider: string;
	urgent?: boolean;
}

const BUDGET_TARGET_DEFAULT = 80;
const OCG_NEAR_LIMIT_PCT = 80;
const URGENCY_RESET_SEC = 3600;
const URGENCY_REMAINING_PCT = 15;

function budgetDecision(snapshot: QuotaSnapshot, plan: PlanInfo, now: Date, planKey: string): BudgetResult {
	const zai = snapshot.zai;
	const ocg = snapshot.ocg;
	const fallbackPlanKey = findFallbackPlanKey(planKey);

	if (!zai) return { provider: planKey };

	const budgetTarget = plan.budgetTarget ?? BUDGET_TARGET_DEFAULT;
	const zaiRemaining = budgetTarget - zai.pct;
	const isPeak = plan.peak ? plan.peak.start <= now.getHours() && now.getHours() < plan.peak.end : false;

	if (!isPeak) return { provider: planKey };

	const urgency = zai.resetSec < URGENCY_RESET_SEC && zaiRemaining > URGENCY_REMAINING_PCT;
	if (urgency) return { provider: planKey, urgent: true };
	if (zaiRemaining <= 0) return { provider: fallbackPlanKey };
	if (ocg && ocg.rollingPct > OCG_NEAR_LIMIT_PCT) return { provider: planKey };

	return { provider: fallbackPlanKey };
}

function findPrimaryPlan(config: ModelPolicy): { planKey: string; planInfo: PlanInfo } {
	const plans = Object.entries(config.plans)
		.filter(([, p]) => p.peak || p.budgetTarget != null)
		.sort(([, a], [, b]) => a.priority - b.priority);

	if (plans.length === 0) {
		const firstEntry = Object.entries(config.plans)[0];
		if (firstEntry) return { planKey: firstEntry[0], planInfo: {} };
		return { planKey: "", planInfo: {} };
	}

	const [key, plan] = plans[0]!;
	return { planKey: key, planInfo: { peak: plan.peak, budgetTarget: plan.budgetTarget } };
}

function findFallbackPlanKey(primaryPlanKey: string): string {
	if (primaryPlanKey !== "opencode-go") return "opencode-go";
	return "zai";
}

function makeRec(config: ModelPolicy, alias: string, reason: string, budgetAlias: string): Recommendation {
	const entry = config.models[alias];
	if (!entry) {
		return { model: alias, provider: "", modelId: "", reason, stickyOverride: false, budgetModel: budgetAlias };
	}
	return { model: alias, provider: entry.provider, modelId: entry.modelId, reason, stickyOverride: false, budgetModel: budgetAlias };
}

function budgetReason(result: BudgetResult, plan: PlanInfo, now: Date, planKey: string): string {
	const isPeak = plan.peak ? plan.peak.start <= now.getHours() && now.getHours() < plan.peak.end : false;
	if (!isPeak) return "Non-peak hours, budget sufficient for Z.ai";
	if (result.urgent) return "Urgency: Z.ai window resetting soon with sufficient budget";
	if (result.provider !== planKey) return "Peak hours, saving Z.ai quota for later";
	return "Peak hours but opencode-go near limit, staying on Z.ai";
}

function findAliasForModel(config: ModelPolicy, currentModel: string): string | undefined {
	if (!currentModel) return undefined;
	const [provider, modelId] = currentModel.split("/");
	if (!provider || !modelId) return undefined;
	for (const [alias, entry] of Object.entries(config.models)) {
		if (entry.provider === provider && entry.modelId === modelId) return alias;
	}
	return undefined;
}

function findFirstModel(config: ModelPolicy): string | undefined {
	for (const sceneModels of Object.values(config.scenes)) {
		if (sceneModels.length > 0) return sceneModels[0];
	}
	const modelKeys = Object.keys(config.models);
	return modelKeys.length > 0 ? modelKeys[0] : undefined;
}
