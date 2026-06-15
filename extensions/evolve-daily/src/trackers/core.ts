/**
 * Activity Tracker Framework — createTracker 工厂函数
 *
 * 封装所有样板逻辑：事件注册、工具注册、状态持久化、
 * steering 注入、GC、remind。在扩展工厂闭包内调用。
 */

import type {
  CustomEntry,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { Static } from "typebox";

import { isValidSkillName } from "./skill-registry";
import {
  canTransition,
  createInitialState,
  deserializeState,
  isResumableStatus,
  isTerminalStatus,
  serializeState,
  type TrackedItem,
  type TrackedItemStatus,
  type TrackerDetails,
  TrackerParams,
  type TrackerRuntimeState,
} from "./types";

// ── Pi SDK custom event API type ──────────────────────

type PiOnAny = {
  on(event: string, handler: (...args: unknown[]) => unknown): void;
};

// ── Stale context detection ──────────────────────────

const STALE_CONTEXT_PATTERNS = [
  "Extension context no longer active",
  "aborted",
  "context canceled",
  "stale context",
  "stalecontext",
];

/** Detect errors that indicate the Pi session has been torn down (compact/reload/exit). */
export function isStaleContextError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return STALE_CONTEXT_PATTERNS.some((p) => msg.includes(p.toLowerCase()));
}

/** 是否仍需在上下文中保留（非终态，含 abandoned 因为它可被恢复） */
function isActive<TMeta>(item: TrackedItem<TMeta>): boolean {
  return !isTerminalStatus(item.status);
}

/** 将超过 abandonThreshold 的非终态 item 标记为 abandoned，返回是否有变更 */
export function markStaleItemsAbandoned<TMeta>(
  state: TrackerRuntimeState<TMeta>,
  abandonThreshold: number,
): boolean {
  let changed = false;
  for (const item of state.items) {
    if (!isResumableStatus(item.status)) continue;
    // 已 abandoned 的 item 跳过：isResumableStatus("abandoned") 为 true，
    // 但重复赋值无意义，且会持续返回 changed=true 触发无谓持久化与状态增长。
    if (item.status === "abandoned") continue;
    const turnsSinceLoad = state.currentTurnIndex - item.loadedAtTurn;
    if (turnsSinceLoad >= abandonThreshold) {
      item.status = "abandoned";
      changed = true;
    }
  }
  return changed;
}

// ── Tool execute/render param types ──────────────────

type RenderOptions = { expanded?: boolean };

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown> | undefined;
  isError?: boolean;
};

// ── Tracker 配置接口（避免 types.ts 引入 Pi API 类型）──

export interface TrackerConfig<TMeta = Record<string, unknown>> {
  name: string;
  toolName: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];

  /** 被动触发事件（可选）。不配则不注册被动监听，创建由 triggerTool 驱动 */
  triggerEvent?: string;
  triggerMatch?: (
    event: unknown,
    ctx: ExtensionContext,
  ) => { name: string; metadata: TMeta; summary: string } | null;

  /** 主动声明 tool 配置（可选）。配了则在 tool execute 中支持 start action */
  triggerTool?: {
    /** 从 tool params 提取 match 信息（name/metadata/summary） */
    extractMeta: (
      params: Record<string, unknown>,
    ) => { name: string; metadata: TMeta; summary: string };
  };

  steering: {
    onCreate: (item: TrackedItem<TMeta>) => string;
    onRemind: (item: TrackedItem<TMeta>, turnsSinceLoad: number) => string;
    onError: (item: TrackedItem<TMeta>) => string;
    onContextRestore: (items: TrackedItem<TMeta>[]) => string;
  };
  entryType: string;
  /** 旧版 entryType（用于向后兼容反序列化） */
  legacyEntryTypes?: string[];
  messageTypes: string[];
  remindInterval: number;
  errorThreshold: number;
  /** 超时 turn 数，非终态 item 超过此值自动转 abandoned */
  abandonThreshold: number;
  renderResult?: (
    details: TrackerDetails<TMeta>,
    options: { expanded?: boolean },
    theme: Theme,
  ) => Text;
}

// ── 类型守卫 ────────────────────────────────────────

function isCustomEntry(
  entry: SessionEntry,
  customType: string,
): boolean {
  return (
    entry.type === "custom" &&
    (entry as CustomEntry).customType === customType
  );
}

// ── 格式化 ──────────────────────────────────────────

function formatItemList<TMeta>(
  items: TrackedItem<TMeta>[],
  trackerName: string,
): string {
  if (items.length === 0) return `No active tracked items (${trackerName}).`;
  return items
    .map(
      (item) =>
        `#${item.id} "${item.name}" status=${item.status} errorCount=${item.errorCount}` +
        ` loadedAtTurn=${item.loadedAtTurn}` +
        (item.detail ? ` detail="${item.detail}"` : ""),
    )
    .join("\n");
}

// ── Tool render helpers (extracted to keep createTracker ≤300 lines) ──

function renderTrackerCall<TMeta>(
  args: Record<string, unknown>,
  config: TrackerConfig<TMeta>,
  theme: Theme,
): Text {
  const parts = [
    theme.fg("toolTitle", theme.bold(`${config.toolName} `)),
    theme.fg("muted", String(args.action ?? "")),
  ];
  if (args.id !== undefined)
    parts.push(theme.fg("accent", `#${String(args.id)}`));
  if (args.status !== undefined)
    parts.push(theme.fg("warning", String(args.status)));
  if (args.detail !== undefined)
    parts.push(theme.fg("dim", `"${String(args.detail)}"`));
  return new Text(parts.join(" "), 0, 0);
}

function renderTrackerResult<TMeta>(
  result: ToolResult,
  options: RenderOptions,
  config: TrackerConfig<TMeta>,
  theme: Theme,
): Text {
  if (config.renderResult && result.details) {
    return config.renderResult(
      result.details as unknown as TrackerDetails<TMeta>,
      options,
      theme,
    );
  }

  if (!result.details) {
    return new Text(theme.fg("dim", "(no details)"), 0, 0);
  }

  // 框架默认渲染
  const details = result.details as unknown as TrackerDetails<TMeta>;
  if (details.error) {
    return new Text(
      theme.fg("error", `[${config.name}] Error: ${details.error}`),
      0,
      0,
    );
  }

  const prefix = theme.fg("accent", `[${config.name}] `);
  const summary = `${details.action}: ${details.items.length} items`;

  if (!options.expanded) {
    return new Text(prefix + theme.fg("dim", summary), 0, 0);
  }

  const items = details.items
    .map((item) => {
      const terminal = isTerminalStatus(item.status) ? " ✓" : "";
      return `  #${item.id} ${item.name} [${item.status}]${terminal}`;
    })
    .join("\n");
  return new Text(
    prefix + summary + "\n" + theme.fg("dim", items),
    0,
    0,
  );
}

// ── execute 分发（提取为顶层函数避免 createTracker 超 300 行）──

type CreateItemFn<TMeta> = (
  match: { name: string; metadata: TMeta; summary: string },
  ctx: ExtensionContext,
) => TrackedItem<TMeta>;
type PersistFn = (ctx: ExtensionContext) => void;

/** executeTrackerAction 的运行时依赖打包（减少参数个数） */
export interface TrackerActionContext<TMeta> {
  state: TrackerRuntimeState<TMeta>;
  config: TrackerConfig<TMeta>;
  pi: ExtensionAPI;
  createItem: CreateItemFn<TMeta>;
  persistState: PersistFn;
}

/** 构造错误返回值的 helper（统一 details.error 填充，避免重复） */
function errorResult<TMeta>(
  action: TrackerDetails<TMeta>["action"],
  message: string,
  dep: { state: TrackerRuntimeState<TMeta>; name: string },
): ToolResult {
  return {
    content: [{ type: "text" as const, text: message }],
    details: {
      action,
      items: [...dep.state.items],
      trackerName: dep.name,
      error: message,
    } satisfies TrackerDetails<TMeta>,
    isError: true,
  };
}

export async function handleStart<TMeta>(
  params: Static<typeof TrackerParams>,
  ctx: ExtensionContext,
  dep: TrackerActionContext<TMeta>,
): Promise<ToolResult> {
  const { state, config, pi, createItem } = dep;
  if (!config.triggerTool) {
    return errorResult("start", "start action not supported by this tracker", { state, name: config.name });
  }
  const skillName = params.name;
  if (!skillName) {
    return errorResult("start", "start requires name parameter", { state, name: config.name });
  }

  // name 校验：从 system prompt 的 <available_skills> 块查
  const systemPrompt = ctx.getSystemPrompt();
  if (!isValidSkillName(skillName, systemPrompt)) {
    return errorResult("start", `skill "${skillName}" not found`, { state, name: config.name });
  }

  const match = config.triggerTool.extractMeta(params);

  // 去重：同名 skill 仍处于非终态时不重复创建，与被动 handler 行为一致
  const existing = state.items.find(
    (item) => item.name === match.name && isActive(item),
  );
  if (existing) {
    return {
      content: [{ type: "text" as const, text: `Skill "${match.name}" is already tracked as #${existing.id} (status=${existing.status}). Use ${config.toolName}(action=update, id=${existing.id}, ...) to update it.` }],
      details: { action: "start" as const, items: [...state.items], trackerName: config.name, createdId: existing.id } satisfies TrackerDetails<TMeta>,
    };
  }

  const newItem = createItem(match, ctx);
  await pi.sendUserMessage(config.steering.onCreate(newItem), { deliverAs: "steer" });

  return {
    content: [{ type: "text" as const, text: `Tracking started: #${newItem.id} "${newItem.name}". Call ${config.toolName}(action=update, id=${newItem.id}, status=completed) when done.` }],
    details: { action: "start", items: [...state.items], trackerName: config.name, createdId: newItem.id } satisfies TrackerDetails<TMeta>,
  };
}

function handleList<TMeta>(
  dep: TrackerActionContext<TMeta>,
): ToolResult {
  const { state, config } = dep;
  return {
    content: [{ type: "text" as const, text: formatItemList(state.items, config.name) }],
    details: { action: "list", items: [...state.items], trackerName: config.name } satisfies TrackerDetails<TMeta>,
  };
}

export type UpdateValidation<TMeta> =
  | { ok: true; item: TrackedItem<TMeta>; updateStatus: TrackedItemStatus }
  | { ok: false; result: ToolResult };

/** 校验 update 参数 + 状态转换合法性。失败返回 errorResult，成功返回目标 item */
export function validateUpdateParams<TMeta>(
  params: Static<typeof TrackerParams>,
  dep: TrackerActionContext<TMeta>,
): UpdateValidation<TMeta> {
  const { state, config } = dep;
  const updateId = params.id;
  const updateStatus = params.status;
  if (updateId === undefined) {
    return { ok: false, result: errorResult("update", "update action requires id parameter", { state, name: config.name }) };
  }
  if (updateStatus === undefined) {
    return { ok: false, result: errorResult("update", "update action requires status parameter", { state, name: config.name }) };
  }
  const item = state.items.find((it) => it.id === updateId);
  if (!item) {
    return { ok: false, result: errorResult("update", `TrackedItem id=${updateId} not found`, { state, name: config.name }) };
  }
  if (!canTransition(item.status, updateStatus)) {
    return { ok: false, result: errorResult("update", `Invalid transition: ${item.status} → ${updateStatus} (current: ${item.status}, terminal states are immutable or path not allowed)`, { state, name: config.name }) };
  }
  return { ok: true, item, updateStatus };
}

/** 处理 error 状态的 errorCount 递增 + onError steering（达到阈值时触发） */
export async function handleOnErrorThreshold<TMeta>(
  item: TrackedItem<TMeta>,
  updateStatus: TrackedItemStatus,
  dep: TrackerActionContext<TMeta>,
): Promise<void> {
  if (updateStatus !== "error") return;
  item.errorCount += 1;
  if (item.errorCount >= dep.config.errorThreshold) {
    await dep.pi.sendUserMessage(dep.config.steering.onError(item), { deliverAs: "steer" });
  }
}

/** 应用状态转换 + side effects（remind/errorCount 重置、onError steering、持久化） */
export async function applyUpdate<TMeta>(
  item: TrackedItem<TMeta>,
  updateStatus: TrackedItemStatus,
  detail: string | undefined,
  ctx: ExtensionContext,
  dep: TrackerActionContext<TMeta>,
): Promise<ToolResult> {
  const { state, config, persistState } = dep;
  const fromAbandoned = item.status === "abandoned";
  item.status = updateStatus;
  item.detail = detail ?? item.detail;

  // 从 abandoned 恢复：重置 remind 计时 + errorCount（超时放弃≠新错误，恢复视为新周期）
  if (fromAbandoned) {
    item.lastRemindAtTurn = state.currentTurnIndex;
    item.errorCount = 0;
  }

  await handleOnErrorThreshold(item, updateStatus, dep);
  persistState(ctx);

  const statusText = isTerminalStatus(item.status) ? " (terminal)" : "";
  return {
    content: [{ type: "text" as const, text: `TrackedItem #${item.id} "${item.name}" → ${item.status}${statusText}` }],
    details: { action: "update", items: [...state.items], trackerName: config.name, updatedId: item.id } satisfies TrackerDetails<TMeta>,
  };
}

/** 创建新 TrackedItem 并推入 state、递增 nextId、持久化（createTracker 内闭包与测试共用） */
export function createTrackedItem<TMeta>(
  match: { name: string; metadata: TMeta; summary: string },
  ctx: ExtensionContext,
  dep: {
    state: TrackerRuntimeState<TMeta>;
    config: TrackerConfig<TMeta>;
    persistState: PersistFn;
  },
): TrackedItem<TMeta> {
  const { state, config, persistState } = dep;
  const turnIndex = state.currentTurnIndex;
  const newItem: TrackedItem<TMeta> = {
    id: state.nextId,
    name: match.name,
    status: "loaded",
    errorCount: 0,
    loadedAtTurn: turnIndex,
    lastRemindAtTurn: -1,
    detail: null,
    metadata: match.metadata,
    anchor: {
      triggerType: config.triggerEvent ?? "tool-start",
      triggerTurn: turnIndex,
      triggerSummary: match.summary,
    },
  };
  state.items.push(newItem);
  state.nextId++;
  persistState(ctx);
  return newItem;
}

async function handleUpdate<TMeta>(
  params: Static<typeof TrackerParams>,
  ctx: ExtensionContext,
  dep: TrackerActionContext<TMeta>,
): Promise<ToolResult> {
  const validation = validateUpdateParams(params, dep);
  if (!validation.ok) return validation.result;
  return applyUpdate(validation.item, validation.updateStatus, params.detail, ctx, dep);
}

async function executeTrackerAction<TMeta>(
  params: Static<typeof TrackerParams>,
  ctx: ExtensionContext,
  dep: TrackerActionContext<TMeta>,
): Promise<ToolResult> {
  switch (params.action) {
    case "start":
      return handleStart(params, ctx, dep);
    case "list":
      return handleList(dep);
    case "update":
      return handleUpdate(params, ctx, dep);
    default:
      return errorResult("list", `Unknown action: ${params.action}`, {
        state: dep.state,
        name: dep.config.name,
      });
  }
}

// ── 工厂函数 ────────────────────────────────────────

export function createTracker<TMeta>(
  pi: ExtensionAPI,
  config: TrackerConfig<TMeta>,
): void {
  let state: TrackerRuntimeState<TMeta> = createInitialState<TMeta>();

  // ── 持久化 + GC ───────────────────────────────────

  function persistState(ctx: ExtensionContext): void {
    let entries: SessionEntry[];
    try {
      pi.appendEntry(config.entryType, serializeState(state));
      entries = ctx.sessionManager.getEntries();
    } catch (e) {
      if (isStaleContextError(e)) {
        console.warn(
          `[${config.name}] skip persist: stale context (${(e as Error).message})`,
        );
        return;
      }
      throw e;
    }
    const staleIndices: number[] = [];
    let foundLatest = false;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (isCustomEntry(entries[i], config.entryType)) {
        if (!foundLatest) {
          foundLatest = true;
        } else {
          staleIndices.push(i);
        }
      }
    }
    for (const idx of staleIndices) {
      entries.splice(idx, 1);
    }
  }

  // ── 状态恢复 ──────────────────────────────────────

  // ── 创建 item（triggerEvent handler 和 tool start action 共用）──

  const createItem: CreateItemFn<TMeta> = (match, ctx) =>
    createTrackedItem(match, ctx, { state, config, persistState });

  function reconstructState(ctx: ExtensionContext): void {
    let entries: SessionEntry[];
    try {
      entries = ctx.sessionManager.getEntries();
    } catch (e) {
      if (isStaleContextError(e)) {
        console.warn(
          `[${config.name}] skip reconstruct: stale context (${(e as Error).message})`,
        );
        state = createInitialState<TMeta>();
        return;
      }
      throw e;
    }
    const allTypes = [config.entryType, ...(config.legacyEntryTypes ?? [])];

    let latestData: Record<string, unknown> | undefined;
    for (let i = entries.length - 1; i >= 0; i--) {
      for (const et of allTypes) {
        if (isCustomEntry(entries[i], et)) {
          latestData = (entries[i] as CustomEntry).data as Record<
            string,
            unknown
          >;
          break;
        }
      }
      if (latestData) break;
    }

    if (!latestData) {
      state = createInitialState<TMeta>();
      return;
    }

    state = deserializeState<TMeta>(latestData);
    // 恢复 currentTurnIndex
    let turnCount = 0;
    for (const entry of entries) {
      if (entry.type === "custom_message" || entry.type === "message") {
        turnCount++;
      }
    }
    state.currentTurnIndex = turnCount;

    // 检查超时 item（compact/reload 后立即清理，不等下一个 turn_end）
    markStaleItemsAbandoned(state, config.abandonThreshold);

    // 过滤终态 item。abandoned 非终态（可被恢复），自动保留
    state.items = state.items.filter((item) => isActive(item));
  }

  // ── Event: session_start / session_tree ────────────

  const handleSessionRestore = async (
    _event: unknown,
    ctx: ExtensionContext,
  ): Promise<void> => {
    reconstructState(ctx);
    const activeItems = state.items.filter((item) => isActive(item));
    if (activeItems.length > 0) {
      await pi.sendUserMessage(
        config.steering.onContextRestore(activeItems),
        { deliverAs: "steer" },
      );
    }
  };
  pi.on("session_start", handleSessionRestore);
  pi.on("session_tree", handleSessionRestore);

  // ── Event: triggerEvent（仅当配置了被动触发时才注册）──

  if (config.triggerEvent && config.triggerMatch) {
    const { triggerMatch, triggerEvent } = config;
    (pi as unknown as PiOnAny).on(
      triggerEvent,
      async (event, nextCtx) => {
        const ctx = nextCtx as ExtensionContext;
        const match = triggerMatch(event, ctx);
        if (!match) return;

        // 被动模式下去重：可恢复/非终态同名 item 存在时不重复创建
        const existing = state.items.find(
          (item) =>
            item.name === match.name && !isTerminalStatus(item.status),
        );
        if (existing) return;

        const newItem = createItem(match, ctx);
        await pi.sendUserMessage(config.steering.onCreate(newItem), {
          deliverAs: "steer",
        });
      },
    );
  }

  // ── Event: turn_end（remind 检查）─────────────────

  (pi as unknown as PiOnAny).on(
    "turn_end",
    async (rawEvent, nextCtx) => {
      const event = rawEvent as Record<string, unknown>;
      const ctx = nextCtx as ExtensionContext;
      const eventTurnIndex = event.turnIndex;
      if (typeof eventTurnIndex === "number") {
        state.currentTurnIndex = eventTurnIndex;
      } else {
        state.currentTurnIndex++;
      }

      let needsPersist = false;
      // abandoned 检查（先于 remind——即将 abandon 的 item 不再发 remind）
      needsPersist = markStaleItemsAbandoned(state, config.abandonThreshold);
      for (const item of state.items) {
        // abandoned 已超时放弃，不再 remind（仅保留可恢复性供 agent 收尾）
        if (item.status === "abandoned") continue;
        if (!isResumableStatus(item.status)) continue;

        const turnsSinceLoad =
          state.currentTurnIndex - item.loadedAtTurn;
        const turnsSinceRemind =
          state.currentTurnIndex - item.lastRemindAtTurn;

        if (
          turnsSinceLoad >= config.remindInterval &&
          turnsSinceRemind >= config.remindInterval
        ) {
          await pi.sendUserMessage(
            config.steering.onRemind(item, turnsSinceLoad),
            { deliverAs: "steer" },
          );
          item.lastRemindAtTurn = state.currentTurnIndex;
          needsPersist = true;
        }
      }

      if (needsPersist) {
        persistState(ctx);
      }
    },
  );

  // ── Event: before_agent_start ──────────────────────

  pi.on("before_agent_start", async () => {
    const activeItems = state.items.filter((item) => isActive(item));
    if (activeItems.length === 0) return undefined;

    return {
      message: {
        customType: `${config.entryType}-context`,
        content: config.steering.onContextRestore(activeItems),
        display: false,
      },
    };
  });

  // ── Message Renderers ──────────────────────────────

  for (const customType of config.messageTypes) {
    pi.registerMessageRenderer(
      customType,
      (
        message: { content: string | unknown },
        _options: unknown,
        theme: Theme,
      ) => {
        const content =
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content);
        return new Text(
          theme.fg("accent", `[${config.name}] `) +
            theme.fg("dim", content),
          0,
          0,
        );
      },
    );
  }

  // ── Tool Registration ──────────────────────────────

  pi.registerTool({
    name: config.toolName,
    label: config.label,
    description: config.description,
    promptGuidelines: config.promptGuidelines,
    parameters: TrackerParams,

    execute: (
      _toolCallId: string,
      params: Static<typeof TrackerParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) =>
      executeTrackerAction(
        params,
        ctx,
        { state, config, pi, createItem, persistState },
      ),

    renderCall(
      args: Record<string, unknown>,
      theme: Theme,
      _context?: unknown,
    ) {
      return renderTrackerCall(args, config, theme);
    },

    renderResult(
      result: { content: Array<{ type: "text"; text?: string } | { type: "image"; data: string; mimeType: string }>; details?: Record<string, unknown> },
      _options: unknown,
      theme: Theme,
      _context?: unknown,
    ) {
      return renderTrackerResult(result as ToolResult, { expanded: (_options as Record<string, unknown> | undefined)?.expanded as boolean | undefined }, config, theme);
    },
  });
}
