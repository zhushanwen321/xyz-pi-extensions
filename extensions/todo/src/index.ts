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
 *
 * 文件拆分（v3.1 — 修复 P1-1/P1-2/P1-3/P1-4 拆分后）：
 * - state.ts: TodoSessionState 接口 + 工厂
 * - model.ts: 数据模型 + 纯函数（add/update/migrate/format）
 * - render.ts: 状态栏 / widget / tool result 渲染
 * - component.ts: TodoListComponent TUI 组件
 * - tool.ts: TodoParams schema + 5 个 action handler + execute dispatcher + registerTodoTool
 * - handlers.ts: 5 个事件处理器 + reconstructState + buildPendingContext
 * - commands.ts: /todos 命令 + todo-context 消息渲染器
 * - index.ts（本文件）: 工厂入口（创建 state + 注册所有 handler）
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { registerTodoContextRenderer,registerTodosCommand } from "./commands";
import { registerTodoEventHandlers } from "./handlers";
import { renderStatusText, renderWidgetLines } from "./render";
import { createTodoSessionState } from "./state";
import { registerTodoTool } from "./tool";

// ── 扩展入口 ─────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── 闭包内状态（session 隔离） ─────────────────────
	const state = createTodoSessionState();

	// ── 刷新显示（依赖闭包 state） ─────────────────────
	function refreshDisplay(ctx: ExtensionContext): void {
		const statusText = renderStatusText(state.todos, ctx.ui.theme);
		ctx.ui.setStatus("todo", statusText || undefined);
		if (state.todos.length === 0) {
			ctx.ui.setWidget("todo", undefined);
		} else {
			ctx.ui.setWidget("todo", renderWidgetLines(state.todos, ctx.ui.theme));
		}
	}

	// ── 注册所有 handler / tool / command ──────────────
	registerTodoEventHandlers(pi, state, refreshDisplay);
	registerTodoTool(pi, state, refreshDisplay);
	registerTodosCommand(pi, state);
	registerTodoContextRenderer(pi);
}
