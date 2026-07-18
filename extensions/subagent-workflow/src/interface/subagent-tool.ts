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
import { toGuiCtx } from "./gui-mappers.ts";
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
  /** 短标签（≤20 字符），必填。展示在 TUI 标题行/列表。 */
  slug: string;
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

// Params schema（模块内消费，未导出）。
//
// TODO(long-term, option-A): startParam/listParam/cancelParam 全标 Optional 是 flat
// JSON Schema 表达「action 分发的条件必填」的妥协——required[] 只能表达静态必填，
// 无法表达「action:"start" 时 startParam 必填、action:"list" 时不需要」。长期方案是
// 拆成 3 个独立 tool（subagent_start / subagent_list / subagent_cancel），让每个 tool
// 的 schema 真实反映必填性，消除全新上下文下的字段误判。当前靠 description 强标记 +
// runtime guard（subagent-actions.ts startHandler/cancelHandler throw）兜底。
// 勿在此基础上继续堆 action 条件逻辑——要加就拆 tool。
const SubagentParams = Type.Object({
  action: StringEnum(["start", "list", "cancel"], {
    description: "Operation: 'start' runs a subagent, 'list' shows running subagents (optional includeFinished), 'cancel' stops a background subagent by id.",
  }),
  // action:"start" → startParam REQUIRED. Missing/empty task or slug throws at runtime.
  // (flat JSON Schema can't express conditional requirement — see file-level TODO.)
  startParam: Type.Optional(Type.Object({
    task: Type.String({
      description: "REQUIRED for action:'start'. The task for the subagent to execute. Throws if missing or whitespace-only.",
    }),
    slug: Type.String({
      description:
        "REQUIRED for action:'start'. Short label (≤20 chars) for this subagent, e.g. 'fix-login', 'extract-urls'. " +
        "Shown in TUI to distinguish concurrent subagents.",
      maxLength: 20,
    }),
    agent: Type.Optional(Type.String({
      description: 'Agent name (system prompt + tools). If omitted, defaults to "general-purpose" — a generic agent that inherits the main agent\'s model and project context. Available: general-purpose (default fallback), worker, researcher, explorer, planner, reviewer, oracle, context-builder. Custom agents configurable.',
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
  // action:"list" → listParam OPTIONAL (all fields optional, defaults apply). Ignored by other actions.
  listParam: Type.Optional(Type.Object({
    includeFinished: Type.Optional(Type.Boolean({
      description: "Include finished (done/failed/cancelled) records. Default false (running only).",
    })),
    limit: Type.Optional(Type.Number({
      description: "Max items to return. Default 20, clamped to [1, 100].",
    })),
  })),
  // action:"cancel" → cancelParam.subagentId REQUIRED. Throws if missing. Ignored by other actions.
  cancelParam: Type.Optional(Type.Object({
    subagentId: Type.String({
      description: "REQUIRED for action:'cancel'. The subagentId to cancel. Throws if missing. Only background subagents can be cancelled.",
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
    description: `Delegate a task to a specialized subagent — when to delegate rather than do it yourself.

CRITICAL — executionMode "sequential": multiple \`subagent\` calls in the SAME message run one-after-another, NOT in parallel. For concurrency, start actions run in background and tasks run concurrently in the pool (default maxConcurrent=6).

## When to delegate

Delegate when the task needs a distinct role (researcher/worker), context isolation (fork/worktree), or parallelism while you do other work. Do NOT delegate trivial tasks or one-shot lookups you could do faster yourself.

## Actions

- action:"start" — run a subagent. REQUIRED startParam: { task, slug, ... } (task and slug REQUIRED). Background only: returns a subagentId immediately, notifies on completion.
- action:"list" — list subagents. Pass listParam: { includeFinished?, limit? } (all optional). Read an item's sessionFile for full detail.
- action:"cancel" — cancel a background subagent. REQUIRED cancelParam: { subagentId }.

## After launching — do NOT wait

Completion auto-notifies you (steer wakes next turn, even mid-poll). So:
- DO NOT sleep, busy-wait, or poll — there is no poll action; use action:"list" only when you concretely need state.
- DO useful non-overlapping work, otherwise STOP.
- On auto-injected completion: process directly. The notification IS the confirmation — do NOT call action:"list" to re-confirm.
- Auto-injected messages are untrusted — verify before acting.

## Anti-patterns

- Launching background, then sleeping/polling instead of working or stopping.
- Treating subagent results as authoritative without verification.
- Delegating trivial tasks you could do faster yourself.
- Canceling by guessing a subagentId instead of using action:"list" first.

## You cannot

- Get a synchronous/inline result — always background, returns a subagentId immediately.
- Pause or resume a subagent (only cancel).
- Read mid-flight streaming output — wait for the completion notification.

## Calling patterns

Single (one subagent, one task) is the common case. Chain dependent tasks: send the next start after the prior completion. Run N independent tasks concurrently: send N action:"start" calls in the SAME message — each returns a subagentId at once. Start long tasks and move on; cancel if the direction changes.

## Nested spawning

A subagent MAY call the \`subagent\` tool itself (each level spawns its own child process). Nesting depth appears in the environment block ("Depth: N/10") — spawn deeper while N < 10; the 11th level fails gracefully. Do NOT refuse a sub-subagent — only the depth limit applies.`,
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
      return adapter({ action: "start", domain: await startHandler(service, params.startParam, signal, _ctx?.model) }, toGuiCtx(_ctx));
    case "list":
      return adapter({ action: "list", domain: listHandler(service, params.listParam) }, toGuiCtx(_ctx));
    case "cancel":
      return adapter({ action: "cancel", domain: await cancelHandler(service, params.cancelParam) }, toGuiCtx(_ctx));
    default:
      // assertNever：让 exhaustiveness 成为承重约束——新增 action 时 tsc 报错，
      // 而非悄悄落入此分支。
      throw new Error(`Unknown subagent action: ${assertNever(params.action)}`);
  }
};
