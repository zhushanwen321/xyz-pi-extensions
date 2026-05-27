/**
 * Workflow Extension — Factory Skeleton
 *
 * Events registered:
 *   session_start  — reconstruct state from Session JSONL
 *   session_tree   — rehydrate on branch switch
 *   session_shutdown — clean up session-scoped state
 *
 * Tool: "workflow"
 *   Actions: create, start, pause, resume, complete, fail, abort, status
 *   Enforces state machine rules (terminal states are irreversible)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  type WorkflowInstance,
  type WorkflowStatus,
  ENTRY_TYPE,
  deserializeState,
  transitionStatus,
  isTerminal,
} from "./state.js";
import { WorkflowOrchestrator, type WorkflowInstanceSummary } from "./orchestrator.js";
import {
  registerWorkflowCommands,
  type WorkflowCommandsState,
} from "./commands.js";
import { renderWorkflowList, registerWorkflowShortcuts } from "./widget.js";
import { registerGenerateTool } from "./tool-generate.js";

// ── Parameter schema ──────────────────────────────────────────

const WorkflowAction = StringEnum(
  ["create", "start", "pause", "resume", "complete", "fail", "abort", "status"] as const,
  { description: "Workflow action to execute" },
);

const WorkflowParams = Type.Object({
  action: WorkflowAction,
  runId: Type.Optional(Type.String({ description: "Workflow run ID" })),
  name: Type.Optional(Type.String({ description: "Workflow name (required for create)" })),
  worker: Type.Optional(
    Type.String({ description: "Default worker agent for this workflow", default: "general-purpose" }),
  ),
  maxTokens: Type.Optional(Type.Number({ description: "Maximum token budget" })),
  maxCost: Type.Optional(Type.Number({ description: "Maximum cost budget" })),
  maxTimeMs: Type.Optional(Type.Number({ description: "Maximum time budget in milliseconds" })),
  error: Type.Optional(Type.String({ description: "Error message (used with fail/abort)" })),
});

// ── Details type for TUI / _render ────────────────────────────

interface InstanceSummary {
  runId: string;
  name: string;
  status: WorkflowStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

interface WorkflowDetails {
  action: string;
  instances: InstanceSummary[];
  _render?: {
    type: "summary-table";
    data: {
      title: string;
      columns: Array<{ key: string; label: string; width?: number; valueType?: "text" | "status" | "duration" | "number" }>;
      rows: Record<string, unknown>[];
    };
    summary?: string;
  };
}

// ── Extension factory ─────────────────────────────────────────

export default function workflowExtension(pi: ExtensionAPI) {
  let lastSessionId = "";
  const orchestrators = new Map<string, WorkflowOrchestrator>();
  const cmdState: WorkflowCommandsState = { lastRunId: null };

  /**
   * Rebuild workflow state from Session JSONL custom entries.
   * Reads entries with ENTRY_TYPE and reconstructs the instances map.
   */
  function reconstructState(ctx: ExtensionContext): Map<string, WorkflowInstance> {
    const instances = new Map<string, WorkflowInstance>();
    try {
      const entries = ctx.sessionManager.getBranch();
      for (const entry of entries) {
        if (entry.type !== "custom") continue;
        const custom = entry as unknown as { customType?: string; data?: unknown };
        if (custom.customType !== ENTRY_TYPE) continue;
        if (custom.data && typeof custom.data === "object") {
          const restored = deserializeState(custom.data);
          for (const [runId, instance] of restored) {
            instances.set(runId, instance);
          }
        }
      }
    } catch {
      // If getBranch or deserialize fail, return empty map
    }
    return instances;
  }

  // ── Build _render descriptor ────────────────────────────────

  function buildRender(
    summaries: WorkflowInstanceSummary[],
  ): WorkflowDetails["_render"] {
    const items = summaries;
    const active = items.filter(
      (i) => i.status === "running" || i.status === "paused",
    ).length;
    const finished = items.filter((i) => isTerminal(i.status)).length;
    return {
      type: "summary-table",
      summary: `${items.length} workflows: ${active} active, ${finished} finished`,
      data: {
        title: "Workflows",
        columns: [
          { key: "name", label: "Name", valueType: "text" },
          { key: "status", label: "Status", valueType: "status" },
          { key: "worker", label: "Worker", valueType: "text" },
          { key: "duration", label: "Duration", valueType: "duration" },
        ],
        rows: items.map((inst) => {
          const duration =
            inst.startedAt && inst.completedAt
              ? `${((new Date(inst.completedAt).getTime() - new Date(inst.startedAt).getTime()) / 1000).toFixed(0)}s`
              : inst.startedAt
                ? `${((Date.now() - new Date(inst.startedAt).getTime()) / 1000).toFixed(0)}s (running)`
                : "-";
          return { name: inst.name, status: inst.status, worker: inst.worker, duration };
        }),
      },
    };
  }

  function toInstanceSummary(summary: WorkflowInstanceSummary): InstanceSummary {
    return {
      runId: summary.runId,
      name: summary.name,
      status: summary.status,
      startedAt: summary.startedAt,
      completedAt: summary.completedAt,
      error: summary.error,
    };
  }

  // ── Events ──────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    lastSessionId = sessionId;

    // Create orchestrator (sole instance holder)
    const orch = new WorkflowOrchestrator(pi, ctx);
    orchestrators.set(sessionId, orch);

    // Restore reconstructed state into orchestrator
    const instances = reconstructState(ctx);
    orch.restoreInstances(instances);

    // Live progress: refresh widget on every trace node change
    orch.onTraceUpdate = (_runId) => {
      if (ctx.hasUI) {
        ctx.ui.setWidget("workflow", renderWorkflowList(orch.list(), ctx.ui.theme));
      }
    };

    // Set up TUI widget showing workflow list overview
    if (ctx.hasUI) {
      const summaryList = orch.list();
      ctx.ui.setWidget("workflow", renderWorkflowList(summaryList, ctx.ui.theme));
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    lastSessionId = sessionId;

    // Create orchestrator for the new session context
    const orch = new WorkflowOrchestrator(pi, ctx);
    orchestrators.set(sessionId, orch);

    // Restore reconstructed state into orchestrator
    const instances = reconstructState(ctx);
    orch.restoreInstances(instances);

    // Live progress: refresh widget on every trace node change
    orch.onTraceUpdate = (_runId) => {
      if (ctx.hasUI) {
        ctx.ui.setWidget("workflow", renderWorkflowList(orch.list(), ctx.ui.theme));
      }
    };

    if (ctx.hasUI) {
      const summaryList = orch.list();
      ctx.ui.setWidget("workflow", renderWorkflowList(summaryList, ctx.ui.theme));
    }
  });

  pi.on("session_shutdown", async () => {
    // Note: Pi's session_shutdown event does not pass ctx, so we use lastSessionId
    const sessionId = lastSessionId;
    // Pause running orchestrators before cleanup
    const orch = orchestrators.get(sessionId);
    if (orch) {
      const running = orch.list().filter((s) => s.status === "running");
      for (const inst of running) {
        orch.pause(inst.runId);
      }
    }
    orchestrators.delete(sessionId);
  });

  // ── Tool: workflow ──────────────────────────────────────────

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Manage running workflow instances (pause, resume, abort, status).\n" +
      "\n" +
      "Do NOT use this tool to start a workflow — use `workflow-run` instead.\n" +
      "This tool is for checking status or controlling already-running workflows.\n" +
      "\n" +
      "Actions:\n" +
      "  status   — List all workflow instances in current session\n" +
      "  pause    — Pause a running workflow (preserves progress, terminates Worker)\n" +
      "  resume   — Resume a paused workflow (replays callCache, skips completed agents)\n" +
      "  abort    — Abort a running workflow (irreversible)\n",
    promptSnippet:
      "Check workflow status, or pause/resume/abort a running workflow",
    promptGuidelines: [
      "Use workflow tool for status checks and lifecycle control of running workflows",
      "To START a new workflow, use workflow-run tool instead",
      "Workflows can be paused and resumed across sessions",
    ],
    parameters: WorkflowParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      lastSessionId = sessionId;
      const orch = orchestrators.get(sessionId);
      if (!orch) {
        throw new Error("Workflow orchestrator not initialized");
      }
      const action = params.action as string;

      switch (action) {
        // ── Create ──
        case "create": {
          const name = params.name as string | undefined;
          if (!name) {
            return {
              content: [{ type: "text" as const, text: "Error: 'name' is required for create action" }],
              details: { action: "create", instances: [] } satisfies WorkflowDetails,
              isError: true,
            };
          }
          const runId =
            (params.runId as string | undefined) ??
            `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const worker = (params.worker as string | undefined) ?? "general-purpose";

          orch.createInstance({
            runId,
            name,
            worker,
            budget: {
              maxTokens: params.maxTokens as number | undefined,
              maxCost: params.maxCost as number | undefined,
              maxTimeMs: params.maxTimeMs as number | undefined,
            },
          });

          const summaries = orch.list();
          return {
            content: [
              { type: "text" as const, text: `Created workflow: ${name} (${runId}) [created]` },
            ],
            details: {
              action: "create",
              instances: summaries.map(toInstanceSummary),
              _render: buildRender(summaries),
            } satisfies WorkflowDetails,
          };
        }

        // ── State transitions ──
        case "start":
        case "pause":
        case "resume":
        case "complete":
        case "fail":
        case "abort": {
          const runId = params.runId as string | undefined;
          if (!runId) {
            return {
              content: [{ type: "text" as const, text: "Error: 'runId' is required for this action" }],
              details: { action, instances: orch.list().map(toInstanceSummary) } satisfies WorkflowDetails,
              isError: true,
            };
          }

          const instance = orch.getInstance(runId);
          if (!instance) {
            return {
              content: [{ type: "text" as const, text: `Error: workflow '${runId}' not found` }],
              details: { action, instances: orch.list().map(toInstanceSummary) } satisfies WorkflowDetails,
              isError: true,
            };
          }

          const actionToTarget: Record<string, WorkflowStatus> = {
            start: "running",
            pause: "paused",
            resume: "running",
            complete: "completed",
            fail: "failed",
            abort: "aborted",
          };

          const targetStatus = actionToTarget[action];
          if (!targetStatus) {
            return {
              content: [{ type: "text" as const, text: `Error: unknown action '${action}'` }],
              details: { action, instances: orch.list().map(toInstanceSummary) } satisfies WorkflowDetails,
              isError: true,
            };
          }

          // For pause/resume/abort: delegate to orchestrator (handles Worker lifecycle)
          if (action === "pause" || action === "resume" || action === "abort") {
            if (action === "abort" && (params.error as string | undefined)) {
              instance.error = params.error as string;
            }
            try {
              if (action === "pause") orch.pause(runId);
              else if (action === "resume") orch.resume(runId);
              else orch.abort(runId);

              const summaries = orch.list();
              return {
                content: [{
                  type: "text" as const,
                  text: `Workflow '${instance.name}' (${runId}): → ${instance.status}`,
                }],
                details: {
                  action,
                  instances: summaries.map(toInstanceSummary),
                  _render: buildRender(summaries),
                } satisfies WorkflowDetails,
              };
            } catch {
              // Orchestrator method failed — fall through to direct state machine
            }
          }

          // Direct state machine transition (start/complete/fail, or orchestrator fallback)
          try {
            const oldStatus = instance.status;
            transitionStatus(instance, targetStatus);

            // Set timestamps
            if (targetStatus === "running" && oldStatus === "created") {
              instance.startedAt = new Date().toISOString();
            } else if (targetStatus === "running" && oldStatus === "paused") {
              instance.pausedAt = undefined;
            } else if (targetStatus === "paused") {
              instance.pausedAt = new Date().toISOString();
            } else if (isTerminal(targetStatus)) {
              instance.completedAt = new Date().toISOString();
              if (action === "fail" || action === "abort") {
                instance.error = (params.error as string | undefined) ?? instance.error;
              }
            }

            orch.persistState();

            const summaries = orch.list();
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Workflow '${instance.name}' (${runId}): ${oldStatus} → ${targetStatus}`,
                },
              ],
              details: {
                action,
                instances: summaries.map(toInstanceSummary),
                _render: buildRender(summaries),
              } satisfies WorkflowDetails,
            };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
              content: [{ type: "text" as const, text: `Error: ${msg}` }],
              details: { action, instances: orch.list().map(toInstanceSummary) } satisfies WorkflowDetails,
              isError: true,
            };
          }
        }

        // ── Status ──
        case "status": {
          const summaries = orch.list();
          if (summaries.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No workflows in current session." }],
              details: { action: "status", instances: [], _render: buildRender(summaries) } satisfies WorkflowDetails,
            };
          }

          const text = summaries
            .map((s) => {
              const duration =
                s.startedAt
                  ? ` (${((Date.now() - new Date(s.startedAt).getTime()) / 1000).toFixed(0)}s)`
                  : "";
              return `[${s.status}] ${s.name} (${s.runId.slice(0, 20)})${duration}` +
                (s.error ? ` error: ${s.error}` : "");
            })
            .join("\n");

          return {
            content: [{ type: "text" as const, text }],
            details: {
              action: "status",
              instances: summaries.map(toInstanceSummary),
              _render: buildRender(summaries),
            } satisfies WorkflowDetails,
          };
        }

        default: {
          return {
            content: [{ type: "text" as const, text: `Unknown action: ${action}` }],
            details: { action, instances: orch.list().map(toInstanceSummary) } satisfies WorkflowDetails,
            isError: true,
          };
        }
      }
    },

    renderCall(args, theme, _context) {
      const action = args.action as string;
      let text =
        theme.fg("toolTitle", theme.bold("workflow ")) +
        theme.fg("muted", action);
      if (args.name) text += ` ${theme.fg("accent", args.name as string)}`;
      if (args.runId) text += ` ${theme.fg("dim", (args.runId as string).slice(0, 20))}`;
      if (args.error) text += ` ${theme.fg("error", "error")}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as WorkflowDetails | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
      }

      if (details.action === "status" && details.instances.length > 0) {
        const lines = details.instances
          .map((inst) => {
            const color: "success" | "warning" | "error" | "muted" =
              inst.status === "completed" ? "success"
              : inst.status === "running" ? "warning"
              : inst.status === "failed" || inst.status === "aborted" ? "error"
              : "muted";
            return `${theme.fg(color, `[${inst.status}]`)} ${theme.fg("accent", inst.name)} ${theme.fg("dim", inst.runId.slice(0, 16))}${inst.error ? ` ${theme.fg("error", inst.error)}` : ""}`;
          })
          .join("\n");
        return new Text(lines, 0, 0);
      }

      const text = result.content[0];
      return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
    },
  });

  // ── Tool: workflow-run ──────────────────────────────────────

  const WorkflowRunParams = Type.Object({
    name: Type.String({ description: "Workflow name to execute" }),
    args: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "Arguments passed to workflow as key-value pairs",
      }),
    ),
    tokens: Type.Optional(
      Type.Number({ description: "Maximum token budget" }),
    ),
    time: Type.Optional(
      Type.Number({ description: "Maximum time budget in milliseconds" }),
    ),
  });

  interface WorkflowRunDetails {
    action: "run";
    runId: string;
    status: string;
    name: string;
    _render?: {
      type: "task-list";
      data: {
        title: string;
        items: Array<{
          label: string;
          status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
          detail?: string;
        }>;
      };
    };
  }

  pi.registerTool({
    name: "workflow-run",
    label: "Workflow Run",
    description:
      "Run a named workflow script in the background. The script runs in a Worker thread " +
      "with agent()/parallel()/pipeline() APIs for multi-step agent orchestration.\n\n" +
      "When to use workflow-run INSTEAD of subagent:\n" +
      "  - The task follows a fixed, deterministic pipeline (not interactive)\n" +
      "  - You need parallel() to run multiple agents concurrently on the SAME task\n" +
      "  - The task should run in the background without blocking the conversation\n" +
      "  - The user explicitly asks to run a workflow by name\n\n" +
      "When to use subagent INSTEAD of workflow-run:\n" +
      "  - The task is a one-off delegation (not a reusable pipeline)\n" +
      "  - You need the agent to interact with the user\n" +
      "  - You need chain/sequential modes with output passing\n" +
      "  - The task doesn't match any existing workflow script\n\n" +
      "Available workflows are discovered from .pi/workflows/ and ~/.pi/agent/workflows/. " +
      "Returns immediately with a runId; results arrive asynchronously.",
    promptSnippet:
      "Run a named workflow script with agent/parallel/pipeline APIs in background",
    promptGuidelines: [
      "Use workflow-run for deterministic, non-interactive agent pipelines that run in the background",
      "Prefer subagent for one-off tasks, interactive work, or tasks without a matching script",
      "The tool returns immediately; workflow results arrive as a background message",
      "Optional --tokens and --time enforce budget limits",
    ],
    parameters: WorkflowRunParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      lastSessionId = sessionId;
      const orch = orchestrators.get(sessionId);
      if (!orch) {
        throw new Error("Workflow orchestrator not initialized");
      }

      const name = params.name as string;
      const args = (params.args as Record<string, unknown> | undefined) ?? {};
      const tokens = params.tokens as number | undefined;
      const time = params.time as number | undefined;

      const runId = await orch.run(name, args, tokens, time);
      cmdState.lastRunId = runId;

      // Update widget
      if (ctx.hasUI) {
        const summaryList = orch.list();
        ctx.ui.setWidget("workflow", renderWorkflowList(summaryList, ctx.ui.theme));
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Started workflow '${name}' (${runId})`,
          },
        ],
        details: {
          action: "run",
          runId,
          status: "running",
          name,
          _render: {
            type: "task-list" as const,
            data: {
              title: `Workflow: ${name}`,
              items: [
                {
                  label: `Started ${runId.slice(0, 16)}...`,
                  status: "in_progress" as const,
                },
              ],
            },
          },
        } satisfies WorkflowRunDetails,
      };
    },

    renderCall(args, theme, _context) {
      const name = args.name as string;
      const text =
        theme.fg("toolTitle", theme.bold("workflow-run ")) +
        theme.fg("accent", name);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as WorkflowRunDetails | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
      }

      const statusColor =
        details.status === "completed"
          ? "success"
          : details.status === "running"
            ? "warning"
            : details.status === "failed" || details.status === "aborted"
              ? "error"
              : "muted";

      const text =
        `${theme.fg(statusColor as "success" | "warning" | "error" | "muted", `[${details.status}]`)}` +
        ` ${theme.fg("accent", details.name)}` +
        ` ${theme.fg("dim", details.runId.slice(0, 16))}`;
      return new Text(text, 0, 0);
    },
  });

  // ── Commands & Shortcuts ───────────────────────────────────

  registerWorkflowCommands(pi, orchestrators, cmdState);
  registerGenerateTool(pi);
  // registerWorkflowShortcuts(pi, orchestrators, cmdState); // shortcuts disabled for now

}
