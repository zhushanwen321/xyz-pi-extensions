/**
 * Model Switch — 共享类型定义
 *
 * 所有跨文件的类型、常量集中管理。
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── 模型条目（v2：内嵌在 ProviderConfig 中）─────────────

export interface ModelEntry {
	/** Pi model ID（如 "glm-5.1"、"ds-flash"） */
	modelId: string;
	/** 输入模态，如 ["text", "image"] */
	capabilities: string[];
}

// ── Provider 配置（v2：models 的 value 类型）────────────

export interface ProviderConfig {
	/** 套餐标识（匹配 plans 中的 key 和 quota-provider cache key） */
	plan: string;
	/** 该 provider 下的模型表 */
	models: Record<string, ModelEntry>;
}

// ── 套餐配置 ───────────────────────────────────────────

export interface PlanConfig {
	priority: number;
	peak?: {
		start: number;
		end: number;
		multiplier: number;
	};
	budgetTarget?: number;
	peakStrategy?: "conserve" | "normal";
	rollingWindowHours?: number;
	thresholds?: {
		rollingLimitPct?: number;
		weeklyLimitPct?: number;
	};
}

export interface StickinessConfig {
	minTurns: number;
	minInputTokens: number;
}

// ── 主配置（v2）─────────────────────────────────────────

export interface ModelPolicy {
	version: number;
	/** provider 名（来自 models.json） → 配置 */
	models: Record<string, ProviderConfig>;
	scenes: Record<string, string[]>;
	/** plan 名（与 quota-provider cache key 对齐） → 套餐配置 */
	plans: Record<string, PlanConfig>;
	stickiness: StickinessConfig;
}

// ── 用量快照（泛化：任何 plan 均可提取）───────────────────

export interface PlanQuota {
	/** 主窗口用量百分比（zhipu→tokensPct, opencode-go→rolling.usagePercent） */
	pct: number | null;
	/** 主窗口剩余秒数 */
	resetSec: number | null;
	/** 显示标签 */
	label: string;
}

export interface QuotaSnapshot {
	/** plan 名 → 用量快照 */
	plans: Record<string, PlanQuota>;
}

// ── 粘性信息 ───────────────────────────────────────────

export interface StickinessInfo {
	turns: number;
	inputTokens: number;
	justCompacted: boolean;
}

// ── 推荐结果 ───────────────────────────────────────────

export type RecommendResult = "ok" | "avoid";

export interface RecommendInfo {
	/** 推荐结论 */
	result: RecommendResult;
	/** 推荐理由 */
	reason: string;
}

// ── Setup 结果 ─────────────────────────────────────────

export interface SetupResult {
	json: string;
	summary: string;
}

// ── 工具函数 ───────────────────────────────────────────

/**
 * 从 ctx 中提取当前模型的 "provider/modelId" 字符串。
 */
export function getCurrentModelId(ctx: ExtensionContext): string {
	const model = ctx.model as { provider?: string; id?: string } | undefined;
	if (!model) return "";
	return `${model.provider ?? ""}/${model.id ?? ""}`;
}

/** session entries 的通用类型（getBranch() 返回值） */
export type SessionEntries = Array<{ type: string; [key: string]: unknown }>;

/** 安全类型断言 */
export function asSessionEntries(entries: unknown): SessionEntries {
	return entries as SessionEntries;
}

