// src/tools/subagent-tool.ts
//
// `subagent` LLM 工具。薄壳——参数解析 + 调 runtime.execute。
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

import { getSubagentService } from "../runtime/subagent-service.ts";
import { adapter, cancelHandler, listHandler, startHandler } from "./subagent-actions.ts";
import { extractAgentName } from "../tui/format.ts";
import { type RenderContext,renderSubagentCall, renderSubagentResult } from "../tui/tool-render.ts";
import type { SubagentToolResult } from "../types.ts";

// ============================================================
// 回调类型（抽 alias 绕 registerTool(unknown) 的 TS2307 误报）
// ============================================================

/**
 * execute 回调的 params 类型（手写副本——stub registerTool 是 unknown，
 * 无法从 SubagentParams schema 反向推断参数类型）。
 * action 与对应 param 不匹配时 handler 内 throw。
 */
interface StartParam {
  task: string;
  agent?: string;
  wait?: boolean;
  model?: string;
  thinkingLevel?: string;
  skillPath?: string;
  appendSystemPrompt?: string[];
  schema?: Record<string, unknown>;
  maxTurns?: number;
  graceTurns?: number;
}

interface ListParam {
  includeFinished?: boolean;
  limit?: number;
}

interface CancelParam {
  subagentId: string;
}

interface SubagentExecuteParams {
  action: "start" | "list" | "cancel";
  startParam?: StartParam;
  listParam?: ListParam;
  cancelParam?: CancelParam;
}

type SubagentExecuteCb = (
  toolCallId: string,
  params: SubagentExecuteParams,
  signal: AbortSignal | undefined,
  onUpdate?: (partialResult: AgentToolResult<SubagentToolResult>) => void,
  ctx?: ExtensionContext,
) => Promise<AgentToolResult<SubagentToolResult>>;

type SubagentRenderCallCb = (args: unknown, theme: Theme, ctx: RenderContext) => Component;

type SubagentRenderResultCb = (
  result: AgentToolResult<SubagentToolResult>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  ctx: RenderContext,
) => Component;

// ============================================================
// Params schema
// ============================================================

export const SubagentParams = Type.Object({
  action: StringEnum(["start", "list", "cancel"], {
    description: "Operation: 'start' runs a subagent, 'list' shows running subagents (optional includeFinished), 'cancel' stops a background subagent by id.",
  }),
  startParam: Type.Optional(Type.Object({
    task: Type.String({
      description: "The task for the subagent to execute (required for action:'start'). Whitespace-only is rejected.",
    }),
    agent: Type.Optional(Type.String({
      description: 'Agent name (system prompt + tools). Defaults to "worker". Available: worker, researcher, scout, planner, reviewer, oracle, context-builder. Custom agents configurable.',
    })),
    wait: Type.Optional(Type.Boolean({
      description: "Execution mode. true (default) = sync: blocks until done, returns result. false = background: returns a subagentId immediately; on completion a message auto-injects that triggers a new turn (no need to poll). Use false for parallel fan-out (multiple start actions with wait:false in one message run concurrently, default maxConcurrent=4) or long tasks.",
    })),
    model: Type.Optional(Type.String({
      description: 'Model override in "provider/modelId" format. If omitted, uses the agent\'s configured default.',
    })),
    thinkingLevel: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const)),
    skillPath: Type.Optional(Type.String()),
    appendSystemPrompt: Type.Optional(Type.Array(Type.String())),
    schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    maxTurns: Type.Optional(Type.Number()),
    graceTurns: Type.Optional(Type.Number()),
  })),
  listParam: Type.Optional(Type.Object({
    includeFinished: Type.Optional(Type.Boolean({
      description: "Include finished (done/failed/cancelled) records. Default false (running only).",
    })),
    limit: Type.Optional(Type.Number({
      description: "Max items to return. Default 20, clamped to [1, 100].",
    })),
  })),
  cancelParam: Type.Optional(Type.Object({
    subagentId: Type.Optional(Type.String({
      description: "The subagentId to cancel (required for action:'cancel'). Only background subagents can be cancelled.",
    })),
  })),
});

// ============================================================
// renderCall 预解析 helper
// ============================================================

// extractAgentName 已上移到 ../tui/format.ts 共享（tool-render / subagent-tool 复用）。

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
    description: `Delegate a task to a specialized subagent via an explicit action.

CRITICAL — this tool is registered with executionMode "sequential": multiple \`subagent\` calls in the SAME message run one-after-another, NOT in parallel. The first must finish before the next starts. To get real concurrency, use background mode (start with wait:false) — background calls return immediately and the underlying tasks run concurrently in the pool (default maxConcurrent=4; extras queue).

## Actions

- action:"start" — run a subagent. Pass startParam: { task, agent?, wait?, ... }.
  - sync (wait:true, default): blocks until the subagent finishes, returns its result. Use when the next step needs the result.
  - background (wait:false): returns a subagentId immediately; the subagent runs detached and keeps running even if you stop. On completion a message is auto-injected that triggers a new turn so you can process the result.
- action:"list" — list subagents. Pass listParam: { includeFinished?: boolean, limit?: number }. Default: running only, limit 20. Each item includes a sessionFile path — read it with the \`read\` tool for full detail (the jsonl is append-only, flushed in real time).
- action:"cancel" — cancel a background subagent. Pass cancelParam: { subagentId }. Only background subagents can be cancelled; sync subagents are cancelled via Esc in the chat.

## After launching background — do NOT wait

Completion auto-notifies you (a message is injected that wakes your next turn). So:
- DO NOT sleep, busy-wait, or poll in a loop after launching. There is no poll action — use action:"list" only when you concretely need the current state.
- DO useful non-overlapping work if you have any.
- Otherwise STOP. Stopping is correct — the completion notification will wake you. It is not giving up.

## Calling patterns

- single — one sync subagent for one task (the common case).
- chain — dependent steps where B needs A's output: sync calls across turns.
- parallel / fan-out — N independent tasks concurrently: send N \`subagent\` calls with action:"start" + wait:false in the SAME message. Each returns a subagentId at once; tasks run concurrently. Then do other work, or just stop.
- background — one long-running task you don't want to block on: action:"start" + wait:false, then move on. Cancel later with action:"cancel" if the direction is wrong.

## Anti-patterns

- Multiple sync (wait:true) calls in one message expecting parallelism → they serialize; a slow first call delays the rest and long chains may get interrupted.
- Launching background, then sleeping/polling instead of working or stopping.
- Using background for a result you need right now → use sync.`,
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
  // service 未就绪（session 未 init）或解析失败时降级——只显示 agent 名。
  // action 化后 agent/model 在 args.startParam 内层，先 unwrap。
  const startParam = (typeof args === "object" && args !== null && "startParam" in args
    ? (args as { startParam?: unknown }).startParam
    : undefined);
  const agent = extractAgentName(startParam);
  const override = extractModelOverride(startParam);
  let resolved: { model: string; thinkingLevel?: string } | undefined;
  try {
    const service = getSubagentService();
    const r = service?.resolveModel(agent, override);
    if (r) resolved = { model: `${r.model.provider}/${r.model.id}`, thinkingLevel: r.thinkingLevel };
  } catch {
    // service 未注册或 modelRegistry 未注入，降级
  }
  return renderSubagentCall(args, theme, ctx, resolved);
};

const subagentRenderResult: SubagentRenderResultCb = (result, options, theme, ctx) =>
  renderSubagentResult(result, options, theme, ctx);

/**
 * execute 实现（action 路由 + adapter）。
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
 *   ║  service = getSubagentService() —— 未初始化 throw                  ║
 *   ║                                                                    ║
 *   ║  switch(params.action):                                           ║
 *   ║    "start"  → startHandler(service, params.startParam, signal,    ║
 *   ║                onUpdate) → 领域对象                                 ║
 *   ║    "list"   → listHandler(service, params.listParam) → 领域对象    ║
 *   ║    "cancel" → cancelHandler(service, params.cancelParam) → 领域对象║
 *   ║                                                                    ║
 *   ║  result = adapter(action, 领域对象)                                ║
 *   ║  return { content: [{text: JSON.stringify(result)}], details: result }║
 *   ╚══════════════════════════════════════════════════════════════════╝
 *
 * handler 返回纯领域对象（不碰 {content, details}），adapter 唯一包装。
 * content（JSON 字符串）给 LLM，details（领域对象 + action）给 renderResult，同源。
 */
const executeSubagent: SubagentExecuteCb = async (
  _toolCallId,
  params,
  signal,
  onUpdate,
  _ctx,
) => {
  const service = getSubagentService();
  if (!service) throw new Error("subagents runtime not initialized");

  switch (params.action) {
    case "start":
      return adapter("start", await startHandler(service, params.startParam, signal, onUpdate));
    case "list":
      return adapter("list", listHandler(service, params.listParam));
    case "cancel":
      return adapter("cancel", await cancelHandler(service, params.cancelParam));
    default:
      throw new Error(`Unknown subagent action: ${String((params as { action?: unknown }).action)}`);
  }
};
