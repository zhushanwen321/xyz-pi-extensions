import { describe, it, expect } from "vitest";
import {
	type Todo,
	VALID_STATUSES,
	migrateTodo,
	addTodos,
	buildRender,
	updateTodos,
	formatTodoLine,
} from "../model";

// ── Task 1: 数据模型增强 + 向后兼容 ──────────────────

describe("Todo data model - Task 1", () => {
	it("should load old data without verifyText/verifyAttempts", () => {
		// 旧格式: 没有 verifyText 和 verifyAttempts 字段
		const oldTodo = { id: 1, text: "test", status: "completed" } as unknown as Todo;
		const migrated = migrateTodo(oldTodo);

		expect(migrated.verifyText).toBeUndefined();
		expect(migrated.verifyAttempts).toBe(0);
		expect(migrated.status).toBe("completed");
		expect(migrated.text).toBe("test");
		expect(migrated.id).toBe(1);
	});

	it("should accept failed status", () => {
		const todo: Todo = {
			id: 1,
			text: "test",
			status: "failed",
			verifyAttempts: 2,
		};
		const migrated = migrateTodo(todo);

		expect(migrated.status).toBe("failed");
		expect(migrated.verifyAttempts).toBe(2);
		expect(VALID_STATUSES).toContain("failed");
	});

	it("should set verifyAttempts default to 0 when migrating old data", () => {
		const oldTodo = { id: 5, text: "old task", status: "pending" } as unknown as Todo;
		const migrated = migrateTodo(oldTodo);

		expect(migrated.verifyAttempts).toBe(0);
	});

	it("should preserve verifyText when present in old data", () => {
		const todo = {
			id: 2,
			text: "task",
			status: "completed",
			verifyText: "check output",
			verifyAttempts: 1,
		} as unknown as Todo;
		const migrated = migrateTodo(todo);

		expect(migrated.verifyText).toBe("check output");
		expect(migrated.verifyAttempts).toBe(1);
	});

	it("should migrate done:true to completed with default verify fields", () => {
		// 极旧格式: done: boolean
		const veryOldTodo = { id: 3, text: "ancient", done: true } as unknown as Todo;
		const migrated = migrateTodo(veryOldTodo);

		expect(migrated.status).toBe("completed");
		expect(migrated.verifyText).toBeUndefined();
		expect(migrated.verifyAttempts).toBe(0);
	});

	it("should migrate done:false to pending with default verify fields", () => {
		const veryOldTodo = { id: 4, text: "ancient2", done: false } as unknown as Todo;
		const migrated = migrateTodo(veryOldTodo);

		expect(migrated.status).toBe("pending");
		expect(migrated.verifyText).toBeUndefined();
		expect(migrated.verifyAttempts).toBe(0);
	});

	it("should include all four valid statuses", () => {
		expect(VALID_STATUSES).toEqual(["pending", "in_progress", "completed", "failed"]);
	});
});

// ── Task 2: todo add 支持 verifyTexts 参数 ────────────

describe("todo add verifyTexts - Task 2", () => {
	it("should map verifyTexts to todos at corresponding indices", () => {
		const result = addTodos([], 1, ["A", "B"], ["V1"]);

		expect(result.error).toBeUndefined();
		expect(result.newTodos).toHaveLength(2);
		expect(result.newTodos[0].verifyText).toBe("V1");
		expect(result.newTodos[1].verifyText).toBeUndefined();
		expect(result.newTodos[0].verifyAttempts).toBe(0);
		expect(result.newTodos[1].verifyAttempts).toBe(0);
	});

	it("should reject verifyTexts longer than texts", () => {
		const result = addTodos([], 1, ["A"], ["V1", "V2"]);

		expect(result.error).toBe("verifyTexts too long");
		expect(result.resultText).toContain("Error");
		expect(result.newTodos).toHaveLength(0);
	});

	it("should work without verifyTexts (backward compat)", () => {
		const result = addTodos([], 1, ["A"]);

		expect(result.error).toBeUndefined();
		expect(result.newTodos).toHaveLength(1);
		expect(result.newTodos[0].verifyText).toBeUndefined();
		expect(result.newTodos[0].verifyAttempts).toBe(0);
	});

	it("should map all verifyTexts when lengths match", () => {
		const result = addTodos([], 1, ["A", "B", "C"], ["V1", "V2", "V3"]);

		expect(result.error).toBeUndefined();
		expect(result.newTodos).toHaveLength(3);
		expect(result.newTodos[0].verifyText).toBe("V1");
		expect(result.newTodos[1].verifyText).toBe("V2");
		expect(result.newTodos[2].verifyText).toBe("V3");
	});

	it("should return error when texts is empty", () => {
		const result = addTodos([], 1, []);

		expect(result.error).toBe("texts required");
	});

	it("should return error when all texts are empty after trim", () => {
		const result = addTodos([], 1, ["  ", " "]);

		expect(result.error).toBe("all texts empty");
	});

	it("should trim texts and assign correct IDs", () => {
		const existing: Todo[] = [{ id: 1, text: "existing", status: "pending", verifyAttempts: 0 }];
		const result = addTodos(existing, 2, ["  new task  "]);

		expect(result.error).toBeUndefined();
		expect(result.newTodos).toHaveLength(2);
		expect(result.newTodos[1].id).toBe(2);
		expect(result.newTodos[1].text).toBe("new task");
		expect(result.newNextId).toBe(3);
	});
});

// ── Task 3: todo update batch updates[] ──────────────

describe("todo update batch - Task 3", () => {
	it("should update multiple todos with updates[]", () => {
		const todos: Todo[] = [
			{ id: 1, text: "A", status: "pending", verifyAttempts: 0 },
			{ id: 2, text: "B", status: "in_progress", verifyAttempts: 0 },
			{ id: 3, text: "C", status: "pending", verifyAttempts: 0 },
		];
		const result = updateTodos(todos, [
			{ id: 1, status: "completed" },
			{ id: 2, text: "B updated" },
			{ id: 3, status: "failed", text: "C failed" },
		]);

		expect(result.error).toBeUndefined();
		expect(result.updatedTodos).toHaveLength(3);
		expect(result.updatedTodos[0].status).toBe("completed");
		expect(result.updatedTodos[0].text).toBe("A");
		expect(result.updatedTodos[1].text).toBe("B updated");
		expect(result.updatedTodos[1].status).toBe("in_progress"); // unchanged
		expect(result.updatedTodos[2].status).toBe("failed");
		expect(result.updatedTodos[2].text).toBe("C failed");
		expect(result.resultText).toBe("Updated 3 todo(s)");
	});

	it("should reject duplicate ids in updates[]", () => {
		const todos: Todo[] = [
			{ id: 1, text: "A", status: "pending", verifyAttempts: 0 },
		];
		const result = updateTodos(todos, [
			{ id: 1, status: "completed" },
			{ id: 1, status: "pending" },
		]);

		expect(result.error).toBe("duplicate ids in updates");
		expect(result.updatedTodos).toEqual(todos); // unchanged
	});

	it("should reject non-existent ids in updates[] (all-or-nothing)", () => {
		const todos: Todo[] = [
			{ id: 1, text: "A", status: "pending", verifyAttempts: 0 },
		];
		const result = updateTodos(todos, [
			{ id: 1, status: "completed" },
			{ id: 999, status: "pending" },
		]);

		expect(result.error).toBe("id 999 not found");
		expect(result.updatedTodos[0].status).toBe("pending"); // #1 not modified
	});

	it("should reject updates[] item missing both status and text", () => {
		const todos: Todo[] = [
			{ id: 1, text: "A", status: "pending", verifyAttempts: 0 },
		];
		const result = updateTodos(todos, [{ id: 1 }]);

		expect(result.error).toContain("neither status nor text");
		expect(result.updatedTodos[0].status).toBe("pending"); // unchanged
	});
});

// ── Task 4: todo list verifyText ────────────────────

describe("todo list verifyText - Task 4", () => {
	it("should include verifyText in list output when present", () => {
		const todo: Todo = {
			id: 1,
			text: "check output",
			status: "pending",
			verifyText: "check X",
			verifyAttempts: 0,
		};
		const line = formatTodoLine(todo);

		expect(line).toContain(" | 验证: check X");
		expect(line).toContain("#1");
		expect(line).toContain("check output");
	});

	it("should not include verify suffix when verifyText is absent", () => {
		const todo: Todo = {
			id: 2,
			text: "plain task",
			status: "completed",
			verifyAttempts: 0,
		};
		const line = formatTodoLine(todo);

		expect(line).not.toContain("验证");
		expect(line).toContain("#2");
		expect(line).toContain("plain task");
	});
});

// ── Task 5: agent_end loop logic (pure data model tests) ──────────

describe("agent_end loop logic - Task 5", () => {
	const MAX_VERIFY_ATTEMPTS = 2;

	it("should detect completed tasks needing verification", () => {
		const todos: Todo[] = [
			{
				id: 1,
				text: "task A",
				status: "completed",
				verifyText: "check output",
				verifyAttempts: 0,
			},
		];

		const needsVerify = todos.find(
			(t) =>
				t.status === "completed" &&
				t.verifyText &&
				t.verifyAttempts < MAX_VERIFY_ATTEMPTS,
		);

		expect(needsVerify).toBeDefined();
		expect(needsVerify!.id).toBe(1);
		expect(needsVerify!.verifyText).toBe("check output");
	});

	it("should not trigger verify for tasks without verifyText", () => {
		const todos: Todo[] = [
			{
				id: 1,
				text: "task A",
				status: "completed",
				verifyAttempts: 0,
			},
		];

		const needsVerify = todos.find(
			(t) =>
				t.status === "completed" &&
				t.verifyText &&
				t.verifyAttempts < MAX_VERIFY_ATTEMPTS,
		);

		expect(needsVerify).toBeUndefined();
	});

	it("should detect verify failure when attempts exceed max", () => {
		const todos: Todo[] = [
			{
				id: 2,
				text: "task B",
				status: "in_progress",
				verifyText: "check B",
				verifyAttempts: MAX_VERIFY_ATTEMPTS,
			},
		];

		const failed = todos.filter(
			(t) =>
				t.verifyText &&
				t.verifyAttempts >= MAX_VERIFY_ATTEMPTS &&
				t.status === "in_progress",
		);

		expect(failed).toHaveLength(1);
		expect(failed[0].id).toBe(2);

		// Simulate status change to failed
		failed[0].status = "failed";
		expect(failed[0].status).toBe("failed");
	});

	it("should not trigger verify for tasks at max attempts", () => {
		const todos: Todo[] = [
			{
				id: 1,
				text: "task A",
				status: "completed",
				verifyText: "check A",
				verifyAttempts: MAX_VERIFY_ATTEMPTS,
			},
		];

		const needsVerify = todos.find(
			(t) =>
				t.status === "completed" &&
				t.verifyText &&
				t.verifyAttempts < MAX_VERIFY_ATTEMPTS,
		);

		expect(needsVerify).toBeUndefined();
	});

	it("should detect stall when no todo activity for threshold rounds", () => {
		const STALL_THRESHOLD = 5;
		const userMessageCount = 10;
		const lastTodoCallCount = 3;
		const todos: Todo[] = [
			{ id: 1, text: "pending task", status: "pending", verifyAttempts: 0 },
		];
		const allCompletedAtCount = null;

		const isStalled =
			todos.length > 0 &&
			allCompletedAtCount === null &&
			userMessageCount - lastTodoCallCount >= STALL_THRESHOLD;

		expect(isStalled).toBe(true);
	});

	it("should detect reminder when interval elapsed", () => {
		const REMINDER_INTERVAL = 3;
		const userMessageCount = 8;
		const lastTodoCallCount = 4;
		const todos: Todo[] = [
			{ id: 1, text: "task", status: "pending", verifyAttempts: 0 },
		];
		const allCompletedAtCount = null;

		const needsReminder =
			todos.length > 0 &&
			allCompletedAtCount === null &&
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

	it("should format pending tasks with verifyText for context injection", () => {
		const todos: Todo[] = [
			{
				id: 1,
				text: "task A",
				status: "pending",
				verifyText: "check A",
				verifyAttempts: 0,
			},
			{
				id: 2,
				text: "task B",
				status: "in_progress",
				verifyAttempts: 0,
			},
		];

		const pendingTodos = todos.filter((t) => t.status !== "completed");
		const lines = pendingTodos.map((t) => {
			const verifyTag = t.verifyText
				? ` [待验证: ${t.verifyText}]`
				: " [无需验证]";
			return `#${t.id}: ${t.text}${verifyTag}`;
		});

		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("#1: task A [待验证: check A]");
		expect(lines[1]).toBe("#2: task B [无需验证]");
	});
});

// ── buildRender ───────────────────────────────────────

describe("buildRender", () => {
	it("should calculate summary correctly", () => {
		const todos: Todo[] = [
			{ id: 1, text: "a", status: "completed", verifyAttempts: 0 },
			{ id: 2, text: "b", status: "pending", verifyAttempts: 0 },
			{ id: 3, text: "c", status: "failed", verifyAttempts: 2 },
		];
		const render = buildRender(todos);

		expect(render).toBeDefined();
		expect(render!.summary).toBe("1/3 completed");
		expect(render!.data.items).toHaveLength(3);
	});

	it("should handle empty list", () => {
		const render = buildRender([]);

		expect(render).toBeDefined();
		expect(render!.summary).toBe("0/0 completed");
		expect(render!.data.items).toHaveLength(0);
	});
});
