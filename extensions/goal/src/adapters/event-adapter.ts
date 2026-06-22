/**
 * Event adapter — Pi 事件 handler + 并发保护（adapters 层）
 *
 * 6 个事件 handler 分两 wave 实现：
 * - Wave 12（本文件）：基础设施 + agent_start + turn_end + message_end + session_start
 * - Wave 13（追加）：before_agent_start + agent_end（最复杂）
 *
 * 设计（D-21 双路径）：
 * - 4 个简单事件委托 service.applyEvent（路径 B）做状态变更，adapter 负责：
 *   ① ESC 守卫（ctx.signal.aborted）
 *   ② 执行 applyEvent 返回的 EventEffect[]（updateWidget 等）
 *   ③ persist（与旧 index.ts 行为对齐：turn_end/message_end 不 persist，
 *      persist 在 before_agent_start/agent_end 触发——Wave 13）
 *
 * 并发保护（在此层，D-21）：
 * - isProcessing 防重入（FR-8.2 G-021，agent_end 用，在此定义供 Wave 13 用）
 * - makeStaleChecker goalId snapshot（FR-8.2 G-020，agent_end 用）
 *
 * FR-6.7 ESC 守卫：turn_end + message_end 在此，agent_end 在 Wave 13。
 *
 * ports 桥接复用 tool-adapter.buildPorts（DRY：单一 ports 构造点）。
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { getCompletedCount } from "../engine/task";
import { updateWidget } from "../projection/widget";
import { applyEvent } from "../service";
import type { GoalSession } from "../session";
import { reconstructGoalState } from "../session";
import { buildPorts } from "./tool-adapter";

// ── 基础设施：stale-checker（FR-8.2 G-020）────────────

/**
 * 构造 stale-check 闭包：入口快照 goalId，后续判断是否被新 goal 覆盖。
 *
 * 用法（Wave 13 agent_end）：
 * ```ts
 * const checkStale = makeStaleChecker(session);
 * // ... 长流程 ...
 * if (checkStale()) return; // goal 被覆盖，本次 agent_end 作废
 * ```
 *
 * 语义：snapshot 时 session.state 可能为 null（首次启动），此时 snapshotGoalId
 * 为 undefined；后续若有新 goal（goalId !== undefined）即视为 stale。
 */
export function makeStaleChecker(session: GoalSession): () => boolean {
	const snapshotGoalId = session.state?.goalId;
	return () => !session.state || session.state.goalId !== snapshotGoalId;
}

/**
 * FR-8.2 G-021：isProcessing 防重入。
 *
 * agent_end 可能并发触发（多 message），重入时直接返回（不重复预算检查/续跑）。
 * 通过 session.isProcessing flag 实现（定义在 session.ts）。
 * 本函数为 agent_end 提供「锁住 + 解锁」语义，Wave 13 使用。
 */
export function acquireProcessing(session: GoalSession): boolean {
	if (session.isProcessing) return false; // 已被占用
	session.isProcessing = true;
	return true;
}

export function releaseProcessing(session: GoalSession): void {
	session.isProcessing = false;
}

// ── 事件 1: agent_start（基线设置）─────────────────────

/**
 * FR-8.6: tasksCompletedAtAgentStart 基线设置（stall 检测用）。
 *
 * 委托 service.applyEvent("agent_start")——它在 session.tasksCompletedAtAgentStart
 * 字段（非 state 字段）写入 getCompletedCount 基线。
 *
 * 无 ESC 守卫（agent_start 是 agent 开始时的信号，此时无 aborted 可能）。
 * 无 persist / updateWidget（基线字段是瞬态，不需持久化或渲染）。
 * applyEvent 对 agent_start 不用 ports（参数声明但忽略），传 undefined 断言即可。
 */
export async function handleAgentStart(session: GoalSession): Promise<void> {
	if (!session.state) return;
	applyEvent(session, "agent_start", undefined, undefined as never);
}

// ── 事件 2: turn_end（FR-6.7 ESC 守卫 + 递增）──────────

/**
 * FR-6.7 ESC 守卫：ctx.signal.aborted 时跳过递增（ESC 不算 goal turn）。
 * 正常路径：currentTurnIndex++ + updateWidget。
 *
 * 委托 service.applyEvent("turn_end")——它递增 currentTurnIndex 并返回
 * EventEffect[{kind:"updateWidget"}]。adapter 执行该 effect。
 *
 * 不 persist（与旧 index.ts:343-347 行为对齐——turn_end 只内存变更 + widget）。
 */
export async function handleTurnEnd(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
): Promise<void> {
	if (!session.state) return;
	// FR-6.7 ESC 守卫
	if (ctx.signal?.aborted) return;

	const effects = applyEvent(session, "turn_end", undefined, buildPorts(pi, ctx));
	// 执行 effects（updateWidget 等）
	for (const effect of effects) {
		if (effect.kind === "updateWidget") {
			updateWidget(session, buildPorts(pi, ctx).ui);
		}
	}
}

// ── 事件 3: message_end（FR-6.7 ESC 守卫 + token 累加）──

export interface MessageEndLikeEvent {
	message: {
		role: string;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			totalTokens?: number;
		};
	};
}

/**
 * FR-6.7 ESC 守卫：ctx.signal.aborted 时跳过 token 累加。
 * FR-8.6: token 累加算法（委托 service.applyEvent("message_end")，
 * 内部用 accumulateTokens：`max(input-cacheRead,0) + output`）。
 *
 * 不 persist / updateWidget（与旧 index.ts:350-365 行为对齐——message_end 只累加 token）。
 * applyEvent 对 message_end 不用 ports，传 undefined 断言即可。
 */
export async function handleMessageEnd(
	session: GoalSession,
	ctx: ExtensionContext,
	event: MessageEndLikeEvent,
): Promise<void> {
	if (!session.state) return;
	// FR-6.7 ESC 守卫
	if (ctx.signal?.aborted) return;

	applyEvent(session, "message_end", event, undefined as never);
}

// ── 事件 4: session_start（状态重建）───────────────────

/**
 * session_start：调 reconstructGoalState 重建持久化状态 + 设基线 + updateWidget。
 *
 * 重建后若 session.state 非空，设 tasksCompletedAtAgentStart 基线并渲染 widget。
 */
export async function handleSessionStart(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
): Promise<void> {
	const ports = buildPorts(pi, ctx);
	reconstructGoalState(session, ports.session);
	if (session.state) {
		session.tasksCompletedAtAgentStart = getCompletedCount(session.state.tasks);
		updateWidget(session, ports.ui);
	}
}
