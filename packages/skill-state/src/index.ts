/**
 * skill-state-tracker — Pi 扩展
 *
 * 自动追踪 skill 加载/执行/异常状态。
 * Hook 自动检测 skill 加载（tool_call），状态机引导 AI 流转，
 * 异常累积到阈值自动触发问题记录。
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "typebox";
import {
  type SkillStateRuntimeState,
  type TrackedItem,
  ENTRY_TYPE,
  canTransition,
  createInitialState,
  deserializeState,
  extractSkillName,
  isTerminalStatus,
  serializeState,
} from "./state";
import {
  agentStartContextPrompt,
  errorForceRecordPrompt,
  loadedSteeringPrompt,
  remindSteeringPrompt,
} from "./templates";

// ── 常量 ────────────────────────────────────────────

const REMIND_INTERVAL = 10;
const ERROR_THRESHOLD = 2;

// ── 工具参数 Schema ─────────────────────────────────

const SkillStateParams = Type.Object({
  action: StringEnum(["update", "list"] as const),
  id: Type.Optional(Type.Number({ description: "TrackedItem ID（update 必填）" })),
  status: Type.Optional(
    StringEnum(["completed", "error", "recorded"] as const, {
      description: "目标状态（update 必填）",
    }),
  ),
  detail: Type.Optional(Type.String({ description: "附加说明（如 error 原因）" })),
});

// ── 类型守卫 ────────────────────────────────────────

function isSkillStateEntry(entry: SessionEntry): entry is CustomEntry<Record<string, unknown>> {
  return entry.type === "custom" && (entry as CustomEntry).customType === ENTRY_TYPE;
}

// ── Helper ──────────────────────────────────────────

function persistState(pi: ExtensionAPI, state: SkillStateRuntimeState, ctx: ExtensionContext): void {
  pi.appendEntry(ENTRY_TYPE, serializeState(state));
  // GC: 删除旧的同类型 entry，只保留最新的
  const entries = ctx.sessionManager.getEntries();
  const staleIndices: number[] = [];
  let foundLatest = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isSkillStateEntry(entry)) {
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

function findNonTerminalByName(items: TrackedItem[], name: string): TrackedItem | undefined {
  return items.find((item) => item.name === name && !isTerminalStatus(item.status));
}

function reconstructState(ctx: ExtensionContext): SkillStateRuntimeState {
  const entries = ctx.sessionManager.getEntries();
  let latestData: Record<string, unknown> | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isSkillStateEntry(entry)) {
      latestData = entry.data as Record<string, unknown>;
      break;
    }
  }
  if (!latestData) return createInitialState();

  const state = deserializeState(latestData);
  // 过滤终态 item
  state.items = state.items.filter((item) => !isTerminalStatus(item.status));
  // 恢复 currentTurnIndex：从 entries 中 turn_end 类型推算
  let turnCount = 0;
  for (const entry of entries) {
    if (entry.type === "custom_message" || entry.type === "message") {
      turnCount++;
    }
  }
  state.currentTurnIndex = turnCount;
  return state;
}

// ── 详情接口 ────────────────────────────────────────

interface SkillStateDetails {
  action: "update" | "list";
  items: TrackedItem[];
  updatedId?: number;
  error?: string;
}

// ── 工具执行 ────────────────────────────────────────

async function executeSkillState(
  pi: ExtensionAPI,
  state: SkillStateRuntimeState,
  params: {
    action: "update" | "list";
    id?: number;
    status?: "completed" | "error" | "recorded";
    detail?: string;
  },
  ctx: ExtensionContext,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SkillStateDetails }> {
  if (params.action === "list") {
    return {
      content: [{ type: "text", text: formatItemList(state.items) }],
      details: { action: "list", items: [...state.items] },
    };
  }

  // action === "update"
  if (params.id === undefined) {
    throw new Error("update 操作需要 id 参数");
  }
  if (params.status === undefined) {
    throw new Error("update 操作需要 status 参数");
  }

  const itemIndex = state.items.findIndex((item) => item.id === params.id);
  if (itemIndex === -1) {
    throw new Error(`TrackedItem id=${params.id} 不存在`);
  }

  const item = state.items[itemIndex];
  if (!canTransition(item.status, params.status)) {
    throw new Error(
      `非法转换: ${item.status} → ${params.status}（当前 ${item.status}，终态不可变更或该路径不允许）`,
    );
  }

  // 执行转换
  item.status = params.status;
  item.detail = params.detail ?? item.detail;

  if (params.status === "error") {
    item.errorCount += 1;
    if (item.errorCount >= ERROR_THRESHOLD) {
      // FR-4: 注入强制记录 steering
      await pi.sendUserMessage(errorForceRecordPrompt(item), { deliverAs: "steer" });
    }
  }

  persistState(pi, state, ctx);

  const statusText = isTerminalStatus(item.status) ? "（终态）" : "";
  return {
    content: [
      {
        type: "text",
        text: `TrackedItem #${item.id} "${item.name}" → ${item.status}${statusText}`,
      },
    ],
    details: { action: "update", items: [...state.items], updatedId: item.id },
  };
}

function formatItemList(items: TrackedItem[]): string {
  if (items.length === 0) return "无活跃追踪。";
  return items
    .map(
      (item) =>
        `#${item.id} "${item.name}" status=${item.status} errorCount=${item.errorCount} loadedAtTurn=${item.loadedAtTurn}` +
        (item.detail ? ` detail="${item.detail}"` : ""),
    )
    .join("\n");
}

// ── 渲染 ────────────────────────────────────────────

function renderSkillStateCall(args: Record<string, unknown>, theme: Theme): Text {
  const parts = [theme.fg("toolTitle", theme.bold("skill_state ")), theme.fg("muted", String(args.action ?? ""))];
  if (args.id !== undefined) parts.push(theme.fg("accent", `#${String(args.id)}`));
  if (args.status !== undefined) parts.push(theme.fg("warning", String(args.status)));
  if (args.detail !== undefined) parts.push(theme.fg("dim", `"${String(args.detail)}"`));
  return new Text(parts.join(" "), 0, 0);
}

function renderSkillStateResult(
  result: { details: unknown },
  options: { expanded?: boolean },
  theme: Theme,
): Text {
  const details = result.details as SkillStateDetails;
  if (details.error) {
    return new Text(theme.fg("error", `[SKILL-STATE] 错误: ${details.error}`), 0, 0);
  }
  const prefix = theme.fg("accent", "[SKILL-STATE] ");
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
  return new Text(prefix + summary + "\n" + theme.fg("dim", items), 0, 0);
}

// ── 事件处理器 ──────────────────────────────────────

async function handleToolCall(
  event: { toolName: string; input: Record<string, unknown> },
  pi: ExtensionAPI,
  state: SkillStateRuntimeState,
  ctx: ExtensionContext,
): Promise<undefined> {
  if (event.toolName !== "read") return undefined;
  const path = event.input?.path;
  if (typeof path !== "string") return undefined;

  const skillName = extractSkillName(path);
  if (!skillName) return undefined;

  // 去重：非终态同名 item 存在时不重复创建
  const existing = findNonTerminalByName(state.items, skillName);
  if (existing) return undefined;

  // 创建新 TrackedItem
  const newItem: TrackedItem = {
    id: state.nextId,
    name: skillName,
    status: "loaded",
    errorCount: 0,
    loadedAtTurn: state.currentTurnIndex,
    lastRemindAtTurn: -1,
    detail: null,
    skillMdPath: path,
  };
  state.items.push(newItem);
  state.nextId++;

  persistState(pi, state, ctx);

  // 注入 steering 提示词
  await pi.sendUserMessage(loadedSteeringPrompt(skillName, newItem.id), { deliverAs: "steer" });

  return undefined;
}

async function handleTurnEnd(
  event: { turnIndex?: number },
  pi: ExtensionAPI,
  state: SkillStateRuntimeState,
  ctx: ExtensionContext,
): Promise<void> {
  // 使用事件中的 turnIndex（如果存在），否则自增
  const eventTurnIndex = event.turnIndex;
  if (typeof eventTurnIndex === "number") {
    state.currentTurnIndex = eventTurnIndex;
  } else {
    state.currentTurnIndex++;
  }

  let needsPersist = false;
  for (const item of state.items) {
    if (isTerminalStatus(item.status)) continue;

    const turnsSinceLoad = state.currentTurnIndex - item.loadedAtTurn;
    const turnsSinceRemind = state.currentTurnIndex - item.lastRemindAtTurn;

    if (turnsSinceLoad >= REMIND_INTERVAL && turnsSinceRemind >= REMIND_INTERVAL) {
      await pi.sendUserMessage(remindSteeringPrompt(item.name, turnsSinceLoad), {
        deliverAs: "steer",
      });
      item.lastRemindAtTurn = state.currentTurnIndex;
      needsPersist = true;
    }
  }

  if (needsPersist) {
    persistState(pi, state, ctx);
  }
}

function handleBeforeAgentStart(state: SkillStateRuntimeState): { message: { customType: string; content: string; display: boolean } } | undefined {
  const activeItems = state.items.filter((item) => !isTerminalStatus(item.status));
  if (activeItems.length === 0) return undefined;

  return {
    message: {
      customType: "skill-state-context",
      content: agentStartContextPrompt(activeItems),
      display: false,
    },
  };
}

// ── 扩展工厂 ────────────────────────────────────────

export default function skillStateExtension(pi: ExtensionAPI): void {
  let state = createInitialState();

  // ── Event: session_start / session_tree（FR-7）──

  const handleSessionRestore = async (_event: unknown, ctx: ExtensionContext) => {
    state = reconstructState(ctx);
  };
  pi.on("session_start", handleSessionRestore);
  pi.on("session_tree", handleSessionRestore);

  // ── Event: tool_call（FR-1, AC-1/2/3）────────────

  pi.on("tool_call", async (event: any, ctx: ExtensionContext) => handleToolCall(event, pi, state, ctx));

  // ── Event: turn_end（FR-3, AC-6）──────────────────

  pi.on("turn_end", async (event: any, ctx: ExtensionContext) => handleTurnEnd(event, pi, state, ctx));

  // ── Event: before_agent_start（FR-8, AC-8）───────

  pi.on("before_agent_start", async () => handleBeforeAgentStart(state));

  // ── Message Renderer ──────────────────────────────

  const messageTypes = ["skill-state-context", "skill-state-remind", "skill-state-force-record"];
  for (const customType of messageTypes) {
    pi.registerMessageRenderer(customType, (message: any, _options: any, theme: Theme) => {
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      return new Text(theme.fg("accent", "[SKILL-STATE] ") + theme.fg("dim", content), 0, 0);
    });
  }

  // ── Tool: skill_state（FR-5, AC-4/5）─────────────

  pi.registerTool({
    name: "skill_state",
    label: "Skill State",
    description:
      "管理 skill 执行追踪状态。" +
      "\n\n可用 action：" +
      "\n- list：查看所有 TrackedItem" +
      "\n- update：更新 TrackedItem 状态（需要 id 和 status）",
    promptSnippet: "追踪 skill 执行状态，自动检测 skill 加载",
    promptGuidelines: [
      "[触发] skill 加载时自动创建追踪，无需手动创建",
      "[流转] 执行完成后用 update status=completed 标记成功",
      "[异常] 遇到困难时用 update status=error 标记异常",
      "[记录] 异常累积 2 次后系统会要求记录问题，完成后 update status=recorded",
      "[查询] 随时用 list 查看所有追踪状态",
    ],
    parameters: SkillStateParams,

    async execute(_toolCallId: string, params: Static<typeof SkillStateParams>, _signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext) {
      const result = await executeSkillState(pi, state, params as any, ctx);
      return result;
    },

    renderCall(args: any, theme: Theme, _context?: any) {
      return renderSkillStateCall(args as Record<string, unknown>, theme);
    },

    renderResult(result: any, options: any, theme: Theme, _context?: any) {
      return renderSkillStateResult(result, options, theme);
    },
  });
}
