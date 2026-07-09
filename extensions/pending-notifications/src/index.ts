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

/** 扩展入口 */
export default function pendingNotificationsExtension(pi: ExtensionAPI): void {
	// ── 闭包内状态（session 隔离，每个 session_start 重建） ─────
	let registry: PendingRegistry = createRegistry();
	let currentSessionId: string = "";

	// ── EventBus 监听：pending:register ─────────────────────
	pi.events.on("pending:register", (data: unknown) => {
		const parsed = parseRegisterEvent(data);
		if (!parsed) return;

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
		if (!added) return;

		pi.appendEntry("pending:register", {
			id: entry.id,
			type: entry.type,
			name: entry.name,
			registeredAt: entry.registeredAt,
			expiresAt: entry.expiresAt,
			sessionId: entry.sessionId,
		});
	});

	// ── EventBus 监听：pending:unregister ───────────────────
	pi.events.on("pending:unregister", (data: unknown) => {
		const parsed = parseUnregisterEvent(data);
		if (!parsed) return;

		const status = mapReasonToStatus(parsed.reason);
		const changed = unregister(registry, parsed.id, status);
		if (!changed) return;

		pi.appendEntry("pending:unregister", {
			id: parsed.id,
			reason: parsed.reason,
			status,
		});
	});

	// ── session_start：从持久化 entries 重建 registry ────────
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		registry = createRegistry();
		currentSessionId = ctx.sessionManager.getSessionId();

		const entries = ctx.sessionManager.getEntries();
		const now = Date.now();
		const { expiredToFlush } = rebuildFromEntries(registry, entries, currentSessionId, now);

		// 补 expired/跨 session 残留的 unregister entry（U3/U4）
		for (const item of expiredToFlush) {
			pi.appendEntry("pending:unregister", {
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
				pi.appendEntry("pending:unregister", {
					id: op.id,
					status: "cancelled",
				});
			}
		}
	});

	// ── 查询 tool ─────────────────────────────────────────
	pi.registerTool({
		name: "pending_notifications",
		description:
			"查询当前活跃的异步操作（workflow/subagent）。action=count 返回数量；action=list 返回列表。状态由 EventBus + session entries 维护，无需手动注册。",
		parameters: PendingNotificationsParams,
		execute: async (params: unknown) => {
			const p = params as ToolParams;
			const active = getActive(registry);

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
}

/** 解析 pending:unregister 事件 data（容错缺失/类型错误字段） */
function parseUnregisterEvent(data: unknown): ParsedUnregister | null {
	if (typeof data !== "object" || data === null) return null;
	const d = data as Record<string, unknown>;
	if (typeof d.id !== "string") return null;
	return {
		id: d.id,
		reason: typeof d.reason === "string" ? d.reason : "completed",
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
