# Wave 11: adapters/command-adapter.ts

- **目标文件**：
  - 创建：`extensions/goal/src/adapters/command-adapter.ts`
- **前置 wave**：Wave 5（service.ts）、Wave 7（projection/prompts.ts）
- **目标**：迁移 8 个 /goal 子命令 handler。调 service.createGoal / service.finalizeGoal。

## 关键行为契约

- **FR-8.12 关键**：handleSet 创建后调 `pi.sendUserMessage(objective, { deliverAs: "followUp" })` 触发 AI；handleResume 有未完成任务时同样调 sendUserMessage
- **FR-8.7 G-R2-008**：handleSet 覆盖非终态旧 goal 写 cancelled history；覆盖终态旧 goal 快速路径（不写 history）
- **FR-8.4 G-002**：handleUpdate 走重塑（重置 objective/tasks/budget flags/stallCount/currentTurnIndex，保留 goalId）
- **FR-6.3**：clear（强制）/abort（检查未完成）语义保留

---

- [ ] **步骤 1：编写 command-adapter.ts**

创建 `extensions/goal/src/adapters/command-adapter.ts`：

```typescript
/**
 * /goal 命令适配器 — 8 个子命令 handler
 *
 * 迁移自 src/command-handler.ts。改动：
 * - 状态变更调 service（createGoal / finalizeGoal）
 * - import 类型自 engine 层
 * - FR-8.12: set/resume 后 sendUserMessage 触发 AI（保持不变）
 *
 * adapters 层可 import Pi 类型（桥接 Pi 和 service）。
 */

import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { checkBudgetOnResume } from "../engine/budget";
import { createGoalState, isActiveStatus, isTerminalStatus, transitionStatus } from "../engine/goal";
import { getCompletedCount, getIncompleteTasks, isTaskDone } from "../engine/task";
import type { BudgetConfig, GoalRuntimeState } from "../engine/types";
import { makeHistoryEntry, serializeState } from "../persistence";
import type { GoalSession } from "../session";
import { clearGoalSession } from "../session";
import { createGoal, finalizeGoal, type ServicePorts } from "../service";
import { parseGoalArgs } from "../commands";
import { objectiveUpdatedPrompt } from "../projection/prompts";
import {
	OBJECTIVE_DISPLAY_LIMIT,
	OBJECTIVE_TRUNCATE_KEEP,
	SECONDS_PER_MINUTE,
} from "../constants";
import { DEFAULT_BUDGET } from "../engine/types";

// ── Orchestrator ──────────────────────────────────────

export async function handleGoalCommand(
	pi: ExtensionAPI,
	session: GoalSession,
	args: string | undefined,
	ctx: ExtensionContext,
): Promise<void> {
	const parsed = parseGoalArgs(args ?? "");
	switch (parsed.action) {
		case "status": return handleStatus(session, ctx);
		case "pause": return handlePause(pi, session, ctx);
		case "resume": return handleResume(pi, session, ctx);
		case "history": return handleHistory(ctx);
		case "clear": return handleClear(pi, session, ctx);
		case "abort": return handleAbort(pi, session, ctx);
		case "update": return handleUpdate(pi, session, parsed.objective, ctx);
		case "set": return handleSet(pi, session, parsed.objective ?? "", parsed.budget, ctx);
	}
}

// ── 辅助：从 ctx 构造 ServicePorts ────────────────────

function makePorts(pi: ExtensionAPI, ctx: ExtensionContext): ServicePorts {
	return {
		persistence: {
			appendState: (state) => pi.appendEntry("goal-state", serializeState(state)),
			appendHistory: (entry) => pi.appendEntry("goal-history", entry),
		},
		ui: {
			setWidget: (name, content) => ctx.ui.setWidget(name, content),
			setStatus: (name, text) => ctx.ui.setStatus(name, text),
			notify: (text, level) => ctx.ui.notify(text, level),
			hasUI: ctx.hasUI,
		},
		messaging: {
			sendContextMessage: (content, deliverAs, customType) => {
				pi.sendMessage({ customType: customType ?? "goal-context", content, display: false }, { deliverAs });
			},
			sendUserMessage: (content, deliverAs) => pi.sendUserMessage(content, { deliverAs }),
		},
		session: {
			getEntries: () => ctx.sessionManager.getEntries(),
			spliceEntry: (idx, count) => ctx.sessionManager.getBranch().splice(idx, count),
			getContextUsage: () => ctx.getContextUsage(),
			signal: ctx.signal,
		},
	};
}

// ── /goal status ──────────────────────────────────────

function handleStatus(session: GoalSession, ctx: ExtensionContext): void {
	if (!session.state) {
		ctx.ui.notify("Goal mode not active. Use /goal <objective> to start.", "info");
		return;
	}
	const state = session.state;
	const completed = getCompletedCount(state.tasks);
	const total = state.tasks.length;
	const lines = [
		`Objective: ${state.objective}`,
		`Status: ${state.status}`,
		`Turn: ${state.currentTurnIndex}/${state.budget.maxTurns}`,
		`Tasks: ${completed}/${total} completed`,
		`Stall turns: ${state.stallCount}`,
		`Time elapsed: ${Math.floor(state.timeUsedSeconds / SECONDS_PER_MINUTE)}m${Math.floor(state.timeUsedSeconds % SECONDS_PER_MINUTE)}s`,
		state.budget.tokenBudget ? `Token: ${state.tokensUsed}/${state.budget.tokenBudget}` : null,
		`Goal ID: ${state.goalId}`,
	].filter(Boolean);
	ctx.ui.notify(lines.join("\n"), "info");
}

// ── /goal pause ───────────────────────────────────────

function handlePause(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext): void {
	if (!session.state) { ctx.ui.notify("Goal mode not active.", "warning"); return; }
	if (isTerminalStatus(session.state.status)) {
		ctx.ui.notify(`Goal is in terminal state (${session.state.status}), cannot pause.`, "warning");
		return;
	}
	session.state.status = transitionStatus(session.state.status, "paused");
	makePorts(pi, ctx).persistence.appendState(serializeState(session.state));
	ctx.ui.notify("Goal paused. Use /goal resume to continue.", "info");
}

// ── /goal resume ──────────────────────────────────────

function handleResume(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext): void {
	if (!session.state) { ctx.ui.notify("Goal mode not active.", "warning"); return; }
	const state = session.state;
	if (isTerminalStatus(state.status)) {
		ctx.ui.notify(`Goal is in terminal state (${state.status}), cannot resume.`, "warning");
		return;
	}
	if (state.status !== "paused" && state.status !== "blocked") {
		ctx.ui.notify("Goal is not paused or blocked, no need to resume.", "info");
		return;
	}
	state.status = "active";
	state.stallCount = 0;
	state.timeStartedAt = Date.now();

	// FR-8.3 G-014: resume 时 budget 重检
	const resumeCheck = checkBudgetOnResume(state);
	if (resumeCheck) {
		const dim = resumeCheck.dimension;
		state.status = transitionStatus(state.status, dim === "token" ? "budget_limited" : "time_limited");
		makePorts(pi, ctx).persistence.appendState(serializeState(state));
		ctx.ui.notify(`${dim === "token" ? "Token" : "Time"} budget exhausted, cannot resume. Use /goal clear to reset.`, "warning");
		return;
	}
	makePorts(pi, ctx).persistence.appendState(serializeState(state));

	// FR-8.12 并行模式：resume 有未完成任务时触发 AI
	const incomplete = getIncompleteTasks(state.tasks);
	if (incomplete.length > 0) {
		pi.sendUserMessage(
			`Goal resumed. Continuing with ${incomplete.length} remaining tasks.` +
			(state.lastBlockerReason ? `\n\nPrevious blocker: ${state.lastBlockerReason}. Try a different approach.` : "") +
			`\n\nObjective: ${state.objective}`,
			{ deliverAs: "followUp" },
		);
	} else {
		ctx.ui.notify("All tasks completed.", "info");
	}
}

// ── /goal history ─────────────────────────────────────

function handleHistory(ctx: ExtensionContext): void {
	const entries = ctx.sessionManager.getEntries();
	const historyEntries = entries.filter(
		(e) => e.type === "custom" && (e as CustomEntry).customType === "goal-history",
	) as Array<CustomEntry<{ goalId: string; objective: string; status: string; completedTasks: number; totalTasks: number; elapsedSeconds: number; timestamp: number }>>;

	if (historyEntries.length === 0) {
		ctx.ui.notify("No goal history", "info");
		return;
	}
	const sorted = [...historyEntries].reverse();
	const lines: string[] = ["Goal history:\n"];
	for (let i = 0; i < sorted.length; i++) {
		const h = sorted[i]!.data;
		if (!h) continue;
		const icon = h.status === "complete" ? "✓" : h.status === "cancelled" ? "✗" : h.status === "budget_limited" ? "⊗" : h.status === "time_limited" ? "⏱" : "?";
		const obj = h.objective.length > OBJECTIVE_DISPLAY_LIMIT ? h.objective.slice(0, OBJECTIVE_TRUNCATE_KEEP) + "..." : h.objective;
		const mins = Math.floor(h.elapsedSeconds / SECONDS_PER_MINUTE);
		const secs = Math.floor(h.elapsedSeconds % SECONDS_PER_MINUTE);
		lines.push(`${i + 1}. ${icon} ${obj}`);
		lines.push(`   ${h.completedTasks}/${h.totalTasks} tasks | ${mins}m${secs}s | ${h.status}`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

// ── /goal clear（强制清）──────────────────────────────

function handleClear(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext): void {
	if (!session.state) { ctx.ui.notify("Goal mode not active.", "info"); return; }
	const ports = makePorts(pi, ctx);
	const completedCount = getCompletedCount(session.state.tasks);
	finalizeGoal(session.state, "cancelled", ports, { clearImmediately: true, completedTasks: completedCount });
	ports.persistence.appendState(serializeState(session.state)); // 注意：finalizeGoal 不 persist
	clearGoalSession(session, ports.ui);
	ctx.ui.notify("Goal cleared.", "info");
}

// ── /goal abort（检查未完成）──────────────────────────

function handleAbort(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext): void {
	if (!session.state) { ctx.ui.notify("Goal mode not active.", "info"); return; }
	if (isTerminalStatus(session.state.status)) {
		ctx.ui.notify(`Goal is already in terminal state (${session.state.status}).`, "warning");
		return;
	}
	// FR-6.3: 有未完成任务拒绝
	if (session.state.tasks.length > 0) {
		const nonCancelled = session.state.tasks.filter((t) => t.status !== "cancelled");
		if (nonCancelled.length > 0) {
			ctx.ui.notify(`Cannot abort: ${nonCancelled.length} non-cancelled tasks exist. Use /goal clear to force cancel.`, "warning");
			return;
		}
	}
	const ports = makePorts(pi, ctx);
	const completedCount = getCompletedCount(session.state.tasks);
	finalizeGoal(session.state, "cancelled", ports, { clearImmediately: true, completedTasks: completedCount });
	ports.persistence.appendState(serializeState(session.state));
	clearGoalSession(session, ports.ui);
	ctx.ui.notify("Goal aborted: no work needed.", "info");
}

// ── /goal update（重塑）──────────────────────────────

function handleUpdate(pi: ExtensionAPI, session: GoalSession, newObjective: string | undefined, ctx: ExtensionContext): void {
	if (!session.state) { ctx.ui.notify("Goal mode not active.", "warning"); return; }
	if (!newObjective) { ctx.ui.notify("Usage: /goal update <new-objective>", "warning"); return; }
	const state = session.state;
	const oldObjective = state.objective;
	// FR-8.4 G-002: 重塑（重置，保留 goalId）
	state.objective = newObjective;
	state.objectiveUpdatedAt = Date.now();
	state.tasks = [];
	state.stallCount = 0;
	state.currentTurnIndex = 0;
	state.lastProgressTurn = 0;
	state.budgetLimitSteeringSent = false;
	state.tokenWarning70Sent = false;
	state.tokenWarning90Sent = false;
	state.timeWarning70Sent = false;
	state.timeWarning90Sent = false;
	session.tasksCompletedAtAgentStart = 0;
	makePorts(pi, ctx).persistence.appendState(serializeState(state));
	ctx.ui.notify(`Objective updated:\nPrevious: ${oldObjective}\nNew: ${newObjective}`, "info");

	if (isActiveStatus(state.status)) {
		const ports = makePorts(pi, ctx);
		ports.messaging.sendContextMessage(objectiveUpdatedPrompt(state, oldObjective), "steer");
	}
}

// ── /goal set（创建）─────────────────────────────────

function handleSet(pi: ExtensionAPI, session: GoalSession, objective: string, budgetOverrides: Partial<BudgetConfig> | undefined, ctx: ExtensionContext): void {
	if (!objective) { ctx.ui.notify("Usage: /goal <objective> [--tokens N] [--timeout N]", "warning"); return; }
	if (!objective.trim()) { ctx.ui.notify("Objective cannot be empty.", "warning"); return; }
	const ports = makePorts(pi, ctx);

	// FR-8.7 G-R2-008: 覆盖已有 goal 的两分支
	if (session.state && !isTerminalStatus(session.state.status)) {
		// 非终态旧 goal：写 cancelled history
		ctx.ui.notify(`Cancelled previous Goal: ${session.state.objective}\n(new goal started)`, "info");
		const completedCount = getCompletedCount(session.state.tasks);
		finalizeGoal(session.state, "cancelled", ports, { clearImmediately: false, completedTasks: completedCount });
		ports.persistence.appendState(serializeState(session.state));
	}
	// 终态旧 goal：快速路径（不写 history，直接覆盖）

	if (budgetOverrides?.tokenBudget !== undefined && budgetOverrides.tokenBudget <= 0) {
		ctx.ui.notify("Token budget must be greater than 0.", "warning");
		return;
	}
	const budget: Partial<BudgetConfig> = {};
	if (budgetOverrides?.tokenBudget) budget.tokenBudget = budgetOverrides.tokenBudget;
	if (budgetOverrides?.timeBudgetMinutes) budget.timeBudgetMinutes = budgetOverrides.timeBudgetMinutes;
	budget.maxTurns = budgetOverrides?.maxTurns ?? DEFAULT_BUDGET.maxTurns;
	budget.maxStallTurns = budgetOverrides?.maxStallTurns ?? DEFAULT_BUDGET.maxStallTurns;

	// FR-3.1: 唯一创建入口
	createGoal(session, objective, [], budget, ports, false);
	session.tasksCompletedAtAgentStart = 0;

	const budgetNotice: string[] = [];
	if (budget.tokenBudget) budgetNotice.push(`Token budget: ${budget.tokenBudget}`);
	if (budget.timeBudgetMinutes) budgetNotice.push(`Time budget: ${budget.timeBudgetMinutes} min`);
	ctx.ui.notify(["Goal started: " + objective, `Max turns: ${budget.maxTurns}`, ...budgetNotice].join("\n"), "info");

	// FR-8.12: 创建后触发 AI（整个 goal workflow 的启动机制）
	pi.sendUserMessage(objective, { deliverAs: "followUp" });
}
```

> **注意**：
> 1. `makePorts` 在每个 handler 内构造——这是 adapter 的职责（桥接 Pi ctx 到 service ports）。Wave 14 的 index.ts 可以抽取共用 makePorts，但本 wave 先内联保持简单。
> 2. `handleClear` / `handleAbort` 调 `finalizeGoal` 后手动 `appendState`——因为 finalizeGoal 只设状态不 persist（persist 是 service/adapter 职责）。clearSession 紧随其后清空 session。
> 3. `handleSet` 调 `createGoal(session, objective, [], budget, ports, false)`——传空 tasks 数组（set 时不预填 task，AI 后续调 create_tasks）。这与 `__goalInit` 不同（后者传 tasks）。

- [ ] **步骤 2：typecheck**

运行：`pnpm --filter @zhushanwen/pi-goal typecheck`
预期：零错误。

- [ ] **步骤 3：提交**

```bash
git add extensions/goal/src/adapters/command-adapter.ts
git commit -m "wave-11: add command-adapter.ts — 8 /goal subcommands, FR-8.12 set/resume AI trigger, FR-8.7 set override branches"
```

---

## 验收标准

### 1. 测试

- [x] **无独立单元测试**——command handler 是 Pi ctx 桥接，由 Wave 14 集成测试覆盖
- [x] `pnpm --filter @zhushanwen/pi-goal typecheck` 零错误
- [x] 全量 `test` 仍全绿（253 tests passed）

> ⚠️ **风险提示**：handleSet 有 FR-8.7 双分支（非终态写 cancelled history vs 终态快速路径）+ FR-8.12 AI 触发，是命令路径最复杂处。建议执行者用 fake pi（mock sendUserMessage / appendEntry）补 command-adapter.test.ts 覆盖 set 的两分支。

### 2. 架构边界

- [x] `grep -rn "\.\./state\|\.\./command-handler" extensions/goal/src/adapters/command-adapter.ts` 无输出（不 import 旧文件）
- [x] adapters 层可 import Pi 类型（`ExtensionAPI` / `ExtensionContext` / `CustomEntry`）
- [x] 禁止 `any`

### 3. 接口契约

- [x] 导出 `handleGoalCommand` 分发器（内部 8 个函数：handleStatus / handlePause / handleResume / handleHistory / handleClear / handleAbort / handleUpdate / handleSet）
- [~] 导出 `makePorts(pi, ctx): ServicePorts`：**实现修正 2**——不重复定义，复用 Wave 10 `tool-adapter.ts` export 的 `buildPorts`（DRY 单一 ports 桥接点）。Wave 11 把 tool-adapter 的 `buildPorts` 由 private 改为 export。

### 4. 行为契约

- [x] FR-8.12：handleSet 创建后调 `pi.sendUserMessage(objective, { deliverAs: "followUp" })`；handleResume 有未完成任务时同样调 sendUserMessage
- [x] FR-8.7 G-R2-008：handleSet 覆盖非终态旧 goal 写 cancelled history；覆盖终态旧 goal 快速路径（不写 history）
- [x] FR-8.4 G-002：handleUpdate 重塑（重置 objective/tasks/budget flags/stallCount/currentTurnIndex/lastProgressTurn + tasksCompletedAtAgentStart，保留 goalId）
- [x] FR-6.3：clear（强制清，不检查未完成）/ abort（检查未完成，有非 cancelled task 则拒绝）语义

### 5. 提交

- [x] commit message 以 `wave-11:` 开头，含「8 /goal subcommands」+「FR-8.12」+「FR-8.7」

---

## 实现修正记录

1. **import 不带 `.js` 后缀**：plan 多处写 `from "../engine/budget.js"` 等，实现改为无后缀，与新层（service.ts / projection/* / actions.ts / tool-adapter.ts）保持一致（`moduleResolution: "bundler"` 接受）。
2. **ports 桥接复用 Wave 10 的 `buildPorts`（DRY）**：plan 在 command-adapter 内联 `makePorts`（与 tool-adapter 的 buildPorts 几乎相同）。实现改为把 tool-adapter.ts 的 `buildPorts` 由 private 改为 `export`，command-adapter import 复用。避免重复定义，单一 ports 桥接点。Wave 12 event-adapter 同样可复用。
3. **删除 4 个未使用 import**：plan 引入 `GoalRuntimeState` / `makeHistoryEntry` / `ServicePorts` / `createGoalState` 但代码未用（finalizeGoal 内部已调 makeHistoryEntry；createGoal 内部已调 createGoalState）。eslint `no-unused-vars` 报错，全部删除。
4. **history entries 类型谓词**：plan 用 `as Array<CustomEntry<{...}>>` 双断言。实现改用 type guard `(e): e is CustomEntry<GoalHistoryData> => ...` 收敛类型（更安全，且把 inline 类型提取为 `GoalHistoryData` interface 提升可读性）。
5. **handleStatus `lines.filter(Boolean)` 显式类型**：plan 用 `string[]` + `null` 元素，TS 推断为 `(string | null)[]`。实现改用 `Array<string | null>` 显式标注，`filter(Boolean)` 后 join 安全。
6. **budgetNotice / blockerNote 字符串拼接**：plan 用多行字符串拼接带 `\n\n`，实现用模板字符串 + 条件拼接（`blockerNote` 变量），可读性等价但 lint 干净（无隐式换行 magic）。
