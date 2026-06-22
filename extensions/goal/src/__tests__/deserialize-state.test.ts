/**
 * FR-5/FR-7.3: deserializeState — 新格式严格解析（字段缺失 throw）
 */
import { describe, expect, it } from "vitest";

import { deserializeState } from "../persistence";

const FULL_DATA = {
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
	lastProgressTurn: 0,
	budgetLimitSteeringSent: false,
	objectiveUpdatedAt: 1000,
	lastBlockerReason: null,
	tokenWarning70Sent: false,
	tokenWarning90Sent: false,
	timeWarning70Sent: false,
	timeWarning90Sent: false,
	lastTurnTokensUsed: 0,
	currentTurnIndex: 0,
};

describe("deserializeState — 新格式严格解析", () => {
	it("完整新格式数据 → 正确还原", () => {
		const state = deserializeState(FULL_DATA);
		expect(state.tasks[0]!.verification).toEqual({
			method: "pnpm test", expected: "all pass", actual: "passed",
		});
		expect(state.tokenWarning70Sent).toBe(false);
	});

	it("task 缺 status 字段 → throw（FR-5）", () => {
		const data = { ...FULL_DATA, tasks: [{ id: 1, description: "t1", lastUpdatedTurn: 0 }] };
		expect(() => deserializeState(data)).toThrow();
	});

	it("顶层缺 budget → throw（不再兜底默认值）", () => {
		const data = { goalId: "g1", objective: "test", status: "active", tasks: [] };
		expect(() => deserializeState(data)).toThrow();
	});

	it("缺 tokenWarning70Sent → throw（新格式必须包含 4 个独立 flag）", () => {
		const data = { ...FULL_DATA };
		delete (data as Record<string, unknown>).tokenWarning70Sent;
		expect(() => deserializeState(data)).toThrow();
	});

	it("subtasks 新格式正确解析", () => {
		const data = {
			...FULL_DATA,
			tasks: [{
				id: 1, description: "t1", status: "in_progress", lastUpdatedTurn: 0,
				subtasks: [{ id: 1, text: "sub", status: "pending", lastUpdatedTurn: 0 }],
			}],
		};
		const state = deserializeState(data);
		expect(state.tasks[0]!.subtasks).toHaveLength(1);
		expect(state.tasks[0]!.subtasks![0]!.status).toBe("pending");
	});

	it("completedAtTurnIndex 可选（缺失 → undefined）", () => {
		const state = deserializeState(FULL_DATA);
		expect(state.completedAtTurnIndex).toBeUndefined();
	});

	it("有 completedAtTurnIndex → 正确还原", () => {
		const data = { ...FULL_DATA, completedAtTurnIndex: 42 };
		expect(deserializeState(data).completedAtTurnIndex).toBe(42);
	});
});
