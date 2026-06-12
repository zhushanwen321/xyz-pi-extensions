/**
 * Todo 渲染函数 — 状态栏、widget（双列）、tool result 渲染。
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

import {
	buildRender,
	getDisplayStatus,
	type Todo,
	type TodoDetails,
} from "./model";

// ── 常量 ────────────────────────────────────────────

const MAX_COLLAPSED_ITEMS = 5;
export const COL_GAP = 3; // 双列间距空格数
export const FALLBACK_TERM_WIDTH = 80;

// ── 状态栏 ────────────────────────────────────────────

export function renderStatusText(todoList: Todo[], th: Theme): string {
	if (todoList.length === 0) return "";

	const completed = todoList.filter((t) => getDisplayStatus(t) === "completed").length;
	const total = todoList.length;

	if (completed === total) {
		return th.fg("success", `\u2713 ${completed}/${total}`);
	}
	return th.fg("accent", "\u2611") + th.fg("muted", ` ${completed}/${total}`);
}

// ── Widget 双列渲染 ──────────────────────────────────

/** 渲染单条 todo 的 widget 行（不含缩进），供 component.ts 复用 */
export function renderWidgetItem(t: Todo, th: Theme): string {
	const mark =
		t.status === "completed"
			? th.fg("success", "\u2713")
			: t.status === "in_progress"
				? th.fg("warning", "\u25cf")
				: th.fg("dim", "\u25cb");
	const id = th.fg("accent", `#${t.id}`);
	const text = t.status === "completed" ? th.fg("dim", t.text) : th.fg("text", t.text);
	return `${mark} ${id} ${text}`;
}

/** 双列布局渲染，供 widget 和 component 复用 */
export function renderDualColumn(
	todos: Todo[],
	th: Theme,
	termWidth: number,
	indent: string,
): string[] {
	const maxColWidth = Math.floor((termWidth - COL_GAP - indent.length) / 2);
	const lines: string[] = [];
	const half = Math.ceil(todos.length / 2);
	for (let row = 0; row < half; row++) {
		const leftStr = truncateToWidth(indent + renderWidgetItem(todos[row], th), maxColWidth);
		const rightIdx = row + half;
		if (rightIdx < todos.length) {
			const rightStr = truncateToWidth(renderWidgetItem(todos[rightIdx], th), maxColWidth);
			const padding = " ".repeat(Math.max(1, COL_GAP));
			lines.push(leftStr + padding + rightStr);
		} else {
			lines.push(leftStr);
		}
	}
	return lines;
}

/** 渲染 widget 行（双列布局） */
export function renderWidgetLines(todoList: Todo[], th: Theme): string[] {
	if (todoList.length === 0) return [];

	const lines: string[] = [];
	const completed = todoList.filter((t) => getDisplayStatus(t) === "completed").length;
	const total = todoList.length;

	lines.push(th.fg("accent", "\u2611") + th.fg("muted", ` ${completed}/${total}`));

	// 双列布局
	for (const line of renderDualColumn(todoList, th, process.stdout.columns || FALLBACK_TERM_WIDTH, "  ")) {
		lines.push(line);
	}

	return lines;
}

// ── 列表渲染辅助函数 ─────────────────────────────────

export function buildTodoListText(todoList: Todo[], options: { expanded: boolean }, theme: Theme): string {
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

import { Text } from "@mariozechner/pi-tui";

export function renderTodoResult(result: unknown, options: { expanded: boolean }, theme: Theme): Text {
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

		case "add":
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

export { buildRender };
