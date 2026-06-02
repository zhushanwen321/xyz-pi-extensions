/**
 * Model Switch — 推荐引擎
 *
 * 三层决策：
 * 1. 场景硬性需求（vision/planning → 固定模型，不受预算影响）
 * 2. KV Cache 粘性保护（连续 turn 数 + input tokens 阈值）
 * 3. 预算决策（高峰期 vs 非高峰期，套餐用量）
 */

import { readCache, type CacheData } from "@zhushanwen/pi-quota-providers";
import type { ModelPolicy } from "./config";

// ── 类型定义 ────────────────────────────────────────────

export interface Recommendation {
	/** 推荐的模型 alias（如 "glm-5.1"） */
	model: string;
	/** Pi provider 名 */
	provider: string;
	/** Pi model ID */
	modelId: string;
	/** 原因描述 */
	reason: string;
	/** 是否因粘性覆盖了预算推荐 */
	stickyOverride: boolean;
	/** 预算推荐的 alias（可能与最终不同） */
	budgetModel: string;
}

export interface QuotaSnapshot {
	zai: { pct: number; resetSec: number } | null;
	ocg: { rollingPct: number; weeklyPct: number; resetSec: number } | null;
}

interface BudgetResult {
	/** 推荐的 plan key（对应 config.plans 中的 key） */
	provider: string;
	urgent?: boolean;
}

// ── 公共 API ────────────────────────────────────────────

/**
 * 计算推荐模型。
 *
 * @param config ModelPolicy 配置
 * @param scene 当前场景（由 detectScene 返回）
 * @param currentModel 当前模型 "provider/modelId" 格式
 * @param sessionEntries session entries（用于粘性计算）
 */
export function computeRecommendation(
	config: ModelPolicy,
	scene: string,
	currentModel: string,
	sessionEntries: Array<{ type: string; [key: string]: unknown }>,
): Recommendation {
	const sceneAliases = config.scenes[scene];
	if (!sceneAliases || sceneAliases.length === 0) {
		// 降级：使用第一个场景的第一个模型
		const fallback = findFirstModel(config);
		if (!fallback) throw new Error("No models configured");
		return makeRec(config, fallback, "Default (no scene config)", fallback);
	}

	// ── 第 1 层：场景硬性需求 ────────────────────────────
	const HARD_SCENES = new Set(["vision", "planning"]);
	if (HARD_SCENES.has(scene)) {
		const alias = sceneAliases[0]!;
		return makeRec(config, alias, `Scene: ${scene}, fixed model`, alias);
	}

	// ── 第 3 层：预算决策 ────────────────────────────────
	const cache = readCache();
	const snapshot = computeQuotaSnapshot(cache);
	const now = new Date();

	const { planKey, planInfo } = findPrimaryPlan(config);
	const budgetResult = budgetDecision(snapshot, planInfo, now, planKey);

	// 从场景列表中找到属于预算推荐 plan 的模型
	const budgetAlias = sceneAliases.find((a) => {
		const entry = config.models[a];
		return entry?.plan === budgetResult.provider;
	});
	const finalBudgetAlias = budgetAlias ?? sceneAliases[0]!;

	// ── 第 2 层：粘性检查 ────────────────────────────────
	const stickyInfo = computeStickiness(currentModel, sessionEntries, config);
	const currentAlias = findAliasForModel(config, currentModel);
	const shouldSwitch = finalBudgetAlias !== currentAlias;

	if (shouldSwitch && currentAlias && stickyInfo.isSticky && !budgetResult.urgent) {
		// 粘性阻止切换
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

	// 正常推荐
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
 *
 * 基于 prompt 内容和工具名做简单关键词匹配。
 */
export function detectScene(prompt: string, toolName?: string): string {
	if (toolName === "analyze_image" || /\bimage\b/i.test(prompt)) return "vision";
	if (/\b(plan|architecture|design)\b/i.test(prompt)) return "planning";
	return "coding";
}

// ── 内部工具 ────────────────────────────────────────────

/**
 * 解析 zai 的 resetTime 字符串（如 "4h11m"/"3d20h"）为剩余秒数。
 */
function parseZaiResetTime(label: string): number {
	if (!label) return 0;
	const dM = label.match(/(\d+)d/);
	const hM = label.match(/(\d+)h/);
	const mM = label.match(/(\d+)m/);
	let sec = 0;
	if (dM) sec += Number(dM[1]) * 86400;
	if (hM) sec += Number(hM[1]) * 3600;
	if (mM) sec += Number(mM[1]) * 60;
	return sec;
}

interface StickinessInfo {
	isSticky: boolean;
	turns: number;
	inputTokens: number;
}

/**
 * 粘性计算：从 session entries 中计算当前模型的连续使用信息。
 *
 * 扫描逻辑：
 * 1. 找到最后一个 model_change entry → 模型切换点
 * 2. 找到最后一个 compaction entry → compaction 点
 * 3. 从 max(model_change, compaction) 之后数 assistant message = consecutiveTurns
 * 4. 累加 assistant message 的 usage.input = 累积 input tokens
 * 5. compaction 后 1 turn 内 → 不粘性（KV Cache 已清除）
 */
function computeStickiness(
	currentModel: string,
	entries: Array<{ type: string; [key: string]: unknown }>,
	config?: ModelPolicy,
): StickinessInfo {
	const minTurns = config?.stickiness?.minTurns ?? 3;
	const minInputTokens = config?.stickiness?.minInputTokens ?? 20_000;

	// 倒序扫描找最近的模型切换和 compaction
	let lastModelChangeIdx = -1;
	let lastCompactionIdx = -1;

	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]!;
		if (e.type === "model_change" && lastModelChangeIdx === -1) {
			lastModelChangeIdx = i;
		}
		if (e.type === "compaction" && lastCompactionIdx === -1) {
			lastCompactionIdx = i;
		}
		if (lastModelChangeIdx !== -1 && lastCompactionIdx !== -1) break;
	}

	// 粘性从 max(model_change, compaction) 之后算
	const stickStartIdx = Math.max(lastModelChangeIdx, lastCompactionIdx);

	// compaction 后 1 turn 内：不粘性
	if (lastCompactionIdx >= 0) {
		const compactionTurnCount = countTurnsAfter(entries, lastCompactionIdx);
		if (compactionTurnCount <= 1) {
			return { isSticky: false, turns: 0, inputTokens: 0 };
		}
	}

	// 从 stickStartIdx 之后数 turn 和 tokens
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

	const isSticky = turns >= minTurns && inputTokens >= minInputTokens;
	return { isSticky, turns, inputTokens };
}

/**
 * 计算从指定位置之后有多少 assistant message。
 */
function countTurnsAfter(entries: Array<{ type: string; [key: string]: unknown }>, startIdx: number): number {
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

/**
 * 预算决策算法。
 *
 * 输入 zai/ocg 用量快照 + 计划配置 + 当前时间，输出推荐 plan key。
 */
function budgetDecision(snapshot: QuotaSnapshot, plan: PlanInfo, now: Date, planKey: string): BudgetResult {
	const zai = snapshot.zai;
	const ocg = snapshot.ocg;

	// 找到备选 plan（priority 更高的）
	const fallbackPlanKey = findFallbackPlanKey(planKey);

	// 没有套餐数据时保守使用主 plan
	if (!zai) return { provider: planKey };

	const budgetTarget = plan.budgetTarget ?? 80;
	const zaiRemaining = budgetTarget - zai.pct;
	const isPeak = plan.peak ? plan.peak.start <= now.getHours() && now.getHours() < plan.peak.end : false;

	if (!isPeak) {
		return { provider: planKey };
	}

	// 高峰期逻辑
	const urgency = zai.resetSec < 3600 && zaiRemaining > 15;

	if (urgency) {
		return { provider: planKey, urgent: true };
	}
	if (zaiRemaining <= 0) {
		return { provider: fallbackPlanKey };
	}
	if (ocg && ocg.rollingPct > 80) {
		return { provider: planKey };
	}

	return { provider: fallbackPlanKey };
}

interface PlanInfo {
	peak?: { start: number; end: number; multiplier: number };
	budgetTarget?: number;
}

/**
 * 找到主要套餐配置（priority 最小的 plan）。
 */
function findPrimaryPlan(config: ModelPolicy): { planKey: string; planInfo: PlanInfo } {
	const plans = Object.entries(config.plans)
		.filter(([, p]) => p.peak || p.budgetTarget != null)
		.sort(([, a], [, b]) => a.priority - b.priority);

	if (plans.length === 0) {
		// 回退：使用第一个 plan
		const firstEntry = Object.entries(config.plans)[0];
		if (firstEntry) {
			return { planKey: firstEntry[0], planInfo: {} };
		}
		return { planKey: "", planInfo: {} };
	}

	const [key, plan] = plans[0]!;
	return {
		planKey: key,
		planInfo: {
			peak: plan.peak,
			budgetTarget: plan.budgetTarget,
		},
	};
}

/**
 * 找到备选 plan key（priority 仅次于主 plan）。
 */
function findFallbackPlanKey(primaryPlanKey: string): string {
	// 简单实现：返回 opencode-go 或第一个非 primary 的 plan
	if (primaryPlanKey !== "opencode-go") return "opencode-go";
	return "zai";
}

/**
 * 生成推荐对象。
 */
function makeRec(config: ModelPolicy, alias: string, reason: string, budgetAlias: string): Recommendation {
	const entry = config.models[alias];
	if (!entry) {
		return { model: alias, provider: "", modelId: "", reason, stickyOverride: false, budgetModel: budgetAlias };
	}
	return {
		model: alias,
		provider: entry.provider,
		modelId: entry.modelId,
		reason,
		stickyOverride: false,
		budgetModel: budgetAlias,
	};
}

/**
 * 生成预算决策的原因文本。
 */
function budgetReason(result: BudgetResult, plan: PlanInfo, now: Date, planKey: string): string {
	const isPeak = plan.peak ? plan.peak.start <= now.getHours() && now.getHours() < plan.peak.end : false;
	if (!isPeak) return "Non-peak hours, budget sufficient for Z.ai";
	if (result.urgent) return "Urgency: Z.ai window resetting soon with sufficient budget";
	if (result.provider !== planKey) return "Peak hours, saving Z.ai quota for later";
	return "Peak hours but opencode-go near limit, staying on Z.ai";
}

/**
 * 根据 "provider/modelId" 字符串从配置中找到对应的 alias。
 */
function findAliasForModel(config: ModelPolicy, currentModel: string): string | undefined {
	if (!currentModel) return undefined;
	const [provider, modelId] = currentModel.split("/");
	if (!provider || !modelId) return undefined;
	for (const [alias, entry] of Object.entries(config.models)) {
		if (entry.provider === provider && entry.modelId === modelId) {
			return alias;
		}
	}
	return undefined;
}

/**
 * 找到配置中的第一个可用模型 alias。
 */
function findFirstModel(config: ModelPolicy): string | undefined {
	for (const sceneModels of Object.values(config.scenes)) {
		if (sceneModels.length > 0) return sceneModels[0];
	}
	const modelKeys = Object.keys(config.models);
	return modelKeys.length > 0 ? modelKeys[0] : undefined;
}
