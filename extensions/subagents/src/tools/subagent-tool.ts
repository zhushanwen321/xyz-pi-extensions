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
//   eventLog 不带 ⎿ 前缀，直接显示 label + icon。

import type { AgentToolResult, ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

import { getRuntime } from "../runtime.ts";
import { formatTokens } from "../tui/format.ts";
import { completeState, createExecutionState, executionStateToDetails, updateStateFromEvent } from "../state/execution-state.ts";
import { renderSubagentCall, SubagentResultComponent, type SubagentToolDetails } from "../tui/subagent-render.ts";
import type { AgentEvent } from "../types.ts";

/** ms to seconds conversion */
const MS_PER_SECOND = 1000;

// ============================================================
// FR-2.3: renderSubagentResult（事件驱动 seed-frame，无 setInterval）
// ============================================================

/**
 * FR-2.3: spinner 现由 seed-frame 驱动（subagent-render.ts 的 detailsSeed），
 * 不再需要定时器。context.state 保留为 Pi runtime 契约要求的占位。
 *
 * 之前用 setInterval(250ms) → context.invalidate() 驱动 spinner 换帧，导致：
 *  - Bug #4：250ms 重绘把 pi-tui viewport 强制拉回底部，用户无法滚动历史；
 *  - Bug #1：background 模式 timer 清理依赖 Pi 回调，组件滚出视区后仍空转。
 *  现在每次 onUpdate（真实事件）触发重绘时 seed 变化 → spinner 自然换帧，
 *  静默期冻结换取滚动体验。与 pi-subagents render.ts 的 runningGlyph 一致。
 */
export type SubagentToolState = Record<string, never>;

/** 占位 state（spinner 已改为 seed-frame，无需 frame/timer 字段）。 */
export function initialToolState(): SubagentToolState {
  return {};
}

/**
 * FR-2.3: renderResult——构造 SubagentResultComponent。
 * 不再管理任何定时器：spinner 由 detailsSeed(details) 在 render 时计算。
 */
export function renderSubagentResult(
  result: AgentToolResult<SubagentToolDetails>,
  options: { expanded: boolean; isPartial: boolean },
  theme: { bg(color: string, text: string): string; fg(color: string, text: string): string; bold(text: string): string },
  _context: { state: SubagentToolState; invalidate(): void },
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

  const comp = new SubagentResultComponent(details, theme);
  comp.setExpanded(options.expanded);
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
  model: Type.Optional(
    Type.String({
      description:
        'Explicit model override in "provider/modelId" format (e.g. "anthropic/claude-sonnet-4.5"). Takes precedence over the agent\'s configured default model.',
    }),
  ),
  thinkingLevel: Type.Optional(
    StringEnum(
      ["off", "minimal", "low", "medium", "high", "xhigh"] as const,
      {
        description:
          'Thinking level override. Only valid when the selected model supports reasoning. Must be one of: "off", "minimal", "low", "medium", "high", "xhigh".',
      },
    ),
  ),
  // Round 6 MF#2: expose skillPath/appendSystemPrompt/schema/maxTurns/graceTurns in schema
  // and pass them through to runAgent (silent loss if not exposed).
  skillPath: Type.Optional(
    Type.String({
      description:
        'Path to a skill directory or file. Injected via session resourceLoader.additionalSkillPaths.',
    }),
  ),
  appendSystemPrompt: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Additional system prompt fragments appended to the agent's system prompt. Use for project-specific context.",
    }),
  ),
  schema: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        'JSON Schema for structured output. The agent is steered to call the "structured-output" tool and the parsed result is exposed as details.parsedOutput.',
    }),
  ),
  maxTurns: Type.Optional(
    Type.Number({
      description:
        "Hard turn limit. When exceeded, the agent is steered to wrap up; after graceTurns more turns, the session is aborted.",
    }),
  ),
  graceTurns: Type.Optional(
    Type.Number({
      description:
        "Additional turns allowed after maxTurns before forced abort. Default 2.",
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
    // FR-2.4: 自己控制背景色（running/done/failed 不同 theme token），不使用 Pi 默认 Box。
    renderShell: "self",

    // ── renderCall：隐藏 Pi 默认标题行，标题由 renderResult 统一渲染进背景 block ──
    renderCall(
      _args: unknown,
      theme: Theme,
      context: { state: SubagentToolState; invalidate(): void },
    ) {
      return renderSubagentCall(_args, theme, context);
    },

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
      params: {
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
      },
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
            turns: status.turns ?? 0,
            totalTokens: status.totalTokens ?? 0,
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

      // FR-9.9: 校验 agent 名存在——不存在则 fail-fast，避免 unknown agent 静默运行为
      // 无 systemPrompt/toolFilter 的 generic agent（浪费 token + 无错误反馈）。
      rt.assertAgentExists(params.agent);

      // FR-O2.2: 判定 effective wait（显式 params.wait > agent.defaultBackground > 默认 sync）
      let effectiveWait: boolean;
      if (params.wait !== undefined) {
        effectiveWait = params.wait; // 显式优先
      } else {
        const agentConfig = rt.getAgentConfig(params.agent);
        effectiveWait = agentConfig?.defaultBackground ? false : true; // 配置其次，默认 sync
      }

      // Bug #2 fix: 始终解析 model（即使无显式 override），让 TUI 第 1 行能展示 provider/model。
      // resolveModelForAgent 在无 override 时走完整 fallback chain 解析 agent 默认 model
      // （见 runtime.ts:748-771 → model-resolver.ts:55-130）。
      // 仅在用户显式指定 model/thinkingLevel 且解析失败时抛错（避免浪费 token）；
      // 无 override 时解析失败则静默（resolved=undefined），runAgent 内部会用全局 fallback。
      // 复用单次解析结果给 sync/background 两条分支（避免双调用触发两次 discoverAll 漂移）。
      const hasExplicitOverride = !!(params.model || params.thinkingLevel);
      const resolved = rt.resolveModelForAgent?.(params.agent, {
        model: params.model,
        thinkingLevel: params.thinkingLevel,
      });
      if (hasExplicitOverride && !resolved) {
        throw new Error(
          `Failed to resolve model "${params.model ?? "<agent-default>"}"` +
            (params.thinkingLevel ? ` with thinkingLevel "${params.thinkingLevel}"` : "") +
            ` for agent "${params.agent ?? "default"}". ` +
            'Check the model string is in "provider/modelId" format and is available in your configured providers.',
        );
      }

      // ── Mode 2: background ──────────────────────────────
      if (effectiveWait === false) {
        const agentName = params.agent ?? "default";
        // bgId 在 startBackground 返回后赋值；onUpdate 闭包引用 bgId（异步触发时已赋值，避免 TDZ）
        let bgId = "";
        // Round 6 MF#1: pass through all fields to startBackground so the agent
        // runtime uses the same model/thinkingLevel/skill/schema as the pre-resolved
        // values reflected in details.model. Without this, runAgent re-resolves
        // the model and may pick a different one (details.model becomes "fake").
        const handle = rt.startBackground({
          task: params.task,
          agent: params.agent,
          model: params.model,
          thinkingLevel: params.thinkingLevel,
          skillPath: params.skillPath,
          appendSystemPrompt: params.appendSystemPrompt,
          schema: params.schema,
          maxTurns: params.maxTurns,
          graceTurns: params.graceTurns,
          signal,
          onUpdate: (bgDetails) => {
            // Wave 1: runtime 已通过 executionStateToDetails 投影出完整 SubagentToolDetails。
            // tool 层只需补充 backgroundId（runtime 不知道），直接透传其余字段。
            onUpdate?.({
              content: [{ type: "text" as const, text: `[subagent] ${bgDetails.turns} turns | ${formatTokens(bgDetails.totalTokens)} | ${bgDetails.elapsedSeconds}s` }],
              details: {
                ...bgDetails,
                backgroundId: bgId,
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
      // resolved 已在分支前提取并复用（见上方 model/thinkingLevel 预解析块）
      const resolvedModelId = resolved?.model.id;
      const resolvedThinkingLevel = resolved?.thinkingLevel;

      // Wave 2: 创建 AgentExecutionState（model 创建时必填），传给 runAgent。
      // runAgent 的 onEvent 拦截器更新 state（唯一 eventLog 构建点），
      // tool 层直接读 state 投影——消灭 toolState 双构建。
      const state = createExecutionState(`sync-${Date.now()}`, {
        agent: agentName,
        model: resolvedModelId ?? "unknown",
        thinkingLevel: resolvedThinkingLevel,
        startedAt: startTime,
      });

      const pushUpdate = () => {
        const details = executionStateToDetails(state);
        onUpdate?.({
          content: [{ type: "text" as const, text: `[subagent] ${details.turns} turns | ${formatTokens(details.totalTokens)} | ${details.elapsedSeconds}s` }],
          details: { ...details },
        });
      };

      const result = await rt.runAgent({
        task: params.task,
        agent: params.agent,
        model: params.model,
        thinkingLevel: params.thinkingLevel,
        // Round 6 MF#2: pass through newly-exposed fields to runAgent
        skillPath: params.skillPath,
        appendSystemPrompt: params.appendSystemPrompt,
        schema: params.schema,
        maxTurns: params.maxTurns,
        graceTurns: params.graceTurns,
        signal,
        // FR-O4.1: sync 高优先级（0），保证响应；background 传 1000（低），不抢占 sync
        priority: 0,
        // Wave 2: 传入 state——tool 的 onEvent 是唯一状态更新点（runtime 不再重复更新）
        state,
        onEvent: (event: AgentEvent) => {
          updateStateFromEvent(state, event);
          pushUpdate();
        },
      });

      if (!result.success) {
        // Round 3 MF#1: sync 用户取消（signal.aborted）不应被误报为 "failed"。
        // runtime runAgent 已正确把状态设为 "cancelled"，此处按 abort 信号选择
        // 最终状态，避免覆盖为 "failed"，与 background 路径及 history 记录一致。
        const failureStatus = signal?.aborted ? "cancelled" : "failed";
        completeState(state, result, failureStatus);
        pushUpdate();
        throw new Error(
          failureStatus === "cancelled"
            ? result.error ?? "subagent cancelled"
            : result.error ?? "subagent failed (no error detail)",
        );
      }

      // Wave 2: 确保 state 反映最终状态（runAgent 的真实实现已调 completeState，
      // 但 mock runAgent 不会——tool 层自包含，保证投影正确）
      if (state.status === "running") completeState(state, result, "done");
      const finalDetails = executionStateToDetails(state);
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

// Wave 5: buildSubagentRender / mapRenderStatus / formatProgressText 已删除。
// _render GUI 描述符被 TUI 渲染层从不读取（死代码），双状态枚举维护负担已消除。
// progress text 现在由 pushUpdate 内联生成（用 executionStateToDetails 投影）。
