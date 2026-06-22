# Wave 10: adapters/tool-adapter.ts

- **目标文件**：`extensions/goal/src/adapters/tool-adapter.ts`
- **前置 wave**：Wave 4（session.ts）、Wave 5（service.ts）、Wave 7（projection/result.ts）、Wave 8/9（adapters/actions.ts）
- **目标**：创建 `adapters/tool-adapter.ts`，实现 goal_manager tool 的完整入口：
  - `GoalManagerParams` schema（typebox，与现有完全一致，AC-4 契约稳定）
  - `executeGoalAction(pi, session, params, ctx, signal)` 分发入口 + stale context 检测（FR-8.2 G-010）+ signal.aborted 守卫
  - `ACTION_HANDLERS` Record（从 actions.ts 的两个子 Record 合并组装，AC-3 编译期完整性）
  - `GoalManagerDetails` 接口（从 result.ts re-export）
  - Ports 构造（把 Pi 的 `pi`/`ctx` 适配为 `ServicePorts`）

## 关键改动点

1. **schema 完全保持**（AC-4）：`GoalManagerParams` 与现有 `tool-handler.ts` 逐字段一致——action 枚举、tasks/updates/taskId/texts/subUpdates/subIds/verifications/evidence/reason/cancelReason 全部不变。`StringEnum` 自 `@mariozechner/pi-ai`，`Type`/`Static` 自 `typebox`。
2. **status 枚举数组来源**：`GOAL_TASK_STATUSES` / `SUBTASK_STATUSES` 在 engine/task.ts（Wave 0）定义并 export（engine 层导出 readonly 数组供 schema 复用，类型规范源头）。本文件 import 自 `../engine/task.js`。
3. **ACTION_HANDLERS 组装**：`{ ...TASK_ACTION_HANDLERS, ...SUBTASK_ACTION_HANDLERS }` 合并 Wave 8/9 的两个子 Record，得到完整 10 条路由表。AC-3 编译期完整性由 typebox 的 `action` 枚举 + Record 查表共同保证（漏 handler → 运行时 `Unknown action`，但 typebox 已在 schema 层拒绝非法 action）。
4. **Ports 构造（Pi → ServicePorts 桥接）**：`buildPorts(pi, ctx)` 把 Pi 的 `pi.appendEntry` / `ctx.ui` / `pi.sendMessage` / `ctx.sessionManager` 适配为 `PersistencePort` / `UiPort` / `MessagingPort` / `SessionPort`。UiPort 实现同时挂 `fg` / `bold`（透传 `ctx.ui.theme`），满足 projection/widget.ts 的 `ThemeLike` 形状（Wave 6 的 `asTheme` 断言依赖此）。
5. **stale context 检测**（FR-8.2 G-010）：`executeGoalAction` 外层 try/catch，捕获 `isStaleContextError` → 返回 stale 提示；其他错误 → 返回 msg + JSON.stringify(params)。
6. **signal.aborted 守卫**：保持当前行为——`signal?.aborted` 时标记并返回 error（`"Tool call aborted by signal."`）。注意 FR-6.7 的 ESC 纯打断主要在事件路径，tool 路径保持当前"标记 + 返回 error"行为（FR-6.7 表格标注 tool 路径不太关心，但保持当前行为）。
7. **entry type 常量**：`GOAL_ENTRY_TYPE = "goal-state"` / `HISTORY_ENTRY_TYPE = "goal-history"`（与现有一致，AC-4）。

## AC-3 编译期完整性说明

`ACTION_HANDLERS: Record<string, ActionHandler>` 的编译期完整性通过两条路径保证：
1. **schema 层**：`GoalManagerParams.action` 的 `StringEnum` 枚举 10 个值，Pi 在调用 `execute` 前用 schema 校验 params，非法 action 不会到 `executeGoalAction`。
2. **Record 查表**：`ACTION_HANDLERS[params.action]` 若 undefined 返回 `"Unknown action"` error。但因 actions.ts 的两个子 Record 已覆盖全部 10 个枚举值，运行时不会命中 undefined 分支（grep 验证 10 个 action 字符串一一对应）。

> **为什么不直接 `Record<Action, ActionHandler>`**：action 是 typebox schema 的 `StringEnum` 值，不是独立 TS 字面量联合类型。要严格 `Record<Action, ...>` 需从 schema 派生 `Action` 类型——可行但增加间接性。当前 `Record<string, ActionHandler>` + schema 枚举 + grep 验证已足够（AC-3 的 grep 验证项覆盖）。

## 步骤 1：创建 `extensions/goal/src/adapters/tool-adapter.ts`

```typescript
/**
 * goal_manager tool 适配器（adapters 层）
 *
 * 迁移自 src/tool-handler.ts 的 executeGoalAction + GoalManagerParams + isStaleContextError。
 *
 * 职责：
 * - 定义 GoalManagerParams schema（AC-4 契约稳定，与现有逐字段一致）
 * - executeGoalAction 分发入口：状态检查 + signal 守卫 + stale context 检测 + ACTION_HANDLERS 查表
 * - Ports 构造（Pi → ServicePorts 桥接）
 * - ACTION_HANDLERS Record 完整组装（合并 actions.ts 的两个子 Record）
 *
 * adapters 层可 import Pi 类型（负责桥接 Pi 和 service）。
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "typebox";

import { GOAL_TASK_STATUSES, SUBTASK_STATUSES } from "../engine/task.js";
import { isStaleContextError, type GoalSession } from "../session.js";
import type { MessagingPort, PersistencePort, SessionPort, UiPort } from "../ports.js";
import type { ServicePorts, ToolActionResult } from "../service.js";
import {
	type ActionContext,
	type ActionHandler,
	SUBTASK_ACTION_HANDLERS,
	TASK_ACTION_HANDLERS,
} from "./actions.js";

// ── 常量（AC-4：entry type 字符串不变）──

export const GOAL_ENTRY_TYPE = "goal-state";
export const HISTORY_ENTRY_TYPE = "goal-history";

// ── ACTION_HANDLERS Record（AC-3：合并两个子 Record，10 条）──

/**
 * goal_manager tool 的 action 分发表。
 * 合并 actions.ts 的 TASK_ACTION_HANDLERS（7 条）+ SUBTASK_ACTION_HANDLERS（3 条）。
 * executeGoalAction 用 `ACTION_HANDLERS[params.action]` 查表分发。
 */
export const ACTION_HANDLERS: Record<string, ActionHandler> = {
	...TASK_ACTION_HANDLERS,
	...SUBTASK_ACTION_HANDLERS,
};

// ── Tool Parameter Schema（AC-4：与现有逐字段一致）──

export const GoalManagerParams = Type.Object({
	action: StringEnum([
		"create_tasks",
		"add_tasks",
		"update_tasks",
		"list_tasks",
		"complete_goal",
		"cancel_goal",
		"report_blocked",
		"add_subtasks",
		"update_subtasks",
		"delete_subtasks",
	] as const),
	tasks: Type.Optional(
		Type.Array(Type.String(), {
			description: "Task descriptions. Each must be a one-line summary (max 60 chars), no newlines or markdown",
		}),
	),
	updates: Type.Optional(
		Type.Array(
			Type.Object({
				taskId: Type.Number(),
				status: StringEnum(GOAL_TASK_STATUSES),
				evidence: Type.Optional(Type.String()),
				actual: Type.Optional(Type.String({ description: "Actual verification result (required when status=verified)" })),
			}),
		),
	),
	taskId: Type.Optional(Type.Number({ description: "Task ID (required for subtask operations)" })),
	texts: Type.Optional(Type.Array(Type.String(), { description: "Subtask text list (for add_subtasks)" })),
	subUpdates: Type.Optional(
		Type.Array(
			Type.Object({
				subId: Type.Number(),
				status: StringEnum(SUBTASK_STATUSES),
			}),
		),
	),
	subIds: Type.Optional(Type.Array(Type.Number(), { description: "Subtask ID list (for delete_subtasks)" })),
	verifications: Type.Optional(
		Type.Array(
			Type.Object({
				method: Type.String({ description: "Verification method, e.g. 'pnpm --filter <pkg> typecheck'" }),
				expected: Type.String({ description: "Expected result, e.g. 'zero type errors'" }),
			}),
			{ description: "Verification configs for each task (1-to-1 with tasks array, for create_tasks/add_tasks)" },
		),
	),
	evidence: Type.Optional(Type.String({ description: "Evidence for completion (required for complete_goal)" })),
	reason: Type.Optional(Type.String({ description: "Reason for being blocked (required for report_blocked)" })),
	cancelReason: Type.Optional(Type.String({ description: "Why the user wants to cancel (required for cancel_goal)" })),
});

// ── Ports 构造（Pi → ServicePorts 桥接）──

/**
 * 把 Pi 的 pi / ctx 适配为 ServicePorts。
 *
 * - persistence: pi.appendEntry 映射到 appendState / appendHistory（type 字符串区分）
 * - ui: ctx.ui 的 setWidget/setStatus/notify + hasUI + theme 的 fg/bold（满足 ThemeLike 形状）
 * - messaging: pi.sendMessage 映射到 sendContextMessage / sendUserMessage
 * - session: ctx.sessionManager 映射到 getEntries/spliceEntry/getContextUsage/signal
 *
 * 注意：persistence 的 appendState 用 GOAL_ENTRY_TYPE，appendHistory 用 HISTORY_ENTRY_TYPE，
 * 与 serializeState / makeHistoryEntry 的输出对齐（session.ts reconstructGoalState 据此识别）。
 */
function buildPorts(pi: ExtensionAPI, ctx: ExtensionContext): ServicePorts {
	const persistence: PersistencePort = {
		appendState: (state): void => {
			pi.appendEntry(GOAL_ENTRY_TYPE, state);
		},
		appendHistory: (entry): void => {
			pi.appendEntry(HISTORY_ENTRY_TYPE, entry);
		},
	};

	const uiPort: UiPort = {
		setWidget: (name, content): void => {
			ctx.ui.setWidget(name, content);
		},
		setStatus: (name, text): void => {
			ctx.ui.setStatus(name, text);
		},
		notify: (text, level): void => {
			ctx.ui.notify(text, level);
		},
		get hasUI(): boolean {
			return Boolean(ctx.hasUI);
		},
		// ThemeLike 形状：透传 ctx.ui.theme 的 fg/bold，供 projection/widget.ts 的 asTheme 断言取出。
		// Pi 的 theme.fg 接收 ThemeColor，与 string 兼容（ThemeColor 是 string 子集）。
		fg: (color: string, text: string): string => ctx.ui.theme.fg(color as never, text),
		bold: (text: string): string => ctx.ui.theme.bold(text),
	};

	const messaging: MessagingPort = {
		sendContextMessage: (content, deliverAs, customType): void => {
			pi.sendMessage(
				{
					customType: customType ?? "goal-context",
					content,
					display: false,
				},
				{ deliverAs },
			);
		},
		sendUserMessage: (content, deliverAs): void => {
			pi.sendMessage(content, { deliverAs });
		},
	};

	const session: SessionPort = {
		getEntries: () => ctx.sessionManager.getEntries(),
		spliceEntry: (index, count): void => {
			ctx.sessionManager.spliceEntries(index, count);
		},
		getContextUsage: () => {
			const usage = ctx.sessionManager.getContextUsage();
			return usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow } : null;
		},
		get signal(): AbortSignal | undefined {
			return ctx.signal;
		},
	};

	return { persistence, ui: uiPort, messaging, session };
}

// ── Tool Execute Handler（分发入口）──

/**
 * 执行 goal_manager tool action 的分发入口。
 *
 * 流程：
 * 1. 状态检查：无 active goal → errorResult
 * 2. signal.aborted 守卫：保持当前行为（标记 + 返回 error）。FR-6.7 的 ESC 纯打断主要在
 *    事件路径（agent_end），tool 路径保持当前"返回 error"行为
 * 3. stale context 检测（FR-8.2 G-010）：外层 try/catch，isStaleContextError → stale 提示；
 *    其他错误 → msg + JSON.stringify(params)
 * 4. ACTION_HANDLERS 查表分发：handler 调 service.applyToolAction 完成实际工作
 *
 * @param pi Extension API
 * @param session goal session
 * @param params tool 参数（已通过 schema 校验）
 * @param ctx extension context
 * @param signal abort signal（Pi 透传，ESC 时 abort）
 */
export async function executeGoalAction(
	pi: ExtensionAPI,
	session: GoalSession,
	params: Static<typeof GoalManagerParams>,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<ToolActionResult> {
	const state = session.state;
	if (!state) {
		return errorResult("Goal mode not active. Use /goal <objective> to start.");
	}

	// signal.aborted 守卫：保持当前行为（返回 error）
	if (signal?.aborted) {
		return errorResult("Tool call aborted by signal.");
	}

	try {
		// Ports 构造（Pi → ServicePorts 桥接）
		const ports = buildPorts(pi, ctx);

		// ACTION_HANDLERS 查表分发
		const handler = ACTION_HANDLERS[params.action];
		if (!handler) {
			return errorResult(`Unknown action: ${params.action}`);
		}

		const actx: ActionContext = { pi, session, params, ctx, ports };
		return handler(actx);
	} catch (err) {
		// FR-8.2 G-010：stale context 检测
		if (isStaleContextError(err)) {
			return errorResult("Goal context stale after compact or session replacement.");
		}
		const msg = err instanceof Error ? err.message : String(err);
		const inputSummary = JSON.stringify(params, null, 2);
		return errorResult(`${msg}\n\nInput: ${inputSummary}`);
	}
}

// ── 错误结果构造器 ────────────────────────────────────

/** 构造标准的错误结果（与 projection/result.ts 的 errorResult 等价，此处用于入口层避免循环 import）。 */
function errorResult(message: string): ToolActionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
	};
}
```

> **import 说明**：
> - `GOAL_TASK_STATUSES` / `SUBTASK_STATUSES` 自 `../engine/task.js`（Wave 0 导出，engine 层规范源头）。若 Wave 0 未导出这两个数组，需在 Wave 0 补充 export——它们是 schema 的规范来源（数组值与 `TaskStatus` / `SubtaskStatus` 联合类型一一对应）。
> - `isStaleContextError` 自 `../session.js`（Wave 4）。
> - port 接口（`PersistencePort` / `UiPort` / `MessagingPort` / `SessionPort`）自 `../ports.js`（Wave 3 定义）；`ServicePorts` / `ToolActionResult` 自 `../service.js`（Wave 5 定义）。与 plan 接口契约的导出来源一致。
> - `ACTION_HANDLERS` 不从 actions.ts import（actions.ts 只导出两个子 Record `TASK_ACTION_HANDLERS` + `SUBTASK_ACTION_HANDLERS`，最终 Record 在本文件组装）。这避免与本地 export 同名冲突。

> **Pi API 映射说明**：
> - `ctx.ui.theme.fg(color as never, text)`：Pi 的 `theme.fg` 签名接收 `ThemeColor`（string 字面量联合）。`as never` 是合法的单步断言（adapter 层桥接 string → ThemeColor，ThemeColor 是 string 子集，运行时安全）。若 lint 报 `as never`，改为 `as Parameters<typeof ctx.ui.theme.fg>[0]` 更精确。
> - `ctx.sessionManager.spliceEntries` / `getContextUsage` / `signal`：Pi 的 SessionManager API。具体方法名以 Pi SDK 实际为准（旧 index.ts:123 用 `ctx.sessionManager.getEntries()`）。若方法名不同（如 `splice` vs `spliceEntries`），按实际调整。
> - `ctx.hasUI`：Pi 的 headless 标志（FR-6.6）。若实际属性名不同（如 `ctx.options.hasUI`），按实际调整。
> - `pi.sendMessage(content, { deliverAs })`：Pi 的消息发送 API。第一个参数是 string 或 message 对象；`sendUserMessage` 传 string，`sendContextMessage` 传 `{ customType, content, display: false }` 对象（保持旧 sendGoalContextMessage 行为）。

## 步骤 2：typecheck 验证

```bash
pnpm --filter @zhushanwen/pi-goal typecheck
```

> 验证点：
> - `GoalManagerParams` schema 与现有逐字段一致（AC-4）
> - `ACTION_HANDLERS` 含 10 条（grep `create_tasks` / `add_subtasks` 等 10 个 action 字符串）
> - `executeGoalAction` 签名与 plan 接口契约一致
> - Ports 构造的 Pi API 映射正确（若 typecheck 报 ctx.sessionManager.spliceEntries 等不存在，按实际 Pi API 调整）
> - 不 import 旧文件（`../tool-handler`、`../action-handlers`、`../state`）
> - 禁止 `any`（Pi theme 桥接用 `as never` 或精确断言，非 `any`）

> **依赖检查**：
> ```bash
> # 验证 ACTION_HANDLERS 覆盖全部 10 个 action
> grep -c "create_tasks\|add_tasks\|update_tasks\|list_tasks\|complete_goal\|cancel_goal\|report_blocked\|add_subtasks\|update_subtasks\|delete_subtasks" extensions/goal/src/adapters/actions.ts
> # 应输出 10（TASK_ACTION_HANDLERS 7 + SUBTASK_ACTION_HANDLERS 3 的 key）
> ```

## 步骤 3：提交

```bash
git add extensions/goal/src/adapters/tool-adapter.ts
git commit -m "refactor(goal): add adapters/tool-adapter.ts with schema + dispatch + ports bridge (Wave 10)"
```

## 验证清单

- [ ] 导出 `GOAL_ENTRY_TYPE`（"goal-state"）/ `HISTORY_ENTRY_TYPE`（"goal-history"）
- [ ] 导出 `GoalManagerParams` schema（AC-4：10 个 action 枚举 + 全部参数字段与现有一致）
- [ ] 导出 `executeGoalAction(pi, session, params, ctx, signal): Promise<ToolActionResult>`
- [ ] 导出 `ACTION_HANDLERS: Record<string, ActionHandler>`（合并 10 条）
- [ ] re-export `GoalManagerDetails`（从 result.ts，或在此定义——plan 接口契约允许两处）
- [ ] FR-8.2 G-010：stale context 检测（isStaleContextError → stale 提示）
- [ ] signal.aborted 守卫（返回 error，保持当前行为）
- [ ] Ports 构造：PersistencePort / UiPort（含 fg/bold 满足 ThemeLike）/ MessagingPort / SessionPort
- [ ] UiPort.hasUI getter 返回 `Boolean(ctx.hasUI)`（FR-6.6）
- [ ] 不 import 旧文件，禁止 `any`
- [ ] `pnpm --filter @zhushanwen/pi-goal typecheck` 通过
- [ ] grep 验证 ACTION_HANDLERS 覆盖全部 10 个 action 字符串
