/**
 * P0 测试：isTaskDone — 业务语义的"完成"判定
 */
import { describe, expect, it } from "vitest";

import { type GoalTask, isTaskDone } from "../engine/task";

const makeTask = (overrides: Partial<GoalTask> = {}): GoalTask => ({
	id: 1,
	description: "test task",
	status: "pending",
	lastUpdatedTurn: 0,
	...overrides,
});

describe("isTaskDone", () => {
	it("verified task → done", () => {
		expect(isTaskDone(makeTask({ status: "verified" }))).toBe(true);
	});

	it("cancelled task → done", () => {
		expect(isTaskDone(makeTask({ status: "cancelled" }))).toBe(true);
	});

	it("completed without verification → done", () => {
		expect(isTaskDone(makeTask({ status: "completed" }))).toBe(true);
	});

	it("completed with verification awaiting → NOT done", () => {
		expect(isTaskDone(makeTask({
			status: "completed",
			verification: { method: "pnpm test", expected: "all pass" },
		}))).toBe(false);
	});

	it("pending → NOT done", () => {
		expect(isTaskDone(makeTask({ status: "pending" }))).toBe(false);
	});

	it("in_progress → NOT done", () => {
		expect(isTaskDone(makeTask({ status: "in_progress" }))).toBe(false);
	});
});
