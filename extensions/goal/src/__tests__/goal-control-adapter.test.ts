/**
 * goal_control adapter 测试 — handler 用 fake ports，findIncompleteTodos 用 mock pi
 *
 * 覆盖 #3 验收：
 * - complete: active 守卫 + evidence 必填 + finalizeAndPersist（status→complete + history）
 * - report_blocked: active 守卫 + reason 必填 + tickState + transitionStatus(active→blocked) + persistState
 * - findIncompleteTodos: undefined 降级 / 全完成 / 有未完成
 *
 * 不 import Pi SDK（handler 接收 ServicePorts，纯逻辑）。
 */
import { describe, expect, it } from "vitest";

import {
	findIncompleteTodos,
	handleComplete,
	handleReportBlocked,
	TODO_DEGRADED,
} from "../adapters/goal-control-adapter";
import { createGoalState, transitionStatus } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";
import type { UiPort } from "../ports";
import type { ServicePorts } from "../service";
import { createGoalSession } from "../session";

// ── Fake Ports ───────────────────────────────────────

function makeFakePorts(): ServicePorts & {
	states: GoalRuntimeState[];
	history: unknown[];
	notifications: Array<{ text: string; level: string }>;
} {
	const states: GoalRuntimeState[] = [];
	const history: unknown[] = [];
	const notifications: Array<{ text: string; level: string }> = [];
	return {
		states,
		history,
		notifications,
		persistence: {
			appendState: (s) => {
				states.push(s);
			},
			appendHistory: (e) => {
				history.push(e);
			},
		},
		ui: {
			setWidget: () => {},
			setStatus: () => {},
			notify: (text, level) => {
				notifications.push({ text, level });
			},
			hasUI: true,
			// widget.asTheme 期望 fg/bold（ports.ts 的 uiPort 同样携带）
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as UiPort,
		messaging: {
			sendContextMessage: () => {},
			sendUserMessage: () => {},
		},
		session: {
			getEntries: () => [],
			spliceEntry: () => {},
			getContextUsage: () => null,
			signal: undefined,
		},
	};
}

/** mock pi：仅暴露 __todoGetList（duck-typed 调用只需此字段） */
function makeMockPi(todoList: unknown): { __todoGetList: () => unknown } {
	return { __todoGetList: () => todoList };
}

const activeState = (overrides: Partial<GoalRuntimeState> = {}): GoalRuntimeState => ({
	...createGoalState("test"),
	...overrides,
});

// ── findIncompleteTodos（duck-typed todo 检查）──────

describe("findIncompleteTodos — duck-typed 降级", () => {
	it("__todoGetList 不存在 → degraded", () => {
		const pi = {} as never;
		expect(findIncompleteTodos(pi)).toBe(TODO_DEGRADED);
	});

	it("返回 undefined → degraded（#3 阶段允许 complete）", () => {
		const pi = { __todoGetList: () => undefined } as never;
		expect(findIncompleteTodos(pi)).toBe(TODO_DEGRADED);
	});

	it("全完成/取消 → 空数组", () => {
		const pi = makeMockPi([
			{ status: "completed" },
			{ status: "cancelled" },
		]);
		expect(findIncompleteTodos(pi)).toEqual([]);
	});

	it("有未完成项 → 返回未完成项", () => {
		const pi = makeMockPi([
			{ status: "completed" },
			{ status: "in_progress" },
			{ status: "pending" },
		]);
		expect(findIncompleteTodos(pi)).toHaveLength(2);
	});
});

// ── handleComplete ───────────────────────────────────

describe("handleComplete — active 守卫 + evidence + finalizeAndPersist", () => {
	it("active + evidence → status complete + 写 history", () => {
		const session = createGoalSession();
		session.state = activeState();
		const ports = makeFakePorts();

		const details = handleComplete({ action: "complete", evidence: "tests pass" }, session, ports);

		expect(details.action).toBe("complete");
		expect(details.status).toBe("complete");
		expect(session.state!.status).toBe("complete");
		// finalizeAndPersist 写 history（FR-8.7）
		expect(ports.history).toHaveLength(1);
		expect(ports.notifications[0]?.level).toBe("info");
	});

	it("非 active（blocked）→ throw", () => {
		const session = createGoalSession();
		session.state = activeState({ status: "blocked" });
		expect(() => handleComplete({ action: "complete", evidence: "x" }, session, makeFakePorts())).toThrow(
			/not active/,
		);
	});

	it("evidence 空 → throw", () => {
		const session = createGoalSession();
		session.state = activeState();
		expect(() =>
			handleComplete({ action: "complete", evidence: "   " }, session, makeFakePorts()),
		).toThrow(/evidence/);
	});

	it("completedTasks 写入 history", () => {
		const session = createGoalSession();
		session.state = activeState();
		const ports = makeFakePorts();
		handleComplete({ action: "complete", evidence: "done", completedTasks: 5 }, session, ports);
		expect((ports.history[0] as { completedTasks?: number }).completedTasks).toBe(5);
	});
});

// ── handleReportBlocked ──────────────────────────────

describe("handleReportBlocked — active 守卫 + tick + transition + persist", () => {
	it("active + reason → status blocked + reason 记录 + tick 累加", () => {
		const session = createGoalSession();
		const past = Date.now() - 4000;
		session.state = activeState({ timeStartedAt: past, timeUsedSeconds: 6 });
		const ports = makeFakePorts();

		const details = handleReportBlocked(
			{ action: "report_blocked", reason: "stuck on X" },
			session,
			ports,
		);

		expect(details.action).toBe("report_blocked");
		expect(details.status).toBe("blocked");
		expect(session.state!.status).toBe("blocked");
		expect(session.state!.lastBlockerReason).toBe("stuck on X");
		// MF-3 tick：转 blocked 前累加当前运行段（6 + ~4s）
		expect(session.state!.timeUsedSeconds).toBeGreaterThanOrEqual(9);
		// persistState 持久化
		expect(ports.states).toHaveLength(1);
		expect(ports.notifications[0]?.level).toBe("warning");
	});

	it("非 active（complete）→ throw", () => {
		const session = createGoalSession();
		session.state = activeState({ status: "complete" });
		expect(() =>
			handleReportBlocked({ action: "report_blocked", reason: "x" }, session, makeFakePorts()),
		).toThrow(/not active/);
	});

	it("reason 空 → throw", () => {
		const session = createGoalSession();
		session.state = activeState();
		expect(() =>
			handleReportBlocked({ action: "report_blocked", reason: "" }, session, makeFakePorts()),
		).toThrow(/reason/);
	});

	it("active→blocked 是合法转换", () => {
		// transitionStatus 自身已由 engine 测试覆盖，此处验证集成不破坏
		expect(transitionStatus("active", "blocked")).toBe("blocked");
	});
});
