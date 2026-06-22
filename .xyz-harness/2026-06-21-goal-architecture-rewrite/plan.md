# Goal 扩展架构重写 实现计划

> **给 agentic worker：** 必备子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 来逐任务执行此计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 将 `extensions/goal`（~3300 行、12 源文件）重构为 engine/ports/adapters/projection 四层架构，对外保持契约，对内建立机器可检查的边界（engine 零 Pi 依赖），并修复已知架构性 bug（widget 实时刷新、token/time 预警维度独立、ESC 纯打断、hasPendingInjection 僵尸字段）。

**架构：** engine 层放纯状态机 + 决策（goal/task/budget 三文件，零 Pi import）；ports.ts 定义四个能力抽象作为边界载体；service.ts 双入口（applyToolAction / applyEvent）协调 engine 纯函数；adapters 层三个适配器各自处理 persist/widget/sendMessage 的差异；projection 层收敛 budget 格式化重复。命令/事件两类输入不合并为单一 applyCommand——它们在触发方/返回值/并发模型/persist 方式上全不同，engine 纯函数才是真正共享层。

**技术栈：** TypeScript（Pi 运行时执行）、`@mariozechner/pi-coding-agent`（Extension API）、typebox（schema）、vitest（测试，禁止 node:test）

**spec：** `.xyz-harness/2026-06-21-goal-architecture-rewrite/spec.md`

---

## 全局约束（每个任务都必须遵守）

1. **engine/ 零 Pi import**：`engine/*.ts` 只能 import typebox 和自身。lint 规则 `grep -rn "@mariozechner\|@earendil" extensions/goal/src/engine/` 必须无输出。
2. **禁止 `any`**：用 `unknown` 或具体类型。
3. **禁止 `eslint-disable`**：直接修问题。
4. **测试不 import Pi SDK**：engine 层测试通过纯函数调用，不依赖 stub。
5. **行为等价**：除 spec 标注的架构必须变更（FR-5 序列化清断、FR-6.7 ESC 纯打断、FR-6.2 预警维度独立、FR-6.1 widget 刷新、FR-6.4 删 hasPendingInjection、FR-6.5 tick 剥离、FR-6.6 headless 守卫），其余行为严格保持。FR-8 全部子章节是契约清单。
6. **每步都跑测试**：`pnpm --filter @zhushanwen/pi-goal test`。
7. **提交信息英文**，正文可中文。

## 文件结构（最终状态）

```
extensions/goal/src/
  engine/                    ← 零 Pi 依赖，纯状态机 + 决策
    goal.ts                  Goal aggregate: GoalStatus 7 态 + transitionStatus + finalizeGoal(纯) + createGoal(纯)
    task.ts                  Task aggregate: TaskStatus 5 态 + validateTransition + 双维度投影 + isTaskDone
    budget.ts                Budget: Resource/Boundary 拆 + checkBudget(纯) + tick(纯) + token 累加算法(纯)
  ports.ts                   PersistencePort / UiPort / MessagingPort / SessionPort 抽象接口
  session.ts                 GoalSession 运行时句柄 + reconstructGoalState + entry GC
  persistence.ts             serialize/deserialize(新格式严格) + appendHistory/queryHistory + GoalHistoryEntry 类型
  service.ts                 applyToolAction / applyEvent 双入口，调 engine 纯函数
  adapters/
    tool-adapter.ts          executeGoalAction 分发 + persist + 返回 ToolResult + ACTION_HANDLERS Record
    command-adapter.ts       /goal 命令解析 + 8 个 handler
    event-adapter.ts         6 个事件 handler + 并发保护(isProcessing/snapshot/stale-check/signal.aborted)
    actions.ts               10 个 action handler（薄封装，调 service.applyToolAction）
  projection/
    widget.ts                renderStatusLine/renderWidgetLines/renderTerminalStatusLine + hasUI 守卫
    prompts.ts               continuation/budgetLimit/objectiveUpdated/contextInjection/stalenessReminder
    result.ts                makeGoalResult/errorResult + budget 格式化收敛
  index.ts                   工厂：注册 tool/command/events + __goalInit
  constants.ts               (不变)
  commands.ts                (不变，parseGoalArgs)
```

**删除的文件：** `tool-handler.ts`（职责拆到 tool-adapter + persistence + session + projection/result）、`state.ts`（拆到 engine/goal + engine/task + engine/budget + session + persistence）、`budget.ts`（移入 engine/budget）、`widget.ts`（移入 projection/widget）、`templates.ts`（移入 projection/prompts）、`action-handlers.ts`（拆到 adapters/actions + engine/task 的 validate）、`command-handler.ts`（移入 adapters/command-adapter）、`agent-end-handler.ts`（移入 adapters/event-adapter）、`before-agent-start-handler.ts`（移入 adapters/event-adapter）。

---

## 任务 1: engine/goal.ts — Goal 状态机（纯函数）

**文件：**
- 创建：`extensions/goal/src/engine/goal.ts`
- 测试：`extensions/goal/src/engine/__tests__/goal.test.ts`

**目标：** 把 `state.ts` 中的 GoalStatus / TERMINAL_STATUSES / transitionStatus / isTerminalStatus / isActiveStatus / createInitialState 提取为纯函数，零 Pi import。

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/goal/src/engine/__tests__/goal.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import {
	createGoalState,
	type GoalRuntimeState,
	isActiveStatus,
	isTerminalStatus,
	transitionStatus,
} from "../goal";

describe("transitionStatus — 终态守卫", () => {
	it("终态 → 任意状态，保持终态不变", () => {
		for (const terminal of ["complete", "budget_limited", "time_limited", "cancelled"] as const) {
			expect(transitionStatus(terminal, "active")).toBe(terminal);
			expect(transitionStatus(terminal, "paused")).toBe(terminal);
		}
	});
	it("active → paused（可逆中间态）", () => {
		expect(transitionStatus("active", "paused")).toBe("paused");
	});
	it("active → blocked（可逆中间态）", () => {
		expect(transitionStatus("active", "blocked")).toBe("blocked");
	});
	it("paused → active（恢复）", () => {
		expect(transitionStatus("paused", "active")).toBe("active");
	});
	it("blocked → active（恢复）", () => {
		expect(transitionStatus("blocked", "active")).toBe("active");
	});
});

describe("isTerminalStatus", () => {
	it("complete/budget_limited/time_limited/cancelled 是终态", () => {
		expect(isTerminalStatus("complete")).toBe(true);
		expect(isTerminalStatus("budget_limited")).toBe(true);
		expect(isTerminalStatus("time_limited")).toBe(true);
		expect(isTerminalStatus("cancelled")).toBe(true);
	});
	it("active/paused/blocked 不是终态", () => {
		expect(isTerminalStatus("active")).toBe(false);
		expect(isTerminalStatus("paused")).toBe(false);
		expect(isTerminalStatus("blocked")).toBe(false);
	});
});

describe("isActiveStatus", () => {
	it("只有 active 返回 true", () => {
		expect(isActiveStatus("active")).toBe(true);
		expect(isActiveStatus("paused")).toBe(false);
		expect(isActiveStatus("blocked")).toBe(false);
	});
});

describe("createGoalState — 初始状态", () => {
	it("默认 budget 为 maxStallTurns=5, maxTurns=50", () => {
		const s = createGoalState("test objective");
		expect(s.objective).toBe("test objective");
		expect(s.status).toBe("active");
		expect(s.tasks).toEqual([]);
		expect(s.budget.maxStallTurns).toBe(5);
		expect(s.budget.maxTurns).toBe(50);
		expect(s.stallCount).toBe(0);
		expect(s.tokensUsed).toBe(0);
		expect(s.goalId).toBeTruthy();
	});
	it("budget 覆盖生效", () => {
		const s = createGoalState("obj", { maxTurns: 100, tokenBudget: 50000 });
		expect(s.budget.maxTurns).toBe(100);
		expect(s.budget.tokenBudget).toBe(50000);
	});
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @zhushanwen/pi-goal test src/engine/__tests__/goal.test.ts`
预期：FAIL，提示 `Cannot find module '../goal'`

- [ ] **步骤 3：编写 engine/goal.ts 实现**

创建 `extensions/goal/src/engine/goal.ts`：

```typescript
/**
 * Goal aggregate — 纯状态机 + 初始状态构造
 * 零 Pi 依赖（只 import typebox 用于类型）。
 */

// ── 类型 ──────────────────────────────────────────────

export type GoalStatus =
	| "active"
	| "paused"
	| "blocked"
	| "complete"
	| "budget_limited"
	| "time_limited"
	| "cancelled";

const TERMINAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
	"complete",
	"budget_limited",
	"time_limited",
	"cancelled",
]);

// ── BudgetConfig（engine 层定义，零 Pi 依赖）──────────

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

// ── GoalRuntimeState（持久化 + 运行时统一格式）─────────
// 注意：tasks 字段类型由 engine/task.ts 定义，此处用 import 引入。
// 为避免循环依赖，Task 类型在 task.ts 定义，这里 import type。

import type { GoalTask } from "./task";

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
	// FR-6.2: token/time 预警维度独立（4 个 flag 替代原 2 个）
	tokenWarning70Sent: boolean;
	tokenWarning90Sent: boolean;
	timeWarning70Sent: boolean;
	timeWarning90Sent: boolean;
	lastTurnTokensUsed: number;
	currentTurnIndex: number;
	completedAtTurnIndex?: number;
}

// ── 状态机转换（纯函数）──────────────────────────────

export function transitionStatus(current: GoalStatus, next: GoalStatus): GoalStatus {
	if (TERMINAL_STATUSES.has(current)) return current;
	return next;
}

export function isTerminalStatus(status: GoalStatus): boolean {
	return TERMINAL_STATUSES.has(status);
}

export function isActiveStatus(status: GoalStatus): boolean {
	return status === "active";
}

// ── 初始状态构造（纯函数）────────────────────────────

export function createGoalState(
	objective: string,
	budgetOverrides: Partial<BudgetConfig> = {},
): GoalRuntimeState {
	return {
		goalId: crypto.randomUUID(),
		objective,
		status: "active",
		tasks: [],
		stallCount: 0,
		tokensUsed: 0,
		timeStartedAt: Date.now(),
		timeUsedSeconds: 0,
		budget: { ...DEFAULT_BUDGET, ...budgetOverrides },
		lastProgressTurn: 0,
		budgetLimitSteeringSent: false,
		objectiveUpdatedAt: Date.now(),
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

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm --filter @zhushanwen/pi-goal test src/engine/__tests__/goal.test.ts`
预期：PASS（全部 4 个 describe 通过）

- [ ] **步骤 5：提交**

```bash
git add extensions/goal/src/engine/goal.ts extensions/goal/src/engine/__tests__/goal.test.ts
git commit -m "feat(goal): add engine/goal.ts — pure state machine + createGoalState"
```

---

## 任务 2: engine/task.ts — Task 状态机 + 双维度投影

**文件：**
- 创建：`extensions/goal/src/engine/task.ts`
- 测试：`extensions/goal/src/engine/__tests__/task.test.ts`

**目标：** TaskStatus 5 态 + SubtaskStatus 3 态 + isTaskDone + 双维度投影函数（getCompletionState / getVerificationState）+ validateTaskTransition（原 validateUpdateTasks 的纯校验部分）。零 Pi import。

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/goal/src/engine/__tests__/task.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import {
	type GoalTask,
	getCompletionState,
	getVerificationState,
	isTerminalTaskStatus,
	isTaskDone,
	validateTaskTransition,
} from "../task";

const makeTask = (overrides: Partial<GoalTask> = {}): GoalTask => ({
	id: 1,
	description: "test",
	status: "pending",
	lastUpdatedTurn: 0,
	...overrides,
});

describe("isTaskDone — 业务语义完成判定", () => {
	it("verified → done", () => {
		expect(isTaskDone(makeTask({ status: "verified" }))).toBe(true);
	});
	it("cancelled → done", () => {
		expect(isTaskDone(makeTask({ status: "cancelled" }))).toBe(true);
	});
	it("completed 无 verification → done", () => {
		expect(isTaskDone(makeTask({ status: "completed" }))).toBe(true);
	});
	it("completed 有 verification → NOT done", () => {
		expect(isTaskDone(makeTask({
			status: "completed",
			verification: { method: "pnpm test", expected: "pass" },
		}))).toBe(false);
	});
	it("pending/in_progress → NOT done", () => {
		expect(isTaskDone(makeTask({ status: "pending" }))).toBe(false);
		expect(isTaskDone(makeTask({ status: "in_progress" }))).toBe(false);
	});
});

describe("getCompletionState — 完成维度投影", () => {
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

describe("getVerificationState — 验证维度投影", () => {
	it("verified → verified（终态）", () => {
		expect(getVerificationState(makeTask({ status: "verified" }))).toBe("verified");
	});
	it("completed 有 verification → pending_verification", () => {
		expect(getVerificationState(makeTask({
			status: "completed",
			verification: { method: "x", expected: "y" },
		}))).toBe("pending_verification");
	});
	it("completed 无 verification → no_verification", () => {
		expect(getVerificationState(makeTask({ status: "completed" }))).toBe("no_verification");
	});
	it("pending/in_progress/cancelled → no_verification", () => {
		expect(getVerificationState(makeTask({ status: "pending" }))).toBe("no_verification");
		expect(getVerificationState(makeTask({ status: "cancelled" }))).toBe("no_verification");
	});
});

describe("isTerminalTaskStatus", () => {
	it("verified/cancelled 是终态", () => {
		expect(isTerminalTaskStatus("verified")).toBe(true);
		expect(isTerminalTaskStatus("cancelled")).toBe(true);
	});
	it("completed 不是终态（有 verification 时需转 verified）", () => {
		expect(isTerminalTaskStatus("completed")).toBe(false);
	});
});

describe("validateTaskTransition — 合法转换", () => {
	it("pending → in_progress ✓", () => {
		expect(validateTaskTransition("pending", "in_progress")).toBeNull();
	});
	it("pending → cancelled ✓", () => {
		expect(validateTaskTransition("pending", "cancelled")).toBeNull();
	});
	it("in_progress → completed ✓", () => {
		expect(validateTaskTransition("in_progress", "completed")).toBeNull();
	});
	it("in_progress → cancelled ✓", () => {
		expect(validateTaskTransition("in_progress", "cancelled")).toBeNull();
	});
	it("completed → verified ✓", () => {
		expect(validateTaskTransition("completed", "verified")).toBeNull();
	});
});

describe("validateTaskTransition — 非法转换", () => {
	it("pending → completed（应先 in_progress）", () => {
		expect(validateTaskTransition("pending", "completed")).not.toBeNull();
	});
	it("in_progress → verified（不能跳过 completed）", () => {
		expect(validateTaskTransition("in_progress", "verified")).not.toBeNull();
	});
	it("verified → 任意（终态）", () => {
		expect(validateTaskTransition("verified", "in_progress")).not.toBeNull();
	});
	it("cancelled → 任意（终态）", () => {
		expect(validateTaskTransition("cancelled", "in_progress")).not.toBeNull();
	});
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @zhushanwen/pi-goal test src/engine/__tests__/task.test.ts`
预期：FAIL，`Cannot find module '../task'`

- [ ] **步骤 3：编写 engine/task.ts 实现**

创建 `extensions/goal/src/engine/task.ts`：

```typescript
/**
 * Task aggregate — 纯状态机 + 双维度投影 + 转换校验
 * 零 Pi 依赖。
 */

export type TaskStatus = "pending" | "in_progress" | "completed" | "verified" | "cancelled";
export type SubtaskStatus = "pending" | "in_progress" | "completed";

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

// ── 终态判定 ─────────────────────────────────────────

export function isTerminalTaskStatus(status: TaskStatus): boolean {
	return status === "verified" || status === "cancelled";
}

// ── 业务语义完成判定（双维度合一的便捷函数）──────────

export function isTaskDone(task: GoalTask): boolean {
	if (task.status === "cancelled") return true;
	if (task.status === "verified") return true;
	if (task.status === "completed" && !task.verification) return true;
	return false;
}

// ── 双维度投影（FR-1.2，D-08）────────────────────────

export type CompletionState = "not_done" | "done";
export type VerificationState = "no_verification" | "pending_verification" | "verified";

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

// ── 转换合法性校验（纯函数，返回错误消息或 null）──────

const VALID_TRANSITIONS: Record<string, Set<string>> = {
	pending: new Set(["in_progress", "cancelled"]),
	in_progress: new Set(["completed", "cancelled"]),
	completed: new Set(["verified"]),
};

const TRANSITION_HINTS: Record<string, string> = {
	pending: "allowed: in_progress or cancelled",
	in_progress: "allowed: completed or cancelled",
	completed: "allowed: verified (only if task has verification config)",
};

/** 校验状态转换合法性。返回错误消息（字符串）或 null（合法）。 */
export function validateTaskTransition(from: TaskStatus, to: TaskStatus): string | null {
	// 终态不可变
	if (from === "verified" || from === "cancelled") {
		return `Task in terminal state (${from}), cannot be changed`;
	}
	// completed 无 verification：不可变（FR-8.3 G-017 全锁）
	// 注意：此函数只看 status，不知道 task 有无 verification。
	// completed 的全锁逻辑在 service 层（需要 task.verification 信息）。
	const allowed = VALID_TRANSITIONS[from];
	if (!allowed || !allowed.has(to)) {
		return `invalid transition ${from} → ${to}. From ${from}, ${TRANSITION_HINTS[from] ?? "no transitions allowed"}`;
	}
	return null;
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm --filter @zhushanwen/pi-goal test src/engine/__tests__/task.test.ts`
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add extensions/goal/src/engine/task.ts extensions/goal/src/engine/__tests__/task.test.ts
git commit -m "feat(goal): add engine/task.ts — task state machine + dual-dimension projection"
```

---

## 任务 3: engine/budget.ts — Budget 决策 + tick + token 累加

**文件：**
- 创建：`extensions/goal/src/engine/budget.ts`
- 测试：`extensions/goal/src/engine/__tests__/budget.test.ts`

**目标：** 把 `budget.ts`（当前依赖 state.ts）重构为纯 engine 函数。包含：Resource/Boundary 类型拆分、checkBudgetOnTurnEnd / checkBudgetOnResume（纯计算）、tick（时间累计，FR-6.5）、token 累加算法（FR-8.6 message_end）。修复 FR-6.2 维度独立预警。

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/goal/src/engine/__tests__/budget.test.ts`（因篇幅，测试覆盖关键场景）：

```typescript
import { describe, expect, it } from "vitest";
import {
	accumulateTokens,
	checkBudgetOnTurnEnd,
	checkBudgetOnResume,
	tick,
	type GoalRuntimeState,
} from "../budget";
import { createGoalState } from "../goal";

const makeState = (overrides: Partial<GoalRuntimeState> = {}): GoalRuntimeState => ({
	...createGoalState("test"),
	...overrides,
});

describe("accumulateTokens — FR-8.6 message_end token 累加算法", () => {
	it("input>0 或 output>0：tokensUsed += max(input-cacheRead,0) + output", () => {
		expect(accumulateTokens(1000, { input: 500, output: 200, cacheRead: 100 })).toBe(600);
		// max(500-100,0) + 200 = 600
	});
	it("cacheRead > input：max 结果为 0", () => {
		expect(accumulateTokens(1000, { input: 100, output: 50, cacheRead: 200 })).toBe(50);
		// max(100-200,0) + 50 = 50
	});
	it("input=0 output=0：fallback totalTokens", () => {
		expect(accumulateTokens(1000, { totalTokens: 300 })).toBe(1300);
	});
	it("无 usage：不累加", () => {
		expect(accumulateTokens(1000, {})).toBe(1000);
	});
});

describe("tick — FR-6.5 时间累计（纯函数，返回新值不 mutate）", () => {
	it("active 状态：累加经过时间", () => {
		const state = makeState({
			status: "active",
			timeStartedAt: 1000000,
			timeUsedSeconds: 0,
		});
		const result = tick(state, 1001000); // now = 1001000, 经过 1 秒
		expect(result.timeUsedSeconds).toBe(1);
		expect(result.timeStartedAt).toBe(1001000);
	});
	it("paused 状态：不累加（保持 timeUsedSeconds）", () => {
		const state = makeState({
			status: "paused",
			timeStartedAt: 1000000,
			timeUsedSeconds: 30,
		});
		const result = tick(state, 1005000);
		expect(result.timeUsedSeconds).toBe(30);
		expect(result.timeStartedAt).toBe(1000000);
	});
});

describe("checkBudgetOnTurnEnd — FR-6.2 维度独立预警", () => {
	it("token 到 70% 发 warning70，随后 time 到 70% 也发（不共享 flag）", () => {
		// token 已到 70%（warning70Sent 已设），time 新到 70%
		const state = makeState({
			budget: { maxStallTurns: 5, maxTurns: 50, tokenBudget: 10000, timeBudgetMinutes: 10 },
			tokensUsed: 7500, // 75% > 70%
			tokenWarning70Sent: true, // token 的 70% 已发过
			timeWarning70Sent: false, // time 的 70% 未发
			timeUsedSeconds: 420, timeStartedAt: 0, status: "active",
			timeWarning90Sent: false, tokenWarning90Sent: false,
			budgetLimitSteeringSent: false, lastTurnTokensUsed: 0,
		} as Partial<GoalRuntimeState> as GoalRuntimeState);
		const result = checkBudgetOnTurnEnd(state, 420); // timeUsed=420s, budget=600s → 70%
		const timeWarning = result.warnings.find(w => w.dimension === "time" && w.type === "warning70");
		expect(timeWarning).toBeTruthy();
	});
	it("token 100% + steering 已发 → terminal exceeded", () => {
		const state = makeState({
			budget: { maxStallTurns: 5, maxTurns: 50, tokenBudget: 10000 },
			tokensUsed: 10000,
			budgetLimitSteeringSent: true,
		} as Partial<GoalRuntimeState> as GoalRuntimeState);
		const result = checkBudgetOnTurnEnd(state, 0);
		expect(result.terminal).toEqual({ type: "exceeded", dimension: "token" });
	});
	it("token 90% 未发 steering → shouldSendSteering", () => {
		const state = makeState({
			budget: { maxStallTurns: 5, maxTurns: 50, tokenBudget: 10000 },
			tokensUsed: 9100,
			budgetLimitSteeringSent: false,
		} as Partial<GoalRuntimeState> as GoalRuntimeState);
		const result = checkBudgetOnTurnEnd(state, 0);
		expect(result.shouldSendSteering).toBe(true);
	});
});

describe("checkBudgetOnResume", () => {
	it("token 超额 → exceeded token", () => {
		const state = makeState({
			budget: { maxStallTurns: 5, maxTurns: 50, tokenBudget: 10000 },
			tokensUsed: 10000,
		} as Partial<GoalRuntimeState> as GoalRuntimeState);
		expect(checkBudgetOnResume(state)).toEqual({ type: "exceeded", dimension: "token" });
	});
	it("未超额 → null", () => {
		const state = makeState({
			budget: { maxStallTurns: 5, maxTurns: 50, tokenBudget: 10000 },
			tokensUsed: 5000,
		} as Partial<GoalRuntimeState> as GoalRuntimeState);
		expect(checkBudgetOnResume(state)).toBeNull();
	});
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @zhushanwen/pi-goal test src/engine/__tests__/budget.test.ts`
预期：FAIL，`Cannot find module '../budget'`

- [ ] **步骤 3：编写 engine/budget.ts 实现**

创建 `extensions/goal/src/engine/budget.ts`。从现有 `budget.ts` 提取逻辑，改为纯函数（接收 `timeUsedSeconds` 参数而非调 `Date.now()`），修复 FR-6.2 维度独立。**完整代码**（关键部分）：

```typescript
/**
 * Budget 决策引擎 — 纯函数，零 Pi 依赖
 * FR-6.2: token/time 预警维度独立（4 个 flag）
 * FR-6.5: tick 时间累计（纯函数，不 mutate）
 * FR-8.6: token 累加算法
 */

import type { GoalRuntimeState } from "./goal";

// ── 决策类型 ──────────────────────────────────────────

export type BudgetDecision =
	| { type: "ok" }
	| { type: "warning70"; dimension: "token" | "time" }
	| { type: "warning90"; dimension: "token" | "time" }
	| { type: "steer_limit"; dimension: "token" | "time" }
	| { type: "exceeded"; dimension: "token" | "time" };

export interface BudgetCheckResult {
	terminal: { type: "exceeded"; dimension: "token" | "time" } | null;
	warnings: BudgetDecision[];
	shouldSendSteering: boolean;
}

// ── 阈值常量（从 constants.ts 复制值，engine 不 import constants 以保持零依赖）──
// 注意：constants.ts 无 Pi import，engine 可安全 import。但为隔离更清晰，这里内联。
const RATIO_HIGH = 0.9;
const RATIO_LOW = 0.7;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const PERCENT_FACTOR = 100;

// ── token 累加（FR-8.6 message_end 算法）──────────────

export interface TokenUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	totalTokens?: number;
}

/** 纯函数：根据 usage 计算累加后的 tokensUsed。 */
export function accumulateTokens(currentTokensUsed: number, usage: TokenUsage): number {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	if (input > 0 || output > 0) {
		return currentTokensUsed + Math.max(input - cacheRead, 0) + output;
	}
	if (usage.totalTokens) {
		return currentTokensUsed + usage.totalTokens;
	}
	return currentTokensUsed;
}

// ── tick：时间累计（FR-6.5）──────────────────────────

export interface TickResult {
	timeUsedSeconds: number;
	timeStartedAt: number;
}

/**
 * 纯函数：计算时间累计。active/paused 的区分通过传入的 isRunning 决定。
 * 返回新的 timeUsedSeconds 和 timeStartedAt，不 mutate。
 */
export function tick(state: GoalRuntimeState, now: number): TickResult {
	// paused/blocked/blocked 不累计（getElapsedTimeSeconds 的逻辑：终态或 paused 返回 timeUsedSeconds）
	// 但 tick 的调用方（service）只在 persist 前、active 状态下调。
	// 为安全，这里检查非 active 不累加。
	if (state.status !== "active") {
		return { timeUsedSeconds: state.timeUsedSeconds, timeStartedAt: state.timeStartedAt };
	}
	if (state.timeStartedAt <= 0) {
		return { timeUsedSeconds: state.timeUsedSeconds, timeStartedAt: state.timeStartedAt };
	}
	const elapsed = (now - state.timeStartedAt) / MS_PER_SECOND;
	return {
		timeUsedSeconds: state.timeUsedSeconds + elapsed,
		timeStartedAt: now,
	};
}

// ── 进度检查（纯函数）────────────────────────────────

// engine/task 的 isTaskDone 在这里通过参数传入，避免循环依赖
export interface ProgressCheck {
	allTasksDone: boolean;
	noTasksCreated: boolean;
	maxTurnsReached: boolean;
	isStalled: boolean;
	budgetTight: boolean;
	completedCount: number;
	totalCount: number;
}

// ── turn end 预算检查（FR-6.2 维度独立）───────────────

export function checkBudgetOnTurnEnd(
	state: GoalRuntimeState,
	timeUsedSeconds: number,
): BudgetCheckResult {
	const result: BudgetCheckResult = {
		terminal: null,
		warnings: [],
		shouldSendSteering: false,
	};

	// Token 预算检查
	if (state.budget.tokenBudget) {
		const tokenPct = state.tokensUsed / state.budget.tokenBudget;
		if (tokenPct >= 1 && state.budgetLimitSteeringSent) {
			result.terminal = { type: "exceeded", dimension: "token" };
			return result;
		}
		if (tokenPct >= RATIO_HIGH && !state.budgetLimitSteeringSent) {
			result.shouldSendSteering = true;
			return result;
		}
		if (tokenPct >= RATIO_HIGH && !state.tokenWarning90Sent) {
			result.warnings.push({ type: "warning90", dimension: "token" });
		} else if (tokenPct >= RATIO_LOW && !state.tokenWarning70Sent) {
			result.warnings.push({ type: "warning70", dimension: "token" });
		}
	}

	// 时间预算检查（FR-6.2: 独立 flag，不与 token 共享）
	if (state.budget.timeBudgetMinutes) {
		const budgetSeconds = state.budget.timeBudgetMinutes * SECONDS_PER_MINUTE;
		if (timeUsedSeconds >= budgetSeconds) {
			result.terminal = { type: "exceeded", dimension: "time" };
			return result;
		}
		const timePct = timeUsedSeconds / budgetSeconds;
		if (timePct >= RATIO_HIGH && !state.timeWarning90Sent) {
			result.warnings.push({ type: "warning90", dimension: "time" });
		} else if (timePct >= RATIO_LOW && !state.timeWarning70Sent) {
			result.warnings.push({ type: "warning70", dimension: "time" });
		}
	}

	return result;
}

// ── resume 预算检查（纯函数）──────────────────────────

export function checkBudgetOnResume(
	state: GoalRuntimeState,
): { type: "exceeded"; dimension: "token" | "time" } | null {
	if (state.budget.tokenBudget && state.tokensUsed >= state.budget.tokenBudget) {
		return { type: "exceeded", dimension: "token" };
	}
	if (state.budget.timeBudgetMinutes) {
		const budgetSeconds = state.budget.timeBudgetMinutes * SECONDS_PER_MINUTE;
		if (state.timeUsedSeconds >= budgetSeconds) {
			return { type: "exceeded", dimension: "time" };
		}
	}
	return null;
}

// ── 百分比计算（供 projection/widget 使用，纯函数）────

export function getTokenUsagePercent(state: GoalRuntimeState): number {
	if (!state.budget.tokenBudget || state.budget.tokenBudget <= 0) return 0;
	return (state.tokensUsed / state.budget.tokenBudget) * PERCENT_FACTOR;
}

export function getTimeUsagePercent(state: GoalRuntimeState, timeUsedSeconds: number): number {
	if (!state.budget.timeBudgetMinutes || state.budget.timeBudgetMinutes <= 0) return 0;
	const budgetSeconds = state.budget.timeBudgetMinutes * SECONDS_PER_MINUTE;
	return (timeUsedSeconds / budgetSeconds) * PERCENT_FACTOR;
}

export function getBudgetColor(percent: number): "error" | "warning" | "muted" {
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "muted";
}

export function checkProgress(
	state: GoalRuntimeState,
	tasksCompletedAtStart: number,
	isTaskDoneFn: (task: import("./task").GoalTask) => boolean,
): ProgressCheck {
	const incomplete = state.tasks.filter(t => !isTaskDoneFn(t));
	const completedCount = state.tasks.filter(
		t => t.status === "completed" || t.status === "verified",
	).length;
	const totalCount = state.tasks.length;
	const progressThisRound = completedCount - tasksCompletedAtStart;
	return {
		allTasksDone: totalCount > 0 && incomplete.length === 0 && completedCount > 0,
		noTasksCreated: totalCount === 0,
		maxTurnsReached: state.currentTurnIndex >= state.budget.maxTurns,
		isStalled: progressThisRound === 0,
		budgetTight: Boolean(
			state.budget.tokenBudget &&
			state.tokensUsed >= state.budget.tokenBudget * 0.8,
		),
		completedCount,
		totalCount,
	};
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm --filter @zhushanwen/pi-goal test src/engine/__tests__/budget.test.ts`
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add extensions/goal/src/engine/budget.ts extensions/goal/src/engine/__tests__/budget.test.ts
git commit -m "feat(goal): add engine/budget.ts — pure budget decisions + tick + token accumulation"
```

---

## 任务 4: ports.ts — 能力抽象接口

**文件：**
- 创建：`extensions/goal/src/ports.ts`

**目标：** 定义 engine/service 层需要的能力抽象。这些接口让 service 不直接 import Pi 类型。零依赖（纯类型定义）。

- [ ] **步骤 1：编写 ports.ts**

创建 `extensions/goal/src/ports.ts`：

```typescript
/**
 * Ports — 能力抽象接口
 * service 层通过这些接口访问 Pi 能力，不直接 import Pi 类型。
 * adapter 层提供实现（包装 ctx / pi）。
 *
 * D-22: ports 的核心价值是机器可检查的边界（engine/ 禁止 import Pi），
 * 不是"可替换的 adapter"。
 */

import type { GoalRuntimeState } from "./engine/goal";

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
	/** 设置 widget 内容（undefined = 清除）。hasUI=false 时 adapter 跳过（FR-6.6 headless 守卫） */
	setWidget(name: string, content: string[] | string | undefined): void;
	/** 设置 status bar。hasUI=false 时跳过 */
	setStatus(name: string, text: string | undefined): void;
	/** 弹通知 */
	notify(text: string, level: "info" | "warning" | "error"): void;
	/** 是否有 UI（headless/RPC mode 为 false） */
	readonly hasUI: boolean;
}

// ── MessagingPort ────────────────────────────────────

export interface MessagingPort {
	/** 发送 custom message（goal-context 等），deliverAs=steer/followUp */
	sendContextMessage(content: string, deliverAs: "steer" | "followUp", customType?: string): void;
	/** 发送 user message（触发 AI 开始工作，FR-8.12） */
	sendUserMessage(content: string, deliverAs: "steer" | "followUp"): void;
}

// ── SessionPort ──────────────────────────────────────

export interface SessionEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface SessionPort {
	/** 获取全部 entries（用于 reconstruct + history 查询） */
	getEntries(): SessionEntry[];
	/** splice entries（用于 entry GC） */
	spliceEntry(index: number, count: number): void;
	/** 上下文使用率（FR-8.6 context pause） */
	getContextUsage(): { tokens?: number; contextWindow?: number } | null;
	/** AbortSignal（FR-6.7 ESC 检测） */
	readonly signal: AbortSignal | undefined;
}
```

- [ ] **步骤 2：typecheck 确认**

运行：`pnpm --filter @zhushanwen/pi-goal typecheck`
预期：无错误（ports.ts 只有类型，不影响现有代码）

- [ ] **步骤 3：提交**

```bash
git add extensions/goal/src/ports.ts
git commit -m "feat(goal): add ports.ts — PersistencePort/UiPort/MessagingPort/SessionPort abstractions"
```

---

## 任务 5: persistence.ts — 序列化 + history

**文件：**
- 创建：`extensions/goal/src/persistence.ts`
- 测试：`extensions/goal/src/__tests__/deserialize-state.test.ts`（改写，FR-5）

**目标：** serialize/deserialize（FR-5 移除旧格式兼容，字段缺失 throw）+ appendHistory/queryHistory。deserialize 假设新格式，缺字段直接报错。

- [ ] **步骤 1：改写 deserialize-state 测试（FR-7.3，非迁移而是改写）**

改写 `extensions/goal/src/__tests__/deserialize-state.test.ts`（替换全部内容）：

```typescript
/**
 * FR-5/FR-7.3: deserializeState — 新格式严格解析（字段缺失 throw）
 */
import { describe, expect, it } from "vitest";

import { deserializeState } from "../persistence";

describe("deserializeState — 新格式严格解析", () => {
	it("完整新格式数据 → 正确还原", () => {
		const data = {
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
		const state = deserializeState(data);
		expect(state.tasks[0]!.verification).toEqual({
			method: "pnpm test", expected: "all pass", actual: "passed",
		});
	});

	it("task 缺 status 字段 → throw（FR-5 严格解析）", () => {
		const data = {
			goalId: "g1", objective: "test", status: "active",
			tasks: [{ id: 1, description: "task 1", lastUpdatedTurn: 0 }], // 缺 status
			stallCount: 0, tokensUsed: 0, timeStartedAt: 1000, timeUsedSeconds: 0,
			budget: { maxStallTurns: 5, maxTurns: 50 },
		};
		expect(() => deserializeState(data)).toThrow();
	});

	it("顶层缺 budget → throw（不再兜底默认值）", () => {
		const data = { goalId: "g1", objective: "test", status: "active", tasks: [] };
		expect(() => deserializeState(data)).toThrow();
	});

	it("subtasks 正确解析（新格式 subtasks 字段）", () => {
		const data = {
			goalId: "g1", objective: "test", status: "active",
			tasks: [{
				id: 1, description: "t1", status: "in_progress", lastUpdatedTurn: 0,
				subtasks: [{ id: 1, text: "sub", status: "pending", lastUpdatedTurn: 0 }],
			}],
			stallCount: 0, tokensUsed: 0, timeStartedAt: 1000, timeUsedSeconds: 0,
			budget: { maxStallTurns: 5, maxTurns: 50 },
			lastProgressTurn: 0, budgetLimitSteeringSent: false,
			objectiveUpdatedAt: 1000, lastBlockerReason: null,
			tokenWarning70Sent: false, tokenWarning90Sent: false,
			timeWarning70Sent: false, timeWarning90Sent: false,
			lastTurnTokensUsed: 0, currentTurnIndex: 0,
		};
		const state = deserializeState(data);
		expect(state.tasks[0]!.subtasks).toHaveLength(1);
		expect(state.tasks[0]!.subtasks![0]!.status).toBe("pending");
	});
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @zhushanwen/pi-goal test src/__tests__/deserialize-state.test.ts`
预期：FAIL（`Cannot find module '../persistence'`）

- [ ] **步骤 3：编写 persistence.ts**

创建 `extensions/goal/src/persistence.ts`：

```typescript
/**
 * 持久化层 — serialize/deserialize + history R/W
 * FR-5: 移除旧格式兼容，字段缺失直接 throw
 */

import type { GoalRuntimeState } from "./engine/goal";
import type { GoalTask, Subtask, SubtaskStatus, TaskStatus, TaskVerification } from "./engine/task";
import type { GoalHistoryEntry } from "./ports";

// ── serialize（深拷贝，纯函数）────────────────────────

export function serializeState(state: GoalRuntimeState): GoalRuntimeState {
	return {
		...state,
		tasks: state.tasks.map(t => ({
			...t,
			subtasks: t.subtasks?.map(s => ({ ...s })),
		})),
		budget: { ...state.budget },
	};
}

// ── deserialize（新格式严格解析，缺字段 throw）────────

export function deserializeState(data: Record<string, unknown>): GoalRuntimeState {
	// FR-5: 不再兜底默认值，缺字段直接 throw
	const require = <T>(key: string): T => {
		if (!(key in data) || data[key] === undefined) {
			throw new Error(`Missing required field: ${key}`);
		}
		return data[key] as T;
	};

	const tasksRaw = require<unknown[]>("tasks");
	const tasks: GoalTask[] = tasksRaw.map((tRaw): GoalTask => {
		const t = tRaw as Record<string, unknown>;
		if (!("status" in t)) {
			throw new Error("Legacy goal-state format detected, session reset required");
		}
		const subtasksRaw = t.subtasks as Record<string, unknown>[] | undefined;
		const subtasks: Subtask[] | undefined = Array.isArray(subtasksRaw)
			? subtasksRaw.map(s => ({
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
		goalId: require("goalId"),
		objective: require("objective"),
		status: require("status"),
		tasks,
		stallCount: require("stallCount"),
		tokensUsed: require("tokensUsed"),
		timeStartedAt: require("timeStartedAt"),
		timeUsedSeconds: require("timeUsedSeconds"),
		budget: require("budget"),
		lastProgressTurn: require("lastProgressTurn"),
		budgetLimitSteeringSent: require("budgetLimitSteeringSent"),
		objectiveUpdatedAt: require("objectiveUpdatedAt"),
		lastBlockerReason: require("lastBlockerReason"),
		tokenWarning70Sent: require("tokenWarning70Sent"),
		tokenWarning90Sent: require("tokenWarning90Sent"),
		timeWarning70Sent: require("timeWarning70Sent"),
		timeWarning90Sent: require("timeWarning90Sent"),
		lastTurnTokensUsed: require("lastTurnTokensUsed"),
		currentTurnIndex: require("currentTurnIndex"),
		completedAtTurnIndex: data.completedAtTurnIndex as number | undefined,
	};
}

// ── history 构造（从 state 生成 entry，纯函数）────────

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

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm --filter @zhushanwen/pi-goal test src/__tests__/deserialize-state.test.ts`
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add extensions/goal/src/persistence.ts extensions/goal/src/__tests__/deserialize-state.test.ts
git commit -m "feat(goal): add persistence.ts — strict deserialize (FR-5) + history entry"
```

---

## 任务 6-10: 概要（service + adapters + projection）

> **说明：** 任务 1-5 建立了 engine 层和基础设施。任务 6-10 是应用层迁移，每步都先确保现有测试不破。因剩余任务结构与前 5 个类似（TDD 循环），这里给出每个任务的文件、职责、关键实现点。执行者按相同模式（写测试→失败→实现→通过→提交）逐个完成。

### 任务 6: session.ts — 运行时句柄 + reconstruct + entry GC

**文件：** 创建 `extensions/goal/src/session.ts`

**职责：**
- `GoalSession` 接口（移除 `hasPendingInjection` FR-6.4、移除 `pendingPause` FR-6.7）
- `reconstructGoalState(session, sessionPort)` — 从 entries 恢复 state（用 persistence.deserializeState，catch → null）
- session_start 非对称强制激活（FR-8.3 G-015）
- entry GC（goal-state 只留最新 1 条，goal-history 留 20 条 FR-8.1 G-006）
- stale context 检测（STALE_CONTEXT_PATTERNS，FR-8.2 G-010）

**关键：** reconstructGoalState 接收 SessionPort（不直接 import ctx）。catch deserializeState throw → state=null（FR-8.1 G-024 部分损坏全丢）。

### 任务 7: service.ts — 双入口协调层

**文件：** 创建 `extensions/goal/src/service.ts`

**职责：**
- `applyToolAction(state, action, ports) → { state, result }` — 路径 A 入口
- `applyEvent(state, event, ports) → { state, effects[] }` — 路径 B 入口
- 两者调 engine 纯函数（transitionStatus / checkBudget / validateTaskTransition）
- `createGoal(objective, tasks?, budget?)` 唯一创建入口（FR-3.1，三个调用源都走它）
- `finalizeGoal(state, terminalStatus, reason, ports)` 唯一完成入口（FR-3.3，按 FR-8.7 矩阵决定 writeHistory + clearSession）
- persist 前 `tick` 累计时间（FR-6.5）

**关键：** service 不持有 ctx（D-16）。并发保护不在此层（在 event-adapter）。

### 任务 8: adapters/tool-adapter.ts + adapters/actions.ts

**文件：** 创建 `extensions/goal/src/adapters/tool-adapter.ts` + `extensions/goal/src/adapters/actions.ts`

**职责：**
- `GoalManagerParams` schema（不变，AC-4）
- `executeGoalAction` 分发（stale context 检测 FR-8.2）
- `ACTION_HANDLERS: Record<Action, ActionHandler>`（AC-3 编译期完整性）
- 10 个 action handler 薄封装，调 service.applyToolAction
- 保留所有 FR-8 行为契约（FR-8.8 create_tasks all-complete **保持当前覆盖行为**，不报错——D-19 拆出独立 ticket）
- FR-8.9 verification steering（update_tasks 标 completed 有 verification → 注入 steer）
- FR-8.10 complete_goal 全 cancelled 守卫
- FR-8.11 add_subtasks 拒绝 completed task
- FR-8.12 set/resume 后 sendUserMessage（但这俩在 command-adapter）

### 任务 9: adapters/command-adapter.ts — /goal 命令

**文件：** 创建 `extensions/goal/src/adapters/command-adapter.ts`

**职责：** 8 个子命令 handler（status/pause/resume/clear/abort/update/history/set），调 service。
- FR-8.4 G-002 update 走 applyToolAction（重塑，保留 goalId）
- FR-8.4 G-003 set 覆盖终态 goal 快速路径
- FR-8.7 set 覆盖非终态 goal 写 cancelled history
- FR-8.12 set 创建后 sendUserMessage(deliverAs="followUp")
- FR-8.12 resume 有未完成任务时同样 sendUserMessage

### 任务 10: adapters/event-adapter.ts — 6 个事件 handler

**文件：** 创建 `extensions/goal/src/adapters/event-adapter.ts`

**职责：** 最复杂的文件，拆为子函数。
- `before_agent_start`：staleness reminder（FR-8.6 重置 lastUpdatedTurn）+ context pause（FR-8.6 85%）+ context injection + AUTO_CLEAR_TURNS（FR-8.1 G-007）
- `agent_start`：tasksCompletedAtAgentStart 基线（FR-8.6）
- `turn_end`：currentTurnIndex++（FR-6.7 ESC 守卫：aborted 跳过）+ widget 刷新
- `message_end`：token 累加（FR-8.6 accumulateTokens，FR-6.7 ESC 守卫：aborted 跳过）
- `agent_end`：完整分支（FR-8.7 handleProgressAndTasks 分支顺序 + budget checks + stall + continuation 去抖）+ goalId snapshot stale-checker（FR-8.2 G-020）+ isProcessing 防重入（FR-8.2 G-021）+ **FR-6.7 ESC 三守卫最关键的一个**（aborted → 不发 continuation、不递增 stall、不做 budget 检查、goal 保持 active）
- `session_start`：reconstructGoalState 委托 session.ts

**并发保护全在此层**：isProcessing / makeStaleChecker / checkStale。ESC 的 `ctx.signal?.aborted` 检查在 message_end / turn_end / agent_end 三个 handler 入口。

### 任务 11: projection/ — widget + prompts + result

**文件：** 创建 `projection/widget.ts` + `projection/prompts.ts` + `projection/result.ts`

**职责：**
- widget.ts：从现有 widget.ts 迁移，updateWidget 加 hasUI 守卫（FR-6.6）
- prompts.ts：从 templates.ts 迁移，budget 格式化收敛（FR-3.4，4 处重复→1 处 formatBudget）
- result.ts：makeGoalResult/errorResult + budget 格式化（与 prompts 共享 formatBudget）

### 任务 12: index.ts — 工厂重写 + __goalInit 收口

**文件：** 重写 `extensions/goal/src/index.ts`

**职责：**
- 注册 tool / command / events（委托 adapters）
- `__goalInit` 内部调 service.createGoal（FR-4.1 双轨消除）
- ctx 改必填（D-16，FR-4.2）
- 移除 `lastCtx` 模块级可变状态
- 移除 `hasPendingInjection`（FR-6.4）
- 移除 `pendingPause`（FR-6.7）

### 任务 13: 删除旧文件 + 全量验证

**文件：** 删除 `tool-handler.ts` / `state.ts` / `budget.ts` / `widget.ts` / `templates.ts` / `action-handlers.ts` / `command-handler.ts` / `agent-end-handler.ts` / `before-agent-start-handler.ts`

**验证：**
- [ ] `pnpm --filter @zhushanwen/pi-goal typecheck` 零错误
- [ ] `pnpm --filter @zhushanwen/pi-goal lint` 零错误
- [ ] `pnpm --filter @zhushanwen/pi-goal test` 全绿
- [ ] `grep -rn "@mariozechner\|@earendil" extensions/goal/src/engine/` 无输出（AC-1）
- [ ] `grep -rn "hasPendingInjection" extensions/goal/src/` 无输出（AC-5）
- [ ] `grep -rn "pendingPause" extensions/goal/src/` 无输出（AC-5）
- [ ] `grep -rn ": any\b\|eslint-disable" extensions/goal/src/` 无输出（AC-7）

- [ ] **提交**

```bash
git add -A
git commit -m "refactor(goal): complete architecture rewrite — engine/ports/adapters/projection layers

- engine/ (zero Pi deps): goal/task/budget pure state machines
- ports.ts: machine-checkable boundary (PersistencePort/UiPort/MessagingPort/SessionPort)
- service.ts: dual entry (applyToolAction/applyEvent), engine shared
- adapters/: tool/command/event, concurrency guards in event-adapter
- projection/: widget/prompts/result, budget formatting deduplicated

Behavior changes (architecture-necessary, per spec):
- FR-5: serialization clean break (old entries discarded)
- FR-6.2: token/time warning flags independent
- FR-6.7: ESC pure interrupt (3-handler aborted guard)
- FR-6.4/6.5/6.6: remove hasPendingInjection, extract tick(), hasUI guard

All FR-8 behavior contracts preserved."
```

---

## 自我审查清单（执行者在完成所有任务后逐条检查）

### 规格覆盖
- [ ] FR-1.1~1.4：engine/goal + engine/task + engine/budget + persistence（GoalHistory DTO）✓
- [ ] FR-2.1~2.3：目录结构 + ports + service 双入口 ✓
- [ ] FR-3.1~3.4：createGoal + applyToolAction/applyEvent + finalizeGoal + projection 收敛 ✓
- [ ] FR-4：__goalInit 双轨消除 + ctx 必填 ✓
- [ ] FR-5：序列化清断 ✓
- [ ] FR-6.1~6.7：widget 刷新 + 预警独立 + clear/abort + 删 hasPendingInjection + tick + headless + ESC ✓
- [ ] FR-7.1~7.4：engine 全枚举 + service fake adapter + 行为回归 + stub ✓
- [ ] FR-8.1~8.12：全部行为契约 ✓
- [ ] AC-1~AC-9：全部验收标准 ✓

### 占位符扫描
- [ ] 无 TBD/TODO/"以后实现"
- [ ] 无"添加适当错误处理"（每个错误处理都有具体代码）
- [ ] 每个代码步骤都有完整代码块

### 类型一致性
- [ ] `GoalRuntimeState` 字段名在所有文件一致（特别是新增的 `tokenWarning70Sent` 等 4 个 flag）
- [ ] `createGoalState` vs `createGoal`（前者 engine 纯构造，后者 service 入口含 task 构造）
- [ ] `applyToolAction` / `applyEvent` 签名在 service 和 adapter 调用点一致
- [ ] `GoalSession` 不再含 `hasPendingInjection` / `pendingPause`
