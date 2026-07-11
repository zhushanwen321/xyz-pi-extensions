/**
 * Workflow Extension — workflow tool（7 actions，FR-5 tool 收口）。
 *
 * 合并原 tool-workflow.ts + tool-workflow-run.ts 为单 tool。
 *
 * Actions:
 * - run: registry.get → runWorkflow（直接启动，无需用户确认）
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

import type { LauncherDeps } from "../orchestration/launcher.ts";
import { abortRun, pauseRun, resumeRun, runWorkflow } from "../orchestration/lifecycle.ts";
import type { WorkflowRun } from "../orchestration/models/workflow-run.ts";
import { retryNode, skipNode } from "../orchestration/node-ops.ts";
import {
  guiComponent,
  type GuiContext,
  guiResult,
  isGuiCapable,
} from "./gui-adapter.ts";
import {
  acquireReentryGuard,
  REENTRY_BUSY_MESSAGE,
  type ReentryGuardRef,
  releaseReentryGuard,
} from "./reentry-guard.ts";
import { formatElapsed, renderTextFallback } from "./views/format.ts";

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
  | { action: "run"; runId: string; status: "running" | "not_found"; name: string }
  | { action: "status"; runs: RunSummary[] }
  | { action: "pause" | "resume" | "abort"; runId: string; status: string; reason?: string }
  | { action: "retry-node" | "skip-node"; runId: string; callId: number };

/** Result returned by the `workflow` tool's execute. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: WorkflowToolDetails | undefined;
  isError?: boolean;
}

// ── GUI 协议 helpers ───────────────────────────────────────

/** 为 details 附加 __gui__（RPC 模式下）。 */
function withGui<T extends WorkflowToolDetails | undefined>(
  details: T,
  ctx?: GuiContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = details ? { ...details } : {};
  if (ctx && isGuiCapable(ctx) && details) {
    out.__gui__ = guiResult(buildWorkflowGui(details));
  }
  return out;
}

/** 按 WorkflowToolDetails 构造对应的 GuiComponent。 */
function buildWorkflowGui(details: WorkflowToolDetails) {
  if (details.action === "run") {
    return guiComponent("workflow-runs", {
      runs: [{ runId: details.runId, name: details.name, status: details.status }],
    });
  }
  if (details.action === "status") {
    return guiComponent("workflow-runs", {
      runs: details.runs.map((r) => ({
        runId: r.runId,
        name: r.name,
        status: r.status,
        reason: r.reason,
        error: r.error,
      })),
    });
  }
  // pause/resume/abort/retry-node/skip-node
  return guiComponent("stats-line", {
    items: [{
      label: details.action,
      value: details.runId.slice(0, 8),
      severity: "ok" as const,
    }],
  });
}

// ── Tool registration ────────────────────────────────────────

/**
 * 注册 workflow tool（7 actions）。
 *
 * @param pi ExtensionAPI
 * @param deps LauncherDeps（LifecycleDeps + registry）
 * @param reentryRef 共享 reentry guard（与 workflow-script tool 共用）
 */
export function registerWorkflowTool(
  pi: ExtensionAPI,
  deps: LauncherDeps,
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
      "run: discover by name/description, then start in background (no user confirmation needed).",
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
      _ctx: ExtensionContext,
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
        let result: ToolResult;
        switch (params.action) {
          case "run":
            result = await actionRun(params, deps, signal);
            break;
          case "status":
            result = actionStatus(deps);
            break;
          case "pause":
            result = await actionLifecycle("pause", params, deps);
            break;
          case "resume":
            result = await actionLifecycle("resume", params, deps);
            break;
          case "abort":
            result = await actionLifecycle("abort", params, deps);
            break;
          case "retry-node":
            result = await actionRetryNode(params, deps);
            break;
          case "skip-node":
            result = await actionSkipNode(params, deps);
            break;
          default:
            return textResult(`Unknown action: ${String(params.action)}`, true);
        }
        // GUI 协议：RPC 模式下附加 __gui__ 到 details
        return {
          ...result,
          details: withGui(result.details, _ctx as GuiContext) as unknown as WorkflowToolDetails,
        };
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
  params: WorkflowToolParams,
  deps: LauncherDeps,
  signal: AbortSignal | undefined,
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
