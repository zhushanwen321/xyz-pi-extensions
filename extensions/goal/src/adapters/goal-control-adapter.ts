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
import type { ProgressInput } from "../engine/budget";
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

// ── duck-typed todo 读取（#7 正式暴露后组装 ProgressInput）────────

export const TODO_DEGRADED = "degraded" as const;

/** duck-typed todo 项形状（运行时按字段判断，不 import todo extension 类型） */
interface TodoLike {
	id?: number;
	text?: string;
	status?: string;
	isVerification?: boolean;
}

/**
 * 从 pi.__todoGetList 组装 ProgressInput（duck-typed，#7）。
 *
 * 方案 A "undefined=降级"：todo 未加载或返回非数组 → undefined，调用方跳过 todo 检查。
 * 不 import todo extension 类型，纯运行时按 status/id/isVerification 字段判断，避免编译期依赖。
 *
 * FR-1: cancelled 非验证项计为「已解决」（completed++）；
 *   cancelled 验证项（isVerification=true）计为「未完成」（FR-2 验证任务不可 cancelled）。
 */
export function buildProgressInput(pi: ExtensionAPI): ProgressInput | undefined {
	const todoList = (pi as unknown as { __todoGetList?: () => unknown }).__todoGetList?.();
	if (!Array.isArray(todoList)) return undefined;
	let completed = 0;
	const incompleteIds: number[] = [];
	let hasVerificationPending = false;
	for (const t of todoList) {
		if (!t || typeof t !== "object") continue;
		const todo = t as TodoLike;
		const isVerification = todo.isVerification === true;
		if (todo.status === "completed") {
			completed++;
		} else if (todo.status === "cancelled" && !isVerification) {
			// FR-1: 非验证任务 cancelled = 已解决
			completed++;
		} else if (todo.status === "cancelled" && isVerification) {
			// FR-2: 验证任务 cancelled = 未完成（验证任务不可 cancelled）
			if (typeof todo.id === "number") incompleteIds.push(todo.id);
			hasVerificationPending = true;
		} else if (typeof todo.id === "number") {
			// pending / in_progress
			incompleteIds.push(todo.id);
			if (isVerification) hasVerificationPending = true;
		}
	}
	return { completedCount: completed, totalCount: todoList.length, incompleteIds, hasVerificationPending };
}

/**
 * complete 动作的 todo 完成守卫：返回未完成项 id 或降级标记。
 *
 * 委托 buildProgressInput（不重复 duck-typed 读取逻辑）。
 * 返回 undefined（todo 未加载）→ "degraded"，调用方跳过检查（允许 complete）。
 *
 * 注：此函数用于纯进度查询（如 agent_end allTasksDone 判定）。
 * complete 前置硬检查请用 {@link checkCompletePrerequisites}（spec FR-2 #1-#4）。
 */
export function findIncompleteTodos(pi: ExtensionAPI): number[] | typeof TODO_DEGRADED {
	const progress = buildProgressInput(pi);
	if (!progress) return TODO_DEGRADED;
	return progress.incompleteIds;
}

// ── complete 前置检查（spec FR-2 #1-#4）──────────────

export interface CompleteCheckResult {
	ok: boolean;
	/** ok=false 时的拒绝原因（含未完成项明细） */
	reason?: string;
}

/**
 * complete 前置硬检查（spec FR-2 complete 前置 #1-#4）。
 *
 * 与 {@link findIncompleteTodos}（纯进度查询，undefined 降级放行）的区别：
 * 此函数是 complete 路径的**硬守卫**，undefined（todo 未加载）必须拒绝——
 * 没有 todo extension 时无法验证完成，不能 complete。
 *
 * #1 todo 未加载（undefined）→ 拒绝："需要 todo extension"
 * #2 空数组 [] → 拒绝："必须先用 todo 工具建任务（含验证任务）"
 * #3 验证任务（isVerification=true）必须 completed（不可 cancelled）
 * #4 有未完成 todo → 拒绝，列出未完成项 id + text + verification 标记
 */
export function checkCompletePrerequisites(pi: ExtensionAPI): CompleteCheckResult {
	const todoList = (pi as unknown as { __todoGetList?: () => unknown }).__todoGetList?.();
	// #1: todo 未加载 → 拒绝
	if (!Array.isArray(todoList)) {
		return { ok: false, reason: "Cannot complete goal: todo extension is required. Install pi-todo to enable completion verification." };
	}
	// #2: 空数组 → 拒绝
	if (todoList.length === 0) {
		return { ok: false, reason: "Cannot complete goal: no todos exist. Use the todo tool to create tasks (including verification tasks with isVerification=true) first." };
	}

	// #3 + #4: 逐项检查
	const incomplete: Array<{ id: number; text: string; verification: boolean }> = [];
	let verificationCancelled = false;
	for (const t of todoList) {
		if (!t || typeof t !== "object") continue;
		const todo = t as TodoLike;
		if (typeof todo.id !== "number") continue;
		const isVerification = todo.isVerification === true;
		const status = todo.status;
		if (status === "completed") continue;
		if (status === "cancelled") {
			// FR-2 #3: 验证任务 cancelled = 未完成（验证任务不可 cancelled）
			if (isVerification) {
				verificationCancelled = true;
				incomplete.push({ id: todo.id, text: todo.text ?? "(no text)", verification: true });
			}
			// 非验证任务 cancelled = 已解决，跳过
			continue;
		}
		// pending / in_progress / 未知状态 → 未完成
		incomplete.push({ id: todo.id, text: todo.text ?? "(no text)", verification: isVerification });
	}

	if (incomplete.length > 0) {
		const lines = incomplete.map((i) => `  #${i.id}${i.verification ? " [verification]" : ""}: ${i.text}`);
		const suffix = verificationCancelled
			? "\nNote: verification todos (isVerification=true) must be completed, not cancelled."
			: "";
		return {
			ok: false,
			reason: `Cannot complete goal: ${incomplete.length} todo item(s) still incomplete.\n${lines.join("\n")}${suffix}`,
		};
	}

	return { ok: true };
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
				// FR-2 complete 前置硬检查（#1-#4）：todo 未加载/空/未完成 → 拒绝
				const check = checkCompletePrerequisites(pi);
				if (!check.ok) {
					throw new Error(check.reason);
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
