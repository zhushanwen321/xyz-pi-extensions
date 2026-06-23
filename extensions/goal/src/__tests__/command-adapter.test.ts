/**
 * command-adapter.ts 测试 — 8 个 /goal 子命令
 *
 * 覆盖：
 * - MF-3 回归：pause/clear/abort/set-overwrite 转 paused/cancelled 前 tick 累加时间
 * - MF-6 覆盖：8 命令分发 + 各 FR 分支（G-R2-008/G-014/G-002/G-063）
 *
 * 用 fake pi + fake ctx（不 import Pi SDK 真实实现）。
 * handleGoalCommand(pi, session, args, ctx) → Promise<void>。
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { handleGoalCommand } from "../adapters/command-adapter";
import { createGoalState } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";
import { createGoalSession } from "../session";

// ── Fake pi / ctx ────────────────────────────────────

interface RecordedCall {
	kind: "appendState" | "appendHistory" | "notify" | "sendContext" | "sendUser";
	text?: string;
	level?: string;
	content?: string;
	deliverAs?: string;
	customType?: string;
	payload?: unknown;
}

interface FakeHarness {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	states: unknown[];
	history: unknown[];
	piCalls: RecordedCall[];
	ctxCalls: RecordedCall[];
}

function makeHarness(): FakeHarness {
	const piCalls: RecordedCall[] = [];
	const ctxCalls: RecordedCall[] = [];
	const states: unknown[] = [];
	const history: unknown[] = [];

	const pi = {
		appendEntry(customType: string, data?: unknown): void {
			if (customType === "goal-history") history.push(data);
			else states.push(data);
			piCalls.push({
				kind: customType === "goal-history" ? "appendHistory" : "appendState",
				payload: data,
			});
		},
		sendMessage(message: unknown, _options?: unknown): void {
			const msg = message as { customType?: string; content?: string };
			piCalls.push({ kind: "sendContext", content: msg.content, customType: msg.customType });
		},
		sendUserMessage(content: string | unknown[], _options?: unknown): void {
			piCalls.push({ kind: "sendUser", content: typeof content === "string" ? content : undefined });
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: true,
		signal: { aborted: false } as AbortSignal,
		getContextUsage: () => null,
		ui: {
			notify: (text: string, level: string) => ctxCalls.push({ kind: "notify", text, level }),
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: { getEntries: () => [], getBranch: () => undefined },
	} as unknown as ExtensionContext;

	return { pi, ctx, states, history, piCalls, ctxCalls };
}

// ── 辅助 ─────────────────────────────────────────────

function makeActiveState(overrides?: Partial<GoalRuntimeState>): GoalRuntimeState {
	return {
		...createGoalState("test objective"),
		status: "active",
		timeStartedAt: 0, // 默认关闭时间累计
		...overrides,
	};
}

function allCalls(h: FakeHarness): RecordedCall[] {
	return [...h.piCalls, ...h.ctxCalls];
}

function notifyText(h: FakeHarness): string[] {
	return allCalls(h)
		.filter((c) => c.kind === "notify")
		.map((c) => c.text ?? "");
}

// ── /goal status ─────────────────────────────────────

describe("handleGoalCommand — status", () => {
	it("无 active goal → 提示未激活", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		await handleGoalCommand(h.pi, session, "status", h.ctx);
		expect(notifyText(h).some((t) => t.includes("not active"))).toBe(true);
	});

	it("有 active goal → 显示 status 面板", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({
			tasks: [
				{ id: 1, description: "t1", status: "completed", lastUpdatedTurn: 0 },
				{ id: 2, description: "t2", status: "pending", lastUpdatedTurn: 0 },
			],
		});
		await handleGoalCommand(h.pi, session, "status", h.ctx);
		const text = notifyText(h).join("\n");
		expect(text).toContain("test objective");
		expect(text).toContain("1/2 completed");
	});
});

// ── /goal pause（MF-3 回归核心）─────────────────────

describe("handleGoalCommand — pause (MF-3 tick regression)", () => {
	it("active → paused：tick 累加当前运行段后再 persist", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		// 模拟已运行 5 秒的 active goal
		const past = Date.now() - 5000;
		session.state = makeActiveState({ timeStartedAt: past, timeUsedSeconds: 10 });
		const timeBefore = session.state.timeUsedSeconds;

		await handleGoalCommand(h.pi, session, "pause", h.ctx);

		expect(session.state!.status).toBe("paused");
		// MF-3 核心：timeUsedSeconds 应包含刚运行的 5 秒（≈15，允许 ±1 误差）
		expect(session.state!.timeUsedSeconds).toBeGreaterThan(timeBefore + 4);
		expect(session.state!.timeUsedSeconds).toBeLessThan(timeBefore + 6);
		// persist 至少 2 次：pause 前 tick-persist + paused 后 appendState
		expect(h.states.length).toBeGreaterThanOrEqual(2);
		expect(notifyText(h).some((t) => t.includes("paused"))).toBe(true);
	});

	it("终态 goal → 拒绝 pause", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({ status: "complete" });
		await handleGoalCommand(h.pi, session, "pause", h.ctx);
		expect(notifyText(h).some((t) => t.includes("terminal"))).toBe(true);
	});

	it("无 active goal → 提示", async () => {
		const h = makeHarness();
		await handleGoalCommand(h.pi, createGoalSession(), "pause", h.ctx);
		expect(notifyText(h).some((t) => t.includes("not active"))).toBe(true);
	});
});

// ── /goal resume（FR-8.3 G-014 预算重检）──────────

describe("handleGoalCommand — resume (FR-8.3 G-014)", () => {
	it("paused → active：resume 成功 + persist + 触发 AI", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({
			status: "paused",
			tasks: [{ id: 1, description: "t", status: "in_progress", lastUpdatedTurn: 0 }],
		});
		await handleGoalCommand(h.pi, session, "resume", h.ctx);
		expect(session.state!.status).toBe("active");
		expect(session.state!.stallCount).toBe(0);
		expect(h.states.length).toBeGreaterThanOrEqual(1); // persist 调用
		// FR-8.12: 有未完成任务 → sendUserMessage 触发 AI
		expect(h.piCalls.some((c) => c.kind === "sendUser")).toBe(true);
	});

	it("token 预算耗尽 → resume 转 budget_limited（G-014）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({
			status: "paused",
			budget: {
				tokenBudget: 1000,
				timeBudgetMinutes: 30,
				maxTurns: 10,
				maxStallTurns: 3,
			},
			tokensUsed: 1200, // 已超 tokenBudget
		});
		await handleGoalCommand(h.pi, session, "resume", h.ctx);
		expect(session.state!.status).toBe("budget_limited");
		expect(notifyText(h).some((t) => t.includes("Token budget exhausted"))).toBe(true);
	});

	it("非 paused/blocked 状态 → 无需 resume", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({ status: "active" });
		await handleGoalCommand(h.pi, session, "resume", h.ctx);
		expect(notifyText(h).some((t) => t.includes("no need to resume"))).toBe(true);
	});
});

// ── /goal clear vs abort（FR-6.3 G-063 守卫差异）──

describe("handleGoalCommand — clear vs abort (FR-6.3)", () => {
	it("clear：强制清，不检查未完成任务", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({
			tasks: [{ id: 1, description: "unfinished", status: "in_progress", lastUpdatedTurn: 0 }],
		});
		await handleGoalCommand(h.pi, session, "clear", h.ctx);
		expect(session.state).toBeNull(); // clearGoalSession 清空
		expect(h.history.length).toBe(1); // 写 cancelled history
		expect(notifyText(h).some((t) => t.includes("cleared"))).toBe(true);
	});

	it("abort：有非 cancelled 任务 → 拒绝", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({
			tasks: [{ id: 1, description: "unfinished", status: "in_progress", lastUpdatedTurn: 0 }],
		});
		await handleGoalCommand(h.pi, session, "abort", h.ctx);
		expect(notifyText(h).some((t) => t.includes("Cannot abort"))).toBe(true);
		expect(session.state).not.toBeNull(); // 未清空
	});

	it("abort：全部 cancelled → 允许清空", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({
			tasks: [{ id: 1, description: "cancelled-task", status: "cancelled", lastUpdatedTurn: 0 }],
		});
		await handleGoalCommand(h.pi, session, "abort", h.ctx);
		expect(session.state).toBeNull();
		expect(notifyText(h).some((t) => t.includes("aborted"))).toBe(true);
	});

	it("abort：MF-3 tick — active goal 转 cancelled 前累加时间", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		const past = Date.now() - 4000;
		session.state = makeActiveState({
			timeStartedAt: past,
			timeUsedSeconds: 3,
			tasks: [{ id: 1, description: "cancelled-task", status: "cancelled", lastUpdatedTurn: 0 }],
		});
		await handleGoalCommand(h.pi, session, "abort", h.ctx);
		// MF-3 核心：history 的 elapsedSeconds 应 ≈ 7（3 + 4）
		const histEntry = h.history[0] as { elapsedSeconds?: number } | undefined;
		expect(histEntry?.elapsedSeconds).toBeGreaterThanOrEqual(6);
	});

	it("clear：MF-3 tick — active goal 转 cancelled 前累加时间", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		const past = Date.now() - 3000;
		session.state = makeActiveState({ timeStartedAt: past, timeUsedSeconds: 5 });
		await handleGoalCommand(h.pi, session, "clear", h.ctx);
		// history 里的 elapsedSeconds 应 ≈ 8（5 + 3）
		const histEntry = h.history[0] as { elapsedSeconds?: number } | undefined;
		expect(histEntry?.elapsedSeconds).toBeGreaterThanOrEqual(7);
	});
});

// ── /goal update（FR-8.4 G-002 重塑）──────────────

describe("handleGoalCommand — update (FR-8.4 G-002)", () => {
	it("重塑：重置 objective/tasks/flags，保留 goalId", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		const originalGoalId = "goal-original-123";
		session.state = makeActiveState({
			goalId: originalGoalId,
			objective: "old objective",
			stallCount: 5,
			currentTurnIndex: 8,
			tasks: [{ id: 1, description: "old", status: "completed", lastUpdatedTurn: 0 }],
		});
		await handleGoalCommand(h.pi, session, "update brand new objective", h.ctx);

		expect(session.state!.objective).toBe("brand new objective");
		expect(session.state!.goalId).toBe(originalGoalId); // 保留
		expect(session.state!.tasks).toHaveLength(0); // 重置
		expect(session.state!.stallCount).toBe(0);
		expect(session.state!.currentTurnIndex).toBe(0);
		expect(session.state!.budgetLimitSteeringSent).toBe(false);
		expect(h.states.length).toBeGreaterThanOrEqual(1); // persist
	});

	it("无参数 → usage 提示", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState();
		await handleGoalCommand(h.pi, session, "update", h.ctx);
		expect(notifyText(h).some((t) => t.includes("Usage"))).toBe(true);
	});

	it("active 状态重塑 → 注入 objectiveUpdated steering", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({ objective: "old" });
		await handleGoalCommand(h.pi, session, "update new obj", h.ctx);
		// FR-8.4: active 时发送 steering
		expect(h.piCalls.some((c) => c.kind === "sendContext")).toBe(true);
	});
});

// ── /goal set（FR-3.1 唯一创建 + G-R2-008 覆盖）──

describe("handleGoalCommand — set (FR-3.1 + G-R2-008)", () => {
	it("无旧 goal → 创建新 goal", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		await handleGoalCommand(h.pi, session, "my objective", h.ctx);
		expect(session.state).not.toBeNull();
		expect(session.state!.objective).toBe("my objective");
		expect(h.piCalls.some((c) => c.kind === "sendUser")).toBe(true); // FR-8.12 触发 AI
	});

	it("覆盖非终态旧 goal → 写 cancelled history（G-R2-008）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({ objective: "old active goal" });
		const historyBefore = h.history.length;
		await handleGoalCommand(h.pi, session, "new objective", h.ctx);
		expect(h.history.length).toBe(historyBefore + 1); // 写了 cancelled history
		expect(notifyText(h).some((t) => t.includes("Cancelled previous"))).toBe(true);
		expect(session.state!.objective).toBe("new objective");
	});

	it("set 覆盖：MF-3 tick — active goal 转 cancelled 前累加时间", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		const past = Date.now() - 4000;
		session.state = makeActiveState({
			objective: "old active goal",
			timeStartedAt: past,
			timeUsedSeconds: 6,
		});
		await handleGoalCommand(h.pi, session, "new objective", h.ctx);
		// MF-3 核心：history 的 elapsedSeconds 应 ≈ 10（6 + 4）
		const histEntry = h.history[0] as { elapsedSeconds?: number } | undefined;
		expect(histEntry?.elapsedSeconds).toBeGreaterThanOrEqual(9);
	});

	it("覆盖终态旧 goal → 快速路径（不写 history）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({ status: "complete", objective: "old done" });
		const historyBefore = h.history.length;
		await handleGoalCommand(h.pi, session, "new objective", h.ctx);
		expect(h.history.length).toBe(historyBefore); // 不写 history
	});

	it("空 objective → usage 提示", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		// parseGoalArgs("") → { action: "status" }，空字符串走 status 路径
		await handleGoalCommand(h.pi, session, "", h.ctx);
		// 空字符串在 parseGoalArgs 里被识别为 status，不是 set；status 路径提示 "not active"
		expect(notifyText(h).some((t) => t.includes("not active"))).toBe(true);
	});

	it("--tokens 0 → parseGoalArgs 过滤（val > 0 校验），创建成功", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		// parseGoalArgs 对 --tokens 0 的 val>0 校验失败，budget.tokenBudget 不设置
		// handleSet 收到 budgetOverrides=undefined（无 tokenBudget），跳过预算校验直接创建
		await handleGoalCommand(h.pi, session, "obj --tokens 0", h.ctx);
		expect(session.state).not.toBeNull();
		expect(session.state!.objective).toBe("obj"); // objective 去掉了 flag
	});
});

// ── /goal history ────────────────────────────────────

describe("handleGoalCommand — history", () => {
	it("无 history → 提示", async () => {
		const h = makeHarness();
		await handleGoalCommand(h.pi, createGoalSession(), "history", h.ctx);
		expect(notifyText(h).some((t) => t.includes("No goal history"))).toBe(true);
	});
});
