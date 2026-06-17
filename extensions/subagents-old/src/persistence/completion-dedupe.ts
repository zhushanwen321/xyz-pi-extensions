// src/persistence/completion-dedupe.ts
//
// TTL 去重 Map。移植自 tintinweb/pi-subagents 的 completion-dedupe.ts。
// 用于 background 完成通知去重（防止 cancel + abort catch 双发 sendMessage）。

/** buildCompletionKey 接受的数据形状（宽松类型，兼容各种 record） */
export interface CompletionDataLike {
  id?: unknown;
  agent?: unknown;
  timestamp?: unknown;
  sessionId?: unknown;
  taskIndex?: unknown;
  totalTasks?: unknown;
  success?: unknown;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 构造去重 key。id 优先（`id:<id>`），否则用 meta 字段拼确定性 composite key。
 */
export function buildCompletionKey(data: CompletionDataLike, fallback: string): string {
  const id = asNonEmptyString(data.id);
  if (id) return `id:${id}`;
  const sessionId = asNonEmptyString(data.sessionId) ?? "no-session";
  const agent = asNonEmptyString(data.agent) ?? "unknown";
  const timestamp = asFiniteNumber(data.timestamp);
  const taskIndex = asFiniteNumber(data.taskIndex);
  const totalTasks = asFiniteNumber(data.totalTasks);
  const success = typeof data.success === "boolean" ? (data.success ? "1" : "0") : "?";
  return [
    "meta",
    sessionId,
    agent,
    timestamp !== undefined ? String(timestamp) : "no-ts",
    taskIndex !== undefined ? String(taskIndex) : "-",
    totalTasks !== undefined ? String(totalTasks) : "-",
    success,
    fallback,
  ].join(":");
}

/** 清理过期条目（now - ts > ttlMs） */
function pruneSeenMap(seen: Map<string, number>, now: number, ttlMs: number): void {
  for (const [key, ts] of seen) {
    if (now - ts > ttlMs) seen.delete(key);
  }
}

/**
 * 标记 key 为已见。
 * @returns true = 重复（应跳过），false = 首次（应处理）
 */
export function markSeenWithTtl(
  seen: Map<string, number>,
  key: string,
  now: number,
  ttlMs: number,
): boolean {
  pruneSeenMap(seen, now, ttlMs);
  if (seen.has(key)) return true;
  seen.set(key, now);
  return false;
}

/**
 * 进程内单例 Map（挂在 globalThis[storeKey]）。
 * 同 storeKey 返回同一实例，跨模块共享。
 */
export function getGlobalSeenMap(storeKey: string): Map<string, number> {
  const globalStore = globalThis as Record<string, unknown>;
  const existing = globalStore[storeKey];
  if (existing instanceof Map) return existing as Map<string, number>;
  const map = new Map<string, number>();
  globalStore[storeKey] = map;
  return map;
}
