/**
 * /todos 命令的 TUI 组件 — 独立可关闭的 todo 列表视图（双列布局）。
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

import type { Todo } from "./model";

const HEADER_PREFIX_DASHES = 3;
const HEADER_RESERVED_WIDTH = 10;
const COL_GAP = 3;
const FALLBACK_TERM_WIDTH = 80;

/** 渲染单条 todo 行 */
function renderItem(todo: Todo, th: Theme): string {
	const mark =
		todo.status === "completed"
			? th.fg("success", "\u2713")
			: todo.status === "in_progress"
				? th.fg("warning", "\u25cf")
				: th.fg("dim", "\u25cb");
	const id = th.fg("accent", `#${todo.id}`);
	const text = todo.status === "completed" ? th.fg("dim", todo.text) : th.fg("text", todo.text);
	return `${mark} ${id} ${text}`;
}

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
		const termWidth = width || FALLBACK_TERM_WIDTH;
		const indent = "  ";
		const maxColWidth = Math.floor((termWidth - COL_GAP - indent.length) / 2);

		lines.push("");
		const title = th.fg("accent", " Todos ");
		const headerLine =
			th.fg("borderMuted", "\u2500".repeat(HEADER_PREFIX_DASHES)) + title + th.fg("borderMuted", "\u2500".repeat(Math.max(0, termWidth - HEADER_RESERVED_WIDTH)));
		lines.push(truncateToWidth(headerLine, termWidth));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`${indent}${th.fg("dim", "No todos yet. Ask the agent to add some!")}`, termWidth));
		} else {
			const completed = this.todos.filter((t) => t.status === "completed").length;
			const total = this.todos.length;
			lines.push(truncateToWidth(`${indent}${th.fg("muted", `${completed}/${total} completed`)}`, termWidth));
			lines.push("");

			// 双列布局
			const half = Math.ceil(this.todos.length / 2);
			for (let row = 0; row < half; row++) {
				const leftStr = truncateToWidth(indent + renderItem(this.todos[row], th), maxColWidth);
				const rightIdx = row + half;
				if (rightIdx < this.todos.length) {
					const rightStr = truncateToWidth(renderItem(this.todos[rightIdx], th), maxColWidth);
					const padding = " ".repeat(Math.max(1, COL_GAP));
					lines.push(leftStr + padding + rightStr);
				} else {
					lines.push(leftStr);
				}
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`${indent}${th.fg("dim", "Press Escape to close")}`, termWidth));
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
