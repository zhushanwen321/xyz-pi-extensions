/**
 * Todo Extension v2 - 三态任务清单，支持状态栏和 entry GC
 *
 * 改动要点：
 * - done: boolean → status: "pending" | "in_progress" | "completed"
 * - toggle → update（id + 可选 status/text，带参数守卫）
 * - 新增 delete action
 * - 状态栏通过 ctx.ui.setStatus 显示进度
 * - reconstructState 向后兼容旧 done 字段 + entry GC
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
	import { Type, type Static } from "typebox";

// ── 数据模型 ─────────────────────────────────────────

interface Todo {
	id: number;
	text: string;
	status: "pending" | "in_progress" | "completed";
}

interface TodoDetails {
	action: "list" | "add" | "update" | "delete" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
	_render?: {
		type: "task-list";
		summary?: string;
		data: {
			items: Array<{ id: number; text: string; status: string }>;
			meta: Record<string, string>;
		};
	};
}

const VALID_STATUSES = ["pending", "in_progress", "completed"] as const;

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "update", "delete", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for update action)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for update action)" })),
	texts: Type.Optional(Type.Array(Type.String(), { description: "Todo text list (for add action)" })),
	ids: Type.Optional(Type.Array(Type.Number(), { description: "Todo ID list (for delete action)" })),
	status: Type.Optional(
		StringEnum(VALID_STATUSES, { description: "Target status (for update action)" }),
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
							: th.fg("dim", "\u25cb");
				const id = th.fg("accent", `#${todo.id}`);
				const text = todo.status === "completed" ? th.fg("dim", todo.text) : th.fg("text", todo.text);
				lines.push(truncateToWidth(`  ${mark} ${id} ${text}`, width));
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

// ── Session state (module-level, rebuilt on session_start) ──

interface TodoSession {
	todos: Todo[];
	nextId: number;
	userMessageCount: number;
	allCompletedAtCount: number | null;
	lastTodoCallCount: number;
	lastReminderCount: number;
}

function createSession(): TodoSession {
	return {
		todos: [],
		nextId: 1,
		userMessageCount: 0,
		allCompletedAtCount: null,
		lastTodoCallCount: 0,
		lastReminderCount: 0,
	};
}

/** 兼容旧格式：旧 entry 可能有 done: boolean，转换为 status */
function migrateTodo(raw: Todo): Todo {
	const record = raw as unknown as Record<string, unknown>;
	if (typeof record.status === "string" && VALID_STATUSES.includes(record.status as Todo["status"])) {
		return raw;
	}
	// 旧格式兜底：done → completed，否则 pending
	const { done, ...rest } = record as unknown as { done?: boolean; id: number; text: string };
	return { id: rest.id, text: rest.text, status: done === true ? "completed" : "pending" };
}

/** 渲染层获取状态：先 migrate 再取 status */
function getDisplayStatus(t: Todo): string {
	return migrateTodo(t).status;
}

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
					: th.fg("dim", "\u25cb");
		const id = th.fg("accent", `#${t.id}`);
		const text = t.status === "completed" ? th.fg("dim", t.text) : th.fg("text", t.text);
		lines.push(`  ${mark} ${id} ${text}`);
	}

	return lines;
}

/** 构建 _render 描述符 */
function buildRender(todoList: Todo[]): TodoDetails["_render"] {
	const completed = todoList.filter((t) => t.status === "completed").length;
	const total = todoList.length;
	return {
		type: "task-list" as const,
		summary: `${completed}/${total} completed`,
		data: {
			items: todoList.map((t) => ({ id: t.id, text: t.text, status: t.status })),
			meta: {},
		},
	};
}

/** 构建错误结果 */
function makeTodoErrorResult(session: TodoSession, action: TodoDetails["action"], error: string, errorMsg: string): { content: Array<{ type: "text"; text: string }>; details: TodoDetails } {
	return {
		content: [{ type: "text" as const, text: errorMsg }],
		details: {
			action,
			todos: [...session.todos],
			nextId: session.nextId,
			error,
			_render: buildRender(session.todos),
		} as TodoDetails,
	};
}

/** 刷新显示 */
function refreshDisplay(session: TodoSession, ctx: ExtensionContext): void {
	const statusText = renderStatusText(session.todos, ctx.ui.theme);
	ctx.ui.setStatus("todo", statusText || undefined);
	if (session.todos.length === 0) {
		ctx.ui.setWidget("todo", undefined);
	} else {
		ctx.ui.setWidget("todo", renderWidgetLines(session.todos, ctx.ui.theme));
	}
}

/** v3: 自动清空延迟轮数（全部完成后保留 N 轮用户消息） */
const AUTO_CLEAR_DELAY_ROUNDS = 2;
/** v3: Verification Nudge 触发阈值（完成 N 个任务以上时检查） */
const VERIFICATION_NUDGE_THRESHOLD = 3;
/** v3: Todo Reminder 触发间隔（N 轮未调用 todo 工具时提醒） */
const TODO_REMINDER_INTERVAL = 10;

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

/** Update action handler */
function handleUpdateAction(session: TodoSession, params: { id?: number; status?: string; text?: string }): { content: Array<{ type: "text"; text: string }>; details: TodoDetails } | { resultText: string } {
	if (params.id === undefined) {
		return makeTodoErrorResult(session, "update", "id required", "Error: update requires id parameter");
	}
	if (params.status === undefined && params.text === undefined) {
		return makeTodoErrorResult(session, "update", "need status or text", "Error: update requires at least status or text parameter");
	}
	if (params.text !== undefined && params.text === "") {
		return makeTodoErrorResult(session, "update", "text empty", "Error: text cannot be empty string");
	}
	if (
		params.status !== undefined &&
		!VALID_STATUSES.includes(params.status as (typeof VALID_STATUSES)[number])
	) {
		return makeTodoErrorResult(session, "update", `invalid status: ${params.status}`, `Error: status only accepts ${VALID_STATUSES.join(" / ")}`);
	}

	const todo = session.todos.find((t) => t.id === params.id);
	if (!todo) {
		return makeTodoErrorResult(session, "update", `#${params.id} not found`, `Todo #${params.id} not found`);
	}

	// T5 完成引导：判断是否是最后一个 pending 即将完成
	const incompleteBefore = session.todos.filter((t) => t.status !== "completed");
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
	let resultText = parts.join(", ");

	if (isLastCompletion) {
		resultText += "\n\nAll todos completed. Please summarize your work.";
	}

	// v3: 检查是否所有 todo 已完成
	const allCompleted = session.todos.every((t) => t.status === "completed");
	if (allCompleted && session.todos.length > 0) {
		session.allCompletedAtCount = session.userMessageCount;
	} else {
		session.allCompletedAtCount = null;
	}
	return { resultText };
}

/** Add action handler */
function handleAddAction(session: TodoSession, params: { texts?: string[] }): { content: Array<{ type: "text"; text: string }>; details: TodoDetails } | { resultText: string } {
	if (!params.texts || params.texts.length === 0) {
		return makeTodoErrorResult(session, "add", "texts required", "Error: add requires texts parameter (non-empty array)");
	}
	const trimmed = params.texts.map((t) => t.trim()).filter((t) => t.length > 0);
	if (trimmed.length === 0) {
		return makeTodoErrorResult(session, "add", "all texts empty", "Error: texts must contain at least one non-empty string");
	}
	const startId = session.nextId;
	for (const t of trimmed) {
		session.todos.push({ id: session.nextId++, text: t, status: "pending" });
	}
	const endId = session.nextId - 1;
	// v3: 新增 todo 表示未全部完成
	session.allCompletedAtCount = null;
	return { resultText: `Added ${trimmed.length} todos (#${startId}-#${endId})` };
}

/** Delete action handler */
function handleDeleteAction(session: TodoSession, params: { ids?: number[] }): { content: Array<{ type: "text"; text: string }>; details: TodoDetails } | { resultText: string } {
	if (!params.ids || params.ids.length === 0) {
		return makeTodoErrorResult(session, "delete", "ids required", "Error: delete requires ids parameter (non-empty array)");
	}
	const uniqueIds = [...new Set(params.ids)];
	const missing = uniqueIds.filter((id) => !session.todos.some((t) => t.id === id));
	if (missing.length > 0) {
		const missingStr = missing.map((id) => `#${id}`).join(", ");
		return makeTodoErrorResult(session, "delete", `#${missing.map((id) => id).join(", #")} not found`, `Error: Todo ${missingStr} not found`);
	}
	const removedIds: number[] = [];
	for (const id of uniqueIds) {
		const idx = session.todos.findIndex((t) => t.id === id);
		if (idx !== -1) {
			session.todos.splice(idx, 1);
			removedIds.push(id);
		}
	}
	return { resultText: `Deleted ${removedIds.length} items (#${removedIds.join(", #")}), ${session.todos.length} remaining` };
}

/** Tool execute handler */
function executeTodoAction(
	session: TodoSession,
	params: { action: string; text?: string; id?: number; texts?: string[]; ids?: number[]; status?: string },
	ctx: ExtensionContext,
) {
	let resultText = "";

	// v3: 追踪 todo 工具调用轮数
	session.lastTodoCallCount = session.userMessageCount;

	switch (params.action) {
		case "list": {
			resultText = session.todos.length
				? session.todos
						.map((t) => {
							const mark =
								t.status === "completed"
									? "x"
									: t.status === "in_progress"
										? "~"
										: " ";
							return `[${mark}] #${t.id}: ${t.text}`;
						})
						.join("\n")
				: "No todos";
			break;
		}

		case "add": {
			const addResult = handleAddAction(session, params);
			if ("details" in addResult) return addResult;
			resultText = addResult.resultText;
			break;
		}

		case "update": {
			const updateResult = handleUpdateAction(session, params);
			if ("details" in updateResult) return updateResult;
			resultText = updateResult.resultText;
			break;
		}

		case "delete": {
			const deleteResult = handleDeleteAction(session, params);
			if ("details" in deleteResult) return deleteResult;
			resultText = deleteResult.resultText;
			break;
		}

		case "clear": {
			const count = session.todos.length;
			session.todos = [];
			session.nextId = 1;
			resultText = count > 0 ? `Cleared ${count} todos` : "No todos to clear";
			// v3: 手动清空后重置
			session.allCompletedAtCount = null;
			break;
		}

		default:
			return {
				content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
				details: {
					action: "list" as const,
					todos: [...session.todos],
					nextId: session.nextId,
					error: `unknown action: ${params.action}`,
					_render: buildRender(session.todos),
				} as TodoDetails,
			};
	}

	refreshDisplay(session, ctx);

	return {
		content: [{ type: "text" as const, text: resultText }],
		details: {
			action: params.action as TodoDetails["action"],
			todos: [...session.todos],
			nextId: session.nextId,
			_render: buildRender(session.todos),
		} as TodoDetails,
	};
}

/** 状态重建 */
function reconstructState(session: TodoSession, ctx: ExtensionContext) {
	session.todos = [];
	session.nextId = 1;

	// v3: 重置提醒追踪状态
	session.userMessageCount = 0;
	session.allCompletedAtCount = null;
	session.lastTodoCallCount = 0;
	session.lastReminderCount = 0;

	const entries = ctx.sessionManager.getEntries();
	let latestIdx = -1;

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

		const details = msg.details as TodoDetails | undefined;
		if (details?.todos && Array.isArray(details.todos)) {
			session.todos = details.todos.map((t) => migrateTodo(t));
			session.nextId = details.nextId ?? (session.todos.length > 0 ? Math.max(...session.todos.map((t) => t.id)) + 1 : 1);
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

// ── 扩展入口 ─────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const session = createSession();

	// ── Register event handlers ──────────────────────
	function registerEventHandlers(): void {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pi event types are typed as `any` in CI stubs
		pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
			reconstructState(session, ctx);
			refreshDisplay(session, ctx);
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pi event types are typed as `any` in CI stubs
		pi.on("session_tree", async (_event: any, ctx: ExtensionContext) => {
			reconstructState(session, ctx);
			refreshDisplay(session, ctx);
		});

		// v3: 追踪用户消息轮数
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pi event types are typed as `any` in CI stubs
		pi.on("agent_start", async (_event: any, _ctx: ExtensionContext) => {
			session.userMessageCount++;
		});

		// v3: 自动清空与提醒检查
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pi event types are typed as `any` in CI stubs
		pi.on("before_agent_start", async (_event: any, ctx: ExtensionContext) => {
			try {
				// 1. 自动清空：全部完成后经过 2 轮用户消息
				if (session.allCompletedAtCount !== null && session.userMessageCount - session.allCompletedAtCount >= AUTO_CLEAR_DELAY_ROUNDS) {
					const count = session.todos.length;
					session.todos = [];
					session.nextId = 1;
					session.allCompletedAtCount = null;
					refreshDisplay(session, ctx);
					return {
						message: {
							customType: "todo-auto-clear",
							content: `All ${count} todos completed, list auto-cleared.`,
							display: true,
						},
					};
				}

				// 2. Verification Nudge：完成 3+ 任务且无验证步骤
				if (
					session.allCompletedAtCount !== null &&
					session.todos.length >= VERIFICATION_NUDGE_THRESHOLD &&
					!session.todos.some((t) => /verif|验证/i.test(t.text))
				) {
					session.lastReminderCount = session.userMessageCount;
					return {
						message: {
							customType: "todo-verification-nudge",
							content: "You completed 3+ tasks without a verification step. Consider adding a verification task before summarizing.",
							display: true,
						},
					};
				}

				// 3. Todo Reminder：10 轮未调用 todo 工具
				if (
					session.todos.length > 0 &&
					session.allCompletedAtCount === null &&
					session.userMessageCount - session.lastTodoCallCount >= TODO_REMINDER_INTERVAL &&
					session.userMessageCount - session.lastReminderCount >= TODO_REMINDER_INTERVAL
				) {
					session.lastReminderCount = session.userMessageCount;
					return {
						message: {
							customType: "todo-reminder",
							content: "The todo tool hasn't been used recently. If working on tasks, consider using it to track progress.",
							display: true,
						},
					};
				}

				return undefined;
			} catch {
				// v3: 提醒/清空非关键路径，异常时静默降级不影响 agent 循环
				return undefined;
			}
		});
	}

	registerEventHandlers();

	// ── Register todo tool ───────────────────────────
	function registerTodoTool(): void {
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

			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pi tool callback type
			async execute(_toolCallId: string, params: Static<typeof TodoParams>, _signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pi params type narrowing
				const result = executeTodoAction(session, params as any, ctx);
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

			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pi render callback args
			renderCall(args: any, theme: Theme, _context?: any) {
				let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
				if (args.texts && args.texts.length > 0) text += ` ${theme.fg("dim", `(${args.texts.length} items)`)}`;
				if (args.ids && args.ids.length > 0) text += ` ${theme.fg("accent", `#${args.ids.join(", #")}`)}`;
				if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
				if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
				if (args.status) text += ` ${theme.fg("warning", args.status)}`;
				return new Text(text, 0, 0);
			},

			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pi render callback args
			renderResult(result: any, options: any, theme: Theme, _context?: any) {
				return renderTodoResult(result, options, theme);
			},
		});
	}

	registerTodoTool();

	// ── Command: /todos ─────────────────────────────────
	pi.registerCommand("todos", {
		description: "View all todos for the current branch",
		handler: async (_args: string | undefined, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pi UI callback args
			await ctx.ui.custom((_tui: any, theme: Theme, _kb: any, done: () => void) => {
				return new TodoListComponent(session.todos, theme, () => done());
			});
		},
	});
}
