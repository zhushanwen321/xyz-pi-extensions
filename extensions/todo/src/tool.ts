/**
 * Todo tool 注册 + execute dispatcher + 5 个 action handler。
 *
 * 拆分理由：原 src/index.ts 的 executeTodoAction 函数 318 行（远超 80 行
 * 限制），且工厂函数体也 612 行。本文件将 dispatcher 与子 handler 分离，
 * 满足 §11 "单文件 ≤ 500 行" 与 "函数 ≤ 80 行" 规范。
 *
 * 行为契约：所有 handler 行为与原 index.ts 内的 switch case 完全一致；
 * 任何与原代码的偏差都属于 bug。
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static,Type } from "typebox";

import {
	addTodos,
	buildRender,
	formatTodoLine,
	type Todo,
	type TodoDetails,
	updateTodos,
	VALID_STATUSES,
} from "./model";
import { renderTodoResult } from "./render";
import type { TodoSessionState } from "./state";

// ── Action 参数类型（dispatcher → handler） ──────────

export interface TodoActionParams {
	action: string;
	text?: string;
	id?: number;
	texts?: string[];
	ids?: number[];
	status?: string;
	verifyTexts?: string[];
	updates?: Array<{ id: number; status?: string; text?: string; verified?: boolean; evidence?: string }>;
	verified?: boolean;
	evidence?: string;
}

// ── TodoParams schema（依赖 Pi 运行时包） ────────────

export const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "update", "delete", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for update action)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for update action)" })),
	texts: Type.Optional(Type.Array(Type.String(), { description: "Todo text list (for add action)" })),
	ids: Type.Optional(Type.Array(Type.Number(), { description: "Todo ID list (for delete action)" })),
	status: Type.Optional(
		StringEnum(VALID_STATUSES, { description: "Target status (for update action)" }),
	),
	verifyTexts: Type.Optional(
		Type.Array(Type.String(), {
			description: "Verification text list (one per texts entry, for add action)",
		}),
	),
	updates: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.Number({ description: "Todo ID to update (in batch updates[])" }),
				status: Type.Optional(
					Type.String({ description: "Target status (in batch updates[]); one of pending/in_progress/verifying/completed/failed" }),
				),
				text: Type.Optional(Type.String({ description: "New todo text (in batch updates[])" })),
				verified: Type.Optional(Type.Boolean({ description: "Required true when skipping verifying to mark completed on tasks with verifyText" })),
				evidence: Type.Optional(Type.String({ description: "Verification evidence (≥10 chars, required for verifying→completed or in_progress→verifying)" })),
			}),
			{ description: "Batch updates array (takes priority over single id/status/text)" },
		),
	),
	verified: Type.Optional(Type.Boolean({ description: "Required true when skipping verifying to mark completed on a task with verifyText" })),
	evidence: Type.Optional(Type.String({ description: "Verification evidence (≥10 chars, required for verifying/completed on tasks with verifyText)" })),
});

// ── 错误结果构造 helper ──────────────────────────────

function errorResult(
	action: TodoDetails["action"],
	state: TodoSessionState,
	errorText: string,
	errorCode: string,
): {
	content: Array<{ type: "text"; text: string }>;
	details: TodoDetails;
} {
	return {
		content: [{ type: "text" as const, text: errorText }],
		details: {
			action,
			todos: [...state.todos],
			nextId: state.nextId,
			error: errorCode,
			_render: buildRender(state.todos),
		} as TodoDetails,
	};
}

// ── 5 个 action handler（每个 < 80 行） ──────────────

/** list action: 格式化所有 todo 列表（AI 可读） */
function handleList(state: TodoSessionState): string {
	return state.todos.length
		? state.todos.map((t) => formatTodoLine(t)).join("\n")
		: "No todos";
}

/** add action: 批量添加 todo */
function handleAdd(
	state: TodoSessionState,
	params: TodoActionParams,
): { resultText: string; error?: string } {
	if (!params.texts || params.texts.length === 0) {
		return { resultText: "", error: "texts required" };
	}

	const addResult = addTodos(state.todos, state.nextId, params.texts, params.verifyTexts);
	if (addResult.error) {
		return { resultText: addResult.resultText || "", error: addResult.error };
	}

	state.todos = addResult.newTodos;
	state.nextId = addResult.newNextId;
	return { resultText: addResult.resultText || "" };
}

/** update action: 批量 updates[] 路径 */
function handleBatchUpdate(
	state: TodoSessionState,
	params: TodoActionParams,
): { resultText: string; error?: string; earlyReturn?: { content: Array<{ type: "text"; text: string }>; details: TodoDetails } } {
	const result = updateTodos(state.todos, params.updates ?? []);
	if (result.error) {
		return {
			resultText: result.resultText || "",
			error: result.error,
			earlyReturn: {
				content: [{ type: "text" as const, text: result.resultText || "" }],
				details: {
					action: "update" as const,
					todos: [...state.todos],
					nextId: state.nextId,
					error: result.error,
					_render: buildRender(state.todos),
				} as TodoDetails,
			},
		};
	}
	state.todos = result.updatedTodos;
	const resultText = result.resultText || "";

	// 检查是否有状态转换拦截
	if (result.blocked && result.blocked.length > 0) {
		return {
			resultText,
			error: "blocked",
			earlyReturn: {
				content: [{ type: "text" as const, text: resultText }],
				details: {
					action: "update" as const,
					todos: [...state.todos],
					nextId: state.nextId,
					error: "blocked",
					_render: buildRender(state.todos),
				} as TodoDetails,
			},
		};
	}

	return { resultText };
}

/** update action: 单条 update 路径（含参数验证 + 状态转换拦截 + 应用） */
function handleSingleUpdate(
	state: TodoSessionState,
	params: TodoActionParams,
): { resultText: string; error?: string } {
	if (params.id === undefined) return { resultText: "", error: "id required" };
	if (params.status === undefined && params.text === undefined) return { resultText: "", error: "need status or text" };
	if (params.text !== undefined && params.text === "") return { resultText: "", error: "text empty" };
	if (
		params.status !== undefined &&
		!VALID_STATUSES.includes(params.status as (typeof VALID_STATUSES)[number])
	) {
		return { resultText: "", error: `invalid status: ${params.status}` };
	}

	const todo = state.todos.find((t) => t.id === params.id);
	if (!todo) return { resultText: "", error: `#${params.id} not found` };

	// 状态转换拦截
	const MIN_EVIDENCE_LEN = 10;
	if (params.status === "verifying") {
		if (!todo.verifyText) return { resultText: "", error: "no verifyText" };
		if (!params.evidence || params.evidence.trim().length < MIN_EVIDENCE_LEN) {
			return { resultText: "", error: "evidence required" };
		}
	} else if (params.status === "completed") {
		if (todo.verifyText && todo.status !== "verifying") {
			if (params.verified !== true) return { resultText: "", error: "verify required" };
			if (!params.evidence || params.evidence.trim().length < MIN_EVIDENCE_LEN) {
				return { resultText: "", error: "evidence required" };
			}
		} else if (todo.status === "verifying") {
			if (!params.evidence || params.evidence.trim().length < MIN_EVIDENCE_LEN) {
				return { resultText: "", error: "evidence required" };
			}
		}
	}

	// T5 完成引导：判断是否是最后一个 pending 即将完成
	const incompleteBefore = state.todos.filter((t) => t.status !== "completed");
	const isLastCompletion =
		params.status === "completed" &&
		incompleteBefore.length === 1 &&
		incompleteBefore[0].id === todo.id;

	if (params.status !== undefined) {
		const oldStatus = todo.status;
		todo.status = params.status as Todo["status"];
		if (params.evidence && (params.status === "verifying" || params.status === "completed")) {
			todo.evidence = params.evidence.trim();
		}
		// 检测验证失败: completed/verifying → in_progress
		if (
			params.status === "in_progress" &&
			todo.verifyText &&
			todo.verifyAttempts < 2 // 来自 MAX_VERIFY_ATTEMPTS（与 handlers.ts / model.ts 保持一致）
		) {
			if (oldStatus === "completed" || oldStatus === "verifying") {
				todo.verifyAttempts++;
			}
		}
	}
	if (params.text !== undefined) {
		todo.text = params.text;
	}

	const parts: string[] = [`Updated todo #${todo.id}`];
	if (params.status !== undefined) parts.push(`status → ${params.status}`);
	if (params.text !== undefined) parts.push(`text → "${todo.text}"`);
	const resultText = parts.join(", ");

	if (isLastCompletion) {
		return { resultText: resultText + "\n\nAll todos completed. Please summarize your work." };
	}
	return { resultText };
}

/** update action: 入口（dispatcher：batch vs single） */
function handleUpdate(
	state: TodoSessionState,
	params: TodoActionParams,
):
	| { resultText: string; error?: string; earlyReturn?: { content: Array<{ type: "text"; text: string }>; details: TodoDetails } }
	| undefined {
	// Batch updates[] takes priority over single id/status/text
	if (params.updates && params.updates.length > 0) {
		return handleBatchUpdate(state, params);
	}
	return handleSingleUpdate(state, params);
}

/** delete action: 批量删除 todo */
function handleDelete(
	state: TodoSessionState,
	params: TodoActionParams,
): { resultText: string; error?: string } {
	if (!params.ids || params.ids.length === 0) {
		return { resultText: "", error: "ids required" };
	}
	const uniqueIds = [...new Set(params.ids)];
	const missing = uniqueIds.filter((id) => !state.todos.some((t) => t.id === id));
	if (missing.length > 0) {
		return { resultText: "", error: `#${missing.map((id) => id).join(", #")} not found` };
	}
	const removedIds: number[] = [];
	for (const id of uniqueIds) {
		const idx = state.todos.findIndex((t) => t.id === id);
		if (idx !== -1) {
			state.todos.splice(idx, 1);
			removedIds.push(id);
		}
	}
	return { resultText: `Deleted ${removedIds.length} items (#${removedIds.join(", #")}), ${state.todos.length} remaining` };
}

/** clear action: 清空 todo 列表 */
function handleClear(state: TodoSessionState): string {
	const count = state.todos.length;
	state.todos = [];
	state.nextId = 1;
	state.allCompletedAtCount = null;
	// v3: 手动清空后重置
	return count > 0 ? `Cleared ${count} todos` : "No todos to clear";
}

// ── Dispatcher（≤ 80 行，纯 switch 分发） ────────────

/** Tool execute dispatcher — 接受 TodoActionParams + state + ctx，调用对应 handler */
export function executeTodoAction(
	params: TodoActionParams,
	state: TodoSessionState,
	ctx: ExtensionContext,
	refreshDisplay: (ctx: ExtensionContext) => void,
): {
	content: Array<{ type: "text"; text: string }>;
	details: TodoDetails;
} {
	// v3: 记录本次 todo 工具调用轮次（userMessageCount 在 agent_start 中递增）
	state.lastTodoCallCount = state.userMessageCount;
	state.stallNotified = false;

	let resultText = "";

	switch (params.action) {
		case "list": {
			resultText = handleList(state);
			break;
		}

		case "add": {
			const r = handleAdd(state, params);
			if (r.error === "texts required") {
				return errorResult("add", state, "Error: add requires texts parameter (non-empty array)", r.error);
			}
			if (r.error) {
				return errorResult("add", state, r.resultText, r.error);
			}
			resultText = r.resultText;
			// v3: 新增 todo 表示未全部完成
			break;
		}

		case "update": {
			const r = handleUpdate(state, params);
			if (!r) {
				resultText = "Unknown error";
				break;
			}
			if (r.earlyReturn) return r.earlyReturn;
			if (r.error) {
				// 把原始人类可读错误文本与 error code 关联
				const errorText = mapUpdateErrorText(state, params, r.error);
				return errorResult("update", state, errorText, r.error);
			}
			resultText = r.resultText;
			break;
		}

		case "delete": {
			const r = handleDelete(state, params);
			if (r.error === "ids required") {
				return errorResult("delete", state, "Error: delete requires ids parameter (non-empty array)", r.error);
			}
			if (r.error) {
				return errorResult("delete", state, `Error: Todo ${r.error.replace(/^#/, "#")}`, r.error);
			}
			resultText = r.resultText;
			break;
		}

		case "clear": {
			resultText = handleClear(state);
			break;
		}

		default:
			return errorResult("list", state, `Unknown action: ${params.action}`, `unknown action: ${params.action}`);
	}

	refreshDisplay(ctx);

	return {
		content: [{ type: "text" as const, text: resultText }],
		details: {
			action: params.action as TodoDetails["action"],
			todos: [...state.todos],
			nextId: state.nextId,
			_render: buildRender(state.todos),
		} as TodoDetails,
	};
}

/** 把 handleUpdate 的 error code 映射回原 index.ts 中的人类可读错误文本 */
function mapUpdateErrorText(state: TodoSessionState, params: TodoActionParams, code: string): string {
	switch (code) {
		case "id required":
			return "Error: update requires id parameter";
		case "need status or text":
			return "Error: update requires at least status or text parameter";
		case "text empty":
			return "Error: text cannot be empty string";
		default:
			if (code.startsWith("invalid status:")) {
				return `Error: status only accepts ${VALID_STATUSES.join(" / ")}`;
			}
			if (code === "#not found" || /^\#\d+ not found$/.test(code)) {
				return `Error: Todo ${code.replace(/^#/, "#")} not found`;
			}
			if (code === "no verifyText") {
				const todo = state.todos.find((t) => t.id === params.id);
				return `Error: #${todo?.id ?? "?"} 无 verifyText，不能进入 verifying 状态`;
			}
			if (code === "verify required") {
				const todo = state.todos.find((t) => t.id === params.id);
				return `⚠️ Task #${todo?.id ?? "?"} "${todo?.text ?? ""}" 有验证要求。\n请先: todo update(id=${todo?.id}, status=verifying, evidence="验证进度")\n或跳过: todo update(id=${todo?.id}, status=completed, verified=true, evidence="验证结论")\n验证标准: ${todo?.verifyText}`;
			}
			if (code === "evidence required") {
				return "⚠️ evidence required (≥10 chars)";
			}
			return `Error: ${code}`;
	}
}

// ── Tool 注册入口 ─────────────────────────────────────

/** 注册 todo tool 到 pi */
export function registerTodoTool(
	pi: ExtensionAPI,
	state: TodoSessionState,
	refreshDisplay: (ctx: ExtensionContext) => void,
): void {
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a todo list." +
			"\n\nAvailable actions:" +
			"\n- list: View all todos" +
			"\n- add: Batch add todos (requires texts array, optional verifyTexts)" +
			"\n- update: Update a todo (requires id, optional status/text)" +
			"\n- delete: Batch delete todos (requires ids array)" +
			"\n- clear: Clear all todos and reset IDs"
		+ "\nWhen /goal is active, do NOT use this tool — use goal_manager's add_subtasks instead.",
		promptSnippet: "Use todo when breaking multi-step work into trackable items during normal (non-goal) conversation. Not for single-step operations.",
		promptGuidelines: [
			"[Usage] 多步骤工作（3+步）时使用。AI 自发创建，无需用户触发",
			"[Goal 冲突] /goal 激活后禁止使用 todo — 改用 add_subtasks",
			"[批量优先] 完成多项任务时使用 updates[] 批量更新，减少工具调用次数",
			"[验证流程] 有 verifyText 的任务: in_progress → verifying(evidence=\"验证进度\") → completed(evidence=\"验证结论\")。evidence ≥ 10 字符",
			"[跳过验证] 有 verifyText 但想直接 completed: 必须传 verified=true + evidence",
			"[验证失败] verifying/completed 被改回 in_progress 时 verifyAttempts++，2 次后进入 failed",
			"[自动闭合] 全部完成后工具自动清理，无需手动 clear",
			"[Not for] 单步操作、简单对话、/goal 已激活时",
		],
		parameters: TodoParams,

		async execute(_toolCallId: string, params: Static<typeof TodoParams>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			// P1-5: 尊重 signal —— 异步被取消时提前返回
			if (signal?.aborted) {
				return {
					content: [{ type: "text" as const, text: "Todo call aborted by signal." }],
					details: {
						action: "list" as const,
						todos: [],
						nextId: 1,
						error: "aborted",
						_render: undefined,
					} as TodoDetails,
				};
			}
			const result = executeTodoAction(params as TodoActionParams, state, ctx, refreshDisplay);
			// Append input params to error results for debugging
			const details = result.details as { error?: string } | undefined;
			if (details?.error) {
				const textPart = result.content[0];
				if (textPart?.type === "text") {
					const inputSummary = JSON.stringify(params);
					textPart.text += `\nInput: ${inputSummary}`;
				}
			}
			return result;
		},

		renderCall(args: Record<string, unknown>, theme: Theme, _context?: unknown) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action as string);
			const texts = args.texts as string[] | undefined;
			const ids = args.ids as number[] | undefined;
			if (texts && texts.length > 0) text += ` ${theme.fg("dim", `(${texts.length} items)`)}`;
			if (ids && ids.length > 0) text += ` ${theme.fg("accent", `#${ids.join(", #")}`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.status) text += ` ${theme.fg("warning", args.status as string)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result: unknown, options: { expanded: boolean }, theme: Theme, _context?: unknown) {
			return renderTodoResult(result, options, theme);
		},
	});
}
