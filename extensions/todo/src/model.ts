/**
 * Todo 数据模型 — 纯函数，不依赖 Pi 运行时。
 * 从 index.ts 提取，便于单元测试。
 */

// ── 数据模型 ─────────────────────────────────────────

export interface Todo {
	id: number;
	text: string;
	verifyText?: string;
	status: "pending" | "in_progress" | "completed" | "failed";
	verifyAttempts: number;
}

export interface TodoDetails {
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

export const VALID_STATUSES = ["pending", "in_progress", "completed", "failed"] as const;

export type ValidStatus = (typeof VALID_STATUSES)[number];

// ── 迁移/兼容 ───────────────────────────────────────

/** 兼容旧格式：旧 entry 可能有 done: boolean，转换为 status；旧数据缺少 verifyText/verifyAttempts 时填充默认值 */
export function migrateTodo(raw: Todo): Todo {
	const record = raw as unknown as Record<string, unknown>;
	const hasValidStatus =
		typeof record.status === "string" &&
		VALID_STATUSES.includes(record.status as ValidStatus);

	const status: ValidStatus = hasValidStatus
		? (record.status as ValidStatus)
		: (() => {
				const { done } = record as { done?: boolean };
				return done === true ? "completed" : "pending";
			})();

	return {
		id: record.id as number,
		text: record.text as string,
		status,
		verifyText: typeof record.verifyText === "string" ? (record.verifyText as string) : undefined,
		verifyAttempts: typeof record.verifyAttempts === "number" ? (record.verifyAttempts as number) : 0,
	};
}



// ── 渲染辅助 ─────────────────────────────────────────

export function buildRender(todoList: Todo[]): TodoDetails["_render"] {
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

export function getDisplayStatus(t: Todo): string {
	return migrateTodo(t).status;
}

// ── Add 逻辑（纯函数，可测试） ─────────────────────

export interface AddResult {
	newTodos: Todo[];
	newNextId: number;
	error?: string;
	resultText?: string;
}

/**
 * 处理 todo add 的核心逻辑。
 * @param currentTodos 当前 todo 列表
 * @param currentNextId 当前 nextId
 * @param texts 要添加的文本列表
 * @param verifyTexts 可选的验证文本列表
 */
export function addTodos(
	currentTodos: Todo[],
	currentNextId: number,
	texts: string[],
	verifyTexts?: string[],
): AddResult {
	if (!texts || texts.length === 0) {
		return {
			newTodos: currentTodos,
			newNextId: currentNextId,
			error: "texts required",
			resultText: "Error: add requires texts parameter (non-empty array)",
		};
	}

	const trimmed = texts.map((t) => t.trim()).filter((t) => t.length > 0);
	if (trimmed.length === 0) {
		return {
			newTodos: currentTodos,
			newNextId: currentNextId,
			error: "all texts empty",
			resultText: "Error: texts must contain at least one non-empty string",
		};
	}

	if (verifyTexts !== undefined && verifyTexts.length > trimmed.length) {
		return {
			newTodos: currentTodos,
			newNextId: currentNextId,
			error: "verifyTexts too long",
			resultText: "Error: verifyTexts length cannot exceed texts length",
		};
	}

	const startId = currentNextId;
	const newTodos = [...currentTodos];
	let nextId = currentNextId;
	for (let i = 0; i < trimmed.length; i++) {
		newTodos.push({
			id: nextId++,
			text: trimmed[i],
			status: "pending" as const,
			verifyText: verifyTexts?.[i],
			verifyAttempts: 0,
		});
	}
	const endId = nextId - 1;

	return {
		newTodos,
		newNextId: nextId,
		resultText: `Added ${trimmed.length} todos (#${startId}-#${endId})`,
	};
}
