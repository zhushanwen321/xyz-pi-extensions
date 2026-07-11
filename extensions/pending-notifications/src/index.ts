/**
 * Pending Notifications Extension — 跨 extension 的异步操作注册/查询机制。
 *
 * 设计定位：解决 workflow/subagent 运行时 goal 持续注入消息的悖论。
 * workflow/subagent 运行时通过 EventBus（pi.events.emit）广播 register/unregister，
 * 本扩展监听这些事件、将状态写入 session entries（pi.appendEntry），
 * 让 goal 的 before_agent_start 从 entries 读取活跃异步操作并注入等待消息。
 *
 * 文件职责：
 * - state.ts:    PendingEntry / PendingRegistry + 纯函数（register/unregister/rebuild）
 * - index.ts（本文件）: 工厂入口（注册 events.on 监听 + session 生命周期 + 查询 tool）
 *
 * 事件契约（与 workflow launcher.ts / subagent-service.ts 对齐）：
 * - emit("pending:register", { id, type, name })
 * - emit("pending:unregister", { id, reason })
 *
 * entry 契约（与 goal before-agent-start.ts 对齐，读取端按 e.data.id 算差集）：
 * - pending:register → { id, type, name, registeredAt, expiresAt, sessionId }
 * - pending:unregister → { id, reason, status }
 *
 * 监听方式：pi.events.on（Pi 的 EventBus，真实 SDK 为 EventBus.on，非 optional）。
 * workflow 侧通过 deps.eventBus 注入 pi.events（同一总线）。
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
	createRegistry,
	getActive,
	PENDING_TTL_MS,
	type PendingEntry,
	type PendingRegistry,
	type PendingStatus,
	type PendingType,
	rebuildFromEntries,
	register,
	unregister,
} from "./state.ts";

/** 工具参数 schema */
const PendingNotificationsParams = Type.Object({
	action: Type.Union([
		Type.Literal("count"),
		Type.Literal("list"),
	]),
});

/** tool 入参形状 */
interface ToolParams {
	action: "count" | "list";
}

/**
 * 模块级 EventBus 监听器 unsubscribe 函数列表。
 *
 * EventBus 是进程级单例（真实 SDK resource-loader 构造一次，跨 /reload、会话切换复用）。
 * 工厂函数 pendingNotificationsExtension 每次 reload 都重新执行，若不先移除旧监听器，
 * N 次 reload 后 EventBus 上会累积 N 组监听器（>11 后抛 Possible EventEmitter memory leak）。
 *
 * 用模块级变量跨 reload 持久：工厂入口先调用上一轮的 unsubscribe 清理旧监听器，
 * 再注册新的。这同时修复了多 session 串数据问题——reload 后只有当前闭包的监听器存活，
 * currentSessionId 始终是最新 session（旧闭包的过期 currentSessionId 不会再给事件打戳）。
 */
let unsubscribers: Array<() => void> = [];

/** 扩展入口 */
export default function pendingNotificationsExtension(pi: ExtensionAPI): void {
	// ── 清理上一轮 reload 的 EventBus 监听器（H2 防泄漏） ─────
	for (const unsub of unsubscribers) {
		try {
			unsub();
		} catch (err) {
			// unsubscribe 失败不阻断初始化（监听器可能已被 EventBus 内部清理）
			console.debug("[pending-notifications] unsubscribe failed during cleanup", err);
		}
	}
	unsubscribers = [];

	// ── 闭包内状态（session 隔离，每个 session_start 重建） ─────
	let registry: PendingRegistry = createRegistry();
	let currentSessionId: string = "";

	// 安全写入 session entry：忽略 stale context 等不可恢复错误（如 subagent 子进程
	// session replacement 后 listener 仍触发）。返回是否成功。
	function safeAppendEntry(customType: string, data: unknown): boolean {
		try {
			pi.appendEntry(customType, data);
			return true;
		} catch {
			// stale context 或 session 已关闭时，静默丢弃。entry 不是关键业务数据，
			// 丢失不会破坏主流程。
			return false;
		}
	}

	// debug 日志：环境变量 PENDING_DEBUG=1 时输出到 console.debug。
	// 不再写入 session entry（pending:log）——session entries 是 append-only 无法 GC，
	// 12 处 debug 日志会让长 session 的 entries 线性膨胀，而 goal before-agent-start
	// 每 turn 全量扫描 getEntries()。状态数据（pending:register/unregister）仍写 entry。
	const debugEnabled = process.env.PENDING_DEBUG === "1";
	function debugLog(level: string, message: string, data?: unknown): void {
		if (!debugEnabled) return;
		console.debug(`[pending-notifications:${level}] ${message}`, data ?? "");
	}

	// ── EventBus 监听：pending:register ─────────────────────
	unsubscribers.push(pi.events.on("pending:register", (data: unknown) => {
		debugLog("debug", "listener: pending:register received", data);
		const parsed = parseRegisterEvent(data);
		if (!parsed) {
			debugLog("warn", "listener: pending:register parse failed", data);
			return;
		}

		debugLog("debug", "listener: pending:register parsed", parsed);

		const now = Date.now();
		const entry: PendingEntry = {
			id: parsed.id,
			type: parsed.type,
			name: parsed.name,
			status: "active",
			registeredAt: now,
			expiresAt: now + PENDING_TTL_MS,
			sessionId: currentSessionId,
		};

		// 重复注册忽略（U6）
		const added = register(registry, entry);
		if (!added) {
			debugLog("debug", "listener: pending:register ignored (duplicate)", { id: parsed.id });
			return;
		}

		safeAppendEntry("pending:register", {
			id: entry.id,
			type: entry.type,
			name: entry.name,
			registeredAt: entry.registeredAt,
			expiresAt: entry.expiresAt,
			sessionId: entry.sessionId,
		});

		debugLog("debug", "listener: pending:register appended", { id: parsed.id });
	}));

	// ── EventBus 监听：pending:unregister ───────────────────
	unsubscribers.push(pi.events.on("pending:unregister", (data: unknown) => {
		debugLog("debug", "listener: pending:unregister received", data);
		const parsed = parseUnregisterEvent(data);
		if (!parsed) {
			debugLog("warn", "listener: pending:unregister parse failed", data);
			return;
		}

		debugLog("debug", "listener: pending:unregister parsed", parsed);

		const status = mapReasonToStatus(parsed.reason);
		// 先读 entry 取 agent 名（unregister 后 entry 仍在 map，但先读语义更清晰）。
		// unknown/duplicate id → changed=false → return，不重复 appendEntry / 不重复 notify。
		const entry = registry.operations.get(parsed.id);
		const changed = unregister(registry, parsed.id, status);
		if (!changed) {
			debugLog("debug", "listener: pending:unregister ignored (unknown id)", { id: parsed.id });
			return;
		}

		safeAppendEntry("pending:unregister", {
			id: parsed.id,
			reason: parsed.reason,
			status,
		});

		// T2: subagent 完成通知。当 payload 携带 result/error/patchFile 时（仅 subagent
		// 终态路径 emit），调 pi.sendMessage 注入完成消息到 LLM（替代已删除的 BgNotifier）。
		// workflow 的 unregister 不携带这些字段，不触发通知。
		if (parsed.result !== undefined || parsed.error !== undefined || parsed.patchFile !== undefined) {
			sendSubagentNotify(pi, {
				id: parsed.id,
				agent: entry?.name ?? parsed.id,
				status: reasonToNotifyStatus(parsed.reason),
				result: parsed.result,
				error: parsed.error,
				patchFile: parsed.patchFile,
			}, isRpcMode);
		}

		debugLog("debug", "listener: pending:unregister appended", { id: parsed.id });
	}));

	// RPC 模式标志（session_start 捕获，传给 sendSubagentNotify 构造 __gui__）
	let isRpcMode = false;

	// ── session_start：从持久化 entries 重建 registry ────────
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		registry = createRegistry();
		currentSessionId = ctx.sessionManager.getSessionId();
		// RPC 模式下 hasUI 为 false（无 TUI 渲染入口）
		isRpcMode = !ctx.hasUI;

		const entries = ctx.sessionManager.getEntries();
		const now = Date.now();
		const { expiredToFlush } = rebuildFromEntries(registry, entries, currentSessionId, now);

		debugLog("debug", "session_start: registry rebuilt", {
			sessionId: currentSessionId,
			totalEntries: entries.length,
			activeAfterRebuild: getActive(registry).length,
			expiredToFlush: expiredToFlush.length,
		});

		// 补 expired/跨 session 残留的 unregister entry（U3/U4）
		for (const item of expiredToFlush) {
			safeAppendEntry("pending:unregister", {
				id: item.id,
				status: item.status,
			});
		}
	});

	// ── session_shutdown：所有 active → cancelled + 补 entry（U11） ──
	pi.on("session_shutdown", (_event, _ctx: ExtensionContext) => {
		const active = getActive(registry);
		for (const op of active) {
			const changed = unregister(registry, op.id, "cancelled");
			if (changed) {
				safeAppendEntry("pending:unregister", {
					id: op.id,
					status: "cancelled",
				});
			}
		}
	});

	// ── 查询 tool ─────────────────────────────────────────
	pi.registerTool({
		name: "pending_notifications",
		label: "Pending Notifications",
		description:
			"查询当前活跃的异步操作（workflow/subagent）。action=count 返回数量；action=list 返回列表。状态由 EventBus + session entries 维护，无需手动注册。",
		parameters: PendingNotificationsParams,
		execute: async (params: unknown) => {
			const p = params as ToolParams;
			const active = getActive(registry);

			debugLog("debug", `tool ${p.action} requested`, { action: p.action, activeCount: active.length });

			if (p.action === "count") {
				return {
					content: [{ type: "text" as const, text: `${active.length} pending operation(s)` }],
					details: { action: "count", count: active.length },
				};
			}

			// action === "list"
			return {
				content: [{ type: "text" as const, text: formatList(active) }],
				details: { action: "list", count: active.length, items: active },
			};
		},
	});
}

// ── 事件解析 helper ─────────────────────────────────

interface ParsedRegister {
	id: string;
	type: PendingType;
	name: string;
}

/** 解析 pending:register 事件 data（容错缺失/类型错误字段） */
function parseRegisterEvent(data: unknown): ParsedRegister | null {
	if (typeof data !== "object" || data === null) return null;
	const d = data as Record<string, unknown>;
	if (typeof d.id !== "string") return null;
	return {
		id: d.id,
		type: d.type === "subagent" ? "subagent" : "workflow",
		name: typeof d.name === "string" ? d.name : d.id,
	};
}

interface ParsedUnregister {
	id: string;
	reason: string;
	result?: string;
	error?: string;
	patchFile?: string;
}

/** 解析 pending:unregister 事件 data（容错缺失/类型错误字段）。
 *  T2 后 subagent 完成路径携带可选的 result/error/patchFile，供消费侧 sendMessage。 */
function parseUnregisterEvent(data: unknown): ParsedUnregister | null {
	if (typeof data !== "object" || data === null) return null;
	const d = data as Record<string, unknown>;
	if (typeof d.id !== "string") return null;
	return {
		id: d.id,
		reason: typeof d.reason === "string" ? d.reason : "completed",
		result: typeof d.result === "string" ? d.result : undefined,
		error: typeof d.error === "string" ? d.error : undefined,
		patchFile: typeof d.patchFile === "string" ? d.patchFile : undefined,
	};
}

/** 将事件 reason 映射为内部 PendingStatus */
function mapReasonToStatus(reason: string): PendingStatus {
	switch (reason) {
		case "completed": return "completed";
		case "failed": return "failed";
		case "cancelled": return "cancelled";
		case "expired": return "expired";
		case "time_limited": return "time_limited";
		case "budget_limited": return "failed";
		case "aborted": return "aborted";
		default: return "completed";
	}
}

/** 格式化 active 列表为可读文本 */
function formatList(active: PendingEntry[]): string {
	if (active.length === 0) return "No pending operations";
	const lines = active.map((op) => `- [${op.type}] ${op.name} (id=${op.id})`);
	return `${active.length} pending operation(s):\n${lines.join("\n")}`;
}

// ── T2: subagent 完成通知（替代已删除的 BgNotifier）─────────

/** 发送给主对话的 customType（bg-notify-render 消费）。与原 notifier.ts 保持一致。 */
const NOTIFY_CUSTOM_TYPE = "subagent-bg-notify";

/** 完成通知的 record 形状（与 bg-notify-render.ts 的 BgNotifyRecord 对齐）。 */
interface NotifyRecord {
	id: string;
	status: "done" | "failed" | "cancelled";
	agent: string;
	result?: string;
	error?: string;
	patchFile?: string;
}

/** 将事件 reason 映射为通知 record 的 status（bg-notify-render 要求 done/failed/cancelled）。 */
function reasonToNotifyStatus(reason: string): "done" | "failed" | "cancelled" {
	switch (reason) {
		case "done": return "done";
		case "failed": return "failed";
		case "cancelled": return "cancelled";
		case "completed": return "done";
		default: return "done";
	}
}

/**
 * 构造 content（进 LLM context）——与原 BgNotifier.buildLlmContent 格式一致，不截断。
 *
 * content 经 convertToLlm 转成 user message 进 LLM context。截断会让 AI 被迫 poll
 * 拉全量，与 background 模式「不轮询」的设计目标矛盾。block 的视觉展示靠 details
 * （renderer 自己 firstLine + truncLine 压缩），与 content 解耦。
 */
function buildNotifyContent(record: NotifyRecord): string {
	const agent = record.agent;
	const id = record.id;
	switch (record.status) {
		case "done": {
			const base = `Subagent "${agent}" (${id}) completed. Result:\n${record.result ?? "(empty)"}`;
			if (record.patchFile) {
				return `${base}\n\nThis subagent ran in an isolated worktree; its file changes were captured as a patch:\n  ${record.patchFile}\nTo bring these changes into the current repo, run: \`git apply ${record.patchFile}\``;
			}
			return base;
		}
		case "failed":
			return `Subagent "${agent}" (${id}) failed: ${record.error ?? "(unknown error)"}`;
		case "cancelled":
			return `Subagent "${agent}" (${id}) cancelled.`;
	}
}

/**
 * 注入 subagent 完成通知到主对话。
 *
 * deliverAs:"followUp" + triggerTurn:true：完成通知在当前 streaming turn 结束后
 * 唤醒父 agent 处理结果（followUp 不打断 streaming、不锁滚动）；空闲时立即 prompt 新 turn。
 * details 作为 bg-notify-render 的渲染数据源（与原 BgNotifier 输出一致）。
 */
/**
 * 注入 subagent 完成通知。
 *
 * @param isRpcMode 是否为 RPC 模式（从 session_start 的 ctx.mode 捕获）。
 * RPC 模式下附加 __gui__ 结构化渲染数据，供 xyz-agent GUI 渲染。
 */
function sendSubagentNotify(pi: ExtensionAPI, record: NotifyRecord, isRpcMode?: boolean): void {
	const details: Record<string, unknown> = { ...record };

	// GUI 协议：RPC 模式下附加 __gui__ 结构化渲染数据
	if (isRpcMode) {
		details.__gui__ = {
			v: 1,
			component: {
				type: "subagent-trace",
				props: {
					agent: record.agent,
					status: record.status === "done" ? "done" : record.status === "failed" ? "failed" : "cancelled",
					result: record.result,
				},
			},
		};
	}

	pi.sendMessage({
		customType: NOTIFY_CUSTOM_TYPE,
		content: buildNotifyContent(record),
		display: true,
		details,
	}, { triggerTurn: true, deliverAs: "followUp" });
}
