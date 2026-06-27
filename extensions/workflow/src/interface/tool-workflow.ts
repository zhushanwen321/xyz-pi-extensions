/**
 * tool-workflow.ts — Workflow lifecycle control tool (pause/resume/abort/status)
 *
 * Extracted from index.ts to reduce entry-file size. Pure relocation;
 * behavior is identical to the previous inline registration.
 *
 * Register via registerWorkflowTool(pi, deps).
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static,Type } from "typebox";

import { isTerminal,transitionStatus,type WorkflowStatus } from "../domain/state.js";
import {
  buildRender,
  MS_PER_SEC,
  RUNID_SHORT_LENGTH,
  RUNID_SLICE_LENGTH,
  toInstanceSummary,
  type WorkflowDetails,
  type WorkflowToolDeps,
} from "./shared.js";

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

// ── Tool registration ─────────────────────────────────────────

export function registerWorkflowTool(pi: ExtensionAPI, deps: WorkflowToolDeps): void {
  const { orchestrators, lsRef, guard } = deps;

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

     
    async execute(_toolCallId: string, params: Static<typeof WorkflowParams>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<{ content: Array<{ type: "text"; text: string }>; details: WorkflowDetails | undefined; isError?: boolean }> {
      // P1-2: Honor abort signal up-front
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "Operation aborted before start" }],
          details: undefined,
          isError: true,
        };
      }
      // P1-6: Reentry guard — prevent concurrent tool calls from clobbering orchestrator state
      if (guard.isProcessing) {
        return {
          content: [{ type: "text" as const, text: "Another workflow operation is in progress; please wait for it to complete before issuing another command." }],
          details: undefined,
          isError: true,
        };
      }
      guard.isProcessing = true;
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

          const actionToTarget: Record<string, WorkflowStatus> = {
            pause: "paused",
            resume: "running",
            abort: "aborted",
          };
          const targetStatus = actionToTarget[action];

          // Pre-flight: reject invalid transitions before touching the orchestrator
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

          // Delegate to orchestrator (handles Worker lifecycle)
          if (action === "abort" && (params.error as string | undefined)) {
            instance.error = params.error as string;
          }
          const oldStatus = instance.status;
          try {
            if (action === "pause") await orch.pause(runId);
            else if (action === "resume") await orch.resume(runId);
            else await orch.abort(runId);

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
          // eslint-disable-next-line taste/no-silent-catch
          } catch {
            // Orchestrator method failed — fall through to idempotent check or direct state machine
          }

          // Idempotent: if the workflow is already in the target state (or a terminal state for abort),
          // return success instead of attempting an invalid state transition.
          // Re-persist to recover from partial orchestrator success (status mutated but persistState threw).
          if (
            instance.status === targetStatus ||
            (action === "abort" && isTerminal(instance.status))
          ) {
            try { await orch.persistState(); } catch { /* best effort */ }
            const summaries = orch.list();
            return {
              content: [{
                type: "text" as const,
                text: `Workflow '${instance.name}' (${runId}): already ${instance.status}`,
              }],
              details: {
                action,
                instances: summaries.map(toInstanceSummary),
                _render: buildRender(summaries),
              } satisfies WorkflowDetails,
            };
          }

          // Last resort: direct state machine transition (e.g. orchestrator in inconsistent state)
          try {
            const oldStatus = instance.status;
            transitionStatus(instance, targetStatus);

            if (targetStatus === "running" && oldStatus === "paused") {
              instance.pausedAt = undefined;
            } else if (targetStatus === "paused") {
              instance.pausedAt = new Date().toISOString();
            } else if (isTerminal(targetStatus)) {
              instance.completedAt = new Date().toISOString();
              if (action === "abort") {
                instance.error = (params.error as string | undefined) ?? instance.error;
              }
            }

            await orch.persistState();

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
              details: { action: "status", instances: [], agents: orch.getAgents(), _render: buildRender(summaries) } satisfies WorkflowDetails,
            };
          }

          const text = summaries
            .map((s) => {
              const duration =
                s.startedAt
                  ? ` (${((Date.now() - new Date(s.startedAt).getTime()) / MS_PER_SEC).toFixed(0)}s)`
                  : "";
              return `[${s.status}] ${s.name} (${s.runId.slice(0, RUNID_SLICE_LENGTH)})${duration}` +
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
        guard.isProcessing = false;
      }
    },

    renderCall(args: Record<string, unknown>, theme: Theme, _context?: unknown) {
      const action = args.action as string;
      let text =
        theme.fg("toolTitle", theme.bold("workflow ")) +
        theme.fg("muted", action);
      if (args.name) text += ` ${theme.fg("accent", args.name as string)}`;
      if (args.runId) text += ` ${theme.fg("dim", (args.runId as string).slice(0, RUNID_SLICE_LENGTH))}`;
      if (args.error) text += ` ${theme.fg("error", "error")}`;
      return new Text(text, 0, 0);
    },

    renderResult(result: { content: Array<{ type: "text" | "image"; text?: string }>; details?: WorkflowDetails }, _options: unknown, theme: Theme, _context?: unknown) {
      const details = result.details as WorkflowDetails | undefined;
      if (!details) {
        const content = result.content as Array<{ type: string; text: string }> | undefined;
        const text = content?.[0];
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
            return `${theme.fg(color, `[${inst.status}]`)} ${theme.fg("accent", inst.name)} ${theme.fg("dim", inst.runId.slice(0, RUNID_SHORT_LENGTH))}${inst.error ? ` ${theme.fg("error", inst.error)}` : ""}`;
          })
          .join("\n");
        return new Text(lines, 0, 0);
      }

      const content = result.content as Array<{ type: string; text: string }> | undefined;
      const text = content?.[0];
      return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
    },
  });
}
