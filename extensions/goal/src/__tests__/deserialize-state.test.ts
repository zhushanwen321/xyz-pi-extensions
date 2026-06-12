/**
 * P1 测试：deserializeState — 旧格式向后兼容
 */
import { describe, expect, it } from "vitest";

import { deserializeState } from "../state";

describe("deserializeState — 向后兼容", () => {
	it("旧数据无 verification 字段 → verification 为 undefined", () => {
		const data = {
			goalId: "g1",
			objective: "test",
			status: "active",
			tasks: [{
				id: 1,
				description: "task 1",
				status: "completed",
				lastUpdatedTurn: 0,
			}],
			stallCount: 0,
			tokensUsed: 0,
			timeStartedAt: 1000,
			timeUsedSeconds: 0,
			budget: { maxStallTurns: 5, maxTurns: 50 },
		};
		const state = deserializeState(data);
		expect(state.tasks[0]!.verification).toBeUndefined();
	});

	it("旧数据有 turnCount 字段 → 被忽略（不报错）", () => {
		const data = {
			goalId: "g1",
			objective: "test",
			status: "active",
			tasks: [],
			stallCount: 0,
			tokensUsed: 0,
			timeStartedAt: 1000,
			timeUsedSeconds: 0,
			budget: { maxStallTurns: 5, maxTurns: 50 },
			turnCount: 42,
		};
		const state = deserializeState(data);
		expect(state.currentTurnIndex).toBe(0);
		// turnCount 不存在于 GoalRuntimeState 接口
		expect("turnCount" in state).toBe(false);
	});

	it("新数据有 verification 字段 → 正确还原", () => {
		const data = {
			goalId: "g1",
			objective: "test",
			status: "active",
			tasks: [{
				id: 1,
				description: "task 1",
				status: "completed",
				lastUpdatedTurn: 5,
				verification: { method: "pnpm test", expected: "all pass", actual: "passed" },
			}],
			stallCount: 0,
			tokensUsed: 0,
			timeStartedAt: 1000,
			timeUsedSeconds: 0,
			budget: { maxStallTurns: 5, maxTurns: 50 },
		};
		const state = deserializeState(data);
		expect(state.tasks[0]!.verification).toEqual({
			method: "pnpm test",
			expected: "all pass",
			actual: "passed",
		});
	});

	it("旧数据 verified 状态的 task → 正常加载", () => {
		const data = {
			goalId: "g1",
			objective: "test",
			status: "active",
			tasks: [{
				id: 1,
				description: "task 1",
				status: "verified",
				lastUpdatedTurn: 3,
			}],
			stallCount: 0,
			tokensUsed: 0,
			timeStartedAt: 1000,
			timeUsedSeconds: 0,
			budget: { maxStallTurns: 5, maxTurns: 50 },
		};
		const state = deserializeState(data);
		expect(state.tasks[0]!.status).toBe("verified");
	});

	it("缺少字段时给默认值", () => {
		const data = {
			goalId: "g1",
			objective: "test",
			status: "active",
			tasks: [],
		};
		const state = deserializeState(data);
		expect(state.stallCount).toBe(0);
		expect(state.tokensUsed).toBe(0);
		expect(state.budget.maxTurns).toBe(50);
		expect(state.budget.maxStallTurns).toBe(5);
	});
});
