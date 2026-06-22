/**
 * service.ts 测试 — 用 fake ports（内存实现 ports.ts 接口）
 *
 * FR-7.2: service 层测试，不 import Pi SDK
 */
import { describe, expect, it } from "vitest";

import { createGoalState } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";
import { applyEvent, applyToolAction, createGoal, finalizeGoal, type ServicePorts } from "../service";
import { createGoalSession } from "../session";

// ── Fake Ports ───────────────────────────────────────

interface RecordedMessage {
	kind: "notify" | "sendContext" | "sendUser";
	text?: string;
	content?: string;
	level?: "info" | "warning" | "error";
	deliverAs?: "steer" | "followUp";
	customType?: string;
}

function makeFakePorts(): ServicePorts & {
	states: GoalRuntimeState[];
	history: unknown[];
	messages: RecordedMessage[];
} {
	const states: GoalRuntimeState[] = [];
	const history: unknown[] = [];
	const messages: RecordedMessage[] = [];
	return {
		states,
		history,
		messages,
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
				messages.push({ kind: "notify", text, level });
			},
			hasUI: true,
		},
		messaging: {
			sendContextMessage: (content, deliverAs, customType) => {
				messages.push({ kind: "sendContext", content, deliverAs, customType });
			},
			sendUserMessage: (content, deliverAs) => {
				messages.push({ kind: "sendUser", content, deliverAs });
			},
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
	it("成功创建：state + tasks 构造", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		const ok = createGoal(session, "my objective", ["task 1", "task 2"], {}, ports, false);
		expect(ok).toBe(true);
		expect(session.state).not.toBeNull();
		expect(session.state!.objective).toBe("my objective");
		expect(session.state!.tasks).toHaveLength(2);
		expect(session.state!.tasks[0]!.id).toBe(1);
		expect(session.state!.tasks[1]!.id).toBe(2);
		expect(session.state!.tasks[0]!.status).toBe("pending");
	});

	it("已有 active goal → 拒绝创建（返回 false）", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		createGoal(session, "first", ["t1"], {}, ports, false);
		const ok = createGoal(session, "second", ["t2"], {}, ports, false);
		expect(ok).toBe(false);
		expect(session.state!.objective).toBe("first"); // 保持原 goal
	});

	it("终态 goal → 允许创建（覆盖）", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		session.state = makeState();
		session.state.status = "complete"; // 终态
		const ok = createGoal(session, "new", ["t1"], {}, ports, false);
		expect(ok).toBe(true);
		expect(session.state.objective).toBe("new");
	});

	it("isExternalInit 截断到 60 字符", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		createGoal(session, "obj", ["short", "a".repeat(100)], {}, ports, true);
		// external init 截断到 60 字符
		expect(session.state!.tasks[1]!.description.length).toBeLessThanOrEqual(60);
	});

	it("非 external init 截断到 80 字符", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		createGoal(session, "obj", ["a".repeat(100)], {}, ports, false);
		expect(session.state!.tasks[0]!.description.length).toBeLessThanOrEqual(80);
	});

	it("persist 被调用", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		createGoal(session, "obj", ["t1"], {}, ports, false);
		expect(ports.states.length).toBeGreaterThanOrEqual(1);
	});

	it("接受 GoalTask[] 输入（取 description）", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		createGoal(
			session,
			"obj",
			[{ id: 99, description: "from task", status: "verified", lastUpdatedTurn: 5 }],
			{},
			ports,
			false,
		);
		// id 重分配（不接受外部 id），status 重置为 pending
		expect(session.state!.tasks[0]!.id).toBe(1);
		expect(session.state!.tasks[0]!.description).toBe("from task");
		expect(session.state!.tasks[0]!.status).toBe("pending");
	});
});

// ── applyToolAction — create_tasks ───────────────────

describe("applyToolAction — create_tasks", () => {
	it("成功创建 tasks", () => {
		const session = createGoalSession();
		session.state = makeState();
		const ports = makeFakePorts();
		const result = applyToolAction(session, "create_tasks", { tasks: ["a", "b"] }, ports);
		expect(result.isError).toBeUndefined();
		expect(session.state!.tasks).toHaveLength(2);
	});

	it("已有未完成 tasks → 拒绝", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "existing", status: "in_progress", lastUpdatedTurn: 0 }];
		const ports = makeFakePorts();
		const result = applyToolAction(session, "create_tasks", { tasks: ["new"] }, ports);
		expect(result.isError).toBe(true);
	});

	it("all-complete → 覆盖（FR-8.8 保持当前行为，D-19 拆出）", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "done", status: "completed", lastUpdatedTurn: 0 }];
		const ports = makeFakePorts();
		const result = applyToolAction(session, "create_tasks", { tasks: ["new"] }, ports);
		expect(result.isError).toBeUndefined();
		expect(session.state!.tasks).toHaveLength(1);
		expect(session.state!.tasks[0]!.description).toBe("new");
	});

	it("空 tasks → 报错", () => {
		const session = createGoalSession();
		session.state = makeState();
		const ports = makeFakePorts();
		const result = applyToolAction(session, "create_tasks", { tasks: [] }, ports);
		expect(result.isError).toBe(true);
	});

	it("session.state=null → 报错", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		const result = applyToolAction(session, "create_tasks", { tasks: ["a"] }, ports);
		expect(result.isError).toBe(true);
	});
});

// ── applyToolAction — update_tasks ───────────────────

describe("applyToolAction — update_tasks", () => {
	it("pending → in_progress 合法", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "t", status: "pending", lastUpdatedTurn: 0 }];
		const result = applyToolAction(
			session,
			"update_tasks",
			{ updates: [{ taskId: 1, status: "in_progress" }] },
			makeFakePorts(),
		);
		expect(result.isError).toBeUndefined();
		expect(session.state!.tasks[0]!.status).toBe("in_progress");
	});

	it("pending → completed 非法（跳过 in_progress）", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "t", status: "pending", lastUpdatedTurn: 0 }];
		const result = applyToolAction(
			session,
			"update_tasks",
			{ updates: [{ taskId: 1, status: "completed", evidence: "x" }] },
			makeFakePorts(),
		);
		expect(result.isError).toBe(true);
	});

	it("completed 无 verification → 全锁（FR-8.3 G-017）", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "t", status: "completed", lastUpdatedTurn: 0 }];
		const result = applyToolAction(
			session,
			"update_tasks",
			{ updates: [{ taskId: 1, status: "cancelled" }] },
			makeFakePorts(),
		);
		expect(result.isError).toBe(true);
	});

	it("completed 有 verification → 只能 verified（其他被拒）", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [
			{
				id: 1,
				description: "t",
				status: "completed",
				lastUpdatedTurn: 0,
				verification: { method: "test", expected: "pass" },
			},
		];
		const result = applyToolAction(
			session,
			"update_tasks",
			{ updates: [{ taskId: 1, status: "cancelled" }] },
			makeFakePorts(),
		);
		expect(result.isError).toBe(true);
	});

	it("completed 有 verification → verified 合法", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [
			{
				id: 1,
				description: "t",
				status: "completed",
				lastUpdatedTurn: 0,
				verification: { method: "test", expected: "pass" },
			},
		];
		const result = applyToolAction(
			session,
			"update_tasks",
			{ updates: [{ taskId: 1, status: "verified", actual: "ok" }] },
			makeFakePorts(),
		);
		expect(result.isError).toBeUndefined();
		expect(session.state!.tasks[0]!.status).toBe("verified");
		expect(session.state!.tasks[0]!.verification!.actual).toBe("ok");
	});

	it("in_progress + verification → completed 触发 FR-8.9 steering", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [
			{
				id: 1,
				description: "t",
				status: "in_progress",
				lastUpdatedTurn: 0,
				verification: { method: "npm test", expected: "0 failures" },
			},
		];
		const ports = makeFakePorts();
		applyToolAction(
			session,
			"update_tasks",
			{ updates: [{ taskId: 1, status: "completed", evidence: "done" }] },
			ports,
		);
		// 应有 steering 消息
		const steer = ports.messages.find((m) => m.deliverAs === "steer");
		expect(steer).toBeTruthy();
		expect(steer!.content).toContain("verification");
	});

	it("completed 缺 evidence → 报错", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "t", status: "in_progress", lastUpdatedTurn: 0 }];
		const result = applyToolAction(
			session,
			"update_tasks",
			{ updates: [{ taskId: 1, status: "completed" }] },
			makeFakePorts(),
		);
		expect(result.isError).toBe(true);
	});

	it("verified 终态不可变", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "t", status: "verified", lastUpdatedTurn: 0 }];
		const result = applyToolAction(
			session,
			"update_tasks",
			{ updates: [{ taskId: 1, status: "in_progress" }] },
			makeFakePorts(),
		);
		expect(result.isError).toBe(true);
	});

	it("重复 taskId → 报错", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [
			{ id: 1, description: "t1", status: "pending", lastUpdatedTurn: 0 },
			{ id: 2, description: "t2", status: "pending", lastUpdatedTurn: 0 },
		];
		const result = applyToolAction(
			session,
			"update_tasks",
			{
				updates: [
					{ taskId: 1, status: "in_progress" },
					{ taskId: 1, status: "completed", evidence: "x" },
				],
			},
			makeFakePorts(),
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("Duplicate");
	});

	it("未知 action → default 分支报错（不支持）", () => {
		const session = createGoalSession();
		session.state = makeState();
		const result = applyToolAction(session, "totally_unknown_action", {}, makeFakePorts());
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("not supported");
	});
});

// ── applyToolAction — complete_goal ──────────────────

describe("applyToolAction — complete_goal", () => {
	it("全完成 → complete", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "t", status: "completed", lastUpdatedTurn: 0 }];
		const result = applyToolAction(session, "complete_goal", { evidence: "all done" }, makeFakePorts());
		expect(result.isError).toBeUndefined();
		expect(session.state!.status).toBe("complete");
		expect(session.state!.completedAtTurnIndex).toBe(session.state!.currentTurnIndex);
	});

	it("有未完成 → 拒绝", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "t", status: "in_progress", lastUpdatedTurn: 0 }];
		const result = applyToolAction(session, "complete_goal", { evidence: "x" }, makeFakePorts());
		expect(result.isError).toBe(true);
	});

	it("全 cancelled → 拒绝（FR-8.10）", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "t", status: "cancelled", lastUpdatedTurn: 0 }];
		const result = applyToolAction(session, "complete_goal", { evidence: "x" }, makeFakePorts());
		expect(result.isError).toBe(true);
	});

	it("缺 evidence → 报错", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "t", status: "completed", lastUpdatedTurn: 0 }];
		const result = applyToolAction(session, "complete_goal", {}, makeFakePorts());
		expect(result.isError).toBe(true);
	});

	it("空 tasks → 报错", () => {
		const session = createGoalSession();
		session.state = makeState();
		const result = applyToolAction(session, "complete_goal", { evidence: "x" }, makeFakePorts());
		expect(result.isError).toBe(true);
	});

	it("写 history（complete 终态）", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "t", status: "completed", lastUpdatedTurn: 0 }];
		const ports = makeFakePorts();
		applyToolAction(session, "complete_goal", { evidence: "done" }, ports);
		expect(ports.history.length).toBe(1);
		expect((ports.history[0] as { status: string }).status).toBe("complete");
	});
});

// ── applyToolAction — cancel_goal ────────────────────

describe("applyToolAction — cancel_goal", () => {
	it("cancel → cancelled + clearSession", () => {
		const session = createGoalSession();
		session.state = makeState();
		const result = applyToolAction(
			session,
			"cancel_goal",
			{ cancelReason: "user wants" },
			makeFakePorts(),
		);
		expect(result.isError).toBeUndefined();
		expect(session.state).toBeNull(); // clearSession
	});

	it("已是终态 → 报错", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.status = "complete";
		const result = applyToolAction(session, "cancel_goal", {}, makeFakePorts());
		expect(result.isError).toBe(true);
	});

	it("cancel 写 history", () => {
		const session = createGoalSession();
		session.state = makeState();
		const ports = makeFakePorts();
		applyToolAction(session, "cancel_goal", { cancelReason: "x" }, ports);
		expect(ports.history.length).toBe(1);
		expect((ports.history[0] as { status: string }).status).toBe("cancelled");
	});
});

// ── applyToolAction — report_blocked ─────────────────

describe("applyToolAction — report_blocked", () => {
	it("blocked → status=blocked + lastBlockerReason", () => {
		const session = createGoalSession();
		session.state = makeState();
		const ports = makeFakePorts();
		const result = applyToolAction(session, "report_blocked", { reason: "API down" }, ports);
		expect(result.isError).toBeUndefined();
		expect(session.state!.status).toBe("blocked");
		expect(session.state!.lastBlockerReason).toBe("API down");
	});

	it("blocked 不写 history（中间态）", () => {
		const session = createGoalSession();
		session.state = makeState();
		const ports = makeFakePorts();
		applyToolAction(session, "report_blocked", { reason: "x" }, ports);
		expect(ports.history.length).toBe(0);
	});

	it("缺 reason → 报错", () => {
		const session = createGoalSession();
		session.state = makeState();
		const result = applyToolAction(session, "report_blocked", {}, makeFakePorts());
		expect(result.isError).toBe(true);
	});
});

// ── applyToolAction — add_tasks ──────────────────────

describe("applyToolAction — add_tasks", () => {
	it("成功追加到现有列表（id 从 max+1 开始）", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [
			{ id: 1, description: "first", status: "completed", lastUpdatedTurn: 0 },
			{ id: 3, description: "third", status: "in_progress", lastUpdatedTurn: 0 },
		];
		const ports = makeFakePorts();
		const result = applyToolAction(session, "add_tasks", { tasks: ["a", "b"] }, ports);
		expect(result.isError).toBeUndefined();
		expect(session.state!.tasks).toHaveLength(4);
		// FR: 下一个 id = max(existing ids)+1 = 4
		expect(session.state!.tasks[2]!.id).toBe(4);
		expect(session.state!.tasks[3]!.id).toBe(5);
		expect(session.state!.tasks[2]!.status).toBe("pending");
		expect(ports.states).toHaveLength(1); // persist 被调用
	});

	it("空 tasks → 报错", () => {
		const session = createGoalSession();
		session.state = makeState();
		const result = applyToolAction(session, "add_tasks", { tasks: [] }, makeFakePorts());
		expect(result.isError).toBe(true);
	});

	it("支持 verifications 数组", () => {
		const session = createGoalSession();
		session.state = makeState();
		const result = applyToolAction(
			session,
			"add_tasks",
			{ tasks: ["t"], verifications: [{ method: "npm test", expected: "ok" }] },
			makeFakePorts(),
		);
		expect(result.isError).toBeUndefined();
		expect(session.state!.tasks[0]!.verification?.method).toBe("npm test");
	});
});

// ── applyToolAction — add_subtasks ───────────────────

describe("applyToolAction — add_subtasks", () => {
	it("成功追加 subtasks（id 从 1 开始）", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "parent", status: "in_progress", lastUpdatedTurn: 0 }];
		const result = applyToolAction(
			session,
			"add_subtasks",
			{ taskId: 1, texts: ["sub-a", "sub-b"] },
			makeFakePorts(),
		);
		expect(result.isError).toBeUndefined();
		expect(session.state!.tasks[0]!.subtasks).toHaveLength(2);
		expect(session.state!.tasks[0]!.subtasks![0]!.id).toBe(1);
		expect(session.state!.tasks[0]!.subtasks![1]!.id).toBe(2);
	});

	it("已存在 subtasks → id 从 max+1 开始", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [
			{
				id: 1,
				description: "parent",
				status: "in_progress",
				lastUpdatedTurn: 0,
				subtasks: [
					{ id: 1, text: "old", status: "completed", lastUpdatedTurn: 0 },
					{ id: 3, text: "old3", status: "pending", lastUpdatedTurn: 0 },
				],
			},
		];
		const result = applyToolAction(
			session,
			"add_subtasks",
			{ taskId: 1, texts: ["new"] },
			makeFakePorts(),
		);
		expect(result.isError).toBeUndefined();
		expect(session.state!.tasks[0]!.subtasks![2]!.id).toBe(4); // max(1,3)+1
	});

	it("FR-8.11: 给 completed task 加 subtask → 拒绝", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "done", status: "completed", lastUpdatedTurn: 0 }];
		const result = applyToolAction(
			session,
			"add_subtasks",
			{ taskId: 1, texts: ["x"] },
			makeFakePorts(),
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("terminal state");
	});

	it("给 cancelled task 加 subtask → 拒绝", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "gone", status: "cancelled", lastUpdatedTurn: 0 }];
		const result = applyToolAction(
			session,
			"add_subtasks",
			{ taskId: 1, texts: ["x"] },
			makeFakePorts(),
		);
		expect(result.isError).toBe(true);
	});

	it("缺 taskId → 报错", () => {
		const session = createGoalSession();
		session.state = makeState();
		const result = applyToolAction(session, "add_subtasks", { texts: ["x"] }, makeFakePorts());
		expect(result.isError).toBe(true);
	});

	it("task 不存在 → 报错", () => {
		const session = createGoalSession();
		session.state = makeState();
		const result = applyToolAction(
			session,
			"add_subtasks",
			{ taskId: 99, texts: ["x"] },
			makeFakePorts(),
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("not found");
	});

	it("texts 全空白 → 报错", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "p", status: "in_progress", lastUpdatedTurn: 0 }];
		const result = applyToolAction(
			session,
			"add_subtasks",
			{ taskId: 1, texts: ["  ", ""] },
			makeFakePorts(),
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("non-empty");
	});
});

// ── applyToolAction — update_subtasks ────────────────

describe("applyToolAction — update_subtasks", () => {
	it("成功更新 subtask 状态（宽松：pending → completed 跳过 in_progress，G-018）", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [
			{
				id: 1,
				description: "p",
				status: "in_progress",
				lastUpdatedTurn: 0,
				subtasks: [{ id: 1, text: "s", status: "pending", lastUpdatedTurn: 0 }],
			},
		];
		const result = applyToolAction(
			session,
			"update_subtasks",
			{ taskId: 1, subUpdates: [{ subId: 1, status: "completed" }] },
			makeFakePorts(),
		);
		expect(result.isError).toBeUndefined();
		expect(session.state!.tasks[0]!.subtasks![0]!.status).toBe("completed");
	});

	it("G-018: completed subtask → 拒绝变更", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [
			{
				id: 1,
				description: "p",
				status: "in_progress",
				lastUpdatedTurn: 0,
				subtasks: [{ id: 1, text: "s", status: "completed", lastUpdatedTurn: 0 }],
			},
		];
		const result = applyToolAction(
			session,
			"update_subtasks",
			{ taskId: 1, subUpdates: [{ subId: 1, status: "in_progress" }] },
			makeFakePorts(),
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("already completed");
	});

	it("subtask 不存在 → 报错", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [
			{
				id: 1,
				description: "p",
				status: "in_progress",
				lastUpdatedTurn: 0,
				subtasks: [{ id: 1, text: "s", status: "pending", lastUpdatedTurn: 0 }],
			},
		];
		const result = applyToolAction(
			session,
			"update_subtasks",
			{ taskId: 1, subUpdates: [{ subId: 99, status: "completed" }] },
			makeFakePorts(),
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("not found");
	});

	it("task 无 subtasks → 报错", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "p", status: "in_progress", lastUpdatedTurn: 0 }];
		const result = applyToolAction(
			session,
			"update_subtasks",
			{ taskId: 1, subUpdates: [{ subId: 1, status: "completed" }] },
			makeFakePorts(),
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("no subtasks");
	});

	it("缺 subUpdates → 报错", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "p", status: "in_progress", lastUpdatedTurn: 0 }];
		const result = applyToolAction(session, "update_subtasks", { taskId: 1 }, makeFakePorts());
		expect(result.isError).toBe(true);
	});
});

// ── applyToolAction — delete_subtasks ────────────────

describe("applyToolAction — delete_subtasks", () => {
	it("成功删除 subtask", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [
			{
				id: 1,
				description: "p",
				status: "in_progress",
				lastUpdatedTurn: 0,
				subtasks: [
					{ id: 1, text: "a", status: "pending", lastUpdatedTurn: 0 },
					{ id: 2, text: "b", status: "pending", lastUpdatedTurn: 0 },
				],
			},
		];
		const result = applyToolAction(
			session,
			"delete_subtasks",
			{ taskId: 1, subIds: [1] },
			makeFakePorts(),
		);
		expect(result.isError).toBeUndefined();
		expect(session.state!.tasks[0]!.subtasks).toHaveLength(1);
		expect(session.state!.tasks[0]!.subtasks![0]!.id).toBe(2);
	});

	it("删空后 subtasks 置 undefined（行为保持）", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [
			{
				id: 1,
				description: "p",
				status: "in_progress",
				lastUpdatedTurn: 0,
				subtasks: [{ id: 1, text: "only", status: "pending", lastUpdatedTurn: 0 }],
			},
		];
		const result = applyToolAction(
			session,
			"delete_subtasks",
			{ taskId: 1, subIds: [1] },
			makeFakePorts(),
		);
		expect(result.isError).toBeUndefined();
		expect(session.state!.tasks[0]!.subtasks).toBeUndefined();
	});

	it("subtask 不存在 → 报错", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [
			{
				id: 1,
				description: "p",
				status: "in_progress",
				lastUpdatedTurn: 0,
				subtasks: [{ id: 1, text: "a", status: "pending", lastUpdatedTurn: 0 }],
			},
		];
		const result = applyToolAction(
			session,
			"delete_subtasks",
			{ taskId: 1, subIds: [99] },
			makeFakePorts(),
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("not found");
	});

	it("缺 subIds → 报错", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "p", status: "in_progress", lastUpdatedTurn: 0 }];
		const result = applyToolAction(session, "delete_subtasks", { taskId: 1 }, makeFakePorts());
		expect(result.isError).toBe(true);
	});
});

// ── applyToolAction — list_tasks ─────────────────────

describe("applyToolAction — list_tasks", () => {
	it("G-005: 只读——不 persist、不写 history", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "task one", status: "in_progress", lastUpdatedTurn: 0 }];
		const ports = makeFakePorts();
		const result = applyToolAction(session, "list_tasks", {}, ports);
		expect(result.isError).toBeUndefined();
		expect(ports.states).toHaveLength(0); // 不 persist
		expect(ports.history).toHaveLength(0); // 不写 history
	});

	it("返回格式化文本（含 task 描述）", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [{ id: 1, description: "task one", status: "in_progress", lastUpdatedTurn: 0 }];
		const result = applyToolAction(session, "list_tasks", {}, makeFakePorts());
		expect(result.isError).toBeUndefined();
		expect(result.content[0]!.text).toContain("task one");
	});

	it("空任务列表 → 显示提示", () => {
		const session = createGoalSession();
		session.state = makeState();
		const result = applyToolAction(session, "list_tasks", {}, makeFakePorts());
		expect(result.isError).toBeUndefined();
		expect(result.content[0]!.text).toContain("No tasks");
	});
});

// ── finalizeGoal — history 写入矩阵 ──────────────────

describe("finalizeGoal — history 写入矩阵", () => {
	it("complete → 写 history", () => {
		const ports = makeFakePorts();
		const state = makeState();
		finalizeGoal(state, "complete", ports, { clearImmediately: false, completedTasks: 1 });
		expect(ports.history.length).toBe(1);
		expect((ports.history[0] as { status: string }).status).toBe("complete");
		expect(state.completedAtTurnIndex).toBe(state.currentTurnIndex);
	});

	it("cancelled → 写 history", () => {
		const ports = makeFakePorts();
		const state = makeState();
		finalizeGoal(state, "cancelled", ports, { clearImmediately: true, completedTasks: 0 });
		expect(ports.history.length).toBe(1);
	});

	it("budget_limited → 写 history", () => {
		const ports = makeFakePorts();
		const state = makeState();
		finalizeGoal(state, "budget_limited", ports, { clearImmediately: false, completedTasks: 2 });
		expect(ports.history.length).toBe(1);
	});

	it("time_limited → 写 history", () => {
		const ports = makeFakePorts();
		const state = makeState();
		finalizeGoal(state, "time_limited", ports, { clearImmediately: false, completedTasks: 0 });
		expect(ports.history.length).toBe(1);
	});

	it("终态 goal 再 finalize → 状态不变（G-016 终态守卫）", () => {
		const ports = makeFakePorts();
		const state = makeState();
		state.status = "complete";
		finalizeGoal(state, "cancelled", ports, { clearImmediately: false, completedTasks: 0 });
		// transitionStatus 终态守卫：保持 complete
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

	it("turn_end → currentTurnIndex++ + updateWidget effect", () => {
		const session = createGoalSession();
		session.state = makeState();
		const before = session.state.currentTurnIndex;
		const effects = applyEvent(session, "turn_end", {}, makeFakePorts());
		expect(session.state.currentTurnIndex).toBe(before + 1);
		expect(effects).toContainEqual({ kind: "updateWidget" });
	});

	it("agent_start → 记录 session.tasksCompletedAtAgentStart（字段在 session 上）", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.tasks = [
			{ id: 1, description: "done", status: "completed", lastUpdatedTurn: 0 },
			{ id: 2, description: "doing", status: "in_progress", lastUpdatedTurn: 0 },
			{ id: 3, description: "verified", status: "verified", lastUpdatedTurn: 0 },
		];
		applyEvent(session, "agent_start", {}, makeFakePorts());
		// 2 个 done (completed + verified)
		expect(session.tasksCompletedAtAgentStart).toBe(2);
		// 字段在 session 顶层，不在 session.state 上
		expect((session.state as unknown as { tasksCompletedAtAgentStart?: number }).tasksCompletedAtAgentStart).toBeUndefined();
	});

	it("agent_start + 非 active status → 不更新", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.status = "paused";
		session.state.tasks = [
			{ id: 1, description: "done", status: "completed", lastUpdatedTurn: 0 },
		];
		applyEvent(session, "agent_start", {}, makeFakePorts());
		expect(session.tasksCompletedAtAgentStart).toBe(0); // 未更新
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
