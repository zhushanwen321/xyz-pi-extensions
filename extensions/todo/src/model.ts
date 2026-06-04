/**
 * Todo 数据模型 — 纯函数，不依赖 Pi 运行时。
 * 从 index.ts 提取，便于单元测试。
 */

// ── 数据模型 ─────────────────────────────────────────

export interface Todo {
	id: number;
	text: string;
	verifyText?: string;
	status: "pending" | "in_progress" | "verifying" | "completed" | "failed";
	verifyAttempts: number;
	/** 验证结论，verifying/completed 时写入 */
	evidence?: string;
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

export const VALID_STATUSES = ["pending", "in_progress", "verifying", "completed", "failed"] as const;

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
		evidence: typeof record.evidence === "string" ? (record.evidence as string) : undefined,
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
	/** 拦截的任务 ID 及其原因 */
	blocked?: Array<{ id: number; text: string; reason: string }>;
}

/** evidence 最小长度 */
const MIN_EVIDENCE_LENGTH = 10;
/** 最大验证重试次数 */
const MAX_VERIFY_ATTEMPTS = 2;

/**
 * 处理 todo batch update 的核心逻辑。
 * All-or-nothing: 任一验证失败，所有变更不生效。
 *
 * 状态转换规则：
 * - 无 verifyText: in_progress → completed 直接通过
 * - 有 verifyText: in_progress → verifying (需 evidence) → completed (需 evidence)
 * - 有 verifyText: in_progress → completed 需 verified=true + evidence（跳过 verifying）
 * - verifying → in_progress: verifyAttempts++
 */
export function updateTodos(
	currentTodos: Todo[],
	updates: Array<{ id: number; status?: string; text?: string; verified?: boolean; evidence?: string }>,
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

	// 状态转换拦截
	const blockedItems: Array<{ id: number; text: string; reason: string }> = [];

	for (const u of updates) {
		if (!u.status) continue;
		const todo = currentTodos.find((t) => t.id === u.id)!;

		if (u.status === "verifying") {
			// → verifying: 必须有 verifyText + evidence
			if (!todo.verifyText) {
				blockedItems.push({ id: todo.id, text: todo.text, reason: "无 verifyText 的任务不能进入 verifying 状态" });
			} else if (!u.evidence || u.evidence.trim().length < MIN_EVIDENCE_LENGTH) {
				blockedItems.push({ id: todo.id, text: todo.text, reason: `进入 verifying 需要 evidence（≥${MIN_EVIDENCE_LENGTH} 字符），说明当前验证进度` });
			}
		} else if (u.status === "completed") {
			if (todo.verifyText && todo.status !== "verifying") {
				// 有 verifyText 但未经过 verifying → 需要 verified=true + evidence
				if (u.verified !== true) {
					blockedItems.push({ id: todo.id, text: todo.text, reason: `有验证要求，请先标 verifying 并传 evidence，或传 verified=true + evidence 跳过` });
				} else if (!u.evidence || u.evidence.trim().length < MIN_EVIDENCE_LENGTH) {
					blockedItems.push({ id: todo.id, text: todo.text, reason: `跳过 verifying 直接 completed 时需要 evidence（≥${MIN_EVIDENCE_LENGTH} 字符）` });
			}
			} else if (todo.status === "verifying") {
				// verifying → completed: 需要 evidence
				if (!u.evidence || u.evidence.trim().length < MIN_EVIDENCE_LENGTH) {
					blockedItems.push({ id: todo.id, text: todo.text, reason: `从 verifying 到 completed 需要 evidence（≥${MIN_EVIDENCE_LENGTH} 字符），说明验证结论` });
			}
			}
		}
	}

	if (blockedItems.length > 0) {
		const lines = blockedItems.map(
			(b) => `  #${b.id}: ${b.text} — ${b.reason}`,
		);
		return {
			updatedTodos: currentTodos,
			resultText: `⚠️ 以下任务被拦截:\n${lines.join("\n")}`,
			blocked: blockedItems,
		};
	}

	// Apply all (safe since all validated)
	const updated = currentTodos.map((t) => {
		const u = updates.find((u) => u.id === t.id);
		if (!u) return t;
		const patch: Partial<Todo> = {};
		if (u.status) patch.status = u.status as Todo["status"];
		if (u.text) patch.text = u.text;
		// verifying 或 completed 时写入 evidence
		if (u.evidence && (u.status === "verifying" || u.status === "completed")) {
			patch.evidence = u.evidence.trim();
		}
		// verifying/completed → in_progress: verifyAttempts++（验证失败回退）
		if (
			u.status === "in_progress" &&
			t.verifyText &&
			t.verifyAttempts < MAX_VERIFY_ATTEMPTS &&
			(t.status === "completed" || t.status === "verifying")
		) {
			patch.verifyAttempts = t.verifyAttempts + 1;
		}
		return { ...t, ...patch };
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
			: t.status === "verifying"
				? "v"
				: t.status === "in_progress"
					? "~"
					: t.status === "failed"
						? "!"
						: " ";
	let line = `[${mark}] #${t.id}: ${t.text}`;
	if (t.status === "verifying" && t.evidence) {
		line += ` | 验证中: ${t.evidence}`;
	} else if (t.status === "completed" && t.evidence) {
		line += ` | 已验证: ${t.evidence}`;
	} else if (t.verifyText) {
		line += ` | 验证: ${t.verifyText}`;
	}
	return line;
}
