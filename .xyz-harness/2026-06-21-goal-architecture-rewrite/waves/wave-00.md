# Wave 0: vitest.config.ts + engine/task.ts

- **目标文件**：
  - 修改：`extensions/goal/vitest.config.ts`
  - 创建：`extensions/goal/src/engine/task.ts`
  - 测试：`extensions/goal/src/engine/__tests__/task.test.ts`
- **前置 wave**：无
- **目标**：建立 engine 层地基。修改 vitest include 模式使 `src/**/*.test.ts` 全量被发现；实现 Task 聚合（5 态 TaskStatus + 3 态 SubtaskStatus + GoalTask/Subtask/TaskVerification 类型 + 双维度投影函数 + 纯 status 级 `validateTaskTransition`），并配齐全枚举测试。engine 零 Pi import。

## 关键约束

1. `engine/` 下禁止 import `@mariozechner` / `@earendil`
2. `validateTaskTransition` **只看 status，不看 verification**。`completed && !verification` 全锁逻辑在 service 层（Wave 5）
3. 禁止 `any`、`eslint-disable`、`as Partial<X> as Y`

---

- [ ] **步骤 1：修改 vitest.config.ts**

将 `include` 从 `["src/__tests__/**/*.test.ts"]` 改为 `["src/**/*.test.ts"]`。完整文件内容：

```typescript
import path from "node:path";

import { defineConfig } from "vitest/config";

const piStub = path.resolve(__dirname, "src/__tests__/stubs/pi-sdk.ts");
const typeboxStub = path.resolve(__dirname, "src/__tests__/stubs/typebox.ts");

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
	},
	resolve: {
		alias: {
			"@mariozechner/pi-coding-agent": piStub,
			"@earendil-works/pi-ai": piStub,
			"@earendil-works/pi-tui": piStub,
			"@mariozechner/pi-ai": piStub,
			"@sinclair/typebox": typeboxStub,
			"typebox": typeboxStub,
		},
	},
});
```

运行：`pnpm --filter @zhushanwen/pi-goal test`
预期：现有 3 个测试全绿。

- [ ] **步骤 2：编写失败的测试**

创建 `extensions/goal/src/engine/__tests__/task.test.ts`：

```typescript
/**
 * engine/task.ts 测试 — Task 聚合状态机 + 双维度投影
 */
import { describe, expect, it } from "vitest";

import {
	getCompletionState,
	getVerificationState,
	isTaskDone,
	isTerminalTaskStatus,
	validateTaskTransition,
	type GoalTask,
} from "../task";

const makeTask = (overrides: Partial<GoalTask> = {}): GoalTask => ({
	id: 1,
	description: "test task",
	status: "pending",
	lastUpdatedTurn: 0,
	...overrides,
});

// ── isTerminalTaskStatus ─────────────────────────────

describe("isTerminalTaskStatus", () => {
	it("verified → terminal", () => {
		expect(isTerminalTaskStatus("verified")).toBe(true);
	});
	it("cancelled → terminal", () => {
		expect(isTerminalTaskStatus("cancelled")).toBe(true);
	});
	it("completed → NOT terminal", () => {
		expect(isTerminalTaskStatus("completed")).toBe(false);
	});
	it("pending → NOT terminal", () => {
		expect(isTerminalTaskStatus("pending")).toBe(false);
	});
	it("in_progress → NOT terminal", () => {
		expect(isTerminalTaskStatus("in_progress")).toBe(false);
	});
});

// ── isTaskDone（业务语义完成判定）─────────────────────

describe("isTaskDone", () => {
	it("verified → done", () => {
		expect(isTaskDone(makeTask({ status: "verified" }))).toBe(true);
	});
	it("cancelled → done", () => {
		expect(isTaskDone(makeTask({ status: "cancelled" }))).toBe(true);
	});
	it("completed without verification → done", () => {
		expect(isTaskDone(makeTask({ status: "completed" }))).toBe(true);
	});
	it("completed with verification pending → NOT done", () => {
		expect(
			isTaskDone(
				makeTask({
					status: "completed",
					verification: { method: "pnpm test", expected: "all pass" },
				}),
			),
		).toBe(false);
	});
	it("pending → NOT done", () => {
		expect(isTaskDone(makeTask({ status: "pending" }))).toBe(false);
	});
	it("in_progress → NOT done", () => {
		expect(isTaskDone(makeTask({ status: "in_progress" }))).toBe(false);
	});
});

// ── getCompletionState ───────────────────────────────

describe("getCompletionState", () => {
	it("completed/verified/cancelled → done", () => {
		expect(getCompletionState(makeTask({ status: "completed" }))).toBe("done");
		expect(getCompletionState(makeTask({ status: "verified" }))).toBe("done");
		expect(getCompletionState(makeTask({ status: "cancelled" }))).toBe("done");
	});
	it("pending/in_progress → not_done", () => {
		expect(getCompletionState(makeTask({ status: "pending" }))).toBe("not_done");
		expect(getCompletionState(makeTask({ status: "in_progress" }))).toBe("not_done");
	});
});

// ── getVerificationState ─────────────────────────────

describe("getVerificationState", () => {
	it("verified → verified", () => {
		expect(getVerificationState(makeTask({ status: "verified" }))).toBe("verified");
	});
	it("completed with verification → pending_verification", () => {
		expect(
			getVerificationState(
				makeTask({
					status: "completed",
					verification: { method: "pnpm test", expected: "pass" },
				}),
			),
		).toBe("pending_verification");
	});
	it("completed without verification → no_verification", () => {
		expect(getVerificationState(makeTask({ status: "completed" }))).toBe("no_verification");
	});
	it("pending → no_verification（即使配了 verification 也未进入验证流程）", () => {
		expect(
			getVerificationState(
				makeTask({
					status: "pending",
					verification: { method: "pnpm test", expected: "pass" },
				}),
			),
		).toBe("no_verification");
	});
	it("cancelled → no_verification", () => {
		expect(getVerificationState(makeTask({ status: "cancelled" }))).toBe("no_verification");
	});
});

// ── validateTaskTransition（status 级转换合法性）───────

describe("validateTaskTransition — 合法转换 → null", () => {
	const legal: Array<[string, string]> = [
		["pending", "in_progress"],
		["pending", "cancelled"],
		["in_progress", "completed"],
		["in_progress", "cancelled"],
		["completed", "verified"],
	];
	for (const [from, to] of legal) {
		it(`${from} → ${to} 合法`, () => {
			expect(validateTaskTransition(from as never, to as never)).toBeNull();
		});
	}
});

describe("validateTaskTransition — 非法转换 → 错误消息", () => {
	const illegal: Array<[string, string]> = [
		["pending", "completed"],
		["pending", "verified"],
		["in_progress", "verified"],
		["in_progress", "pending"],
		["completed", "pending"],
		["completed", "in_progress"],
		["completed", "cancelled"],
		["verified", "pending"],
		["verified", "in_progress"],
		["cancelled", "pending"],
		["cancelled", "in_progress"],
	];
	for (const [from, to] of illegal) {
		it(`${from} → ${to} 非法`, () => {
			const err = validateTaskTransition(from as never, to as never);
			expect(err, `${from} → ${to} should be rejected`).not.toBeNull();
			expect(typeof err).toBe("string");
		});
	}
});
```

- [ ] **步骤 3：运行测试确认失败**

运行：`pnpm --filter @zhushanwen/pi-goal test src/engine/__tests__/task.test.ts`
预期：FAIL，`Cannot find module '../task'`

- [ ] **步骤 4：编写 engine/task.ts 实现**

创建 `extensions/goal/src/engine/task.ts`：

```typescript
/**
 * Task 聚合 — 纯状态机 + 双维度投影
 *
 * 零 Pi 依赖（engine 层地基）。
 *
 * 关键约束：validateTaskTransition 只看 status，不看 verification。
 * `completed && !verification` 的全锁逻辑在 service 层（Wave 5）实现。
 */

// ── 状态枚举 ────────────────────────────────────────

export type TaskStatus = "pending" | "in_progress" | "completed" | "verified" | "cancelled";

export type SubtaskStatus = "pending" | "in_progress" | "completed";

export const TASK_STATUSES: readonly TaskStatus[] = [
	"pending",
	"in_progress",
	"completed",
	"verified",
	"cancelled",
] as const;

export const SUBTASK_STATUSES: readonly SubtaskStatus[] = [
	"pending",
	"in_progress",
	"completed",
] as const;

// ── 数据结构 ────────────────────────────────────────

export interface TaskVerification {
	method: string;
	expected: string;
	actual?: string;
}

export interface Subtask {
	id: number;
	text: string;
	status: SubtaskStatus;
	lastUpdatedTurn: number;
}

export interface GoalTask {
	id: number;
	description: string;
	status: TaskStatus;
	evidence?: string;
	verification?: TaskVerification;
	subtasks?: Subtask[];
	lastUpdatedTurn: number;
}

// ── 双维度投影类型 ──────────────────────────────────

export type CompletionState = "not_done" | "done";

export type VerificationState =
	| "no_verification"
	| "pending_verification"
	| "verified";

// ── status 级转换表 ──────────────────────────────────

const LEGAL_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
	pending: ["in_progress", "cancelled"],
	in_progress: ["completed", "cancelled"],
	completed: ["verified"],
	verified: [],
	cancelled: [],
};

const TRANSITION_HINTS: Readonly<Record<TaskStatus, string>> = {
	pending: "allowed: in_progress or cancelled",
	in_progress: "allowed: completed or cancelled",
	completed: "allowed: verified (only if task has verification config)",
	verified: "terminal state, no transitions allowed",
	cancelled: "terminal state, no transitions allowed",
};

// ── 终态判定 ────────────────────────────────────────

export function isTerminalTaskStatus(status: TaskStatus): boolean {
	return status === "verified" || status === "cancelled";
}

// ── 业务语义完成判定 ────────────────────────────────

export function isTaskDone(task: GoalTask): boolean {
	if (task.status === "cancelled") return true;
	if (task.status === "verified") return true;
	if (task.status === "completed" && !task.verification) return true;
	return false;
}

// ── 双维度投影 ──────────────────────────────────────

export function getCompletionState(task: GoalTask): CompletionState {
	if (task.status === "completed" || task.status === "verified" || task.status === "cancelled") {
		return "done";
	}
	return "not_done";
}

export function getVerificationState(task: GoalTask): VerificationState {
	if (task.status === "verified") return "verified";
	if (task.status === "completed" && task.verification) return "pending_verification";
	return "no_verification";
}

// ── 转换合法性校验（纯 status 级）────────────────────

/**
 * 校验 status 级转换合法性。
 * 只看 status，不看 verification。completed→verified 在 status 级合法。
 * `completed && !verification` 全锁由 service 层处理。
 *
 * @returns 错误消息字符串（非法）或 null（合法）
 */
export function validateTaskTransition(from: TaskStatus, to: TaskStatus): string | null {
	const allowed = LEGAL_TRANSITIONS[from];
	if (!allowed || !allowed.includes(to)) {
		const hint = TRANSITION_HINTS[from] ?? "no transitions allowed";
		return `invalid transition ${from} → ${to}. From ${from}, ${hint}`;
	}
	return null;
}

// ── 进度辅助函数（供 service/projection 使用）─────────

/** completed + verified 计数（widget/history 口径） */
export function getCompletedCount(tasks: GoalTask[]): number {
	return tasks.filter((t) => t.status === "completed" || t.status === "verified").length;
}

/** 未完成任务列表（isTaskDone 反向） */
export function getIncompleteTasks(tasks: GoalTask[]): GoalTask[] {
	return tasks.filter((t) => !isTaskDone(t));
}

/** 下一个可用 task id */
export function getNextTaskId(tasks: GoalTask[]): number {
	return tasks.length > 0 ? Math.max(...tasks.map((t) => t.id)) + 1 : 1;
}
```

- [ ] **步骤 5：运行测试确认通过**

运行：`pnpm --filter @zhushanwen/pi-goal test src/engine/__tests__/task.test.ts`
预期：PASS

- [ ] **步骤 6：typecheck + 验证零 Pi 依赖**

```bash
pnpm --filter @zhushanwen/pi-goal typecheck
grep -rn "@mariozechner\|@earendil" extensions/goal/src/engine/
```
预期：typecheck 零错误；grep 无输出。

- [ ] **步骤 7：提交**

```bash
git add extensions/goal/vitest.config.ts extensions/goal/src/engine/task.ts extensions/goal/src/engine/__tests__/task.test.ts
git commit -m "wave-0: add engine/task.ts — task state machine, dual-dimension projection, full tests"
```

---

## 验收标准

### 1. 测试

- [ ] `pnpm --filter @zhushanwen/pi-goal test src/engine/__tests__/task.test.ts` PASS
- [ ] `pnpm --filter @zhushanwen/pi-goal test`（全量）现有 3 个旧测试仍全绿（vitest include 改动未破坏既有发现）

### 2. 架构边界

- [ ] `grep -rn "@mariozechner\|@earendil" extensions/goal/src/engine/` 无输出（engine 零 Pi import）
- [ ] `grep -rn "any\b\|eslint-disable\|as Partial.*as" extensions/goal/src/engine/task.ts` 无输出
- [ ] vitest.config.ts 的 `include` 已改为 `["src/**/*.test.ts"]`

### 3. 接口契约

- [ ] `engine/task.ts` 导出与 plan.md 契约一致：`TaskStatus` / `SubtaskStatus` / `GoalTask` / `Subtask` / `TaskVerification` / `CompletionState` / `VerificationState` / `GOAL_TASK_STATUSES` / `SUBTASK_STATUSES`
- [ ] 导出函数签名一致：`isTerminalTaskStatus(status)` / `isTaskDone(task)` / `getCompletionState(task)` / `getVerificationState(task)` / `validateTaskTransition(from, to): string | null` / `getCompletedCount(tasks)` / `getIncompleteTasks(tasks)` / `getNextTaskId(tasks)`

### 4. 行为契约

- [ ] FR-2.x：5 态 TaskStatus（pending / in_progress / completed / verified / cancelled）全枚举覆盖
- [ ] `validateTaskTransition` 只看 status，不看 verification（completed→verified 不在此守卫）
- [ ] `isTaskDone`：cancelled / verified / (completed && !verification) 返回 true
- [ ] 双维度投影：completed+verification → pending_verification；completed+无 verification → no_verification

### 5. 提交

- [ ] commit message 以 `wave-0:` 开头，描述含「task state machine」+「dual-dimension projection」
