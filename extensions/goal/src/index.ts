/**
 * Pi /goal Extension — 工厂入口（重构后架构）
 *
 * 注册 command / events，全部委托 adapters 层。
 * __goalInit 内部调 service.createGoal（FR-4.1）。
 *
 * 架构（D-21 双路径 + Ports/Adapters）：
 * - engine/：零 Pi 依赖的纯状态机（goal/budget/types）
 * - ports.ts：机器可检查的能力边界
 * - adapters/ports.ts：Pi → ServicePorts 桥接（单一构造点）
 * - service.ts：事件入口协调器（applyEvent）
 * - adapters/：Pi 桥接（command-adapter / event-adapter / ports）
 * - projection/：渲染（widget / prompts）
 *
 * FR-4.2/D-16：ctx 必填，移除 lastCtx 模块级可变状态。
 * FR-6.4：移除 hasPendingInjection。
 * FR-6.7：移除 pendingPause（ESC 改用 ctx.signal.aborted 守卫，在 event-adapter）。
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { handleGoalCommand } from "./adapters/command-adapter";
import {
	handleAgentEnd,
	handleAgentStart,
	handleBeforeAgentStart,
	handleMessageEnd,
	handleSessionStart,
	handleTurnEnd,
} from "./adapters/event-adapter";
import { registerGoalControlTool } from "./adapters/goal-control-adapter";
import { buildPorts } from "./adapters/ports";
import { createGoal } from "./service";
import { createGoalSession, type GoalSession } from "./session";

// ── Local Interfaces (Like*Event — 避免 any on Pi callback/event signatures) ────

interface BeforeAgentStartLikeEvent {
	type: "before_agent_start";
	prompt: string;
	systemPrompt: string;
}

interface TurnEndLikeEvent {
	type: "turn_end";
	turnIndex: number;
}

interface MessageEndLikeEvent {
	type: "message_end";
	message: {
		role: string;
		usage?: { input?: number; output?: number; cacheRead?: number; totalTokens?: number };
	};
}

interface AgentEndLikeEvent {
	type: "agent_end";
	messages: unknown[];
}

interface SessionStartLikeEvent {
	type: "session_start";
	reason: string;
}

interface LikeCustomMessage {
	customType: string;
	content: string | unknown;
}

interface LikeMessageRenderOptions {
	expanded: boolean;
}

// ── Extension Factory ─────────────────────────────────

export default function goalExtension(pi: ExtensionAPI) {
	const session: GoalSession = createGoalSession();

	// ── Command: /goal ────────────────────────────────

	pi.registerCommand("goal", {
		description:
			"Goal-driven mode: /goal <objective> [--tokens N] [--timeout N] | /goal resume | /goal clear | /goal update <new-objective> | /goal status | /goal history",
		handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
			await handleGoalCommand(pi, session, args, ctx);
		},
	});

	// ── Tool: goal_control（complete / report_blocked，#3 替代已删 goal_manager）──

	registerGoalControlTool(pi, session);

	// ── Events（全部委托 adapters/event-adapter）────────

	pi.on("before_agent_start", async (_event: BeforeAgentStartLikeEvent, ctx: ExtensionContext) => {
		return handleBeforeAgentStart(pi, session, ctx);
	});

	pi.on("agent_start", async () => {
		await handleAgentStart(session);
	});

	pi.on("turn_end", async (_event: TurnEndLikeEvent, ctx: ExtensionContext) => {
		await handleTurnEnd(pi, session, ctx);
	});

	pi.on("message_end", async (event: MessageEndLikeEvent, ctx: ExtensionContext) => {
		await handleMessageEnd(session, ctx, event);
	});

	pi.on("agent_end", async (_event: AgentEndLikeEvent, ctx: ExtensionContext) => {
		await handleAgentEnd(pi, session, ctx);
	});

	pi.on("session_start", async (_event: SessionStartLikeEvent, ctx: ExtensionContext) => {
		await handleSessionStart(pi, session, ctx);
	});

	// ── Message Renderers ──────────────────────────────

	const goalMessageTypes = ["goal-context", "goal-context-exceeded"];
	for (const customType of goalMessageTypes) {
		pi.registerMessageRenderer(
			customType,
			(message: LikeCustomMessage, _options: LikeMessageRenderOptions, theme: Theme) => {
				const prefix =
					message.customType === "goal-context-exceeded"
						? theme.fg("error", "[GOAL Budget] ")
						: theme.fg("accent", "[GOAL] ");
				const content =
					typeof message.content === "string" ? message.content : JSON.stringify(message.content);
				return new Text(prefix + theme.fg("dim", content), 0, 0);
			},
		);
	}

	// ── External API: __goalInit（FR-4 双轨消除）──────────

	/**
	 * 允许其他扩展（coding-workflow / plan）通过 pi.__goalInit 编程式初始化 goal。
	 * 内部调 service.createGoal（FR-4.1——与 /goal set 走同一创建逻辑）。
	 *
	 * FR-4.2/D-16: ctx 必填（消除 lastCtx 模块级可变状态）。
	 * ports 构造复用 adapters/ports.buildPorts（DRY：单一 ports 构造点）。
	 *
	 * @param objective 目标描述
	 * @param budget 预算配置，传 undefined 用默认值
	 * @param ctx **必填**——调用方的 ExtensionContext。省略会返回 false（创建失败）。
	 * @returns true 创建成功；false 已有 active goal 或 ctx 缺失
	 */
	const api = pi as unknown as Record<string, unknown>;
	api.__goalInit = (
		objective: string,
		budget: GoalInitBudget | undefined,
		ctx: ExtensionContext,
	): boolean => {
		if (!ctx) return false;
		return createGoal(session, objective, budget ?? {}, buildPorts(pi, ctx), true);
	};
}

// ── Cross-extension API 类型（单一 source of truth，API-1）──────────

/**
 * `pi.__goalInit` 的预算配置形状。
 *
 * 跨扩展（coding-workflow / plan）通过 `pi.__goalInit` 编程式初始化 goal 时使用。
 * 与 `BudgetConfig` 的差异：本类型只暴露外部可设的可选字段，且全部 optional。
 */
export interface GoalInitBudget {
	tokenBudget?: number;
	timeBudgetMinutes?: number;
}

/**
 * `pi.__goalInit` 的规范函数签名（API-1：单一 source of truth）。
 *
 * 跨扩展消费者应 import 本类型而非重复声明 inline alias，避免签名 drift：
 * ```ts
 * import type { GoalInitFn } from "@zhushanwen/pi-goal";
 * const goalInit = (pi as unknown as { __goalInit?: GoalInitFn }).__goalInit;
 * ```
 *
 * @param objective 目标描述
 * @param budget 预算配置，传 undefined 用默认值
 * @param ctx **必填**——调用方的 ExtensionContext。省略会返回 false（创建失败）。
 * @returns true 创建成功；false 已有 active goal 或 ctx 缺失
 */
export type GoalInitFn = (
	objective: string,
	budget: GoalInitBudget | undefined,
	ctx: ExtensionContext,
) => boolean;
