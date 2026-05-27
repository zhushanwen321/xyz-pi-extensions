/**
 * Workflow Extension — TUI Widget
 *
 * Combines three Pi TUI mechanisms:
 *   1. setWidget  — list view (all workflow status overview)
 *   2. registerShortcut — ctrl+shift+p (pause) / ctrl+shift+x (abort) / ctrl+shift+r (retry)
 *   3. ctx.ui.custom() overlay — detail view (single workflow trace nodes)
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import {
  Container,
  Spacer,
  Text,
  type Component,
} from "@earendil-works/pi-tui";

import type { WorkflowOrchestrator, WorkflowInstanceSummary } from "./orchestrator.js";
import type { WorkflowInstance } from "./state.js";

// ── Color helpers ──────────────────────────────────────────────

/** Map a workflow status to a TUI theme color token. */
function statusColor(
  status: string,
  theme: Theme,
): string {
  switch (status) {
    case "completed":
      return theme.fg("success", `[${status}]`);
    case "running":
      return theme.fg("warning", `[${status}]`);
    case "failed":
    case "aborted":
    case "budget_limited":
    case "time_limited":
      return theme.fg("error", `[${status}]`);
    case "paused":
      return theme.fg("accent", `[${status}]`);
    default:
      return theme.fg("muted", `[${status}]`);
  }
}

/** Map a trace node status to a TUI theme color token. */
function nodeColor(node: { status: string }, theme: Theme): string {
  switch (node.status) {
    case "completed":
      return theme.fg("success", `[${node.status}]`);
    case "failed":
      return theme.fg("error", `[${node.status}]`);
    case "running":
      return theme.fg("warning", `[${node.status}]`);
    default:
      return theme.fg("muted", `[${node.status}]`);
  }
}

// ── setWidget renderer: workflow list overview ─────────────────

/**
 * Render a compact overview of all workflow instances with trace progress.
 * Returns an array of lines suitable for ctx.ui.setWidget().
 * Similar to subagent's collapsed parallel view.
 */
export function renderWorkflowList(
  instances: WorkflowInstanceSummary[],
  theme: Theme,
): string[] {
  if (instances.length === 0) {
    return [theme.fg("muted", "  No workflows")];
  }

  const lines: string[] = [];
  for (const inst of instances) {
    const elapsed =
      inst.startedAt && inst.completedAt
        ? `${((new Date(inst.completedAt).getTime() - new Date(inst.startedAt).getTime()) / 1000).toFixed(0)}s`
        : inst.startedAt
          ? `${((Date.now() - new Date(inst.startedAt).getTime()) / 1000).toFixed(0)}s`
          : "-";

    // Header line: status + name + elapsed + budget
    const completedNodes = inst.traceNodes?.filter((n) => n.status === "completed").length ?? 0;
    const totalNodes = inst.traceNodes?.length ?? 0;
    const progress = totalNodes > 0 ? ` ${completedNodes}/${totalNodes} agents` : "";

    lines.push(
      `${statusColor(inst.status, theme)} ${theme.fg("accent", inst.name)} ${theme.fg("dim", elapsed)}${theme.fg("muted", progress)}`,
    );

    // Trace node lines (like subagent collapsed view)
    if (inst.traceNodes && inst.traceNodes.length > 0) {
      for (const node of inst.traceNodes) {
        const icon = node.status === "completed" ? "\u2705"
          : node.status === "running" ? "\u23F3"
          : node.status === "failed" ? "\u274C"
          : "\u25CB";
        const nodeDuration =
          node.startedAt && node.completedAt
            ? `${((new Date(node.completedAt).getTime() - new Date(node.startedAt).getTime()) / 1000).toFixed(1)}s`
            : node.startedAt
              ? `${((Date.now() - new Date(node.startedAt).getTime()) / 1000).toFixed(0)}s...`
              : "";
        const taskPreview =
          node.task.length > 60 ? `${node.task.slice(0, 60)}...` : node.task;
        lines.push(
          `  ${icon} ${theme.fg("dim", `#${node.stepIndex}`)} ${theme.fg("muted", taskPreview)} ${theme.fg("dim", nodeDuration)}`,
        );
      }
    }
  }
  return lines;
}

// ── ctx.ui.custom() overlay: single workflow detail ────────────

/**
 * Build a TUI Component showing the full ExecutionTrace for a workflow.
 * Used with ctx.ui.custom() as an overlay.
 */
export function renderWorkflowDetail(
  instance: WorkflowInstance,
  theme: Theme,
): Component {
  const container = new Container();

  // ── Header line ──
  const header = `${theme.fg("toolTitle", theme.bold(instance.name))} ${statusColor(instance.status, theme)} ${theme.fg("dim", instance.runId.slice(0, 20))}`;
  container.addChild(new Text(header, 0, 0));
  container.addChild(new Spacer(1));

  // ── Budget info ──
  const b = instance.budget;
  const budgetParts: string[] = [];
  budgetParts.push(`Token: ${b.usedTokens}${b.maxTokens !== undefined ? ` / ${b.maxTokens}` : ""}`);
  budgetParts.push(`Cost: ${b.usedCost.toFixed(4)}${b.maxCost !== undefined ? ` / ${b.maxCost}` : ""}`);
  if (instance.startedAt) {
    const elapsed = instance.completedAt
      ? `${((new Date(instance.completedAt).getTime() - new Date(instance.startedAt).getTime()) / 1000).toFixed(0)}s`
      : `${((Date.now() - new Date(instance.startedAt).getTime()) / 1000).toFixed(0)}s (running)`;
    budgetParts.push(`Time: ${elapsed}`);
  }
  container.addChild(new Text(theme.fg("dim", budgetParts.join(" | ")), 0, 0));
  container.addChild(new Spacer(1));

  // ── Error info ──
  if (instance.error) {
    container.addChild(new Text(theme.fg("error", `Error: ${instance.error}`), 0, 0));
    container.addChild(new Spacer(1));
  }

  // ── Trace nodes ──
  if (instance.trace.length === 0) {
    container.addChild(new Text(theme.fg("muted", "(no trace nodes)"), 0, 0));
  } else {
    container.addChild(new Text(theme.fg("muted", theme.bold("Execution Trace:")), 0, 0));
    container.addChild(new Spacer(1));

    for (const node of instance.trace) {
      // Node header: status + agent + step
      const nodeHeader = `${nodeColor(node, theme)} ${theme.fg("accent", node.agent)} ${theme.fg("dim", `(#${node.stepIndex})`)}`;
      container.addChild(new Text(nodeHeader, 0, 0));

      // Task preview
      const taskPreview =
        node.task.length > 80
          ? `${node.task.slice(0, 80)}...`
          : node.task;
      container.addChild(new Text(theme.fg("dim", `  ${taskPreview}`), 0, 0));

      // Error detail on failed nodes
      if (node.status === "failed" && node.result?.error) {
        container.addChild(
          new Text(theme.fg("error", `  Error: ${node.result.error.slice(0, 120)}`), 0, 0),
        );
      }

      container.addChild(new Spacer(1));
    }
  }

  // ── Footer hint ──
  container.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand, Esc to close)"), 0, 0));

  return container;
}

// ── Shortcut registration ─────────────────────────────────────

/**
 * Register global TUI shortcuts for workflow lifecycle operations.
 *
 *   ctrl+shift+p — Pause the last-started workflow (or prompt to select)
 *   ctrl+shift+x — Abort the last-started workflow
 *   ctrl+shift+r — Retry the last-started workflow
 */
export function registerWorkflowShortcuts(
  api: ExtensionAPI,
  orchestrators: Map<string, WorkflowOrchestrator>,
  cmdState: { lastRunId: string | null },
): void {
  // ── ctrl+shift+p: Pause ──
  api.registerShortcut("ctrl+shift+p", {
    description: "Pause the most recently started workflow",
    handler: async (ctx: ExtensionContext) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const orch = orchestrators.get(sessionId);
      if (!orch) return;

      const runId = cmdState.lastRunId;
      if (!runId) {
        ctx.ui.notify("No workflow to pause", "warning");
        return;
      }

      try {
        orch.pause(runId);
        ctx.ui.notify(`Paused ${runId.slice(0, 16)}...`, "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Pause failed: ${msg}`, "error");
      }
    },
  });

  // ── ctrl+shift+x: Abort ──
  api.registerShortcut("ctrl+shift+x", {
    description: "Abort the most recently started workflow",
    handler: async (ctx: ExtensionContext) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const orch = orchestrators.get(sessionId);
      if (!orch) return;

      const runId = cmdState.lastRunId;
      if (!runId) {
        ctx.ui.notify("No workflow to abort", "warning");
        return;
      }

      try {
        orch.abort(runId);
        ctx.ui.notify(`Aborted ${runId.slice(0, 16)}...`, "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Abort failed: ${msg}`, "error");
      }
    },
  });

  // ── ctrl+shift+r: Retry ──
  api.registerShortcut("ctrl+shift+r", {
    description: "Retry the most recently started workflow",
    handler: async (ctx: ExtensionContext) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const orch = orchestrators.get(sessionId);
      if (!orch) return;

      const runId = cmdState.lastRunId;
      if (!runId) {
        ctx.ui.notify("No workflow to retry", "warning");
        return;
      }

      // Retry by re-running the workflow with its original args
      const instance = orch.getInstance(runId);
      if (!instance) {
        ctx.ui.notify("Workflow instance not found", "error");
        return;
      }

      // Re-run with same name, no args passthrough (orchestrator.run starts fresh)
      try {
        const newRunId = await orch.run(
          instance.name,
          {},
          instance.budget.maxTokens,
          instance.budget.maxTimeMs,
        );
        cmdState.lastRunId = newRunId;
        ctx.ui.notify(
          `Retrying '${instance.name}' → ${newRunId.slice(0, 16)}...`,
          "info",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Retry failed: ${msg}`, "error");
      }
    },
  });
}
