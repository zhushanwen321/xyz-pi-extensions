/**
 * event-adapter.ts 测试 — agent_end / before_agent_start 核心逻辑
 *
 * 覆盖 agent_end 的 4 层分支优先级（FR-8.7）+ ESC 守卫（FR-6.7）+
 * before_agent_start 的 AUTO_CLEAR/staleness/context wrap-up。
 *
 * 用 fake pi + fake ctx（不 import Pi SDK）。handler 签名 (pi, session, ctx) → void/result。
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
	type BeforeAgentStartResult,
	handleAgentEnd,
	handleBeforeAgentStart,
} from "../adapters/event-adapter";
import { createGoalState } from "../engine/goal";
import type { GoalTask } from "../engine/task";
import type { GoalRuntimeState } from "../engine/types";
import { createGoalSession } from "../session";

// ── Fake pi / ctx ────────────────────────────────────

interface RecordedCall {
	kind: "appendState" | "appendHistory" | "notify" | "sendContext" | "sendUser" | "setStatus" | "setWidget";
	payload?: unknown;
	text?: string;
	level?: string;
	content?: string;
	deliverAs?: string;
	customType?: string;
	key?: string;
}

function makeFakePi(): { pi: ExtensionAPI; calls: RecordedCall[]; states: unknown[]; history: unknown[] } {
	const calls: RecordedCall[] = [];
	const states: unknown[] = [];
	const history: unknown[] = [];
	const pi = {
		appendEntry(customType: string, data?: unknown): void {
			calls.push({ kind: customType === "goal-history" ? "appendHistory" : "appendState", payload: data });
			if (customType === "goal-history") history.push(data);
			else states.push(data);
		},
		sendMessage(message: unknown, _options?: unknown): void {
			const msg = message as { customType?: string; content?: string; display?: boolean };
			calls.push({
				kind: "sendContext",
				content: msg.content,
				customType: msg.customType,
				payload: _options,
			});
		},
		sendUserMessage(_content: string | unknown[], _options?: unknown): void {
			calls.push({ kind: "sendUser", content: typeof _content === "string" ? _content : undefined });
		},
	} as unknown as ExtensionAPI;
	return { pi, calls, states, history };
}

function makeFakeCtx(overrides?: {
	aborted?: boolean;
	hasUI?: boolean;
	contextUsage?: { tokens?: number; contextWindow?: number };
}): { ctx: ExtensionContext; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const signal = { aborted: overrides?.aborted ?? false } as AbortSignal;
	const ctx = {
		hasUI: overrides?.hasUI ?? true,
		signal,
		getContextUsage: () => overrides?.contextUsage,
		ui: {
			notify: (text: string, level: string) => {
				calls.push({ kind: "notify", text, level });
			},
			setStatus: (key: string, text: string | undefined) => {
				calls.push({ kind: "setStatus", key, text });
			},
			setWidget: (key: string, _content: unknown) => {
				calls.push({ kind: "setWidget", key });
			},
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		},
		sessionManager: { getEntries: () => [], getBranch: () => undefined },
	} as unknown as ExtensionContext;
	return { ctx, calls };
}

/** 把 pi.calls 和 ctx.calls 合并（实际调用时都 push 到各自数组） */
function allCalls(piCalls: RecordedCall[], ctxCalls: RecordedCall[]): RecordedCall[] {
	return [...piCalls, ...ctxCalls];
}

// ── 辅助：构造 task / state ──────────────────────────

function makeTask(id: number, status: GoalTask["status"], lastUpdatedTurn = 0): GoalTask {
	return { id, description: `task ${id}`, status, lastUpdatedTurn };
}

function makeRunningState(overrides?: Partial<GoalRuntimeState>): GoalRuntimeState {
	return {
		...createGoalState("test objective"),
		timeStartedAt: 0, // 关闭时间累计（避免测试随机性）
		...overrides,
	};
}

/** 全部 task 已完成的 state */
function makeAllDoneState(): GoalRuntimeState {
	return makeRunningState({
		tasks: [makeTask(1, "completed"), makeTask(2, "verified")],
	});
}

// ── handleAgentEnd：ESC 守卫 ──────────────────────────

describe("handleAgentEnd — FR-6.7 ESC 守卫", () => {
	it("aborted=true：不发 continuation、不递增 stall、不做 budget 检查、goal 保持 active", async () => {
		const { pi, calls: piCalls, states } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx({ aborted: true });
		const session = createGoalSession();
		session.state = makeRunningState({ tokensUsed: 1000, lastTurnTokensUsed: 0 });

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		// 不发 continuation（无 sendContext/sendUser）
		expect(all.filter((c) => c.kind === "sendContext" || c.kind === "sendUser")).toHaveLength(0);
		// 不做 budget 检查（无 notify 关于 budget）
		expect(all.filter((c) => c.kind === "notify")).toHaveLength(0);
		// goal 保持 active（status 不变）
		expect(session.state!.status).toBe("active");
		// 不 persist（ESC 不触发副作用）
		expect(states).toHaveLength(0);
		// 不递增 stallCount
		expect(session.state!.stallCount).toBe(0);
	});

	it("aborted=true + 终态：仍走终态 notify（ESC 不影响终态路径）", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx({ aborted: true });
		const session = createGoalSession();
		session.state = makeRunningState({ status: "complete", tasks: [makeTask(1, "completed")] });

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		// 终态 notify 仍触发
		const notify = all.filter((c) => c.kind === "notify");
		expect(notify).toHaveLength(1);
		expect(notify[0]!.text).toContain("Objective completed");
	});
});

// ── handleAgentEnd：FR-8.7 分支 1 — allTasksDone ──────

describe("handleAgentEnd — FR-8.7 分支 1: allTasksDone", () => {
	it("1a: allTasksDone + maxTurnsReached → complete（不因 maxTurns 变 cancelled）", async () => {
		const { pi, calls: piCalls, history } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx();
		const session = createGoalSession();
		session.state = makeAllDoneState();
		session.state.currentTurnIndex = 50; // = maxTurns (50)
		session.tasksCompletedAtAgentStart = 2;

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		expect(session.state!.status).toBe("complete");
		expect(session.state!.completedAtTurnIndex).toBe(50);
		// 写 history
		expect(history).toHaveLength(1);
		// notify 含 "All tasks completed"
		const notify = all.filter((c) => c.kind === "notify");
		expect(notify[0]!.text).toContain("All tasks completed");
	});

	it("1b: allTasksDone + budgetTight → steer（立即收尾）", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx();
		const session = createGoalSession();
		session.state = makeRunningState({
			tasks: [makeTask(1, "completed"), makeTask(2, "completed")],
			budget: { maxStallTurns: 5, maxTurns: 50, tokenBudget: 1000 },
			tokensUsed: 850, // 85% >= 80% (RATIO_TIGHT)
		});
		session.tasksCompletedAtAgentStart = 2;

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		// 不转终态（仍 active，等 LLM 调 complete_goal）
		expect(session.state!.status).toBe("active");
		// 发 steer 消息
		const sendContext = all.filter((c) => c.kind === "sendContext");
		expect(sendContext).toHaveLength(1);
	});

	it("1c: allTasksDone + 正常 → followUp（提示 complete_goal）", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx();
		const session = createGoalSession();
		session.state = makeAllDoneState();
		session.tasksCompletedAtAgentStart = 2;

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		expect(session.state!.status).toBe("active");
		const sendContext = all.filter((c) => c.kind === "sendContext");
		expect(sendContext).toHaveLength(1);
		expect(sendContext[0]!.content).toContain("complete_goal");
	});
});

// ── handleAgentEnd：FR-8.7 分支 2 — noTasksCreated ────

describe("handleAgentEnd — FR-8.7 分支 2: noTasksCreated", () => {
	it("2a: noTasksCreated + maxTurnsReached → cancelled", async () => {
		const { pi, calls: piCalls, history } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx();
		const session = createGoalSession();
		session.state = makeRunningState({ currentTurnIndex: 50, tasks: [] });

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		expect(session.state!.status).toBe("cancelled");
		expect(history).toHaveLength(1);
		const notify = all.filter((c) => c.kind === "notify");
		expect(notify[0]!.text).toContain("Max turns");
	});

	it("2b: noTasksCreated + 正常 → followUp（提示 create_tasks 或 cancel）", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx();
		const session = createGoalSession();
		session.state = makeRunningState({ tasks: [] });

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		expect(session.state!.status).toBe("active");
		const sendContext = all.filter((c) => c.kind === "sendContext");
		expect(sendContext[0]!.content).toContain("create_tasks");
	});
});

// ── handleAgentEnd：FR-8.7 分支 3 — maxTurnsReached（有未完成）───

describe("handleAgentEnd — FR-8.7 分支 3: maxTurnsReached + 有未完成", () => {
	it("有未完成 + maxTurnsReached → cancelled", async () => {
		const { pi, calls: piCalls, history } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx();
		const session = createGoalSession();
		session.state = makeRunningState({
			tasks: [makeTask(1, "completed"), makeTask(2, "in_progress")],
			currentTurnIndex: 50,
		});

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		expect(session.state!.status).toBe("cancelled");
		expect(history).toHaveLength(1);
		const notify = all.filter((c) => c.kind === "notify");
		expect(notify[0]!.text).toContain("1 tasks still incomplete");
	});
});

// ── handleAgentEnd：FR-8.7 分支 4 — stall + continuation ────

describe("handleAgentEnd — FR-8.7 分支 4: stall 检测 + continuation", () => {
	it("stall 检测：completedCount 未增 → stallCount++", async () => {
		const { pi } = makeFakePi();
		const { ctx } = makeFakeCtx();
		const session = createGoalSession();
		// 2 个未完成 task（确保不命中 allTasksDone）
		// baseline=0，completedCount=0 → isStalled=(0-0===0)=true
		session.state = makeRunningState({
			tasks: [makeTask(1, "in_progress"), makeTask(2, "pending")],
			lastTurnTokensUsed: 0,
			tokensUsed: 100, // tokenDelta > 0 → 发 continuation
		});
		session.tasksCompletedAtAgentStart = 0;

		await handleAgentEnd(pi, session, ctx);

		expect(session.state!.stallCount).toBe(1);
		expect(session.state!.status).toBe("active"); // 未超 maxStallTurns
	});

	it("有进展：completedCount 增加 → stallCount 重置", async () => {
		const { pi } = makeFakePi();
		const { ctx } = makeFakeCtx();
		const session = createGoalSession();
		// 1 完成 + 1 未完成（不全完成，不走 branch 1）
		// baseline=0，completedCount=1 → isStalled=(1-0===0)=false → 有进展
		session.state = makeRunningState({
			tasks: [makeTask(1, "completed"), makeTask(2, "in_progress")],
			tokensUsed: 100,
		});
		session.tasksCompletedAtAgentStart = 0;

		await handleAgentEnd(pi, session, ctx);

		expect(session.state!.stallCount).toBe(0);
		expect(session.state!.lastProgressTurn).toBe(session.state!.currentTurnIndex);
	});

	it("stall 超限（stallCount >= maxStallTurns）→ blocked", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx();
		const session = createGoalSession();
		// baseline=0, completedCount=0 → isStalled=true → stallCount++ (4→5)
		// 5 >= maxStallTurns(5) → blocked
		session.state = makeRunningState({
			tasks: [makeTask(1, "in_progress"), makeTask(2, "pending")],
			tokensUsed: 100,
			stallCount: 4,
		});
		session.tasksCompletedAtAgentStart = 0;

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		expect(session.state!.status).toBe("blocked");
		const notify = all.filter((c) => c.kind === "notify");
		expect(notify[0]!.text).toContain("auto-blocked");
	});

	it("continuation 去抖：tokenDelta=0（空 turn）不发", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx();
		const session = createGoalSession();
		// 未完成 task + baseline=0, completedCount=0 → isStalled=true，但未超限
		session.state = makeRunningState({
			tasks: [makeTask(1, "in_progress"), makeTask(2, "pending")],
			tokensUsed: 100,
			lastTurnTokensUsed: 100, // tokenDelta = 0
		});
		session.tasksCompletedAtAgentStart = 0;

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		const sendContext = all.filter((c) => c.kind === "sendContext");
		expect(sendContext).toHaveLength(0); // 空 turn 不发
		// isStalled=true → stallCount++（=1）
		expect(session.state!.stallCount).toBe(1);
	});

	it("continuation 正常：tokenDelta>0 → 发 continuationPrompt", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx();
		const session = createGoalSession();
		// 未完成 task + baseline=0, completedCount=0 → isStalled=true，但未超限
		session.state = makeRunningState({
			tasks: [makeTask(1, "in_progress"), makeTask(2, "pending")],
			tokensUsed: 200,
			lastTurnTokensUsed: 0, // tokenDelta = 200 > 0
		});
		session.tasksCompletedAtAgentStart = 0;

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		const sendContext = all.filter((c) => c.kind === "sendContext");
		expect(sendContext).toHaveLength(1);
		expect(sendContext[0]!.content).toContain("[GOAL]");
	});
});

// ── handleAgentEnd：并发保护（G-021）+ stale（G-020）───

describe("handleAgentEnd — 并发保护 + stale 快照", () => {
	it("isProcessing=true → 直接返回（防重入）", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx();
		const session = createGoalSession();
		session.state = makeAllDoneState();
		session.isProcessing = true; // 已锁

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		// 无任何副作用
		expect(all).toHaveLength(0);
	});

	it("finally 块释放 isProcessing（即使中途 return）", async () => {
		const { pi } = makeFakePi();
		const { ctx } = makeFakeCtx({ aborted: true });
		const session = createGoalSession();
		session.state = makeRunningState();

		await handleAgentEnd(pi, session, ctx);

		expect(session.isProcessing).toBe(false);
	});

	it("state=null → 直接返回（无 goal 时）", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx();
		const session = createGoalSession();
		// session.state 保持 null

		await handleAgentEnd(pi, session, ctx);

		expect(allCalls(piCalls, ctxCalls)).toHaveLength(0);
	});
});

// ── handleBeforeAgentStart ────────────────────────────

describe("handleBeforeAgentStart", () => {
	it("state=null → 返回 undefined", async () => {
		const { pi } = makeFakePi();
		const { ctx } = makeFakeCtx();
		const session = createGoalSession();

		const result = await handleBeforeAgentStart(pi, session, ctx);

		expect(result).toBeUndefined();
	});

	it("正常 active goal → 返回 context injection 消息", async () => {
		const { pi } = makeFakePi();
		const { ctx } = makeFakeCtx();
		const session = createGoalSession();
		session.state = makeRunningState({ tasks: [makeTask(1, "in_progress")] });

		const result = await handleBeforeAgentStart(pi, session, ctx);

		expect(result).toBeDefined();
		expect(result!.message.customType).toBe("goal-context");
		expect(result!.message.content).toContain("[GOAL mode activated]");
		expect(result!.message.display).toBe(false);
	});

	// FR-8.1 G-007: AUTO_CLEAR_TURNS=2
	it("终态 + turnsInTerminal >= 2 → clearGoalSession（state 清空）", async () => {
		const { pi } = makeFakePi();
		const { ctx } = makeFakeCtx();
		const session = createGoalSession();
		session.state = makeRunningState({
			status: "complete",
			currentTurnIndex: 10,
			completedAtTurnIndex: 8, // turnsInTerminal = 2 >= AUTO_CLEAR_TURNS
			tasks: [makeTask(1, "completed")],
		});

		const result = await handleBeforeAgentStart(pi, session, ctx);

		expect(result).toBeUndefined();
		expect(session.state).toBeNull();
	});

	it("终态 + turnsInTerminal < 2 → 不清理，折叠 status bar", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx({ hasUI: true });
		const session = createGoalSession();
		session.state = makeRunningState({
			status: "complete",
			currentTurnIndex: 10,
			completedAtTurnIndex: 9, // turnsInTerminal = 1 < 2
			tasks: [makeTask(1, "completed")],
		});

		const result = await handleBeforeAgentStart(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		expect(result).toBeUndefined();
		expect(session.state).not.toBeNull(); // 未清理
		// setStatus 触发（折叠为终态单行）
		expect(all.filter((c) => c.kind === "setStatus" && c.key === "goal").length).toBeGreaterThan(0);
	});

	// FR-8.6 staleness reminder（TASK_STALL_TURN_THRESHOLD=10）
	it("停滞 task（lastUpdatedTurn 落后 >= 10）→ 注入 staleness reminder + 重置 lastUpdatedTurn", async () => {
		const { pi } = makeFakePi();
		const { ctx } = makeFakeCtx();
		const session = createGoalSession();
		session.state = makeRunningState({
			currentTurnIndex: 15,
			tasks: [makeTask(1, "in_progress", 5)], // staleTurns = 15 - 5 = 10 >= 10
		});

		const result = await handleBeforeAgentStart(pi, session, ctx) as BeforeAgentStartResult;

		expect(result).toBeDefined();
		expect(result!.message.customType).toBe("goal-staleness-reminder");
		expect(result!.message.content).toContain("stalled");
		// lastUpdatedTurn 被重置为 currentTurnIndex
		expect(session.state!.tasks[0]!.lastUpdatedTurn).toBe(15);
	});

	it("所有 task 已终态但 goal 仍 active → 注入 allTerminal 提醒", async () => {
		const { pi } = makeFakePi();
		const { ctx } = makeFakeCtx();
		const session = createGoalSession();
		session.state = makeRunningState({
			tasks: [makeTask(1, "completed"), makeTask(2, "verified")],
		});

		const result = await handleBeforeAgentStart(pi, session, ctx) as BeforeAgentStartResult;

		expect(result).toBeDefined();
		expect(result!.message.customType).toBe("goal-staleness-reminder");
		expect(result!.message.content).toContain("complete_goal");
	});

	// ADR-002 context usage 提示（CONTEXT_USAGE_RATIO_LIMIT=0.85，保持 active）
	it("context 使用率 > 85% → 保持 active + 注入 wrap-up 指令", async () => {
		const { pi } = makeFakePi();
		const { ctx } = makeFakeCtx({ contextUsage: { tokens: 9000, contextWindow: 10000 } }); // 90% > 85%
		const session = createGoalSession();
		session.state = makeRunningState({ tasks: [makeTask(1, "in_progress")] });

		const result = await handleBeforeAgentStart(pi, session, ctx) as BeforeAgentStartResult;

		expect(result).toBeDefined();
		expect(result!.message.customType).toBe("goal-context-exceeded");
		// ADR-002：goal 保持 active（不转 paused）
		expect(session.state!.status).toBe("active");
	});

	it("context 使用率 <= 85% → 正常 context injection", async () => {
		const { pi } = makeFakePi();
		const { ctx } = makeFakeCtx({ contextUsage: { tokens: 5000, contextWindow: 10000 } }); // 50%
		const session = createGoalSession();
		session.state = makeRunningState({ tasks: [makeTask(1, "in_progress")] });

		const result = await handleBeforeAgentStart(pi, session, ctx) as BeforeAgentStartResult;

		expect(result!.message.customType).toBe("goal-context");
		expect(session.state!.status).toBe("active");
	});

	it("非 active（blocked）→ 返回 undefined（不注入）", async () => {
		const { pi } = makeFakePi();
		const { ctx } = makeFakeCtx();
		const session = createGoalSession();
		session.state = makeRunningState({ status: "blocked" });

		const result = await handleBeforeAgentStart(pi, session, ctx);

		expect(result).toBeUndefined();
	});
});
