/**
 * service.ts 测试 — 用 fake ports（内存实现 ports.ts 接口）
 *
 * FR-7.2: service 层测试，不 import Pi SDK
 */
import { describe, expect, it } from "vitest";

import { createGoalState } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";
import { applyEvent, createGoal, finalizeGoal, type ServicePorts } from "../service";
import { createGoalSession } from "../session";

// ── Fake Ports ───────────────────────────────────────

function makeFakePorts(): ServicePorts & {
	states: GoalRuntimeState[];
	history: unknown[];
} {
	const states: GoalRuntimeState[] = [];
	const history: unknown[] = [];
	return {
		states,
		history,
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
			notify: () => {},
			hasUI: true,
		},
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

const makeState = (): GoalRuntimeState => createGoalState("test");

// ── createGoal 测试 ──────────────────────────────────

describe("createGoal — 唯一创建入口", () => {
	it("成功创建：state 构造 + persist", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		const ok = createGoal(session, "my objective", {}, ports, false);
		expect(ok).toBe(true);
		expect(session.state).not.toBeNull();
		expect(session.state!.objective).toBe("my objective");
		expect(ports.states.length).toBeGreaterThanOrEqual(1);
	});

	it("已有 active goal → 拒绝创建（返回 false）", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		createGoal(session, "first", {}, ports, false);
		const ok = createGoal(session, "second", {}, ports, false);
		expect(ok).toBe(false);
		expect(session.state!.objective).toBe("first"); // 保持原 goal
	});

	it("终态 goal → 允许创建（覆盖）", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		session.state = makeState();
		session.state.status = "complete"; // 终态
		const ok = createGoal(session, "new", {}, ports, false);
		expect(ok).toBe(true);
		expect(session.state.objective).toBe("new");
	});
});

// ── finalizeGoal — history 写入矩阵 ──────────────────

describe("finalizeGoal — history 写入矩阵", () => {
	it("complete → 写 history", () => {
		const ports = makeFakePorts();
		const state = makeState();
		finalizeGoal(state, "complete", ports, { completedTasks: 1 });
		expect(ports.history.length).toBe(1);
		expect((ports.history[0] as { status: string }).status).toBe("complete");
		expect(state.completedAtTurnIndex).toBe(state.currentTurnIndex);
	});

	it("cancelled → 写 history", () => {
		const ports = makeFakePorts();
		const state = makeState();
		finalizeGoal(state, "cancelled", ports, { completedTasks: 0 });
		expect(ports.history.length).toBe(1);
	});

	it("budget_limited → 写 history", () => {
		const ports = makeFakePorts();
		const state = makeState();
		finalizeGoal(state, "budget_limited", ports, { completedTasks: 2 });
		expect(ports.history.length).toBe(1);
	});

	it("time_limited → 写 history", () => {
		const ports = makeFakePorts();
		const state = makeState();
		finalizeGoal(state, "time_limited", ports, { completedTasks: 0 });
		expect(ports.history.length).toBe(1);
	});

	it("终态 goal 再 finalize → throw（查表非法转换）", () => {
		const ports = makeFakePorts();
		const state = makeState();
		state.status = "complete";
		// transitionStatus 查表：终态不可转，调用方须先 isTerminalStatus 守卫
		expect(() => finalizeGoal(state, "cancelled", ports, { completedTasks: 0 })).toThrow();
		expect(state.status).toBe("complete");
	});
});

// ── applyEvent — 简单事件（路径 B）────────────────────

describe("applyEvent — 简单事件", () => {
	it("message_end 累加 assistant token（FR-8.6）", () => {
		const session = createGoalSession();
		session.state = makeState();
		const before = session.state.tokensUsed;
		applyEvent(session, "message_end", {
			message: {
				role: "assistant",
				usage: { input: 100, output: 50, cacheRead: 20 },
			},
		}, makeFakePorts());
		// accumulateTokens: max(100 - 20, 0) + 50 = 130
		expect(session.state.tokensUsed).toBe(before + 130);
	});

	it("message_end 忽略非 assistant 消息", () => {
		const session = createGoalSession();
		session.state = makeState();
		const before = session.state.tokensUsed;
		applyEvent(session, "message_end", {
			message: { role: "user", usage: { input: 100, output: 50 } },
		}, makeFakePorts());
		expect(session.state.tokensUsed).toBe(before);
	});

	it("message_end 缺 usage → 不变", () => {
		const session = createGoalSession();
		session.state = makeState();
		const before = session.state.tokensUsed;
		applyEvent(session, "message_end", { message: { role: "assistant" } }, makeFakePorts());
		expect(session.state.tokensUsed).toBe(before);
	});

	it("回归#1: message_end 非 active（blocked）→ 不累加 token（FR-8.6 G-R2-001）", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.status = "blocked"; // 非 active
		const before = session.state.tokensUsed;
		applyEvent(session, "message_end", {
			message: {
				role: "assistant",
				usage: { input: 100, output: 50, cacheRead: 20 },
			},
		}, makeFakePorts());
		// 回归修复：blocked 状态不累加 token（原 bug：缺 isActiveStatus 守卫）
		expect(session.state.tokensUsed).toBe(before);
	});

	it("turn_end → currentTurnIndex++ + updateWidget effect", () => {
		const session = createGoalSession();
		session.state = makeState();
		const before = session.state.currentTurnIndex;
		const effects = applyEvent(session, "turn_end", {}, makeFakePorts());
		expect(session.state.currentTurnIndex).toBe(before + 1);
		expect(effects).toContainEqual({ kind: "updateWidget" });
	});

	it("agent_start → 无副作用（task 已移除）", () => {
		const session = createGoalSession();
		session.state = makeState();
		const effects = applyEvent(session, "agent_start", {}, makeFakePorts());
		expect(effects).toEqual([]);
	});

	it("session.state=null → 返回空 effects", () => {
		const session = createGoalSession();
		const effects = applyEvent(session, "turn_end", {}, makeFakePorts());
		expect(effects).toEqual([]);
	});

	it("未知事件 → 返回空 effects（不报错）", () => {
		const session = createGoalSession();
		session.state = makeState();
		const effects = applyEvent(session, "unknown_event", {}, makeFakePorts());
		expect(effects).toEqual([]);
	});
});
