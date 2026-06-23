/**
 * goal_manager tool 适配器（adapters 层）
 *
 * 迁移自 src/tool-handler.ts 的 executeGoalAction + GoalManagerParams。
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

import { SUBTASK_STATUSES, TASK_STATUSES } from "../engine/task";
import type { MessagingPort, PersistencePort, SessionPort, UiPort } from "../ports";
import { errorResult } from "../projection/result";
import type { ServicePorts, ToolActionResult } from "../service";
import type { GoalSession } from "../session";
import { isStaleContextError } from "../session";
import {
	type ActionContext,
	type ActionHandler,
	SUBTASK_ACTION_HANDLERS,
	TASK_ACTION_HANDLERS,
} from "./actions";

// ── 常量（AC-4：entry type 字符串不变）────────────────

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
				status: StringEnum(TASK_STATUSES),
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

// ── Ports 构造（Pi → ServicePorts 桥接）──────────────

/**
 * 把 Pi 的 pi / ctx 适配为 ServicePorts。
 *
 * - persistence: pi.appendEntry 映射到 appendState / appendHistory（type 字符串区分）
 * - ui: ctx.ui 的 setWidget/setStatus/notify + hasUI + theme 的 fg/bold（满足 ThemeLike 形状）
 * - messaging: pi.sendMessage 映射到 sendContextMessage / sendUserMessage
 * - session: ctx.sessionManager.getEntries + best-effort splice（保留旧 index.ts 行为）+
 *   ctx.getContextUsage + ctx.signal
 *
 * 注意：persistence 的 appendState 用 GOAL_ENTRY_TYPE，appendHistory 用 HISTORY_ENTRY_TYPE，
 * 与 serializeState / makeHistoryEntry 的输出对齐（session.ts reconstructGoalState 据此识别）。
 */
export function buildPorts(pi: ExtensionAPI, ctx: ExtensionContext): ServicePorts {
	const persistence: PersistencePort = {
		appendState: (state): void => {
			pi.appendEntry(GOAL_ENTRY_TYPE, state);
		},
		appendHistory: (entry): void => {
			pi.appendEntry(HISTORY_ENTRY_TYPE, entry);
		},
	};

	// UiPort 实现 + 额外的 fg/bold（满足 projection/widget.ts 的 ThemeLike 形状，
	// asTheme(uiPort) 用 `as unknown as ThemeLike` 单步断言取出 fg/bold）。
	// 因 UiPort 接口未声明 fg/bold（D-22：UiPort 只声明机器可检查的能力边界），
	// 构造满足 UiPort & ThemeLike 的对象后整体断言为 UiPort（多出的 fg/bold 运行时存在）。
	const uiPort = {
		setWidget(name: string, content: string[] | string | undefined): void {
			ctx.ui.setWidget(name, content);
		},
		setStatus(name: string, text: string | undefined): void {
			ctx.ui.setStatus(name, text);
		},
		notify(text: string, level: "info" | "warning" | "error"): void {
			ctx.ui.notify(text, level);
		},
		get hasUI(): boolean {
			return Boolean(ctx.hasUI);
		},
		// ThemeLike 形状：透传 ctx.ui.theme 的 fg/bold。
		// Pi 的 theme.fg 接收 ThemeColor（string 字面量联合），adapter 层桥接 string → ThemeColor，
		// `as never` 是合法的单步断言（ThemeColor 是 string 子集，运行时安全）。
		fg(color: string, text: string): string {
			return ctx.ui.theme.fg(color as never, text);
		},
		bold(text: string): string {
			return ctx.ui.theme.bold(text);
		},
	} as UiPort;

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
			pi.sendUserMessage(content, { deliverAs });
		},
	};

	const session: SessionPort = {
		getEntries: () => ctx.sessionManager.getEntries(),
		// best-effort splice：与旧 index.ts 一致——对 getEntries() 返回的数组执行 splice
		// （reconstructGoalState 的 entry GC 用，session_start 路径才触发；tool 路径不触发）。
		spliceEntry: (index, count): void => {
			ctx.sessionManager.getEntries().splice(index, count);
		},
		getContextUsage: () => {
			const usage = ctx.getContextUsage();
			return usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow } : null;
		},
		get signal(): AbortSignal | undefined {
			return ctx.signal;
		},
	};

	return { persistence, ui: uiPort, messaging, session };
}

// ── Tool Execute Handler（分发入口）──────────────────

/**
 * 执行 goal_manager tool action 的分发入口。
 *
 * 流程：
 * 1. 状态检查：无 active goal → errorResult
 * 2. signal.aborted 守卫：保持当前行为（返回 error）。FR-6.7 的 ESC 纯打断主要在
 *    事件路径（agent_end），tool 路径保持当前"返回 error"行为。
 * 3. Ports 构造（Pi → ServicePorts 桥接）。
 * 4. ACTION_HANDLERS 查表分发：handler 调 service.applyToolAction 完成实际工作。
 * 5. 外层 try/catch：stale context 检测（FR-8.2 G-010）+ 通用错误兜底（msg + params 摘要）。
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

// errorResult 由 projection/result.ts 统一导出（DRY：service / tool-adapter 共用）。
