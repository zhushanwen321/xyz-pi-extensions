/**
 * Todo tool 注册 + execute dispatcher + 5 个 action handler。
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "typebox";

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

// ── Action 参数类型 ──────────────────────────────────

export interface TodoActionParams {
	action: string;
	text?: string;
	id?: number;
	texts?: string[];
	ids?: number[];
	status?: string;
	updates?: Array<{ id: number; status?: string; text?: string }>;
}

// ── TodoParams schema ────────────────────────────────

export const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "update", "delete", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for update action)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for update action)" })),
	texts: Type.Optional(Type.Array(Type.String(), { description: "Todo text list (for add action)" })),
	ids: Type.Optional(Type.Array(Type.Number(), { description: "Todo ID list (for delete action)" })),
	status: Type.Optional(
		StringEnum(VALID_STATUSES, { description: "Target status (for update action)" }),
	),
	updates: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.Number({ description: "Todo ID to update" }),
				status: Type.Optional(
					Type.String({ description: "Target status; one of pending/in_progress/completed" }),
				),
				text: Type.Optional(Type.String({ description: "New todo text" })),
			}),
			{ description: "Batch updates array (takes priority over single id/status/text)" },
		),
	),
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

// ── 5 个 action handler ──────────────────────────────

/** list action */
function handleList(state: TodoSessionState): string {
	return state.todos.length
		? state.todos.map((t) => formatTodoLine(t)).join("\n")
		: "No todos";
}

/** add action */
function handleAdd(
	state: TodoSessionState,
	params: TodoActionParams,
): { resultText: string; error?: string } {
	if (!params.texts || params.texts.length === 0) {
		return { resultText: "", error: "texts required" };
	}

	const addResult = addTodos(state.todos, state.nextId, params.texts);
	if (addResult.error) {
		return { resultText: addResult.resultText || "", error: addResult.error };
	}

	state.todos = addResult.newTodos;
	state.nextId = addResult.newNextId;
	return { resultText: addResult.resultText || "" };
}

/** update action: batch */
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
	return { resultText: result.resultText || "" };
}

/** update action: single */
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

	if (params.status !== undefined) {
		todo.status = params.status as Todo["status"];
	}
	if (params.text !== undefined) {
		todo.text = params.text;
	}

	const parts: string[] = [`Updated todo #${todo.id}`];
	if (params.status !== undefined) parts.push(`status → ${params.status}`);
	if (params.text !== undefined) parts.push(`text → "${todo.text}"`);

	// 最后一个完成提示
	const incompleteAfter = state.todos.filter((t) => t.status !== "completed");
	if (params.status === "completed" && incompleteAfter.length === 0) {
		return { resultText: parts.join(", ") + "\n\nAll todos completed. Please summarize your work." };
	}
	return { resultText: parts.join(", ") };
}

/** update action: dispatcher */
function handleUpdate(
	state: TodoSessionState,
	params: TodoActionParams,
):
	| { resultText: string; error?: string; earlyReturn?: { content: Array<{ type: "text"; text: string }>; details: TodoDetails } }
	| undefined {
	if (params.updates && params.updates.length > 0) {
		return handleBatchUpdate(state, params);
	}
	return handleSingleUpdate(state, params);
}

/** delete action */
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

/** clear action */
function handleClear(state: TodoSessionState): string {
	const count = state.todos.length;
	state.todos = [];
	state.nextId = 1;
	state.allCompletedAtCount = null;
	state.completionSteered = false;
	return count > 0 ? `Cleared ${count} todos` : "No todos to clear";
}

// ── Dispatcher ───────────────────────────────────────

export function executeTodoAction(
	params: TodoActionParams,
	state: TodoSessionState,
	ctx: ExtensionContext,
	refreshDisplay: (ctx: ExtensionContext) => void,
): {
	content: Array<{ type: "text"; text: string }>;
	details: TodoDetails;
} {
	state.lastTodoCallCount = state.userMessageCount;
	state.stallNotified = false;

	// 有未完成项时重置 completionSteered
	const hasIncomplete = state.todos.some((t) => t.status !== "completed");
	if (hasIncomplete) {
		state.completionSteered = false;
	}

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

function mapUpdateErrorText(state: TodoSessionState, _params: TodoActionParams, code: string): string {
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
			if (code.startsWith("#") && code.includes("not found")) {
				return `Error: Todo ${code} not found`;
			}
			return `Error: ${code}`;
	}
}

// ── Tool 注册入口 ─────────────────────────────────────

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
			"\n- add: Batch add todos (requires texts array)" +
			"\n- update: Update a todo (requires id, optional status/text)" +
			"\n- delete: Batch delete todos (requires ids array)" +
			"\n- clear: Clear all todos and reset IDs"
		+ "\nWhen /goal is active, do NOT use this tool — use goal_manager's add_subtasks instead.",
		promptSnippet: "Use todo when breaking multi-step work into trackable items during normal (non-goal) conversation. Not for single-step operations.",
		promptGuidelines: [
			"[Usage] 多步骤工作（3+步）时使用。AI 自发创建，无需用户触发",
			"[Goal 冲突] /goal 激活后禁止使用 todo — 改用 add_subtasks",
			"[批量优先] 完成多项任务时使用 updates[] 批量更新，减少工具调用次数",
			"[自动闭合] 全部完成后工具自动清理，无需手动 clear",
			"[Not for] 单步操作、简单对话、/goal 已激活时",
		],
		parameters: TodoParams,

		async execute(_toolCallId: string, params: Static<typeof TodoParams>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
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
