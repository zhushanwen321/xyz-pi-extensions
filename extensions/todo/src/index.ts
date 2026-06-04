/**
 * Todo Extension v2 - 三态任务清单，支持状态栏和 entry GC
 *
 * 改动要点：
 * - done: boolean → status: "pending" | "in_progress" | "completed" | "failed"
 * - toggle → update（id + 可选 status/text，带参数守卫）
 * - 新增 delete action
 * - 状态栏通过 ctx.ui.setStatus 显示进度
 * - reconstructState 向后兼容旧 done 字段 + entry GC
 * - 支持 verifyText/verifyAttempts 字段（数据模型增强）
 * - add 支持 verifyTexts 参数（验证文本映射）
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type, type Static } from "typebox";

import {
	type Todo,
	type TodoDetails,
	VALID_STATUSES,
	migrateTodo,
	getDisplayStatus,
	buildRender,
	addTodos,
	updateTodos,
	formatTodoLine,
} from "./model";

// ── TodoParams schema（依赖 Pi 运行时包） ────────────

const TodoParams = Type.Object({
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
				id: Type.Number(),
				status: Type.Optional(Type.String()),
				text: Type.Optional(Type.String()),
			}),
			{ description: "Batch updates array (takes priority over single id/status/text)" },
		),
	),
});

// ── 常量 ────────────────────────────────────────────

const HEADER_PREFIX_DASHES = 3;
const HEADER_RESERVED_WIDTH = 10;
const MAX_COLLAPSED_ITEMS = 5;

// ── /todos 命令 TUI 组件 ─────────────────────────────

class TodoListComponent {
	private todos: Todo[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: Todo[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Todos ");
		const headerLine =
			th.fg("borderMuted", "\u2500".repeat(HEADER_PREFIX_DASHES)) + title + th.fg("borderMuted", "\u2500".repeat(Math.max(0, width - HEADER_RESERVED_WIDTH)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet. Ask the agent to add some!")}`, width));
		} else {
			const completed = this.todos.filter((t) => t.status === "completed").length;
			const total = this.todos.length;
			lines.push(truncateToWidth(`  ${th.fg("muted", `${completed}/${total} completed`)}`, width));
			lines.push("");

			for (const todo of this.todos) {
				const mark =
					todo.status === "completed"
						? th.fg("success", "\u2713")
						: todo.status === "in_progress"
							? th.fg("warning", "\u25cf")
							: todo.status === "failed"
								? th.fg("error", "\u2717")
								: th.fg("dim", "\u25cb");
				const id = th.fg("accent", `#${todo.id}`);
				const text = todo.status === "completed" ? th.fg("dim", todo.text) : th.fg("text", todo.text);
				const verifyTag = todo.verifyText ? th.fg("warning", " [待验证]") : th.fg("dim", " [无需验证]");
				lines.push(truncateToWidth(`  ${mark} ${id} ${text}${verifyTag}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ── 辅助函数 ─────────────────────────────────────────

/** 渲染状态栏文本 */
function renderStatusText(todoList: Todo[], th: Theme): string {
	if (todoList.length === 0) return "";

	const completed = todoList.filter((t) => getDisplayStatus(t) === "completed").length;
	const total = todoList.length;

	// 全部完成
	if (completed === total) {
		return th.fg("success", `\u2713 ${completed}/${total}`);
	}
	// 有未完成
	return th.fg("accent", "\u2611") + th.fg("muted", ` ${completed}/${total}`);
}

/** 渲染 widget 行 */
function renderWidgetLines(todoList: Todo[], th: Theme): string[] {
	if (todoList.length === 0) return [];

	const lines: string[] = [];
	const completed = todoList.filter((t) => getDisplayStatus(t) === "completed").length;
	const total = todoList.length;

	lines.push(th.fg("accent", "\u2611") + th.fg("muted", ` ${completed}/${total}`));

	for (const t of todoList) {
		const mark =
			t.status === "completed"
				? th.fg("success", "\u2713")
				: t.status === "in_progress"
					? th.fg("warning", "\u25cf")
					: t.status === "failed"
						? th.fg("error", "\u2717")
						: th.fg("dim", "\u25cb");
		const id = th.fg("accent", `#${t.id}`);
		const text = t.status === "completed" ? th.fg("dim", t.text) : th.fg("text", t.text);
		lines.push(`  ${mark} ${id} ${text}`);
	}

	return lines;
}

// buildRender 已从 model.ts 导入

/** v3: 自动清空延迟轮数（全部完成后保留 N 轮用户消息） */
const AUTO_CLEAR_DELAY_ROUNDS = 2;
/** v3: Stall 检测阈值（无 todo 活动轮数 → stall 提醒） */
const STALL_THRESHOLD = 5;
/** v3: 提醒间隔（上次 todo 调用后轮数 → 提醒） */
const REMINDER_INTERVAL = 3;
/** v3: 最大验证失败次数 */
const MAX_VERIFY_ATTEMPTS = 2;

// ── 列表渲染辅助函数 ─────────────────────────────────

function buildTodoListText(todoList: Todo[], options: { expanded: boolean }, theme: Theme): string {
	if (todoList.length === 0) {
		return theme.fg("dim", "No todos");
	}
	let listText = theme.fg("muted", `${todoList.length} todos:`);
	const display = options.expanded ? todoList : todoList.slice(0, MAX_COLLAPSED_ITEMS);
	for (const t of display) {
		const status = getDisplayStatus(t);
		const mark =
			status === "completed"
				? theme.fg("success", "\u2713")
				: status === "in_progress"
					? theme.fg("warning", "\u25cf")
					: status === "failed"
						? theme.fg("error", "\u2717")
						: theme.fg("dim", "\u25cb");
		const itemText =
			status === "completed" ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
		listText += `\n${mark} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
	}
	if (!options.expanded && todoList.length > MAX_COLLAPSED_ITEMS) {
		listText += `\n${theme.fg("dim", `... ${todoList.length - MAX_COLLAPSED_ITEMS} more`)}`;
	}
	return listText;
}

// ── Tool renderResult handler ────────────────────────

function renderTodoResult(result: unknown, options: { expanded: boolean }, theme: Theme): Text {
	const r = result as { content: Array<{ type: string; text?: string }>; details?: unknown };
	const details = r.details as TodoDetails | undefined;
	if (!details) {
		const text = r.content[0];
		return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
	}

	if (details.error) {
		return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
	}

	const todoList = details.todos;

	switch (details.action) {
		case "list": {
			return new Text(buildTodoListText(todoList, options, theme), 0, 0);
		}

		case "add": {
			const text = r.content[0];
			const msg = text?.type === "text" ? (text.text ?? "") : "";
			const listText = buildTodoListText(todoList, options, theme);
			return new Text(
				theme.fg("success", "\u2713 ") + theme.fg("muted", msg) + "\n\n" + listText,
				0,
				0,
			);
		}

		case "update":
		case "delete":
		case "clear": {
			const text = r.content[0];
			const msg = text?.type === "text" ? (text.text ?? "") : "";
			const listText = buildTodoListText(todoList, options, theme);
			return new Text(
				theme.fg("success", "\u2713 ") + theme.fg("muted", msg) + "\n\n" + listText,
				0,
				0,
			);
		}

		default: {
			const text = r.content[0];
			const msg = text?.type === "text" ? (text.text ?? "") : "";
			return new Text(theme.fg("dim", msg || "Done"), 0, 0);
		}
	}
}

// ── 扩展入口 ─────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── 闭包内状态（session 隔离） ─────────────────────
	let todos: Todo[] = [];
	let nextId = 1;

	// v3: 用户消息轮数与提醒追踪
	let userMessageCount = 0;
	let allCompletedAtCount: number | null = null;
	let lastTodoCallCount = 0;

	// ── 刷新显示（依赖闭包 state） ─────────────────────
	function refreshDisplay(ctx: ExtensionContext): void {
		const statusText = renderStatusText(todos, ctx.ui.theme);
		ctx.ui.setStatus("todo", statusText || undefined);
		if (todos.length === 0) {
			ctx.ui.setWidget("todo", undefined);
		} else {
			ctx.ui.setWidget("todo", renderWidgetLines(todos, ctx.ui.theme));
		}
	}

	// ── Tool execute handler ─────────────────────────────
	function executeTodoAction(
		params: { action: string; text?: string; id?: number; texts?: string[]; ids?: number[]; status?: string; verifyTexts?: string[]; updates?: Array<{ id: number; status?: string; text?: string }> },
		ctx: ExtensionContext,
	) {
		let resultText = "";

		// v3: 追踪 todo 工具调用轮数
		userMessageCount++;
		lastTodoCallCount = userMessageCount;

		switch (params.action) {
			case "list": {
				resultText = todos.length
					? todos.map((t) => formatTodoLine(t)).join("\n")
					: "No todos";
				break;
			}

			case "add": {
				if (!params.texts || params.texts.length === 0) {
					return {
						content: [{ type: "text" as const, text: "Error: add requires texts parameter (non-empty array)" }],
						details: {
							action: "add" as const,
							todos: [...todos],
							nextId,
							error: "texts required",
							_render: buildRender(todos),
						} as TodoDetails,
					};
				}

				const addResult = addTodos(todos, nextId, params.texts, params.verifyTexts);
				if (addResult.error) {
					return {
						content: [{ type: "text" as const, text: addResult.resultText! }],
						details: {
							action: "add" as const,
							todos: [...todos],
							nextId,
							error: addResult.error,
							_render: buildRender(todos),
						} as TodoDetails,
					};
				}

				todos = addResult.newTodos;
				nextId = addResult.newNextId;
				resultText = addResult.resultText!;
				// v3: 新增 todo 表示未全部完成
				allCompletedAtCount = null;
				break;
			}

			case "update": {
				// Batch updates[] takes priority over single id/status/text
				if (params.updates && params.updates.length > 0) {
					const result = updateTodos(todos, params.updates);
					if (result.error) {
						return {
							content: [{ type: "text" as const, text: result.resultText! }],
							details: {
								action: "update" as const,
								todos: [...todos],
								nextId,
								error: result.error,
								_render: buildRender(todos),
							} as TodoDetails,
						};
					}
					todos = result.updatedTodos;
					resultText = result.resultText || "";

					// v3: 检查是否所有 todo 已完成
					const allCompleted = todos.every((t) => t.status === "completed");
					if (allCompleted && todos.length > 0) {
						allCompletedAtCount = userMessageCount;
					} else {
						allCompletedAtCount = null;
					}
					break;
				}
				// Single update: original logic continues
				if (params.id === undefined) {
					return {
						content: [{ type: "text" as const, text: "Error: update requires id parameter" }],
						details: {
							action: "update" as const,
							todos: [...todos],
							nextId,
							error: "id required",
							_render: buildRender(todos),
						} as TodoDetails,
					};
				}
				if (params.status === undefined && params.text === undefined) {
					return {
						content: [{ type: "text" as const, text: "Error: update requires at least status or text parameter" }],
						details: {
							action: "update" as const,
							todos: [...todos],
							nextId,
							error: "need status or text",
							_render: buildRender(todos),
						} as TodoDetails,
					};
				}
				if (params.text !== undefined && params.text === "") {
					return {
						content: [{ type: "text" as const, text: "Error: text cannot be empty string" }],
						details: {
							action: "update" as const,
							todos: [...todos],
							nextId,
							error: "text empty",
							_render: buildRender(todos),
						} as TodoDetails,
					};
				}
				if (
					params.status !== undefined &&
					!VALID_STATUSES.includes(params.status as (typeof VALID_STATUSES)[number])
				) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: status only accepts ${VALID_STATUSES.join(" / ")}`,
							},
						],
						details: {
							action: "update" as const,
							todos: [...todos],
							nextId,
							error: `invalid status: ${params.status}`,
							_render: buildRender(todos),
						} as TodoDetails,
					};
				}

				const todo = todos.find((t) => t.id === params.id);
				if (!todo) {
					return {
						content: [{ type: "text" as const, text: `Todo #${params.id} not found` }],
						details: {
							action: "update" as const,
							todos: [...todos],
							nextId,
							error: `#${params.id} not found`,
							_render: buildRender(todos),
						} as TodoDetails,
					};
				}

				// T5 完成引导：判断是否是最后一个 pending 即将完成
				const incompleteBefore = todos.filter(
					(t) => t.status !== "completed",
				);
				const isLastCompletion =
					params.status === "completed" &&
					incompleteBefore.length === 1 &&
					incompleteBefore[0].id === todo.id;

				if (params.status !== undefined) {
					todo.status = params.status as Todo["status"];
				}
				if (params.text !== undefined) {
					todo.text = params.text;
				}

				const parts: string[] = [`Updated todo #${todo.id}`];
				if (params.status !== undefined) parts.push(`status → ${params.status}`);
				if (params.text !== undefined) parts.push(`text → "${todo.text}"`);
				resultText = parts.join(", ");

				if (isLastCompletion) {
					resultText += "\n\nAll todos completed. Please summarize your work.";
				}

				// v3: 检查是否所有 todo 已完成
				const allCompleted = todos.every((t) => t.status === "completed");
				if (allCompleted && todos.length > 0) {
					allCompletedAtCount = userMessageCount;
				} else {
					allCompletedAtCount = null;
				}
				break;
			}

			case "delete": {
				if (!params.ids || params.ids.length === 0) {
					return {
						content: [{ type: "text" as const, text: "Error: delete requires ids parameter (non-empty array)" }],
						details: {
							action: "delete" as const,
							todos: [...todos],
							nextId,
							error: "ids required",
							_render: buildRender(todos),
						} as TodoDetails,
					};
				}
				const uniqueIds = [...new Set(params.ids)];
				const missing = uniqueIds.filter((id) => !todos.some((t) => t.id === id));
				if (missing.length > 0) {
					const missingStr = missing.map((id) => `#${id}`).join(", ");
					return {
						content: [{ type: "text" as const, text: `Error: Todo ${missingStr} not found` }],
						details: {
							action: "delete" as const,
							todos: [...todos],
							nextId,
							error: `#${missing.map((id) => id).join(", #")} not found`,
							_render: buildRender(todos),
						} as TodoDetails,
					};
				}
				const removedIds: number[] = [];
				for (const id of uniqueIds) {
					const idx = todos.findIndex((t) => t.id === id);
					if (idx !== -1) {
						todos.splice(idx, 1);
						removedIds.push(id);
					}
				}
				resultText = `Deleted ${removedIds.length} items (#${removedIds.join(", #")}), ${todos.length} remaining`;
				break;
			}

			case "clear": {
				const count = todos.length;
				todos = [];
				nextId = 1;
				resultText = count > 0 ? `Cleared ${count} todos` : "No todos to clear";
				// v3: 手动清空后重置
				allCompletedAtCount = null;
				break;
			}

			default:
				return {
					content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
					details: {
						action: "list" as const,
						todos: [...todos],
						nextId,
						error: `unknown action: ${params.action}`,
						_render: buildRender(todos),
					} as TodoDetails,
				};
		}

		refreshDisplay(ctx);

		return {
			content: [{ type: "text" as const, text: resultText }],
			details: {
				action: params.action as TodoDetails["action"],
				todos: [...todos],
				nextId,
				_render: buildRender(todos),
			} as TodoDetails,
		};
	}

	// ── 状态重建 ───────────────────────────────────────
	function reconstructState(ctx: ExtensionContext) {
		todos = [];
		nextId = 1;

		// v3: 重置提醒追踪状态
		userMessageCount = 0;
		allCompletedAtCount = null;
		lastTodoCallCount = 0;

		const entries = ctx.sessionManager.getEntries();
		let latestIdx = -1;

		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as TodoDetails | undefined;
			if (details?.todos && Array.isArray(details.todos)) {
				todos = details.todos.map((t) => migrateTodo(t));
				nextId = details.nextId ?? (todos.length > 0 ? Math.max(...todos.map((t) => t.id)) + 1 : 1);
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
	}

	// ── 事件处理器 ──────────────────────────────────────
	pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
		reconstructState(ctx);
		refreshDisplay(ctx);
	});
	pi.on("session_tree", async (_event: any, ctx: ExtensionContext) => {
		reconstructState(ctx);
		refreshDisplay(ctx);
	});

	// v3: 追踪用户消息轮数
	pi.on("agent_start", async (_event: any, _ctx: ExtensionContext) => {
		userMessageCount++;
	});

	// v3: Task 6 - before_agent_start 注入 todo context (display: false)
	pi.on("before_agent_start", async (_event: any, ctx: ExtensionContext) => {
		try {
			if (todos.length === 0) return undefined;

			const pendingTodos = todos.filter((t) => t.status !== "completed");
			if (pendingTodos.length === 0) return undefined;

			// 格式化 pending 任务 (含 verifyText 供 AI 阅读)
			const lines = pendingTodos.map((t) => {
				const verifyTag = t.verifyText
					? ` [待验证: ${t.verifyText}]`
					: " [无需验证]";
				return `#${t.id}: ${t.text}${verifyTag}`;
			});

			const contextStr =
				`<todo_context>\n[TODO] ${pendingTodos.length} tasks pending\n${lines.join("\n")}\n\nRules:\n- 优先使用 updates[] 批量更新\n- [待验证] 的任务必须验证通过后才能 completed\n- 全部完成后工具自动闭合\n</todo_context>`;

			pi.deliver({
				deliverAs: "steer",
				display: false,
				customType: "todo-context",
				message: contextStr,
			});

			// 更新状态栏
			ctx.ui.setStatus("todo", `📋 ${pendingTodos.length} pending`);

			return undefined;
		} catch {
			return undefined;
		}
	});

	// v3: Task 5 - agent_end: auto-close + stall + verify 循环
	pi.on("agent_end", async (_event: any, ctx: ExtensionContext) => {
		try {
			// 1. 检查验证失败 (completed + verifyText + attempts >= MAX)
			const verifyFailed = todos.find(
				(t) =>
					t.status === "completed" &&
					t.verifyText &&
					t.verifyAttempts >= MAX_VERIFY_ATTEMPTS,
			);
			if (verifyFailed) {
				verifyFailed.status = "failed";
				refreshDisplay(ctx);
				pi.deliver({
					deliverAs: "steer",
					display: false,
					customType: "todo-context",
					message: `<todo_context>\n[TODO] Task #${verifyFailed.id} "${verifyFailed.text}" failed verification after ${MAX_VERIFY_ATTEMPTS} attempts.\n</todo_context>`,
				});
				return;
			}

			// 2. 检查待验证任务 (completed + verifyText + attempts < MAX)
			const needsVerify = todos.find(
				(t) =>
					t.status === "completed" &&
					t.verifyText &&
					t.verifyAttempts < MAX_VERIFY_ATTEMPTS,
			);
			if (needsVerify) {
				needsVerify.verifyAttempts++;
				refreshDisplay(ctx);
				pi.deliver({
					deliverAs: "steer",
					display: false,
					customType: "todo-context",
					message: `<todo_context>\n[TODO] Task #${needsVerify.id} "${needsVerify.text}" needs verification (attempt ${needsVerify.verifyAttempts}/${MAX_VERIFY_ATTEMPTS}):\n${needsVerify.verifyText}\n</todo_context>`,
				});
				return;
			}

			// 3. 自动清空: 全部完成经过 2 轮
			if (
				allCompletedAtCount !== null &&
				userMessageCount - allCompletedAtCount >= AUTO_CLEAR_DELAY_ROUNDS
			) {
				const count = todos.length;
				todos = [];
				nextId = 1;
				allCompletedAtCount = null;
				refreshDisplay(ctx);
				pi.deliver({
					deliverAs: "steer",
					display: false,
					customType: "todo-context",
					message: `<todo_context>\n[TODO] All ${count} todos completed, list auto-cleared.\n</todo_context>`,
				});
				return;
			}

			// 4. Stall 检测: 5 轮未调用 todo 且还有未完成任务
			if (
				todos.length > 0 &&
				allCompletedAtCount === null &&
				userMessageCount - lastTodoCallCount >= STALL_THRESHOLD
			) {
				const pendingText = todos
					.filter((t) => t.status !== "completed")
					.map((t) => `#${t.id}: ${t.text}`)
					.join("\n");
				pi.deliver({
					deliverAs: "steer",
					display: false,
					customType: "todo-context",
					message: `<todo_context>\n[TODO] You have ${todos.length} pending tasks:\n${pendingText}\n</todo_context>`,
				});
				return;
			}

			// 5. 提醒: 3 轮未调用 todo
			if (
				todos.length > 0 &&
				allCompletedAtCount === null &&
				userMessageCount - lastTodoCallCount >= REMINDER_INTERVAL
			) {
				pi.deliver({
					deliverAs: "steer",
					display: false,
					customType: "todo-context",
					message: `<todo_context>\n[TODO] You have ${todos.length} tasks. Consider updating progress.\n</todo_context>`,
				});
				return;
			}
		} catch {
			// 非关键路径，异常时静默降级
			return;
		}
	});

	// ── Tool: todo ──────────────────────────────────────
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
			"\n- clear: Clear all todos and reset IDs",
		promptSnippet: "Lightweight task list for tracking progress on multi-step work, without requiring /goal mode",
		promptGuidelines: [
			"[Usage] Use for multi-step tasks (3+ steps), progress tracking, or when explicitly requested",
			"[Not for] Single-step operations, trivial tasks, or when goal_manager is already active",
			"[Timing] Create before starting work, mark completed immediately when done",
			"[Status] At most one in_progress at a time; mark completed immediately",
			"[Granularity] One todo per verifiable work unit, 3-8 items ideal",
			"[Completion] All todos auto-clear when completed (retained for 2 turns)",
			"[Verification] When completing 3+ tasks, consider adding a verification step",
			"[Scope] Do not use todo as a substitute for goal_manager — they serve different purposes",
		],
		parameters: TodoParams,

		async execute(_toolCallId: string, params: Static<typeof TodoParams>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			const result = executeTodoAction(params as Parameters<typeof executeTodoAction>[0], ctx);
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

	// ── Command: /todos ─────────────────────────────────
	pi.registerCommand("todos", {
		description: "View all todos for the current branch",
		handler: async (_args: string | undefined, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom((_tui: unknown, theme: Theme, _kb: unknown, done: () => void) => {
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});
}
