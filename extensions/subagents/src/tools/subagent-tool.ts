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
import { extractAgentName } from "../tui/format.ts";
import { type RenderContext,renderSubagentCall, renderSubagentResult } from "../tui/tool-render.ts";
import type { SubagentToolDetails } from "../types.ts";

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
) => Promise<AgentToolResult<SubagentToolDetails>>;

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
  task: Type.Optional(Type.String({
    description: "The task for the subagent to execute. Required to start a new subagent. Omit only when polling an existing background subagent (use backgroundId instead).",
  })),
  agent: Type.Optional(Type.String({
    description: 'Agent name (defines system prompt + tools). Defaults to "worker". Available agents: worker (general), researcher (read-only exploration), scout, planner, reviewer, oracle, context-builder. Custom agents can be defined in config.',
  })),
  wait: Type.Optional(Type.Boolean({
    description: "Execution mode. true (default) = sync: blocks until the subagent finishes, returns its result directly. false = background: returns a backgroundId immediately while the subagent runs detached; on completion a message is auto-injected that triggers a new turn so you can process the result — no need to sleep/poll. Use false for parallel fan-out (multiple wait:false calls in one message run concurrently in the pool, default maxConcurrent=4) or for long tasks you don't want to block on.",
  })),
  backgroundId: Type.Optional(Type.String({
    description: "Poll an existing background subagent by its id. The id is returned when you start a subagent with wait:false. Returns current status (running/done/failed) and result if finished. Do NOT pass this when starting a new task — it is for checking progress of a previously started background subagent only.",
  })),
  model: Type.Optional(Type.String({
    description: 'Model override in "provider/modelId" format (e.g. "anthropic/claude-sonnet-4.5"). If omitted, uses the agent\'s configured default model.',
  })),
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
    description: `Delegate a task to a specialized subagent.

CRITICAL — this tool is registered with executionMode "sequential": multiple \`subagent\` calls in the SAME message run one-after-another, NOT in parallel. The first must finish before the next starts. To get real concurrency, use background mode (wait:false) — background calls return immediately and the underlying tasks run concurrently in the pool (default maxConcurrent=4; extras queue).

## Modes

- sync (wait:true, default): blocks until the subagent finishes, returns its result. Use when the next step needs the result.
- background (wait:false): returns a backgroundId immediately; the subagent runs detached and keeps running even if you stop. On completion a message is auto-injected into the conversation that triggers a new turn so you can process the result.

## Calling patterns

- single — one sync subagent for one task (the common case).
- chain — dependent steps where B needs A's output: sync calls across turns (A's result informs B's prompt). Sequential by nature.
- parallel / fan-out — N independent tasks running concurrently: send N \`subagent\` calls with wait:false in the SAME message. Each returns a backgroundId at once; tasks run concurrently. Then do other work, or just stop.
- background — one long-running task you don't want to block on: wait:false, then move on.

## After launching background — do NOT wait

Completion auto-notifies you (a message is injected that wakes your next turn). So:
- DO NOT sleep, busy-wait, or poll in a loop after launching.
- DO useful non-overlapping work if you have any.
- Otherwise STOP. Stopping is correct — the completion notification will wake you. It is not giving up.

## Polling (backgroundId)

Poll only for a concrete reason (e.g. user asks "is it done yet?"). Reflexive polling right after launch is an anti-pattern — the completion notification already covers it.

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
  const agent = extractAgentName(args);
  const override = extractModelOverride(args);
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
  const service = getSubagentService();
  if (!service) throw new Error("subagents runtime not initialized");

  // ── poll 路径 ──
  if (params.backgroundId) {
    const result = service.query(params.backgroundId);
    if (!result) throw new Error(`No subagent record with id "${params.backgroundId}"`);
    // 按 status 分支：done→result；failed/cancelled→暴露 error（不掩盖失败，M5 修复）
    const text = result.status === "running"
      ? `Subagent ${result.id} is still running (${result.turns} turns).`
      : result.status === "done"
        ? (result.result ?? `Subagent ${result.id} finished.`)
        : `Subagent ${result.id} ${result.status}${result.error ? `: ${result.error}` : ""}.`;
    const content = [{ type: "text" as const, text }];
    return { content, details: result };
  }

  // ── task 必填 ──
  if (!params.task) throw new Error("task is required");

  // ── 调 service.execute（mode 判定 + agent 校验 + 执行全在 service 内部）──
  // D-1：取消首次确认拦截——不再注入 onConfirmCategory。
  const handle = await service.execute({
    task: params.task,
    agent: params.agent,
    wait: params.wait,
    model: params.model,
    thinkingLevel: params.thinkingLevel,
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
    // background：立即返回 backgroundId + 完整 details（status=running），
    // 让 tool block 能正常渲染 running 态（而非 "did not produce details"）。
    // 后台进度靠 progress widget（execute return 后 tool block 无法继续更新）。
    return { content: [{ type: "text", text: `Background subagent started: ${handle.backgroundId}` }],
      details: handle.details };
  }

  // sync: details 用 project 投影的 SubagentToolDetails（含 elapsedSeconds/currentActivity），
  //       而非 record snapshot（后者缺 TUI 渲染字段）。
  // schema 模式：优先输出 parsedOutput 的 JSON（调用方期望结构化数据，非 agent 文本）。
  // 失败/取消时 record.result 为空字符串，但 error 只进 details.error ——
  // 父 agent 只读 content 会误判「成功但无返回值」。这里与 poll 路径对齐：
  // 把 error 拼进 content，保证失败「出声」（项目「错误要出声」约定）。
  const syncText = handle.details.parsedOutput !== undefined
    ? JSON.stringify(handle.details.parsedOutput)
    : (handle.record.result
      || (handle.details.error ? `Subagent failed: ${handle.details.error}` : "Subagent failed."));
  return { content: [{ type: "text", text: syncText }],
    details: handle.details };
};
