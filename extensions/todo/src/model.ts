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

// ── Update 逻辑（纯函数，可测试） ──────────────────

export interface UpdateResult {
	updatedTodos: Todo[];
	error?: string;
	resultText?: string;
	/** 拦截的任务 ID 及其 verifyText（需要验证） */
	verifyRequired?: Array<{ id: number; text: string; verifyText: string }>;
}

/**
 * 处理 todo batch update 的核心逻辑。
 * All-or-nothing: 任一验证失败，所有变更不生效。
 *
 * verified 参数：有 verifyText 的任务标记 completed 时，必须传 verified=true 才能通过。
 * 否则返回 verifyRequired 列表，由调用方决定如何处理。
 *
 * @param currentTodos 当前 todo 列表
 * @param updates 批量更新项数组
 */
export function updateTodos(
	currentTodos: Todo[],
	updates: Array<{ id: number; status?: string; text?: string; verified?: boolean }>,
): UpdateResult {
	// 验证: no duplicate ids
	const ids = updates.map((u) => u.id);
	if (new Set(ids).size !== ids.length) {
		return {
			updatedTodos: currentTodos,
			error: "duplicate ids in updates",
			resultText: "Error: duplicate ids in updates",
		};
	}
	// 验证: all ids exist and each has at least one change, and valid status
	for (const u of updates) {
		const todo = currentTodos.find((t) => t.id === u.id);
		if (!todo) {
			return {
				updatedTodos: currentTodos,
				error: `id ${u.id} not found`,
				resultText: `Error: Todo #${u.id} not found`,
			};
		}
		if (!u.status && !u.text) {
			return {
				updatedTodos: currentTodos,
				error: `update item for id ${u.id} has neither status nor text`,
				resultText: `Error: update item for id ${u.id} has neither status nor text`,
			};
		}
		if (u.status && !VALID_STATUSES.includes(u.status as (typeof VALID_STATUSES)[number])) {
			return {
				updatedTodos: currentTodos,
				error: `invalid status: ${u.status}`,
				resultText: `Error: invalid status '${u.status}' for update item id ${u.id}`,
			};
		}
	}

	// 验证拦截：有 verifyText 的任务 → completed 时需要 verified=true
	const verifyRequiredItems: Array<{ id: number; text: string; verifyText: string }> = [];
	for (const u of updates) {
		if (u.status !== "completed" || u.verified === true) continue;
		const todo = currentTodos.find((t) => t.id === u.id);
		if (todo?.verifyText) {
			verifyRequiredItems.push({ id: todo.id, text: todo.text, verifyText: todo.verifyText });
		}
	}
	if (verifyRequiredItems.length > 0) {
		const lines = verifyRequiredItems.map(
			(v) => `  #${v.id}: ${v.text} — 验证标准: ${v.verifyText}`,
		);
		return {
			updatedTodos: currentTodos, // 不变更
			resultText: `⚠️ 以下任务有验证要求，请先验证通过后再传 verified=true 标记完成:\n${lines.join("\n")}`,
			verifyRequired: verifyRequiredItems,
		};
	}

	// Apply all (safe since all validated)
	const updated = currentTodos.map((t) => {
		const u = updates.find((u) => u.id === t.id);
		if (!u) return t;
		return {
			...t,
			...(u.status ? { status: u.status as Todo["status"] } : {}),
			...(u.text ? { text: u.text } : {}),
		};
	});
	return {
		updatedTodos: updated,
		resultText: `Updated ${updates.length} todo(s)`,
	};
}

// ── 格式化辅助 ───────────────────────────────────────

/** 格式化单条 todo 为纯文本行（AI 可读），含 verifyText 原文 */
export function formatTodoLine(t: Todo): string {
	const mark =
		t.status === "completed"
			? "x"
			: t.status === "in_progress"
				? "~"
				: t.status === "failed"
					? "!"
					: " ";
	let line = `[${mark}] #${t.id}: ${t.text}`;
	if (t.verifyText) {
		line += ` | 验证: ${t.verifyText}`;
	}
	return line;
}
