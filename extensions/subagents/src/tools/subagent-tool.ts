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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { getRuntime } from "../runtime.ts";

/** ms to seconds conversion */
const MS_PER_SECOND = 1000;

/** 工具参数 schema（TypeBox） */
const SubagentParams = Type.Object({
  task: Type.String({
    description: "The task for the subagent to complete. Be specific and self-contained.",
  }),
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

/**
 * 注册 `subagent` LLM 工具。
 * 由扩展工厂（src/index.ts）调用。
 */
export function registerSubagentTool(pi: ExtensionAPI): void {
  // Cast: the tool shape is correct, but the subagents SDK type stub differs from
  // the real SDK types resolved when workflow compiles this source. Casting avoids
  // cross-tsconfig ToolDefinition generic inference mismatch.
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate a task to a specialized subagent running in an isolated in-process session with its own context. Supports synchronous (await result), background (fire-and-forget), and result polling.",
    promptSnippet: "Delegate a task to a subagent (sync/background)",
    promptGuidelines: [
      "Use for focused subtasks: code review, research, codebase scouting, planning.",
      "The subagent runs in its own session — it does NOT inherit your conversation context.",
      "Pass wait:false for long-running tasks you don't need immediately; poll with backgroundId later.",
      "The tool returns text by default; for structured results (issues list, findings), the structured details are in the response.",
    ],
    executionMode: "sequential",
    parameters: SubagentParams,

    async execute(
      _toolCallId: string,
      params: { task: string; agent?: string; wait?: boolean; backgroundId?: string },
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown,
    ) {
      const rt = getRuntime();
      if (!rt) {
        throw new Error("SubagentRuntime not initialized (session_start not fired).");
      }

      // 模式 3: 查询 background 结果
      if (params.backgroundId) {
        const status = rt.getBackground(params.backgroundId);
        if (!status) {
          throw new Error(`Background subagent "${params.backgroundId}" not found.`);
        }
        if (status.status === "running") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Background subagent ${status.id} is still running (started ${Math.round((Date.now() - status.startedAt) / MS_PER_SECOND)}s ago). Poll again later.`,
              },
            ],
            details: { backgroundId: status.id, status: status.status },
          };
        }
        const text = status.result?.text ?? status.error ?? "(no output)";
        return {
          content: [{ type: "text" as const, text }],
          details: {
            backgroundId: status.id,
            status: status.status,
            artifacts: status.result?.parsedOutput,
            sessionId: status.result?.sessionId,
          },
        };
      }

      // 模式 2: background（wait:false）
      if (params.wait === false) {
        const handle = rt.startBackground({
          task: params.task,
          agent: params.agent,
          signal,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Started background subagent ${handle.id}. Call this tool again with backgroundId="${handle.id}" to check its result.`,
            },
          ],
          details: { backgroundId: handle.id, status: handle.status },
        };
      }

      // 模式 1: 同步（默认）
      const result = await rt.runAgent({
        task: params.task,
        agent: params.agent,
        signal,
      });
      if (!result.success) {
        throw new Error(result.error ?? "subagent failed (no error detail)");
      }
      return {
        content: [{ type: "text" as const, text: result.text }],
        details: {
          artifacts: result.parsedOutput,
          usage: result.usage,
          turns: result.turns,
          sessionId: result.sessionId,
        },
      };
    },
  } as never);
}
