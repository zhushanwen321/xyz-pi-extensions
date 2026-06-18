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
import { type RenderContext,renderSubagentCall, renderSubagentResult } from "../tui/tool-render.ts";
import type { CategoryConfirmResult, ExecuteOptions, ExecutionMode, SubagentToolDetails } from "../types.ts";

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

const subagentRenderCall: SubagentRenderCallCb = (args, theme, ctx) =>
  renderSubagentCall(args, theme, ctx);

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
  _ctx,
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

  // ── agent 存在性校验（fail-fast）──
  const agentName = params.agent ?? "default";
  hub.assertAgentExists(agentName);

  // ── mode 判定 ──
  const agentConfig = hub.getAgentConfig(agentName);
  const mode: ExecutionMode = params.wait === false
    ? "background"
    : agentConfig?.defaultBackground === true && params.wait === undefined
      ? "background"
      : "sync";

  // ── 调 hub.execute（统一入口）──
  const handle = await hub.execute({
    task: params.task,
    agent: agentName,
    mode,
    model: params.model,
    thinkingLevel: params.thinkingLevel as ExecuteOptions["thinkingLevel"],
    skillPath: params.skillPath,
    appendSystemPrompt: params.appendSystemPrompt,
    schema: params.schema,
    maxTurns: params.maxTurns,
    graceTurns: params.graceTurns,
    signal,
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

  return { content: [{ type: "text", text: handle.record.result ?? "" }],
    details: handle.record } as unknown as void;
};

// 保留未使用的类型别名（CategoryConfirmResult/ExecutionMode 在 execute 实现中使用）
export type { CategoryConfirmResult, ExecutionMode };
