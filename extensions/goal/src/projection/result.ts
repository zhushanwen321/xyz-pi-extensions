/**
 * Tool result 类型 + 错误结果构造器（projection 层）
 *
 * 历史背景：旧版有 makeGoalResult / buildBudgetReport / errorResult 三个构造器，
 * 重构后 action 结果由 service 层内联构造（makeResult），budget 格式化收敛到
 * prompts.ts 的 formatBudget。本文件保留两样东西：
 * - GoalManagerDetails：goal_manager tool 返回结果的 details 字段类型（index.ts 消费）
 * - errorResult：跨层的标准错误结果构造器（service / tool-adapter 共用，DRY）
 */

import type { GoalTask } from "../engine/task";
import type { ToolActionResult } from "../service";

// ── Tool Details Types ───────────────────────────────

/**
 * goal_manager tool 返回结果的 details 字段类型。
 * 被 adapters/actions.ts 和 adapters/tool-adapter.ts 使用。
 */
export interface GoalManagerDetails {
	action: string;
	tasks: GoalTask[];
	goalId: string;
	status: string;
}

// ── Result Builders ──────────────────────────────────

/**
 * 构造标准的错误结果（避免重复的 content 模板）。
 *
 * 唯一定义点：service.ts / tool-adapter.ts 都 import 此函数，消除三处重复。
 */
export function errorResult(message: string): ToolActionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
	};
}
