import { describe, expect, it } from "vitest";

import {
	addTodos,
	buildRender,
	formatTodoLine,
	migrateTodo,
	type Todo,
	updateTodos,
	VALID_STATUSES,
} from "../model";

// ── 数据模型 + 向后兼容 ──────────────────────────────

describe("Todo data model", () => {
	it("should load old data without verifyText/verifyAttempts", () => {
		const oldTodo = { id: 1, text: "test", status: "completed" } as unknown as Todo;
		const migrated = migrateTodo(oldTodo);

		expect(migrated.status).toBe("completed");
		expect(migrated.text).toBe("test");
		expect(migrated.id).toBe(1);
	});

	it("should include exactly three valid statuses", () => {
		expect(VALID_STATUSES).toEqual(["pending", "in_progress", "completed"]);
	});

	it("should migrate verifying → in_progress", () => {
		const oldTodo = { id: 1, text: "test", status: "verifying" } as unknown as Todo;
		const migrated = migrateTodo(oldTodo);
		expect(migrated.status).toBe("in_progress");
	});

	it("should migrate failed → pending", () => {
		const oldTodo = { id: 1, text: "test", status: "failed" } as unknown as Todo;
		const migrated = migrateTodo(oldTodo);
		expect(migrated.status).toBe("pending");
	});

	it("should migrate done:true to completed", () => {
		const veryOldTodo = { id: 3, text: "ancient", done: true } as unknown as Todo;
		const migrated = migrateTodo(veryOldTodo);
		expect(migrated.status).toBe("completed");
	});

	it("should migrate done:false to pending", () => {
		const veryOldTodo = { id: 4, text: "ancient2", done: false } as unknown as Todo;
		const migrated = migrateTodo(veryOldTodo);
		expect(migrated.status).toBe("pending");
	});
});

// ── todo add ────────────────────────────────────────

describe("todo add", () => {
	it("should add todos with sequential IDs", () => {
		const result = addTodos([], 1, ["A", "B"]);
		expect(result.error).toBeUndefined();
		expect(result.newTodos).toHaveLength(2);
		expect(result.newTodos[0].id).toBe(1);
		expect(result.newTodos[1].id).toBe(2);
		expect(result.newTodos[0].status).toBe("pending");
	});

	it("should append to existing todos", () => {
		const existing: Todo[] = [{ id: 1, text: "existing", status: "pending" }];
		const result = addTodos(existing, 2, ["new task"]);
		expect(result.error).toBeUndefined();
		expect(result.newTodos).toHaveLength(2);
		expect(result.newTodos[1].id).toBe(2);
		expect(result.newTodos[1].text).toBe("new task");
		expect(result.newNextId).toBe(3);
	});

	it("should return error when texts is empty", () => {
		const result = addTodos([], 1, []);
		expect(result.error).toBe("texts required");
	});

	it("should return error when all texts are empty after trim", () => {
		const result = addTodos([], 1, ["  ", " "]);
		expect(result.error).toBe("all texts empty");
	});

	it("should trim texts", () => {
		const result = addTodos([], 1, ["  new task  "]);
		expect(result.error).toBeUndefined();
		expect(result.newTodos[0].text).toBe("new task");
	});
});

// ── todo update batch ───────────────────────────────

describe("todo update batch", () => {
	it("should update multiple todos with updates[]", () => {
		const todos: Todo[] = [
			{ id: 1, text: "A", status: "pending" },
			{ id: 2, text: "B", status: "in_progress" },
			{ id: 3, text: "C", status: "pending" },
		];
		const result = updateTodos(todos, [
			{ id: 1, status: "completed" },
			{ id: 2, text: "B updated" },
			{ id: 3, status: "completed", text: "C done" },
		]);

		expect(result.error).toBeUndefined();
		expect(result.updatedTodos).toHaveLength(3);
		expect(result.updatedTodos[0].status).toBe("completed");
		expect(result.updatedTodos[0].text).toBe("A");
		expect(result.updatedTodos[1].text).toBe("B updated");
		expect(result.updatedTodos[1].status).toBe("in_progress");
		expect(result.updatedTodos[2].status).toBe("completed");
		expect(result.updatedTodos[2].text).toBe("C done");
	});

	it("should reject duplicate ids in updates[]", () => {
		const todos: Todo[] = [{ id: 1, text: "A", status: "pending" }];
		const result = updateTodos(todos, [
			{ id: 1, status: "completed" },
			{ id: 1, status: "pending" },
		]);
		expect(result.error).toBe("duplicate ids in updates");
		expect(result.updatedTodos).toEqual(todos);
	});

	it("should reject non-existent ids", () => {
		const todos: Todo[] = [{ id: 1, text: "A", status: "pending" }];
		const result = updateTodos(todos, [{ id: 999, status: "pending" }]);
		expect(result.error).toBe("id 999 not found");
	});

	it("should reject updates[] item missing both status and text", () => {
		const todos: Todo[] = [{ id: 1, text: "A", status: "pending" }];
		const result = updateTodos(todos, [{ id: 1 }]);
		expect(result.error).toContain("neither status nor text");
	});

	it("should reject invalid status values", () => {
		const todos: Todo[] = [{ id: 1, text: "A", status: "pending" }];
		const result = updateTodos(todos, [{ id: 1, status: "banana" }]);
		expect(result.error).toContain("invalid status");
	});
});

// ── completed 无拦截 ────────────────────────────────

describe("completed without interception", () => {
	it("should allow in_progress → completed directly", () => {
		const todos: Todo[] = [{ id: 1, text: "simple", status: "in_progress" }];
		const result = updateTodos(todos, [{ id: 1, status: "completed" }]);
		expect(result.error).toBeUndefined();
		expect(result.updatedTodos[0].status).toBe("completed");
	});

	it("should allow pending → completed directly", () => {
		const todos: Todo[] = [{ id: 1, text: "skip", status: "pending" }];
		const result = updateTodos(todos, [{ id: 1, status: "completed" }]);
		expect(result.error).toBeUndefined();
		expect(result.updatedTodos[0].status).toBe("completed");
	});

	it("should allow batch all completed without evidence", () => {
		const todos: Todo[] = [
			{ id: 1, text: "A", status: "in_progress" },
			{ id: 2, text: "B", status: "in_progress" },
		];
		const result = updateTodos(todos, [
			{ id: 1, status: "completed" },
			{ id: 2, status: "completed" },
		]);
		expect(result.error).toBeUndefined();
		expect(result.updatedTodos[0].status).toBe("completed");
		expect(result.updatedTodos[1].status).toBe("completed");
	});
});

// ── formatTodoLine ──────────────────────────────────

describe("formatTodoLine", () => {
	it("should format pending todo", () => {
		const todo: Todo = { id: 1, text: "task A", status: "pending" };
		expect(formatTodoLine(todo)).toBe("[ ] #1: task A");
	});

	it("should format in_progress todo", () => {
		const todo: Todo = { id: 2, text: "task B", status: "in_progress" };
		expect(formatTodoLine(todo)).toBe("[~] #2: task B");
	});

	it("should format completed todo", () => {
		const todo: Todo = { id: 3, text: "task C", status: "completed" };
		expect(formatTodoLine(todo)).toBe("[x] #3: task C");
	});
});

// ── buildRender ─────────────────────────────────────

describe("buildRender", () => {
	it("should calculate summary correctly", () => {
		const todos: Todo[] = [
			{ id: 1, text: "a", status: "completed" },
			{ id: 2, text: "b", status: "pending" },
			{ id: 3, text: "c", status: "in_progress" },
		];
		const render = buildRender(todos);
		expect(render).toBeDefined();
		expect(render!.summary).toBe("1/3 completed");
		expect(render!.data.items).toHaveLength(3);
	});

	it("should handle empty list", () => {
		const render = buildRender([]);
		expect(render!.summary).toBe("0/0 completed");
	});
});

// ── agent_end logic (pure data) ─────────────────────

describe("agent_end logic", () => {
	it("should detect stall when no todo activity for threshold rounds", () => {
		const STALL_THRESHOLD = 5;
		const userMessageCount = 10;
		const lastTodoCallCount = 3;
		const todos: Todo[] = [{ id: 1, text: "pending task", status: "pending" }];

		const isStalled =
			todos.length > 0 &&
			userMessageCount - lastTodoCallCount >= STALL_THRESHOLD;

		expect(isStalled).toBe(true);
	});

	it("should detect reminder when interval elapsed", () => {
		const REMINDER_INTERVAL = 2;
		const userMessageCount = 5;
		const lastTodoCallCount = 3;
		const todos: Todo[] = [{ id: 1, text: "task", status: "pending" }];

		const needsReminder =
			todos.length > 0 &&
			userMessageCount - lastTodoCallCount >= REMINDER_INTERVAL;

		expect(needsReminder).toBe(true);
	});

	it("should auto-clear when all completed and delay rounds elapsed", () => {
		const AUTO_CLEAR_DELAY_ROUNDS = 2;
		const userMessageCount = 7;
		const allCompletedAtCount = 4;

		const shouldClear =
			allCompletedAtCount !== null &&
			userMessageCount - allCompletedAtCount >= AUTO_CLEAR_DELAY_ROUNDS;

		expect(shouldClear).toBe(true);
	});

	it("should not auto-clear when delay rounds not yet elapsed", () => {
		const AUTO_CLEAR_DELAY_ROUNDS = 2;
		const userMessageCount = 5;
		const allCompletedAtCount = 4;

		const shouldClear =
			allCompletedAtCount !== null &&
			userMessageCount - allCompletedAtCount >= AUTO_CLEAR_DELAY_ROUNDS;

		expect(shouldClear).toBe(false);
	});

	it("should pick first pending todo as next recommended", () => {
		const todos: Todo[] = [
			{ id: 1, text: "A", status: "completed" },
			{ id: 2, text: "B", status: "pending" },
			{ id: 3, text: "C", status: "pending" },
		];
		const next = todos.find((t) => t.status !== "completed");
		expect(next!.id).toBe(2);
		expect(next!.text).toBe("B");
	});
});
