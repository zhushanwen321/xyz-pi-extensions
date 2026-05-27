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

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

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
	text: Type.Optional(Type.String({ description: "Todo 文本（update 时使用）" })),
	id: Type.Optional(Type.Number({ description: "Todo ID（update 时使用）" })),
	texts: Type.Optional(Type.Array(Type.String(), { description: "Todo 文本列表（add 时使用）" })),
	ids: Type.Optional(Type.Array(Type.Number(), { description: "Todo ID 列表（delete 时使用）" })),
	status: Type.Optional(
		StringEnum(VALID_STATUSES, { description: "目标状态（update 时使用）" }),
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
			lines.push(truncateToWidth(`  ${th.fg("dim", "\u6682\u65e0 todo\u3002\u8ba9 agent \u6dfb\u52a0\u4e00\u4e9b\uff01")}`, width));
		} else {
			const completed = this.todos.filter((t) => t.status === "completed").length;
			const total = this.todos.length;
			lines.push(truncateToWidth(`  ${th.fg("muted", `${completed}/${total} \u5df2\u5b8c\u6210`)}`, width));
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
		lines.push(truncateToWidth(`  ${th.fg("dim", "\u6309 Escape \u5173\u95ed")}`, width));
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

/** 更新状态栏和 widget */
function refreshDisplay(ctx: ExtensionContext): void {
	const statusText = renderStatusText(todos, ctx.ui.theme);
	ctx.ui.setStatus("todo", statusText || undefined);

	if (todos.length === 0) {
		ctx.ui.setWidget("todo", undefined);
	} else {
		ctx.ui.setWidget("todo", renderWidgetLines(todos, ctx.ui.theme));
	}
}

// ── 模块级状态 ───────────────────────────────────────

let todos: Todo[] = [];
let nextId = 1;

/** 构建 _render 描述符 */
function buildRender(todoList: Todo[]): TodoDetails["_render"] {
	const completed = todoList.filter((t) => t.status === "completed").length;
	const total = todoList.length;
	return {
		type: "task-list" as const,
		summary: `${completed}/${total} 已完成`,
		data: {
			items: todoList.map((t) => ({ id: t.id, text: t.text, status: t.status })),
			meta: {},
		},
	};
}

// ── Tool execute handler ─────────────────────────────

function executeTodoAction(params: { action: string; text?: string; id?: number; texts?: string[]; ids?: number[]; status?: string }, ctx: ExtensionContext) {
	let resultText = "";

	switch (params.action) {
		case "list": {
			resultText = todos.length
				? todos
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
				: "\u6682\u65e0 todo";
			break;
		}

		case "add": {
			if (!params.texts || params.texts.length === 0) {
				return {
					content: [{ type: "text" as const, text: "\u9519\u8bef\uff1aadd \u9700\u8981 texts \u53c2\u6570\uff08\u975e\u7a7a\u6570\u7ec4\uff09" }],
					details: {
						action: "add" as const,
						todos: [...todos],
						nextId,
						error: "texts required",
						_render: buildRender(todos),
				} as TodoDetails,
				};
			}
			const trimmed = params.texts.map((t) => t.trim()).filter((t) => t.length > 0);
			if (trimmed.length === 0) {
				return {
					content: [{ type: "text" as const, text: "\u9519\u8bef\uff1atexts \u4e2d\u81f3\u5c11\u9700\u8981\u4e00\u4e2a\u975e\u7a7a\u5b57\u7b26\u4e32" }],
					details: {
						action: "add" as const,
						todos: [...todos],
						nextId,
						error: "all texts empty",
						_render: buildRender(todos),
				} as TodoDetails,
				};
			}
			const startId = nextId;
			for (const t of trimmed) {
				todos.push({ id: nextId++, text: t, status: "pending" });
			}
			const endId = nextId - 1;
			resultText = `\u5df2\u6dfb\u52a0 ${trimmed.length} \u9879 todo (#${startId}-#${endId})`;
			break;
		}

		case "update": {
			if (params.id === undefined) {
				return {
					content: [{ type: "text" as const, text: "\u9519\u8bef\uff1aupdate \u9700\u8981 id \u53c2\u6570" }],
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
					content: [{ type: "text" as const, text: "\u9519\u8bef\uff1aupdate \u81f3\u5c11\u9700\u8981 status \u6216 text \u53c2\u6570" }],
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
					content: [{ type: "text" as const, text: "\u9519\u8bef\uff1atext \u4e0d\u80fd\u4e3a\u7a7a\u5b57\u7b26\u4e32" }],
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
							text: `\u9519\u8bef\uff1astatus \u53ea\u63a5\u53d7 ${VALID_STATUSES.join(" / ")}`,
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
					content: [{ type: "text" as const, text: `Todo #${params.id} \u4e0d\u5b58\u5728` }],
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

			const parts: string[] = [`\u5df2\u66f4\u65b0 todo #${todo.id}`];
			if (params.status !== undefined) parts.push(`\u72b6\u6001 \u2192 ${params.status}`);
			if (params.text !== undefined) parts.push(`\u6587\u672c \u2192 "${todo.text}"`);
			resultText = parts.join("\uff0c");

			if (isLastCompletion) {
				resultText += "\n\n\u6240\u6709 todo \u5df2\u5b8c\u6210\u3002\u8bf7\u603b\u7ed3\u5de5\u4f5c\u6210\u679c\u3002";
			}
			break;
		}

		case "delete": {
			if (!params.ids || params.ids.length === 0) {
				return {
					content: [{ type: "text" as const, text: "\u9519\u8bef\uff1adelete \u9700\u8981 ids \u53c2\u6570\uff08\u975e\u7a7a\u6570\u7ec4\uff09" }],
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
					content: [{ type: "text" as const, text: `\u9519\u8bef\uff1aTodo ${missingStr} \u4e0d\u5b58\u5728` }],
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
			resultText = `\u5df2\u5220\u9664 ${removedIds.length} \u9879 (#${removedIds.join(", #")})\uff0c\u5269\u4f59 ${todos.length} \u9879`;
			break;
		}

		case "clear": {
			const count = todos.length;
			todos = [];
			nextId = 1;
			resultText = count > 0 ? `\u5df2\u6e05\u7a7a ${count} \u9879 todo` : "\u6682\u65e0 todo\uff0c\u65e0\u9700\u6e05\u7a7a";
			break;
		}

		default:
			return {
				content: [{ type: "text" as const, text: `\u672a\u77e5 action: ${params.action}` }],
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

// ── 列表渲染辅助函数 ─────────────────────────────────

function buildTodoListText(todoList: Todo[], options: { expanded: boolean }, theme: Theme): string {
	if (todoList.length === 0) {
		return theme.fg("dim", "\u6682\u65e0 todo");
	}
	let listText = theme.fg("muted", `${todoList.length} \u9879 todo\uff1a`);
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
		listText += `\n${theme.fg("dim", `... \u8fd8\u6709 ${todoList.length - MAX_COLLAPSED_ITEMS} \u9879`)}`;
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
		return new Text(theme.fg("error", `\u9519\u8bef: ${details.error}`), 0, 0);
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
			return new Text(theme.fg("dim", msg || "\u5b8c\u6210"), 0, 0);
		}
	}
}

// ── 扩展入口 ─────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;

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
	};

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		refreshDisplay(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		refreshDisplay(ctx);
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"\u7ba1\u7406 todo \u6e05\u5355\u3002" +
			"\n\n\u53ef\u7528 action\uff1a" +
			"\n- list\uff1a\u67e5\u770b\u6240\u6709 todo" +
			"\n- add\uff1a\u6279\u91cf\u6dfb\u52a0 todo\uff08\u9700\u8981 texts \u6570\u7ec4\uff09" +
			"\n- update\uff1a\u66f4\u65b0 todo\uff08\u9700\u8981 id\uff0c\u53ef\u9009 status/text\uff09" +
			"\n- delete\uff1a\u6279\u91cf\u5220\u9664 todo\uff08\u9700\u8981 ids \u6570\u7ec4\uff09" +
			"\n- clear\uff1a\u6e05\u7a7a\u6240\u6709 todo \u5e76\u91cd\u7f6e ID",
		promptSnippet: "\u8f7b\u91cf\u7ea7\u4efb\u52a1\u6e05\u5355\u3002\u591a\u6b65\u9aa4\u5de5\u4f5c\u65f6\u8ffd\u8e2a\u8fdb\u5ea6\uff0c\u4e0d\u5fc5\u7b49 /goal \u6a21\u5f0f",
		promptGuidelines: [
			"[\u4f7f\u7528\u573a\u666f] \u591a\u6b65\u9aa4\u4efb\u52a1\u3001\u9700\u8981\u8ffd\u8e2a\u8fdb\u5ea6\u3001\u4e34\u65f6\u8bb0\u5f55\u5f85\u529e\u65f6\u4f7f\u7528 todo",
			"[\u4e0d\u9002\u7528] \u5355\u6b65\u64cd\u4f5c\u3001\u5df2\u7ecf\u5728\u7528 goal_manager \u65f6\u4e0d\u9700\u8981 todo",
			"[\u65f6\u673a] \u5f00\u59cb\u5de5\u4f5c\u524d\u4e3b\u52a8\u521b\u5efa\uff0c\u5b8c\u6210\u65f6\u53ca\u65f6\u6807\u8bb0",
			"[\u7c92\u5ea6] \u4e00\u4e2a todo \u5bf9\u5e94\u4e00\u4e2a\u53ef\u9a8c\u8bc1\u7684\u5de5\u4f5c\u5355\u5143\uff0c3-8 \u9879\u4e3a\u5b9c\uff0c\u4e0d\u8981\u8fc7\u5ea6\u62c6\u5206",
			"[\u72b6\u6001] in_progress \u975e\u5f3a\u5236\uff0cpending \u2192 completed \u76f4\u63a5\u8df3\u8f6c\u5408\u6cd5",
			"[\u5b9a\u4f4d] \u4e0d\u8981\u7528 todo \u66ff\u4ee3 goal_manager\uff0c\u4e24\u8005\u5b9a\u4f4d\u4e0d\u540c",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await executeTodoAction(params, ctx);
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

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.texts && args.texts.length > 0) text += ` ${theme.fg("dim", `(${args.texts.length} items)`)}`;
			if (args.ids && args.ids.length > 0) text += ` ${theme.fg("accent", `#${args.ids.join(", #")}`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.status) text += ` ${theme.fg("warning", args.status)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, options, theme, _context) {
			return renderTodoResult(result, options, theme);
		},
	});

	pi.registerCommand("todos", {
		description: "\u67e5\u770b\u5f53\u524d\u5206\u652f\u7684\u6240\u6709 todo",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos \u9700\u8981\u4ea4\u4e92\u6a21\u5f0f", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});
}
