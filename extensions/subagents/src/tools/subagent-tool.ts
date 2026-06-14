// src/tools/subagent-tool.ts
//
// `subagent` LLM 工具：让父 agent 把任务委派给专门的子 agent。
// 支持三种模式：
//   1. 同步（默认）：await runAgent()，返回子 agent 的文本/artifacts
//   2. background（wait:false）：startBackground()，立即返回 backgroundId
//   3. 查询（backgroundId）：getBackground()，取后台任务结果
//
// 工具名 `subagent` 已在 EXCLUDED_TOOL_NAMES 预留（FR-6.2），子 agent 不会递归调用。
// 参考 tintinweb/pi-subagents 的 subagent tool 设计。
//
// 对话流渲染（FR-2/FR-3）：
//   renderResult 返回 SubagentResultComponent，以背景色 block 形式在对话流中展示：
//   - running 时：toolPendingBg（进度 + eventLog）
//   - done 时：toolSuccessBg（eventLog + result）
//   - failed 时：toolErrorBg（eventLog + error）
//   eventLog 不带 ├─ 前缀，直接显示 label + icon。

import type { AgentToolResult, ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { getRuntime } from "../runtime.ts";
import { updateWidgetFromEvent } from "../event-log-builder.ts";
import { formatTokens } from "../tui/format.ts";
import type { WidgetAgentState } from "../tui/agent-widget.ts";
import { SubagentResultComponent, type SubagentToolDetails } from "../tui/subagent-render.ts";
import type { AgentEvent, AgentEventLogEntry } from "../types.ts";

/** ms to seconds conversion */
const MS_PER_SECOND = 1000;

// ============================================================
// FR-2.3: spinner 定时器 state + renderSubagentResult
// ============================================================

/** FR-2.3: spinner 定时器 state（ToolDefinition 的 TState） */
export interface SubagentToolState {
  timer?: ReturnType<typeof setInterval>;
  frame: number;
}

/** 初始化 tool state（frame=0, 无 timer） */
export function initialToolState(): SubagentToolState {
  return { frame: 0 };
}

/** spinner 帧数（RUNNING_FRAMES.length，与 subagent-render.ts 一致） */
const SPINNER_FRAMES_COUNT = 10;
/** spinner 定时器间隔（ms） */
const SPINNER_INTERVAL_MS = 250;

/**
 * FR-2.3: renderResult 逻辑——管理 spinner 定时器生命周期。
 * running 时启动 setInterval(250ms) → context.invalidate()；done/failed 时 clearInterval。
 * 定时器存 context.state（pi-tui Component 无 destroy 钩子，state 是唯一销毁点）。
 *
 * ⚠️ context.state 由 Pi runtime 初始化为 `{}`（tool-execution.js rendererState = {}），
 * 首次渲染时 frame/timer 均为 undefined。必须在 running 分支入口确保 frame 初始化为 0，
 * 否则 `(undefined + 1) % 10 = NaN`，spinner 帧序列取 [NaN] 得到 undefined。
 *
 * ⚠️ 定时器清理前置条件：Pi runtime（tool-execution.js）不对 renderResult 返回的 Component
 * 调 dispose/destroy。定时器的清理**完全依赖** Pi 在 agent 状态变为 done/failed 后**再次调用**
 * renderResult（此时进入 else 分支 clearInterval）。sync 模式的 pushUpdate("done"/"failed")
 * 会触发 onUpdate → Pi 重渲染 → renderResult 再入；background 模式同理。
 * timer.unref() 保证不阻止进程退出，但运行期若 Pi 因组件隐藏/滚动/session 切换不再调
 * renderResult，250ms interval 会持续 invalidate 不可见组件（CPU 轻微浪费，非泄漏——
 * 进程退出时随 unref 清理）。
 */
export function renderSubagentResult(
  result: AgentToolResult<SubagentToolDetails>,
  options: { expanded: boolean; isPartial: boolean },
  theme: { bg(color: string, text: string): string; fg(color: string, text: string): string; bold(text: string): string },
  context: { state: SubagentToolState; invalidate(): void },
): SubagentResultComponent {
  const details = result.details;
  if (!details || typeof details.status !== "string") {
    // 防御：Pi 运行时理论上必传 details（SDK 契约 details: T 必选），
    // 但历史上有空对象传入的场景。结构检查 + fallback 避免崩溃。
    return new SubagentResultComponent(
      { eventLog: [], status: "done", agent: "default", turns: 0, totalTokens: 0, elapsedSeconds: 0 },
      theme,
    );
  }

  // 确保 state 字段初始化（Pi runtime 初始传 {}，frame/timer 为 undefined）
  if (context.state.frame === undefined) context.state.frame = 0;

  const comp = new SubagentResultComponent(details, theme);
  comp.setExpanded(options.expanded);

  if (details.status === "running") {
    if (!context.state.timer) {
      context.state.timer = setInterval(() => {
        context.state.frame = (context.state.frame + 1) % SPINNER_FRAMES_COUNT;
        comp.setSpinnerFrame(context.state.frame);
        context.invalidate();
      }, SPINNER_INTERVAL_MS);
      context.state.timer.unref?.();
    }
    comp.setSpinnerFrame(context.state.frame);
  } else {
    if (context.state.timer) {
      clearInterval(context.state.timer);
      context.state.timer = undefined;
    }
  }

  return comp;
}

// ============================================================
// Params schema
// ============================================================

const SubagentParams = Type.Object({
  task: Type.Optional(
    Type.String({
      description:
        "The task for the subagent to complete. Be specific and self-contained. Required unless polling with backgroundId.",
    }),
  ),
  agent: Type.Optional(
    Type.String({
      description:
        'Agent name (e.g. "worker", "reviewer", "researcher", "scout", "planner"). Defaults to "worker" (general coding agent).',
    }),
  ),
  wait: Type.Optional(
    Type.Boolean({
      description:
        "true = await the result synchronously (the default unless the agent is configured with defaultBackground). false = run in background and return a backgroundId immediately; a completion notification arrives automatically when done.",
    }),
  ),
  backgroundId: Type.Optional(
    Type.String({
      description:
        'If set, fetch the result of a prior background subagent by its id (returned from wait:false). Ignores task/agent/wait.',
    }),
  ),
});

// ============================================================
// Tool registration
// ============================================================

/**
 * 注册 `subagent` LLM 工具。
 * 由扩展工厂（src/index.ts）调用。
 */
export function registerSubagentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate a task to a specialized subagent running in an isolated in-process session with its own context. Supports synchronous (await result), background (fire-and-forget), and result polling.",
    promptSnippet: "Delegate a task to a subagent (sync/background)",
    promptGuidelines: [
      "Use for focused subtasks that benefit from a specialized agent and isolated context: multi-file code review, web research, codebase scouting, implementation planning.",
      "Pass wait:false for long-running tasks. After starting a background subagent, end your turn—a completion notification is injected into your next turn when it finishes (no need to poll).",
      "Do NOT run sleep loops or repeated polling calls just to wait for a background subagent.",
      "Use backgroundId to check status/result of a specific prior background subagent when needed.",
      "Do NOT delegate simple one-line fixes or questions you can answer yourself — delegation has overhead (new session, no inherited context).",
      "Do NOT delegate tasks that require your current conversation context — the subagent starts fresh and cannot see your chat history.",
      "Do NOT delegate tasks the user asked YOU to do directly — if the user says 'you do X', they expect you, not a subagent.",
      "Do NOT use this tool to avoid work you find tedious — if you have the tools and context, do it yourself.",
      "The subagent CANNOT modify your conversation context. Its text output and structured artifacts are the ONLY things returned to you. It cannot set your variables, call your tools, or continue your workflow.",
      "Example: delegate 'review the error handling in src/auth/' to reviewer, or 'research best practices for X' to researcher with wait:false.",
      "Counter-example: do NOT delegate 'fix the typo on line 42 of foo.ts' — do it directly.",
    ],
    executionMode: "sequential",
    parameters: SubagentParams,

    // ── renderResult：对话流背景色 block ──────────────────────
    renderResult(
      result: AgentToolResult<SubagentToolDetails>,
      options: { expanded: boolean; isPartial: boolean },
      theme: Theme,
      context: { state: SubagentToolState; invalidate(): void },
    ) {
      return renderSubagentResult(result, options, theme, context);
    },

    async execute(
      _toolCallId: string,
      params: { task?: string; agent?: string; wait?: boolean; backgroundId?: string },
      signal: AbortSignal | undefined,
      onUpdate?: (partialResult: AgentToolResult<SubagentToolDetails>) => void,
    ) {
      const rt = getRuntime();
      if (!rt) {
        throw new Error("SubagentRuntime not initialized (session_start not fired).");
      }

      // ── Mode 3: query background result ──────────────────
      if (params.backgroundId) {
        const status = rt.getBackground(params.backgroundId);
        if (!status) {
          throw new Error(`Background subagent "${params.backgroundId}" not found.`);
        }
        if (status.status === "running") {
          const details: SubagentToolDetails = {
            eventLog: status.eventLog ?? [],
            status: "running",
            agent: status.agent ?? "default",
            turns: 0,
            totalTokens: 0,
            elapsedSeconds: Math.round((Date.now() - status.startedAt) / MS_PER_SECOND),
          };
          return {
            content: [
              {
                type: "text" as const,
                text: `Background subagent ${status.id} is still running (started ${details.elapsedSeconds}s ago). Poll again later.`,
              },
            ],
            details,
          };
        }
        const details: SubagentToolDetails = {
          eventLog: status.eventLog ?? [],
          status: status.status === "done" ? "done" : "failed",
          agent: status.agent ?? "default",
          turns: status.result?.turns ?? 0,
          totalTokens: status.result?.usage
            ? status.result.usage.input + status.result.usage.output + status.result.usage.cacheRead + status.result.usage.cacheWrite
            : 0,
          elapsedSeconds: status.endedAt ? Math.round((status.endedAt - status.startedAt) / MS_PER_SECOND) : 0,
          result: status.result?.text,
          error: status.error,
        };
        const text = status.result?.text ?? status.error ?? "(no output)";
        return {
          content: [{ type: "text" as const, text }],
          details,
        };
      }

      // task required for sync/background modes
      if (!params.task) {
        throw new Error(
          'Parameter "task" is required unless polling with backgroundId. ' +
            'Provide a task description for the subagent to execute.',
        );
      }

      // FR-O2.2: 判定 effective wait（显式 params.wait > agent.defaultBackground > 默认 sync）
      let effectiveWait: boolean;
      if (params.wait !== undefined) {
        effectiveWait = params.wait; // 显式优先
      } else {
        const agentConfig = rt.getAgentConfig(params.agent);
        effectiveWait = agentConfig?.defaultBackground ? false : true; // 配置其次，默认 sync
      }

      // ── Mode 2: background ──────────────────────────────
      if (effectiveWait === false) {
        const agentName = params.agent ?? "default";
        const resolved = rt.resolveModelForAgent?.(params.agent);
        // bgId 在 startBackground 返回后赋值；onUpdate 闭包引用 bgId（异步触发时已赋值，避免 TDZ）
        let bgId = "";
        const handle = rt.startBackground({
          task: params.task,
          agent: params.agent,
          signal,
          onUpdate: (bgDetails) => {
            onUpdate?.({
              content: [{ type: "text" as const, text: `[subagent] ${bgDetails.turns} turns | ${bgDetails.totalTokens} tokens | ${bgDetails.elapsedSeconds}s` }],
              details: {
                eventLog: bgDetails.eventLog,
                status: bgDetails.status,
                agent: agentName,
                turns: bgDetails.turns,
                totalTokens: bgDetails.totalTokens,
                elapsedSeconds: bgDetails.elapsedSeconds,
                backgroundId: bgId,
                model: resolved?.model.id,
                thinkingLevel: resolved?.thinkingLevel,
              },
            });
          },
        });
        bgId = handle.id;
        const details: SubagentToolDetails = {
          eventLog: [],
          status: "running",
          agent: agentName,
          turns: 0,
          totalTokens: 0,
          elapsedSeconds: 0,
          backgroundId: handle.id,
          model: resolved?.model.id,
          thinkingLevel: resolved?.thinkingLevel,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Started background subagent ${handle.id}. Call this tool again with backgroundId="${handle.id}" to check its result.`,
            },
          ],
          details,
        };
      }

      // ── Mode 1: sync ────────────────────────────────────
      const startTime = Date.now();
      const agentName = params.agent ?? "default";
      // FR-1.2: 解析 model/thinkingLevel（resolveModelForAgent 在任务 5 实现）
      const resolved = rt.resolveModelForAgent?.(params.agent);
      const resolvedModelId = resolved?.model.id;
      const resolvedThinkingLevel = resolved?.thinkingLevel;

      // FR-1.3: 复用 updateWidgetFromEvent 统一 eventLog 构建（含 text_output/thinking 切片），
      // 与 background 模式共享同一套逻辑，保证 sync/background 对话流 block 视觉一致（spec FR-2.1）。
      const toolState: WidgetAgentState = {
        id: "sync",
        agent: agentName,
        status: "running",
        eventLog: [],
      };

      const buildDetails = (status: SubagentToolDetails["status"]): SubagentToolDetails => ({
        eventLog: [...(toolState.eventLog ?? [])],
        status,
        agent: agentName,
        turns: toolState.turns ?? 0,
        totalTokens: toolState.totalTokens ?? 0,
        elapsedSeconds: Math.floor((Date.now() - startTime) / MS_PER_SECOND),
        model: resolvedModelId,
        thinkingLevel: resolvedThinkingLevel,
      });

      const pushUpdate = (status: SubagentToolDetails["status"]) => {
        onUpdate?.({
          content: [{ type: "text" as const, text: formatProgressText(toolState.eventLog ?? [], toolState.turns ?? 0, toolState.totalTokens ?? 0, startTime) }],
          details: buildDetails(status),
        });
      };

      const result = await rt.runAgent({
        task: params.task,
        agent: params.agent,
        signal,
        // FR-O4.1: sync 高优先级（0），保证响应；background 传 1000（低），不抢占 sync
        priority: 0,
        onEvent: (event: AgentEvent) => {
          // FR-1.3: 统一委托 updateWidgetFromEvent（处理 tool_start/end、text_output/thinking 切片、
          // turn_end summary、message_end token 累加、ring buffer 淘汰）
          updateWidgetFromEvent(toolState, event, startTime);
          // Push live update
          pushUpdate("running");
        },
      });

      if (!result.success) {
        pushUpdate("failed");
        throw new Error(result.error ?? "subagent failed (no error detail)");
      }

      const finalDetails = buildDetails("done");
      finalDetails.result = result.text;
      // V4：worktree 隔离执行有变更时，向 LLM 追加 merge 指令（分支名 + 合并命令）
      let resultText = result.text;
      if (result.worktree?.hasChanges && result.worktree.branch) {
        const branch = result.worktree.branch;
        resultText =
          resultText +
          `\n\n---\nChanges saved to branch \`${branch}\`. Merge with: \`git merge ${branch}\``;
      }
      return {
        content: [{ type: "text" as const, text: resultText }],
        details: finalDetails,
      };
    },
  });
}

// ============================================================
// Helpers
// ============================================================

/** Build progress text for the model (content field) */
function formatProgressText(
  eventLog: AgentEventLogEntry[],
  turns: number,
  totalTokens: number,
  startTime: number,
): string {
  const elapsed = Math.floor((Date.now() - startTime) / MS_PER_SECOND);
  const tokenStr = formatTokens(totalTokens);
  const lines = [`[subagent] ${turns} turns | ${tokenStr} tokens | ${elapsed}s`];
  // Show last 3 events for context
  const recent = eventLog.slice(-3);
  for (const entry of recent) {
    lines.push(`  ${entry.label}`);
  }
  return lines.join("\n");
}
