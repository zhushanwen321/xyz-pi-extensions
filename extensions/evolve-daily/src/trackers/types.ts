/**
 * Activity Tracker Framework — 类型定义与状态机
 *
 * 通用 TrackedItem 状态机：loaded → completed | error → recorded
 * 纯数据层，无 Pi API 依赖。
 */

import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";

// ── 常量 ────────────────────────────────────────────

/** appendEntry 的 customType 前缀 */
export const TRACKER_ENTRY_PREFIX = "evolve-tracker-";

const TERMINAL_STATUSES: ReadonlySet<TrackedItemStatus> = new Set([
  "completed",
  "recorded",
  "cancelled",
  "abandoned",
]);

/**
 * FR-3 转换矩阵：
 *   loaded  → completed ✅, error ✅, cancelled ✅
 *   error   → completed ✅, error ✅, recorded ✅, cancelled ✅
 *   abandoned 是纯系统状态（turn_end/reconstructState 自动触发），不在 ALLOWED_TRANSITIONS 的 from 中
 *   终态不可变更
 *
 * cancelled 用于标记 agent 主动放弃（如 start 后发现不适用）。
 * abandoned 用于标记超时未终结（系统自动，agent 不能手动设）。
 */
const ALLOWED_TRANSITIONS: ReadonlyMap<
  string,
  ReadonlySet<TrackedItemStatus>
> = new Map([
  ["loaded", new Set(["completed", "error", "cancelled"])],
  ["error", new Set(["completed", "error", "recorded", "cancelled"])],
]);

// ── 类型 ────────────────────────────────────────────

export type TrackedItemStatus =
  | "loaded"
  | "error"
  | "completed"
  | "recorded"
  | "cancelled"
  | "abandoned";

/** L3 anchor：让 extractor 能定位 JSONL 原始上下文 */
export interface Anchor {
  triggerType: string;
  triggerTurn: number;
  triggerSummary: string;
}

export interface TrackedItem<
  TMeta = Record<string, unknown>,
> {
  id: number;
  name: string;
  status: TrackedItemStatus;
  errorCount: number;
  loadedAtTurn: number;
  lastRemindAtTurn: number;
  detail: string | null;
  metadata: TMeta;
  anchor: Anchor;
}

export interface TrackerRuntimeState<
  TMeta = Record<string, unknown>,
> {
  items: TrackedItem<TMeta>[];
  nextId: number;
  currentTurnIndex: number;
}

export interface TrackerDetails<
  TMeta = Record<string, unknown>,
> {
  action: "start" | "update" | "list";
  items: TrackedItem<TMeta>[];
  trackerName: string;
  createdId?: number;
  updatedId?: number;
  error?: string;
}

/** use_skill tool 参数 schema（start/update/list 三种 action） */
export const TrackerParams = Type.Object({
  action: StringEnum(["start", "update", "list"] as const),
  name: Type.Optional(
    Type.String({ description: "Skill name (required for start). Get from available_skills list." }),
  ),
  path: Type.Optional(
    Type.String({ description: "SKILL.md absolute path (optional for start, from available_skills location field)" }),
  ),
  id: Type.Optional(
    Type.Number({ description: "TrackedItem ID (required for update)" }),
  ),
  status: Type.Optional(
    StringEnum(["completed", "error", "cancelled", "recorded"] as const, {
      description:
        "Target status (required for update). cancelled = agent actively abandons. Note: abandoned is system-only, cannot be set manually.",
    }),
  ),
  detail: Type.Optional(
    Type.String({ description: "Additional notes (e.g. error reason, cancel reason)" }),
  ),
});

// ── 状态机函数 ──────────────────────────────────────

export function isTerminalStatus(status: TrackedItemStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function canTransition(
  from: TrackedItemStatus,
  to: TrackedItemStatus,
): boolean {
  if (isTerminalStatus(from)) return false;
  return ALLOWED_TRANSITIONS.get(from)?.has(to) ?? false;
}

// ── 序列化 ──────────────────────────────────────────

export function serializeState<TMeta>(
  state: TrackerRuntimeState<TMeta>,
): Record<string, unknown> {
  return {
    items: state.items,
    nextId: state.nextId,
    currentTurnIndex: state.currentTurnIndex,
  };
}

/**
 * 反序列化，含旧 skill-state-tracker 格式兼容。
 * 旧 item 的 skillMdPath 从顶层映射到 metadata.skillMdPath，
 * 缺少 anchor 的旧 item 填充默认值。
 */
export function deserializeState<TMeta>(
  data: Record<string, unknown>,
): TrackerRuntimeState<TMeta> {
  const rawItems = Array.isArray(data.items)
    ? (data.items as Array<Record<string, unknown>>)
    : [];

  const items = rawItems.map((raw) => {
    // 旧格式兼容：skillMdPath 在顶层 → 移入 metadata
    const metadata = ((raw.metadata ?? {}) as Record<string, unknown>);
    if (typeof raw.skillMdPath === "string") {
      metadata.skillMdPath = raw.skillMdPath;
    }

    const loadedAtTurn =
      typeof raw.loadedAtTurn === "number" ? raw.loadedAtTurn : 0;

    const anchor: Anchor = raw.anchor
      ? (raw.anchor as Anchor)
      : {
          triggerType: "unknown",
          triggerTurn: loadedAtTurn,
          triggerSummary: `legacy: ${raw.name ?? ""}`,
        };

    return {
      id: typeof raw.id === "number" ? raw.id : 0,
      name: typeof raw.name === "string" ? raw.name : "",
      status: (raw.status as TrackedItemStatus) ?? "loaded",
      errorCount: typeof raw.errorCount === "number" ? raw.errorCount : 0,
      loadedAtTurn,
      lastRemindAtTurn:
        typeof raw.lastRemindAtTurn === "number" ? raw.lastRemindAtTurn : -1,
      detail: typeof raw.detail === "string" ? raw.detail : null,
      metadata: metadata as TMeta,
      anchor,
    } satisfies TrackedItem<TMeta>;
  });

  // 过滤旧 dismissed item（不迁移、不映射，直接丢弃）
  // raw.status 来自旧 entry，理论值含 dismissed；TrackedItemStatus 不再含它，需强转
  const filteredItems = items.filter(
    (item) => (item.status as string) !== "dismissed",
  );

  return {
    items: filteredItems,
    nextId: typeof data.nextId === "number" ? data.nextId : 1,
    currentTurnIndex:
      typeof data.currentTurnIndex === "number" ? data.currentTurnIndex : 0,
  };
}

export function createInitialState<
  TMeta,
>(): TrackerRuntimeState<TMeta> {
  return { items: [], nextId: 1, currentTurnIndex: 0 };
}
