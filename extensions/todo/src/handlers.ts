/**
 * Todo 事件处理器 — session_start / session_tree / agent_start /
 * before_agent_start / agent_end。
 *
 * 拆分理由：原 src/index.ts 中 agent_end 处理器约 60 行、before_agent_start
 * 约 40 行，均超过 §11 "事件处理器 ≤ 20 行" 限制。本文件将每个事件
 * handler 拆为 ≤ 20 行的 orchestrator + 职责单一的子函数。
 *
 * 行为契约：所有 handler 行为与原 index.ts 内的 pi.on 回调完全一致；
 * 任何与原代码的偏差都属于 bug。
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
	migrateTodo,
	type TodoDetails,
} from "./model";
import type { TodoSessionState } from "./state";

// ── 常量（与原 index.ts 内联常量保持一致） ──────────

/** v3: 全部完成后保留的轮数，之后再自动 clear */
const AUTO_CLEAR_DELAY_ROUNDS = 2;
/** v3: Stall 检测阈值（无 todo 活动轮数 → stall 提醒） */
const STALL_THRESHOLD = 5;
/** v3: 提醒间隔（上次 todo 调用后轮数 → 提醒） */
const REMINDER_INTERVAL = 3;
/** v3: 最大验证失败次数 */
const MAX_VERIFY_ATTEMPTS = 2;

// ── 辅助函数 ────────────────────────────────────────

/** 刷新状态栏 + widget（由 index.ts 注入，闭包共享 state） */
export type RefreshDisplayFn = (ctx: ExtensionContext) => void;

/** 构建 pending 任务的 <todo_context> 字符串（agent_end stall/reminder 共用） */
function buildPendingContext(state: TodoSessionState, turnCount: number): string {
	const pendingTodos = state.todos.filter((t) => t.status !== "completed");
	const pendingCount = pendingTodos.length;
	const completedCount = state.todos.filter((t) => t.status === "completed").length;
	const lines = pendingTodos
		.map((t) => {
			let verifyTag = "";
			if (t.status === "verifying") {
				verifyTag = ` [验证中${t.evidence ? ": " + t.evidence : ""}] → 需要 evidence 完成验证`;
			} else if (t.verifyText) {
				verifyTag = ` [待验证: ${t.verifyText}]`;
			}
			return `#${t.id}: ${t.text}${verifyTag}`;
		})
		.join("\n");
	return `<todo_context>\n[TODO] Turn ${turnCount} — ${pendingCount} tasks pending, ${completedCount} completed\n${lines}\n\nRules:\n- 优先使用 updates[] 批量更新\n- 有 verifyText 的任务: 先标 verifying(evidence="验证进度") → 再标 completed(evidence="验证结论")\n- 无 verifyText 的任务可直接 completed\n- 全部完成后工具自动闭合\n</todo_context>`;
}

// ── 状态重建 ────────────────────────────────────────

/** 从 session entries 重建 state（兼容旧 done:boolean 格式 + entry GC） */
export function reconstructState(state: TodoSessionState, ctx: ExtensionContext): void {
	state.todos = [];
	state.nextId = 1;
	// v3: 重置提醒追踪状态
	state.userMessageCount = 0;
	state.lastTodoCallCount = 0;
	state.stallNotified = false;
	state.allCompletedAtCount = null;

	const entries = ctx.sessionManager.getEntries();
	let latestIdx = -1;

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

		const details = msg.details as TodoDetails | undefined;
		if (details?.todos && Array.isArray(details.todos)) {
			state.todos = details.todos.map((t) => migrateTodo(t));
			state.nextId = details.nextId ?? (state.todos.length > 0 ? Math.max(...state.todos.map((t) => t.id)) + 1 : 1);
			latestIdx = i;
		}
	}

	if (latestIdx >= 0) {
		const staleIndices: number[] = [];
		for (let i = 0; i < latestIdx; i++) {
			const entry = entries[i];
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role === "toolResult" && msg.toolName === "todo") {
				staleIndices.push(i);
			}
		}
		for (let j = staleIndices.length - 1; j >= 0; j--) {
			entries.splice(staleIndices[j], 1);
		}
	}

	// auto-clear 由 agent_end 延迟处理（AUTO_CLEAR_DELAY_ROUNDS），不再在此立即清空
}

// ── before_agent_start 子函数 ───────────────────────

/** 构造 before_agent_start 返回的 todo context 消息 */
function buildBeforeAgentStartMessage(state: TodoSessionState): { message: { customType: string; content: string; display: boolean } } | undefined {
	if (state.todos.length === 0) return undefined;

	const pendingTodos = state.todos.filter((t) => t.status !== "completed");
	if (pendingTodos.length === 0) return undefined;

	// 格式化 pending 任务 (含 verifying 状态和 verifyText)
	const lines = pendingTodos.map((t) => {
		let verifyTag = "";
		if (t.status === "verifying") {
			verifyTag = ` [验证中${t.evidence ? ": " + t.evidence : ""}] → 需要 evidence 完成验证`;
		} else if (t.verifyText) {
			verifyTag = ` [待验证: ${t.verifyText}]`;
		}
		return `#${t.id}: ${t.text}${verifyTag}`;
	});

	const contextStr =
		`<todo_context>\n[TODO] ${pendingTodos.length} tasks pending\n${lines.join("\n")}\n\nRules:\n- 有 verifyText 的任务: 先标 verifying(evidence="验证进度") → 再标 completed(evidence="验证结论")\n- 无 verifyText 的任务可直接 completed\n- 全部完成后工具自动闭合\n</todo_context>`;

	return {
		message: {
			customType: "todo-context",
			content: contextStr,
			display: false,
		},
	};
}

// ── agent_end 4 个子函数 ───────────────────────────

/** 1. Auto-clear: 所有 todo 都 completed → 延迟 N 轮后 clear
 *  返回 { handled, cleared }：
 *  - handled=true → orchestrator 应直接 return（allCompleted 路径或实际已清空）
 *  - cleared=true → 实际清空了 todos，orchestrator 需要 refreshDisplay
 */
function handleAutoClear(state: TodoSessionState): { handled: boolean; cleared: boolean } {
	const allCompleted = state.todos.every((t) => t.status === "completed");
	if (!allCompleted) {
		state.allCompletedAtCount = null;
		return { handled: false, cleared: false };
	}
	if (state.allCompletedAtCount === null) {
		state.allCompletedAtCount = state.userMessageCount;
	}
	if (state.userMessageCount - state.allCompletedAtCount >= AUTO_CLEAR_DELAY_ROUNDS) {
		state.todos = [];
		state.nextId = 1;
		state.allCompletedAtCount = null;
		return { handled: true, cleared: true };
	}
	return { handled: true, cleared: false };
}

/** 2. Verify 失败处理: verifyAttempts >= MAX 且仍为 completed → 设 failed */
function handleVerifyFailure(state: TodoSessionState, pi: ExtensionAPI): boolean {
	const failedIds: number[] = [];
	for (const t of state.todos) {
		if (
			t.status === "completed" &&
			t.verifyText &&
			t.verifyAttempts >= MAX_VERIFY_ATTEMPTS
		) {
			t.status = "failed";
			failedIds.push(t.id);
		}
	}
	if (failedIds.length > 0) {
		pi.sendUserMessage(
			`<todo_context>\n[TODO] 验证失败: Task ${failedIds.map((id) => "#" + id).join(", ")} 已重试 ${MAX_VERIFY_ATTEMPTS} 次仍未通过，已标记为 failed。请决定是否手动 override。\n</todo_context>`,
			{ deliverAs: "steer", customType: "todo-context" },
		);
		return true;
	}
	return false;
}

/** 3. Stall 检测: STALL_THRESHOLD 轮未调用 todo 且还有未完成任务 */
function handleStallDetection(state: TodoSessionState, pi: ExtensionAPI): boolean {
	if (
		!state.stallNotified &&
		state.userMessageCount - state.lastTodoCallCount >= STALL_THRESHOLD
	) {
		state.stallNotified = true;
		pi.sendUserMessage(buildPendingContext(state, state.userMessageCount), { deliverAs: "steer", customType: "todo-context" });
		return true;
	}
	return false;
}

/** 4. 提醒: REMINDER_INTERVAL 轮未调用 todo */
function handleReminder(state: TodoSessionState, pi: ExtensionAPI): boolean {
	if (state.userMessageCount - state.lastTodoCallCount >= REMINDER_INTERVAL) {
		pi.sendUserMessage(buildPendingContext(state, state.userMessageCount), { deliverAs: "steer", customType: "todo-context" });
		return true;
	}
	return false;
}

// ── Event handler 注册入口 ──────────────────────────

/** 注册所有 todo 事件处理器到 pi */
export function registerTodoEventHandlers(
	pi: ExtensionAPI,
	state: TodoSessionState,
	refreshDisplay: RefreshDisplayFn,
): void {
	// session_start / session_tree: 重建 state + 刷新显示
	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		reconstructState(state, ctx);
		refreshDisplay(ctx);
	});
	pi.on("session_tree", async (_event: unknown, ctx: ExtensionContext) => {
		reconstructState(state, ctx);
		refreshDisplay(ctx);
	});

	// v3: 追踪用户消息轮数
	pi.on("agent_start", async (_event: unknown, _ctx: ExtensionContext) => {
		state.userMessageCount++;
	});

	// v3: Task 6 - before_agent_start 注入 todo context (display: false)
	pi.on("before_agent_start", async (_event: unknown, ctx: ExtensionContext) => {
		try {
			const pendingTodos = state.todos.filter((t) => t.status !== "completed");
			if (pendingTodos.length > 0) {
				ctx.ui.setStatus("todo", `📋 ${pendingTodos.length} pending`);
			}
			return buildBeforeAgentStartMessage(state);
		} catch (e) {
			console.debug("[todo] before_agent_start error:", e);
			return undefined;
		}
	});

	// agent_end: auto-clear + verify-failed + stall + reminder (≤ 20 行 orchestrator)
	pi.on("agent_end", async (_event: unknown, ctx: ExtensionContext) => {
		try {
			if (state.todos.length === 0) return;
			const ac = handleAutoClear(state);
			if (ac.handled) { if (ac.cleared) refreshDisplay(ctx); return; }
			if (handleVerifyFailure(state, pi)) { refreshDisplay(ctx); return; }
			if (handleStallDetection(state, pi)) return;
			handleReminder(state, pi);
		} catch (e) {
			console.debug("[todo] agent_end error:", e);
		}
	});
}
