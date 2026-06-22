/**
 * Tool result 构建器（projection 层）
 *
 * 迁移自 src/tool-handler.ts 的 makeGoalResult / errorResult 和
 * src/action-handlers.ts 的 buildBudgetReport。
 *
 * FR-3.4：budget 格式化收敛到 prompts.ts 的 formatBudget。
 */

import { SECONDS_PER_MINUTE } from "../constants";
import type { GoalTask } from "../engine/task";
import type { GoalRuntimeState } from "../engine/types";
import type { ToolActionResult } from "../service";
import type { GoalSession } from "../session";
import { formatBudget } from "./prompts";

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
 * 构造标准成功结果，附带 budget 后缀。
 *
 * FR-3.4：budget 拼接通过 formatBudget(state, timeUsedSeconds, "remaining") 收敛，
 * 替代旧 makeGoalResult 内联的 budgetInfo 数组拼接逻辑。
 *
 * @param session goal session（读 state）
 * @param text 结果正文
 * @param timeUsedSeconds 累计耗时秒数（adapter/service 计算后传入）
 */
export function makeGoalResult(
	session: GoalSession,
	text: string,
	timeUsedSeconds: number,
): ToolActionResult {
	const state = session.state;
	if (!state) {
		// P1-1: 不再抛异常，返回标准 isError 结果
		return errorResult("No active goal");
	}
	const budgetStr = formatBudget(state, timeUsedSeconds, "remaining");
	const suffix = budgetStr ? `\n\n${budgetStr}` : "";
	return {
		content: [{ type: "text", text: text + suffix }],
		details: {
			action: "update",
			tasks: state.tasks.map((t) => ({ ...t })),
			goalId: state.goalId,
			status: state.status,
		} satisfies GoalManagerDetails,
	};
}

/** 构造标准的错误结果（避免重复的 content 模板）。 */
export function errorResult(message: string): ToolActionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
	};
}

/**
 * 构建 goal 完成时的 budget 报告（多行数组）。
 *
 * FR-3.4：budget 行通过 formatBudget(state, timeUsedSeconds, "report") 收敛，
 * 替代旧 buildBudgetReport 的内联拼接。total turns / tasks completed 行保持独立。
 *
 * @returns 报告行数组（complete_goal 的 result 文本用它 join("\n")）
 */
export function buildBudgetReport(state: GoalRuntimeState, timeUsedSeconds: number): string[] {
	const lines: string[] = [];
	lines.push(`Total turns: ${state.currentTurnIndex}`);
	const completedCount = state.tasks.filter(
		(t) => t.status === "completed" || t.status === "verified",
	).length;
	lines.push(`Tasks completed: ${completedCount}/${state.tasks.length}`);
	if (state.budget.tokenBudget) {
		lines.push(`Token usage: ${state.tokensUsed}/${state.budget.tokenBudget}`);
	}
	lines.push(
		`Duration: ${Math.floor(timeUsedSeconds / SECONDS_PER_MINUTE)}m${Math.floor(timeUsedSeconds % SECONDS_PER_MINUTE)}s`,
	);
	return lines;
}
