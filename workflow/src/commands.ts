/**
 * Workflow Extension — Commands & Completion Notification
 *
 * Commands:
 *   /workflow run <name> [--args key=val ...] [--tokens N] [--time N]
 *   /workflows              — interactive panel (delegates to widget overlay)
 *   /workflow list          — list running workflows
 *   /workflow abort <run-id>
 *
 * Completion notification sends a custom message via pi.sendMessage()
 * when a workflow reaches a terminal state, with a _render descriptor
 * for GUI display.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { type WorkflowOrchestrator } from "./orchestrator.js";
import { type WorkflowInstance, isTerminal } from "./state.js";

// ── Types ──────────────────────────────────────────────────────

export interface WorkflowCommandsState {
  /** Last-started run ID, used by shortcuts that need a default target */
  lastRunId: string | null;
}

// ── Completion Notification ────────────────────────────────────

const statusToItemStatus = (
  s: string,
): "pending" | "in_progress" | "completed" | "failed" | "cancelled" => {
  if (s === "completed") return "completed";
  if (s === "failed") return "failed";
  if (s === "running") return "in_progress";
  return "pending";
};

/**
 * Send a completion notification via pi.sendMessage when a workflow
 * reaches a terminal state. Includes a _render descriptor for GUI.
 */
export function sendCompletionNotification(
  api: ExtensionAPI,
  runId: string,
  instance: WorkflowInstance,
): void {
  api.sendMessage({
    customType: "workflow-result",
    content:
      `Workflow '${instance.name}' (${runId.slice(0, 16)}...) completed: ${instance.status}`,
    display: true,
    details: {
      runId,
      name: instance.name,
      status: instance.status,
      traceLength: instance.trace.length,
      _render: {
        type: "task-list" as const,
        data: {
          title: `Workflow: ${instance.name} (${runId.slice(0, 12)}...)`,
          items: instance.trace.map((node) => ({
            label: `[${node.stepIndex}] ${node.agent}: ${node.task.slice(0, 80)}`,
            status: statusToItemStatus(node.status),
            detail: node.result?.content?.slice(0, 120),
          })),
          summary: `Status: ${instance.status} | ${instance.trace.length} agent calls`,
        },
      },
    },
  });
}

// ── Argument parsing ───────────────────────────────────────────

interface ParsedRunArgs {
  name: string;
  args: Record<string, unknown>;
  tokens?: number;
  time?: number;
}

function parseRunArgs(tokens: string[]): ParsedRunArgs {
  const name = tokens[0] ?? "";
  const result: ParsedRunArgs = { name, args: {} };

  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "--args") {
      i++;
      while (i < tokens.length && !tokens[i].startsWith("--")) {
        const kv = tokens[i].split("=", 2);
        if (kv.length === 2) {
          result.args[kv[0]] = kv[1];
        }
        i++;
      }
    } else if (token === "--tokens") {
      i++;
      if (i < tokens.length) {
        result.tokens = Number(tokens[i]);
        i++;
      }
    } else if (token === "--time") {
      i++;
      if (i < tokens.length) {
        result.time = Number(tokens[i]);
        i++;
      }
    } else {
      // Unknown token, skip
      i++;
    }
  }

  return result;
}

// ── Poll helper ────────────────────────────────────────────────

/**
 * Start polling a workflow instance for terminal state.
 * Calls sendCompletionNotification when done. The timer is unref'd
 * so it does not prevent process exit.
 */
function pollForCompletion(
  api: ExtensionAPI,
  orch: WorkflowOrchestrator,
  runId: string,
): void {
  const pollInterval = setInterval(() => {
    const inst = orch.getInstance(runId);
    if (!inst || isTerminal(inst.status)) {
      clearInterval(pollInterval);
      if (inst) {
        sendCompletionNotification(api, runId, inst);
      }
    }
  }, 2000);

  if (typeof pollInterval === "object" && "unref" in pollInterval) {
    pollInterval.unref();
  }
}

// ── Command registration ───────────────────────────────────────

/**
 * Register /workflow and /workflows commands.
 * The `orchestrators` map allows command handlers to resolve the
 * correct orchestrator for the current session at runtime.
 */
export function registerWorkflowCommands(
  api: ExtensionAPI,
  orchestrators: Map<string, WorkflowOrchestrator>,
  cmdState: WorkflowCommandsState,
): void {
  // ── /workflow ────────────────────────────────────────────────

  api.registerCommand("workflow", {
    description: [
      "Workflow management.",
      "Subcommands:",
      "  run <name> [--args key=val ...] [--tokens N] [--time N]  Start a workflow",
      "  list              List running workflow instances",
      "  abort <run-id>    Abort a running workflow",
      "",
      "Shorthand: /workflows opens the interactive panel.",
    ].join("\n"),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length === 0) {
        ctx.ui.notify("Usage: /workflow run|list|abort", "warning");
        return;
      }

      const sessionId = ctx.sessionManager.getSessionId();
      const orch = orchestrators.get(sessionId);
      if (!orch) {
        ctx.ui.notify("Workflow system not initialized", "error");
        return;
      }

      const subcommand = parts[0];

      switch (subcommand) {
        // ── run ──
        case "run": {
          const parsed = parseRunArgs(parts.slice(1));
          if (!parsed.name) {
            ctx.ui.notify("Usage: /workflow run <name> [--args ...]", "warning");
            return;
          }

          try {
            const runId = await orch.run(
              parsed.name,
              parsed.args,
              parsed.tokens,
              parsed.time,
            );
            cmdState.lastRunId = runId;
            ctx.ui.notify(
              `Started '${parsed.name}' (${runId.slice(0, 16)}...)`,
              "info",
            );
            pollForCompletion(api, orch, runId);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`Failed: ${msg}`, "error");
          }
          return;
        }

        // ── list ──
        case "list": {
          const instances = orch.list();
          if (instances.length === 0) {
            ctx.ui.notify("No workflow instances in current session", "info");
            return;
          }
          const lines = instances.map((inst) => {
            const ts = inst.startedAt
              ? new Date(inst.startedAt).toLocaleTimeString()
              : "-";
            return (
              `[${inst.status}] ${inst.name} (${inst.runId.slice(0, 16)}...) ${ts}` +
              (inst.error ? ` error: ${inst.error}` : "")
            );
          });
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }

        // ── abort ──
        case "abort": {
          const runId = parts[1];
          if (!runId) {
            ctx.ui.notify("Usage: /workflow abort <run-id>", "warning");
            return;
          }
          try {
            orch.abort(runId);
            ctx.ui.notify(`Aborted ${runId.slice(0, 16)}...`, "info");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`Abort failed: ${msg}`, "error");
          }
          return;
        }

        default:
          ctx.ui.notify(
            `Unknown: ${subcommand}. Use: run | list | abort`,
            "warning",
          );
      }
    },
  });

  // ── /workflows — interactive panel ───────────────────────────

  api.registerCommand("workflows", {
    description: "Open interactive workflow overview panel",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/workflows requires interactive mode", "error");
        return;
      }

      const sessionId = ctx.sessionManager.getSessionId();
      const orch = orchestrators.get(sessionId);
      if (!orch) {
        ctx.ui.notify("Workflow system not initialized", "error");
        return;
      }

      const instances = orch.list();
      if (instances.length === 0) {
        ctx.ui.notify("No workflows in current session", "info");
        return;
      }

      // Show a select dialog listing all workflows
      const displayNames = instances.map(
        (i) => `${i.name} (${i.runId.slice(0, 12)}...) [${i.status}]`,
      );
      const selected = await ctx.ui.select("Select workflow:", displayNames);
      if (!selected) return;

      const idx = displayNames.indexOf(selected);
      if (idx === -1) return;

      const instance = orch.getInstance(instances[idx].runId);
      if (!instance) return;

      // Show details via notify (fallback when ctx.ui.custom is complex)
      const traceLines = instance.trace.map(
        (node) =>
          `  [${node.stepIndex}] ${node.agent}: ${node.status} — ${node.task.slice(0, 60)}`,
      );
      ctx.ui.notify(
        [
          `Workflow: ${instance.name} (${instance.runId.slice(0, 16)}...)`,
          `Status: ${instance.status}`,
          `Nodes: ${instance.trace.length}`,
          ...traceLines,
        ].join("\n"),
        "info",
      );
    },
  });
}
