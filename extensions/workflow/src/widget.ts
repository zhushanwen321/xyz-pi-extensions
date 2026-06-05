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
  type Component,
  Container,
  Spacer,
  Text,
} from "@mariozechner/pi-tui";

import type { WorkflowInstanceSummary,WorkflowOrchestrator } from "./orchestrator.js";
import type { WorkflowInstance } from "./state.js";

// ── Constants ─────────────────────────────────────────────────

const MS_PER_SEC = 1000;
const TASK_PREVIEW_LENGTH = 50;
const MAX_VISIBLE_NODES = 6;
const DETAIL_TASK_PREVIEW_LENGTH = 80;
const ERROR_PREVIEW_LENGTH = 120;
const RUNID_PREVIEW_LENGTH = 20;
const SHORT_RUNID_LENGTH = 16;
const DURATION_DECIMALS = 0;
const NODE_DURATION_DECIMALS = 1;
const COST_DECIMALS = 4;

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

// ── Node collapsing helper ───────────────────────────────────

type CollapsedEntry =
  | { type: "node"; node: { stepIndex: number; status: string; agent: string; task: string; startedAt?: string; completedAt?: string } }
  | { type: "summary"; count: number; names: string; totalDuration: string };

/**
 * Collapse consecutive completed nodes into a single summary line
 * when total nodes exceed MAX_VISIBLE_NODES.
 */
function collapseNodes(
  nodes: Array<{ stepIndex: number; status: string; agent: string; task: string; startedAt?: string; completedAt?: string }>,
): CollapsedEntry[] {
  if (nodes.length <= MAX_VISIBLE_NODES) {
    return nodes.map((node) => ({ type: "node" as const, node }));
  }

  const result: CollapsedEntry[] = [];
  let completedBatch: typeof nodes = [];

  const flushCompleted = () => {
    if (completedBatch.length === 0) return;
    if (completedBatch.length === 1) {
      result.push({ type: "node", node: completedBatch[0] });
    } else {
      const names = completedBatch
        .map((n) => n.agent !== "unknown" ? n.agent : `#${n.stepIndex}`)
        .join(", ");
      const totalMs = completedBatch.reduce((sum, n) => {
        if (!n.startedAt || !n.completedAt) return sum;
        return sum + (new Date(n.completedAt).getTime() - new Date(n.startedAt).getTime());
      }, 0);
      result.push({
        type: "summary",
        count: completedBatch.length,
        names,
        totalDuration: `${(totalMs / MS_PER_SEC).toFixed(NODE_DURATION_DECIMALS)}s`,
      });
    }
    completedBatch = [];
  };

  for (const node of nodes) {
    if (node.status === "completed") {
      completedBatch.push(node);
    } else {
      flushCompleted();
      result.push({ type: "node", node });
    }
  }
  flushCompleted();

  return result;
}

// ── Trace node helpers ────────────────────────────────────────

/** Deduplicate trace nodes by stepIndex, keeping the latest entry. */
function dedupeTraceNodes(
  traceNodes: Array<{ stepIndex: number; status: string; agent: string; task: string; startedAt?: string; completedAt?: string }>,
): Array<{ stepIndex: number; status: string; agent: string; task: string; startedAt?: string; completedAt?: string }> {
  const deduped = new Map<number, typeof traceNodes[0]>();
  for (const node of traceNodes) {
    deduped.set(node.stepIndex, node);
  }
  return Array.from(deduped.values()).sort((a, b) => a.stepIndex - b.stepIndex);
}

/** Format a node's icon (ASCII, no emoji). */
function nodeIcon(status: string): string {
  return status === "completed" ? "✓"
    : status === "running" ? "●"
    : status === "failed" ? "✗"
    : "○";
}

/** Compute duration string for a trace node. */
function nodeDurationStr(node: { startedAt?: string; completedAt?: string }): string {
  return node.startedAt && node.completedAt
    ? `${((new Date(node.completedAt).getTime() - new Date(node.startedAt).getTime()) / MS_PER_SEC).toFixed(NODE_DURATION_DECIMALS)}s`
    : node.startedAt
      ? `${((Date.now() - new Date(node.startedAt).getTime()) / MS_PER_SEC).toFixed(DURATION_DECIMALS)}s...`
      : "";
}

/** Derive display label from agent description or task prompt. */
function nodeLabel(node: { agent: string; task: string }): string {
  const raw = (node.agent && node.agent !== "unknown")
    ? node.agent
    : node.task.replace(/[\r\n]+/g, " ").slice(0, 30);
  return raw.length > TASK_PREVIEW_LENGTH
    ? `${raw.slice(0, TASK_PREVIEW_LENGTH)}...` : raw;
}

/** Render a single collapsed entry (summary or node) to a themed line. */
function renderCollapsedItem(
  item: CollapsedEntry,
  theme: Theme,
): string {
  if (item.type === "summary") {
    return `  ${theme.fg("dim", `✓ ${item.count} completed (${item.names}) ${item.totalDuration}`)}`;
  }
  const node = item.node;
  const icon = nodeIcon(node.status);
  const duration = nodeDurationStr(node);
  const label = nodeLabel(node);
  const textColor = node.status === "completed" ? "dim" : "muted";
  return `  ${icon} ${theme.fg("dim", `#${node.stepIndex}`)} ${theme.fg(textColor, label)} ${theme.fg("dim", duration)}`;
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
    return [];
  }

  const lines: string[] = [];
  for (const inst of instances) {
    const elapsed =
      inst.startedAt && inst.completedAt
        ? `${((new Date(inst.completedAt).getTime() - new Date(inst.startedAt).getTime()) / MS_PER_SEC).toFixed(DURATION_DECIMALS)}s`
        : inst.startedAt
          ? `${((Date.now() - new Date(inst.startedAt).getTime()) / MS_PER_SEC).toFixed(DURATION_DECIMALS)}s`
          : "-";

    // Header line: status + name + elapsed + budget
    const completedNodes = inst.traceNodes?.filter((n) => n.status === "completed").length ?? 0;
    const totalNodes = inst.traceNodes?.length ?? 0;
    const progress = totalNodes > 0 ? ` ${completedNodes}/${totalNodes} agents` : "";

    lines.push(
      `${statusColor(inst.status, theme)} ${theme.fg("accent", inst.name)} ${theme.fg("dim", elapsed)}${theme.fg("muted", progress)}`,
    );

    // Trace node lines (deduped, collapsed)
    if (inst.traceNodes && inst.traceNodes.length > 0) {
      const nodes = dedupeTraceNodes(inst.traceNodes);
      const collapsed = collapseNodes(nodes);
      for (const item of collapsed) {
        lines.push(renderCollapsedItem(item, theme));
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
  const header = `${theme.fg("toolTitle", theme.bold(instance.name))} ${statusColor(instance.status, theme)} ${theme.fg("dim", instance.runId.slice(0, RUNID_PREVIEW_LENGTH))}`;
  container.addChild(new Text(header, 0, 0));
  container.addChild(new Spacer(1));

  // ── Budget info ──
  const b = instance.budget;
  const budgetParts: string[] = [];
  budgetParts.push(`Token: ${b.usedTokens}${b.maxTokens !== undefined ? ` / ${b.maxTokens}` : ""}`);
  budgetParts.push(`Cost: ${b.usedCost.toFixed(COST_DECIMALS)}${b.maxCost !== undefined ? ` / ${b.maxCost}` : ""}`);
  if (instance.startedAt) {
    const elapsed = instance.completedAt
      ? `${((new Date(instance.completedAt).getTime() - new Date(instance.startedAt).getTime()) / MS_PER_SEC).toFixed(DURATION_DECIMALS)}s`
      : `${((Date.now() - new Date(instance.startedAt).getTime()) / MS_PER_SEC).toFixed(DURATION_DECIMALS)}s (running)`;
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
        node.task.length > DETAIL_TASK_PREVIEW_LENGTH
          ? `${node.task.slice(0, DETAIL_TASK_PREVIEW_LENGTH)}...`
          : node.task;
      container.addChild(new Text(theme.fg("dim", `  ${taskPreview}`), 0, 0));

      // Error detail on failed nodes
      if (node.status === "failed" && node.result?.error) {
        container.addChild(
          new Text(theme.fg("error", `  Error: ${node.result.error.slice(0, ERROR_PREVIEW_LENGTH)}`), 0, 0),
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
        ctx.ui.notify(`Paused ${runId.slice(0, SHORT_RUNID_LENGTH)}...`, "info");
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
        ctx.ui.notify(`Aborted ${runId.slice(0, SHORT_RUNID_LENGTH)}...`, "info");
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
          `Retrying '${instance.name}' → ${newRunId.slice(0, SHORT_RUNID_LENGTH)}...`,
          "info",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Retry failed: ${msg}`, "error");
      }
    },
  });
}
