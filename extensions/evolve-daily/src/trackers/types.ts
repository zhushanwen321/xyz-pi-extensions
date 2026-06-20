/**
 * Activity Tracker Framework — 类型定义与状态机
 *
 * 通用 TrackedItem 状态机：
 *   loaded  → completed | error | cancelled | abandoned(system)
 *   error   → completed | recorded | cancelled | abandoned(system)
 *   abandoned(system) → completed | error | cancelled | recorded
 * 纯数据层，无 Pi API 依赖。
 */

import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";

// ── 常量 ────────────────────────────────────────────

const TERMINAL_STATUSES: ReadonlySet<TrackedItemStatus> = new Set([
  "completed",
  "recorded",
  "cancelled",
]);

/** 需要被提醒/继续追踪的非终态集合（含可被恢复的 abandoned） */
const RESUMABLE_STATUSES: ReadonlySet<TrackedItemStatus> = new Set([
  "loaded",
  "error",
  "abandoned",
]);

/**
 * FR-3 转换矩阵：
 *   loaded    → completed ✅, error ✅, cancelled ✅
 *   error     → completed ✅, error ✅, recorded ✅, cancelled ✅
 *   abandoned → completed ✅, error ✅, cancelled ✅, recorded ✅
 *   终态不可变更：completed / recorded / cancelled
 *
 * cancelled 用于标记 agent 主动放弃（如 start 后发现不适用）。
 * abandoned 主要是系统状态（turn_end/reconstructState 自动触发），但允许 agent 手动恢复，
 * 避免"用户回来收尾时无法关闭"的僵局。
 *
 * key 类型为 TrackedItemStatus，编译期防止拼写错误。
 */
const ALLOWED_TRANSITIONS: ReadonlyMap<
  TrackedItemStatus,
  ReadonlySet<TrackedItemStatus>
> = new Map<TrackedItemStatus, ReadonlySet<TrackedItemStatus>>([
  ["loaded", new Set<TrackedItemStatus>(["completed", "error", "cancelled"])],
  ["error", new Set<TrackedItemStatus>(["completed", "error", "recorded", "cancelled"])],
  ["abandoned", new Set<TrackedItemStatus>(["completed", "error", "recorded", "cancelled"])],
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

/** 终态：agent 无法再手动变更（但 abandoned 可被恢复，不算严格终态） */
export function isTerminalStatus(status: TrackedItemStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** 是否仍应被追踪/提醒（loaded/error/abandoned） */
export function isResumableStatus(status: TrackedItemStatus): boolean {
  return RESUMABLE_STATUSES.has(status);
}

export function canTransition(
  from: TrackedItemStatus,
  to: TrackedItemStatus,
): boolean {
  if (isTerminalStatus(from)) return false;
  return ALLOWED_TRANSITIONS.get(from)?.has(to) ?? false;
}

// ── 类型守卫 ────────────────────────────────────────

const TRACKED_ITEM_STATUSES: ReadonlySet<TrackedItemStatus> = new Set<TrackedItemStatus>([
  "loaded",
  "error",
  "completed",
  "recorded",
  "cancelled",
  "abandoned",
]);

/** 运行时校验 status 是否为合法的 TrackedItemStatus（用于反序列化外部数据） */
function isTrackedItemStatus(x: unknown): x is TrackedItemStatus {
  return typeof x === "string" && TRACKED_ITEM_STATUSES.has(x as TrackedItemStatus);
}

/** 校验 anchor 结构（旧数据可能缺字段或格式漂移） */
function isAnchor(x: unknown): x is Anchor {
  if (typeof x !== "object" || x === null) return false;
  const a = x as Record<string, unknown>;
  return (
    typeof a.triggerType === "string" &&
    typeof a.triggerTurn === "number" &&
    typeof a.triggerSummary === "string"
  );
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

    // 过滤旧 dismissed item（不迁移、不映射，直接丢弃）
    // 在 map 内提前过滤：raw.status 含已废弃的 dismissed，需在强转前拦截
    const status: TrackedItemStatus = isTrackedItemStatus(raw.status)
      ? raw.status
      : "loaded";

    const anchor: Anchor = isAnchor(raw.anchor)
      ? raw.anchor
      : {
          triggerType: "unknown",
          triggerTurn: loadedAtTurn,
          triggerSummary: `legacy: ${typeof raw.name === "string" ? raw.name : ""}`,
        };

    return {
      id: typeof raw.id === "number" ? raw.id : 0,
      name: typeof raw.name === "string" ? raw.name : "",
      // dismissed 在 isTrackedItemStatus 中已返回 false → fallback "loaded"，
      // 但语义上 dismissed 是已废弃的终态，不应复活为 loaded，下面 filter 会丢弃
      status,
      errorCount: typeof raw.errorCount === "number" ? raw.errorCount : 0,
      loadedAtTurn,
      lastRemindAtTurn:
        typeof raw.lastRemindAtTurn === "number" ? raw.lastRemindAtTurn : -1,
      detail: typeof raw.detail === "string" ? raw.detail : null,
      metadata: metadata as TMeta,
      anchor,
    } satisfies TrackedItem<TMeta>;
  });

  // 过滤旧 dismissed item（isTrackedItemStatus 不含 dismissed，已 fallback 为 loaded；
  // 这里用原始 raw.status 再判一次，确保 dismissed 不被误当作 loaded 复活）
  const filteredItems = items.filter((_, i) => {
    const rawStatus = rawItems[i]?.status;
    return rawStatus !== "dismissed";
  });

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
