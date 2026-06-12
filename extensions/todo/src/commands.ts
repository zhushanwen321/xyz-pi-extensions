/**
 * /todos 命令注册 — 进入 TodoListComponent TUI 视图（双列布局）。
 *
 * todo-context 消息不再需要 registerMessageRenderer，
 * 因为所有 context 通过 before_agent_start 的 display:false 注入，
 * 用户在 TUI 中不可见。
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";

import type { TodoSessionState } from "./state";
import { TodoListComponent } from "./component";

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
