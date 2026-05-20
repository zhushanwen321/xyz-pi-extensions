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
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
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
}

const VALID_STATUSES = ["pending", "in_progress", "completed"] as const;

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "update", "delete", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo 文本（add / update 时使用）" })),
	id: Type.Optional(Type.Number({ description: "Todo ID（update / delete 时使用）" })),
	status: Type.Optional(
		StringEnum(VALID_STATUSES, { description: "目标状态（update 时使用）" }),
	),
});

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
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "暂无 todo。让 agent 添加一些！")}`, width));
		} else {
			const completed = this.todos.filter((t) => t.status === "completed").length;
			const total = this.todos.length;
			lines.push(truncateToWidth(`  ${th.fg("muted", `${completed}/${total} 已完成`)}`, width));
			lines.push("");

			for (const todo of this.todos) {
				const mark =
					todo.status === "completed"
						? th.fg("success", "✓")
						: todo.status === "in_progress"
							? th.fg("warning", "●")
							: th.fg("dim", "○");
				const id = th.fg("accent", `#${todo.id}`);
				const text = todo.status === "completed" ? th.fg("dim", todo.text) : th.fg("text", todo.text);
				lines.push(truncateToWidth(`  ${mark} ${id} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "按 Escape 关闭")}`, width));
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

/** 渲染层获取状态：兼容旧 done 字段 */
function getDisplayStatus(t: Todo): string {
	const record = t as unknown as Record<string, unknown>;
	if (typeof record.status === "string" && VALID_STATUSES.includes(record.status as Todo["status"])) {
		return record.status;
	}
	return record.done === true ? "completed" : "pending";
}

/** 渲染状态栏文本 */
function renderStatusText(todoList: Todo[], th: Theme): string {
	if (todoList.length === 0) return "";

	const completed = todoList.filter((t) => getDisplayStatus(t) === "completed").length;
	const total = todoList.length;

	// 全部完成
	if (completed === total) {
		return th.fg("success", `✓ ${completed}/${total}`);
	}
	// 有未完成
	return th.fg("accent", `☑`) + th.fg("muted", ` ${completed}/${total}`);
}

/** 更新状态栏 */
function updateStatusLine(ctx: ExtensionContext): void {
	const text = renderStatusText(todos, ctx.ui.theme);
	ctx.ui.setStatus("todo", text || undefined);
}

// ── 模块级状态 ───────────────────────────────────────

let todos: Todo[] = [];
let nextId = 1;

// ── 扩展入口 ─────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	/**
	 * 从 session entries 重建状态。
	 * 只保留最新一条 entry 的快照，旧 entries 执行 GC（splice 移除）。
	 */
	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;

		const entries = ctx.sessionManager.getBranch();
		let latestIdx = -1;

		// 找到最新一条 todo toolResult 的索引
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as TodoDetails | undefined;
			if (details?.todos && Array.isArray(details.todos)) {
				// 向后兼容旧格式 todos
				todos = details.todos.map((t) => migrateTodo(t));
				// nextId 可能缺失，从现有 todos 推算
				nextId = details.nextId ?? (todos.length > 0 ? Math.max(...todos.map((t) => t.id)) + 1 : 1);
				latestIdx = i;
			}
		}

		// Entry GC：删除最新之前的旧 todo toolResult entries
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
			// 从后向前 splice，避免索引偏移（后面的索引在 splice 后会失效）
			for (let j = staleIndices.length - 1; j >= 0; j--) {
				entries.splice(staleIndices[j], 1);
			}
		}
	};

	// ── 事件监听 ────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		updateStatusLine(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		updateStatusLine(ctx);
	});

	// ── Tool: todo ──────────────────────────────────────

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"管理 todo 清单。" +
			"\n\n可用 action：" +
			"\n- list：查看所有 todo" +
			"\n- add：添加 todo（需要 text）" +
			"\n- update：更新 todo（需要 id，可选 status/text）" +
			"\n- delete：删除 todo（需要 id）" +
			"\n- clear：清空所有 todo 并重置 ID",
		promptSnippet: "轻量级任务清单。多步骤工作时追踪进度，不必等 /goal 模式",
		promptGuidelines: [
			"[使用场景] 多步骤任务、需要追踪进度、临时记录待办时使用 todo",
			"[不适用] 单步操作、已经在用 goal_manager 时不需要 todo",
			"[时机] 开始工作前主动创建，完成时及时标记",
			"[粒度] 一个 todo 对应一个可验证的工作单元，3-8 项为宜，不要过度拆分",
			"[状态] in_progress 非强制，pending → completed 直接跳转合法",
			"[定位] 不要用 todo 替代 goal_manager，两者定位不同",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
						: "暂无 todo";
					break;
				}

				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "错误：add 需要 text 参数" }],
							details: {
								action: "add",
								todos: [...todos],
								nextId,
								error: "text required",
							} as TodoDetails,
						};
					}
					const newTodo: Todo = { id: nextId++, text: params.text, status: "pending" };
					todos.push(newTodo);
					resultText = `已添加 todo #${newTodo.id}: ${newTodo.text}`;
					break;
				}

				case "update": {
					// 参数守卫：必须有 id
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "错误：update 需要 id 参数" }],
							details: {
								action: "update",
								todos: [...todos],
								nextId,
								error: "id required",
							} as TodoDetails,
						};
					}
					// 参数守卫：至少需要 status 或 text
					if (params.status === undefined && params.text === undefined) {
						return {
							content: [{ type: "text", text: "错误：update 至少需要 status 或 text 参数" }],
							details: {
								action: "update",
								todos: [...todos],
								nextId,
								error: "need status or text",
							} as TodoDetails,
						};
					}
					// 参数守卫：text 不能为空字符串
					if (params.text !== undefined && params.text === "") {
						return {
							content: [{ type: "text", text: "错误：text 不能为空字符串" }],
							details: {
								action: "update",
								todos: [...todos],
								nextId,
								error: "text empty",
							} as TodoDetails,
						};
					}
					// 参数守卫：status 值校验（StringEnum 已在 schema 层校验，双保险）
					if (
						params.status !== undefined &&
						!VALID_STATUSES.includes(params.status as (typeof VALID_STATUSES)[number])
					) {
						return {
							content: [
								{
									type: "text",
									text: `错误：status 只接受 ${VALID_STATUSES.join(" / ")}`,
								},
							],
							details: {
								action: "update",
								todos: [...todos],
								nextId,
								error: `invalid status: ${params.status}`,
							} as TodoDetails,
						};
					}

					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} 不存在` }],
							details: {
								action: "update",
								todos: [...todos],
								nextId,
								error: `#${params.id} not found`,
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

					// 应用更新
					if (params.status !== undefined) {
						todo.status = params.status;
					}
					if (params.text !== undefined) {
						todo.text = params.text;
					}

					const parts: string[] = [`已更新 todo #${todo.id}`];
					if (params.status !== undefined) parts.push(`状态 → ${params.status}`);
					if (params.text !== undefined) parts.push(`文本 → "${todo.text}"`);
					resultText = parts.join("，");

					// 最后一个 pending 完成时追加引导
					if (isLastCompletion) {
						resultText += "\n\n所有 todo 已完成。请总结工作成果。";
					}
					break;
				}

				case "delete": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "错误：delete 需要 id 参数" }],
							details: {
								action: "delete",
								todos: [...todos],
								nextId,
								error: "id required",
							} as TodoDetails,
						};
					}
					const idx = todos.findIndex((t) => t.id === params.id);
					if (idx === -1) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} 不存在` }],
							details: {
								action: "delete",
								todos: [...todos],
								nextId,
								error: `#${params.id} not found`,
							} as TodoDetails,
						};
					}
					const removed = todos.splice(idx, 1)[0];
					resultText = `已删除 todo #${removed.id}: ${removed.text}（剩余 ${todos.length} 项）`;
					break;
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					resultText = count > 0 ? `已清空 ${count} 项 todo` : "暂无 todo，无需清空";
					break;
				}

				default:
					return {
						content: [{ type: "text", text: `未知 action: ${params.action}` }],
						details: {
							action: "list",
							todos: [...todos],
							nextId,
							error: `unknown action: ${params.action}`,
						} as TodoDetails,
					};
			}

			// 每次执行后更新状态栏（clear 时 renderStatusText 返回空字符串，
			// "" || undefined 自动清除）
			updateStatusLine(ctx);

			return {
				content: [{ type: "text", text: resultText }],
				details: {
					action: params.action as TodoDetails["action"],
					todos: [...todos],
					nextId,
				} as TodoDetails,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.status) text += ` ${theme.fg("warning", args.status)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `错误: ${details.error}`), 0, 0);
			}

			const todoList = details.todos;

			switch (details.action) {
				case "list": {
					if (todoList.length === 0) {
						return new Text(theme.fg("dim", "暂无 todo"), 0, 0);
					}
					let listText = theme.fg("muted", `${todoList.length} 项 todo：`);
					const display = expanded ? todoList : todoList.slice(0, 5);
					for (const t of display) {
						const status = getDisplayStatus(t);
						const mark =
							status === "completed"
								? theme.fg("success", "✓")
								: status === "in_progress"
									? theme.fg("warning", "●")
									: theme.fg("dim", "○");
						const itemText =
							status === "completed" ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
						listText += `\n${mark} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
					}
					if (!expanded && todoList.length > 5) {
						listText += `\n${theme.fg("dim", `... 还有 ${todoList.length - 5} 项`)}`;
					}
					return new Text(listText, 0, 0);
				}

				case "add": {
					const added = todoList[todoList.length - 1];
					if (!added) return new Text(theme.fg("success", "✓ 已添加"), 0, 0);
					return new Text(
						theme.fg("success", "✓ 已添加 ") +
							theme.fg("accent", `#${added.id}`) +
							" " +
							theme.fg("muted", added.text),
						0,
						0,
					);
				}

				case "update": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "delete": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "clear": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				// 兜底：旧 session 中可能存在 action: "toggle"
				case "toggle" as string: {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				default: {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("dim", msg || "完成"), 0, 0);
				}
			}
		},
	});

	// ── Command: /todos ─────────────────────────────────

	pi.registerCommand("todos", {
		description: "查看当前分支的所有 todo",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos 需要交互模式", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});
}
