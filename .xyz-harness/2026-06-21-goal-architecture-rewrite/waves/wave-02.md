# Wave 2: engine/budget.ts

- **目标文件**：
  - 创建：`extensions/goal/src/engine/budget.ts`
  - 测试：`extensions/goal/src/engine/__tests__/budget.test.ts`
- **前置 wave**：Wave 1（engine/types.ts + engine/goal.ts 已存在）
- **目标**：实现 Budget 决策引擎纯函数。

## 关键约束

- `tick(timeStartedAt, timeUsedSeconds, now, isRunning)` — 纯函数，不调 `Date.now()`，不检查 `state.status`
- FR-6.2：`checkBudgetOnTurnEnd` 用 4 个独立 flag
- `checkProgress` 接收 `isTaskDoneFn` 注入
- 禁止 `any`、双重断言

---

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/goal/src/engine/__tests__/budget.test.ts`：

```typescript
/**
 * engine/budget.ts 测试
 */
import { describe, expect, it } from "vitest";

import {
	accumulateTokens,
	checkBudgetOnResume,
	checkBudgetOnTurnEnd,
	checkProgress,
	getBudgetColor,
	getTimeUsagePercent,
	getTokenUsagePercent,
	tick,
	type TokenUsage,
} from "../budget";
import type { GoalRuntimeState } from "../types";
import type { GoalTask } from "../task";
import { isTaskDone } from "../task";

const makeState = (overrides: Partial<GoalRuntimeState> = {}): GoalRuntimeState => ({
	goalId: "test",
	objective: "test",
	status: "active",
	tasks: [],
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
	...overrides,
});

const makeTask = (o: Partial<GoalTask> = {}): GoalTask => ({
	id: 1, description: "t", status: "pending", lastUpdatedTurn: 0, ...o,
});

// ── accumulateTokens（FR-8.6）─────────────────────────

describe("accumulateTokens", () => {
	it("input/output 有 → max(input-cacheRead,0)+output", () => {
		expect(accumulateTokens(1000, { input: 100, output: 50, cacheRead: 20 })).toBe(1130);
	});
	it("cacheRead > input → max=0", () => {
		expect(accumulateTokens(1000, { input: 50, output: 30, cacheRead: 100 })).toBe(1030);
	});
	it("input=0 output=0 → fallback totalTokens", () => {
		expect(accumulateTokens(1000, { totalTokens: 200 })).toBe(1200);
	});
	it("全空 → 不累加", () => {
		expect(accumulateTokens(1000, {})).toBe(1000);
	});
	it("无 cacheRead → 视为 0", () => {
		expect(accumulateTokens(0, { input: 100, output: 50 })).toBe(150);
	});
});

// ── tick（FR-6.5 纯函数）──────────────────────────────

describe("tick", () => {
	it("isRunning=true → 累加 now-start 到 timeUsedSeconds", () => {
		expect(tick(1000, 0, 1600, true)).toEqual({ timeUsedSeconds: 600, timeStartedAt: 1600 });
	});
	it("isRunning=true → 叠加已有 timeUsedSeconds", () => {
		expect(tick(1000, 100, 1600, true)).toEqual({ timeUsedSeconds: 700, timeStartedAt: 1600 });
	});
	it("isRunning=false → 不累加，但重置 timeStartedAt=now", () => {
		expect(tick(1000, 500, 2000, false)).toEqual({ timeUsedSeconds: 500, timeStartedAt: 2000 });
	});
	it("纯函数：相同输入相同输出", () => {
		expect(tick(1000, 50, 2000, true)).toEqual(tick(1000, 50, 2000, true));
	});
});

// ── checkBudgetOnTurnEnd（FR-6.2 维度独立）────────────

describe("checkBudgetOnTurnEnd — 无预算", () => {
	it("无 token/time budget → ok", () => {
		const r = checkBudgetOnTurnEnd(makeState(), 0);
		expect(r.terminal).toBeNull();
		expect(r.warnings).toEqual([]);
		expect(r.shouldSendSteering).toBe(false);
	});
});

describe("checkBudgetOnTurnEnd — token 阈值", () => {
	it("token < 70% → 无预警", () => {
		const s = makeState({ tokensUsed: 600, budget: { maxStallTurns: 5, maxTurns: 50, tokenBudget: 1000 } });
		expect(checkBudgetOnTurnEnd(s, 0).warnings).toEqual([]);
	});
	it("token >= 70% 未发 → warning70 token", () => {
		const s = makeState({ tokensUsed: 700, budget: { maxStallTurns: 5, maxTurns: 50, tokenBudget: 1000 } });
		expect(checkBudgetOnTurnEnd(s, 0).warnings).toContainEqual({ type: "warning70", dimension: "token" });
	});
	it("token >= 70% 已发 → 不重复", () => {
		const s = makeState({ tokensUsed: 750, tokenWarning70Sent: true, budget: { maxStallTurns: 5, maxTurns: 50, tokenBudget: 1000 } });
		expect(checkBudgetOnTurnEnd(s, 0).warnings).not.toContainEqual({ type: "warning70", dimension: "token" });
	});
	it("token >= 90% 未发 steering → shouldSendSteering", () => {
		const s = makeState({ tokensUsed: 950, budget: { maxStallTurns: 5, maxTurns: 50, tokenBudget: 1000 } });
		expect(checkBudgetOnTurnEnd(s, 0).shouldSendSteering).toBe(true);
	});
	it("token >= 100% 已发 steering → terminal exceeded token", () => {
		const s = makeState({ tokensUsed: 1000, budgetLimitSteeringSent: true, budget: { maxStallTurns: 5, maxTurns: 50, tokenBudget: 1000 } });
		expect(checkBudgetOnTurnEnd(s, 0).terminal).toEqual({ type: "exceeded", dimension: "token" });
	});
});

describe("checkBudgetOnTurnEnd — time 阈值", () => {
	it("time < 70% → 无预警", () => {
		const s = makeState({ budget: { maxStallTurns: 5, maxTurns: 50, timeBudgetMinutes: 10 } });
		expect(checkBudgetOnTurnEnd(s, 300).warnings).toEqual([]);
	});
	it("time >= 70% → warning70 time", () => {
		const s = makeState({ budget: { maxStallTurns: 5, maxTurns: 50, timeBudgetMinutes: 10 } });
		expect(checkBudgetOnTurnEnd(s, 420).warnings).toContainEqual({ type: "warning70", dimension: "time" });
	});
	it("time >= 100% → terminal exceeded time", () => {
		const s = makeState({ budget: { maxStallTurns: 5, maxTurns: 50, timeBudgetMinutes: 10 } });
		expect(checkBudgetOnTurnEnd(s, 600).terminal).toEqual({ type: "exceeded", dimension: "time" });
	});
});

describe("checkBudgetOnTurnEnd — FR-6.2 维度独立（核心 bug 修复）", () => {
	it("token 已发 70%，time 到 70% 也独立发", () => {
		const s = makeState({
			tokensUsed: 750, tokenWarning70Sent: true,
			budget: { maxStallTurns: 5, maxTurns: 50, tokenBudget: 1000, timeBudgetMinutes: 10 },
		});
		const r = checkBudgetOnTurnEnd(s, 450); // time 75%
		expect(r.warnings).toContainEqual({ type: "warning70", dimension: "time" });
		expect(r.warnings).not.toContainEqual({ type: "warning70", dimension: "token" });
	});
	it("两个维度同时到 70% → 两个 warning70 都发", () => {
		const s = makeState({
			tokensUsed: 750,
			budget: { maxStallTurns: 5, maxTurns: 50, tokenBudget: 1000, timeBudgetMinutes: 10 },
		});
		const r = checkBudgetOnTurnEnd(s, 450);
		expect(r.warnings).toContainEqual({ type: "warning70", dimension: "token" });
		expect(r.warnings).toContainEqual({ type: "warning70", dimension: "time" });
	});
});

// ── checkBudgetOnResume ──────────────────────────────

describe("checkBudgetOnResume", () => {
	it("无预算 → null", () => expect(checkBudgetOnResume(makeState())).toBeNull());
	it("token 超额 → exceeded token", () => {
		const s = makeState({ tokensUsed: 1000, budget: { maxStallTurns: 5, maxTurns: 50, tokenBudget: 1000 } });
		expect(checkBudgetOnResume(s)).toEqual({ type: "exceeded", dimension: "token" });
	});
	it("time 超额 → exceeded time", () => {
		const s = makeState({ timeUsedSeconds: 700, budget: { maxStallTurns: 5, maxTurns: 50, timeBudgetMinutes: 10 } });
		expect(checkBudgetOnResume(s)).toEqual({ type: "exceeded", dimension: "time" });
	});
	it("未超额 → null", () => {
		const s = makeState({ tokensUsed: 500, budget: { maxStallTurns: 5, maxTurns: 50, tokenBudget: 1000 } });
		expect(checkBudgetOnResume(s)).toBeNull();
	});
});

// ── checkProgress ────────────────────────────────────

describe("checkProgress", () => {
	it("无任务 → noTasksCreated", () => {
		const r = checkProgress(makeState({ tasks: [] }), 0, isTaskDone);
		expect(r.noTasksCreated).toBe(true);
	});
	it("全 done → allTasksDone", () => {
		const s = makeState({ tasks: [makeTask({ id: 1, status: "completed" }), makeTask({ id: 2, status: "verified" })] });
		expect(checkProgress(s, 0, isTaskDone).allTasksDone).toBe(true);
	});
	it("有未完成 → allTasksDone=false", () => {
		const s = makeState({ tasks: [makeTask({ id: 1, status: "in_progress" })] });
		expect(checkProgress(s, 0, isTaskDone).allTasksDone).toBe(false);
	});
	it("maxTurnsReached", () => {
		const s = makeState({ currentTurnIndex: 50, budget: { maxStallTurns: 5, maxTurns: 50 } });
		expect(checkProgress(s, 0, isTaskDone).maxTurnsReached).toBe(true);
	});
	it("isStalled：本 round 无进展", () => {
		const s = makeState({ tasks: [makeTask({ id: 1, status: "completed" })], currentTurnIndex: 5 });
		expect(checkProgress(s, 1, isTaskDone).isStalled).toBe(true);
	});
	it("budgetTight：tokensUsed >= 80%", () => {
		const s = makeState({ tokensUsed: 850, budget: { maxStallTurns: 5, maxTurns: 50, tokenBudget: 1000 } });
		expect(checkProgress(s, 0, isTaskDone).budgetTight).toBe(true);
	});
});

// ── 百分比 + 颜色 ────────────────────────────────────

describe("getTokenUsagePercent / getTimeUsagePercent", () => {
	it("无 tokenBudget → 0", () => expect(getTokenUsagePercent(makeState())).toBe(0));
	it("50% token", () => {
		expect(getTokenUsagePercent(makeState({ tokensUsed: 500, budget: { maxStallTurns: 5, maxTurns: 50, tokenBudget: 1000 } }))).toBe(50);
	});
	it("无 timeBudgetMinutes → 0", () => expect(getTimeUsagePercent(makeState(), 100)).toBe(0));
	it("50% time", () => {
		expect(getTimeUsagePercent(makeState({ budget: { maxStallTurns: 5, maxTurns: 50, timeBudgetMinutes: 10 } }), 300)).toBe(50);
	});
});

describe("getBudgetColor", () => {
	it(">=90 → error", () => expect(getBudgetColor(90)).toBe("error"));
	it(">=70 → warning", () => expect(getBudgetColor(70)).toBe("warning"));
	it("<70 → muted", () => expect(getBudgetColor(69)).toBe("muted"));
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @zhushanwen/pi-goal test src/engine/__tests__/budget.test.ts`
预期：FAIL，`Cannot find module '../budget'`

- [ ] **步骤 3：编写 engine/budget.ts**

创建 `extensions/goal/src/engine/budget.ts`：

```typescript
/**
 * Budget 决策引擎 — 纯函数
 *
 * 零 Pi 依赖。import from "./types" 和 "./task"。
 *
 * FR-6.5: tick 是纯函数（不调 Date.now，不查 status）
 * FR-6.2: checkBudgetOnTurnEnd 用 4 个独立 flag
 * FR-8.6: accumulateTokens token 累加算法
 */

import type { GoalTask } from "./task";
import { getCompletedCount } from "./task";
import type { GoalRuntimeState } from "./types";

// ── 常量（engine 内部，保持自洽）──────────────────────

const RATIO_HIGH = 0.9;
const RATIO_LOW = 0.7;
const RATIO_TIGHT = 0.8;
const PERCENT_FACTOR = 100;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

// ── 类型 ────────────────────────────────────────────

export interface TokenUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	totalTokens?: number;
}

export interface TickResult {
	timeUsedSeconds: number;
	timeStartedAt: number;
}

export type BudgetDecision =
	| { type: "warning70"; dimension: "token" | "time" }
	| { type: "warning90"; dimension: "token" | "time" };

export interface BudgetCheckResult {
	terminal: { type: "exceeded"; dimension: "token" | "time" } | null;
	warnings: BudgetDecision[];
	shouldSendSteering: boolean;
}

export interface ProgressCheck {
	allTasksDone: boolean;
	noTasksCreated: boolean;
	maxTurnsReached: boolean;
	isStalled: boolean;
	budgetTight: boolean;
	completedCount: number;
	totalCount: number;
}

// ── token 累加（FR-8.6）──────────────────────────────

export function accumulateTokens(currentTokensUsed: number, usage: TokenUsage): number {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	if (input > 0 || output > 0) {
		return currentTokensUsed + Math.max(input - cacheRead, 0) + output;
	}
	return currentTokensUsed + (usage.totalTokens ?? 0);
}

// ── 时间累计（FR-6.5 纯函数）──────────────────────────

export function tick(
	timeStartedAt: number,
	timeUsedSeconds: number,
	now: number,
	isRunning: boolean,
): TickResult {
	if (isRunning && timeStartedAt > 0) {
		const elapsed = (now - timeStartedAt) / MS_PER_SECOND;
		return { timeUsedSeconds: timeUsedSeconds + elapsed, timeStartedAt: now };
	}
	return { timeUsedSeconds, timeStartedAt: now };
}

// ── 百分比计算 ───────────────────────────────────────

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
	if (percent >= RATIO_HIGH * PERCENT_FACTOR) return "error";
	if (percent >= RATIO_LOW * PERCENT_FACTOR) return "warning";
	return "muted";
}

// ── turn end 预算检查（FR-6.2 维度独立）───────────────

export function checkBudgetOnTurnEnd(state: GoalRuntimeState, timeUsedSeconds: number): BudgetCheckResult {
	const result: BudgetCheckResult = { terminal: null, warnings: [], shouldSendSteering: false };

	// token 维度
	if (state.budget.tokenBudget) {
		const tokenPct = state.tokensUsed / state.budget.tokenBudget;
		if (tokenPct >= 1 && state.budgetLimitSteeringSent) {
			result.terminal = { type: "exceeded", dimension: "token" };
			return result;
		}
		if (tokenPct >= RATIO_HIGH && !state.budgetLimitSteeringSent) {
			result.shouldSendSteering = true;
		} else if (tokenPct >= RATIO_HIGH && !state.tokenWarning90Sent) {
			result.warnings.push({ type: "warning90", dimension: "token" });
		} else if (tokenPct >= RATIO_LOW && !state.tokenWarning70Sent) {
			result.warnings.push({ type: "warning70", dimension: "token" });
		}
	}

	// time 维度（FR-6.2: 独立 flag，不被 token 吞）
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

// ── resume 预算重检 ──────────────────────────────────

export function checkBudgetOnResume(state: GoalRuntimeState): { type: "exceeded"; dimension: "token" | "time" } | null {
	if (state.budget.tokenBudget && state.tokensUsed >= state.budget.tokenBudget) {
		return { type: "exceeded", dimension: "token" };
	}
	if (state.budget.timeBudgetMinutes) {
		if (state.timeUsedSeconds >= state.budget.timeBudgetMinutes * SECONDS_PER_MINUTE) {
			return { type: "exceeded", dimension: "time" };
		}
	}
	return null;
}

// ── 进度检查（isTaskDoneFn 注入）─────────────────────

export function checkProgress(
	state: GoalRuntimeState,
	tasksCompletedAtStart: number,
	isTaskDoneFn: (task: GoalTask) => boolean,
): ProgressCheck {
	const incomplete = state.tasks.filter((t) => !isTaskDoneFn(t));
	const completedCount = getCompletedCount(state.tasks);
	const totalCount = state.tasks.length;
	return {
		allTasksDone: totalCount > 0 && incomplete.length === 0 && completedCount > 0,
		noTasksCreated: totalCount === 0,
		maxTurnsReached: state.currentTurnIndex >= state.budget.maxTurns,
		isStalled: completedCount - tasksCompletedAtStart === 0,
		budgetTight: Boolean(state.budget.tokenBudget && state.tokensUsed >= state.budget.tokenBudget * RATIO_TIGHT),
		completedCount,
		totalCount,
	};
}
```

> **FR-6.2 修复要点**：旧版 `checkBudgetOnTurnEnd` 在 token steering 命中时直接 `return`，跳过 time 维度检查。新版不再 return，steering 设置后继续检查 time——修复"time 预警被 token 吞"的 bug。

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm --filter @zhushanwen/pi-goal test src/engine/__tests__/budget.test.ts`
预期：PASS

- [ ] **步骤 5：typecheck + 验证**

```bash
pnpm --filter @zhushanwen/pi-goal typecheck
grep -rn "@mariozechner\|@earendil" extensions/goal/src/engine/
grep -n "Date.now\|\.status" extensions/goal/src/engine/budget.ts
```
预期：typecheck 零错误；engine 零 Pi import；budget.ts 内无 `Date.now()` 调用，不读 `state.status`。

- [ ] **步骤 6：提交**

```bash
git add extensions/goal/src/engine/budget.ts extensions/goal/src/engine/__tests__/budget.test.ts
git commit -m "wave-2: add engine/budget.ts — pure budget decisions, FR-6.2 independent warnings, FR-6.5 tick, FR-8.6 token accumulation"
```
