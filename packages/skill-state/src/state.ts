/**
 * skill-state-tracker 状态模型
 *
 * 4 状态状态机：loaded → completed | error → recorded
 * 纯数据层，无 Pi API 依赖。
 */

// ── 类型 ────────────────────────────────────────────

export type TrackedItemStatus = "loaded" | "error" | "completed" | "recorded";

export interface TrackedItem {
  id: number;
  name: string;
  status: TrackedItemStatus;
  errorCount: number;
  loadedAtTurn: number;
  lastRemindAtTurn: number;
  detail: string | null;
  skillMdPath: string;
}

export interface SkillStateRuntimeState {
  items: TrackedItem[];
  nextId: number;
  currentTurnIndex: number;
}

// ── 常量 ────────────────────────────────────────────

export const ENTRY_TYPE = "skill-state-tracker";

const TERMINAL_STATUSES: ReadonlySet<TrackedItemStatus> = new Set(["completed", "recorded"]);

/**
 * FR-2 转换矩阵：
 *   loaded  → completed ✅, error ✅, recorded ❌
 *   error   → completed ✅, error ✅, recorded ✅
 *   终态不可变更
 */
const ALLOWED_TRANSITIONS: ReadonlyMap<string, ReadonlySet<TrackedItemStatus>> = new Map([
  ["loaded", new Set(["completed", "error"])],
  ["error", new Set(["completed", "error", "recorded"])],
]);

// ── 状态机函数 ──────────────────────────────────────

export function isTerminalStatus(status: TrackedItemStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function canTransition(from: TrackedItemStatus, to: TrackedItemStatus): boolean {
  if (isTerminalStatus(from)) return false;
  return ALLOWED_TRANSITIONS.get(from)?.has(to) ?? false;
}

/**
 * 从路径中提取 skill 名称。
 * 路径必须以 SKILL.md 结尾，名称取倒数第二级目录。
 * 例: "/path/to/diagnose/SKILL.md" → "diagnose"
 */
export function extractSkillName(path: string): string | null {
  if (!path.endsWith("SKILL.md")) return null;
  const MIN_PATH_SEGMENTS = 2;
  const segments = path.replace(/\/$/, "").split("/");
  if (segments.length < MIN_PATH_SEGMENTS) return null;
  return segments[segments.length - MIN_PATH_SEGMENTS] ?? null;
}

// ── 序列化 ──────────────────────────────────────────

export function serializeState(state: SkillStateRuntimeState): Record<string, unknown> {
  return {
    items: state.items,
    nextId: state.nextId,
    currentTurnIndex: state.currentTurnIndex,
  };
}

export function deserializeState(data: Record<string, unknown>): SkillStateRuntimeState {
  const items = Array.isArray(data.items)
    ? (data.items as TrackedItem[]).map((item: TrackedItem) => ({
        id: item.id ?? 0,
        name: item.name ?? "",
        status: (item.status as TrackedItemStatus) ?? "loaded",
        errorCount: item.errorCount ?? 0,
        loadedAtTurn: item.loadedAtTurn ?? 0,
        lastRemindAtTurn: item.lastRemindAtTurn ?? -1,
        detail: item.detail ?? null,
        skillMdPath: item.skillMdPath ?? "",
      }))
    : [];
  return {
    items,
    nextId: typeof data.nextId === "number" ? data.nextId : 1,
    currentTurnIndex: typeof data.currentTurnIndex === "number" ? data.currentTurnIndex : 0,
  };
}

export function createInitialState(): SkillStateRuntimeState {
  return { items: [], nextId: 1, currentTurnIndex: 0 };
}
