/**
 * projection/prompts.ts 测试 — 7 个 prompt 生成函数 + formatBudget 4 样式
 *
 * 覆盖：
 * - formatBudget 4 种 style（percent/line/remaining/report）
 * - escapeXmlText（XML 注入防护）
 * - continuationPrompt / budgetLimitPrompt / objectiveUpdatedPrompt
 * - contextInjectionPrompt / stalenessReminderPrompt
 * - formatTaskList（5 状态分支 + 子任务）
 *
 * 纯函数测试，不 import Pi SDK。
 */
import { describe, expect, it } from "vitest";

import type { GoalTask } from "../../engine/task";
import { createGoalState } from "../../engine/goal";
import type { GoalRuntimeState } from "../../engine/types";
import {
	budgetLimitPrompt,
	continuationPrompt,
	contextInjectionPrompt,
	formatBudget,
	formatTaskList,
	objectiveUpdatedPrompt,
	stalenessReminderPrompt,
} from "../prompts";

// ── 辅助 ─────────────────────────────────────────────

function makeState(overrides?: Partial<GoalRuntimeState>): GoalRuntimeState {
	return {
		...createGoalState("test objective"),
		...overrides,
	};
}

function makeTask(id: number, status: GoalTask["status"], extra?: Partial<GoalTask>): GoalTask {
	return { id, description: `task ${id}`, status, lastUpdatedTurn: 0, ...extra };
}

// ── formatBudget 4 样式（FR-3.4 唯一收敛出口）────────

describe("formatBudget — 4 styles (FR-3.4)", () => {
	it("percent: Token + Time 百分比", () => {
		const state = makeState({
			budget: { tokenBudget: 1000, timeBudgetMinutes: 10, maxTurns: 5, maxStallTurns: 3 },
			tokensUsed: 500,
		});
		const out = formatBudget(state, 300, "percent"); // 300s = 5min / 10min = 50%
		expect(out).toContain("Token: 50%");
		expect(out).toContain("Time: 50%");
	});

	it("percent: 无预算 → 空字符串", () => {
		const state = makeState();
		expect(formatBudget(state, 0, "percent")).toBe("");
	});

	it("line: 剩余/总量格式", () => {
		const state = makeState({
			budget: { tokenBudget: 1000, timeBudgetMinutes: 10, maxTurns: 5, maxStallTurns: 3 },
			tokensUsed: 300,
		});
		const out = formatBudget(state, 120, "line"); // 120s = 2min used, 8min remaining
		expect(out).toContain("Tokens: 700/1000");
		expect(out).toContain("Time: 8m/10m");
	});

	it("remaining: used/total (N remaining) 格式", () => {
		const state = makeState({
			budget: { tokenBudget: 1000, timeBudgetMinutes: 10, maxTurns: 5, maxStallTurns: 3 },
			tokensUsed: 400,
		});
		const out = formatBudget(state, 60, "remaining"); // 60s=1min used, 9min remaining
		expect(out).toContain("Token: 400/1000 (600 remaining)");
		expect(out).toContain("Time: 1m/10m (9m remaining)");
	});

	it("report: 多行 usage + duration", () => {
		const state = makeState({
			budget: { tokenBudget: 1000, timeBudgetMinutes: 10, maxTurns: 5, maxStallTurns: 3 },
			tokensUsed: 700,
		});
		const out = formatBudget(state, 125, "report"); // 125s = 2m5s
		expect(out).toContain("Token usage: 700/1000");
		expect(out).toContain("Duration: 2m5s");
	});

	it("report: 无 token 预算 → 只有 duration", () => {
		const state = makeState();
		const out = formatBudget(state, 65, "report"); // 65s = 1m5s
		expect(out).toBe("Duration: 1m5s");
	});

	it("remaining clamp: 超预算不出现负数", () => {
		const state = makeState({
			budget: { tokenBudget: 100, timeBudgetMinutes: 1, maxTurns: 5, maxStallTurns: 3 },
			tokensUsed: 150, // 超 tokenBudget
		});
		const out = formatBudget(state, 120, "remaining"); // 120s 超 1min budget
		expect(out).toContain("(0 remaining)"); // 不出现负数
	});
});

// ── escapeXmlText（XML 注入防护）──────────────────────

describe("XML escaping in prompts", () => {
	it("objective 中的 <>& 被转义（continuationPrompt）", () => {
		const state = makeState({ objective: "<script>alert('x')</script> & data" });
		const out = continuationPrompt(state, 0);
		expect(out).toContain("&lt;script&gt;");
		expect(out).toContain("&amp; data");
		expect(out).not.toContain("<script>");
	});

	it("objectiveUpdatedPrompt 转义新旧 objective", () => {
		const state = makeState({ objective: "new <b>x</b>" });
		const out = objectiveUpdatedPrompt(state, "old <i>y</i> & z");
		expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
		expect(out).toContain("&lt;i&gt;y&lt;/i&gt;");
		expect(out).toContain("&amp; z");
	});
});

// ── continuationPrompt ───────────────────────────────

describe("continuationPrompt", () => {
	it("有未完成任务 → 显示 remaining task ids", () => {
		const state = makeState({
			tasks: [
				makeTask(1, "completed"),
				makeTask(2, "in_progress"),
				makeTask(3, "pending"),
			],
			currentTurnIndex: 3,
		});
		const out = continuationPrompt(state, 0);
		expect(out).toContain("Turn 3/");
		expect(out).toContain("1/3");
		expect(out).toContain("remaining: #2,#3");
	});

	it("无任务 → 提示 create_tasks", () => {
		const state = makeState({ tasks: [] });
		const out = continuationPrompt(state, 0);
		expect(out).toContain("Not created");
		expect(out).toContain("create_tasks");
	});

	it("全部完成 → ✓ 标记", () => {
		const state = makeState({
			tasks: [makeTask(1, "completed"), makeTask(2, "verified")],
		});
		const out = continuationPrompt(state, 0);
		expect(out).toContain("✓");
		expect(out).not.toContain("remaining:");
	});

	it("stallCount > 0 → 显示 stall 行", () => {
		const state = makeState({ stallCount: 2 });
		const out = continuationPrompt(state, 0);
		expect(out).toContain("Stall: 2/");
	});
});

// ── budgetLimitPrompt ────────────────────────────────

describe("budgetLimitPrompt", () => {
	it("token 维度 → TOKEN budget 提示", () => {
		const state = makeState({
			budget: { tokenBudget: 1000, timeBudgetMinutes: 10, maxTurns: 5, maxStallTurns: 3 },
			tokensUsed: 950,
			tasks: [makeTask(1, "in_progress")],
		});
		const out = budgetLimitPrompt(state, "token", 60);
		expect(out).toContain("TOKEN budget");
		expect(out).toContain("Tokens used: 950 / 1000");
		expect(out).toContain("wrap up immediately");
	});

	it("time 维度 → time budget 提示", () => {
		const state = makeState({
			budget: { tokenBudget: 1000, timeBudgetMinutes: 10, maxTurns: 5, maxStallTurns: 3 },
			tasks: [makeTask(1, "in_progress")],
		});
		const out = budgetLimitPrompt(state, "time", 540); // 540s = 9m
		expect(out).toContain("time budget");
		expect(out).toContain("Time elapsed: 9m0s / 10 min");
	});

	it("全部完成 → All tasks completed", () => {
		const state = makeState({ tasks: [makeTask(1, "completed")] });
		const out = budgetLimitPrompt(state, "token", 0);
		expect(out).toContain("All tasks completed");
	});
});

// ── objectiveUpdatedPrompt ───────────────────────────

describe("objectiveUpdatedPrompt", () => {
	it("显示新旧 objective + 指令", () => {
		const state = makeState({ objective: "new obj" });
		const out = objectiveUpdatedPrompt(state, "old obj");
		expect(out).toContain("Objective updated");
		expect(out).toContain("Previous objective: old obj");
		expect(out).toContain("new obj");
		expect(out).toContain("supersedes");
	});
});

// ── contextInjectionPrompt ───────────────────────────

describe("contextInjectionPrompt", () => {
	it("包含 objective/status/turn/progress + 规则", () => {
		const state = makeState({
			status: "active",
			currentTurnIndex: 2,
			tasks: [makeTask(1, "completed"), makeTask(2, "pending")],
			budget: { tokenBudget: 1000, timeBudgetMinutes: 10, maxTurns: 5, maxStallTurns: 3 },
			tokensUsed: 200,
		});
		const out = contextInjectionPrompt(state, 60);
		expect(out).toContain("GOAL mode activated");
		expect(out).toContain("Status: active");
		expect(out).toContain("Turn: 2/5");
		expect(out).toContain("Task progress: 1/2");
		expect(out).toContain("Token: 20%"); // 200/1000
		expect(out).toContain("create_tasks");
	});
});

// ── stalenessReminderPrompt ──────────────────────────

describe("stalenessReminderPrompt", () => {
	it("allTerminal=true → 提示 complete/cancel", () => {
		const state = makeState({
			tasks: [makeTask(1, "completed"), makeTask(2, "verified")],
		});
		const out = stalenessReminderPrompt(state, [], true);
		expect(out).toContain("All tasks completed");
		expect(out).toContain("complete_goal");
	});

	it("有 stale tasks → 列出 stale task 详情", () => {
		const state = makeState({ currentTurnIndex: 15 });
		const staleTasks = [
			{
				task: makeTask(3, "in_progress"),
				staleTurns: 12,
				staleSubtasks: [{ text: "sub A", staleTurns: 8 }],
			},
		];
		const out = stalenessReminderPrompt(state, staleTasks, false);
		expect(out).toContain("#3");
		expect(out).toContain("12 turns idle");
		expect(out).toContain("sub A");
		expect(out).toContain("8 turns");
	});
});

// ── formatTaskList（5 状态 + 子任务）─────────────────

describe("formatTaskList", () => {
	it("空数组 → No tasks yet", () => {
		expect(formatTaskList([])).toBe("No tasks yet.");
	});

	it("5 种状态分组渲染 + 汇总", () => {
		const tasks: GoalTask[] = [
			makeTask(1, "in_progress"),
			makeTask(2, "pending", { verification: { method: "npm test", expected: "pass" } }),
			makeTask(3, "completed", { evidence: "done" }),
			makeTask(4, "verified", { verification: { method: "lint", expected: "0 err", actual: "0 err" } }),
			makeTask(5, "cancelled"),
		];
		const out = formatTaskList(tasks);
		// active 分组
		expect(out).toContain("In progress / Pending (2):");
		expect(out).toContain("● #1:");
		expect(out).toContain("☐ #2:");
		expect(out).toContain("[验证: npm test]");
		// verified 分组
		expect(out).toContain("Verified (1):");
		expect(out).toContain("◉ #4:");
		expect(out).toContain("actual: 0 err");
		// completed 分组
		expect(out).toContain("Completed (1):");
		expect(out).toContain("✓ #3:");
		expect(out).toContain("done");
		// cancelled 分组
		expect(out).toContain("Cancelled (1):");
		expect(out).toContain("✗ #5:");
		// 汇总
		expect(out).toContain("2/5 completed");
		expect(out).toContain("1 cancelled");
	});

	it("子任务渲染", () => {
		const tasks: GoalTask[] = [
			{
				id: 1,
				description: "parent",
				status: "in_progress",
				lastUpdatedTurn: 0,
				subtasks: [
					{ id: 1, text: "sub done", status: "completed" },
					{ id: 2, text: "sub active", status: "in_progress" },
					{ id: 3, text: "sub pending", status: "pending" },
				],
			},
		];
		const out = formatTaskList(tasks);
		expect(out).toContain("✓ #1.1: sub done");
		expect(out).toContain("● #1.2: sub active");
		expect(out).toContain("○ #1.3: sub pending");
	});

	it("completed 有 verification → awaiting verification 标记", () => {
		const tasks: GoalTask[] = [
			makeTask(1, "completed", {
				evidence: "done",
				verification: { method: "test", expected: "pass" },
			}),
		];
		const out = formatTaskList(tasks);
		expect(out).toContain("[awaiting verification]");
	});
});
