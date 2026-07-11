// src/interface/subagent-tool.ts
//
// `subagent` LLM 工具。薄壳——参数解析 + 调 runtime.execute。
// 不创建 state、不节流 onUpdate、不持久化（全部在 runtime 层统一）。
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

import { getSubagentService } from "../execution/subagent-service.ts";
import type { SubagentToolResult } from "../execution/types.ts";
import { extractAgentName } from "./format.ts";
import { adapter, cancelHandler, listHandler, startHandler } from "./subagent-actions.ts";
import { type RenderContext,renderSubagentCall, renderSubagentResult } from "./tool-render.ts";

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
  model?: string;
  thinkingLevel?: string;
  skillPath?: string;
  appendSystemPrompt?: string[];
  schema?: Record<string, unknown>;
  maxTurns?: number;
  graceTurns?: number;
  fork?: boolean;
  worktree?: boolean;
  cwd?: string;
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
  // ctx 在 SDK 契约里必填；此处保持 optional 以兼容 onUpdate? 在前（TS 参数顺序约束），
  // 结构兼容——registerTool(unknown) 不校验，运行时 SDK 必传入。
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

/** Params schema（模块内消费，未导出）。 */
const SubagentParams = Type.Object({
  action: StringEnum(["start", "list", "cancel"], {
    description: "Operation: 'start' runs a subagent, 'list' shows running subagents (optional includeFinished), 'cancel' stops a background subagent by id.",
  }),
  startParam: Type.Optional(Type.Object({
    task: Type.String({
      description: "The task for the subagent to execute (required for action:'start'). Whitespace-only is rejected.",
    }),
    agent: Type.Optional(Type.String({
      description: 'Agent name (system prompt + tools). If omitted, defaults to "general-purpose" — a generic agent that inherits the main agent\'s model and project context. Available: general-purpose (default fallback), worker, researcher, scout, planner, reviewer, oracle, context-builder. Custom agents configurable.',
    })),
    model: Type.Optional(Type.String({
      description: 'Model override in "provider/modelId" format. Resolution order (top wins): (1) this param, (2) agent .md frontmatter model, (3) the main agent\'s current model (zero-config default). An explicit model (param or frontmatter) that is missing or unauthorized THROWS — there is no silent fallback to the main model. Omit this param to inherit the main model.',
    })),
    thinkingLevel: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const)),
    skillPath: Type.Optional(Type.String()),
    appendSystemPrompt: Type.Optional(Type.Array(Type.String())),
    schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    maxTurns: Type.Optional(Type.Number({
      description: "Turn limit. The subagent is terminated via SIGTERM after maxTurns turn_end events + graceTurns of slack. There is no graceful wrap-up message — the process is killed. 0 or omitted = unlimited.",
    })),
    graceTurns: Type.Optional(Type.Number({
      description: "Extra turns allowed after maxTurns is reached before SIGTERM (default 2). Only meaningful when maxTurns is set.",
    })),
    fork: Type.Optional(Type.Boolean({
      description: "Fork mode: inherit the parent's conversation context. When true, the subagent receives the parent's session file via --fork and builds a branched conversation (it sees prior turns/messages). The subagent still runs in a separate spawned child process (process isolation) — fork is about context inheritance, not process sharing. Use worktree:true (requires fork:true) for file-system isolation.",
    })),
    worktree: Type.Optional(Type.Boolean({
      description: "Worktree isolation (requires fork:true): run the subagent in a dedicated git worktree, providing file-system level isolation from the parent session. Prevents concurrent file-write conflicts between parent and subagent. Only takes effect when fork:true; passing worktree:true without fork:true throws an error.",
    })),
    cwd: Type.Optional(Type.String({
      description: 'Override the working directory for the subagent execution. Must be an absolute path. Defaults to the parent session\'s cwd.',
    })),
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
    subagentId: Type.String({
      description: "The subagentId to cancel (required for action:'cancel'). Only background subagents can be cancelled.",
    }),
  })),
});

// ============================================================
// renderCall 预解析 helper
// ============================================================

// extractAgentName 已上移到 ../tui/format.ts 共享（tool-render / subagent-tool 复用）。

/** exhaustiveness 承重 helper：default 分支把 action 收敛为 never，新增 action 时 tsc 报错。 */
function assertNever(value: never): string {
  return String(value);
}

/** unknown 是否为含 model/thinkingLevel 的对象（类型守卫，替代全可选结构 `as`）。 */
function isModelOverrideObj(a: unknown): a is { model?: unknown; thinkingLevel?: unknown } {
  return typeof a === "object" && a !== null;
}

/** unknown args 是否含 startParam（类型守卫，替代 `in` 后的 `as`）。 */
function hasStartParam(a: unknown): a is { startParam?: unknown } {
  return typeof a === "object" && a !== null && "startParam" in a;
}

/** 从 unknown args 安全提取 model/thinkingLevel override（传给 resolveModel）。 */
function extractModelOverride(args: unknown): { model?: string; thinkingLevel?: string } | undefined {
  if (!isModelOverrideObj(args)) return undefined;
  const override: { model?: string; thinkingLevel?: string } = {};
  if (typeof args.model === "string" && args.model.length > 0) override.model = args.model;
  if (typeof args.thinkingLevel === "string" && args.thinkingLevel.length > 0) override.thinkingLevel = args.thinkingLevel;
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

CRITICAL — this tool is registered with executionMode "sequential": multiple \`subagent\` calls in the SAME message run one-after-another, NOT in parallel. The first must finish before the next starts. To get real concurrency, all start actions run in background mode — background calls return immediately and the underlying tasks run concurrently in the pool (default maxConcurrent=6; extras queue).

## Actions

- action:"start" — run a subagent. Pass startParam: { task, agent?, ... }. The subagent always runs in background: it returns a subagentId immediately, runs detached, and keeps running even if you stop. On completion a message is auto-injected that triggers a new turn so you can process the result.
- action:"list" — list subagents. Pass listParam: { includeFinished?: boolean, limit?: number }. Default: running only, limit 20. Each item includes a sessionFile path — read it with the \`read\` tool for full detail (the jsonl is append-only, flushed in real time). Ignores startParam/cancelParam.
- action:"cancel" — cancel a background subagent. Pass cancelParam: { subagentId }. Only background subagents can be cancelled. Ignores startParam/listParam.

## After launching — do NOT wait

Completion auto-notifies you (a message is injected that wakes your next turn). So:
- DO NOT sleep, busy-wait, or poll in a loop after launching. There is no poll action — use action:"list" only when you concretely need the current state.
- DO useful non-overlapping work if you have any.
- Otherwise STOP. Stopping is correct — the completion notification will wake you. It is not giving up.

## Calling patterns

- single — one subagent for one task (the common case).
- chain — dependent steps where B needs A's output: send the next start only after A's completion notification.
- parallel / fan-out — N independent tasks concurrently: send N \`subagent\` calls with action:"start" in the SAME message. Each returns a subagentId at once; tasks run concurrently. Then do other work, or just stop.
- background — one long-running task you don't want to block on: action:"start", then move on. Cancel later with action:"cancel" if the direction is wrong.

## Anti-patterns

- Launching background, then sleeping/polling instead of working or stopping.

## Nested spawning

A subagent MAY itself call the \`subagent\` tool (nested delegation is supported; each level spawns its own child process). A subagent sees its nesting depth in the environment block ("Depth: N/10") — you may spawn deeper while N < 10. The 11th nesting level is refused with a clear "nesting depth 11 > 10" or "fork depth 10 >= 10" error and fails the subagent gracefully (does not crash the parent). Do NOT refuse to spawn a sub-subagent by assuming it is disallowed — it is not; only the depth limit applies.`,
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

// ponytail: renderCall 每次 TUI invalidate 都触发，同一解析错误会重复刷屏。
// 按错误消息去重（Set），session 内只报第一次。错误消息含 modelStr，足够区分。
const reportedRenderErrors = new Set<string>();

const subagentRenderCall: SubagentRenderCallCb = (args, theme, ctx) => {
  // 预解析 model（同步）：让标题行能显示 model/thinking，不必等 execute。
  // resolveModel 三层：override → agentConfig.model → 主 agent model（session 缓存）。
  // 主 agent model 由 ModelConfigService 缓存（session_start 注入，model_select 刷新），
  // 补偿 renderCall 的 ToolRenderContext 不含 model 的 SDK 限制。
  // service 未就绪 / 缓存为空 / 解析失败 → 降级不显示 model。
  const startParam = hasStartParam(args) ? args.startParam : undefined;
  const agent = extractAgentName(startParam);
  const override = extractModelOverride(startParam);
  let resolved: { model: string; thinkingLevel?: string } | undefined;
  try {
    const service = getSubagentService();
    const r = service?.resolveModel(agent, override);
    if (r) resolved = { model: `${r.model.provider}/${r.model.id}`, thinkingLevel: r.thinkingLevel };
  } catch (err) {
    // service 未注册 / modelRegistry 未注入 / 无可用 model → 降级不显示 model（renderCall 不应崩）。
    // 去重：同一 err.message 只 console.debug 一次，避免 TUI invalidate 反复刷屏。
    const msg = err instanceof Error ? err.message : String(err);
    if (!reportedRenderErrors.has(msg)) {
      reportedRenderErrors.add(msg);
      void err; // 显式确认忽略：renderCall 降级是设计意图，不阻断渲染
      console.debug("[subagents] renderCall model resolution failed, degrading:", err);
    }
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
 *   ║    "start"  → startHandler(service, params.startParam, signal) → 领域对象  ║
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
  _onUpdate,
  _ctx,
) => {
  // background 模式：execute 立即返回，detached 运行不向 tool 层回流 onUpdate
  //（完成由 notify 驱动新 turn）。onUpdate 参数保留以兼容 SDK 回调签名，但不消费。
  const service = getSubagentService();
  if (!service) throw new Error("subagents runtime not initialized");

  switch (params.action) {
    case "start":
      return adapter({ action: "start", domain: await startHandler(service, params.startParam, signal, _ctx?.model) }, _ctx);
    case "list":
      return adapter({ action: "list", domain: listHandler(service, params.listParam) }, _ctx);
    case "cancel":
      return adapter({ action: "cancel", domain: await cancelHandler(service, params.cancelParam) }, _ctx);
    default:
      // assertNever：让 exhaustiveness 成为承重约束——新增 action 时 tsc 报错，
      // 而非悄悄落入此分支。
      throw new Error(`Unknown subagent action: ${assertNever(params.action)}`);
  }
};
