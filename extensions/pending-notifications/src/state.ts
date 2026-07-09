/**
 * Pending Notifications State — 数据模型和纯函数。
 *
 * 职责：
 * - PendingOperation: 异步操作的注册信息
 * - PendingNotificationsState: 会话状态接口
 * - 纯函数：register/unregister/query 操作
 */

/** 异步操作状态 */
export type OperationStatus = "pending" | "running" | "completed" | "failed";

/** 异步操作注册信息 */
export interface PendingOperation {
	/** 操作唯一标识（由注册方提供） */
	id: string;
	/** 操作来源扩展名 */
	source: string;
	/** 操作描述 */
	description: string;
	/** 操作状态 */
	status: OperationStatus;
	/** 注册时间戳 */
	registeredAt: number;
	/** 最后更新时间戳 */
	updatedAt: number;
	/** 可选的元数据 */
	metadata?: Record<string, unknown>;
}

/** 会话状态 */
export interface PendingNotificationsState {
	/** 已注册的操作 */
	operations: Map<string, PendingOperation>;
}

/** 创建会话状态 */
export function createPendingNotificationsState(): PendingNotificationsState {
	return {
		operations: new Map(),
	};
}

/** 注册操作结果 */
export interface RegisterResult {
	success: boolean;
	operation?: PendingOperation;
	error?: string;
}

/** 注册新操作 */
export function registerOperation(
	state: PendingNotificationsState,
	id: string,
	source: string,
	description: string,
	metadata?: Record<string, unknown>,
): RegisterResult {
	if (state.operations.has(id)) {
		return { success: false, error: `operation ${id} already exists` };
	}

	const now = Date.now();
	const operation: PendingOperation = {
		id,
		source,
		description,
		status: "pending",
		registeredAt: now,
		updatedAt: now,
		metadata,
	};

	state.operations.set(id, operation);
	return { success: true, operation };
}

/** 更新操作状态结果 */
export interface UpdateResult {
	success: boolean;
	operation?: PendingOperation;
	error?: string;
}

/** 更新操作状态 */
export function updateOperationStatus(
	state: PendingNotificationsState,
	id: string,
	status: OperationStatus,
	metadata?: Record<string, unknown>,
): UpdateResult {
	const operation = state.operations.get(id);
	if (!operation) {
		return { success: false, error: `operation ${id} not found` };
	}

	operation.status = status;
	operation.updatedAt = Date.now();
	if (metadata !== undefined) {
		operation.metadata = { ...operation.metadata, ...metadata };
	}

	return { success: true, operation };
}

/** 注销操作结果 */
export interface UnregisterResult {
	success: boolean;
	error?: string;
}

/** 注销操作 */
export function unregisterOperation(
	state: PendingNotificationsState,
	id: string,
): UnregisterResult {
	if (!state.operations.has(id)) {
		return { success: false, error: `operation ${id} not found` };
	}

	state.operations.delete(id);
	return { success: true };
}

/** 查询结果 */
export interface QueryResult {
	operations: PendingOperation[];
	total: number;
}

/** 查询所有操作 */
export function queryOperations(
	state: PendingNotificationsState,
	filter?: {
		source?: string;
		status?: OperationStatus;
	},
): QueryResult {
	let operations = Array.from(state.operations.values());

	if (filter?.source) {
		operations = operations.filter((op) => op.source === filter.source);
	}

	if (filter?.status) {
		operations = operations.filter((op) => op.status === filter.status);
	}

	return {
		operations,
		total: operations.length,
	};
}

/** 检查是否有待处理的操作 */
export function hasPendingOperations(
	state: PendingNotificationsState,
	source?: string,
): boolean {
	const filter = source ? { source, status: "pending" as OperationStatus } : { status: "pending" as OperationStatus };
	const result = queryOperations(state, filter);
	return result.total > 0;
}

/** 获取操作数量统计 */
export function getOperationStats(
	state: PendingNotificationsState,
): Record<OperationStatus, number> {
	const stats: Record<OperationStatus, number> = {
		pending: 0,
		running: 0,
		completed: 0,
		failed: 0,
	};

	for (const op of state.operations.values()) {
		stats[op.status]++;
	}

	return stats;
}
