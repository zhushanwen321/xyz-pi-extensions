# Wave 14: index.ts 重写 + 删旧文件 + 迁移测试 + 全量验证

- **目标文件**：
  - 重写：`extensions/goal/src/index.ts`
  - 删除：9 个旧文件
  - 迁移：2 个测试文件的 import
- **前置 wave**：Wave 10-13（所有 adapter 已就绪）
- **目标**：大爆炸切换——index.ts 重写为工厂（委托 adapters）+ __goalInit 收口 + ctx 必填 + 删旧文件 + 迁移测试 + 全量验证。

## 关键行为契约

- **FR-4.1**：__goalInit 内部调 service.createGoal（双轨消除）
- **FR-4.2 / D-16**：ctx 改必填，移除 lastCtx 模块级可变状态
- **FR-6.4**：移除 hasPendingInjection
- **FR-6.7**：移除 pendingPause
- **AC-4**：goal_manager tool schema 不变；/goal 命令子命令不变

---

- [ ] **步骤 1：重写 index.ts**

重写 `extensions/goal/src/index.ts`（替换全部内容）：

```typescript
/**
 * Pi /goal Extension — 工厂入口
 *
 * 注册 tool / command / events，全部委托 adapters 层。
 * __goalInit 内部调 service.createGoal（FR-4.1 双轨消除）。
 *
 * FR-4.2/D-16: ctx 必填，移除 lastCtx 模块级可变状态。
 * FR-6.4: 移除 hasPendingInjection。
 * FR-6.7: 移除 pendingPause。
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static } from "typebox";

import { handleAgentEnd, handleBeforeAgentStart, handleAgentStart, handleMessageEnd, handleSessionStart, handleTurnEnd } from "./adapters/event-adapter";
import { handleGoalCommand } from "./adapters/command-adapter";
import { executeGoalAction, GoalManagerParams } from "./adapters/tool-adapter";
import { type GoalManagerDetails } from "./adapters/tool-adapter";
import { createGoalSession, type GoalSession } from "./session";
import { createGoal } from "./service";
import { isStaleContextError } from "./session";
import { getCompletedCount } from "./engine/task";
import { toSingleLine } from "./projection/widget";

// ── Local Interfaces (Like*Event — 避免 any) ──────────

interface BeforeAgentStartLikeEvent { type: "before_agent_start"; prompt: string; systemPrompt: string }
interface TurnEndLikeEvent { type: "turn_end"; turnIndex: number }
interface MessageEndLikeEvent { type: "message_end"; message: { role: string; usage?: { input?: number; output?: number; cacheRead?: number; totalTokens?: number } } }
interface AgentEndLikeEvent { type: "agent_end"; messages: unknown[] }
interface SessionStartLikeEvent { type: "session_start"; reason: string }
interface LikeCustomMessage { customType: string; content: string | unknown }
interface LikeMessageRenderOptions { expanded: boolean }
interface LikeToolResult { content: Array<{ type: string; text?: string }>; details?: GoalManagerDetails }
interface LikeToolRenderResultOptions { expanded: boolean }

// ── Extension Factory ─────────────────────────────────

export default function goalExtension(pi: ExtensionAPI) {
	const session: GoalSession = createGoalSession();

	// ── Tool: goal_manager ────────────────────────────

	pi.registerTool({
		name: "goal_manager",
		label: "Goal Manager",
		description:
			"Goal mode task manager. This tool is only available after starting a goal via the /goal command. AI cannot trigger it proactively. If Goal mode is not active, calling this tool will error." +
			"\n\nAvailable actions:" +
			"\n- create_tasks: Decompose the objective into a task list (call once at goal start). Each task description must be a one-line summary (max 60 chars), no newlines or markdown. Accept verifications array for task verification." +
			"\n- add_tasks: Append new tasks to the existing list (when omissions are discovered). Fails if no tasks exist yet — use create_tasks first." +
			"\n- update_tasks: Batch update task statuses. Must follow state machine: pending→in_progress→completed→verified. Completed requires evidence." +
			"\n- list_tasks: View progress and remaining budget" +
			"\n- complete_goal: Mark the objective as achieved. Only call when ALL tasks are completed or verified with concrete evidence." +
			"\n- cancel_goal: Cancel the current goal (use when user wants to exit/stop)" +
			"\n- report_blocked: Report being blocked. Only use after trying at least 3 alternative approaches." +
			"\n- add_subtasks: Add subtasks to a specified task (params: taskId, texts[])." +
			"\n- update_subtasks: Batch update subtask statuses (params: taskId, subUpdates[])." +
			"\n- delete_subtasks: Delete subtasks from a specified task (params: taskId, subIds[]).",
		promptSnippet: "Manage task list, completion status, and exit for /goal mode",
		parameters: GoalManagerParams,

		async execute(_toolCallId: string, params: Static<typeof GoalManagerParams>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			try {
				return await executeGoalAction(pi, session, params, ctx, signal);
			} catch (err) {
				if (isStaleContextError(err)) {
					return {
						content: [{ type: "text" as const, text: "Goal context stale after compact or session replacement." }],
						isError: true as const,
					};
				}
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `${msg}\n\nInput: ${JSON.stringify(params, null, 2)}` }],
					isError: true,
				};
			}
		},

		renderCall(args: Static<typeof GoalManagerParams>, theme: Theme) {
			let text = theme.fg("toolTitle", theme.bold("goal_manager ")) + theme.fg("muted", args.action);
			if (args.tasks) text += ` ${theme.fg("dim", `(${args.tasks.length} tasks)`)}`;
			if (args.updates) text += ` ${theme.fg("dim", `(${args.updates.length} updates)`)}`;
			if (args.taskId !== undefined) text += ` ${theme.fg("accent", `#${args.taskId}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result: LikeToolResult, { expanded }: LikeToolRenderResultOptions, theme: Theme) {
			const details = result.details;
			if (!details || !Array.isArray(details.tasks)) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
			}
			const tasks = details.tasks;
			const completed = getCompletedCount(tasks);
			const summary = theme.fg("success", `✓ ${completed}/${tasks.length} completed`);
			if (!expanded || tasks.length === 0) return new Text(summary, 0, 0);
			const lines = [summary];
			for (const t of tasks) {
				const icon = t.status === "verified" ? theme.fg("success", "◉")
					: t.status === "completed" ? theme.fg("success", "✓")
					: t.status === "in_progress" ? theme.fg("warning", "●")
					: t.status === "cancelled" ? theme.fg("dim", "✗")
					: theme.fg("dim", "☐");
				lines.push(`  ${icon} ${theme.fg("accent", `#${t.id}`)} ${theme.fg("dim", toSingleLine(t.description))}`);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// ── Command: /goal ────────────────────────────────

	pi.registerCommand("goal", {
		description: "Goal-driven mode: /goal <objective> [flags] | /goal pause | /goal resume | /goal abort | /goal clear | /goal update <new-objective> | /goal status | /goal history",
		handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
			await handleGoalCommand(pi, session, args, ctx);
		},
	});

	// ── Events ────────────────────────────────────────

	pi.on("before_agent_start", async (_event: BeforeAgentStartLikeEvent, ctx: ExtensionContext) => {
		return handleBeforeAgentStart(pi, session, ctx);
	});

	pi.on("agent_start", async () => {
		await handleAgentStart(pi, session, undefined as unknown as ExtensionContext);
	});

	pi.on("turn_end", async (_event: TurnEndLikeEvent, ctx: ExtensionContext) => {
		await handleTurnEnd(pi, session, ctx);
	});

	pi.on("message_end", async (event: MessageEndLikeEvent, ctx: ExtensionContext) => {
		await handleMessageEnd(pi, session, ctx, event);
	});

	pi.on("agent_end", async (_event: AgentEndLikeEvent, ctx: ExtensionContext) => {
		await handleAgentEnd(pi, session, ctx);
	});

	pi.on("session_start", async (_event: SessionStartLikeEvent, ctx: ExtensionContext) => {
		await handleSessionStart(pi, session, ctx);
	});

	// ── Message Renderers ──────────────────────────────

	const goalMessageTypes = ["goal-context", "goal-context-exceeded", "goal-staleness-reminder"];
	for (const customType of goalMessageTypes) {
		pi.registerMessageRenderer(customType, (message: LikeCustomMessage, _options: LikeMessageRenderOptions, theme: Theme) => {
			const prefix = message.customType === "goal-context-exceeded"
				? theme.fg("error", "[GOAL Budget] ")
				: message.customType === "goal-staleness-reminder"
					? theme.fg("warning", "[GOAL Reminder] ")
					: theme.fg("accent", "[GOAL] ");
			const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
			return new Text(prefix + theme.fg("dim", content), 0, 0);
		});
	}

	// ── External API: __goalInit（FR-4 双轨消除）──────────

	/**
	 * 允许其他扩展（coding-workflow / plan）通过 pi.__goalInit 编程式初始化 goal。
	 * 内部调 service.createGoal（FR-4.1 双轨消除）。
	 *
	 * FR-4.2/D-16: ctx 必填（消除 lastCtx 模块级可变状态）。
	 * D-12: tasks 参数保留（核心价值是 task 构造逻辑唯一，不是砍参数）。
	 */
	function initializeGoalFromExternal(
		objective: string,
		tasks: string[],
		budget: { tokenBudget?: number; timeBudgetMinutes?: number; maxTurns?: number } | undefined,
		ctx: ExtensionContext,
	): boolean {
		// 构造 ports（adapter 职责）
		const ports: ServicePorts = {
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
				sendContextMessage: (content, deliverAs, ct) => pi.sendMessage({ customType: ct ?? "goal-context", content, display: false }, { deliverAs }),
				sendUserMessage: (content, deliverAs) => pi.sendUserMessage(content, { deliverAs }),
			},
			session: {
				getEntries: () => ctx.sessionManager.getEntries(),
				spliceEntry: (idx, count) => ctx.sessionManager.getBranch().splice(idx, count),
				getContextUsage: () => ctx.getContextUsage(),
				signal: ctx.signal,
			},
		};
		return createGoal(session, objective, tasks, budget ?? {}, ports, true);
	}

	// Expose on pi for cross-extension access
	const api = pi as unknown as Record<string, unknown>;
	api.__goalInit = initializeGoalFromExternal;
}
```

> **需要的额外 import**：`ServicePorts` from `./service`、`serializeState` from `./persistence`。执行者补全 import。
>
> **注意**：`handleAgentStart` 的 `undefined as unknown as ExtensionContext` 是 hack——因为 agent_start 事件 handler 签名是 `(_event, ctx)` 但我们的 `handleAgentStart` 不需要 ctx（只读 session）。更干净的做法是让 `handleAgentStart` 不接收 ctx 参数。执行者可调整签名。

- [ ] **步骤 2：删除 9 个旧文件**

```bash
rm extensions/goal/src/state.ts
rm extensions/goal/src/budget.ts
rm extensions/goal/src/widget.ts
rm extensions/goal/src/templates.ts
rm extensions/goal/src/tool-handler.ts
rm extensions/goal/src/action-handlers.ts
rm extensions/goal/src/command-handler.ts
rm extensions/goal/src/agent-end-handler.ts
rm extensions/goal/src/before-agent-start-handler.ts
```

- [ ] **步骤 3：迁移现有测试 import**

**`is-task-done.test.ts`**：`import from "../state"` → `import from "../engine/task"`

```bash
# 替换 import 行
sed -i '' 's|import { type GoalTask, isTaskDone } from "../state"|import { type GoalTask, isTaskDone } from "../engine/task"|' extensions/goal/src/__tests__/is-task-done.test.ts
```

**`validate-update-tasks.test.ts`**：`import from "../action-handlers"` → 此测试的 validateUpdateTasks 逻辑现已内置到 service.applyToolAction。测试需改写为调 service.applyToolAction 或直接测 engine/task.validateTaskTransition。最简单做法：

```typescript
// 改 import：
// 旧：import { validateUpdateTasks } from "../action-handlers";
// 新：测试改为调 service.applyToolAction（但需要 fake ports）
// 或：只测 validateTaskTransition（engine 层），service 层的集成测试已在 service.test.ts 覆盖
```

执行者选择：保留 validate-update-tasks.test.ts 但改为测 `validateTaskTransition`（engine 层），或删除（service.test.ts 已覆盖 update_tasks 的校验逻辑）。

- [ ] **步骤 4：typecheck**

运行：`pnpm --filter @zhushanwen/pi-goal typecheck`
预期：零错误。如果有错误，修复 import 路径或类型不匹配。

> **常见问题**：
> - `GoalManagerParams` 的 import 路径（从 tool-adapter 还是单独定义）
> - `GoalManagerDetails` 的 export 位置
> - `ServicePorts` 需要 import
> - `serializeState` 需要 import

- [ ] **步骤 5：lint**

运行：`pnpm --filter @zhushanwen/pi-goal lint`
预期：零错误。

- [ ] **步骤 6：运行全部测试**

运行：`pnpm --filter @zhushanwen/pi-goal test`
预期：全绿。

- [ ] **步骤 7：全量 grep 验证**

```bash
# AC-1: engine 零 Pi import
grep -rn "@mariozechner\|@earendil" extensions/goal/src/engine/
# 预期：无输出

# AC-5: hasPendingInjection 已删
grep -rn "hasPendingInjection" extensions/goal/src/
# 预期：无输出

# AC-5: pendingPause 已删
grep -rn "pendingPause" extensions/goal/src/
# 预期：无输出

# AC-7: 零 any / eslint-disable
grep -rn ": any\b\|eslint-disable" extensions/goal/src/
# 预期：无输出

# D-16: lastCtx 已删
grep -rn "lastCtx" extensions/goal/src/
# 预期：无输出
```

- [ ] **步骤 8：验证旧文件已删**

```bash
ls extensions/goal/src/state.ts extensions/goal/src/budget.ts extensions/goal/src/widget.ts extensions/goal/src/templates.ts extensions/goal/src/tool-handler.ts extensions/goal/src/action-handlers.ts extensions/goal/src/command-handler.ts extensions/goal/src/agent-end-handler.ts extensions/goal/src/before-agent-start-handler.ts 2>&1
# 预期：全部 "No such file or directory"
```

- [ ] **步骤 9：提交**

```bash
git add -A
git commit -m "wave-14: rewrite index.ts (factory delegates to adapters), __goalInit delegates to createGoal (FR-4.1), ctx required (D-16), delete 9 old files, migrate test imports

Architecture rewrite complete:
- engine/ (zero Pi deps): task/types/goal/budget
- ports.ts: machine-checkable boundary
- service.ts: dual entry (applyToolAction/applyEvent)
- adapters/: tool/command/event with ESC guards + concurrency protection
- projection/: widget/prompts/result with budget formatting deduplicated

Behavior changes (architecture-necessary):
- FR-5: serialization clean break
- FR-6.2: token/time warning flags independent (4 flags)
- FR-6.7: ESC pure interrupt (3-handler aborted guard)
- FR-6.4/6.5/6.6: remove hasPendingInjection, extract tick, hasUI guard

All FR-8 behavior contracts preserved."
```

- [ ] **步骤 10：最终全量验证**

```bash
pnpm --filter @zhushanwen/pi-goal typecheck
pnpm --filter @zhushanwen/pi-goal lint
pnpm --filter @zhushanwen/pi-goal test
```
全部必须通过。如果失败，逐个修复直到全绿。

---

## 完成标志

全部以下条件满足时，架构重写完成：

- [ ] typecheck 零错误
- [ ] lint 零错误
- [ ] test 全绿
- [ ] engine/ 零 Pi import（grep 无输出）
- [ ] hasPendingInjection / pendingPause / lastCtx / any / eslint-disable 全部 grep 无输出
- [ ] 9 个旧文件已删除
- [ ] index.ts 只 import adapters/engine/projection/service/session/persistence/ports/constants/commands
