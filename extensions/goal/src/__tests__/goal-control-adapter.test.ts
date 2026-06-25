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
	buildProgressInput,
	checkCompletePrerequisites,
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

// ── findIncompleteTodos（委托 buildProgressInput，duck-typed 降级）──

describe("findIncompleteTodos — duck-typed 降级（#7 委托 buildProgressInput）", () => {
	it("__todoGetList 不存在 → degraded", () => {
		const pi = {} as never;
		expect(findIncompleteTodos(pi)).toBe(TODO_DEGRADED);
	});

	it("返回 undefined → degraded（允许 complete）", () => {
		const pi = { __todoGetList: () => undefined } as never;
		expect(findIncompleteTodos(pi)).toBe(TODO_DEGRADED);
	});

	it("全完成 → 空数组", () => {
		const pi = makeMockPi([
			{ id: 1, text: "a", status: "completed" },
			{ id: 2, text: "b", status: "completed" },
		]);
		expect(findIncompleteTodos(pi)).toEqual([]);
	});

	it("有未完成项 → 返回未完成 id", () => {
		const pi = makeMockPi([
			{ id: 1, text: "a", status: "completed" },
			{ id: 2, text: "b", status: "in_progress" },
			{ id: 3, text: "c", status: "pending" },
		]);
		expect(findIncompleteTodos(pi)).toEqual([2, 3]);
	});

	it("cancelled 非验证项不计入未完成（FR-1）", () => {
		const pi = makeMockPi([
			{ id: 1, text: "done", status: "completed" },
			{ id: 2, text: "dropped", status: "cancelled" },
		]);
		expect(findIncompleteTodos(pi)).toEqual([]);
	});

	it("cancelled 验证项计入未完成（FR-2 验证任务不可 cancelled）", () => {
		const pi = makeMockPi([
			{ id: 1, text: "done", status: "completed" },
			{ id: 2, text: "verify", status: "cancelled", isVerification: true },
		]);
		expect(findIncompleteTodos(pi)).toEqual([2]);
	});
});

// ── buildProgressInput（#7 ProgressInput 组装）──────

describe("buildProgressInput — duck-typed ProgressInput 组装", () => {
	it("__todoGetList 不存在 → undefined（降级）", () => {
		const pi = {} as never;
		expect(buildProgressInput(pi)).toBeUndefined();
	});

	it("返回非数组 → undefined（降级）", () => {
		const pi = { __todoGetList: () => "not-array" } as never;
		expect(buildProgressInput(pi)).toBeUndefined();
	});

	it("正常 → 组装 ProgressInput", () => {
		const pi = makeMockPi([
			{ id: 1, text: "a", status: "completed" },
			{ id: 2, text: "b", status: "in_progress" },
			{ id: 3, text: "c", status: "pending" },
		]);
		expect(buildProgressInput(pi)).toEqual({
			completedCount: 1,
			totalCount: 3,
			incompleteIds: [2, 3],
			hasVerificationPending: false,
		});
	});

	it("空列表 → total=0", () => {
		const pi = makeMockPi([]);
		expect(buildProgressInput(pi)).toEqual({
			completedCount: 0,
			totalCount: 0,
			incompleteIds: [],
			hasVerificationPending: false,
		});
	});

	it("cancelled 非验证项计为 completed（FR-1）", () => {
		const pi = makeMockPi([
			{ id: 1, text: "done", status: "completed" },
			{ id: 2, text: "dropped", status: "cancelled" },
		]);
		expect(buildProgressInput(pi)).toEqual({
			completedCount: 2,
			totalCount: 2,
			incompleteIds: [],
			hasVerificationPending: false,
		});
	});

	it("未完成验证任务 → hasVerificationPending=true", () => {
		const pi = makeMockPi([
			{ id: 1, text: "done", status: "completed" },
			{ id: 2, text: "verify", status: "pending", isVerification: true },
		]);
		expect(buildProgressInput(pi)).toEqual({
			completedCount: 1,
			totalCount: 2,
			incompleteIds: [2],
			hasVerificationPending: true,
		});
	});

	it("cancelled 验证项计为未完成 + hasVerificationPending=true（FR-2）", () => {
		const pi = makeMockPi([
			{ id: 1, text: "done", status: "completed" },
			{ id: 2, text: "verify", status: "cancelled", isVerification: true },
		]);
		const result = buildProgressInput(pi)!;
		expect(result.completedCount).toBe(1);
		expect(result.incompleteIds).toEqual([2]);
		expect(result.hasVerificationPending).toBe(true);
	});
});

// ── checkCompletePrerequisites（spec FR-2 #1-#4 硬守卫）──

describe("checkCompletePrerequisites — FR-2 complete 前置硬检查", () => {
	it("#1 todo 未加载（__todoGetList 不存在）→ 拒绝", () => {
		const pi = {} as never;
		const r = checkCompletePrerequisites(pi);
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("todo extension");
	});

	it("#1 todo 返回 undefined → 拒绝", () => {
		const pi = { __todoGetList: () => undefined } as never;
		expect(checkCompletePrerequisites(pi).ok).toBe(false);
	});

	it("#2 空数组 → 拒绝（提示建任务含验证任务）", () => {
		const pi = makeMockPi([]);
		const r = checkCompletePrerequisites(pi);
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("no todos");
		expect(r.reason).toContain("isVerification");
	});

	it("#4 有未完成项 → 拒绝 + 列出 id + text", () => {
		const pi = makeMockPi([
			{ id: 1, text: "done", status: "completed" },
			{ id: 2, text: "pending work", status: "in_progress" },
		]);
		const r = checkCompletePrerequisites(pi);
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("#2");
		expect(r.reason).toContain("pending work");
		expect(r.reason).toContain("1 todo item(s)");
	});

	it("#4 未完成验证项 → 列出 [verification] 标记", () => {
		const pi = makeMockPi([
			{ id: 1, text: "done", status: "completed" },
			{ id: 2, text: "run tests", status: "pending", isVerification: true },
		]);
		const r = checkCompletePrerequisites(pi);
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("[verification]");
		expect(r.reason).toContain("run tests");
	});

	it("#3 验证任务 cancelled → 拒绝（验证任务不可 cancelled）", () => {
		const pi = makeMockPi([
			{ id: 1, text: "done", status: "completed" },
			{ id: 2, text: "verify", status: "cancelled", isVerification: true },
		]);
		const r = checkCompletePrerequisites(pi);
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("verification todos");
		expect(r.reason).toContain("must be completed, not cancelled");
	});

	it("全部 completed → ok=true", () => {
		const pi = makeMockPi([
			{ id: 1, text: "a", status: "completed" },
			{ id: 2, text: "verify", status: "completed", isVerification: true },
		]);
		expect(checkCompletePrerequisites(pi).ok).toBe(true);
	});

	it("非验证任务 cancelled + 其余 completed → ok=true（FR-1）", () => {
		const pi = makeMockPi([
			{ id: 1, text: "done", status: "completed" },
			{ id: 2, text: "dropped", status: "cancelled" },
		]);
		expect(checkCompletePrerequisites(pi).ok).toBe(true);
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
