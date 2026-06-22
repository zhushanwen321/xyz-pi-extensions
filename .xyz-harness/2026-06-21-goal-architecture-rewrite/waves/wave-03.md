# Wave 3: ports.ts + persistence.ts

- **目标文件**：
  - 创建：`extensions/goal/src/ports.ts`
  - 创建：`extensions/goal/src/persistence.ts`
  - 改写：`extensions/goal/src/__tests__/deserialize-state.test.ts`
- **前置 wave**：Wave 1（engine/types.ts + engine/task.ts 已存在）
- **目标**：定义 4 个 Port 接口（机器可检查的边界）；实现 serialize/deserialize（FR-5 严格版，移除旧格式兼容，缺字段 throw）+ makeHistoryEntry。

## 关键约束

- ports.ts 只 import 类型 from `./engine/types`（纯类型定义，零运行时依赖）
- persistence.ts import from `./engine/types` + `./engine/task` + `./ports`（仅 GoalHistoryEntry 类型）
- FR-5：`deserializeState` 缺字段直接 throw，不兜底默认值，不迁移旧格式
- 禁止 `any`

---

- [ ] **步骤 1：编写 ports.ts**

创建 `extensions/goal/src/ports.ts`：

```typescript
/**
 * Ports — 能力抽象接口
 *
 * D-22: ports 的核心价值是机器可检查的边界（engine/ 禁止 import Pi），
 * 不是"可替换的 adapter"。service 层通过这些接口访问 Pi 能力，
 * adapter 层提供实现（包装 ctx / pi）。
 */

import type { GoalRuntimeState } from "./engine/types";

// ── GoalHistoryEntry（DTO，非 aggregate，D-09）─────────

export interface GoalHistoryEntry {
	goalId: string;
	objective: string;
	status: string;
	completedTasks: number;
	totalTasks: number;
	elapsedSeconds: number;
	timestamp: number;
}

// ── PersistencePort ──────────────────────────────────

export interface PersistencePort {
	/** 写入 goal-state entry（最新 1 条，GC 由 session 层管） */
	appendState(state: GoalRuntimeState): void;
	/** 写入 goal-history 归档 entry */
	appendHistory(entry: GoalHistoryEntry): void;
}

// ── UiPort ───────────────────────────────────────────

export interface UiPort {
	/** 设置 widget（undefined = 清除）。hasUI=false 时 adapter 跳过（FR-6.6） */
	setWidget(name: string, content: string[] | string | undefined): void;
	/** 设置 status bar */
	setStatus(name: string, text: string | undefined): void;
	/** 弹通知 */
	notify(text: string, level: "info" | "warning" | "error"): void;
	/** 是否有 UI（headless/RPC mode 为 false） */
	readonly hasUI: boolean;
}

// ── MessagingPort ────────────────────────────────────

export interface MessagingPort {
	/** 发送 custom message（goal-context 等） */
	sendContextMessage(content: string, deliverAs: "steer" | "followUp", customType?: string): void;
	/** 发送 user message（触发 AI 开始工作，FR-8.12） */
	sendUserMessage(content: string, deliverAs: "steer" | "followUp"): void;
}

// ── SessionPort ──────────────────────────────────────

export interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface SessionPort {
	getEntries(): SessionEntryLike[];
	spliceEntry(index: number, count: number): void;
	getContextUsage(): { tokens?: number; contextWindow?: number } | null;
	readonly signal: AbortSignal | undefined;
}
```

- [ ] **步骤 2：编写 persistence.ts**

创建 `extensions/goal/src/persistence.ts`：

```typescript
/**
 * 持久化层 — serialize/deserialize + history entry 构造
 *
 * FR-5: 移除旧格式兼容，字段缺失直接 throw。
 * 零 Pi 依赖。
 */

import type { GoalTask, Subtask, SubtaskStatus, TaskStatus, TaskVerification } from "./engine/task";
import type { GoalRuntimeState } from "./engine/types";
import type { GoalHistoryEntry } from "./ports";

// ── 常量 ──────────────────────────────────────────────

export const ENTRY_TYPE = "goal-state";
export const HISTORY_ENTRY_TYPE = "goal-history";

// ── serialize（深拷贝，纯函数）────────────────────────

export function serializeState(state: GoalRuntimeState): GoalRuntimeState {
	return {
		...state,
		tasks: state.tasks.map((t) => ({
			...t,
			subtasks: t.subtasks?.map((s) => ({ ...s })),
		})),
		budget: { ...state.budget },
	};
}

// ── deserialize（FR-5 严格解析，缺字段 throw）──────────

function requireField<T>(data: Record<string, unknown>, key: string): T {
	if (!(key in data) || data[key] === undefined) {
		throw new Error(`Missing required field: ${key}`);
	}
	return data[key] as T;
}

export function deserializeState(data: Record<string, unknown>): GoalRuntimeState {
	// FR-5: 不兜底默认值，缺字段直接 throw
	const tasksRaw = requireField<unknown[]>("tasks" as never) as unknown;
	// 上面的写法绕了弯，重写：
	return deserializeImpl(data);
}

function deserializeImpl(data: Record<string, unknown>): GoalRuntimeState {
	const req = <T>(key: string): T => {
		if (!(key in data) || data[key] === undefined) {
			throw new Error(`Missing required field: ${key}`);
		}
		return data[key] as T;
	};

	const tasksRaw = req<unknown[]>("tasks");
	const tasks: GoalTask[] = tasksRaw.map((tRaw): GoalTask => {
		const t = tRaw as Record<string, unknown>;
		if (!("status" in t)) {
			throw new Error("Legacy goal-state format detected, session reset required");
		}
		const subtasksRaw = t.subtasks as Record<string, unknown>[] | undefined;
		const subtasks: Subtask[] | undefined = Array.isArray(subtasksRaw)
			? subtasksRaw.map((s) => ({
				id: s.id as number,
				text: s.text as string,
				status: s.status as SubtaskStatus,
				lastUpdatedTurn: (s.lastUpdatedTurn as number) ?? 0,
			}))
			: undefined;
		return {
			id: t.id as number,
			description: t.description as string,
			status: t.status as TaskStatus,
			evidence: t.evidence as string | undefined,
			verification: t.verification as TaskVerification | undefined,
			subtasks,
			lastUpdatedTurn: (t.lastUpdatedTurn as number) ?? 0,
		};
	});

	return {
		goalId: req("goalId"),
		objective: req("objective"),
		status: req("status"),
		tasks,
		stallCount: req("stallCount"),
		tokensUsed: req("tokensUsed"),
		timeStartedAt: req("timeStartedAt"),
		timeUsedSeconds: req("timeUsedSeconds"),
		budget: req("budget"),
		lastProgressTurn: req("lastProgressTurn"),
		budgetLimitSteeringSent: req("budgetLimitSteeringSent"),
		objectiveUpdatedAt: req("objectiveUpdatedAt"),
		lastBlockerReason: req("lastBlockerReason"),
		tokenWarning70Sent: req("tokenWarning70Sent"),
		tokenWarning90Sent: req("tokenWarning90Sent"),
		timeWarning70Sent: req("timeWarning70Sent"),
		timeWarning90Sent: req("timeWarning90Sent"),
		lastTurnTokensUsed: req("lastTurnTokensUsed"),
		currentTurnIndex: req("currentTurnIndex"),
		completedAtTurnIndex: data.completedAtTurnIndex as number | undefined,
	};
}
```

> **注意**：上面的 `deserializeState` 入口函数有一层多余的包装（先 throw 再调 impl）。实现时应直接用 `deserializeImpl` 的逻辑作为 `deserializeState` 的函数体，删除中间层。最终版应该是一个干净的函数。

- [ ] **步骤 3：简化 persistence.ts 的 deserializeState**

上面步骤 2 的实现有冗余包装。最终 `persistence.ts` 中 `deserializeState` 应直接是 `deserializeImpl` 的内容（内联 `req` helper）。执行时请合并为一个干净的函数，不要有中间调用层。

- [ ] **步骤 4：编写 makeHistoryEntry**

在 `persistence.ts` 末尾添加：

```typescript
/** 从 state 构造 GoalHistoryEntry（纯函数） */
export function makeHistoryEntry(state: GoalRuntimeState, completedTasks: number): GoalHistoryEntry {
	return {
		goalId: state.goalId,
		objective: state.objective,
		status: state.status,
		completedTasks,
		totalTasks: state.tasks.length,
		elapsedSeconds: Math.floor(state.timeUsedSeconds),
		timestamp: Date.now(),
	};
}
```

- [ ] **步骤 5：改写 deserialize-state.test.ts**

改写 `extensions/goal/src/__tests__/deserialize-state.test.ts`（替换全部内容）：

```typescript
/**
 * FR-5/FR-7.3: deserializeState — 新格式严格解析（字段缺失 throw）
 */
import { describe, expect, it } from "vitest";

import { deserializeState } from "../persistence";

const FULL_DATA = {
	goalId: "g1",
	objective: "test",
	status: "active",
	tasks: [{
		id: 1,
		description: "task 1",
		status: "completed",
		lastUpdatedTurn: 5,
		verification: { method: "pnpm test", expected: "all pass", actual: "passed" },
	}],
	stallCount: 0,
	tokensUsed: 0,
	timeStartedAt: 1000,
	timeUsedSeconds: 0,
	budget: { maxStallTurns: 5, maxTurns: 50 },
	lastProgressTurn: 0,
	budgetLimitSteeringSent: false,
	objectiveUpdatedAt: 1000,
	lastBlockerReason: null,
	tokenWarning70Sent: false,
	tokenWarning90Sent: false,
	timeWarning70Sent: false,
	timeWarning90Sent: false,
	lastTurnTokensUsed: 0,
	currentTurnIndex: 0,
};

describe("deserializeState — 新格式严格解析", () => {
	it("完整新格式数据 → 正确还原", () => {
		const state = deserializeState(FULL_DATA);
		expect(state.tasks[0]!.verification).toEqual({
			method: "pnpm test", expected: "all pass", actual: "passed",
		});
		expect(state.tokenWarning70Sent).toBe(false);
	});

	it("task 缺 status 字段 → throw（FR-5）", () => {
		const data = { ...FULL_DATA, tasks: [{ id: 1, description: "t1", lastUpdatedTurn: 0 }] };
		expect(() => deserializeState(data)).toThrow();
	});

	it("顶层缺 budget → throw（不再兜底默认值）", () => {
		const data = { goalId: "g1", objective: "test", status: "active", tasks: [] };
		expect(() => deserializeState(data)).toThrow();
	});

	it("缺 tokenWarning70Sent → throw（新格式必须包含 4 个独立 flag）", () => {
		const data = { ...FULL_DATA };
		delete (data as Record<string, unknown>).tokenWarning70Sent;
		expect(() => deserializeState(data)).toThrow();
	});

	it("subtasks 新格式正确解析", () => {
		const data = {
			...FULL_DATA,
			tasks: [{
				id: 1, description: "t1", status: "in_progress", lastUpdatedTurn: 0,
				subtasks: [{ id: 1, text: "sub", status: "pending", lastUpdatedTurn: 0 }],
			}],
		};
		const state = deserializeState(data);
		expect(state.tasks[0]!.subtasks).toHaveLength(1);
		expect(state.tasks[0]!.subtasks![0]!.status).toBe("pending");
	});

	it("completedAtTurnIndex 可选（缺失 → undefined）", () => {
		const state = deserializeState(FULL_DATA);
		expect(state.completedAtTurnIndex).toBeUndefined();
	});

	it("有 completedAtTurnIndex → 正确还原", () => {
		const data = { ...FULL_DATA, completedAtTurnIndex: 42 };
		expect(deserializeState(data).completedAtTurnIndex).toBe(42);
	});
});
```

> **注意**：改写后此测试 import 从 `../state` 改为 `../persistence`。但此时 `../state` 仍然存在（旧文件），所以旧测试的 import 不会断——新测试只是指向新模块。**大爆炸原则**：不删旧文件，新测试独立存在。但 vitest include 现在是 `src/**/*.test.ts`，所以 `src/__tests__/deserialize-state.test.ts` 会被发现并跑（它 import `../persistence`，该文件已在本 wave 创建）。

- [ ] **步骤 6：typecheck**

运行：`pnpm --filter @zhushanwen/pi-goal typecheck`
预期：零错误。

- [ ] **步骤 7：运行 deserialize 测试**

运行：`pnpm --filter @zhushanwen/pi-goal test src/__tests__/deserialize-state.test.ts`
预期：PASS

- [ ] **步骤 8：提交**

```bash
git add extensions/goal/src/ports.ts extensions/goal/src/persistence.ts extensions/goal/src/__tests__/deserialize-state.test.ts
git commit -m "wave-3: add ports.ts (4 Port interfaces) + persistence.ts (strict deserialize FR-5, no legacy compat)"
```
