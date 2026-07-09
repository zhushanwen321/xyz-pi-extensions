import { describe, expect, it } from "vitest";

import {
	createPendingNotificationsState,
	getOperationStats,
	hasPendingOperations,
	type OperationStatus,
	queryOperations,
	registerOperation,
	unregisterOperation,
	updateOperationStatus,
} from "../state";

// ── 状态创建 ────────────────────────────────────────

describe("createPendingNotificationsState", () => {
	it("should create empty state", () => {
		const state = createPendingNotificationsState();
		expect(state.operations.size).toBe(0);
	});
});

// ── 注册操作 ────────────────────────────────────────

describe("registerOperation", () => {
	it("should register a new operation", () => {
		const state = createPendingNotificationsState();
		const result = registerOperation(state, "op1", "workflow", "Running test workflow");

		expect(result.success).toBe(true);
		expect(result.operation).toBeDefined();
		expect(result.operation!.id).toBe("op1");
		expect(result.operation!.source).toBe("workflow");
		expect(result.operation!.description).toBe("Running test workflow");
		expect(result.operation!.status).toBe("pending");
		expect(result.operation!.registeredAt).toBeGreaterThan(0);
		expect(result.operation!.updatedAt).toBeGreaterThan(0);
	});

	it("should register with metadata", () => {
		const state = createPendingNotificationsState();
		const metadata = { workflowId: "wf-123", step: 3 };
		const result = registerOperation(state, "op1", "workflow", "Running step 3", metadata);

		expect(result.success).toBe(true);
		expect(result.operation!.metadata).toEqual(metadata);
	});

	it("should reject duplicate operation id", () => {
		const state = createPendingNotificationsState();
		registerOperation(state, "op1", "workflow", "First operation");
		const result = registerOperation(state, "op1", "workflow", "Duplicate operation");

		expect(result.success).toBe(false);
		expect(result.error).toContain("already exists");
	});

	it("should register multiple operations", () => {
		const state = createPendingNotificationsState();
		registerOperation(state, "op1", "workflow", "Operation 1");
		registerOperation(state, "op2", "subagent", "Operation 2");
		registerOperation(state, "op3", "workflow", "Operation 3");

		expect(state.operations.size).toBe(3);
	});
});

// ── 更新操作状态 ────────────────────────────────────

describe("updateOperationStatus", () => {
	it("should update operation status", () => {
		const state = createPendingNotificationsState();
		registerOperation(state, "op1", "workflow", "Running");

		const result = updateOperationStatus(state, "op1", "running");

		expect(result.success).toBe(true);
		expect(result.operation!.status).toBe("running");
		expect(result.operation!.updatedAt).toBeGreaterThanOrEqual(result.operation!.registeredAt);
	});

	it("should update metadata", () => {
		const state = createPendingNotificationsState();
		registerOperation(state, "op1", "workflow", "Running", { step: 1 });

		const result = updateOperationStatus(state, "op1", "running", { step: 2, progress: 50 });

		expect(result.success).toBe(true);
		expect(result.operation!.metadata).toEqual({ step: 2, progress: 50 });
	});

	it("should merge metadata", () => {
		const state = createPendingNotificationsState();
		registerOperation(state, "op1", "workflow", "Running", { step: 1, name: "test" });

		updateOperationStatus(state, "op1", "running", { step: 2 });

		const op = state.operations.get("op1")!;
		expect(op.metadata).toEqual({ step: 2, name: "test" });
	});

	it("should reject non-existent operation", () => {
		const state = createPendingNotificationsState();
		const result = updateOperationStatus(state, "op1", "running");

		expect(result.success).toBe(false);
		expect(result.error).toContain("not found");
	});

	it("should transition through all valid statuses", () => {
		const state = createPendingNotificationsState();
		registerOperation(state, "op1", "workflow", "Test");

		const statuses: OperationStatus[] = ["running", "completed"];
		for (const status of statuses) {
			const result = updateOperationStatus(state, "op1", status);
			expect(result.success).toBe(true);
			expect(result.operation!.status).toBe(status);
		}
	});
});

// ── 注销操作 ────────────────────────────────────────

describe("unregisterOperation", () => {
	it("should unregister existing operation", () => {
		const state = createPendingNotificationsState();
		registerOperation(state, "op1", "workflow", "Test");

		const result = unregisterOperation(state, "op1");

		expect(result.success).toBe(true);
		expect(state.operations.size).toBe(0);
	});

	it("should reject non-existent operation", () => {
		const state = createPendingNotificationsState();
		const result = unregisterOperation(state, "op1");

		expect(result.success).toBe(false);
		expect(result.error).toContain("not found");
	});

	it("should not affect other operations", () => {
		const state = createPendingNotificationsState();
		registerOperation(state, "op1", "workflow", "Test 1");
		registerOperation(state, "op2", "subagent", "Test 2");

		unregisterOperation(state, "op1");

		expect(state.operations.size).toBe(1);
		expect(state.operations.has("op2")).toBe(true);
	});
});

// ── 查询操作 ────────────────────────────────────────

describe("queryOperations", () => {
	it("should return all operations without filter", () => {
		const state = createPendingNotificationsState();
		registerOperation(state, "op1", "workflow", "Test 1");
		registerOperation(state, "op2", "subagent", "Test 2");

		const result = queryOperations(state);

		expect(result.total).toBe(2);
		expect(result.operations).toHaveLength(2);
	});

	it("should filter by source", () => {
		const state = createPendingNotificationsState();
		registerOperation(state, "op1", "workflow", "Test 1");
		registerOperation(state, "op2", "subagent", "Test 2");
		registerOperation(state, "op3", "workflow", "Test 3");

		const result = queryOperations(state, { source: "workflow" });

		expect(result.total).toBe(2);
		expect(result.operations.every((op) => op.source === "workflow")).toBe(true);
	});

	it("should filter by status", () => {
		const state = createPendingNotificationsState();
		registerOperation(state, "op1", "workflow", "Test 1");
		registerOperation(state, "op2", "workflow", "Test 2");
		updateOperationStatus(state, "op1", "running");

		const result = queryOperations(state, { status: "pending" });

		expect(result.total).toBe(1);
		expect(result.operations[0].id).toBe("op2");
	});

	it("should filter by both source and status", () => {
		const state = createPendingNotificationsState();
		registerOperation(state, "op1", "workflow", "Test 1");
		registerOperation(state, "op2", "subagent", "Test 2");
		registerOperation(state, "op3", "workflow", "Test 3");
		updateOperationStatus(state, "op1", "running");
		updateOperationStatus(state, "op2", "running");

		const result = queryOperations(state, { source: "workflow", status: "running" });

		expect(result.total).toBe(1);
		expect(result.operations[0].id).toBe("op1");
	});

	it("should return empty result for non-matching filter", () => {
		const state = createPendingNotificationsState();
		registerOperation(state, "op1", "workflow", "Test 1");

		const result = queryOperations(state, { source: "nonexistent" });

		expect(result.total).toBe(0);
		expect(result.operations).toHaveLength(0);
	});
});

// ── 待处理操作检查 ──────────────────────────────────

describe("hasPendingOperations", () => {
	it("should return false when no operations", () => {
		const state = createPendingNotificationsState();
		expect(hasPendingOperations(state)).toBe(false);
	});

	it("should return true when has pending operations", () => {
		const state = createPendingNotificationsState();
		registerOperation(state, "op1", "workflow", "Test");
		expect(hasPendingOperations(state)).toBe(true);
	});

	it("should return false when all operations are completed", () => {
		const state = createPendingNotificationsState();
		registerOperation(state, "op1", "workflow", "Test");
		updateOperationStatus(state, "op1", "completed");
		expect(hasPendingOperations(state)).toBe(false);
	});

	it("should filter by source", () => {
		const state = createPendingNotificationsState();
		registerOperation(state, "op1", "workflow", "Test 1");
		registerOperation(state, "op2", "subagent", "Test 2");

		expect(hasPendingOperations(state, "workflow")).toBe(true);
		expect(hasPendingOperations(state, "nonexistent")).toBe(false);
	});

	it("should return true when has running operations", () => {
		const state = createPendingNotificationsState();
		registerOperation(state, "op1", "workflow", "Test");
		updateOperationStatus(state, "op1", "running");
		expect(hasPendingOperations(state)).toBe(false);
	});
});

// ── 操作统计 ────────────────────────────────────────

describe("getOperationStats", () => {
	it("should return zero stats for empty state", () => {
		const state = createPendingNotificationsState();
		const stats = getOperationStats(state);

		expect(stats.pending).toBe(0);
		expect(stats.running).toBe(0);
		expect(stats.completed).toBe(0);
		expect(stats.failed).toBe(0);
	});

	it("should count operations by status", () => {
		const state = createPendingNotificationsState();
		registerOperation(state, "op1", "workflow", "Test 1");
		registerOperation(state, "op2", "workflow", "Test 2");
		registerOperation(state, "op3", "workflow", "Test 3");
		registerOperation(state, "op4", "workflow", "Test 4");

		updateOperationStatus(state, "op1", "running");
		updateOperationStatus(state, "op2", "completed");
		updateOperationStatus(state, "op3", "failed");

		const stats = getOperationStats(state);

		expect(stats.pending).toBe(1);
		expect(stats.running).toBe(1);
		expect(stats.completed).toBe(1);
		expect(stats.failed).toBe(1);
	});
});

// ── 集成场景 ────────────────────────────────────────

describe("integration scenarios", () => {
	it("should handle workflow lifecycle", () => {
		const state = createPendingNotificationsState();

		// workflow 注册开始
		registerOperation(state, "wf-1", "workflow", "Running test workflow", {
			totalSteps: 5,
		});

		expect(hasPendingOperations(state, "workflow")).toBe(true);

		// workflow 执行中
		updateOperationStatus(state, "wf-1", "running", { currentStep: 1 });

		const op = state.operations.get("wf-1")!;
		expect(op.status).toBe("running");
		expect(op.metadata).toEqual({ totalSteps: 5, currentStep: 1 });

		// workflow 完成
		updateOperationStatus(state, "wf-1", "completed");

		expect(hasPendingOperations(state, "workflow")).toBe(false);

		// 清理
		unregisterOperation(state, "wf-1");
		expect(state.operations.size).toBe(0);
	});

	it("should handle multiple concurrent operations from different sources", () => {
		const state = createPendingNotificationsState();

		// workflow 和 subagent 同时运行
		registerOperation(state, "wf-1", "workflow", "Running workflow");
		registerOperation(state, "sa-1", "subagent", "Running subagent");

		expect(hasPendingOperations(state)).toBe(true);
		expect(hasPendingOperations(state, "workflow")).toBe(true);
		expect(hasPendingOperations(state, "subagent")).toBe(true);

		// 查询所有待处理
		const pending = queryOperations(state, { status: "pending" });
		expect(pending.total).toBe(2);

		// workflow 完成
		updateOperationStatus(state, "wf-1", "completed");
		expect(hasPendingOperations(state, "workflow")).toBe(false);
		expect(hasPendingOperations(state, "subagent")).toBe(true);

		// subagent 完成
		updateOperationStatus(state, "sa-1", "completed");
		expect(hasPendingOperations(state)).toBe(false);
	});

	it("should handle operation failure", () => {
		const state = createPendingNotificationsState();

		registerOperation(state, "op1", "workflow", "Test");
		updateOperationStatus(state, "op1", "running");
		updateOperationStatus(state, "op1", "failed", { error: "timeout" });

		const op = state.operations.get("op1")!;
		expect(op.status).toBe("failed");
		expect(op.metadata).toEqual({ error: "timeout" });

		// 统计应该反映失败
		const stats = getOperationStats(state);
		expect(stats.failed).toBe(1);
		expect(stats.pending).toBe(0);
	});
});
