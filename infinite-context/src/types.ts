/**
 * Infinite Context Engine — Core type definitions
 *
 * 段索引追踪器（SegmentTracker）和树压缩器（TreeCompressor）共用的类型。
 */

// ── Segment（段） ────────────────────────────────────

/** 一个"段"代表两次 user message 之间的完整对话轮次 */
export interface Segment {
	/** 段唯一 ID，格式 seg_N（N 为递增整数） */
	segId: string;
	/** 该段覆盖的 turn 索引范围 */
	turnRange: { start: number; end: number };
	/** 触发该段的 user message 文本 */
	userMessage: string;
	/** 是否已完成（新 user message 到来时标记前段完成） */
	completed: boolean;
	/** 段原始数据文件路径（.pi/infinite-context/<sessionId>/seg_N.json） */
	filePath: string;
}

// ── Segment Entry 持久化类型 ─────────────────────────

/** appendEntry("ic-segment", ...) 的 data 结构 */
export interface SegmentEntryData {
	segId: string;
	turnRange: { start: number; end: number };
	userMessage: string;
	completed: boolean;
	filePath: string;
}

/** appendEntry("ic-turn", ...) 的 data 结构 */
export interface TurnEntryData {
	turnIndex: number;
	segId: string;
	/** 该 turn 中工具调用的摘要 */
	toolCalls: string[];
}

// ── Tree Node（树节点，Task 2 使用） ─────────────────

/** 树压缩后的节点 */
export interface TreeNode {
	/** 节点 ID */
	nodeId: string;
	/** 节点摘要文本 */
	summary: string;
	/** 估算 token 数 */
	tokenCount: number;
	/** 子节点 */
	children: TreeNode[];
	/** 关联的段 ID（叶节点指向 Segment.segId） */
	segId?: string;
}

// ── Compact Tree（压缩树，Task 2 使用） ──────────────

/** 完整的压缩树结构 */
export interface CompactTree {
	/** 树 ID */
	treeId: string;
	/** 根节点 */
	root: TreeNode;
	/** 树的总 token 数（所有节点 tokenCount 之和） */
	totalTokens: number;
	/** 创建时间戳 */
	createdAt: number;
	/** 树的深度 */
	depth: number;
}

// ── Retention Gradient ─────────────────────────────────

/** 保留梯度：根据 context 使用百分比决定保留多少个段 */
export const RETENTION_GRADIENT: ReadonlyArray<{
	usageMax: number;
	retainCount: number;
}> = [
	{ usageMax: 50, retainCount: 9999 },
	{ usageMax: 71, retainCount: 8 },
	{ usageMax: 81, retainCount: 4 },
	{ usageMax: 91, retainCount: 2 },
	{ usageMax: 101, retainCount: 1 },
] as const;

// ── Compression Config ─────────────────────────────────

/** 树压缩的参数配置 */
export const COMPRESSION_CONFIG = {
	ratioMin: 0.2,
	ratioMax: 0.5,
	perSegmentTokens: 63,
} as const;

// ── IContextUsage ───────────────────────────────────────

/** 当前 context 使用情况快照 */
export interface IContextUsage {
	contextWindow: number;
	usedTokens: number;
	percent: number;
}
