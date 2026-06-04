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

	it("should include all five valid statuses", () => {
		expect(VALID_STATUSES).toEqual(["pending", "in_progress", "verifying", "completed", "failed"]);
	});

	it("should preserve evidence when migrating old data", () => {
		const todo = {
			id: 1,
			text: "task",
			status: "verifying",
			verifyText: "check X",
			evidence: "grep confirmed no residual",
			verifyAttempts: 0,
		} as unknown as Todo;
		const migrated = migrateTodo(todo);
		expect(migrated.evidence).toBe("grep confirmed no residual");
		expect(migrated.status).toBe("verifying");
	});

	it("should default evidence to undefined when absent", () => {
		const oldTodo = { id: 1, text: "test", status: "pending" } as unknown as Todo;
		const migrated = migrateTodo(oldTodo);
		expect(migrated.evidence).toBeUndefined();
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

	it("should show verifying status with evidence", () => {
		const todo: Todo = {
			id: 3,
			text: "fix auth",
			status: "verifying",
			verifyText: "check status codes",
			evidence: "grep confirmed no display:true residual",
			verifyAttempts: 0,
		};
		const line = formatTodoLine(todo);

		expect(line).toContain("[v]");
		expect(line).toContain("验证中: grep confirmed no display:true residual");
	});

	it("should show completed with evidence", () => {
		const todo: Todo = {
			id: 4,
			text: "fix login",
			status: "completed",
			verifyText: "密码错误时返回正确错误码",
			evidence: "42 测试全通过，typecheck 无错误",
			verifyAttempts: 0,
		};
		const line = formatTodoLine(todo);

		expect(line).toContain("[x]");
		expect(line).toContain("已验证: 42 测试全通过");
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

	it("should detect verify failure when attempts exceed max (completed status)", () => {
		const todos: Todo[] = [
			{
				id: 2,
				text: "task B",
				status: "completed",
				verifyText: "check B",
				verifyAttempts: MAX_VERIFY_ATTEMPTS,
			},
		];

		const failed = todos.find(
			(t) =>
				t.status === "completed" &&
				t.verifyText &&
				t.verifyAttempts >= MAX_VERIFY_ATTEMPTS,
		);

		expect(failed).toBeDefined();
		failed!.status = "failed";
		expect(failed!.status).toBe("failed");
	});

	it("should increment verifyAttempts when AI re-opens completed task with verifyText", () => {
		const todos: Todo[] = [
			{ id: 1, text: "task A", status: "completed", verifyText: "check A", verifyAttempts: 0 },
		];

		todos[0].status = "in_progress";
		todos[0].verifyAttempts++;
		expect(todos[0].verifyAttempts).toBe(1);
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
				: "";
			return `#${t.id}: ${t.text}${verifyTag}`;
		});

		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("#1: task A [待验证: check A]");
		expect(lines[1]).toBe("#2: task B");
	});

	it("should include verifying tasks as pending (not completed)", () => {
		const todos: Todo[] = [
			{ id: 1, text: "A", status: "verifying", verifyText: "check A", verifyAttempts: 0, evidence: "testing..." },
			{ id: 2, text: "B", status: "completed", verifyAttempts: 0 },
		];

		const pendingTodos = todos.filter((t) => t.status !== "completed");
		expect(pendingTodos).toHaveLength(1);
		expect(pendingTodos[0].status).toBe("verifying");
	});
});

// ── batch update validation - Task 3b ─────────────────

describe("batch update validation - Task 3b", () => {
	it("should reject invalid status values in updates[]", () => {
		const todos: Todo[] = [{ id: 1, text: "A", status: "pending", verifyAttempts: 0 }];
		const result = updateTodos(todos, [{ id: 1, status: "banana" }]);
		expect(result.error).toContain("invalid status");
		expect(result.updatedTodos[0].status).toBe("pending"); // unchanged
	});

	it("should accept valid status values in updates[]", () => {
		const todos: Todo[] = [{ id: 1, text: "A", status: "pending", verifyAttempts: 0 }];
		const result = updateTodos(todos, [{ id: 1, status: "completed" }]);
		expect(result.error).toBeUndefined();
		expect(result.updatedTodos[0].status).toBe("completed");
	});
});

// ── verifyAttempts increment on re-open ─────────────

describe("verifyAttempts increment on re-open", () => {
	it("should increment verifyAttempts when status changes from completed to in_progress with verifyText", () => {
		const todo: Todo = { id: 1, text: "fix auth", status: "completed", verifyText: "check status codes", verifyAttempts: 0 };

		const oldStatus = todo.status;
		todo.status = "in_progress";
		if (oldStatus === "completed" && todo.verifyText && todo.verifyAttempts < 2) {
			todo.verifyAttempts++;
		}

		expect(todo.verifyAttempts).toBe(1);
		expect(todo.status).toBe("in_progress");
	});

	it("should NOT increment verifyAttempts when re-opening task without verifyText", () => {
		const todo: Todo = { id: 1, text: "simple task", status: "completed", verifyAttempts: 0 };

		const oldStatus = todo.status;
		todo.status = "in_progress";
		if (oldStatus === "completed" && todo.verifyText && todo.verifyAttempts < 2) {
			todo.verifyAttempts++;
		}

		expect(todo.verifyAttempts).toBe(0); // no verifyText → no increment
	});
});

// ── verifying state transitions ────────────────────

describe("verifying state transitions", () => {
	it("should block verifying on task without verifyText", () => {
		const todos: Todo[] = [
			{ id: 1, text: "simple", status: "in_progress", verifyAttempts: 0 },
		];
		const result = updateTodos(todos, [{ id: 1, status: "verifying", evidence: "this should be blocked" }]);

		expect(result.blocked).toBeDefined();
		expect(result.blocked!.length).toBe(1);
		expect(result.blocked![0].reason).toContain("verifyText");
		expect(result.updatedTodos[0].status).toBe("in_progress"); // unchanged
	});

	it("should block verifying without evidence", () => {
		const todos: Todo[] = [
			{ id: 1, text: "fix auth", status: "in_progress", verifyText: "check codes", verifyAttempts: 0 },
		];
		const result = updateTodos(todos, [{ id: 1, status: "verifying" }]);

		expect(result.blocked).toBeDefined();
		expect(result.blocked![0].reason).toContain("evidence");
		expect(result.updatedTodos[0].status).toBe("in_progress");
	});

	it("should block verifying with evidence shorter than 10 chars", () => {
		const todos: Todo[] = [
			{ id: 1, text: "fix auth", status: "in_progress", verifyText: "check codes", verifyAttempts: 0 },
		];
		const result = updateTodos(todos, [{ id: 1, status: "verifying", evidence: "short" }]);

		expect(result.blocked).toBeDefined();
		expect(result.blocked![0].reason).toContain("10");
	});

	it("should allow verifying with valid evidence", () => {
		const todos: Todo[] = [
			{ id: 1, text: "fix auth", status: "in_progress", verifyText: "check codes", verifyAttempts: 0 },
		];
		const result = updateTodos(todos, [{ id: 1, status: "verifying", evidence: "grep confirmed no residual code" }]);

		expect(result.error).toBeUndefined();
		expect(result.blocked).toBeUndefined();
		expect(result.updatedTodos[0].status).toBe("verifying");
		expect(result.updatedTodos[0].evidence).toBe("grep confirmed no residual code");
	});

	it("should block verifying → completed without evidence", () => {
		const todos: Todo[] = [
			{ id: 1, text: "fix auth", status: "verifying", verifyText: "check codes", verifyAttempts: 0, evidence: "testing" },
		];
		const result = updateTodos(todos, [{ id: 1, status: "completed" }]);

		expect(result.blocked).toBeDefined();
		expect(result.blocked![0].reason).toContain("evidence");
		expect(result.updatedTodos[0].status).toBe("verifying"); // unchanged
	});

	it("should allow verifying → completed with evidence", () => {
		const todos: Todo[] = [
			{ id: 1, text: "fix auth", status: "verifying", verifyText: "check codes", verifyAttempts: 0, evidence: "testing in progress" },
		];
		const result = updateTodos(todos, [{ id: 1, status: "completed", evidence: "all 42 tests passed, typecheck clean" }]);

		expect(result.error).toBeUndefined();
		expect(result.updatedTodos[0].status).toBe("completed");
		expect(result.updatedTodos[0].evidence).toBe("all 42 tests passed, typecheck clean");
	});

	it("should allow in_progress → completed directly for tasks without verifyText", () => {
		const todos: Todo[] = [
			{ id: 1, text: "simple", status: "in_progress", verifyAttempts: 0 },
		];
		const result = updateTodos(todos, [{ id: 1, status: "completed" }]);

		expect(result.error).toBeUndefined();
		expect(result.blocked).toBeUndefined();
		expect(result.updatedTodos[0].status).toBe("completed");
	});

	it("should block in_progress → completed on verifyText task without verified+evidence", () => {
		const todos: Todo[] = [
			{ id: 1, text: "fix auth", status: "in_progress", verifyText: "check codes", verifyAttempts: 0 },
		];
		const result = updateTodos(todos, [{ id: 1, status: "completed" }]);

		expect(result.blocked).toBeDefined();
		expect(result.blocked![0].reason).toContain("verifying");
	});

	it("should allow in_progress → completed with verified=true + evidence (skip verifying)", () => {
		const todos: Todo[] = [
			{ id: 1, text: "fix auth", status: "in_progress", verifyText: "check codes", verifyAttempts: 0 },
		];
		const result = updateTodos(todos, [{ id: 1, status: "completed", verified: true, evidence: "all tests passed confirmed" }]);

		expect(result.error).toBeUndefined();
		expect(result.updatedTodos[0].status).toBe("completed");
		expect(result.updatedTodos[0].evidence).toBe("all tests passed confirmed");
	});

	it("should block in_progress → completed with verified=true but no evidence", () => {
		const todos: Todo[] = [
			{ id: 1, text: "fix auth", status: "in_progress", verifyText: "check codes", verifyAttempts: 0 },
		];
		const result = updateTodos(todos, [{ id: 1, status: "completed", verified: true }]);

		expect(result.blocked).toBeDefined();
		expect(result.blocked![0].reason).toContain("evidence");
	});

	it("should block batch completed when mixed verifyText tasks lack evidence", () => {
		const todos: Todo[] = [
			{ id: 1, text: "A", status: "in_progress", verifyText: "check A", verifyAttempts: 0 },
			{ id: 2, text: "B", status: "in_progress", verifyAttempts: 0 },
		];
		const result = updateTodos(todos, [
			{ id: 1, status: "completed" },
			{ id: 2, status: "completed" },
		]);

		expect(result.blocked).toBeDefined();
		expect(result.blocked!.length).toBe(1); // only #1 blocked
		expect(result.blocked![0].id).toBe(1);
		// both unchanged (all-or-nothing)
		expect(result.updatedTodos[0].status).toBe("in_progress");
		expect(result.updatedTodos[1].status).toBe("in_progress");
	});

	it("should allow batch when verifyText task has verified+evidence and non-verifyText task is plain", () => {
		const todos: Todo[] = [
			{ id: 1, text: "A", status: "in_progress", verifyText: "check A", verifyAttempts: 0 },
			{ id: 2, text: "B", status: "in_progress", verifyAttempts: 0 },
		];
		const result = updateTodos(todos, [
			{ id: 1, status: "completed", verified: true, evidence: "confirmed via grep" },
			{ id: 2, status: "completed" },
		]);

		expect(result.error).toBeUndefined();
		expect(result.updatedTodos[0].status).toBe("completed");
		expect(result.updatedTodos[1].status).toBe("completed");
	});

	it("should allow non-completed status changes without evidence", () => {
		const todos: Todo[] = [
			{ id: 1, text: "A", status: "pending", verifyText: "check A", verifyAttempts: 0 },
		];
		const result = updateTodos(todos, [{ id: 1, status: "in_progress" }]);

		expect(result.error).toBeUndefined();
		expect(result.blocked).toBeUndefined();
		expect(result.updatedTodos[0].status).toBe("in_progress");
	});

	it("should allow verifying → in_progress (verification failed, rework)", () => {
		const todos: Todo[] = [
			{ id: 1, text: "fix auth", status: "verifying", verifyText: "check codes", verifyAttempts: 0, evidence: "initial check" },
		];
		const result = updateTodos(todos, [{ id: 1, status: "in_progress" }]);

		expect(result.error).toBeUndefined();
		expect(result.updatedTodos[0].status).toBe("in_progress");
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
