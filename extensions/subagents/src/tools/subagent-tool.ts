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
import { extractLabelFromArgs } from "../tui/format.ts";
import { SubagentResultComponent,type SubagentToolDetails } from "../tui/subagent-render.ts";
import type { AgentEvent, AgentEventLogEntry } from "../types.ts";
import { MAX_EVENT_LOG_ENTRIES, TURN_SUMMARY_MAX } from "../types.ts";

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
 */
export function renderSubagentResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean },
  theme: { bg(color: string, text: string): string; fg(color: string, text: string): string; bold(text: string): string },
  context: { state: SubagentToolState; invalidate(): void },
): SubagentResultComponent {
  const details = result.details as SubagentToolDetails | undefined;
  if (!details) {
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
        "true (default) = await the result synchronously. false = run in background and return a backgroundId immediately (use backgroundId to check later).",
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
      "Pass wait:false for long-running tasks you don't need immediately; poll with backgroundId later.",
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

      // ── Mode 2: background ──────────────────────────────
      if (params.wait === false) {
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

      // 维护 eventLog（ring buffer），onEachEvent 时推送给 onUpdate
      const eventLog: AgentEventLogEntry[] = [];
      let turns = 0;
      let totalTokens = 0;
      let currentTurnText = "";

      const buildDetails = (status: SubagentToolDetails["status"]): SubagentToolDetails => ({
        eventLog: [...eventLog],
        status,
        agent: agentName,
        turns,
        totalTokens,
        elapsedSeconds: Math.floor((Date.now() - startTime) / MS_PER_SECOND),
        model: resolvedModelId,
        thinkingLevel: resolvedThinkingLevel,
      });

      const pushUpdate = (status: SubagentToolDetails["status"]) => {
        onUpdate?.({
          content: [{ type: "text" as const, text: formatProgressText(eventLog, turns, totalTokens, startTime) }],
          details: buildDetails(status),
        });
      };

      const result = await rt.runAgent({
        task: params.task,
        agent: params.agent,
        signal,
        onEvent: (event: AgentEvent) => {
          switch (event.type) {
            case "tool_start": {
              const label = extractLabelFromArgs(event.toolName, (event as { args?: unknown }).args);
              eventLog.push({ type: "tool_start", label, ts: Date.now(), status: "running" });
              break;
            }
            case "tool_end": {
              const label = extractLabelFromArgs(event.toolName, (event as { args?: unknown }).args);
              eventLog.push({ type: "tool_end", label, ts: Date.now(), status: event.isError ? "failed" : "done" });
              break;
            }
            case "text_delta": {
              currentTurnText += event.delta;
              break;
            }
            case "turn_end": {
              const summary = currentTurnText.slice(0, TURN_SUMMARY_MAX);
              eventLog.push({ type: "turn_end", label: summary, ts: Date.now() });
              currentTurnText = "";
              turns++;
              break;
            }
            case "message_end": {
              if (event.usage) {
                totalTokens += event.usage.input + event.usage.output + event.usage.cacheRead + event.usage.cacheWrite;
              }
              break;
            }
          }
          // Ring buffer
          while (eventLog.length > MAX_EVENT_LOG_ENTRIES) eventLog.shift();
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
  const tokenStr = totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : `${totalTokens}`;
  const lines = [`[subagent] ${turns} turns | ${tokenStr} tokens | ${elapsed}s`];
  // Show last 3 events for context
  const recent = eventLog.slice(-3);
  for (const entry of recent) {
    lines.push(`  ${entry.label}`);
  }
  return lines.join("\n");
}
