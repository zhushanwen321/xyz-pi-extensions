/**
 * Model Switch — 共享类型定义
 *
 * 所有跨文件的类型、常量集中管理。
 * 参考 pi-extension-standards §3.2。
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── 配置类型 ────────────────────────────────────────────

export interface ModelEntry {
	/** Pi provider 名（如 "zhipu"） */
	provider: string;
	/** Pi model ID（如 "glm-5.1-plus"） */
	modelId: string;
	/** 套餐标识（关联 plans 中的 key） */
	plan: string;
	/** 模型能力标记 */
	capabilities: string[];
}

export interface PlanConfig {
	/** 优先级（越小越优先） */
	priority: number;
	/** 高峰期配置 */
	peak?: {
		start: number;
		end: number;
		multiplier: number;
	};
	/** 预算目标百分比 */
	budgetTarget?: number;
}

export interface StickinessConfig {
	minTurns: number;
	minInputTokens: number;
}

export interface ModelPolicy {
	version: number;
	models: Record<string, ModelEntry>;
	scenes: Record<string, string[]>;
	plans: Record<string, PlanConfig>;
	stickiness: StickinessConfig;
}

// ── 推荐引擎类型 ─────────────────────────────────────────

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

// ── Setup 类型 ──────────────────────────────────────────

export interface SetupResult {
	/** 生成的配置 JSON 字符串 */
	json: string;
	/** 格式化的可读摘要 */
	summary: string;
}

// ── 工具函数 ────────────────────────────────────────────

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
