/**
 * Evolution Engine — 类型定义
 *
 * 所有 status/target/severity 使用联合字面量（不使用 enum），
 * 与项目其他 extension 保持一致。
 */

// ── 核心数据模型 ─────────────────────────────────────

/** LLM Judge 产出的单条进化建议 */
export interface EvolutionSuggestion {
	/** UUID */
	id: string;
	/** 建议目标类型 */
	target: "claude-md" | "skill";
	/** 要修改的文件绝对路径 */
	targetPath: string;
	/** 严重程度 */
	severity: "high" | "medium" | "low";
	/** 0-1 置信度 */
	confidence: number;
	/** 建议标题 */
	title: string;
	/** 建议内容描述 */
	description: string;
	/** 数据支撑说明 */
	rationale: string;
	/** unified diff */
	diff: string;
	/** 当前状态，初始值为 "pending" */
	status: "pending" | "approved" | "rejected" | "applied" | "failed";
}

/** 待审批的建议文件（suggestions/pending.json） */
export interface PendingFile {
	/** ISO timestamp — 生成时间 */
	generatedAt: string;
	/** 使用的 Phase 2 报告路径 */
	reportUsed: string;
	/** 建议列表 */
	suggestions: EvolutionSuggestion[];
}

/** 操作历史条目（history.jsonl 每行一条） */
export interface HistoryEntry {
	/** ISO timestamp */
	timestamp: string;
	/** 操作类型 */
	action: "apply" | "rollback";
	/** 对应 suggestion ID */
	suggestionId: string;
	/** 目标文件路径 */
	targetPath: string;
	/** 备份文件路径 */
	backupPath: string;
	/** 应用的 diff */
	diff: string;
	/** 建议标题（用于回滚展示） */
	title: string;
	/** apply 时的 git commit SHA，用于 rollback 时 git revert */
	commitSha?: string;
}

// ── 自动触发 ─────────────────────────────────────────

/** 自动触发规则命中标记 */
export interface AutoTriggerFlag {
	/** 触发规则 */
	rule: "token-decline" | "skill-dormant" | "error-spike";
	/** ISO timestamp — 触发时间 */
	triggeredAt: string;
	/** 具体数值描述 */
	detail: string;
}

// ── Judge 输入 ────────────────────────────────────────

/** LLM Judge 子进程的输入参数 */
export interface JudgeInput {
	/** 分析目标 */
	target: "all" | "claude-md" | "skills" | "merge-reviewer";
	/** Phase 2 JSON 报告路径 */
	reportPath: string;
	/** 构建的 prompt 临时文件路径 */
	promptFilePath: string;
}

// ── Command 参数与返回 ───────────────────────────────

/** /evolve 命令参数 */
export interface EvolveCommandParams {
	/** 分析目标，默认 "all" */
	target: "all" | "claude-md" | "skills";
	/** 时间范围，默认 "7d" */
	since: string;
	/** 抽样 session 数 */
	sample: number | undefined;
}

/** /evolve-apply 命令参数 */
export interface EvolveApplyCommandParams {
	/** 操作类型：list 只展示，apply 执行，skip 跳过 */
	action: "list" | "apply" | "skip";
	/** 建议索引（0-based），apply/skip 时必需 */
	index: number | undefined;
}

/** apply 操作返回值 */
export interface ApplyResult {
	success: boolean;
	reason?: string;
	/** 备份文件的实际路径（success 时有值） */
	backupPath?: string;
	/** apply 时的 git commit SHA（git commit 成功时有值） */
	commitSha?: string;
}

/** rollback 操作返回值 */
export interface RollbackResult {
	success: boolean;
	reason?: string;
}

// ── 统计 ─────────────────────────────────────────────

/** /evolve-stats 仪表盘数据 */
export interface StatsData {
	/** 工具调用总数 */
	toolCalls: number;
	/** token 输入总量 */
	tokenInput: number;
	/** token 输出总量 */
	tokenOutput: number;
	/** 高频 skill 排名 */
	topSkills: Array<{ name: string; count: number }>;
	/** 高失败率工具排名 */
	topFailures: Array<{ tool: string; rate: number }>;
}

/** 所有 command handler 的统一返回结构 */
export interface CommandResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

// ── 路径常量 ─────────────────────────────────────────

/** evolution-engine 使用的目录集合 */
export interface Dirs {
	/** ~/.pi/agent/evolution-data */
	evolutionDir: string;
	/** ~/.pi/agent/evolution-data/reports */
	reportsDir: string;
	/** ~/.pi/agent/evolution-data/tmp */
	tmpDir: string;
	/** extension 源码下 src/templates/ 的绝对路径 */
	templateDir: string;
}
