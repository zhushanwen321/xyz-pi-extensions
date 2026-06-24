/**
 * goal_control tool — agent 终态控制入口（complete / report_blocked）
 *
 * #3：替代已删除的 goal_manager tool。
 *
 * 职责分层：
 * - execute 层（adapter 跨扩展职责）：signal 守卫 + todo 完成检查（duck-typed
 *   pi.__todoGetList，#7 正式暴露前 undefined 降级）
 * - handler 层（goal 业务，契约对齐 code-architecture §3 handleComplete/handleReportBlocked）：
 *   active 守卫 + evidence/reason 必填 + 状态转换
 *
 * 复用 engine/service 既有函数，不重写：
 * - complete: finalizeAndPersist(state, "complete", ...)（内部已含 tickState → finalizeGoal → persist）
 * - report_blocked: 手动 tickState（status 仍 active 才累加当前运行段）→ transitionStatus(active→blocked) → persistState
 *
 * executionMode: "sequential"——状态变更 tool，不可与同批其他 tool 并行执行。
 *
 * 错误处理：用 throw new Error（CLAUDE.md Tool 设计规范），不返回错误成功模式。
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "typebox";

import { isActiveStatus, transitionStatus } from "../engine/goal";
import type { GoalStatus } from "../engine/types";
import { updateWidget } from "../projection/widget";
import { finalizeAndPersist, persistState, tickState, type ServicePorts } from "../service";
import type { GoalSession } from "../session";
import { buildPorts } from "./ports";

// ── Params schema ────────────────────────────────────

const GoalControlParams = Type.Object({
	action: StringEnum(["complete", "report_blocked"] as const),
	evidence: Type.Optional(
		Type.String({
			description:
				"Required for 'complete'. Concrete completion evidence (files created/modified, tests passed, commands run). Do not mark complete on assumption, intent, or partial progress.",
		}),
	),
	reason: Type.Optional(
		Type.String({
			description:
				"Required for 'report_blocked'. The specific blocking condition and what was already tried (at least 3 approaches). Do NOT use for uncertainty, slow/hard work, or incomplete progress — keep working.",
		}),
	),
	completedTasks: Type.Optional(
		Type.Number({
			description: "Optional. Number of completed tasks, written into goal history on 'complete'. Defaults to 0.",
		}),
	),
});

export type GoalControlActionParams = Static<typeof GoalControlParams>;

// ── Details（renderResult 数据来源）──────────────────

export interface GoalControlDetails {
	action: "complete" | "report_blocked";
	goalId: string;
	status: GoalStatus;
}

// ── duck-typed todo 检查（#7 正式暴露前降级）────────

export const TODO_DEGRADED = "degraded" as const;

/**
 * 读 pi.__todoGetList()（#7 才在 todo extension 正式暴露）。
 *
 * 方案 A "undefined=降级"：
 * - 返回值 undefined（todo 未加载）→ "degraded"，调用方跳过 todo 检查（允许 complete）
 * - 非 undefined 且有未完成项（status 非 completed/cancelled）→ 返回未完成项数组
 *
 * 不 import todo extension 类型，纯 duck-typed（运行时按 status 字段判断），
 * 避免 #7 未落地时产生编译期依赖。
 */
export function findIncompleteTodos(pi: ExtensionAPI): unknown[] | typeof TODO_DEGRADED {
	const todoList = (pi as unknown as { __todoGetList?: () => unknown }).__todoGetList?.();
	if (todoList === undefined) return TODO_DEGRADED;
	if (!Array.isArray(todoList)) return TODO_DEGRADED;
	return todoList.filter((t) => {
		if (!t || typeof t !== "object") return false;
		const status = (t as { status?: unknown }).status;
		return status !== "completed" && status !== "cancelled";
	});
}

// ── 业务 handler（契约对齐 §3，可测：fake ports）──────

/**
 * complete 业务逻辑：active 守卫 + evidence 必填 + finalizeAndPersist。
 *
 * todo 完成检查属 adapter 跨扩展职责，在 execute 层完成（需 pi），不在此处。
 */
export function handleComplete(
	params: GoalControlActionParams,
	session: GoalSession,
	ports: ServicePorts,
): GoalControlDetails {
	const state = session.state;
	if (!state) throw new Error("Goal mode not active.");
	if (!isActiveStatus(state.status)) {
		throw new Error(`Goal is not active (status: ${state.status}). Only an active goal can be completed.`);
	}
	const evidence = params.evidence?.trim();
	if (!evidence) {
		throw new Error("'evidence' is required for complete. Provide concrete completion evidence.");
	}

	// FR-3.3: 唯一终态序列入口（内部：tickState → finalizeGoal(transition+history) → persist）
	finalizeAndPersist(state, "complete", params.completedTasks ?? 0, ports);
	updateWidget(session, ports.ui);
	ports.ui.notify(`Goal completed: ${state.objective}`, "info");

	return { action: "complete", goalId: state.goalId, status: state.status };
}

/**
 * report_blocked 业务逻辑：active 守卫 + reason 必填 + tickState + transitionStatus + persistState。
 *
 * 必须在 transitionStatus **之前** tickState，使 tick 看到 active 状态并累加当前运行段；
 * 否则转 blocked 后 persistState 内部的 tick 因 status≠active 不累加，丢失最后一段运行时间。
 */
export function handleReportBlocked(
	params: GoalControlActionParams,
	session: GoalSession,
	ports: ServicePorts,
): GoalControlDetails {
	const state = session.state;
	if (!state) throw new Error("Goal mode not active.");
	if (state.status !== "active") {
		throw new Error(`Goal is not active (status: ${state.status}). Only an active goal can report_blocked.`);
	}
	const reason = params.reason?.trim();
	if (!reason) {
		throw new Error("'reason' is required for report_blocked. Describe the blocking condition.");
	}

	state.lastBlockerReason = reason;
	// 先 tickState 累加当前运行段（此时 status 仍为 active）
	tickState(state);
	state.status = transitionStatus(state.status, "blocked");

	persistState(session, ports);
	updateWidget(session, ports.ui);
	ports.ui.notify(`Goal blocked: ${reason}`, "warning");

	return { action: "report_blocked", goalId: state.goalId, status: state.status };
}

// ── Tool 注册 ────────────────────────────────────────

export function registerGoalControlTool(pi: ExtensionAPI, session: GoalSession): void {
	pi.registerTool({
		name: "goal_control",
		label: "Goal Control",
		description:
			"Control the active goal's terminal state. Only use when a goal is active (/goal started).\n\nActions:\n- complete: mark the active goal complete. Requires `evidence` with concrete proof (files/tests/commands). All todos must be finished first.\n- report_blocked: mark the active goal blocked by a real blocker. Requires `reason` describing the block and what was tried. Only after genuine exhaustion of alternatives.",
		promptSnippet:
			"Use goal_control to end an active goal: complete (with evidence, todos done) or report_blocked (with reason, after trying alternatives).",
		executionMode: "sequential",
		parameters: GoalControlParams,

		async execute(
			_toolCallId: string,
			params: GoalControlActionParams,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: GoalControlDetails }> {
			if (signal?.aborted) {
				throw new Error("goal_control aborted by signal.");
			}
			const ports = buildPorts(pi, ctx);

			let details: GoalControlDetails;
			if (params.action === "complete") {
				// adapter 跨扩展守卫：todo 完成检查（undefined 降级，允许 complete）
				const incomplete = findIncompleteTodos(pi);
				if (incomplete !== TODO_DEGRADED && incomplete.length > 0) {
					throw new Error(
						`Cannot complete goal: ${incomplete.length} todo item(s) still incomplete. Finish them (or mark cancelled) before completing the goal.`,
					);
				}
				details = handleComplete(params, session, ports);
			} else {
				details = handleReportBlocked(params, session, ports);
			}

			const text =
				details.action === "complete"
					? `Goal completed.\nGoal ID: ${details.goalId}`
					: `Goal reported blocked.\nGoal ID: ${details.goalId}\nReason: ${params.reason?.trim() ?? ""}`;
			return { content: [{ type: "text", text }], details };
		},

		renderCall(args: Record<string, unknown>, theme: Theme): Text {
			const action = args.action as string;
			const actionLabel =
				action === "complete"
					? theme.fg("success", "complete")
					: theme.fg("error", "report_blocked");
			return new Text(theme.fg("toolTitle", theme.bold("goal_control ")) + actionLabel, 0, 0);
		},

		renderResult(result: unknown, _options: { expanded: boolean }, theme: Theme): Text {
			const d = (result as { details?: GoalControlDetails }).details;
			if (!d) return new Text(theme.fg("dim", "goal_control"), 0, 0);
			const statusColor = d.status === "complete" ? "success" : d.status === "blocked" ? "error" : "muted";
			const label = d.action === "complete" ? "Completed" : "Blocked";
			return new Text(theme.fg(statusColor, `◆ Goal ${label}`), 0, 0);
		},
	});
}
