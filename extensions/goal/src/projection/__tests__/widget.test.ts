/**
 * widget.ts 测试 — projection 层渲染（TC-2）
 *
 * 覆盖：
 * - toSingleLine: 多行压缩
 * - renderStatusLine: 5 状态后缀 + cancelled 短路 + 预算/停滞指标
 * - renderWidgetLines: cancelled 短路 + task 行 + subtask 折叠 + 预算进度条
 * - renderTerminalStatusLine: 终态单行 + cancelled 短路
 * - renderTaskRow: 5 status 图标 + 验证标签 + subtask 展开
 * - renderSubtaskLines: all-completed 折叠
 * - updateWidget: FR-6.6 hasUI 守卫 + 终态折叠 + cancelled 清除
 *
 * 用 passthrough ThemeLike（fg/bold 返回原文），断言渲染逻辑而非颜色。
 */
import { describe, expect, it } from "vitest";

import { createGoalState } from "../../engine/goal";
import type { GoalTask } from "../../engine/task";
import type { GoalRuntimeState } from "../../engine/types";
import type { UiPort } from "../../ports";
import { createGoalSession } from "../../session";
import {
	renderStatusLine,
	renderTerminalStatusLine,
	renderWidgetLines,
	type ThemeLike,
	toSingleLine,
	updateWidget,
} from "../widget";

// ── Passthrough theme（断言渲染逻辑，不含颜色干扰）────

const theme: ThemeLike = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

// ── 辅助 ─────────────────────────────────────────────

function makeState(overrides?: Partial<GoalRuntimeState>): GoalRuntimeState {
	return {
		...createGoalState("test objective"),
		status: "active",
		...overrides,
	};
}

function makeTask(overrides?: Partial<GoalTask>): GoalTask {
	return {
		id: 1,
		description: "task desc",
		status: "pending",
		lastUpdatedTurn: 0,
		...overrides,
	};
}

// ── toSingleLine ─────────────────────────────────────

describe("toSingleLine", () => {
	it("多行 → 空格分隔单行 + 去首尾空白（不折叠连续空格）", () => {
		expect(toSingleLine("hello\nworld")).toBe("hello world");
		// \r?\n → 空格，然后 trim；内部连续空格不折叠
		expect(toSingleLine("a\nb\nc")).toBe("a b c");
		expect(toSingleLine("  trimmed  ")).toBe("trimmed");
	});
	it("单行原样返回（trim）", () => {
		expect(toSingleLine("  single  ")).toBe("single");
	});
});

// ── renderStatusLine ─────────────────────────────────

describe("renderStatusLine", () => {
	it("cancelled → 空字符串（短路）", () => {
		expect(renderStatusLine(makeState({ status: "cancelled" }), theme)).toBe("");
	});

	it("active 状态：含 Goal 标识 + turn 计数", () => {
		const text = renderStatusLine(makeState({ status: "active", currentTurnIndex: 3 }), theme);
		expect(text).toContain("◆ Goal");
		expect(text).toContain("3/50"); // DEFAULT_BUDGET.maxTurns=50
	});

	it("paused → 含 ⏸ Paused 后缀", () => {
		const text = renderStatusLine(makeState({ status: "paused" }), theme);
		expect(text).toContain("⏸ Paused");
	});

	it("blocked → 含 ⊘ Blocked 后缀", () => {
		const text = renderStatusLine(makeState({ status: "blocked" }), theme);
		expect(text).toContain("⊘ Blocked");
	});

	it("complete → 含 ✓ Completed 后缀", () => {
		const text = renderStatusLine(makeState({ status: "complete" }), theme);
		expect(text).toContain("✓ Completed");
	});

	it("budget_limited → 含 ⊗ Token budget exhausted 后缀", () => {
		const text = renderStatusLine(makeState({ status: "budget_limited" }), theme);
		expect(text).toContain("⊗ Token budget exhausted");
	});

	it("time_limited → 含 ⏱ Time budget exhausted 后缀", () => {
		const text = renderStatusLine(makeState({ status: "time_limited" }), theme);
		expect(text).toContain("⏱ Time budget exhausted");
	});

	it("有 task：显示 done/total + pending verify 计数", () => {
		const text = renderStatusLine(
			makeState({
				status: "active",
				tasks: [
					makeTask({ id: 1, status: "completed", verification: { method: "m", expected: "e" } }),
					makeTask({ id: 2, status: "verified" }),
					makeTask({ id: 3, status: "pending" }),
				],
			}),
			theme,
		);
		expect(text).toContain("2/3 tasks");
		expect(text).toContain("1 pending verify"); // 1 个 completed + verification 待验证
	});

	it("有 verified 无 pending：显示 verified 计数", () => {
		// 逻辑要求 completedCount > 0 且 pendingVerify === 0 才显示 verified 计数
		// （completed 无 verification 不计入 pendingVerify）
		const text = renderStatusLine(
			makeState({
				status: "active",
				tasks: [
					makeTask({ id: 1, status: "completed" }), // completedCount=1, 无 verification → pendingVerify=0
					makeTask({ id: 2, status: "verified" }),
					makeTask({ id: 3, status: "pending" }),
				],
			}),
			theme,
		);
		expect(text).toContain("2/3 tasks");
		expect(text).toContain("1 verified");
	});

	it("stallCount > 0 → 显示停滞警告", () => {
		const text = renderStatusLine(makeState({ status: "active", stallCount: 3 }), theme);
		expect(text).toContain("⚠ 3 turns stalled");
	});

	it("tokenBudget > 0 → 显示 token 百分比", () => {
		const text = renderStatusLine(
			makeState({
				status: "active",
				budget: { tokenBudget: 1000, timeBudgetMinutes: 0, maxTurns: 20, maxStallTurns: 3 },
				tokensUsed: 500,
			}),
			theme,
		);
		expect(text).toContain("50% tokens");
	});
});

// ── renderTerminalStatusLine ─────────────────────────

describe("renderTerminalStatusLine", () => {
	it("cancelled → 空字符串", () => {
		expect(renderTerminalStatusLine(makeState({ status: "cancelled" }), theme)).toBe("");
	});

	it("complete → 含 ✓ Completed + task 计数", () => {
		const text = renderTerminalStatusLine(
			makeState({
				status: "complete",
				tasks: [makeTask({ id: 1, status: "verified" }), makeTask({ id: 2, status: "completed" })],
			}),
			theme,
		);
		expect(text).toContain("✓ Completed");
		expect(text).toContain("2/2 tasks");
	});

	it("budget_limited → 含 ⊗ Token budget exhausted", () => {
		const text = renderTerminalStatusLine(makeState({ status: "budget_limited" }), theme);
		expect(text).toContain("⊗ Token budget exhausted");
	});
});

// ── renderWidgetLines ────────────────────────────────

describe("renderWidgetLines", () => {
	it("cancelled → 空数组", () => {
		expect(renderWidgetLines(makeState({ status: "cancelled" }), theme)).toEqual([]);
	});

	it("无 task → 含 'Waiting for task list creation'", () => {
		const lines = renderWidgetLines(makeState({ status: "active" }), theme);
		expect(lines.some((l) => l.includes("Waiting for task list creation"))).toBe(true);
	});

	it("有 task → 含 objective + task 行", () => {
		const lines = renderWidgetLines(
			makeState({
				status: "active",
				tasks: [makeTask({ id: 1, description: "build feature", status: "in_progress" })],
			}),
			theme,
		);
		expect(lines.some((l) => l.includes("Objective: test objective"))).toBe(true);
		expect(lines.some((l) => l.includes("#1") && l.includes("build feature"))).toBe(true);
	});

	it("tokenBudget + timeBudget → 含进度条行", () => {
		const lines = renderWidgetLines(
			makeState({
				status: "active",
				budget: { tokenBudget: 1000, timeBudgetMinutes: 30, maxTurns: 20, maxStallTurns: 3 },
				tokensUsed: 250,
				timeUsedSeconds: 540, // 9 min
			}),
			theme,
		);
		expect(lines.some((l) => l.includes("Token:") && l.includes("25%"))).toBe(true);
		expect(lines.some((l) => l.includes("Time:") && l.includes("9/30min"))).toBe(true);
	});

	it("subtask 全部 completed → 折叠不显示 subtask 行", () => {
		const lines = renderWidgetLines(
			makeState({
				status: "active",
				tasks: [
					makeTask({
						id: 1,
						status: "in_progress",
						subtasks: [
							{ id: 1, text: "sub1", status: "completed", lastUpdatedTurn: 0 },
							{ id: 2, text: "sub2", status: "completed", lastUpdatedTurn: 0 },
						],
					}),
				],
			}),
			theme,
		);
		// 不含 1.1 / 1.2（subtask 折叠）
		expect(lines.every((l) => !l.includes("1.1") && !l.includes("1.2"))).toBe(true);
	});

	it("subtask 部分未完成 → 展开 subtask 行", () => {
		const lines = renderWidgetLines(
			makeState({
				status: "active",
				tasks: [
					makeTask({
						id: 1,
						status: "in_progress",
						subtasks: [
							{ id: 1, text: "done", status: "completed", lastUpdatedTurn: 0 },
							{ id: 2, text: "todo", status: "pending", lastUpdatedTurn: 0 },
						],
					}),
				],
			}),
			theme,
		);
		expect(lines.some((l) => l.includes("1.2") && l.includes("todo"))).toBe(true);
	});
});

// ── renderTaskRow（通过 renderWidgetLines 间接）───────

describe("renderTaskRow (via renderWidgetLines)", () => {
	it("verified task → 含 ◉ 图标 + actual 信息", () => {
		const lines = renderWidgetLines(
			makeState({
				status: "active",
				tasks: [
					makeTask({
						id: 1,
						status: "verified",
						verification: { method: "tsc", expected: "0 errors", actual: "passed" },
					}),
				],
			}),
			theme,
		);
		expect(lines.some((l) => l.includes("◉"))).toBe(true);
		expect(lines.some((l) => l.includes("actual: passed"))).toBe(true);
	});

	it("completed + verification → 含 ✓ + [待验证] 标记", () => {
		const lines = renderWidgetLines(
			makeState({
				status: "active",
				tasks: [
					makeTask({
						id: 1,
						status: "completed",
						verification: { method: "tsc", expected: "0 errors" },
					}),
				],
			}),
			theme,
		);
		expect(lines.some((l) => l.includes("✓"))).toBe(true);
		expect(lines.some((l) => l.includes("[待验证]"))).toBe(true);
	});

	it("cancelled task → 含 ✗ 图标", () => {
		const lines = renderWidgetLines(
			makeState({
				status: "active",
				tasks: [makeTask({ id: 1, status: "cancelled" })],
			}),
			theme,
		);
		expect(lines.some((l) => l.includes("✗"))).toBe(true);
	});

	it("pending task → 含 ☐ 图标", () => {
		const lines = renderWidgetLines(
			makeState({
				status: "active",
				tasks: [makeTask({ id: 1, status: "pending" })],
			}),
			theme,
		);
		expect(lines.some((l) => l.includes("☐"))).toBe(true);
	});
});

// ── updateWidget（FR-6.6 hasUI 守卫）─────────────────

describe("updateWidget (FR-6.6 hasUI guard)", () => {
	interface RecordedCall {
		method: "setWidget" | "setStatus";
		args: unknown[];
	}

	// 返回 { ui, calls } —— 直接持有 calls 引用，无需 __calls 反射 cast
	function makeUiPort(hasUI: boolean): { ui: UiPort; calls: RecordedCall[] } {
		const calls: RecordedCall[] = [];
		// 满足 UiPort + ThemeLike（asTheme 断言从 uiPort 取 fg/bold）
		const ui = {
			hasUI,
			setWidget(name: string, content: unknown) {
				calls.push({ method: "setWidget", args: [name, content] });
			},
			setStatus(name: string, text: unknown) {
				calls.push({ method: "setStatus", args: [name, text] });
			},
			notify() {},
			// passthrough theme（与上方 theme 一致）
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as UiPort;
		return { ui, calls };
	}

	it("hasUI=false → 不调 setWidget/setStatus（headless 守卫）", () => {
		const { ui, calls } = makeUiPort(false);
		const session = createGoalSession();
		session.state = makeState({ status: "active" });
		updateWidget(session, ui);
		expect(calls).toHaveLength(0); // FR-6.6
	});

	it("session.state=null → 清除 widget + status", () => {
		const { ui, calls } = makeUiPort(true);
		updateWidget(createGoalSession(), ui);
		expect(calls.some((c) => c.method === "setWidget" && c.args[1] === undefined)).toBe(true);
		expect(calls.some((c) => c.method === "setStatus" && c.args[1] === undefined)).toBe(true);
	});

	it("cancelled → 清除 widget + status", () => {
		const { ui, calls } = makeUiPort(true);
		const session = createGoalSession();
		session.state = makeState({ status: "cancelled" });
		updateWidget(session, ui);
		expect(calls.some((c) => c.method === "setWidget" && c.args[1] === undefined)).toBe(true);
		expect(calls.some((c) => c.method === "setStatus" && c.args[1] === undefined)).toBe(true);
	});

	it("终态（非 cancelled）→ setStatus 终态单行 + setWidget undefined", () => {
		const { ui, calls } = makeUiPort(true);
		const session = createGoalSession();
		session.state = makeState({ status: "complete" });
		updateWidget(session, ui);
		expect(calls.some((c) => c.method === "setStatus" && typeof c.args[1] === "string")).toBe(true);
		expect(calls.some((c) => c.method === "setWidget" && c.args[1] === undefined)).toBe(true);
	});

	it("active → setStatus + setWidget（正常渲染）", () => {
		const { ui, calls } = makeUiPort(true);
		const session = createGoalSession();
		session.state = makeState({ status: "active" });
		updateWidget(session, ui);
		expect(calls.some((c) => c.method === "setStatus" && typeof c.args[1] === "string")).toBe(true);
		expect(calls.some((c) => c.method === "setWidget" && Array.isArray(c.args[1]))).toBe(true);
	});
});
