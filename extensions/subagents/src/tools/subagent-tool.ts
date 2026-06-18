// src/tools/subagent-tool.ts
//
// `subagent` LLM 工具。薄壳——参数解析 + 首次 category 确认 + 调 runtime.execute。
// 不创建 state、不节流 onUpdate、不写 history（全部在 runtime 层统一）。
//
// 设计说明：renderCall/renderResult/execute 三个回调均抽成模块级 const +
// 顶层 type alias。原因：stub 的 registerTool(tool: unknown) 参数是 unknown，
// 在其对象字面量内直接标注从 pi-coding-agent 导入的泛型（AgentToolResult<X>、
// Theme、ExtensionContext）会触发 TS2307 误报（probe5d/5f 验证）。
// 抽到顶层后参数类型由 alias 提供，绕过该 quirk。

import type { Component } from "@earendil-works/pi-tui";
import { StringEnum } from "@mariozechner/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { getHub } from "../runtime/subagent-hub.ts";
import { CategoryConfirmComponent, type CategoryConfirmInput } from "../tui/category-confirm.ts";
import type { ThemeLike } from "../tui/format.ts";
import { type RenderContext,renderSubagentCall, renderSubagentResult } from "../tui/tool-render.ts";
import type { CategoryConfirmResult, ExecuteOptions, SubagentToolDetails } from "../types.ts";

// ============================================================
// 回调类型（抽 alias 绕 registerTool(unknown) 的 TS2307 误报）
// ============================================================

/**
 * execute 回调的 params 类型（手写副本，因为 stub registerTool 是 unknown，
 * 无法从 SubagentParams schema 反向推断参数类型。与 old 实现一致）。
 */
interface SubagentExecuteParams {
  task?: string;
  agent?: string;
  wait?: boolean;
  backgroundId?: string;
  model?: string;
  thinkingLevel?: string;
  skillPath?: string;
  appendSystemPrompt?: string[];
  schema?: Record<string, unknown>;
  maxTurns?: number;
  graceTurns?: number;
}

type SubagentExecuteCb = (
  toolCallId: string,
  params: SubagentExecuteParams,
  signal: AbortSignal | undefined,
  onUpdate?: (partialResult: AgentToolResult<SubagentToolDetails>) => void,
  ctx?: ExtensionContext,
) => Promise<void>;

type SubagentRenderCallCb = (args: unknown, theme: Theme, ctx: RenderContext) => Component;

type SubagentRenderResultCb = (
  result: AgentToolResult<SubagentToolDetails>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  ctx: RenderContext,
) => Component;

// ============================================================
// Params schema
// ============================================================

export const SubagentParams = Type.Object({
  task: Type.Optional(Type.String({ description: "The task for the subagent. Required unless polling with backgroundId." })),
  agent: Type.Optional(Type.String({ description: 'Agent name. Defaults to "worker".' })),
  wait: Type.Optional(Type.Boolean({ description: "true=sync (default), false=background." })),
  backgroundId: Type.Optional(Type.String({ description: "Poll a prior background subagent." })),
  model: Type.Optional(Type.String({ description: '"provider/modelId" override.' })),
  thinkingLevel: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const)),
  skillPath: Type.Optional(Type.String()),
  appendSystemPrompt: Type.Optional(Type.Array(Type.String())),
  schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  maxTurns: Type.Optional(Type.Number()),
  graceTurns: Type.Optional(Type.Number()),
});

// ============================================================
// renderCall 预解析 helper
// ============================================================

/** 从 unknown args 安全提取 agent 名。 */
function extractAgentNameFromArgs(args: unknown): string {
  if (typeof args === "object" && args !== null && "agent" in args) {
    const v = (args as { agent: unknown }).agent;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "worker";
}

/** 从 unknown args 安全提取 model/thinkingLevel override（传给 resolveModel）。 */
function extractModelOverride(args: unknown): { model?: string; thinkingLevel?: string } | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const a = args as { model?: unknown; thinkingLevel?: unknown };
  const override: { model?: string; thinkingLevel?: string } = {};
  if (typeof a.model === "string" && a.model.length > 0) override.model = a.model;
  if (typeof a.thinkingLevel === "string" && a.thinkingLevel.length > 0) override.thinkingLevel = a.thinkingLevel;
  return Object.keys(override).length > 0 ? override : undefined;
}

// ============================================================
// 注册
// ============================================================

/** 注册 `subagent` 工具。由工厂调用。 */
export function registerSubagentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate a task to a specialized subagent (sync/background/poll).",
    executionMode: "sequential",
    parameters: SubagentParams,
    renderCall: subagentRenderCall,
    renderResult: subagentRenderResult,
    execute: executeSubagent,
  });
}

// ============================================================
// 回调实现（模块级 const）
// ============================================================

const subagentRenderCall: SubagentRenderCallCb = (args, theme, ctx) => {
  // 预解析 model（同步）：renderCall 在 execute 前调用，但 model 解析是同步的
  // （只读配置 + sessionState）。让标题行能显示 model/thinking，不必等 execute。
  // hub 未就绪（session 未 init）或解析失败时降级——只显示 agent 名。
  const agent = extractAgentNameFromArgs(args);
  const override = extractModelOverride(args);
  let resolved: { model: string; thinkingLevel?: string } | undefined;
  try {
    const hub = getHub();
    const r = hub?.resolveModel(agent, override);
    if (r) resolved = { model: r.model.id, thinkingLevel: r.thinkingLevel };
  } catch {
    // hub 未注册或 modelRegistry 未注入，降级
  }
  return renderSubagentCall(args, theme, ctx, resolved);
};

const subagentRenderResult: SubagentRenderResultCb = (result, options, theme, ctx) =>
  renderSubagentResult(result, options, theme, ctx);

/**
 * execute 实现。
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
 *   ║  rt = getRuntime() —— 未初始化 throw                             ║
 *   ║                                                                    ║
 *   ║  ── Mode 3: poll ──────────────────────────────────────────────  ║
 *   ║  if (params.backgroundId):                                       ║
 *   ║    query = rt.query(backgroundId)   ◄── store.snapshot + project ║
 *   ║    不存在 throw；running → 返回 running details                  ║
 *   ║    settled → 返回 project（顶层 turns/tokens，不钻 result）      ║
 *   ║    return { content, details }                                    ║
 *   ║                                                                    ║
 *   ║  ── task 必填校验 ───────────────────────────────────────────  ║
 *   ║  rt.assertAgentExists(params.agent)   ◄── fail-fast 未知 agent  ║
 *   ║                                                                    ║
 *   ║  ── 首次 category 确认拦截（仅 hasUI && !confirmed）─────────  ║
 *   ║  ctx.ui.custom(CategoryConfirmComponent)                          ║
 *   ║  cancelled → throw（不重试）                                      ║
 *   ║  rt.applyCategoryConfirm(result)                                  ║
 *   ║                                                                    ║
 *   ║  ── mode 判定 ─────────────────────────────────────────────  ║
 *   ║  params.wait > agent.defaultBackground > "sync"                   ║
 *   ║                                                                    ║
 *   ║  ── 预解析 model（仅显式 override 失败时 throw）───────────  ║
 *   ║  resolved = rt.resolveModelForAgent(agent, override)             ║
 *   ║  hasExplicitOverride && !resolved → throw                        ║
 *   ║                                                                    ║
 *   ║  ── 调 runtime.execute（统一入口）────────────────────────  ║
 *   ║  handle = await rt.execute({                                      ║
 *   ║    task, agent, mode, model, thinkingLevel,                       ║
 *   ║    skillPath, appendSystemPrompt, schema, maxTurns, graceTurns,   ║
 *   ║    signal,                                                        ║
 *   ║    onUpdate: (details) => onUpdate?.({ content, details }),       ║
 *   ║  })                                                                ║
 *   ║                                                                    ║
 *   ║  ── 返回 ─────────────────────────────────────────────────  ║
 *   ║  handle.mode==="background":                                      ║
 *   ║    返回 backgroundId（LLM 后续 poll）                             ║
 *   ║  handle.mode==="sync":                                            ║
 *   ║    details = project(handle.record)                               ║
 *   ║    resultText += worktree 变更 → merge 指令                       ║
 *   ║    return { content: resultText, details }                        ║
 *   ╚══════════════════════════════════════════════════════════════════╝
 */
const executeSubagent: SubagentExecuteCb = async (
  _toolCallId,
  params,
  signal,
  onUpdate,
  ctx,
) => {
  const hub = getHub();
  if (!hub) throw new Error("subagents runtime not initialized");

  // ── poll 路径 ──
  if (params.backgroundId) {
    const result = hub.query(params.backgroundId);
    if (!result) throw new Error(`No subagent record with id "${params.backgroundId}"`);
    const content = result.status === "running"
      ? [{ type: "text" as const, text: `Subagent ${result.id} is still running (${result.turns} turns).` }]
      : [{ type: "text" as const, text: result.result ?? `Subagent ${result.id} finished.` }];
    return { content, details: result } as unknown as void;
  }

  // ── task 必填 ──
  if (!params.task) throw new Error("task is required");

  // ── 首次 category 确认回调（仅 hasUI 时注入；headless 跳过，hub 内 ensureConfirmed 走 fallback）──
  const onConfirmCategory = buildConfirmCallback(ctx);

  // ── 调 hub.execute（mode 判定 + agent 校验 + 确认 + 执行全在 hub 内部）──
  const handle = await hub.execute({
    task: params.task,
    agent: params.agent,
    wait: params.wait,
    model: params.model,
    thinkingLevel: params.thinkingLevel as ExecuteOptions["thinkingLevel"],
    skillPath: params.skillPath,
    appendSystemPrompt: params.appendSystemPrompt,
    schema: params.schema,
    maxTurns: params.maxTurns,
    graceTurns: params.graceTurns,
    signal,
    onConfirmCategory,
    onUpdate: onUpdate
      ? (details) => {
          onUpdate({ content: [{ type: "text", text: details.result ?? "" }], details });
        }
      : undefined,
  });

  // ── 返回 ──
  if (handle.mode === "background") {
    return { content: [{ type: "text", text: `Background subagent started: ${handle.backgroundId}` }],
      details: { backgroundId: handle.backgroundId } } as unknown as void;
  }

  // sync: details 用 project 投影的 SubagentToolDetails（含 elapsedSeconds/currentActivity），
  //       而非 record snapshot（后者缺 TUI 渲染字段）。
  return { content: [{ type: "text", text: handle.record.result ?? "" }],
    details: handle.details } as unknown as void;
};

// ============================================================
// 首次 category 确认回调工厂
// ============================================================

/**
 * 构造 onConfirmCategory 回调。
 *
 * 仅当 ctx.hasUI 时返回可触发 overlay 的回调；否则返回 undefined（headless 跳过确认，
 * hub 内 ensureConfirmed 走 fallback 解析）。
 *
 * 回调内调 ctx.ui.custom<CategoryConfirmResult>(...)，弹出 CategoryConfirmComponent
 * 全屏 overlay。用户确认 → resolve CategoryConfirmResult；取消 → resolve cancelled。
 *
 * ctx.ui.custom 的 factory 第 4 参 done 由 Pi 框架提供，调它 resolve Promise。
 * 对照 pi-tui-development-guide.md §3.2 overlay 契约。
 */
function buildConfirmCallback(
  ctx: ExtensionContext | undefined,
): ((input: {
  categories: { name: string; model: string }[];
  currentModels: Record<string, { model: string; thinkingLevel?: string }>;
  available: unknown[];
}) => Promise<CategoryConfirmResult>) | undefined {
  if (!ctx || !ctx.hasUI) return undefined;

  return async (input) => {
    // available 是 unknown[]（ExecuteOptions 的宽松声明），转 ModelInfo[] 供组件消费
    const confirmInput: CategoryConfirmInput = {
      categories: input.categories,
      currentModels: input.currentModels,
      available: input.available as CategoryConfirmInput["available"],
    };

    const result = await ctx.ui.custom<CategoryConfirmResult>(
      (_tui, theme, keybindings, done) =>
        // Pi Theme 与 ThemeLike duck-type 兼容（均有 fg/bg/bold/underline），
        // 但 ctx.ui.custom 的 factory theme 参数是 Pi Theme 类型，
        // CategoryConfirmComponent 要 ThemeLike——结构兼容但 tsc 需显式标注
        new CategoryConfirmComponent(confirmInput, theme as unknown as ThemeLike, keybindings, done),
      // overlay:false —— 组件渲染在 TUI input 区（替换 editor），常驻接管键盘焦点。
      // 非 overlay：不开浮层，背景由 editorContainer 管，退出时 Pi 自动恢复 editor。
      // （对照 spec FR-2.0：input 区常驻组件，而非浮层 overlay）
      { overlay: false },
    );
    // ctx.ui.custom 在用户取消（Esc）时由组件调 done({action:"cancelled",...}) resolve，
    // 不会 reject。返回结果即为 CategoryConfirmResult。
    return result ?? { action: "cancelled", overrides: {} };
  };
}

// 保留未使用的类型别名（CategoryConfirmResult 在 execute 实现中使用）
export type { CategoryConfirmResult };
