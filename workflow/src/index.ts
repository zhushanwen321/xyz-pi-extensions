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
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

import {
  type WorkflowInstance,
  type WorkflowStatus,
  ENTRY_TYPE,
  serializeState,
  deserializeState,
  createInstance as createWorkflowInstance,
  transitionStatus,
  isTerminal,
} from "./state.js";
import { WorkflowOrchestrator } from "./orchestrator.js";
import {
  registerWorkflowCommands,
  sendCompletionNotification,
  type WorkflowCommandsState,
} from "./commands.js";
import { renderWorkflowList, registerWorkflowShortcuts } from "./widget.js";

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
    summary?: string;
    data: {
      columns: string[];
      rows: Record<string, unknown>[];
    };
  };
}

// ── Extension factory ─────────────────────────────────────────

export default function workflowExtension(pi: ExtensionAPI) {
  // Session-scoped state: Map<sessionId, Map<runId, WorkflowInstance>>
  const sessionStates = new Map<string, Map<string, WorkflowInstance>>();
  let lastSessionId = "";
  const orchestrators = new Map<string, WorkflowOrchestrator>();
  const cmdState: WorkflowCommandsState = { lastRunId: null };

  function getSessionState(sessionId: string): Map<string, WorkflowInstance> {
    let state = sessionStates.get(sessionId);
    if (!state) {
      state = new Map();
      sessionStates.set(sessionId, state);
    }
    return state;
  }

  function persistState(instances: Map<string, WorkflowInstance>): void {
    pi.appendEntry(ENTRY_TYPE, serializeState(instances));
  }

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
    instances: Map<string, WorkflowInstance>,
  ): WorkflowDetails["_render"] {
    const items = Array.from(instances.values());
    const active = items.filter(
      (i) => i.status === "running" || i.status === "paused",
    ).length;
    const finished = items.filter((i) => isTerminal(i.status)).length;
    return {
      type: "summary-table",
      summary: `${items.length} workflows: ${active} active, ${finished} finished`,
      data: {
        columns: ["Name", "Status", "Worker", "Duration"],
        rows: items.map((inst) => {
          const duration =
            inst.startedAt && inst.completedAt
              ? `${((new Date(inst.completedAt).getTime() - new Date(inst.startedAt).getTime()) / 1000).toFixed(0)}s`
              : inst.startedAt
                ? `${((Date.now() - new Date(inst.startedAt).getTime()) / 1000).toFixed(0)}s (running)`
                : "-";
          return { Name: inst.name, Status: inst.status, Worker: inst.worker, Duration: duration };
        }),
      },
    };
  }

  function toInstanceSummary(inst: WorkflowInstance): InstanceSummary {
    return {
      runId: inst.runId,
      name: inst.name,
      status: inst.status,
      startedAt: inst.startedAt,
      completedAt: inst.completedAt,
      error: inst.error,
    };
  }

  // ── Events ──────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    lastSessionId = sessionId;

    // Reconstruct state-machine instances
    const instances = reconstructState(ctx);
    sessionStates.set(sessionId, instances);

    // Create orchestrator (separate from state-machine instances)
    const orch = new WorkflowOrchestrator(pi, ctx);
    orchestrators.set(sessionId, orch);

    // Set up TUI widget showing workflow list overview
    if (ctx.hasUI) {
      const summaryList = orch.list();
      ctx.ui.setWidget("workflow", renderWorkflowList(summaryList, ctx.ui.theme));
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    lastSessionId = sessionId;
    const instances = reconstructState(ctx);
    sessionStates.set(sessionId, instances);

    // Re-create orchestrator for the new session context
    const orch = new WorkflowOrchestrator(pi, ctx);
    orchestrators.set(sessionId, orch);

    if (ctx.hasUI) {
      const summaryList = orch.list();
      ctx.ui.setWidget("workflow", renderWorkflowList(summaryList, ctx.ui.theme));
    }
  });

  pi.on("session_shutdown", async () => {
    const sessionId = lastSessionId;
    // Pause running orchestrators before cleanup
    const orch = orchestrators.get(sessionId);
    if (orch) {
      const running = orch.list().filter((s) => s.status === "running");
      for (const inst of running) {
        orch.pause(inst.runId);
      }
    }
    sessionStates.delete(sessionId);
    orchestrators.delete(sessionId);
  });

  // ── Tool: workflow ──────────────────────────────────────────

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Multi-agent workflow orchestration. Create, manage, and trace multi-step agent workflows.\n\n" +
      "Actions:\n" +
      "  create   — Create a new workflow in 'created' status\n" +
      "  start    — Transition created → running\n" +
      "  pause    — Transition running → paused\n" +
      "  resume   — Transition paused → running\n" +
      "  complete — Transition running → completed (terminal)\n" +
      "  fail     — Transition running → failed (terminal)\n" +
      "  abort    — Transition running → aborted (terminal)\n" +
      "  status   — List all workflows in current session\n\n" +
      "State machine: created → running ↔ paused → completed/failed/aborted/budget_limited/time_limited\n" +
      "Terminal states are irreversible.",
    promptSnippet:
      "Orchestrate multi-agent workflows with state persistence and execution tracing",
    promptGuidelines: [
      "Use workflow when you need to orchestrate multiple agents in a multi-step process",
      "Workflows have states: created → running ↔ paused → completed/failed/aborted/budget_limited/time_limited",
      "Terminal states cannot be transitioned out of",
      "State is persisted across session branches via Session JSONL entries",
    ],
    parameters: WorkflowParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      lastSessionId = sessionId;
      const instances = getSessionState(sessionId);
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

          const instance = createWorkflowInstance({
            runId,
            name,
            worker,
            budget: {
              maxTokens: params.maxTokens as number | undefined,
              maxCost: params.maxCost as number | undefined,
              maxTimeMs: params.maxTimeMs as number | undefined,
            },
          });

          instances.set(runId, instance);
          persistState(instances);

          return {
            content: [
              { type: "text" as const, text: `Created workflow: ${name} (${runId}) [created]` },
            ],
            details: {
              action: "create",
              instances: Array.from(instances.values()).map(toInstanceSummary),
              _render: buildRender(instances),
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
              details: { action, instances: Array.from(instances.values()).map(toInstanceSummary) } satisfies WorkflowDetails,
              isError: true,
            };
          }

          const instance = instances.get(runId);
          if (!instance) {
            return {
              content: [{ type: "text" as const, text: `Error: workflow '${runId}' not found` }],
              details: { action, instances: Array.from(instances.values()).map(toInstanceSummary) } satisfies WorkflowDetails,
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
              details: { action, instances: Array.from(instances.values()).map(toInstanceSummary) } satisfies WorkflowDetails,
              isError: true,
            };
          }

          try {
            const oldStatus = instance.status;
            transitionStatus(instance, targetStatus);

            // Set timestamps
            if (targetStatus === "running" && oldStatus === "created") {
              instance.startedAt = new Date().toISOString();
            } else if (targetStatus === "paused") {
              instance.pausedAt = new Date().toISOString();
            } else if (isTerminal(targetStatus)) {
              instance.completedAt = new Date().toISOString();
              if (action === "fail" || action === "abort") {
                instance.error = (params.error as string | undefined) ?? instance.error;
              }
            }

            persistState(instances);

            return {
              content: [
                {
                  type: "text" as const,
                  text: `Workflow '${instance.name}' (${runId}): ${oldStatus} → ${targetStatus}`,
                },
              ],
              details: {
                action,
                instances: Array.from(instances.values()).map(toInstanceSummary),
                _render: buildRender(instances),
              } satisfies WorkflowDetails,
            };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
              content: [{ type: "text" as const, text: `Error: ${msg}` }],
              details: { action, instances: Array.from(instances.values()).map(toInstanceSummary) } satisfies WorkflowDetails,
              isError: true,
            };
          }
        }

        // ── Status ──
        case "status": {
          const items = Array.from(instances.values());
          if (items.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No workflows in current session." }],
              details: { action: "status", instances: [], _render: buildRender(instances) } satisfies WorkflowDetails,
            };
          }

          const text = items
            .map((inst) => {
              const duration =
                inst.startedAt
                  ? ` (${((Date.now() - new Date(inst.startedAt).getTime()) / 1000).toFixed(0)}s)`
                  : "";
              return `[${inst.status}] ${inst.name} (${inst.runId.slice(0, 20)})${duration}` +
                (inst.error ? ` error: ${inst.error}` : "");
            })
            .join("\n");

          return {
            content: [{ type: "text" as const, text }],
            details: {
              action: "status",
              instances: Array.from(instances.values()).map(toInstanceSummary),
              _render: buildRender(instances),
            } satisfies WorkflowDetails,
          };
        }

        default: {
          return {
            content: [{ type: "text" as const, text: `Unknown action: ${action}` }],
            details: { action, instances: Array.from(instances.values()).map(toInstanceSummary) } satisfies WorkflowDetails,
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
      "Run a workflow in the background. Starts execution immediately and returns " +
      "a runId without waiting for completion. Results are delivered as a custom " +
      "message (workflow-result) when the workflow finishes.",
    promptSnippet:
      "Execute a workflow script with optional arguments and budget limits",
    promptGuidelines: [
      "Use workflow-run to start workflows that execute in the background",
      "The tool returns immediately with a runId; results arrive asynchronously",
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

      // Poll for completion (unref'd so it doesn't block process exit)
      const pollInterval = setInterval(() => {
        const inst = orch.getInstance(runId);
        if (!inst || isTerminal(inst.status)) {
          clearInterval(pollInterval);
          if (inst) {
            sendCompletionNotification(pi, runId, inst);
          }
        }
      }, 2000);

      if (typeof pollInterval === "object" && "unref" in pollInterval) {
        pollInterval.unref();
      }

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
  registerWorkflowShortcuts(pi, orchestrators, cmdState);
}
