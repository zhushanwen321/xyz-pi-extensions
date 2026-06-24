/**
 * widget.ts 测试 — projection 层渲染（TC-2）
 *
 * 覆盖：
 * - toSingleLine: 多行压缩
 * - renderStatusLine: 状态后缀 + cancelled 短路 + 预算/停滞指标
 * - renderWidgetLines: cancelled 短路 + objective + 预算进度条
 * - renderTerminalStatusLine: 终态单行 + cancelled 短路
 * - updateWidget: FR-6.6 hasUI 守卫 + 终态折叠 + cancelled 清除
 *
 * 用 passthrough ThemeLike（fg/bold 返回原文），断言渲染逻辑而非颜色。
 */
import { describe, expect, it } from "vitest";

import { createGoalState } from "../../engine/goal";
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

// ── toSingleLine ─────────────────────────────────────

describe("toSingleLine", () => {
	it("多行 → 空格分隔单行 + 去首尾空白（不折叠连续空格）", () => {
		expect(toSingleLine("hello\nworld")).toBe("hello world");
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

	it("complete → 含 ✓ Completed", () => {
		const text = renderTerminalStatusLine(makeState({ status: "complete" }), theme);
		expect(text).toContain("✓ Completed");
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

	it("active → 含 objective 行", () => {
		const lines = renderWidgetLines(makeState({ status: "active" }), theme);
		expect(lines.some((l) => l.includes("Objective: test objective"))).toBe(true);
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
});

// ── updateWidget（FR-6.6 hasUI 守卫）─────────────────

describe("updateWidget (FR-6.6 hasUI guard)", () => {
	interface RecordedCall {
		method: "setWidget" | "setStatus";
		args: unknown[];
	}

	function makeUiPort(hasUI: boolean): { ui: UiPort; calls: RecordedCall[] } {
		const calls: RecordedCall[] = [];
		const ui = {
			hasUI,
			setWidget(name: string, content: unknown) {
				calls.push({ method: "setWidget", args: [name, content] });
			},
			setStatus(name: string, text: unknown) {
				calls.push({ method: "setStatus", args: [name, text] });
			},
			notify() {},
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
