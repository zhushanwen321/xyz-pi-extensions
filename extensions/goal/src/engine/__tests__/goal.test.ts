/**
 * engine/goal.ts 测试 — Goal 7 态状态机 + createGoalState
 */
import { describe, expect, it } from "vitest";

import {
	createGoalState,
	isActiveStatus,
	isTerminalStatus,
	transitionStatus,
} from "../goal";
import type { GoalStatus } from "../types";

const TERMINAL: GoalStatus[] = ["complete", "budget_limited", "time_limited", "cancelled"];
const NON_TERMINAL: GoalStatus[] = ["active", "blocked"]; // ADR-002：paused 已删除
const ALL = [...NON_TERMINAL, ...TERMINAL];

// ── isTerminalStatus / isActiveStatus ─────────────────

describe("isTerminalStatus", () => {
	for (const s of TERMINAL) {
		it(`${s} → terminal`, () => expect(isTerminalStatus(s)).toBe(true));
	}
	for (const s of NON_TERMINAL) {
		it(`${s} → NOT terminal`, () => expect(isTerminalStatus(s)).toBe(false));
	}
});

describe("isActiveStatus", () => {
	it("active → true", () => expect(isActiveStatus("active")).toBe(true));
	for (const s of ALL) {
		if (s === "active") continue;
		it(`${s} → false`, () => expect(isActiveStatus(s)).toBe(false));
	}
});

// ── transitionStatus（终态守卫，宽松）──────────────────

describe("transitionStatus — 终态不可覆盖", () => {
	for (const terminal of TERMINAL) {
		for (const target of ALL) {
			it(`terminal ${terminal} → ${target} 保持 ${terminal}`, () => {
				expect(transitionStatus(terminal, target)).toBe(terminal);
			});
		}
	}
});

describe("transitionStatus — 非终态可被任意覆盖", () => {
	for (const current of NON_TERMINAL) {
		for (const target of ALL) {
			it(`${current} → ${target} 返回 ${target}`, () => {
				expect(transitionStatus(current, target)).toBe(target);
			});
		}
	}
});

// ── createGoalState 初始值 ───────────────────────────

describe("createGoalState — 初始值", () => {
	it("status = active", () => expect(createGoalState("obj").status).toBe("active"));
	it("objective 透传", () => expect(createGoalState("my obj").objective).toBe("my obj"));
	it("tasks 为空数组", () => expect(createGoalState("obj").tasks).toEqual([]));
	it("stallCount = 0", () => expect(createGoalState("obj").stallCount).toBe(0));
	it("tokensUsed = 0", () => expect(createGoalState("obj").tokensUsed).toBe(0));
	it("timeUsedSeconds = 0", () => expect(createGoalState("obj").timeUsedSeconds).toBe(0));
	it("goalId 非空", () => {
		expect(createGoalState("obj").goalId).toBeTruthy();
		expect(typeof createGoalState("obj").goalId).toBe("string");
	});
	it("两个 createGoalState 生成不同 goalId", () => {
		expect(createGoalState("obj").goalId).not.toBe(createGoalState("obj").goalId);
	});
	it("currentTurnIndex = 0", () => expect(createGoalState("obj").currentTurnIndex).toBe(0));
	it("completedAtTurnIndex = undefined", () => {
		expect(createGoalState("obj").completedAtTurnIndex).toBeUndefined();
	});
	// FR-6.2: 4 个独立预警 flag
	it("tokenWarning70Sent = false", () => expect(createGoalState("obj").tokenWarning70Sent).toBe(false));
	it("tokenWarning90Sent = false", () => expect(createGoalState("obj").tokenWarning90Sent).toBe(false));
	it("timeWarning70Sent = false", () => expect(createGoalState("obj").timeWarning70Sent).toBe(false));
	it("timeWarning90Sent = false", () => expect(createGoalState("obj").timeWarning90Sent).toBe(false));
});

describe("createGoalState — budget 合并", () => {
	it("无 overrides 用 DEFAULT_BUDGET", () => {
		const s = createGoalState("obj");
		expect(s.budget).toEqual({ maxStallTurns: 5, maxTurns: 50 });
	});
	it("tokenBudget override", () => {
		expect(createGoalState("obj", { tokenBudget: 10000 }).budget.tokenBudget).toBe(10000);
	});
	it("maxTurns override", () => {
		expect(createGoalState("obj", { maxTurns: 100 }).budget.maxTurns).toBe(100);
	});
	it("多字段 override", () => {
		const s = createGoalState("obj", { tokenBudget: 5000, maxStallTurns: 3 });
		expect(s.budget.tokenBudget).toBe(5000);
		expect(s.budget.maxStallTurns).toBe(3);
		expect(s.budget.maxTurns).toBe(50);
	});
});
