// ── Evolution data types ───────────────────────────────

/** 每日汇总（按 session 聚合，增量写入） */
export interface DailySummary {
	date: string;
	sessions: SessionRecord[];
	toolCalls: ToolCallStats;
	tokenUsage: TokenUsageStats;
	skillTriggers: Record<string, number>;
	agentCalls: Record<string, number>;
}

export interface SessionRecord {
	sessionId: string;
	cwd: string;
	startTime: string;
	endTime?: string;
	turns: number;
}

export interface ToolCallStats {
	total: number;
	byTool: Record<string, number>;
	failures: Record<string, number>;
}

export interface TokenUsageStats {
	totalInput: number;
	totalOutput: number;
	turns: number;
}

/** 工具执行累积统计 */
export interface ToolStats {
	byTool: Record<
		string,
		{
			calls: number;
			failures: number;
		}
	>;
	updatedAt: string;
}

/** Skill 触发累积统计 */
export interface SkillTriggerStats {
	bySkill: Record<
		string,
		{
			triggers: number;
			lastTriggered: string;
		}
	>;
	updatedAt: string;
}

/** Session 清单记录 */
export interface SessionManifestEntry {
	sessionId: string;
	cwd: string;
	startTime: string;
	endTime?: string;
	turns: number;
	totalTokens: number;
}

/** Session 清单文件 */
export interface SessionManifest {
	entries: SessionManifestEntry[];
	updatedAt: string;
}

/** 内存中当前 turn 的 buffer */
export interface TurnBuffer {
	toolCalls: { toolName: string; success: boolean }[];
	tokenUsage: { input: number; output: number } | null;
	skillTriggers: string[];
	agentCalls: string[];
}

export function emptyDailySummary(date: string): DailySummary {
	return {
		date,
		sessions: [],
		toolCalls: { total: 0, byTool: {}, failures: {} },
		tokenUsage: { totalInput: 0, totalOutput: 0, turns: 0 },
		skillTriggers: {},
		agentCalls: {},
	};
}

export function emptyToolStats(): ToolStats {
	return { byTool: {}, updatedAt: "" };
}

export function emptySkillTriggerStats(): SkillTriggerStats {
	return { bySkill: {}, updatedAt: "" };
}

export function emptySessionManifest(): SessionManifest {
	return { entries: [], updatedAt: "" };
}

export function emptyTurnBuffer(): TurnBuffer {
	return { toolCalls: [], tokenUsage: null, skillTriggers: [], agentCalls: [] };
}
