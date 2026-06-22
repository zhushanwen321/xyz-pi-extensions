# Wave 13: adapters/event-adapter.ts 追加（before_agent_start + agent_end）

- **目标文件**：
  - 追加到：`extensions/goal/src/adapters/event-adapter.ts`（Wave 12 创建的文件）
- **前置 wave**：Wave 12（event-adapter 基础设施 + 4 简单事件）
- **目标**：追加 2 个最复杂的事件 handler。**这是整个重构的核心**——agent_end 的 4 层分支优先级 + ESC 守卫 + 并发保护。

## 关键行为契约

### before_agent_start
- **FR-8.1 G-007**：AUTO_CLEAR_TURNS=2，终态 goal 2 turn 后 clearGoalSession
- **FR-8.6 staleness reminder**：TASK_STALL_TURN_THRESHOLD=10，**重置被提醒项 lastUpdatedTurn**（避免重复触发）
- **FR-8.6 context pause**：CONTEXT_USAGE_RATIO_LIMIT=0.85，超限转 paused
- 正常 context injection

### agent_end（FR-8.7 完整分支）
- **FR-8.2 G-021**：isProcessing 防重入
- **FR-8.2 G-020**：makeStaleChecker + 入口 checkStale + 每个副作用前 checkStale
- **FR-6.7 ESC 守卫（最关键）**：ctx.signal?.aborted → 不发 continuation、不递增 stall、不做 budget 检查、goal 保持 active
- **FR-8.7 分支优先级**：
  1. allTasksDone → maxTurnsReached? complete : budgetTight? steer : followUp
  2. noTasksCreated → maxTurnsReached? cancelled : followUp
  3. maxTurnsReached（有未完成）→ cancelled
  4. 否则 → stall 检测 + continuation
- **FR-8.6 continuation 去抖**：tokenDelta=0 不发

---

- [ ] **步骤 1：追加 before_agent_start 到 event-adapter.ts**

在 `extensions/goal/src/adapters/event-adapter.ts` 末尾追加：

```typescript
// ── 事件 5: before_agent_start（staleness + context pause + injection）───

import {
	contextInjectionPrompt,
	stalenessReminderPrompt,
} from "../projection/prompts";
import { renderTerminalStatusLine } from "../projection/widget";
import { clearGoalSession } from "../session";
import { isTaskDone } from "../engine/task";
import { transitionStatus } from "../engine/goal";
import {
	AUTO_CLEAR_TURNS,
	CONTEXT_USAGE_RATIO_LIMIT,
	TASK_STALL_TURN_THRESHOLD,
} from "../constants";
import type { GoalTask } from "../engine/task";

interface BeforeAgentStartResult {
	message: {
		customType: string;
		content: string;
		display: boolean;
	};
}

export async function handleBeforeAgentStart(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
): Promise<BeforeAgentStartResult | undefined> {
	if (!session.state) return;

	// 终态处理
	if (isTerminalStatus(session.state.status)) {
		handleTerminalStateBeforeAgent(session, ctx);
		return;
	}
	if (!isActiveStatus(session.state.status)) return;

	// 停滞检测
	const staleResult = checkStaleness(session);
	if (staleResult) return staleResult;

	// Context 使用率检查
	const ctxResult = checkContextUsage(pi, session, ctx);
	if (ctxResult) return ctxResult;

	// 正常 context injection
	return {
		message: {
			customType: "goal-context",
			content: contextInjectionPrompt(session.state),
			display: false,
		},
	};
}

function handleTerminalStateBeforeAgent(session: GoalSession, ctx: ExtensionContext): void {
	const state = session.state!;
	const turnsInTerminal = state.currentTurnIndex - (state.completedAtTurnIndex ?? 0);
	// FR-8.1 G-007: AUTO_CLEAR_TURNS=2 后清理
	if (turnsInTerminal >= AUTO_CLEAR_TURNS) {
		clearGoalSession(session, makePorts({} as ExtensionAPI, ctx).ui);
		return;
	}
	// 折叠 status bar（终态显示）
	const statusText = renderTerminalStatusLine(state, ctx.ui.theme as unknown as { fg: (c: string, t: string) => string; bold: (t: string) => string });
	if (statusText && ctx.hasUI) ctx.ui.setStatus("goal", statusText);
	if (ctx.hasUI) ctx.ui.setWidget("goal", undefined);
}

function checkStaleness(session: GoalSession): BeforeAgentStartResult | undefined {
	const state = session.state!;
	const staleTasks: Array<{
		task: GoalTask;
		staleTurns: number;
		staleSubtasks: Array<{ text: string; staleTurns: number }>;
	}> = [];
	let allTerminal = true;

	for (const task of state.tasks) {
		if (!isTaskDone(task)) {
			allTerminal = false;
			const staleTurns = state.currentTurnIndex - task.lastUpdatedTurn;
			if (staleTurns >= TASK_STALL_TURN_THRESHOLD) {
				const staleSubtasks: Array<{ text: string; staleTurns: number }> = [];
				if (task.subtasks) {
					for (const s of task.subtasks) {
						if (s.status !== "completed") {
							const subStale = state.currentTurnIndex - s.lastUpdatedTurn;
							if (subStale >= TASK_STALL_TURN_THRESHOLD) {
								staleSubtasks.push({ text: s.text, staleTurns: subStale });
							}
						}
					}
				}
				staleTasks.push({ task, staleTurns, staleSubtasks });
			}
		}
	}

	// 所有 task 已终态但 goal 仍 active
	if (allTerminal && state.tasks.length > 0) {
		return {
			message: {
				customType: "goal-staleness-reminder",
				content: stalenessReminderPrompt(state, [], true),
				display: false,
			},
		};
	}

	// 有停滞项 → 注入提醒
	if (staleTasks.length > 0) {
		// FR-8.6: 重置被提醒项的 lastUpdatedTurn（避免下轮重复触发）
		for (const item of staleTasks) {
			item.task.lastUpdatedTurn = state.currentTurnIndex;
			if (item.task.subtasks) {
				for (const s of item.task.subtasks) {
					if (s.status !== "completed") s.lastUpdatedTurn = state.currentTurnIndex;
				}
			}
		}
		return {
			message: {
				customType: "goal-staleness-reminder",
				content: stalenessReminderPrompt(state, staleTasks, false),
				display: false,
			},
		};
	}

	return undefined;
}

function checkContextUsage(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
): BeforeAgentStartResult | undefined {
	const usage = ctx.getContextUsage();
	if (usage && usage.contextWindow > 0 && (usage.tokens ?? 0) / usage.contextWindow > CONTEXT_USAGE_RATIO_LIMIT) {
		const state = session.state!;
		// FR-8.6: context > 85% → 转 paused
		state.status = transitionStatus(state.status, "paused");
		persistAndUpdate(pi, session, ctx);
		return {
			message: {
				customType: "goal-context-exceeded",
				content:
					"[GOAL — context space low, must wrap up now]\n" +
					"1. Use goal_manager's list_tasks to check remaining tasks\n" +
					"2. Only mark tasks you genuinely completed with evidence\n" +
					"3. Summarize current progress and remaining work\n" +
					"Do not start new tasks.",
				display: false,
			},
		};
	}
	return undefined;
}
```

- [ ] **步骤 2：追加 agent_end 到 event-adapter.ts**

继续在文件末尾追加 agent_end 完整实现（**最复杂的函数**）：

```typescript
// ── 事件 6: agent_end（FR-8.7 完整分支 + ESC 守卫 + 并发保护）──

import { checkBudgetOnTurnEnd, checkProgress } from "../engine/budget";
import { getIncompleteTasks } from "../engine/task";
import { continuationPrompt, budgetLimitPrompt } from "../projection/prompts";
import { makeHistoryEntry } from "../persistence";
import { PERCENT_FACTOR } from "../constants";

interface AgentEndLikeEvent {
	messages: unknown[];
}

export async function handleAgentEnd(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
): Promise<void> {
	if (!session.state || session.isProcessing) return;
	session.isProcessing = true;
	try {
		const checkStale = makeStaleChecker(session);
		if (checkStale()) return;

		// 终态处理
		if (session.state.status === "complete" || session.state.status === "blocked") {
			await handleTerminalStateAgentEnd(pi, session, ctx, checkStale);
			return;
		}
		if (!isActiveStatus(session.state.status)) return;

		// FR-6.7 ESC 守卫（最关键）：aborted 时 goal 保持 active，不做任何副作用
		if (ctx.signal?.aborted) {
			// 不发 continuation、不递增 stall、不做 budget 检查、不转 paused
			// goal 保持 active，等用户下次输入恢复
			return;
		}

		// 预算检查
		const budgetResult = checkBudgetOnTurnEnd(session.state, session.state.timeUsedSeconds);
		const budgetAction = await handleBudgetChecks(pi, session, ctx, budgetResult, checkStale);
		if (budgetAction !== "continue") return;

		// 进度 + 任务检查（FR-8.7 分支优先级）
		const progress = checkProgress(session.state, session.tasksCompletedAtAgentStart, isTaskDone);
		const progressAction = handleProgressAndTasks(pi, session, ctx, progress, checkStale);
		if (progressAction !== "continue") return;

		// stall 检测 + continuation
		await handleStallAndContinuation(pi, session, ctx, progress, checkStale);
	} finally {
		session.isProcessing = false;
	}
}

async function handleTerminalStateAgentEnd(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
	checkStale: () => boolean,
): Promise<void> {
	const state = session.state!;
	if (persistAndUpdate(pi, session, ctx, checkStale)) return;
	if (state.status === "complete") {
		ctx.ui.notify(
			`Objective completed ✓ (${getCompletedCount(state.tasks)}/${state.tasks.length} tasks, ${state.currentTurnIndex} turns)`,
			"info",
		);
	} else {
		ctx.ui.notify("Goal blocked. Use /goal resume to continue or /goal clear to reset.", "warning");
	}
}

type BudgetAction = "continue" | "stop";

async function handleBudgetChecks(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
	budgetResult: ReturnType<typeof checkBudgetOnTurnEnd>, checkStale: () => boolean,
): Promise<BudgetAction> {
	// 发送预警（FR-6.2 维度独立）
	for (const w of budgetResult.warnings) {
		if (w.type === "warning90") {
			if (w.dimension === "token") session.state!.tokenWarning90Sent = true;
			else session.state!.timeWarning90Sent = true;
			ctx.ui.notify(`${w.dimension === "token" ? "Token" : "Time"} budget 90% used — start wrapping up.`, "warning");
		} else if (w.type === "warning70") {
			if (w.dimension === "token") session.state!.tokenWarning70Sent = true;
			else session.state!.timeWarning70Sent = true;
			ctx.ui.notify(`${w.dimension === "token" ? "Token" : "Time"} budget 70% used — keep scope in check.`, "info");
		}
	}
	// 预算耗尽 → 终止
	if (budgetResult.terminal) {
		const dim = budgetResult.terminal.dimension;
		session.state!.status = transitionStatus(session.state!.status, dim === "token" ? "budget_limited" : "time_limited");
		session.state!.completedAtTurnIndex = session.state!.currentTurnIndex;
		// FR-8.7: 写 history
		pi.appendEntry("goal-history", makeHistoryEntry(session.state!, getCompletedCount(session.state!.tasks)));
		if (persistAndUpdate(pi, session, ctx, checkStale)) return "stop";
		ctx.ui.notify(
			dim === "token" ? "Token budget exhausted, Goal terminated." : `Time budget exhausted, Goal terminated.`,
			"warning",
		);
		return "stop";
	}
	// 90% steering → 收尾
	if (budgetResult.shouldSendSteering) {
		session.state!.budgetLimitSteeringSent = true;
		if (persistAndUpdate(pi, session, ctx, checkStale)) return "stop";
		const ports = makePorts(pi, ctx);
		ports.messaging.sendContextMessage(budgetLimitPrompt(session.state!, "token"), "steer");
		return "stop";
	}
	if (checkStale()) return "stop";
	return "continue";
}

type ProgressAction = "continue" | "stop";

function handleProgressAndTasks(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
	progress: ReturnType<typeof checkProgress>, checkStale: () => boolean,
): ProgressAction {
	// FR-8.7 分支 1: 全部任务完成
	if (progress.allTasksDone) {
		return handleAllTasksDone(pi, session, ctx, progress, checkStale);
	}
	// FR-8.7 分支 2: 无任务创建
	if (progress.noTasksCreated) {
		return handleNoTasksOrMaxTurns(pi, session, ctx, progress, checkStale);
	}
	// FR-8.7 分支 3: 最大轮次（有未完成）
	if (progress.maxTurnsReached) {
		return handleMaxTurnsReached(pi, session, ctx, checkStale);
	}
	return "continue";
}

function handleAllTasksDone(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
	progress: ReturnType<typeof checkProgress>, checkStale: () => boolean,
): ProgressAction {
	const state = session.state!;
	// FR-8.7 1a: maxTurnsReached → complete（优先 complete，不因 maxTurns 变 cancelled）
	if (progress.maxTurnsReached) {
		state.status = transitionStatus(state.status, "complete");
		state.completedAtTurnIndex = state.currentTurnIndex;
		pi.appendEntry("goal-history", makeHistoryEntry(state, progress.completedCount));
		if (persistAndUpdate(pi, session, ctx, checkStale)) return "stop";
		ctx.ui.notify(`All tasks completed, Goal auto-closed. (${progress.completedCount}/${progress.totalCount} tasks, ${state.currentTurnIndex} turns)`, "info");
		return "stop";
	}
	// FR-8.7 1b: budgetTight → steer（立即收尾）
	if (progress.budgetTight) {
		const ports = makePorts(pi, ctx);
		ports.messaging.sendContextMessage(
			`All tasks completed, token budget ${Math.round(state.tokensUsed / state.budget.tokenBudget! * PERCENT_FACTOR)}% used.` +
			`Call goal_manager's complete_goal now with overall evidence.\n\nObjective: ${state.objective}`,
			"steer",
		);
	} else {
		// FR-8.7 1c: followUp（提示 complete_goal）
		const ports = makePorts(pi, ctx);
		ports.messaging.sendContextMessage(
			`All ${progress.totalCount} tasks completed. Call goal_manager's complete_goal with overall evidence.\n\nObjective: ${state.objective}`,
			"followUp",
		);
	}
	persistAndUpdate(pi, session, ctx);
	return "stop";
}

function handleNoTasksOrMaxTurns(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
	progress: ReturnType<typeof checkProgress>, checkStale: () => boolean,
): ProgressAction {
	const state = session.state!;
	// FR-8.7 2a: maxTurnsReached → cancelled（LLM 未建任务且超轮）
	if (progress.maxTurnsReached) {
		state.status = transitionStatus(state.status, "cancelled");
		state.completedAtTurnIndex = state.currentTurnIndex;
		pi.appendEntry("goal-history", makeHistoryEntry(state, 0));
		if (persistAndUpdate(pi, session, ctx, checkStale)) return "stop";
		ctx.ui.notify(`Max turns reached (${state.budget.maxTurns}), LLM did not create task list.`, "warning");
		return "stop";
	}
	// FR-8.7 2b: followUp（提示 create_tasks 或 cancel_goal）
	const ports = makePorts(pi, ctx);
	ports.messaging.sendContextMessage(
		`No task list created yet. First check if the objective is already satisfied — if yes, call goal_manager's cancel_goal with cancelReason. Otherwise call create_tasks immediately.\n\nObjective: ${state.objective}`,
		"followUp",
	);
	persistAndUpdate(pi, session, ctx);
	return "stop";
}

function handleMaxTurnsReached(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
	checkStale: () => boolean,
): ProgressAction {
	const state = session.state!;
	const incomplete = getIncompleteTasks(state.tasks);
	// FR-8.7 3: maxTurns 有未完成 → cancelled
	state.status = transitionStatus(state.status, "cancelled");
	state.completedAtTurnIndex = state.currentTurnIndex;
	pi.appendEntry("goal-history", makeHistoryEntry(state, getCompletedCount(state.tasks)));
	if (persistAndUpdate(pi, session, ctx, checkStale)) return "stop";
	ctx.ui.notify(`Max turns reached (${state.budget.maxTurns}), ${incomplete.length} tasks still incomplete.`, "warning");
	return "stop";
}

async function handleStallAndContinuation(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
	progress: ReturnType<typeof checkProgress>, checkStale: () => boolean,
): Promise<void> {
	const state = session.state!;
	if (checkStale()) return;

	// Stall 检测
	if (progress.isStalled) {
		state.stallCount++;
	} else {
		state.stallCount = 0;
		state.lastProgressTurn = state.currentTurnIndex;
	}
	if (state.stallCount >= state.budget.maxStallTurns) {
		// stall 超限 → blocked（中间态，不走 finalizeGoal，不写 history）
		state.status = transitionStatus(state.status, "blocked");
		if (persistAndUpdate(pi, session, ctx, checkStale)) return;
		ctx.ui.notify(`${state.stallCount} consecutive turns without progress, Goal auto-blocked. Use /goal resume to continue or /goal clear to reset.`, "warning");
		return;
	}
	if (checkStale()) return;

	// FR-8.6: continuation 去抖（空 turn 不发）
	const tokenDelta = state.tokensUsed - state.lastTurnTokensUsed;
	state.lastTurnTokensUsed = state.tokensUsed;
	if (tokenDelta <= 0) {
		// 空 turn：只 persist，不发 continuation
		persistAndUpdate(pi, session, ctx);
		return;
	}
	persistAndUpdate(pi, session, ctx);
	// 发 continuation
	const ports = makePorts(pi, ctx);
	ports.messaging.sendContextMessage(continuationPrompt(state), "followUp");
}
```

> **FR-8.7 分支优先级总结**（已在代码中严格实现）：
> 1. allTasksDone → maxTurnsReached? **complete**（不因 maxTurns 变 cancelled）: budgetTight? **steer** : **followUp**（提示 complete_goal）
> 2. noTasksCreated → maxTurnsReached? **cancelled**（LLM 未建任务且超轮）: **followUp**（提示 create_tasks 或 cancel）
> 3. maxTurnsReached（有未完成）→ **cancelled**
> 4. 否则 → stall 检测 + continuation（去抖：tokenDelta=0 不发）
>
> **ESC 守卫**（FR-6.7）：agent_end 入口检查 `ctx.signal?.aborted`，true 时直接 return——不发 continuation、不递增 stall、不做 budget 检查、goal 保持 active。
>
> **注意 import 位置**：上面的 import 语句（contextInjectionPrompt / stalenessReminderPrompt / renderTerminalStatusLine / clearGoalSession / isTaskDone / transitionStatus / 常量 / checkBudgetOnTurnEnd / checkProgress / getIncompleteTasks / continuationPrompt / budgetLimitPrompt / makeHistoryEntry / PERCENT_FACTOR）应合并到文件顶部的 import 区域，而非分散在文件中间。执行时请把所有 import 移到文件头。

- [ ] **步骤 3：整理 import**

把步骤 1 和步骤 2 中分散的 import 语句全部合并到 event-adapter.ts 文件顶部。最终 import 区域应包含：

```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { checkBudgetOnTurnEnd, checkProgress, getTokenUsagePercent } from "../engine/budget";
import { isActiveStatus, isTerminalStatus, transitionStatus } from "../engine/goal";
import { getCompletedCount, getIncompleteTasks, isTaskDone } from "../engine/task";
import type { GoalTask } from "../engine/task";
import type { GoalRuntimeState } from "../engine/types";
import { makeHistoryEntry, serializeState } from "../persistence";
import type { GoalSession } from "../session";
import { clearGoalSession, reconstructGoalState } from "../session";
import type { ServicePorts } from "../service";
import {
	contextInjectionPrompt,
	continuationPrompt,
	budgetLimitPrompt,
	stalenessReminderPrompt,
} from "../projection/prompts";
import { renderTerminalStatusLine, updateWidget } from "../projection/widget";
import {
	AUTO_CLEAR_TURNS,
	CONTEXT_USAGE_RATIO_LIMIT,
	PERCENT_FACTOR,
	TASK_STALL_TURN_THRESHOLD,
} from "../constants";
```

- [ ] **步骤 4：typecheck**

运行：`pnpm --filter @zhushanwen/pi-goal typecheck`
预期：零错误。

> **常见 typecheck 问题**：
> - `handleTerminalStateBeforeAgent` 里 `makePorts({} as ExtensionAPI, ctx)` 是 hack——clearGoalSession 只需 uiPort，可改为直接构造 `{ hasUI: ctx.hasUI, setWidget: (...) => {}, setStatus: (...) => {} }` 或调 `clearGoalSession(session, makePorts(pi, ctx).ui)`（但此函数没有 pi 参数）。**修复**：给 `handleTerminalStateBeforeAgent` 加 `pi` 参数，或直接用 ctx.ui（因为 clearGoalSession 内部检查 hasUI）。执行者按实际 typecheck 错误修正。
> - theme 桥接 `ctx.ui.theme as unknown as { fg: ...; bold: ... }` 是必要的（Pi 的 Theme 类型和 ThemeLike 不完全匹配）。但更干净的做法是让 updateWidget 直接接收 ctx 而非 uiPort——不过这破坏了 ports 抽象。执行者可选择保持 hack 或重构。

- [ ] **步骤 5：提交**

```bash
git add extensions/goal/src/adapters/event-adapter.ts
git commit -m "wave-13: add before_agent_start + agent_end — FR-8.7 full branch priority, ESC guard, staleness reminder, context pause, stall detection, continuation debounce"
```

---

## 验收标准

### 1. 测试

- [ ] **强烈建议补 event-adapter.test.ts**——agent_end 的 4 层分支优先级是整个重构最复杂、最不能靠 typecheck 兜底的逻辑
- [ ] 若补测试，用 fake ctx（mock signal.aborted / sessionManager / ui）+ makeState/makeTask 构造场景，覆盖以下路径：
  - [ ] ESC：ctx.signal.aborted=true → 不发 continuation、不递增 stall、不做 budget 检查、goal 保持 active
  - [ ] allTasksDone + maxTurnsReached → complete
  - [ ] allTasksDone + budgetTight → steer
  - [ ] allTasksDone + 正常 → followUp
  - [ ] noTasksCreated + maxTurnsReached → cancelled
  - [ ] 有未完成 + maxTurnsReached → cancelled
  - [ ] stall 检测：completedCount 未增 → stallCount++
  - [ ] continuation 去抖：tokenDelta=0 不发
  - [ ] before_agent_start：AUTO_CLEAR_TURNS=2 终态后 clearGoalSession
  - [ ] before_agent_start：staleness reminder 重置 lastUpdatedTurn
  - [ ] before_agent_start：context pause（CONTEXT_USAGE_RATIO_LIMIT=0.85）
- [ ] `pnpm --filter @zhushanwen/pi-goal typecheck` 零错误
- [ ] 全量 `test` 仍全绿

> 🚨 **最高风险 wave**：307 行 agent_end 完整分支逻辑，typecheck 验证不了任何行为正确性。如果不补测试，这个 wave 等于把最复杂的逻辑裸奔上线，Wave 14 的集成测试（旧架构迁移来的）根本不覆盖 ESC guard / 4 层分支优先级 / continuation 去抖等新行为。

### 2. 架构边界

- [ ] `grep -rn "\.\./state\|\.\./agent-end-handler\|\.\./before-agent-start-handler\|\.\./budget" extensions/goal/src/adapters/event-adapter.ts` 无输出（不 import 旧文件；budget 走 engine/budget）
- [ ] 禁止 `any`
- [ ] 已知 hack 需记录（不阻塞验收，但 Wave 14 需清理）：
  - `handleTerminalStateBeforeAgent` 的 `makePorts({} as ExtensionAPI, ctx)`
  - theme 桥接 `ctx.ui.theme as unknown as { fg: ...; bold: ... }`

### 3. 接口契约

- [ ] 新增 2 个事件 handler：`handleBeforeAgentStart` / `handleAgentEnd`
- [ ] 与 Wave 12 的 4 个 handler 合并后，event-adapter.ts 共 6 个 handler（覆盖 Pi 的 6 个事件）

### 4. 行为契约

#### before_agent_start
- [ ] FR-8.1 G-007：AUTO_CLEAR_TURNS=2，终态 goal 2 turn 后 clearGoalSession
- [ ] FR-8.6 staleness reminder：TASK_STALL_TURN_THRESHOLD=10，**重置被提醒项 lastUpdatedTurn**（避免重复触发）
- [ ] FR-8.6 context pause：CONTEXT_USAGE_RATIO_LIMIT=0.85，超限转 paused
- [ ] 正常 context injection（contextInjectionPrompt）

#### agent_end（FR-8.7 完整分支）
- [ ] FR-8.2 G-021：isProcessing 防重入
- [ ] FR-8.2 G-020：makeStaleChecker + 入口 checkStale + 每个副作用前 checkStale
- [ ] **FR-6.7 ESC 守卫（最关键）**：ctx.signal?.aborted → 不发 continuation、不递增 stall、不做 budget 检查、goal 保持 active
- [ ] FR-8.7 分支优先级（按序）：
  1. allTasksDone → maxTurnsReached? complete : budgetTight? steer : followUp
  2. noTasksCreated → maxTurnsReached? cancelled : followUp
  3. maxTurnsReached（有未完成）→ cancelled
  4. 否则 → stall 检测 + continuation
- [ ] FR-8.6 continuation 去抖：tokenDelta=0 不发

### 5. 提交

- [ ] commit message 以 `wave-13:` 开头，含「FR-8.7 full branch priority」+「ESC guard」+「stall detection」
