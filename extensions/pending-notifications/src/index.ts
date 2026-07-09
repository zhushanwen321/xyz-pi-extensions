/**
 * Pending Notifications Extension — 跨 extension 的异步操作注册/查询机制。
 *
 * 设计定位：解决 workflow/subagent 运行时 goal 持续注入消息的悖论。
 * 当有异步操作（workflow/subagent）正在运行时，其他扩展（如 goal）可以通过
 * 查询 pending-notifications 来判断是否应该暂停消息注入。
 *
 * 文件职责：
 * - state.ts:    PendingNotificationsState 会话状态接口 + 工厂 + 纯函数
 * - index.ts（本文件）: 工厂入口（注册 tool + 事件处理）
 *
 * 工具设计：
 * - register: 注册新的异步操作
 * - update: 更新操作状态
 * - unregister: 注销操作
 * - query: 查询操作列表
 * - stats: 获取操作统计
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
	createPendingNotificationsState,
	getOperationStats,
	hasPendingOperations,
	type OperationStatus,
	queryOperations,
	registerOperation,
	unregisterOperation,
	updateOperationStatus,
} from "./state.ts";

/** 操作状态枚举 */
const OperationStatusEnum = Type.Union([
	Type.Literal("pending"),
	Type.Literal("running"),
	Type.Literal("completed"),
	Type.Literal("failed"),
]);

/** 工具参数 schema */
const PendingNotificationsParams = Type.Object({
	action: Type.Union([
		Type.Literal("register"),
		Type.Literal("update"),
		Type.Literal("unregister"),
		Type.Literal("query"),
		Type.Literal("stats"),
	]),
	id: Type.Optional(Type.String({ description: "操作唯一标识" })),
	source: Type.Optional(Type.String({ description: "操作来源扩展名" })),
	description: Type.Optional(Type.String({ description: "操作描述" })),
	status: Type.Optional(OperationStatusEnum),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "可选的元数据" })),
	filterSource: Type.Optional(Type.String({ description: "查询过滤：来源扩展名" })),
	filterStatus: Type.Optional(OperationStatusEnum),
});

/** 扩展入口 */
export default function pendingNotificationsExtension(pi: ExtensionAPI): void {
	// ── 闭包内状态（session 隔离） ─────────────────────
	const state = createPendingNotificationsState();

	// ── 跨扩展 API ───────────────────────────────────
	// 暴露给其他扩展的查询接口
	(pi as unknown as Record<string, unknown>).__pendingNotificationsHasPending = (source?: string): boolean => {
		return hasPendingOperations(state, source);
	};

	(pi as unknown as Record<string, unknown>).__pendingNotificationsQuery = (filter?: { source?: string; status?: OperationStatus }) => {
		return queryOperations(state, filter);
	};

	// ── 注册工具 ─────────────────────────────────────
	pi.registerTool({
		name: "pending_notifications",
		description: "跨 extension 的异步操作注册/查询机制。用于注册正在运行的异步操作（如 workflow/subagent），其他扩展可以通过查询来判断是否应该暂停消息注入。",
		parameters: PendingNotificationsParams,
		execute: async (params: unknown, _ctx: unknown) => {
			const p = params as {
				action: string;
				id?: string;
				source?: string;
				description?: string;
				status?: OperationStatus;
				metadata?: Record<string, unknown>;
				filterSource?: string;
				filterStatus?: OperationStatus;
			};

			switch (p.action) {
				case "register": {
					if (!p.id || !p.source || !p.description) {
						throw new Error("register requires id, source, and description");
					}
					const result = registerOperation(state, p.id, p.source, p.description, p.metadata);
					if (!result.success) {
						throw new Error(result.error);
					}
					return {
						content: [{ type: "text" as const, text: `Registered operation ${p.id} from ${p.source}` }],
						details: { action: "register", operation: result.operation },
					};
				}

				case "update": {
					if (!p.id || !p.status) {
						throw new Error("update requires id and status");
					}
					const result = updateOperationStatus(state, p.id, p.status, p.metadata);
					if (!result.success) {
						throw new Error(result.error);
					}
					return {
						content: [{ type: "text" as const, text: `Updated operation ${p.id} to ${p.status}` }],
						details: { action: "update", operation: result.operation },
					};
				}

				case "unregister": {
					if (!p.id) {
						throw new Error("unregister requires id");
					}
					const result = unregisterOperation(state, p.id);
					if (!result.success) {
						throw new Error(result.error);
					}
					return {
						content: [{ type: "text" as const, text: `Unregistered operation ${p.id}` }],
						details: { action: "unregister", id: p.id },
					};
				}

				case "query": {
					const filter: { source?: string; status?: OperationStatus } = {};
					if (p.filterSource) filter.source = p.filterSource;
					if (p.filterStatus) filter.status = p.filterStatus;
					const result = queryOperations(state, filter);
					return {
						content: [{ type: "text" as const, text: `Found ${result.total} operations` }],
						details: { action: "query", ...result },
					};
				}

				case "stats": {
					const stats = getOperationStats(state);
					return {
						content: [{ type: "text" as const, text: `Stats: ${JSON.stringify(stats)}` }],
						details: { action: "stats", stats },
					};
				}

				default:
					throw new Error(`Unknown action: ${p.action}`);
			}
		},
	});

	// ── 注册事件处理 ─────────────────────────────────
	pi.on("session_start", (_event: unknown, _ctx: ExtensionContext) => {
		// 会话开始时重置状态
		const freshState = createPendingNotificationsState();
		(state as unknown as { operations: Map<string, unknown> }).operations = freshState.operations;
	});
}
