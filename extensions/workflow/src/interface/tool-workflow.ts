/**
 * Workflow Extension — workflow tool（7 actions，FR-5 tool 收口）。
 *
 * 合并原 tool-workflow.ts + tool-workflow-run.ts 为单 tool。
 *
 * Actions:
 * - run: registry.get → requiresConfirmation → RPC 降级确认 → recordApproval → runWorkflow
 * - status: 列出 runs（deps.runs）
 * - pause: 调 pauseRun
 * - resume: 调 resumeRun
 * - abort: 调 abortRun
 * - retry-node: 调 retryNode
 * - skip-node: 调 skipNode
 *
 * **restart 不包含**（D-9 废弃）。
 *
 * 层归属：Interface。依赖 Pi SDK + Engine lifecycle/node-ops/launcher + helpers。
 *
 * 参考：domain-models.md §FR-5（tool 收口 4→2）。
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "typebox";

import type { LauncherDeps } from "../engine/launcher.js";
import { abortRun, pauseRun, resumeRun, runWorkflow } from "../engine/lifecycle.js";
import type { WorkflowRun } from "../engine/models/workflow-run.js";
import { retryNode, skipNode } from "../engine/node-ops.js";
import { recordApproval, requiresConfirmation } from "./helpers.js";
import {
  acquireReentryGuard,
  REENTRY_BUSY_MESSAGE,
  type ReentryGuardRef,
  releaseReentryGuard,
} from "./reentry-guard.js";
import { formatElapsed, renderTextFallback } from "./views/format.js";

// ── Parameter schema ─────────────────────────────────────────

const WorkflowParams = Type.Object({
  action: StringEnum(
    ["run", "status", "pause", "resume", "abort", "retry-node", "skip-node"] as const,
    { description: "Workflow action to execute" },
  ),
  name: Type.Optional(
    Type.String({ description: "Workflow name (run action)" }),
  ),
  runId: Type.Optional(
    Type.String({ description: "Workflow run ID (pause/resume/abort/retry-node/skip-node)" }),
  ),
  callId: Type.Optional(
    Type.Number({ description: "Agent call ID (retry-node/skip-node)" }),
  ),
  args: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Arguments passed to workflow as key-value pairs (run action)",
    }),
  ),
  tokens: Type.Optional(Type.Number({ description: "Maximum token budget (run action)" })),
  time: Type.Optional(Type.Number({ description: "Maximum time budget in ms (run action)" })),
  error: Type.Optional(
    Type.String({ description: "Error/reason message (optional, used with abort)" }),
  ),
});

type WorkflowToolParams = Static<typeof WorkflowParams>;

// ── Constants ────────────────────────────────────────────────

/** runId 截断长度（显示用）。 */
const RUNID_SHORT = 8;

// ── Types ────────────────────────────────────────────────────

interface RunSummary {
  runId: string;
  name: string;
  status: string;
  reason?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

// ── Tool result types ──

/**
 * Discriminated union of `workflow` tool `details` payloads.
 *
 * Discriminant: `action`. Each action's details shape is explicitly typed so
 * downstream consumers (GUI task-list renderer, structured-output) can narrow
 * without unsafe casts.
 */
export type WorkflowToolDetails =
  | { action: "run"; runId: string; status: "running" | "not_found" | "declined"; name: string }
  | { action: "status"; runs: RunSummary[] }
  | { action: "pause" | "resume" | "abort"; runId: string; status: string; reason?: string }
  | { action: "retry-node" | "skip-node"; runId: string; callId: number };

/** Result returned by the `workflow` tool's execute. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: WorkflowToolDetails | undefined;
  isError?: boolean;
}

// ── Tool registration ────────────────────────────────────────

/**
 * 注册 workflow tool（7 actions）。
 *
 * @param pi ExtensionAPI
 * @param deps LauncherDeps（LifecycleDeps + registry）
 * @param sessionApprovals 本 session 已批准的脚本名集合（requiresConfirmation 用）
 * @param reentryRef 共享 reentry guard（与 workflow-script tool 共用）
 */
export function registerWorkflowTool(
  pi: ExtensionAPI,
  deps: LauncherDeps,
  sessionApprovals: Set<string>,
  reentryRef: ReentryGuardRef,
): void {
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Execute and control workflows: run (start), status, pause, resume, abort, " +
      "retry-node (re-run a failed agent call to refresh its trace; does NOT resume the " +
      "workflow script or change its output — see promptGuidelines), skip-node (mark a call as skipped).\n" +
      "Replaces workflow + workflow-run tools.",
    promptSnippet: "Run, pause, resume, abort, or check workflow status",
    promptGuidelines: [
      "PRIORITY: When user says 'workflow', 'run workflow', try run action FIRST.",
      "run: discover by name/description, confirm with user (tmp or unapproved), then start in background.",
      "Do NOT poll status after starting — results appear automatically via notifyDone.",
      "retry-node/skip-node: for specific failed agent calls (requires runId + callId). " +
      "retry-node only re-runs the call and refreshes the trace — the workflow script has " +
      "already moved past the failed call, so the new result does NOT feed back into the " +
      "script flow. Use retry-node for diagnostics, not to resume the workflow.",
    ],
    parameters: WorkflowParams,

    async execute(
      _toolCallId: string,
      params: WorkflowToolParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<ToolResult> {
 // P1-2: Honor abort signal up-front
      if (signal?.aborted) {
        return textResult("Operation aborted before start", true);
      }
 // P1-6: Reentry guard
      if (!acquireReentryGuard(reentryRef)) {
        return textResult(REENTRY_BUSY_MESSAGE, true);
      }
      try {
        switch (params.action) {
          case "run":
            return await actionRun(pi, params, deps, sessionApprovals, signal, ctx);
          case "status":
            return actionStatus(deps);
          case "pause":
            return await actionLifecycle("pause", params, deps);
          case "resume":
            return await actionLifecycle("resume", params, deps);
          case "abort":
            return await actionLifecycle("abort", params, deps);
          case "retry-node":
            return await actionRetryNode(params, deps);
          case "skip-node":
            return await actionSkipNode(params, deps);
          default:
            return textResult(`Unknown action: ${String(params.action)}`, true);
        }
      } finally {
        releaseReentryGuard(reentryRef);
      }
    },

    renderCall(args: Record<string, unknown>, theme: Theme, _context?: unknown) {
      const action = String(args.action ?? "");
      const name = args.name ? ` ${String(args.name)}` : "";
      const runId = args.runId ? ` ${String(args.runId).slice(0, RUNID_SHORT)}` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("workflow ")) +
          theme.fg("muted", action) +
          theme.fg("accent", name) +
          theme.fg("dim", runId),
        0,
        0,
      );
    },

    renderResult(result: { content?: Array<{ type: string; text?: string }> }, _options: unknown, _theme: Theme, _context?: unknown) {
      return new Text(renderTextFallback(result), 0, 0);
    },
  });
}

// ── run action ───────────────────────────────────────────────

async function actionRun(
  pi: ExtensionAPI,
  params: WorkflowToolParams,
  deps: LauncherDeps,
  sessionApprovals: Set<string>,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<ToolResult> {
  const name = params.name;
  if (!name) {
    return textResult("run requires 'name' parameter", true);
  }
  const args = params.args ?? {};
  const tokens = params.tokens;
  const time = params.time;

  const script = await deps.registry.get(name);
  if (!script) {
 // 模糊匹配建议
    const all = await deps.registry.loadAll();
    const available = all.filter((wf) => wf.available);
    const suggestions = available
      .map((wf) => `  - ${wf.name}: ${wf.meta.description || "(no description)"}`)
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: `Workflow '${name}' not found. Available:\n${suggestions || "  (none)"}`,
        },
      ],
      details: { action: "run", runId: "", status: "not_found", name },
      isError: true,
    };
  }

 // 确认流程（tmp 或未批准需确认）
  if (requiresConfirmation(script, sessionApprovals)) {
    if (ctx.hasUI) {
      const ok = await ctx.ui.confirm(
        "Run workflow?",
        `Workflow: ${script.name}\nDescription: ${script.meta.description ?? "(none)"}\nSource: [${script.source}]\nPath: ${script.path}`,
      );
      if (!ok) {
        return {
          content: [{ type: "text", text: `User declined to run '${script.name}'.` }],
          details: { action: "run", runId: "", status: "declined", name: script.name },
        };
      }
 // 持久化批准（tmp 不持久化——每次都要确认）
      if (script.source !== "tmp") {
        sessionApprovals.add(script.name);
        await recordApproval(script.name, pi);
      }
    } else {
 // RPC 降级：sendUserMessage 提示
      pi.sendUserMessage(
        `Confirm to run '${script.name}'? (RPC mode — auto-confirm not available, proceed with caution)`,
        { deliverAs: "steer" },
      );
    }
  }

 // 构建 RunSpec + 启动
  const runId = await runWorkflow(
    {
      scriptSource: script.toExecutable(),
      args,
      budgetTokens: tokens,
      budgetTimeMs: time,
      scriptName: script.name,
      scriptPath: script.path,
      description: script.meta.description,
    },
    deps,
    signal,
  );

  return {
    content: [
      {
        type: "text",
        text: `Started workflow '${script.name}' (${runId}). Running in background — do NOT poll status.`,
      },
    ],
    details: { action: "run", runId, status: "running", name: script.name },
  };
}

// ── status action ────────────────────────────────────────────

function actionStatus(deps: LauncherDeps): ToolResult {
  const runs = Array.from(deps.runs.values());
  if (runs.length === 0) {
    return {
      content: [{ type: "text", text: "No workflows in current session." }],
      details: { action: "status", runs: [] },
    };
  }
  const summaries = runs.map(toRunSummary);
  const lines = summaries.map((s) => {
    const duration = s.startedAt ? ` (${formatElapsed(s.startedAt)})` : "";
    const reasonSuffix = s.reason && s.reason !== "completed" ? ` [${s.reason}]` : "";
    return `[${s.status}${reasonSuffix}] ${s.name} (${s.runId.slice(0, RUNID_SHORT)})${duration}${s.error ? ` error: ${s.error}` : ""}`;
  });
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { action: "status", runs: summaries },
  };
}

// ── pause/resume/abort lifecycle actions ─────────────────────

async function actionLifecycle(
  action: "pause" | "resume" | "abort",
  params: WorkflowToolParams,
  deps: LauncherDeps,
): Promise<ToolResult> {
  const runId = params.runId;
  if (!runId) {
    return textResult(`'runId' is required for ${action}`, true);
  }
  const run = deps.runs.get(runId);
  if (!run) {
    return textResult(`Workflow '${runId}' not found`, true);
  }
  try {
    const oldStatus = run.state.status;
    if (action === "pause") {
      await pauseRun(runId, deps);
    } else if (action === "resume") {
      await resumeRun(runId, deps);
    } else {
      await abortRun(runId, deps, params.error);
    }
    const newStatus = run.state.status;
    const reasonSuffix = run.state.reason ? ` (${run.state.reason})` : "";
    return {
      content: [
        {
          type: "text",
          text: `Workflow '${run.spec.scriptName}' (${runId}): ${oldStatus} → ${newStatus}${reasonSuffix}`,
        },
      ],
      details: { action, runId, status: newStatus, reason: run.state.reason },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult(`Error: ${msg}`, true);
  }
}

// ── retry-node / skip-node ───────────────────────────────────

async function actionRetryNode(params: WorkflowToolParams, deps: LauncherDeps): Promise<ToolResult> {
  const runId = params.runId;
  const callId = params.callId;
  if (!runId || callId === undefined) {
    return textResult("retry-node requires 'runId' and 'callId'", true);
  }
  const run = deps.runs.get(runId);
  if (!run) {
    return textResult(`Workflow '${runId}' not found`, true);
  }
  try {
    await retryNode(run, callId, deps);
    return {
      content: [
        { type: "text", text: `Retried call ${callId} in run ${runId.slice(0, RUNID_SHORT)}.` },
      ],
      details: { action: "retry-node", runId, callId },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult(`Error: ${msg}`, true);
  }
}

async function actionSkipNode(params: WorkflowToolParams, deps: LauncherDeps): Promise<ToolResult> {
  const runId = params.runId;
  const callId = params.callId;
  if (!runId || callId === undefined) {
    return textResult("skip-node requires 'runId' and 'callId'", true);
  }
  const run = deps.runs.get(runId);
  if (!run) {
    return textResult(`Workflow '${runId}' not found`, true);
  }
  try {
    await skipNode(run, callId, deps);
    return {
      content: [
        { type: "text", text: `Skipped call ${callId} in run ${runId.slice(0, RUNID_SHORT)}.` },
      ],
      details: { action: "skip-node", runId, callId },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult(`Error: ${msg}`, true);
  }
}

// ── helpers ──────────────────────────────────────────────────

/** WorkflowRun → 摘要（status action 用）。 */
function toRunSummary(run: WorkflowRun): RunSummary {
  return {
    runId: run.runId,
    name: run.spec.scriptName,
    status: run.state.status,
    reason: run.state.reason,
    startedAt: run.meta.startedAt,
    completedAt: run.meta.completedAt,
    error: run.state.error,
  };
}

function textResult(text: string, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    details: undefined,
    isError: isError || undefined,
  };
}
