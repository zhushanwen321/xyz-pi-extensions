/**
 * Workflow Extension — Factory Skeleton
 *
 * Events registered:
 *   session_start  — reconstruct state from Session JSONL
 *   session_tree   — rehydrate on branch switch
 *   session_shutdown — clean up session-scoped state
 *
 * Tool: "workflow"
 *   Actions: pause, resume, abort, status
 *   Enforces state machine rules (terminal states are irreversible)
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "typebox";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
  sendCompletionNotification,
  type WorkflowCommandsState,
} from "./commands.js";
import { renderWorkflowList } from "./widget.js";
import { registerGenerateTool } from "./tool-generate.js";

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

  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
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

    // Event-driven completion notification (replaces polling)
    // Fires when a workflow reaches any terminal state
    orch.onCompletion = (runId) => {
      const instance = orch.getInstance(runId);
      if (instance) sendCompletionNotification(pi, runId, instance);
    };

    // Set up TUI widget showing workflow list overview
    if (ctx.hasUI) {
      const summaryList = orch.list();
      ctx.ui.setWidget("workflow", renderWorkflowList(summaryList, ctx.ui.theme));
    }
  });

  pi.on("session_tree", async (_event: any, ctx: ExtensionContext) => {
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

    orch.onCompletion = (runId) => {
      const instance = orch.getInstance(runId);
      if (instance) sendCompletionNotification(pi, runId, instance);
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
      "Control running workflow instances: pause, resume, abort, or check status.\n" +
      "\n" +
      "For STARTING a new workflow, use \`workflow-run\` instead.\n" +
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
      "Use workflow tool for status checks and lifecycle control of running workflows",
      "To START a new workflow, use workflow-run tool instead",
      "Workflows can be paused and resumed across sessions",
    ],
    parameters: WorkflowParams,

    async execute(_toolCallId: string, params: Static<typeof WorkflowParams>, _signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext) {
      const sessionId = ctx.sessionManager.getSessionId();
      lastSessionId = sessionId;
      const orch = orchestrators.get(sessionId);
      if (!orch) {
        return {
          content: [{ type: "text", text: "Workflow orchestrator not initialized" }],
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

          // Delegate to orchestrator (handles Worker lifecycle)
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

          // Fallback: direct state machine transition if orchestrator fails
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

    renderCall(args: any, theme: Theme, _context?: any) {
      const action = args.action as string;
      let text =
        theme.fg("toolTitle", theme.bold("workflow ")) +
        theme.fg("muted", action);
      if (args.name) text += ` ${theme.fg("accent", args.name as string)}`;
      if (args.runId) text += ` ${theme.fg("dim", (args.runId as string).slice(0, 20))}`;
      if (args.error) text += ` ${theme.fg("error", "error")}`;
      return new Text(text, 0, 0);
    },

    renderResult(result: any, _options: any, theme: Theme, _context?: any) {
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
    name: Type.String({ description: "Exact workflow name or natural language task description" }),
    mode: Type.Optional(
      StringEnum(["auto", "force"] as const, {
        description: "'auto' (default): search existing workflows, confirm with user. 'force': skip confirmation, AI decides",
      }),
    ),
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
      "Run a workflow by exact name or natural language task description. Searches .pi/workflows/ " +
      "for matching scripts before executing.\n\n" +
      "Two modes:\n" +
      "- auto (default): Searches existing workflows first. Exact match → run after user confirmation. " +
      "Fuzzy match → list candidates for user to choose. No match → suggest workflow-generate. " +
      "Always confirms with user before execution.\n" +
      "- force: Skips confirmation. AI decides best match or returns error if none found. " +
      "Use only when user explicitly says \"just run it\" or \"skip confirmation\".\n\n" +
      "When to use:\n" +
      "- User says \"run workflow X\" → exact name, auto mode\n" +
      "- User describes a task that sounds like a workflow → natural language, auto mode\n" +
      "- User says \"just do it\" or \"no need to ask\" → force mode\n" +
      "- User asks for a reusable pipeline → auto mode, may lead to workflow-generate\n\n" +
      "Do NOT use for single-step tasks that bash can handle directly.",
    promptSnippet:
      "Run a workflow by name or task description with auto-discovery",
    promptGuidelines: [
      "Default to auto mode. Only use force when user explicitly skips confirmation.",
      "name can be an exact workflow name OR a natural language task description.",
      "When name is descriptive (not an exact workflow name), the tool searches existing workflows by description.",
      "If no workflow matches, the tool returns suggestions. Use workflow-generate to create one, then confirm with user.",
      "Do NOT use workflow-run for single-step tasks. It's for multi-step agent pipelines.",
      "After workflow-run returns 'started', results arrive asynchronously. Check with workflow { action: status }.",
    ],
    parameters: WorkflowRunParams,

    async execute(_toolCallId: string, params: Static<typeof WorkflowRunParams>, _signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext) {
      const sessionId = ctx.sessionManager.getSessionId();
      lastSessionId = sessionId;
      const orch = orchestrators.get(sessionId);
      if (!orch) {
        return {
          content: [{ type: "text", text: "Workflow orchestrator not initialized" }],
          isError: true,
        };
      }

      const name = params.name as string;
      const mode = (params.mode as string | undefined) ?? "auto";
      const args = (params.args as Record<string, unknown> | undefined) ?? {};
      const tokens = params.tokens as number | undefined;
      const time = params.time as number | undefined;

      // ── Discovery: search existing workflows ──────────────
      const { loadWorkflows } = await import("./config-loader.js");
      let allWorkflows: Awaited<ReturnType<typeof loadWorkflows>>;
      try {
        allWorkflows = await loadWorkflows();
      } catch {
        allWorkflows = [];
      }
      const available = allWorkflows.filter((wf) => wf.available);

      // Step 1: Exact name match
      const exactMatch = available.find(
        (wf) => wf.name === name,
      );

      if (exactMatch) {
        if (mode === "force") {
          // Force mode: run directly
          const runId = await orch.run(name, args, tokens, time);
          cmdState.lastRunId = runId;
          if (ctx.hasUI) {
            ctx.ui.setWidget("workflow", renderWorkflowList(orch.list(), ctx.ui.theme));
          }
          return {
            content: [{ type: "text" as const, text: `Started workflow '${name}' (${runId}) [force mode]` }],
            details: { action: "run", runId, status: "running", name } satisfies WorkflowRunDetails,
          };
        }
        // Auto mode: confirm with user
        pi.sendUserMessage(
          `Found workflow '${exactMatch.name}': ${exactMatch.description || "(no description)"}\n` +
          `Source: [${exactMatch.source}] Path: ${exactMatch.path}\n\n` +
          `Confirm: use workflow-run with name '${exactMatch.name}' and mode 'force' to execute, ` +
          `or tell the user the path and wait for their confirmation.`,
        );
        return {
          content: [{ type: "text" as const, text: `Found exact match: '${exactMatch.name}'. Awaiting user confirmation.` }],
          details: { action: "run", runId: "", status: "pending", name: exactMatch.name } satisfies WorkflowRunDetails,
        };
      }

      // Step 2: Fuzzy match by description/name keywords
      const inputLower = name.toLowerCase();
      const inputWords = inputLower.split(/\s+/).filter((w) => w.length > 2);
      const candidates = available.filter((wf) => {
        const text = `${wf.name} ${wf.description}`.toLowerCase();
        return inputWords.some((w) => text.includes(w));
      });

      if (candidates.length > 0) {
        const candidateList = candidates
          .map((wf) => `  - ${wf.name}: ${wf.description || "(no description)"} [${wf.source}]`)
          .join("\n");

        if (mode === "force") {
          // Force mode: pick first candidate and run
          const best = candidates[0];
          const runId = await orch.run(best.name, args, tokens, time);
          cmdState.lastRunId = runId;
          if (ctx.hasUI) {
            ctx.ui.setWidget("workflow", renderWorkflowList(orch.list(), ctx.ui.theme));
          }
          return {
            content: [{ type: "text" as const, text: `Started workflow '${best.name}' (${runId}) [force mode, fuzzy match]` }],
            details: { action: "run", runId, status: "running", name: best.name } satisfies WorkflowRunDetails,
          };
        }
        // Auto mode: list candidates for user
        pi.sendUserMessage(
          `No exact match for '${name}', but found ${candidates.length} related workflow(s):\n${candidateList}\n\n` +
          `Ask the user which one to use, or if they want to create a new workflow. ` +
          `If they choose one, use workflow-run with the exact name and mode 'force'.`,
        );
        return {
          content: [{ type: "text" as const, text: `Found ${candidates.length} fuzzy match(es) for '${name}'. Awaiting user choice.` }],
          details: { action: "run", runId: "", status: "pending", name } satisfies WorkflowRunDetails,
        };
      }

      // Step 3: No match
      const fullList = available.length > 0
        ? available.map((wf) => `  - ${wf.name}: ${wf.description || "(no description)"}`).join("\n")
        : "  (none)";

      if (mode === "force") {
        return {
          content: [{
            type: "text" as const,
            text: `No matching workflow for '${name}'. Available:\n${fullList}\n\nRe-run with mode='auto' for interactive selection, or use workflow-generate to create a new workflow.`,
          }],
          isError: true,
        };
      }
      // Auto mode: suggest creating new
      pi.sendUserMessage(
        `No workflow matches '${name}'. Available workflows:\n${fullList}\n\n` +
          `Suggestions:\n` +
          `1. If one of the above looks suitable, use workflow-run with its exact name.\n` +
          `2. If none fits, use workflow-generate to create a new temporary workflow.\n` +
          `3. Before executing a generated workflow, ALWAYS show the script path and wait for user confirmation.`,
      );
      return {
        content: [{ type: "text" as const, text: `No match for '${name}'. Suggestions sent to conversation.` }],
        details: { action: "run", runId: "", status: "pending", name } satisfies WorkflowRunDetails,
      };
    },

    renderCall(args: any, theme: Theme, _context?: any) {
      const name = args.name as string;
      const text =
        theme.fg("toolTitle", theme.bold("workflow-run ")) +
        theme.fg("accent", name);
      return new Text(text, 0, 0);
    },

    renderResult(result: any, _options: any, theme: Theme, _context?: any) {
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

  // ── Auto-inject script format spec on workflow-generate calls ──────
  // When AI calls workflow-generate, inject the full format reference as
  // a steering message so it's available in the next LLM call for corrections.
  const skillPath = resolve(import.meta.dirname!, "skills/workflow-script-format/SKILL.md");
  let cachedFormatSpec: string | undefined;

  pi.on("tool_call", async (event: Record<string, unknown>) => {
    if (event.toolName !== "workflow-generate") return;

    if (!cachedFormatSpec) {
      try {
        const raw = readFileSync(skillPath, "utf-8");
        // Strip YAML frontmatter (---...---)
        const body = raw.replace(/^---[\s\S]*?---\n*/, "");
        cachedFormatSpec = body.trim();
      } catch {
        return; // SKILL.md not found — skip injection
      }
    }

    pi.sendUserMessage(
      `[Workflow Script Format Reference — MANDATORY]\n${cachedFormatSpec}`,
      { deliverAs: "steer" },
    );
  });

}
