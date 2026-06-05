/**
 * /todos 命令的 TUI 组件 — 独立可关闭的 todo 列表视图。
 *
 * 拆分理由：原 src/index.ts 的 TodoListComponent 占用约 85 行，与渲染函数、
 * tool 注册、事件注册混在一起。独立后 commands.ts 只需引用本组件。
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

import type { Todo } from "./model";

const HEADER_PREFIX_DASHES = 3;
const HEADER_RESERVED_WIDTH = 10;

/** /todos 命令的 TUI 组件 — 独立可关闭的 todo 列表视图 */
export class TodoListComponent {
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
						: todo.status === "verifying"
							? th.fg("warning", "\u25d0")
							: todo.status === "in_progress"
								? th.fg("warning", "\u25cf")
								: todo.status === "failed"
									? th.fg("error", "\u2717")
									: th.fg("dim", "\u25cb");
				const id = th.fg("accent", `#${todo.id}`);
				const text = todo.status === "completed" ? th.fg("dim", todo.text) : th.fg("text", todo.text);
				let verifyTag = "";
				if (todo.status === "verifying") {
					verifyTag = th.fg("warning", ` [验证中${todo.evidence ? ": " + todo.evidence.slice(0, 30) : ""}]`);
				} else if (todo.verifyText && todo.status !== "completed") {
					verifyTag = th.fg("warning", " [待验证]");
				} else if (todo.status === "completed" && todo.verifyText) {
					verifyTag = th.fg("success", " [已验证]");
				} else if (todo.verifyText === undefined) {
					verifyTag = th.fg("dim", " [无需验证]");
				}
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
