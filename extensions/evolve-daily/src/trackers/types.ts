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
]);

/**
 * FR-3 转换矩阵：
 *   loaded  → completed ✅, error ✅, recorded ❌
 *   error   → completed ✅, error ✅, recorded ✅
 *   终态不可变更
 */
const ALLOWED_TRANSITIONS: ReadonlyMap<
  string,
  ReadonlySet<TrackedItemStatus>
> = new Map([
  ["loaded", new Set(["completed", "error"])],
  ["error", new Set(["completed", "error", "recorded"])],
]);

// ── 类型 ────────────────────────────────────────────

export type TrackedItemStatus = "loaded" | "error" | "completed" | "recorded";

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
  action: "update" | "list";
  items: TrackedItem<TMeta>[];
  trackerName: string;
  updatedId?: number;
  error?: string;
}

/** 所有 tracker 共享的参数 schema（同一状态机） */
export const TrackerParams = Type.Object({
  action: StringEnum(["update", "list"] as const),
  id: Type.Optional(
    Type.Number({ description: "TrackedItem ID (required for update)" }),
  ),
  status: Type.Optional(
    StringEnum(["completed", "error", "recorded"] as const, {
      description: "Target status (required for update)",
    }),
  ),
  detail: Type.Optional(
    Type.String({ description: "Additional notes (e.g. error reason)" }),
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

  return {
    items,
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
