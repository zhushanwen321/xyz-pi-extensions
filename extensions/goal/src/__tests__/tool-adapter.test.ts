/**
 * tool-adapter.ts 测试 — executeGoalAction 分发 + buildPorts 桥接
 *
 * 覆盖：
 * - MF-9: executeGoalAction（stale context catch / signal.aborted 守卫 / 未知 action / 通用错误兜底）
 * - buildPorts 4 port 构造（persistence/ui/messaging/session）
 * - ACTION_HANDLERS 10 条完整
 *
 * 用 fake pi + fake ctx（不 import Pi SDK 真实实现）。
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createGoalState } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";
import { createGoalSession } from "../session";
import {
	ACTION_HANDLERS,
	buildPorts,
	executeGoalAction,
	HISTORY_ENTRY_TYPE,
} from "../adapters/tool-adapter";

// ── Fake pi / ctx ────────────────────────────────────

interface FakeHarness {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	states: unknown[];
	history: unknown[];
	messages: unknown[];
	notifyCalls: Array<{ text: string; level: string }>;
}

function makeHarness(options?: { aborted?: boolean }): FakeHarness {
	const states: unknown[] = [];
	const history: unknown[] = [];
	const messages: unknown[] = [];
	const notifyCalls: Array<{ text: string; level: string }> = [];

	const pi = {
		appendEntry(customType: string, data?: unknown): void {
			if (customType === HISTORY_ENTRY_TYPE) history.push(data);
			else states.push(data);
		},
		sendMessage(message: unknown, options?: unknown): void {
			messages.push({ message, options });
		},
		sendUserMessage(content: string | unknown[], options?: unknown): void {
			messages.push({ content, options });
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: true,
		signal: { aborted: options?.aborted ?? false } as AbortSignal,
		getContextUsage: () => ({ tokens: 100, contextWindow: 1000 }),
		ui: {
			notify: (text: string, level: string) => notifyCalls.push({ text, level }),
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: {
			getEntries: () => [],
			getBranch: () => undefined,
		},
	} as unknown as ExtensionContext;

	return { pi, ctx, states, history, messages, notifyCalls };
}

function makeState(overrides?: Partial<GoalRuntimeState>): GoalRuntimeState {
	return {
		...createGoalState("test objective"),
		status: "active",
		timeStartedAt: 0,
		...overrides,
	};
}

// ── ACTION_HANDLERS 10 条完整 ────────────────────────

describe("ACTION_HANDLERS — 10 actions registered", () => {
	it("包含 7 个 task action + 3 个 subtask action", () => {
		const taskActions = ["create_tasks", "add_tasks", "update_tasks", "list_tasks", "complete_goal", "cancel_goal", "report_blocked"];
		const subtaskActions = ["add_subtasks", "update_subtasks", "delete_subtasks"];
		for (const a of taskActions) {
			expect(ACTION_HANDLERS[a]).toBeDefined();
		}
		for (const a of subtaskActions) {
			expect(ACTION_HANDLERS[a]).toBeDefined();
		}
		expect(Object.keys(ACTION_HANDLERS).length).toBeGreaterThanOrEqual(10);
	});
});

// ── buildPorts 4 port 构造 ───────────────────────────

describe("buildPorts — 4 ports construction", () => {
	it("persistence: appendState 用 GOAL_ENTRY_TYPE, appendHistory 用 HISTORY_ENTRY_TYPE", () => {
		const h = makeHarness();
		const ports = buildPorts(h.pi, h.ctx);
		ports.persistence.appendState({ x: 1 } as never);
		ports.persistence.appendHistory({ y: 2 } as never);
		expect(h.states).toHaveLength(1);
		expect(h.history).toHaveLength(1);
	});

	it("ui: notify/setStatus/setWidget + hasUI", () => {
		const h = makeHarness();
		const ports = buildPorts(h.pi, h.ctx);
		expect(ports.ui.hasUI).toBe(true);
		ports.ui.notify("hello", "info");
		expect(h.notifyCalls).toHaveLength(1);
		expect(h.notifyCalls[0]!.text).toBe("hello");
	});

	it("ui: hasUI=false 当 ctx.hasUI=false", () => {
		const h = makeHarness();
		(h.ctx as unknown as { hasUI: boolean }).hasUI = false;
		const ports = buildPorts(h.pi, h.ctx);
		expect(ports.ui.hasUI).toBe(false);
	});

	it("messaging: sendContextMessage + sendUserMessage", () => {
		const h = makeHarness();
		const ports = buildPorts(h.pi, h.ctx);
		ports.messaging.sendContextMessage("ctx msg", "steer");
		ports.messaging.sendUserMessage("user msg", "followUp");
		expect(h.messages).toHaveLength(2);
	});

	it("session: getEntries + getContextUsage + signal", () => {
		const h = makeHarness();
		const ports = buildPorts(h.pi, h.ctx);
		expect(ports.session.getEntries()).toEqual([]);
		const usage = ports.session.getContextUsage();
		expect(usage).toEqual({ tokens: 100, contextWindow: 1000 });
		expect(ports.session.signal).toBeDefined();
		expect(ports.session.signal?.aborted).toBe(false);
	});
});

// ── executeGoalAction 分发 ───────────────────────────

describe("executeGoalAction — dispatch", () => {
	it("无 active goal → errorResult", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		const result = await executeGoalAction(h.pi, session, { action: "list_tasks" } as never, h.ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("not active");
	});

	it("signal.aborted → errorResult", async () => {
		const h = makeHarness({ aborted: true });
		const session = createGoalSession();
		session.state = makeState();
		const signal = { aborted: true } as AbortSignal;
		const result = await executeGoalAction(h.pi, session, { action: "list_tasks" } as never, h.ctx, signal);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("aborted");
	});

	it("未知 action → errorResult", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeState();
		const result = await executeGoalAction(
			h.pi,
			session,
			{ action: "totally_unknown" } as never,
			h.ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("Unknown action");
	});

	it("list_tasks → 返回任务列表（成功路径）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeState({
			tasks: [
				{ id: 1, description: "task one", status: "pending", lastUpdatedTurn: 0 },
				{ id: 2, description: "task two", status: "in_progress", lastUpdatedTurn: 0 },
			],
		});
		const result = await executeGoalAction(h.pi, session, { action: "list_tasks" } as never, h.ctx);
		expect(result.isError).toBeUndefined();
		expect(result.content[0]!.text).toContain("task one");
		expect(result.content[0]!.text).toContain("task two");
	});

	it("create_tasks → 创建并 persist（成功路径）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeState();
		const result = await executeGoalAction(
			h.pi,
			session,
			{ action: "create_tasks", tasks: ["a", "b"] } as never,
			h.ctx,
		);
		expect(result.isError).toBeUndefined();
		expect(session.state!.tasks).toHaveLength(2);
		expect(h.states).toHaveLength(1); // persist 调用
	});

	it("stale context 错误 → 友好 errorResult（G-010）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeState();
		// 构造一个会抛 stale context 错误的 pi（appendEntry 抛错）
		const stalePi = {
			appendEntry(): void {
				throw new Error("The extension context was aborted and is no longer active");
			},
			sendMessage(): void {},
			sendUserMessage(): void {},
		} as unknown as ExtensionAPI;
		const result = await executeGoalAction(
			stalePi,
			session,
			{ action: "create_tasks", tasks: ["a"] } as never,
			h.ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("stale");
	});

	it("通用错误 → errorResult 含错误消息 + input 摘要", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeState();
		// 构造一个会抛通用错误的 pi
		const errorPi = {
			appendEntry(): void {
				throw new Error("disk full");
			},
			sendMessage(): void {},
			sendUserMessage(): void {},
		} as unknown as ExtensionAPI;
		const result = await executeGoalAction(
			errorPi,
			session,
			{ action: "create_tasks", tasks: ["a"] } as never,
			h.ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("disk full");
		expect(result.content[0]!.text).toContain("Input:");
	});
});
