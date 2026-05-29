/**
 * Infinite Context Engine — Core type definitions
 *
 * 段索引追踪器（SegmentTracker）和树压缩器（TreeCompressor）共用的类型。
 */

// ── Segment（段） ────────────────────────────────────

/** 一个"段"代表两次 user message 之间的完整对话轮次 */
export interface Segment {
	segId: string;
	turnRange: { start: number; end: number };
	userMessage: string;
	completed: boolean;
	filePath: string;
}

// ── Segment Entry 持久化类型 ─────────────────────────

export interface SegmentEntryData {
	segId: string;
	turnRange: { start: number; end: number };
	userMessage: string;
	completed: boolean;
	filePath: string;
}

export interface TurnEntryData {
	turnIndex: number;
	segId: string;
	toolCalls: string[];
}

// ── Tree Node ─────────────────────────────────────────

export interface TreeNode {
	nodeId: string;
	summary: string;
	tokenCount: number;
	children: TreeNode[];
	segId?: string;
}

// ── Compact Tree ─────────────────────────────────────

export interface CompactTree {
	treeId: string;
	root: TreeNode;
	totalTokens: number;
	createdAt: number;
	depth: number;
}

// ── Custom message types ─────────────────────────────

export const IC_COMPACT_START_TYPE = "ic-compact-start";
export const IC_COMPACT_END_TYPE = "ic-compact-end";
export const IC_COMPACT_STATS_TYPE = "ic-compact-stats";

// ── 配置 ─────────────────────────────────────────────

/**
 * 保留窗口配置（用于 /context-status 显示和 retention window 计算）
 * 注意：triggerCompression 不再使用此配置过滤段——所有段都参与压缩
 */
export const RETENTION_CONFIG = {
	maxSegments: 2,
	maxTurns: 8,
} as const;

/**
 * 上下文组装/压缩的全局配置
 */
export const IC_CONFIG = {
	/** dedup key 截断长度 */
	dedupKeyLength: 80,
	/** 默认 context window */
	defaultContextWindow: 200_000,
	/** 触发压缩的阈值（treeContextTokens / contextWindow） */
	compressionThreshold: 0.7,
	/** 预算上限（最大使用 context window 比例） */
	budgetRatio: 0.8,
	/** 预算分配：摘要部分比例 */
	summaryBudgetRatio: 0.3,
	/** 预算分配：保留原文部分比例 */
	retentionBudgetRatio: 0.7,
	/** 压缩超时（ms） */
	compressionTimeoutMs: 60_000,
	/** 最大重试次数 */
	maxRetryCount: 1,
	/** stderr 日志截断长度 */
	maxStderrLogLength: 500,
	/** stdout 日志截断长度 */
	maxStdoutLogLength: 1000,
} as const;
