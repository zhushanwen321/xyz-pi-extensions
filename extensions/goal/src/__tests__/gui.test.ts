/**
 * buildGoalGui 测试 — goal 的 GUI 渲染描述符构造（W3 Wave __gui__ 协议）
 *
 * 覆盖：
 * - 有 tokenBudget/timeBudget → card(progress-bar + stats-line)
 * - 预算消耗阈值（≥70% warn, ≥90% danger）
 * - 状态→severity/variant 映射
 * - 无 budget → stats-line 摘要
 */
import { describe, expect, it } from "vitest";

import { buildGoalGui } from "../adapters/goal-control-adapter";
import { createGoalState } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";

function makeState(overrides: Partial<GoalRuntimeState> = {}): GoalRuntimeState {
	return {
		...createGoalState("test"),
		...overrides,
	};
}

describe("buildGoalGui", () => {
	it("有 tokenBudget → card 含 progress-bar + stats-line", () => {
		const gui = buildGoalGui(
			makeState({
				tokensUsed: 4200,
				budget: { tokenBudget: 10000 },
				currentTurnIndex: 3,
			}),
		);
		expect(gui.v).toBe(1);
		expect(gui.component.type).toBe("card");
		const body = gui.component.props.body as { type: string; props: Record<string, unknown> }[];
		// body[0] = progress-bar(tokens), body[1] = stats-line
		const tokenBar = body.find((c) => c.type === "progress-bar")!;
		expect(tokenBar.props).toMatchObject({ current: 4200, total: 10000, severity: "ok" });
		const stats = body.find((c) => c.type === "stats-line")!;
		expect(stats.props.items).toContainEqual(expect.objectContaining({ label: "status", value: "active" }));
	});

	it("token 消耗 ≥90% → severity danger", () => {
		const gui = buildGoalGui(
			makeState({
				tokensUsed: 9500,
				budget: { tokenBudget: 10000 },
			}),
		);
		const body = gui.component.props.body as { type: string; props: Record<string, unknown> }[];
		const tokenBar = body.find((c) => c.type === "progress-bar")!;
		expect(tokenBar.props.severity).toBe("danger");
	});

	it("token 消耗 ≥70% → severity warn", () => {
		const gui = buildGoalGui(
			makeState({
				tokensUsed: 7500,
				budget: { tokenBudget: 10000 },
			}),
		);
		const body = gui.component.props.body as { type: string; props: Record<string, unknown> }[];
		const tokenBar = body.find((c) => c.type === "progress-bar")!;
		expect(tokenBar.props.severity).toBe("warn");
	});

	it("无 budget → stats-line 摘要", () => {
		const gui = buildGoalGui(
			makeState({
				currentTurnIndex: 5,
				tokensUsed: 3000,
			}),
		);
		expect(gui.component.type).toBe("stats-line");
		const items = gui.component.props.items as { label?: string }[];
		const labels = items.map((i) => i.label);
		expect(labels).toContain("goal");
		expect(labels).toContain("status");
		expect(labels).toContain("turn");
		expect(labels).toContain("tokens");
	});

	it("blocked 状态 → card variant danger", () => {
		const gui = buildGoalGui(
			makeState({
				status: "blocked",
				budget: { tokenBudget: 10000 },
			}),
		);
		expect(gui.component.type).toBe("card");
		expect(gui.component.props.variant).toBe("danger");
	});

	it("complete 状态 → card variant success", () => {
		const gui = buildGoalGui(
			makeState({
				status: "complete",
				budget: { tokenBudget: 10000 },
			}),
		);
		expect(gui.component.type).toBe("card");
		expect(gui.component.props.variant).toBe("success");
	});

	it("time 进度条：≥90% → danger", () => {
		const gui = buildGoalGui(
			makeState({
				timeUsedSeconds: 5 * 60 + 1, // 5.01 min / 5 min budget
				budget: { timeBudgetMinutes: 5 },
			}),
		);
		const body = gui.component.props.body as { type: string; props: { label?: string; severity?: string } }[];
		const timeBar = body.find((c) => c.type === "progress-bar" && c.props.label === "time")!;
		expect(timeBar.props.severity).toBe("danger");
	});

	it("slug 缺省 → header 用 goalId 前 8 字符", () => {
		const state = makeState({ slug: undefined, budget: { tokenBudget: 10000 } });
		const gui = buildGoalGui(state);
		expect(gui.component.props.header).toBe(state.goalId.slice(0, 8));
	});
});
