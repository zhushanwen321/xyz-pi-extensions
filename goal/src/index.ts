/**
 * Pi /goal Extension — Codex-style persistent goal-driven autonomous loop
 *
 * 功能：
 * - 持久化目标设定，支持 pause/resume/clear/update
 * - Evidence-based completion（完成任务必须提供具体证据）
 * - Token 预算 + 时间预算（含 70%/90% 预警）
 * - Blocked 状态检测（连续 stall 自动阻塞）
 * - Steering 模板化（continuation / budget-limit / objective-updated）
 * - 任务清单追踪
 *
 * 健壮性保障：
 * - goalId snapshot 防止旧回调操作新 goal
 * - 时间累计统一由 persistState 管理，无双写
 * - 防重入保护（hasPendingInjection）
 * - deserializeState 向后兼容旧格式
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

import {
	type GoalRuntimeState,
	type GoalTask,
	type BudgetConfig,
	DEFAULT_BUDGET,
	createInitialState,
	transitionStatus,
	isTerminalStatus,
	isActiveStatus,
	serializeState,
	deserializeState,
	getCompletedCount,
	getIncompleteTasks,
	getElapsedTimeSeconds,
	getTokenUsagePercent,
	getTimeUsagePercent,
} from "./state";

import { parseGoalArgs } from "./commands";
import {
	continuationPrompt,
	budgetLimitPrompt,
	objectiveUpdatedPrompt,
	contextInjectionPrompt,
	formatTaskList,
} from "./templates";

import { renderStatusLine, renderWidgetLines } from "./widget";

// ── Constants ─────────────────────────────────────────

const ENTRY_TYPE = "goal-state";

// ── Tool Parameter Schemas ────────────────────────────

const GoalManagerParams = Type.Object({
	action: StringEnum([
		"create_tasks",
		"complete_task",
		"list_tasks",
		"complete_goal",
		"report_blocked",
	] as const),
	tasks: Type.Optional(Type.Array(Type.String(), { description: "Task descriptions for create_tasks" })),
	taskId: Type.Optional(Type.Number({ description: "Task ID for complete_task" })),
	evidence: Type.Optional(Type.String({ description: "Evidence for completion (required for complete_task and complete_goal)" })),
	reason: Type.Optional(Type.String({ description: "Reason for being blocked (required for report_blocked)" })),
});

// ── Tool Details Types ────────────────────────────────

interface GoalManagerDetails {
	action: string;
	tasks: GoalTask[];
	goalId: string;
	status: string;
}

// ── Extension Factory ─────────────────────────────────

export default function goalExtension(pi: ExtensionAPI) {
	let state: GoalRuntimeState | null = null;
	let tasksCompletedAtAgentStart = 0;
	let hasPendingInjection = false; // P1-3: 防重入，before_agent_start 设 true，agent_end 检查

	// ── Tool: goal_manager ─────────────────────────────

	pi.registerTool({
		name: "goal_manager",
		label: "Goal Manager",
		description:
			"管理 /goal 模式的目标和任务清单。必须在开始工作前调用 create_tasks 拆分任务。" +
			"完成每个任务调用 complete_task（必须提供 evidence）。" +
			"目标达成时调用 complete_goal（必须提供整体 evidence）。" +
			"遇到阻塞调用 report_blocked。只在 /goal 模式激活时可用。",
		promptSnippet: "管理目标驱动模式下的任务清单和完成状态",
		promptGuidelines: [
			"使用 goal_manager 的 create_tasks 在开始工作前将目标拆分为可验证的具体步骤",
			"如果已有任务清单，不要再次调用 create_tasks，除非目标被更新",
			"完成每个任务后必须调用 goal_manager 的 complete_task 并提供 evidence（具体证据，如'运行测试 X 通过'）",
			"只有当你能提供具体证据证明目标已达成时，才能调用 goal_manager 的 complete_goal",
			"遇到无法解决的阻塞时，调用 goal_manager 的 report_blocked 报告原因",
			"使用 goal_manager 的 list_tasks 查看当前进度和剩余任务",
		],
		parameters: GoalManagerParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state) {
				throw new Error("Goal 模式未激活。使用 /goal <objective> 启动。");
			}

			switch (params.action) {
				case "create_tasks": {
					if (!params.tasks || params.tasks.length === 0) {
						throw new Error("create_tasks requires a non-empty tasks array");
					}
					// 保护已有任务进度：如果已有未完成任务，拒绝覆盖
					const existingIncomplete = getIncompleteTasks(state.tasks);
					if (state.tasks.length > 0 && existingIncomplete.length > 0) {
						throw new Error(
							`已有 ${state.tasks.length} 个任务（${existingIncomplete.length} 个未完成）。` +
								`请继续完成现有任务，不要重新创建。如需重新规划，请先使用 /goal update 更新目标。`,
						);
					}
					state.tasks = params.tasks.map((desc, i) => ({
						id: i + 1,
						description: desc,
						completed: false,
					}));
					persistState(ctx);
					return makeResult(
						`已创建 ${state.tasks.length} 个任务：\n${state.tasks.map((t) => `  #${t.id}: ${t.description}`).join("\n")}`,
					);
				}

				case "complete_task": {
					if (params.taskId === undefined) {
						throw new Error("complete_task requires taskId");
					}
					if (!params.evidence || params.evidence.trim() === "") {
						throw new Error("complete_task requires evidence — 提供具体的完成证据（如'测试通过'、'文件已创建'等）");
					}
					const task = state.tasks.find((t) => t.id === params.taskId);
					if (!task) {
						throw new Error(`Task #${params.taskId} not found`);
					}
					if (task.completed) {
						return makeResult(`任务 #${task.id} 已完成，无需重复标记。`);
					}
					task.completed = true;
					task.evidence = params.evidence;
					persistState(ctx);
					return makeResult(`已完成任务 #${task.id}: ${task.description}\n证据: ${params.evidence}`);
				}

				case "list_tasks": {
					return makeResult(formatTaskList(state.tasks));
				}

				case "complete_goal": {
					if (!params.evidence || params.evidence.trim() === "") {
						throw new Error("complete_goal requires evidence — 提供具体的证据证明目标已达成");
					}
					// R4: 零任务拒绝——防止模型跳过任务追踪直接完成
					if (state.tasks.length === 0) {
						throw new Error("请先使用 create_tasks 创建任务清单，再完成目标。");
					}
					const incomplete = getIncompleteTasks(state.tasks);
					if (incomplete.length > 0) {
						throw new Error(
							`还有 ${incomplete.length} 个任务未完成：${incomplete.map((t) => `#${t.id}`).join(", ")}。` +
								`请先完成这些任务或提供理由说明为什么它们不需要完成。`,
						);
					}
					state.status = transitionStatus(state.status, "complete");
					persistState(ctx);
					// #7: 完成时的预算报告
					const budgetReport: string[] = [];
					budgetReport.push(`总轮次: ${state.turnCount}`);
					budgetReport.push(`任务完成: ${getCompletedCount(state.tasks)}/${state.tasks.length}`);
					if (state.budget.tokenBudget) {
						budgetReport.push(`Token 消耗: ${state.tokensUsed}/${state.budget.tokenBudget}`);
					}
					const elapsed = getElapsedTimeSeconds(state);
					budgetReport.push(`用时: ${Math.floor(elapsed / 60)}分${Math.floor(elapsed % 60)}秒`);
					return makeResult(
						`目标已完成!\n证据: ${params.evidence}\n\n--- Budget Report ---\n${budgetReport.join("\n")}`,
					);
				}

				case "report_blocked": {
					if (!params.reason || params.reason.trim() === "") {
						throw new Error("report_blocked requires reason — 说明阻塞原因");
					}
					state.lastBlockerReason = params.reason;
					state.status = transitionStatus(state.status, "blocked");
					persistState(ctx);
					return makeResult(`已报告阻塞。原因: ${params.reason}`);
				}

				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("goal_manager ")) + theme.fg("muted", args.action);
			if (args.tasks) text += ` ${theme.fg("dim", `(${args.tasks.length} tasks)`)}`;
			if (args.taskId !== undefined) text += ` ${theme.fg("accent", `#${args.taskId}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as GoalManagerDetails | undefined;
			if (!details || !Array.isArray(details.tasks)) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const tasks = details.tasks;
			const completed = tasks.filter((t) => t.completed).length;
			const summary = theme.fg("success", `✓ ${completed}/${tasks.length} 完成`);
			if (!expanded || tasks.length === 0) {
				return new Text(summary, 0, 0);
			}
			const lines = [summary];
			for (const t of tasks) {
				const icon = t.completed ? theme.fg("success", "✓") : theme.fg("dim", "☐");
				const desc = t.completed ? theme.fg("dim", t.description) : theme.fg("text", t.description);
				lines.push(`  ${icon} ${theme.fg("accent", `#${t.id}`)} ${desc}`);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// ── Helpers ────────────────────────────────────────

	function makeResult(text: string) {
		if (!state) throw new Error("No active goal");
		const budgetInfo: string[] = [];
		// #6: Tool 响应包含剩余预算
		if (state.budget.tokenBudget) {
			const remaining = Math.max(state.budget.tokenBudget - state.tokensUsed, 0);
			budgetInfo.push(`Token: ${state.tokensUsed}/${state.budget.tokenBudget} (剩余 ${remaining})`);
		}
		if (state.budget.timeBudgetMinutes) {
			const elapsed = getElapsedTimeSeconds(state);
			const remaining = Math.max(state.budget.timeBudgetMinutes * 60 - elapsed, 0);
			budgetInfo.push(`时间: ${Math.floor(elapsed / 60)}分/${state.budget.timeBudgetMinutes}分 (剩余 ${Math.floor(remaining / 60)}分)`);
		}
		const suffix = budgetInfo.length > 0 ? `\n\n[Budget] ${budgetInfo.join(" | ")}` : "";
		return {
			content: [{ type: "text", text: text + suffix }],
			details: {
				action: "update",
				tasks: state.tasks.map((t) => ({ ...t })),
				goalId: state.goalId,
				status: state.status,
			} satisfies GoalManagerDetails,
		};
	}

	/**
	 * 持久化状态。统一管理时间累计，调用方不需要手动赋值 timeUsedSeconds。
	 * R2 修复：无论什么状态都同步时间，消除双写问题。
	 */
	function persistState(ctx: ExtensionContext): void {
		if (!state) return;
		const now = Date.now();
		if (state.timeStartedAt > 0) {
			state.timeUsedSeconds += (now - state.timeStartedAt) / 1000;
			state.timeStartedAt = now;
		}
		pi.appendEntry(ENTRY_TYPE, serializeState(state));
	}

	function reconstructState(ctx: ExtensionContext): void {
		state = null;
		const entries = ctx.sessionManager.getEntries();

		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (
				entry.type === "custom" &&
				"customType" in entry &&
				(entry as any).customType === ENTRY_TYPE
			) {
				const data = (entry as any).data as Record<string, unknown> | undefined;
				if (data) {
					state = deserializeState(data);
				}
				break;
			}
		}

		if (!state) return;

		// 非终态 → 恢复为 active（session 重启后 resume）
		if (!isTerminalStatus(state.status) && state.status !== "paused") {
			state.status = "active";
			state.timeStartedAt = Date.now();
		}

		// #3: Entry GC — 标记旧的 goal-state entries 以便 session manager 清理
		// 找到最新 entry 后，向前扫描所有旧的 goal-state entries 并从数组移除
		// 这防止长 session 中 entries 无限积累
		const goalEntryIndices: number[] = [];
		let latestFound = false;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (
				entry.type === "custom" &&
				"customType" in entry &&
				(entry as any).customType === ENTRY_TYPE
			) {
				if (!latestFound) {
					latestFound = true; // 保留最新的
				} else {
					goalEntryIndices.push(i);
				}
			}
		}
		// 从后向前删除，避免索引偏移
		for (const idx of goalEntryIndices) {
			entries.splice(idx, 1);
		}
	}

	function updateWidget(ctx: ExtensionContext): void {
		if (!state || state.status === "cancelled") {
			ctx.ui.setWidget("goal", undefined);
			ctx.ui.setStatus("goal", undefined);
			return;
		}

		ctx.ui.setStatus("goal", renderStatusLine(state, ctx.ui.theme));
		ctx.ui.setWidget("goal", renderWidgetLines(state, ctx.ui.theme));
	}

	function clearGoal(ctx: ExtensionContext): void {
		state = null;
		tasksCompletedAtAgentStart = 0;
		hasPendingInjection = false;
		ctx.ui.setWidget("goal", undefined);
		ctx.ui.setStatus("goal", undefined);
	}

	// ── Command: /goal ─────────────────────────────────

	pi.registerCommand("goal", {
		description:
			"目标驱动模式: /goal <objective> [--tokens N] [--timeout N] [--max-turns N] | /goal pause | /goal resume | /goal clear | /goal update <new-objective> | /goal status",
		handler: async (args, ctx) => {
			const parsed = parseGoalArgs(args);

			switch (parsed.action) {
				case "status": {
					if (!state) {
						ctx.ui.notify("Goal 模式未激活。使用 /goal <objective> 启动。", "info");
						return;
					}
					const completed = getCompletedCount(state.tasks);
					const total = state.tasks.length;
					const elapsed = getElapsedTimeSeconds(state);
					const lines = [
						`目标: ${state.objective}`,
						`状态: ${state.status}`,
						`轮次: ${state.turnCount}/${state.budget.maxTurns}`,
						`任务: ${completed}/${total} 完成`,
						`无进展轮数: ${state.stallCount}`,
						`已用时间: ${Math.floor(elapsed / 60)}分${Math.floor(elapsed % 60)}秒`,
						state.budget.tokenBudget ? `Token: ${state.tokensUsed}/${state.budget.tokenBudget}` : null,
						`Goal ID: ${state.goalId}`,
					].filter(Boolean);
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				case "pause": {
					if (!state) {
						ctx.ui.notify("Goal 模式未激活。", "warning");
						return;
					}
					if (isTerminalStatus(state.status)) {
						ctx.ui.notify(`Goal 已处于终态 (${state.status})，无法暂停。`, "warning");
						return;
					}
					state.status = transitionStatus(state.status, "paused");
					persistState(ctx);
					updateWidget(ctx);
					ctx.ui.notify("Goal 已暂停。使用 /goal resume 恢复。", "info");
					return;
				}

				case "resume": {
					if (!state) {
						ctx.ui.notify("Goal 模式未激活。", "warning");
						return;
					}
					if (isTerminalStatus(state.status)) {
						ctx.ui.notify(`Goal 已处于终态 (${state.status})，无法恢复。`, "warning");
						return;
					}
					if (state.status !== "paused" && state.status !== "blocked") {
						ctx.ui.notify("Goal 未暂停或阻塞，无需恢复。", "info");
						return;
					}
					state.status = "active";
					state.stallCount = 0;
					state.timeStartedAt = Date.now();

					// #1: Resume 时重检预算 — 如果 token 或时间已超限，直接转终态
					if (state.budget.tokenBudget && state.tokensUsed >= state.budget.tokenBudget) {
						state.status = transitionStatus(state.status, "budget_limited");
						persistState(ctx);
						updateWidget(ctx);
						ctx.ui.notify("Token 预算已耗尽，无法恢复。使用 /goal clear 清除。", "warning");
						return;
					}
					if (state.budget.timeBudgetMinutes) {
						const elapsed = getElapsedTimeSeconds(state);
						if (elapsed >= state.budget.timeBudgetMinutes * 60) {
							state.status = transitionStatus(state.status, "time_limited");
							persistState(ctx);
							updateWidget(ctx);
							ctx.ui.notify("时间预算已耗尽，无法恢复。使用 /goal clear 清除。", "warning");
							return;
						}
					}

					persistState(ctx);
					updateWidget(ctx);

					const incomplete = getIncompleteTasks(state.tasks);
					if (incomplete.length > 0) {
						pi.sendUserMessage(
							`Goal 已恢复。继续执行剩余 ${incomplete.length} 个任务。` +
							(state.lastBlockerReason ? `

上次阻塞原因: ${state.lastBlockerReason}。请尝试不同的方法。` : "") +
							`

目标: ${state.objective}`,
							{ deliverAs: "followUp" },
						);
					} else {
						ctx.ui.notify("所有任务已完成。", "info");
					}
					return;
				}

				case "clear": {
					if (!state) {
						ctx.ui.notify("Goal 模式未激活。", "info");
						return;
					}
					state.status = "cancelled";
					persistState(ctx);
					clearGoal(ctx);
					ctx.ui.notify("Goal 已清除。", "info");
					return;
				}

				case "update": {
					if (!state) {
						ctx.ui.notify("Goal 模式未激活。", "warning");
						return;
					}
					if (!parsed.objective) {
						ctx.ui.notify("用法: /goal update <new-objective>", "warning");
						return;
					}
					const oldObjective = state.objective;
					state.objective = parsed.objective;
					state.objectiveUpdatedAt = Date.now();
					// 清除已有任务，允许重新规划
					state.tasks = [];
					// R3: 重置所有计数器，防止旧计数器影响新目标
					state.stallCount = 0;
					state.turnCount = 0;
					state.lastProgressTurn = 0;
					state.budgetLimitSteeringSent = false;
					state.budgetWarning70Sent = false;
					state.budgetWarning90Sent = false;
					tasksCompletedAtAgentStart = 0;
					persistState(ctx);
					updateWidget(ctx);
					ctx.ui.notify(`目标已更新:\n旧: ${oldObjective}\n新: ${parsed.objective}`, "info");

					if (isActiveStatus(state.status)) {
						pi.sendUserMessage(objectiveUpdatedPrompt(state, oldObjective), { deliverAs: "steer" });
					}
					return;
				}

				case "set": {
					if (!parsed.objective) {
						ctx.ui.notify("用法: /goal <objective> [--tokens N] [--timeout N]", "warning");
						return;
					}
					// #2: 空白 objective 拦截
					if (!parsed.objective.trim()) {
						ctx.ui.notify("目标描述不能为空。", "warning");
						return;
					}
					// 如果已有活跃 goal，先取消旧的并通知用户
					if (state && !isTerminalStatus(state.status)) {
						ctx.ui.notify(
							`已取消旧 Goal: ${state.objective}\n(新目标已启动)`,
							"info",
						);
						state.status = "cancelled";
						persistState(ctx);
					}

					// P2: 零预算拒绝
					if (parsed.budget?.tokenBudget !== undefined && parsed.budget.tokenBudget <= 0) {
						ctx.ui.notify("Token 预算必须大于 0。", "warning");
						return;
					}
					// P1: Objective 长度限制
					if (parsed.objective.length > 4000) {
						ctx.ui.notify(`目标描述过长（${parsed.objective.length} 字符），上限 4000 字符。`, "warning");
						return;
					}

					const budget: Partial<BudgetConfig> = {};
					if (parsed.budget?.tokenBudget) budget.tokenBudget = parsed.budget.tokenBudget;
					if (parsed.budget?.timeBudgetMinutes) budget.timeBudgetMinutes = parsed.budget.timeBudgetMinutes;
					budget.maxTurns = parsed.budget?.maxTurns ?? DEFAULT_BUDGET.maxTurns;
					budget.maxStallTurns = parsed.budget?.maxStallTurns ?? DEFAULT_BUDGET.maxStallTurns;

					state = createInitialState(parsed.objective, budget);
					tasksCompletedAtAgentStart = 0;
					hasPendingInjection = false;

					persistState(ctx);
					updateWidget(ctx);

					const budgetNotice: string[] = [];
					if (budget.tokenBudget) budgetNotice.push(`Token 预算: ${budget.tokenBudget}`);
					if (budget.timeBudgetMinutes) budgetNotice.push(`时间预算: ${budget.timeBudgetMinutes} 分钟`);
					const notice = [
						`Goal 已启动: ${parsed.objective}`,
						`最大轮次: ${budget.maxTurns}`,
						...budgetNotice,
					].join("\n");
					ctx.ui.notify(notice, "info");

					pi.sendUserMessage(parsed.objective, { deliverAs: "followUp" });
					return;
				}
			}
		},
	});

	// ── Event: before_agent_start ──────────────────────

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!state || !isActiveStatus(state.status)) return;

		// 标记有 pending injection，防止 agent_end 重复发 continuation
		hasPendingInjection = true;

		// 上下文空间保护
		const usage = ctx.getContextUsage();
		if (usage && usage.contextWindow > 0 && (usage.tokens ?? 0) / usage.contextWindow > 0.85) {
			state.status = transitionStatus(state.status, "paused");
			persistState(ctx);
			updateWidget(ctx);

			return {
				message: {
					customType: "goal-context-exceeded",
					content:
						"[GOAL — 上下文空间不足，必须立即收尾]\n" +
						"1. 用 goal_manager 的 list_tasks 查看剩余任务\n" +
						"2. 只标记你真正完成且有证据的任务\n" +
						"3. 总结当前进度和剩余工作\n" +
						"不要再开始新任务。",
					display: false,
				},
			};
		}

		return {
			message: {
				customType: "goal-context",
				content: contextInjectionPrompt(state),
				display: false,
			},
		};
	});

	// ── Event: agent_start — 记录本 agent loop 起始时的完成数 ──

	pi.on("agent_start", async () => {
		if (!state || !isActiveStatus(state.status)) return;
		tasksCompletedAtAgentStart = getCompletedCount(state.tasks);
	});

	// ── Event: turn_end ────────────────────────────────

	pi.on("turn_end", async (_event, ctx) => {
		if (!state) return;
		updateWidget(ctx);
	});

	// ── Event: message_end (token accounting) ──────────
	// 排除 cached input 以避免跨 turn 双重计算（对齐 Codex 公式）

	pi.on("message_end", async (event, _ctx) => {
		if (!state || !isActiveStatus(state.status)) return;
		if (event.message.role !== "assistant") return;

		const usage = event.message.usage;
		if (usage) {
			const input = usage.input ?? 0;
			const output = usage.output ?? 0;
			const cacheRead = usage.cacheRead ?? 0;
			if (input > 0 || output > 0) {
				// #4: Codex 公式 = (input - cached) + output
				state.tokensUsed += Math.max(input - cacheRead, 0) + output;
			} else if (usage.totalTokens) {
				state.tokensUsed += usage.totalTokens;
			}
		}
	});

	// ── Event: agent_end ───────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		if (!state) return;

		// R1: 捕获 goalId snapshot，防止旧回调操作新 goal
		const snapshotGoalId = state.goalId;

		const checkStale = () => !state || state.goalId !== snapshotGoalId;

		// ── 处理 complete/blocked（tool execute 中设置的状态）──

		if (state.status === "complete") {
			persistState(ctx);
			if (checkStale()) return;
			updateWidget(ctx);
			ctx.ui.notify(
				`目标已完成 ✓ (${getCompletedCount(state.tasks)}/${state.tasks.length} 任务, ${state.turnCount} 轮)`,
				"info",
			);
			return;
		}

		if (state.status === "blocked") {
			persistState(ctx);
			if (checkStale()) return;
			updateWidget(ctx);
			ctx.ui.notify("Goal 被阻塞。使用 /goal resume 恢复或 /goal clear 清除。", "warning");
			return;
		}

		// ── 只处理 active 状态 ──

		if (!isActiveStatus(state.status)) return;

		// P1-3: 防重入——如果 before_agent_start 注入了 context，跳过本轮 continuation
		if (hasPendingInjection) {
			hasPendingInjection = false;
			return;
		}

		if (checkStale()) return;

		// ── 预算预警（P2-6: token + time 70%/90%）──

		if (state.budget.tokenBudget) {
			const pct = state.tokensUsed / state.budget.tokenBudget;
			if (pct >= 0.9 && !state.budgetWarning90Sent) {
				state.budgetWarning90Sent = true;
				ctx.ui.notify("Token 预算已用 90%，请开始收尾。", "warning");
			} else if (pct >= 0.7 && !state.budgetWarning70Sent) {
				state.budgetWarning70Sent = true;
				ctx.ui.notify("Token 预算已用 70%，注意控制范围。", "info");
			}
		}
		if (state.budget.timeBudgetMinutes) {
			const elapsed = getElapsedTimeSeconds(state);
			const timePct = elapsed / (state.budget.timeBudgetMinutes * 60);
			if (timePct >= 0.9 && !state.budgetWarning90Sent) {
				state.budgetWarning90Sent = true;
				ctx.ui.notify("时间预算已用 90%，请开始收尾。", "warning");
			} else if (timePct >= 0.7 && !state.budgetWarning70Sent) {
				state.budgetWarning70Sent = true;
				ctx.ui.notify("时间预算已用 70%，注意控制范围。", "info");
			}
		}

		// Token 预算检查（同步两阶段）
		// Phase 1: 首次达到 90% 预算 → 注入 steering，允许一轮收尾
		// Phase 2: 已发 steering 且已达到 100% → 直接终止
		if (state.budget.tokenBudget) {
			const pct = state.tokensUsed / state.budget.tokenBudget;

			if (pct >= 1 && state.budgetLimitSteeringSent) {
				state.status = transitionStatus(state.status, "budget_limited");
				persistState(ctx);
				if (checkStale()) return;
				updateWidget(ctx);
				ctx.ui.notify("Token 预算已耗尽，Goal 已终止。", "warning");
				return;
			}

			if (pct >= 0.9 && !state.budgetLimitSteeringSent) {
				state.budgetLimitSteeringSent = true;
				persistState(ctx);
				if (checkStale()) return;
				updateWidget(ctx);
				pi.sendUserMessage(budgetLimitPrompt(state, "token"), { deliverAs: "steer" });
				return;
			}
		}

		// 时间预算检查
		if (state.budget.timeBudgetMinutes) {
			const elapsed = getElapsedTimeSeconds(state);
			if (elapsed >= state.budget.timeBudgetMinutes * 60) {
				state.status = transitionStatus(state.status, "time_limited");
				persistState(ctx);
				if (checkStale()) return;
				updateWidget(ctx);
				ctx.ui.notify(
					`时间预算耗尽 (${state.budget.timeBudgetMinutes} 分钟)，Goal 已终止。`,
					"warning",
				);
				return;
			}
		}

		if (checkStale()) return;

		// ── 统一 turnCount 递增（先递增再检查）──

		state.turnCount++;

		// 所有任务完成但 goal 未标记 complete → 自动提示
		const incomplete = getIncompleteTasks(state.tasks);
		const total = state.tasks.length;
		if (total > 0 && incomplete.length === 0) {
			// 防止无限循环：多次提示后仍未 complete 则自动 complete
			if (state.turnCount >= state.budget.maxTurns) {
				state.status = transitionStatus(state.status, "complete");
				persistState(ctx);
				if (checkStale()) return;
				updateWidget(ctx);
				ctx.ui.notify(
					`所有任务已完成，Goal 自动结束。(${getCompletedCount(state.tasks)}/${total} 任务, ${state.turnCount} 轮)`,
					"info",
				);
				return;
			}

			// P2-7: 预算紧张时用 steer 优先完成，而非 followUp
			const budgetTight = state.budget.tokenBudget
				&& state.tokensUsed >= state.budget.tokenBudget * 0.8;

			if (budgetTight) {
				pi.sendUserMessage(
					`所有任务已完成，且 token 预算已用 ${Math.round(state.tokensUsed / state.budget.tokenBudget! * 100)}%。` +
					`请立即调用 goal_manager 的 complete_goal 完成目标，提供整体 evidence。` +
					`\n\n目标: ${state.objective}`,
					{ deliverAs: "steer" },
				);
			} else {
				pi.sendUserMessage(
					`所有 ${total} 个任务已完成。请调用 goal_manager 的 complete_goal 完成目标，提供整体 evidence。` +
						`\n\n目标: ${state.objective}`,
					{ deliverAs: "followUp" },
				);
			}
			persistState(ctx);
			updateWidget(ctx);
			return;
		}

		// 没有任务创建
		if (total === 0) {
			if (state.turnCount >= state.budget.maxTurns) {
				state.status = transitionStatus(state.status, "cancelled");
				persistState(ctx);
				if (checkStale()) return;
				updateWidget(ctx);
				ctx.ui.notify(
					`已达最大轮次 (${state.budget.maxTurns})，LLM 未创建任务清单。`,
					"warning",
				);
				return;
			}
			pi.sendUserMessage(
				`你尚未创建任务清单。请立即调用 goal_manager 的 create_tasks 将工作拆分为具体可验证的任务步骤。` +
					`\n\n目标: ${state.objective}`,
				{ deliverAs: "followUp" },
			);
			persistState(ctx);
			updateWidget(ctx);
			return;
		}

		// 最大轮次检查
		if (state.turnCount >= state.budget.maxTurns) {
			state.status = transitionStatus(state.status, "cancelled");
			persistState(ctx);
			if (checkStale()) return;
			updateWidget(ctx);
			ctx.ui.notify(
				`已达最大轮次 (${state.budget.maxTurns})，还有 ${incomplete.length} 个任务未完成。`,
				"warning",
			);
			return;
		}

		// 进展跟踪（基于 agent_start 时记录的完成数，而非 turn_start）
		const currentCompleted = getCompletedCount(state.tasks);
		const progressThisRound = currentCompleted - tasksCompletedAtAgentStart;

		if (progressThisRound === 0) {
			state.stallCount++;
		} else {
			state.stallCount = 0;
			state.lastProgressTurn = state.turnCount;
		}

		// Stall → Blocked
		if (state.stallCount >= state.budget.maxStallTurns) {
			state.status = transitionStatus(state.status, "blocked");
			persistState(ctx);
			if (checkStale()) return;
			updateWidget(ctx);
			ctx.ui.notify(
				`已连续 ${state.stallCount} 轮无进展，Goal 自动阻塞。使用 /goal resume 恢复或 /goal clear 清除。`,
				"warning",
			);
			return;
		}

		if (checkStale()) return;

		// P0: 去抖 — 检测本 turn 是否有任何 token 消耗
		// 如果 token delta = 0，说明模型没做任何实质工作，不发 continuation
		const tokenDelta = state.tokensUsed - state.lastTurnTokensUsed;
		state.lastTurnTokensUsed = state.tokensUsed;

		if (tokenDelta === 0) {
			persistState(ctx);
			updateWidget(ctx);
			// 不发 continuation，等待用户输入
			return;
		}

		// Normal continuation
		persistState(ctx);
		updateWidget(ctx);

		pi.sendUserMessage(continuationPrompt(state), { deliverAs: "followUp" });
	});

	// ── Event: session_start (state reconstruction) ───

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		if (state) {
			tasksCompletedAtAgentStart = getCompletedCount(state.tasks);
			updateWidget(ctx);
		}
	});

	// ── Message Renderers ──────────────────────────────

	const goalMessageTypes = [
		"goal-context",
		"goal-context-exceeded",
	];

	for (const customType of goalMessageTypes) {
		pi.registerMessageRenderer(customType, (message, _options, theme) => {
			const prefix =
				message.customType === "goal-context-exceeded"
					? theme.fg("error", "[GOAL 预算] ")
					: theme.fg("accent", "[GOAL] ");
			const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
			return new Text(prefix + theme.fg("dim", content), 0, 0);
		});
	}
}
