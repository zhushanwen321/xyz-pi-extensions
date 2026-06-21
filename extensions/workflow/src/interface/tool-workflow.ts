/**
 * tool-workflow.ts — Workflow Control Tool
 *
 * Extracted from index.ts to reduce file size.
 * Lifecycle control for already-running workflows: pause, resume, abort, status.
 * For STARTING a workflow, use tool-workflow-run.ts instead.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "typebox";

import { isTerminal, type WorkflowStatus } from "../domain/state.js";
import { RUNID_INDEX_LONG, RUNID_INDEX_SHORT } from "../infra/constants.js";
import { type WorkflowInstanceSummary, type WorkflowOrchestrator } from "../orchestrator.js";
import { acquireReentryGuard, REENTRY_BUSY_MESSAGE, type ReentryGuardRef,releaseReentryGuard } from "./reentry-guard.js";
import type { LastSessionRef } from "./tool-workflow-run.js";
import { formatElapsed, renderTextFallback, statusColorToken } from "./views/format.js";

// ── Parameter schema ──────────────────────────────────────────

const WorkflowAction = StringEnum(
  ["pause", "resume", "abort", "status"] as const,
  { description: "Workflow action to execute" },
);

const WorkflowParams = Type.Object({
  action: WorkflowAction,
  runId: Type.Optional(Type.String({ description: "Workflow run ID (required for pause/resume/abort)" })),
  error: Type.Optional(Type.String({ description: "Error/reason message (optional, used with abort)" })),
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
  agents?: Array<{ name: string; source: string; model?: string }>;
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

// ── Helper: _render descriptor builder ────────────────────────

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
            ? formatElapsed(inst.startedAt, new Date(inst.completedAt).getTime())
            : inst.startedAt
              ? `${formatElapsed(inst.startedAt)} (running)`
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

// ── Tool registration ─────────────────────────────────────────

export function registerWorkflowTool(
  pi: ExtensionAPI,
  orchestrators: Map<string, WorkflowOrchestrator>,
  lsRef: LastSessionRef,
  guard: ReentryGuardRef,
): void {
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Control running workflow instances: pause, resume, abort, or check status.\n" +
      "\n" +
      "For STARTING a new workflow, use `workflow-run` instead.\n" +
      "This tool ONLY controls already-running workflows.\n" +
      "\n" +
      "Actions:\n" +
      "  status   — List all workflow instances in current session\n" +
      "  pause    — Pause a running workflow (preserves progress, terminates Worker)\n" +
      "  resume   — Resume a paused workflow (replays callCache, skips completed agents)\n" +
      "  abort    — Abort a running workflow (irreversible)\n",
    promptSnippet:
      "Check workflow status, or pause/resume/abort a running workflow",
    promptGuidelines: [
      "Use workflow tool for lifecycle control: pause, resume, abort.",
      "To START a new workflow, use workflow-run tool instead",
      "Only check status (action: status) when the user explicitly asks. Never poll in a loop.",
      "Workflows can be paused and resumed across sessions",
    ],
    parameters: WorkflowParams,

    async execute(_toolCallId: string, params: Static<typeof WorkflowParams>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      // P1-2: Honor abort signal up-front
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "Operation aborted before start" }],
          details: undefined,
          isError: true,
        };
      }
      // P1-6: Reentry guard — prevent concurrent tool calls from clobbering orchestrator state
      if (!acquireReentryGuard(guard)) {
        return {
          content: [{ type: "text" as const, text: REENTRY_BUSY_MESSAGE }],
          details: undefined,
          isError: true,
        };
      }
      try {
      const sessionId = ctx.sessionManager.getSessionId();
      lsRef.lastSessionId = sessionId;
      const orch = orchestrators.get(sessionId);
      if (!orch) {
        return {
          content: [{ type: "text", text: "Workflow orchestrator not initialized" }],
          details: undefined,
          isError: true,
        };
      }
      const action = params.action as string;

      switch (action) {
        // ── Control (pause / resume / abort) ──
        case "pause":
        case "resume":
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

          // Pre-flight: reject invalid transitions before touching the orchestrator.
          if (
            (action === "pause" && instance.status !== "running") ||
            (action === "resume" && instance.status !== "paused")
          ) {
            return {
              content: [{
                type: "text" as const,
                text: `Error: cannot ${action} workflow '${instance.name}' (${runId}): current status is '${instance.status}', expected '${action === "pause" ? "running" : "paused"}'`,
              }],
              details: {
                action,
                instances: orch.list().map(toInstanceSummary),
                _render: buildRender(orch.list()),
              } satisfies WorkflowDetails,
              isError: true,
            };
          }

          // Delegate to orchestrator (handles Worker lifecycle).
          // Wave 5 (5-D): orchestrator.pause/resume/abort now route through
          // terminateInstance with A4 ordering (cleanup before status mutation),
          // so the previous 3-layer fallback (orchestrator → idempotent check →
          // direct transitionStatus) is no longer needed. A throw from the
          // orchestrator now genuinely means the transition failed — surface it.
          const oldStatus = instance.status;
          try {
            if (action === "pause") await orch.pause(runId);
            else if (action === "resume") await orch.resume(runId);
            else await orch.abort(runId, params.error as string | undefined);

            const summaries = orch.list();
            return {
              content: [{
                type: "text" as const,
                text: `Workflow '${instance.name}' (${runId}): ${oldStatus} → ${instance.status}`,
              }],
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
              details: {
                action,
                instances: orch.list().map(toInstanceSummary),
                _render: buildRender(orch.list()),
              } satisfies WorkflowDetails,
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
              details: { action: "status", instances: [], agents: orch.getAgents(), _render: buildRender(summaries) } satisfies WorkflowDetails,
            };
          }

          const text = summaries
            .map((s) => {
              const duration =
                s.startedAt
                  ? ` (${formatElapsed(s.startedAt)})`
                  : "";
              return `[${s.status}] ${s.name} (${s.runId.slice(0, RUNID_INDEX_LONG)})${duration}` +
                (s.error ? ` error: ${s.error}` : "");
            })
            .join("\n");

          return {
            content: [{ type: "text" as const, text }],
            details: {
              action: "status",
              instances: summaries.map(toInstanceSummary),
              agents: orch.getAgents(),
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
      } finally {
        // P1-6: Always release the reentry guard
        releaseReentryGuard(guard);
      }
    },

    renderCall(args: Record<string, unknown>, theme: Theme, _context?: unknown) {
      const action = args.action as string;
      let text =
        theme.fg("toolTitle", theme.bold("workflow ")) +
        theme.fg("muted", action);
      if (args.name) text += ` ${theme.fg("accent", args.name as string)}`;
      if (args.runId) text += ` ${theme.fg("dim", (args.runId as string).slice(0, RUNID_INDEX_LONG))}`;
      if (args.error) text += ` ${theme.fg("error", "error")}`;
      return new Text(text, 0, 0);
    },

    renderResult(result: { content?: Array<{ type: string; text?: string }>; details?: WorkflowDetails }, _options: unknown, theme: Theme, _context?: unknown) {
      const details = result.details;
      if (!details) {
        return new Text(renderTextFallback(result), 0, 0);
      }

      if (details.action === "status" && details.instances.length > 0) {
        const lines = details.instances
          .map((inst) => {
            const color = statusColorToken(inst.status);
            return `${theme.fg(color, `[${inst.status}]`)} ${theme.fg("accent", inst.name)} ${theme.fg("dim", inst.runId.slice(0, RUNID_INDEX_SHORT))}${inst.error ? ` ${theme.fg("error", inst.error)}` : ""}`;
          })
          .join("\n");
        return new Text(lines, 0, 0);
      }

      return new Text(renderTextFallback(result), 0, 0);
    },
  });
}
