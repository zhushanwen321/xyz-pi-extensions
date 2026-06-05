/**
 * /todos 命令注册 — 进入 TodoListComponent TUI 视图。
 * registerMessageRenderer for todo-context — 渲染注入的 todo 上下文消息。
 *
 * 拆分理由：原 src/index.ts 的 command 注册块与 message renderer 注册块
 * 混合了 TUI 组件定义与注册逻辑。抽出后 index.ts 工厂只需调用本文件
 * 导出的注册函数。
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { TodoListComponent } from "./component";
import type { TodoSessionState } from "./state";

/** 注册 /todos 命令到 pi */
export function registerTodosCommand(pi: ExtensionAPI, state: TodoSessionState): void {
	pi.registerCommand("todos", {
		description: "View all todos for the current branch",
		handler: async (_args: string | undefined, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom((_tui: unknown, theme: Theme, _kb: unknown, done: () => void) => {
				return new TodoListComponent(state.todos, theme, () => done());
			});
		},
	});
}

/** 注册 todo-context 消息渲染器（用于 before_agent_start 注入的 <todo_context> 消息） */
export function registerTodoContextRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("todo-context", (message: Record<string, unknown>, _options: unknown, theme: Theme) => {
		const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		const match = content.match(/\[TODO\]\s*(?:Turn \d+ — )?(\d+)\s*tasks?\s*(pending|completed)/);
		let displayText: string;
		if (match) {
			const count = match[1];
			displayText = match[2] === "completed"
				? theme.fg("success", `[TODO] All ${count} tasks completed \u2713`)
				: theme.fg("warning", `[TODO] ${count} tasks pending`);
		} else {
			const firstLine = content.split("\n").find((l: string) => l.includes("[TODO]")) || "[TODO]";
			displayText = theme.fg("accent", firstLine.trim());
		}
		return new Text(displayText, 0, 0);
	});
}
