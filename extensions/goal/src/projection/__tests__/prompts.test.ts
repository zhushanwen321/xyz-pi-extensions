/**
 * projection/prompts.ts 测试 — prompt 生成函数 + formatBudget 4 样式
 *
 * 覆盖：
 * - formatBudget 4 种 style（percent/line/remaining/report）
 * - escapeXmlText（XML 注入防护）
 * - continuationPrompt / budgetLimitPrompt / objectiveUpdatedPrompt / contextInjectionPrompt
 *
 * 注：stalenessReminderPrompt / formatTaskList 随 task CRUD 删除（#6 基于 lastUpdatedTurn 重做 staleness）。
 *
 * 纯函数测试，不 import Pi SDK。
 */
import { describe, expect, it } from "vitest";

import { createGoalState } from "../../engine/goal";
import type { GoalRuntimeState } from "../../engine/types";
import {
	budgetLimitPrompt,
	contextInjectionPrompt,
	continuationPrompt,
	formatBudget,
	objectiveUpdatedPrompt,
} from "../prompts";

// ── 辅助 ─────────────────────────────────────────────

function makeState(overrides?: Partial<GoalRuntimeState>): GoalRuntimeState {
	return {
		...createGoalState("test objective"),
		...overrides,
	};
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
	it("含 objective + Turn + Completion audit 段落", () => {
		const state = makeState({ currentTurnIndex: 3 });
		const out = continuationPrompt(state, 0);
		expect(out).toContain("Turn 3/");
		expect(out).toContain("test objective");
		expect(out).toContain("Completion audit");
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
		});
		const out = budgetLimitPrompt(state, "token", 60);
		expect(out).toContain("TOKEN budget");
		expect(out).toContain("Tokens used: 950 / 1000");
		expect(out).toContain("wrap up immediately");
	});

	it("time 维度 → time budget 提示", () => {
		const state = makeState({
			budget: { tokenBudget: 1000, timeBudgetMinutes: 10, maxTurns: 5, maxStallTurns: 3 },
		});
		const out = budgetLimitPrompt(state, "time", 540); // 540s = 9m
		expect(out).toContain("time budget");
		expect(out).toContain("Time elapsed: 9m0s / 10 min");
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
	it("包含 objective/status/turn + 预算百分比 + 规则", () => {
		const state = makeState({
			status: "active",
			currentTurnIndex: 2,
			budget: { tokenBudget: 1000, timeBudgetMinutes: 10, maxTurns: 5, maxStallTurns: 3 },
			tokensUsed: 200,
		});
		const out = contextInjectionPrompt(state, 60);
		expect(out).toContain("GOAL mode activated");
		expect(out).toContain("Status: active");
		expect(out).toContain("Turn: 2/5");
		expect(out).toContain("Token: 20%"); // 200/1000
		expect(out).toContain("test objective");
	});
});
