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
	/** 高峰期策略：conserve=节省 Z.ai，normal=不特殊处理 */
	peakStrategy?: "conserve" | "normal";
	/** 滚动窗口大小（小时） */
	rollingWindowHours?: number;
	/** opencode-go 套餐限额阈值 */
	thresholds?: {
		rollingLimitPct?: number;
		weeklyLimitPct?: number;
	};
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

// ── 用量快照类型 ─────────────────────────────────────────

export interface QuotaSnapshot {
	zai: { pct: number; resetSec: number } | null;
	ocg: {
		rollingPct: number;
		rollingResetSec: number;
		weeklyPct: number;
		weeklyResetSec: number;
		monthlyPct: number;
		monthlyResetSec: number;
	} | null;
}

// ── 粘性信息类型 ─────────────────────────────────────────

export interface StickinessInfo {
	/** switch/compaction 后的 assistant turn 数 */
	turns: number;
	/** 累积 input tokens */
	inputTokens: number;
	/** compaction 后 ≤1 turn */
	justCompacted: boolean;
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

/** 安全类型断言：getBranch() 返回 SessionEntry[]，需要通过 unknown 中转 */
export function asSessionEntries(entries: unknown): SessionEntries {
	return entries as SessionEntries;
}
