# Wave 1: engine/types.ts + engine/goal.ts

- **目标文件**：
  - 创建：`extensions/goal/src/engine/types.ts`
  - 创建：`extensions/goal/src/engine/goal.ts`
  - 测试：`extensions/goal/src/engine/__tests__/goal.test.ts`
- **前置 wave**：Wave 0（engine/task.ts 已存在）
- **目标**：建立 Goal 聚合类型与状态机。`types.ts` 定义 `GoalRuntimeState`（含 4 个独立预警 flag，修复 FR-6.2）+ `BudgetConfig` + `DEFAULT_BUDGET`；`goal.ts` 实现状态机函数 + `createGoalState`。

## 关键约束

- engine/ 零 Pi import；types.ts 只 import `./task`；goal.ts 只 import `./types`
- FR-6.2：`GoalRuntimeState` 必须有 4 个独立预警 flag（tokenWarning70Sent/tokenWarning90Sent/timeWarning70Sent/timeWarning90Sent），不用旧的共享 flag
- `transitionStatus` 保持宽松（G-016）：仅守卫终态不可覆盖

---

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/goal/src/engine/__tests__/goal.test.ts`：

```typescript
/**
 * engine/goal.ts 测试 — Goal 7 态状态机 + createGoalState
 */
import { describe, expect, it } from "vitest";

import {
	createGoalState,
	isActiveStatus,
	isTerminalStatus,
	transitionStatus,
} from "../goal";
import type { GoalStatus } from "../types";

const TERMINAL: GoalStatus[] = ["complete", "budget_limited", "time_limited", "cancelled"];
const NON_TERMINAL: GoalStatus[] = ["active", "paused", "blocked"];
const ALL = [...NON_TERMINAL, ...TERMINAL];

// ── isTerminalStatus / isActiveStatus ─────────────────

describe("isTerminalStatus", () => {
	for (const s of TERMINAL) {
		it(`${s} → terminal`, () => expect(isTerminalStatus(s)).toBe(true));
	}
	for (const s of NON_TERMINAL) {
		it(`${s} → NOT terminal`, () => expect(isTerminalStatus(s)).toBe(false));
	}
});

describe("isActiveStatus", () => {
	it("active → true", () => expect(isActiveStatus("active")).toBe(true));
	for (const s of ALL) {
		if (s === "active") continue;
		it(`${s} → false`, () => expect(isActiveStatus(s)).toBe(false));
	}
});

// ── transitionStatus（终态守卫，宽松）──────────────────

describe("transitionStatus — 终态不可覆盖", () => {
	for (const terminal of TERMINAL) {
		for (const target of ALL) {
			it(`terminal ${terminal} → ${target} 保持 ${terminal}`, () => {
				expect(transitionStatus(terminal, target)).toBe(terminal);
			});
		}
	}
});

describe("transitionStatus — 非终态可被任意覆盖", () => {
	for (const current of NON_TERMINAL) {
		for (const target of ALL) {
			it(`${current} → ${target} 返回 ${target}`, () => {
				expect(transitionStatus(current, target)).toBe(target);
			});
		}
	}
});

// ── createGoalState 初始值 ───────────────────────────

describe("createGoalState — 初始值", () => {
	it("status = active", () => expect(createGoalState("obj").status).toBe("active"));
	it("objective 透传", () => expect(createGoalState("my obj").objective).toBe("my obj"));
	it("tasks 为空数组", () => expect(createGoalState("obj").tasks).toEqual([]));
	it("stallCount = 0", () => expect(createGoalState("obj").stallCount).toBe(0));
	it("tokensUsed = 0", () => expect(createGoalState("obj").tokensUsed).toBe(0));
	it("timeUsedSeconds = 0", () => expect(createGoalState("obj").timeUsedSeconds).toBe(0));
	it("goalId 非空", () => {
		expect(createGoalState("obj").goalId).toBeTruthy();
		expect(typeof createGoalState("obj").goalId).toBe("string");
	});
	it("两个 createGoalState 生成不同 goalId", () => {
		expect(createGoalState("obj").goalId).not.toBe(createGoalState("obj").goalId);
	});
	it("currentTurnIndex = 0", () => expect(createGoalState("obj").currentTurnIndex).toBe(0));
	it("completedAtTurnIndex = undefined", () => {
		expect(createGoalState("obj").completedAtTurnIndex).toBeUndefined();
	});
	// FR-6.2: 4 个独立预警 flag
	it("tokenWarning70Sent = false", () => expect(createGoalState("obj").tokenWarning70Sent).toBe(false));
	it("tokenWarning90Sent = false", () => expect(createGoalState("obj").tokenWarning90Sent).toBe(false));
	it("timeWarning70Sent = false", () => expect(createGoalState("obj").timeWarning70Sent).toBe(false));
	it("timeWarning90Sent = false", () => expect(createGoalState("obj").timeWarning90Sent).toBe(false));
});

describe("createGoalState — budget 合并", () => {
	it("无 overrides 用 DEFAULT_BUDGET", () => {
		const s = createGoalState("obj");
		expect(s.budget).toEqual({ maxStallTurns: 5, maxTurns: 50 });
	});
	it("tokenBudget override", () => {
		expect(createGoalState("obj", { tokenBudget: 10000 }).budget.tokenBudget).toBe(10000);
	});
	it("maxTurns override", () => {
		expect(createGoalState("obj", { maxTurns: 100 }).budget.maxTurns).toBe(100);
	});
	it("多字段 override", () => {
		const s = createGoalState("obj", { tokenBudget: 5000, maxStallTurns: 3 });
		expect(s.budget.tokenBudget).toBe(5000);
		expect(s.budget.maxStallTurns).toBe(3);
		expect(s.budget.maxTurns).toBe(50);
	});
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @zhushanwen/pi-goal test src/engine/__tests__/goal.test.ts`
预期：FAIL，`Cannot find module '../goal'`

- [ ] **步骤 3：编写 engine/types.ts**

创建 `extensions/goal/src/engine/types.ts`：

```typescript
/**
 * Goal 运行时组合状态类型 — engine 层共享类型定义
 *
 * 零 Pi 依赖。仅 import GoalTask from "./task"。
 *
 * FR-6.2 修复：预警 flag 按 token/time 维度独立（4 个独立 flag），
 * 取代旧版 budgetWarning70Sent/budgetWarning90Sent 共享 flag。
 */

import type { GoalTask } from "./task";

// ── Goal 状态枚举 ────────────────────────────────────

export type GoalStatus =
	| "active"
	| "paused"
	| "blocked"
	| "complete"
	| "budget_limited"
	| "time_limited"
	| "cancelled";

export const TERMINAL_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
	"complete",
	"budget_limited",
	"time_limited",
	"cancelled",
]);

// ── 预算配置 ────────────────────────────────────────

export interface BudgetConfig {
	tokenBudget?: number;
	timeBudgetMinutes?: number;
	maxStallTurns: number;
	maxTurns: number;
}

export const DEFAULT_BUDGET: BudgetConfig = {
	maxStallTurns: 5,
	maxTurns: 50,
};

// ── 运行时状态（也是持久化格式）─────────────────────

export interface GoalRuntimeState {
	goalId: string;
	objective: string;
	status: GoalStatus;
	tasks: GoalTask[];
	stallCount: number;
	tokensUsed: number;
	timeStartedAt: number;
	timeUsedSeconds: number;
	budget: BudgetConfig;
	lastProgressTurn: number;
	budgetLimitSteeringSent: boolean;
	objectiveUpdatedAt: number;
	lastBlockerReason: string | null;
	// FR-6.2: 4 个独立预警 flag
	tokenWarning70Sent: boolean;
	tokenWarning90Sent: boolean;
	timeWarning70Sent: boolean;
	timeWarning90Sent: boolean;
	lastTurnTokensUsed: number;
	currentTurnIndex: number;
	completedAtTurnIndex?: number;
}
```

- [ ] **步骤 4：编写 engine/goal.ts**

创建 `extensions/goal/src/engine/goal.ts`：

```typescript
/**
 * Goal 聚合状态机 — 纯函数
 *
 * 零 Pi 依赖。import from "./types"。
 */

import type { BudgetConfig, GoalRuntimeState, GoalStatus } from "./types";
import { DEFAULT_BUDGET, TERMINAL_GOAL_STATUSES } from "./types";

export function isTerminalStatus(status: GoalStatus): boolean {
	return TERMINAL_GOAL_STATUSES.has(status);
}

export function isActiveStatus(status: GoalStatus): boolean {
	return status === "active";
}

/**
 * 安全的状态转换。终态不可被覆盖（G-016 保持宽松）。
 */
export function transitionStatus(current: GoalStatus, next: GoalStatus): GoalStatus {
	if (TERMINAL_GOAL_STATUSES.has(current)) return current;
	return next;
}

/**
 * 创建初始 GoalRuntimeState。纯数据构造，无副作用。
 */
export function createGoalState(
	objective: string,
	budgetOverrides?: Partial<BudgetConfig>,
): GoalRuntimeState {
	const now = Date.now();
	return {
		goalId: crypto.randomUUID(),
		objective,
		status: "active",
		tasks: [],
		stallCount: 0,
		tokensUsed: 0,
		timeStartedAt: now,
		timeUsedSeconds: 0,
		budget: { ...DEFAULT_BUDGET, ...budgetOverrides },
		lastProgressTurn: 0,
		budgetLimitSteeringSent: false,
		objectiveUpdatedAt: now,
		lastBlockerReason: null,
		tokenWarning70Sent: false,
		tokenWarning90Sent: false,
		timeWarning70Sent: false,
		timeWarning90Sent: false,
		lastTurnTokensUsed: 0,
		currentTurnIndex: 0,
	};
}
```

- [ ] **步骤 5：运行测试确认通过**

运行：`pnpm --filter @zhushanwen/pi-goal test src/engine/__tests__/goal.test.ts`
预期：PASS

- [ ] **步骤 6：typecheck + 验证零 Pi 依赖**

```bash
pnpm --filter @zhushanwen/pi-goal typecheck
grep -rn "@mariozechner\|@earendil" extensions/goal/src/engine/
grep -rn "budgetWarning70Sent\|budgetWarning90Sent" extensions/goal/src/engine/
```
预期：typecheck 零错误；两个 grep 无输出（无 Pi import，无旧版共享 flag）。

- [ ] **步骤 7：提交**

```bash
git add extensions/goal/src/engine/types.ts extensions/goal/src/engine/goal.ts extensions/goal/src/engine/__tests__/goal.test.ts
git commit -m "wave-1: add engine/types.ts + engine/goal.ts — GoalRuntimeState with 4 independent warning flags (FR-6.2)"
```

---

## 验收标准

### 1. 测试

- [ ] `pnpm --filter @zhushanwen/pi-goal test src/engine/__tests__/goal.test.ts` PASS
- [ ] 全量 `test` 仍全绿（不破坏 Wave 0 的 task.test.ts）

### 2. 架构边界

- [ ] `grep -rn "@mariozechner\|@earendil" extensions/goal/src/engine/` 无输出
- [ ] `grep -rn "budgetWarning70Sent\|budgetWarning90Sent" extensions/goal/src/engine/` 无输出（旧版共享 flag 已消除）
- [ ] types.ts 只 import `./task`；goal.ts 只 import `./types`（无跨层 import）

### 3. 接口契约

- [ ] `engine/types.ts` 导出：`GoalStatus` / `GoalRuntimeState`（含 4 个独立预警 flag + `completedAtTurnIndex?`）/ `BudgetConfig` / `DEFAULT_BUDGET`
- [ ] `engine/goal.ts` 导出：`transitionStatus(current, target)` / `isTerminalStatus(status)` / `isActiveStatus(status)` / `createGoalState(objective, budgetOverrides?)`

### 4. 行为契约

- [ ] FR-6.2：4 个独立预警 flag（tokenWarning70Sent / tokenWarning90Sent / timeWarning70Sent / timeWarning90Sent），非旧版共享 budgetWarning70Sent/budgetWarning90Sent
- [ ] G-016：`transitionStatus` 仅守卫终态不可覆盖（终态→任意 保持终态；非终态→任意 允许覆盖）
- [ ] `createGoalState` 初始值：status=active, tasks=[], stallCount=0, tokensUsed=0, timeUsedSeconds=0, currentTurnIndex=0, 4 个 flag 全 false, goalId 唯一非空

### 5. 提交

- [ ] commit message 以 `wave-1:` 开头，含「4 independent warning flags」+「FR-6.2」
