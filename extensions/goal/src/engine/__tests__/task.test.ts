/**
 * engine/task.ts 测试 — Task 聚合状态机 + 双维度投影
 */
import { describe, expect, it } from "vitest";

import {
	getCompletionState,
	getVerificationState,
	isTaskDone,
	isTerminalTaskStatus,
	validateTaskTransition,
	type GoalTask,
} from "../task";

const makeTask = (overrides: Partial<GoalTask> = {}): GoalTask => ({
	id: 1,
	description: "test task",
	status: "pending",
	lastUpdatedTurn: 0,
	...overrides,
});

// ── isTerminalTaskStatus ─────────────────────────────

describe("isTerminalTaskStatus", () => {
	it("verified → terminal", () => {
		expect(isTerminalTaskStatus("verified")).toBe(true);
	});
	it("cancelled → terminal", () => {
		expect(isTerminalTaskStatus("cancelled")).toBe(true);
	});
	it("completed → NOT terminal", () => {
		expect(isTerminalTaskStatus("completed")).toBe(false);
	});
	it("pending → NOT terminal", () => {
		expect(isTerminalTaskStatus("pending")).toBe(false);
	});
	it("in_progress → NOT terminal", () => {
		expect(isTerminalTaskStatus("in_progress")).toBe(false);
	});
});

// ── isTaskDone（业务语义完成判定）─────────────────────

describe("isTaskDone", () => {
	it("verified → done", () => {
		expect(isTaskDone(makeTask({ status: "verified" }))).toBe(true);
	});
	it("cancelled → done", () => {
		expect(isTaskDone(makeTask({ status: "cancelled" }))).toBe(true);
	});
	it("completed without verification → done", () => {
		expect(isTaskDone(makeTask({ status: "completed" }))).toBe(true);
	});
	it("completed with verification pending → NOT done", () => {
		expect(
			isTaskDone(
				makeTask({
					status: "completed",
					verification: { method: "pnpm test", expected: "all pass" },
				}),
			),
		).toBe(false);
	});
	it("pending → NOT done", () => {
		expect(isTaskDone(makeTask({ status: "pending" }))).toBe(false);
	});
	it("in_progress → NOT done", () => {
		expect(isTaskDone(makeTask({ status: "in_progress" }))).toBe(false);
	});
});

// ── getCompletionState ───────────────────────────────

describe("getCompletionState", () => {
	it("completed/verified/cancelled → done", () => {
		expect(getCompletionState(makeTask({ status: "completed" }))).toBe("done");
		expect(getCompletionState(makeTask({ status: "verified" }))).toBe("done");
		expect(getCompletionState(makeTask({ status: "cancelled" }))).toBe("done");
	});
	it("pending/in_progress → not_done", () => {
		expect(getCompletionState(makeTask({ status: "pending" }))).toBe("not_done");
		expect(getCompletionState(makeTask({ status: "in_progress" }))).toBe("not_done");
	});
});

// ── getVerificationState ─────────────────────────────

describe("getVerificationState", () => {
	it("verified → verified", () => {
		expect(getVerificationState(makeTask({ status: "verified" }))).toBe("verified");
	});
	it("completed with verification → pending_verification", () => {
		expect(
			getVerificationState(
				makeTask({
					status: "completed",
					verification: { method: "pnpm test", expected: "pass" },
				}),
			),
		).toBe("pending_verification");
	});
	it("completed without verification → no_verification", () => {
		expect(getVerificationState(makeTask({ status: "completed" }))).toBe("no_verification");
	});
	it("pending → no_verification（即使配了 verification 也未进入验证流程）", () => {
		expect(
			getVerificationState(
				makeTask({
					status: "pending",
					verification: { method: "pnpm test", expected: "pass" },
				}),
			),
		).toBe("no_verification");
	});
	it("cancelled → no_verification", () => {
		expect(getVerificationState(makeTask({ status: "cancelled" }))).toBe("no_verification");
	});
});

// ── validateTaskTransition（status 级转换合法性）───────

describe("validateTaskTransition — 合法转换 → null", () => {
	const legal: Array<[string, string]> = [
		["pending", "in_progress"],
		["pending", "cancelled"],
		["in_progress", "completed"],
		["in_progress", "cancelled"],
		["completed", "verified"],
	];
	for (const [from, to] of legal) {
		it(`${from} → ${to} 合法`, () => {
			expect(validateTaskTransition(from as never, to as never)).toBeNull();
		});
	}
});

describe("validateTaskTransition — 非法转换 → 错误消息", () => {
	const illegal: Array<[string, string]> = [
		["pending", "completed"],
		["pending", "verified"],
		["in_progress", "verified"],
		["in_progress", "pending"],
		["completed", "pending"],
		["completed", "in_progress"],
		["completed", "cancelled"],
		["verified", "pending"],
		["verified", "in_progress"],
		["cancelled", "pending"],
		["cancelled", "in_progress"],
	];
	for (const [from, to] of illegal) {
		it(`${from} → ${to} 非法`, () => {
			const err = validateTaskTransition(from as never, to as never);
			expect(err, `${from} → ${to} should be rejected`).not.toBeNull();
			expect(typeof err).toBe("string");
		});
	}
});
