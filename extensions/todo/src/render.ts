/**
 * Todo 渲染函数 — 状态栏、widget、tool result 渲染。
 *
 * 拆分理由：原 src/index.ts 把渲染逻辑与业务逻辑混在一起。提取后 index.ts
 * 工厂只需调用 register* 函数；这些纯函数接受 Todo[] / theme 等入参，
 * 不依赖闭包状态，可独立测试。
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import {
	buildRender,
	getDisplayStatus,
	type Todo,
	type TodoDetails,
} from "./model";

const MAX_COLLAPSED_ITEMS = 5;

// ── 状态栏 ────────────────────────────────────────────

/** 渲染状态栏文本 */
export function renderStatusText(todoList: Todo[], th: Theme): string {
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
export function renderWidgetLines(todoList: Todo[], th: Theme): string[] {
	if (todoList.length === 0) return [];

	const lines: string[] = [];
	const completed = todoList.filter((t) => getDisplayStatus(t) === "completed").length;
	const total = todoList.length;

	lines.push(th.fg("accent", "\u2611") + th.fg("muted", ` ${completed}/${total}`));

	for (const t of todoList) {
		const mark =
			t.status === "completed"
				? th.fg("success", "\u2713")
				: t.status === "verifying"
					? th.fg("warning", "\u25d0")
					: t.status === "in_progress"
						? th.fg("warning", "\u25cf")
						: t.status === "failed"
							? th.fg("error", "\u2717")
							: th.fg("dim", "\u25cb");
		const id = th.fg("accent", `#${t.id}`);
		const text = t.status === "completed" ? th.fg("dim", t.text) : th.fg("text", t.text);
		let verifyTag = "";
		if (t.status === "verifying") {
			verifyTag = th.fg("warning", ` [验证中${t.evidence ? ": " + t.evidence.slice(0, 30) : ""}]`);
		} else if (t.verifyText && t.status !== "completed") {
			verifyTag = th.fg("warning", " [待验证]");
		} else if (t.status === "completed" && t.verifyText) {
			verifyTag = th.fg("success", " [已验证]");
		} else if (t.verifyText === undefined) {
			verifyTag = th.fg("dim", " [无需验证]");
		}
		lines.push(`  ${mark} ${id} ${text}${verifyTag}`);
	}

	return lines;
}

// ── 列表渲染辅助函数 ─────────────────────────────────

/** 拼装 todo 列表的纯文本表示（AI/工具结果消费） */
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
				: status === "verifying"
					? theme.fg("warning", "\u25d0")
					: status === "in_progress"
						? theme.fg("warning", "\u25cf")
						: status === "failed"
							? theme.fg("error", "\u2717")
							: theme.fg("dim", "\u25cb");
		const itemText =
			status === "completed" ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
		let verifyTag = "";
		if (status === "verifying") {
			verifyTag = theme.fg("warning", ` [验证中${t.evidence ? ": " + t.evidence.slice(0, 30) : ""}]`);
		} else if (t.verifyText && status !== "completed") {
			verifyTag = theme.fg("warning", " [待验证]");
		} else if (status === "completed" && t.verifyText) {
			verifyTag = theme.fg("success", " [已验证]");
		} else if (t.verifyText === undefined) {
			verifyTag = theme.fg("dim", " [无需验证]");
		}
		listText += `\n${mark} ${theme.fg("accent", `#${t.id}`)} ${itemText}${verifyTag}`;
	}
	if (!options.expanded && todoList.length > MAX_COLLAPSED_ITEMS) {
		listText += `\n${theme.fg("dim", `... ${todoList.length - MAX_COLLAPSED_ITEMS} more`)}`;
	}
	return listText;
}

// ── Tool renderResult handler ────────────────────────

/** 渲染 tool execute 返回结果 */
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

// 重新导出 buildRender 供 tool.ts 使用（避免循环引用）
export { buildRender };
