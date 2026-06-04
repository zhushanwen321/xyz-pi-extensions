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

import {
  canTransition,
  createInitialState,
  deserializeState,
  isTerminalStatus,
  serializeState,
  TrackerParams,

  type TrackedItem,
  type TrackedItemStatus,
  type TrackerDetails,
  type TrackerRuntimeState,
} from "./types";

// ── Pi SDK custom event API type ──────────────────────

type PiOnAny = {
  on(event: string, handler: (...args: unknown[]) => unknown): void;
};

// ── Tool execute/render param types ──────────────────

type RenderOptions = { expanded?: boolean };

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
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
  triggerEvent: string;
  triggerMatch: (
    event: unknown,
  ) => { name: string; metadata: TMeta; summary: string } | null;
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

// ── 工厂函数 ────────────────────────────────────────

export function createTracker<TMeta>(
  pi: ExtensionAPI,
  config: TrackerConfig<TMeta>,
): void {
  let state: TrackerRuntimeState<TMeta> = createInitialState<TMeta>();

  // ── 持久化 + GC ───────────────────────────────────

  function persistState(ctx: ExtensionContext): void {
    pi.appendEntry(config.entryType, serializeState(state));
    const entries = ctx.sessionManager.getEntries();
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

  function reconstructState(ctx: ExtensionContext): void {
    const entries = ctx.sessionManager.getEntries();
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
    // 过滤终态 item
    state.items = state.items.filter(
      (item) => !isTerminalStatus(item.status),
    );
    // 恢复 currentTurnIndex
    let turnCount = 0;
    for (const entry of entries) {
      if (entry.type === "custom_message" || entry.type === "message") {
        turnCount++;
      }
    }
    state.currentTurnIndex = turnCount;
  }

  // ── Event: session_start / session_tree ────────────

  const handleSessionRestore = async (
    _event: unknown,
    ctx: ExtensionContext,
  ): Promise<void> => {
    reconstructState(ctx);
    const activeItems = state.items.filter(
      (item) => !isTerminalStatus(item.status),
    );
    if (activeItems.length > 0) {
      await pi.sendUserMessage(
        config.steering.onContextRestore(activeItems),
        { deliverAs: "steer" },
      );
    }
  };
  pi.on("session_start", handleSessionRestore);
  pi.on("session_tree", handleSessionRestore);

  // ── Event: triggerEvent (e.g. tool_call) ───────────

  // Pi 事件系统支持任意字符串事件名，但类型定义不完整（与 session_compact 同）
  (pi as unknown as PiOnAny).on(
    config.triggerEvent,
    async (event, nextCtx) => {
      const ctx = nextCtx as ExtensionContext;
      const match = config.triggerMatch(event);
      if (!match) return;

      // 去重：非终态同名 item 存在时不重复创建
      const existing = state.items.find(
        (item) =>
          item.name === match.name && !isTerminalStatus(item.status),
      );
      if (existing) return;

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
          triggerType: config.triggerEvent,
          triggerTurn: turnIndex,
          triggerSummary: match.summary,
        },
      };
      state.items.push(newItem);
      state.nextId++;

      persistState(ctx);
      await pi.sendUserMessage(config.steering.onCreate(newItem), {
        deliverAs: "steer",
      });
    },
  );

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
      for (const item of state.items) {
        if (isTerminalStatus(item.status)) continue;

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
    const activeItems = state.items.filter(
      (item) => !isTerminalStatus(item.status),
    );
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

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<ToolResult> {
      // ── list ──
      if (params.action === "list") {
        return {
          content: [
            {
              type: "text" as const,
              text: formatItemList(state.items, config.name),
            },
          ],
          details: {
            action: "list",
            items: [...state.items],
            trackerName: config.name,
          } satisfies TrackerDetails<TMeta>,
        };
      }

      // ── update ──
      const updateId = params.id as number | undefined;
      const updateStatus = params.status as string | undefined;
      if (updateId === undefined) {
        return { content: [{ type: "text", text: "update action requires id parameter" }], isError: true };
      }
      if (updateStatus === undefined) {
        return { content: [{ type: "text", text: "update action requires status parameter" }], isError: true };
      }

      const itemIndex = state.items.findIndex(
        (item) => item.id === updateId,
      );
      if (itemIndex === -1) {
        return { content: [{ type: "text", text: `TrackedItem id=${updateId} not found` }], isError: true };
      }

      const item = state.items[itemIndex];
      if (!canTransition(item.status, updateStatus as TrackedItemStatus)) {
        return { content: [{ type: "text", text: `Invalid transition: ${item.status} → ${updateStatus} (current: ${item.status}, terminal states are immutable or path not allowed)` }], isError: true };
      }

      // 执行转换
      item.status = updateStatus as TrackedItemStatus;
      item.detail = (params.detail as string | undefined | null) ?? item.detail;

      if (updateStatus === "error") {
        item.errorCount += 1;
        if (item.errorCount >= config.errorThreshold) {
          await pi.sendUserMessage(config.steering.onError(item), {
            deliverAs: "steer",
          });
        }
      }

      persistState(ctx);

      const statusText = isTerminalStatus(item.status) ? " (terminal)" : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `TrackedItem #${item.id} "${item.name}" → ${item.status}${statusText}`,
          },
        ],
        details: {
          action: "update",
          items: [...state.items],
          trackerName: config.name,
          updatedId: item.id,
        } satisfies TrackerDetails<TMeta>,
      };
    },

    renderCall(
      args: Record<string, unknown>,
      theme: Theme,
      _context?: unknown,
    ) {
      return renderTrackerCall(args, config, theme);
    },

    renderResult(
      result: ToolResult,
      options: RenderOptions,
      theme: Theme,
      _context?: unknown,
    ) {
      return renderTrackerResult(result, options, config, theme);
    },
  });
}
