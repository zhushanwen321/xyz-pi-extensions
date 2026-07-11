/**
 * Pending Notifications State — 数据模型和纯函数。
 *
 * 职责：
 * - PendingEntry: 一个异步操作的完整描述（与 pending:register entry data 对齐）
 * - PendingRegistry: 内存中的活跃操作注册表（Map<id, PendingEntry>）
 * - register/unregister: 运行时事件驱动的状态变更
 * - rebuildFromEntries: session_start 从持久化 entries 重建 registry + 识别需要补注销的 expired/跨 session 残留
 *
 * 设计要点：
 * - 纯函数，不依赖 Pi 运行时（ExtensionAPI/appendEntry），可独立单元测试
 * - 所有时间戳由调用方传入（now），便于测试
 * - rebuildFromEntries 返回 activeIds + expiredToFlush（需要 index.ts 补 appendEntry 的列表），
 *   不直接写 entry —— 写 entry 是副作用，由 index.ts 负责
 */

/** 异步操作类型（来源：workflow / subagent） */
export type PendingType = "workflow" | "subagent";

/** 异步操作终态/过渡状态。active = 仍在运行；其他都视为已结束 */
export type PendingStatus = "active" | "completed" | "failed" | "cancelled" | "expired" | "time_limited" | "aborted";

/** 一个异步操作的完整描述（= pending:register entry 的 data 字段） */
export interface PendingEntry {
	/** 操作唯一标识（workflow runId / subagent id） */
	id: string;
	/** 操作来源类型 */
	type: PendingType;
	/** 可读名称（workflow name / subagent name） */
	name: string;
	/** 注册时状态（恒为 active，由 register 设置） */
	status: PendingStatus;
	/** 注册时间戳 ms */
	registeredAt: number;
	/** 过期时间戳 ms（registeredAt + TTL） */
	expiresAt: number;
	/** 注册时的 sessionId（用于跨 session 残留检测） */
	sessionId: string;
}

/** pending:register entry 在 entries 里的最小可识别形状 */
interface RegisterEntryData {
	id: unknown;
	type: unknown;
	name: unknown;
	registeredAt: unknown;
	expiresAt: unknown;
	sessionId: unknown;
}

/** pending:unregister entry 在 entries 里的最小可识别形状。
 *  result/error/patchFile 为 subagent 完成通知携带的附加字段（T2 后由 pending-notifications
 *  消费侧读取并 sendMessage 到 LLM）。workflow 的 unregister 不携带这些字段。 */
interface UnregisterEntryData {
	id: unknown;
	result?: unknown;
	error?: unknown;
	patchFile?: unknown;
}

/** SessionEntry 的最小可识别形状（duck-typed，避免依赖 SDK 具体类型） */
interface EntryLike {
	customType?: string;
	data?: unknown;
}

/** pending:register entry 的 TTL（1 小时） */
export const PENDING_TTL_MS = 3_600_000;

/** 注册表：内存中的活跃操作（session 隔离，由 index.ts 在闭包内持有） */
export interface PendingRegistry {
	/** 所有已注册操作（含已注销的，便于去重判断） */
	operations: Map<string, PendingEntry>;
}

/** 创建空注册表 */
export function createRegistry(): PendingRegistry {
	return { operations: new Map() };
}

/**
 * 注册操作。已存在（任何 status）的同 id 操作被忽略（U6 重复注册）。
 * 返回是否实际新增（true = 新注册，false = 被忽略）。
 */
export function register(registry: PendingRegistry, entry: PendingEntry): boolean {
	if (registry.operations.has(entry.id)) {
		return false;
	}
	registry.operations.set(entry.id, entry);
	return true;
}

/**
 * 注销操作。不存在则忽略不报错（U8）。
 * 返回是否实际变更（true = 注销了 active 操作，false = 不存在或已注销）。
 */
export function unregister(registry: PendingRegistry, id: string, status: PendingStatus): boolean {
	const op = registry.operations.get(id);
	if (!op || op.status !== "active") {
		return false;
	}
	op.status = status;
	return true;
}

/** 返回当前所有 active 操作（按注册顺序） */
export function getActive(registry: PendingRegistry): PendingEntry[] {
	return Array.from(registry.operations.values()).filter((op) => op.status === "active");
}

/** rebuildFromEntries 的结果：重建后的活跃列表 + 需要补注销的 entry */
export interface RebuildResult {
	/** 重建后识别为 active 的 id 列表（已写入 registry） */
	activeIds: string[];
	/** 需要补 pending:unregister entry 的操作（expired/跨 session 残留） */
	expiredToFlush: Array<{ id: string; status: PendingStatus }>;
}

/**
 * 从持久化 entries 重建 registry（session_start 时调用）。
 *
 * 算法（对齐 goal before-agent-start.ts 的读取契约）：
 * 1. 收集所有 pending:register entry，按 id 算差集（减去 pending:unregister 的 id）
 *    前提：id 全局唯一（workflow runId=`wf-<ts>-<rand>`、subagent id=`bg-/run-<tag>-<seq>-<ts>`）。
 *    若未来 id 复用（register→unregister→register 同 id），全局 Set 差集会误跳第二次 register。
 * 2. 对每个活跃的 register entry 检查：
 *    - sessionId 不符当前 session → expired（U4 跨 session 残留）
 *    - expiresAt <= now → expired（U3 过期）
 * 3. 仍活跃的写入 registry，expired 的进入 expiredToFlush（由 index.ts 补 appendEntry）
 *
 * 注意：本函数只重建 registry + 计算需补的 entry，不写 entry（副作用归 index.ts）。
 */
export function rebuildFromEntries(
	registry: PendingRegistry,
	entries: unknown[],
	currentSessionId: string,
	now: number,
): RebuildResult {
	const registerEntries: Array<{ data: RegisterEntryData }> = [];
	const unregisteredIds = new Set<string>();

	for (const raw of entries as EntryLike[]) {
		if (raw.customType === "pending:register") {
			registerEntries.push({ data: (raw.data ?? {}) as RegisterEntryData });
		} else if (raw.customType === "pending:unregister") {
			const data = (raw.data ?? {}) as UnregisterEntryData;
			if (typeof data.id === "string") {
				unregisteredIds.add(data.id);
			}
		}
	}

	const activeIds: string[] = [];
	const expiredToFlush: Array<{ id: string; status: PendingStatus }> = [];

	for (const { data } of registerEntries) {
		if (typeof data.id !== "string") continue;
		if (unregisteredIds.has(data.id)) continue;

		const entry = normalizeRegisterEntry(data, currentSessionId);
		// 跨 session 残留（U4）
		if (entry.sessionId !== currentSessionId) {
			expiredToFlush.push({ id: entry.id, status: "expired" });
			continue;
		}
		// 过期（U3）
		if (entry.expiresAt <= now) {
			expiredToFlush.push({ id: entry.id, status: "expired" });
			continue;
		}
		// 仍活跃
		registry.operations.set(entry.id, entry);
		activeIds.push(entry.id);
	}

	return { activeIds, expiredToFlush };
}

/** 从 entry data 归一化为 PendingEntry（补默认值，容错缺失字段） */
function normalizeRegisterEntry(data: RegisterEntryData, currentSessionId: string): PendingEntry {
	const registeredAt = typeof data.registeredAt === "number" ? data.registeredAt : Date.now();
	return {
		id: data.id as string,
		type: (data.type === "subagent" ? "subagent" : "workflow") as PendingType,
		name: typeof data.name === "string" ? data.name : (data.id as string),
		status: "active",
		registeredAt,
		expiresAt: typeof data.expiresAt === "number" ? data.expiresAt : registeredAt + PENDING_TTL_MS,
		sessionId: typeof data.sessionId === "string" ? data.sessionId : currentSessionId,
	};
}
