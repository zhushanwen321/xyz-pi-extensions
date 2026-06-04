import { describe, it, expect } from "vitest";
import {
	type Todo,
	VALID_STATUSES,
	migrateTodo,
	addTodos,
	buildRender,
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
