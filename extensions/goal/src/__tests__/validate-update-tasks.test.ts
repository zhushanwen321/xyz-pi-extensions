/**
 * P0 测试：validateUpdateTasks — 状态转换验证
 */
import { describe, expect, it } from "vitest";

import { validateUpdateTasks } from "../action-handlers";
import { type GoalRuntimeState, type GoalTask } from "../state";

const makeState = (tasks: GoalTask[]): GoalRuntimeState => ({
	goalId: "test",
	objective: "test",
	status: "active",
	tasks,
	stallCount: 0,
	tokensUsed: 0,
	timeStartedAt: Date.now(),
	timeUsedSeconds: 0,
	budget: { maxStallTurns: 5, maxTurns: 50 },
	lastProgressTurn: 0,
	budgetLimitSteeringSent: false,
	objectiveUpdatedAt: Date.now(),
	lastBlockerReason: null,
	budgetWarning70Sent: false,
	budgetWarning90Sent: false,
	lastTurnTokensUsed: 0,
	currentTurnIndex: 1,
});

const makeTask = (overrides: Partial<GoalTask> = {}): GoalTask => ({
	id: 1,
	description: "test task",
	status: "pending",
	lastUpdatedTurn: 0,
	...overrides,
});

describe("validateUpdateTasks — 合法转换", () => {
	it("pending → in_progress ✓", () => {
		const state = makeState([makeTask({ id: 1, status: "pending" })]);
		const err = validateUpdateTasks(state, [{ taskId: 1, status: "in_progress" }]);
		expect(err).toBeNull();
	});

	it("pending → cancelled ✓", () => {
		const state = makeState([makeTask({ id: 1, status: "pending" })]);
		const err = validateUpdateTasks(state, [{ taskId: 1, status: "cancelled" }]);
		expect(err).toBeNull();
	});

	it("in_progress → completed (有 evidence) ✓", () => {
		const state = makeState([makeTask({ id: 1, status: "in_progress" })]);
		const err = validateUpdateTasks(state, [{ taskId: 1, status: "completed", evidence: "done" }]);
		expect(err).toBeNull();
	});

	it("in_progress → cancelled ✓", () => {
		const state = makeState([makeTask({ id: 1, status: "in_progress" })]);
		const err = validateUpdateTasks(state, [{ taskId: 1, status: "cancelled" }]);
		expect(err).toBeNull();
	});

	it("completed(有 verification) → verified (有 actual) ✓", () => {
		const state = makeState([makeTask({
			id: 1,
			status: "completed",
			verification: { method: "pnpm test", expected: "pass" },
		})]);
		const err = validateUpdateTasks(state, [{ taskId: 1, status: "verified", actual: "all pass" }]);
		expect(err).toBeNull();
	});
});

describe("validateUpdateTasks — 非法转换", () => {
	it("pending → completed (应先走 in_progress)", () => {
		const state = makeState([makeTask({ id: 1, status: "pending" })]);
		const err = validateUpdateTasks(state, [{ taskId: 1, status: "completed", evidence: "done" }]);
		expect(err).not.toBeNull();
	});

	it("pending → verified (不能跳过)", () => {
		const state = makeState([makeTask({ id: 1, status: "pending" })]);
		const err = validateUpdateTasks(state, [{ taskId: 1, status: "verified", actual: "ok" }]);
		expect(err).not.toBeNull();
	});

	it("in_progress → verified (不能跳过 completed)", () => {
		const state = makeState([makeTask({ id: 1, status: "in_progress" })]);
		const err = validateUpdateTasks(state, [{ taskId: 1, status: "verified", actual: "ok" }]);
		expect(err).not.toBeNull();
	});

	it("in_progress → pending (不能回退)", () => {
		const state = makeState([makeTask({ id: 1, status: "in_progress" })]);
		const err = validateUpdateTasks(state, [{ taskId: 1, status: "pending" }]);
		expect(err).not.toBeNull();
	});

	it("completed(无 verification) → 任何状态 (终态不可变)", () => {
		const state = makeState([makeTask({ id: 1, status: "completed" })]);
		const err = validateUpdateTasks(state, [{ taskId: 1, status: "in_progress" }]);
		expect(err).not.toBeNull();
	});

	it("completed(有 verification) → 非 verified 状态", () => {
		const state = makeState([makeTask({
			id: 1,
			status: "completed",
			verification: { method: "pnpm test", expected: "pass" },
		})]);
		const err = validateUpdateTasks(state, [{ taskId: 1, status: "cancelled" }]);
		expect(err).not.toBeNull();
	});

	it("verified → 任何状态 (终态不可变)", () => {
		const state = makeState([makeTask({ id: 1, status: "verified" })]);
		const err = validateUpdateTasks(state, [{ taskId: 1, status: "in_progress" }]);
		expect(err).not.toBeNull();
	});

	it("cancelled → 任何状态 (终态不可变)", () => {
		const state = makeState([makeTask({ id: 1, status: "cancelled" })]);
		const err = validateUpdateTasks(state, [{ taskId: 1, status: "in_progress" }]);
		expect(err).not.toBeNull();
	});
});

describe("validateUpdateTasks — 必填检查", () => {
	it("completed 缺 evidence → 错误", () => {
		const state = makeState([makeTask({ id: 1, status: "in_progress" })]);
		const err = validateUpdateTasks(state, [{ taskId: 1, status: "completed" }]);
		expect(err).not.toBeNull();
	});

	it("completed evidence 为空字符串 → 错误", () => {
		const state = makeState([makeTask({ id: 1, status: "in_progress" })]);
		const err = validateUpdateTasks(state, [{ taskId: 1, status: "completed", evidence: "  " }]);
		expect(err).not.toBeNull();
	});

	it("verified 缺 actual → 错误", () => {
		const state = makeState([makeTask({
			id: 1,
			status: "completed",
			verification: { method: "pnpm test", expected: "pass" },
		})]);
		const err = validateUpdateTasks(state, [{ taskId: 1, status: "verified" }]);
		expect(err).not.toBeNull();
	});

	it("verified 但 task 无 verification 配置 → 错误", () => {
		const state = makeState([makeTask({ id: 1, status: "completed" })]);
		const err = validateUpdateTasks(state, [{ taskId: 1, status: "verified", actual: "ok" }]);
		expect(err).not.toBeNull();
	});
});

describe("validateUpdateTasks — 其他检查", () => {
	it("重复 taskId → 错误", () => {
		const state = makeState([makeTask({ id: 1, status: "pending" })]);
		const err = validateUpdateTasks(state, [
			{ taskId: 1, status: "in_progress" },
			{ taskId: 1, status: "cancelled" },
		]);
		expect(err).not.toBeNull();
	});

	it("不存在的 taskId → 错误", () => {
		const state = makeState([makeTask({ id: 1, status: "pending" })]);
		const err = validateUpdateTasks(state, [{ taskId: 99, status: "in_progress" }]);
		expect(err).not.toBeNull();
	});
});
