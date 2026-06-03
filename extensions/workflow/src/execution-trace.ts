/**
 * Execution Trace — Append-only trace logging for workflow runs.
 *
 * Each trace node is persisted via pi.appendEntry("workflow-trace", { runId, node })
 * as a CustomEntry in the session's JSONL. Updates append a new entry (same runId,
 * same stepIndex) — loadTrace groups by stepIndex and takes the latest.
 *
 * Entry type: "workflow-trace"
 * Data shape: { runId: string; node: ExecutionTraceNode }
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry, CustomEntry } from "@mariozechner/pi-coding-agent";
import type { ExecutionTraceNode } from "./state.js";

// ── Constants ───────────────────────────────────────────────────

/** Entry type used for pi.appendEntry and reading trace entries. */
const TRACE_ENTRY_TYPE = "workflow-trace";

// ── Internal helpers ────────────────────────────────────────────

/** Data shape stored in each CustomEntry.data field. */
interface TraceEntryData {
  runId: string;
  node: ExecutionTraceNode;
}

/**
 * Type guard: check if a SessionEntry is a trace entry of our type.
 */
function isTraceEntry(entry: SessionEntry): entry is CustomEntry<TraceEntryData> {
  return entry.type === "custom" && (entry as CustomEntry).customType === TRACE_ENTRY_TYPE;
}

// ── Core functions ──────────────────────────────────────────────

/**
 * Append a trace node for a given workflow run.
 * The node is persisted as a custom entry in the session JSONL.
 *
 * @param pi  - ExtensionAPI instance (for appendEntry)
 * @param runId - Workflow run identifier
 * @param node - Trace node to record
 */
export function appendTraceNode(
  pi: ExtensionAPI,
  runId: string,
  node: ExecutionTraceNode,
): void {
  pi.appendEntry(TRACE_ENTRY_TYPE, { runId, node });
}

/**
 * Load all trace nodes for a given workflow run.
 *
 * Because entries are append-only and nodes may be updated (via updateNodeStatus),
 * this groups entries by stepIndex and returns only the latest entry for each,
 * sorted by stepIndex ascending.
 *
 * @param ctx   - ExtensionContext (provides sessionManager.getEntries)
 * @param runId - Workflow run identifier
 * @returns Trace nodes for the run, in step order
 */
export function loadTrace(
  ctx: ExtensionContext,
  runId: string,
): ExecutionTraceNode[] {
  const entries = ctx.sessionManager.getEntries();
  const latestByStep = new Map<number, ExecutionTraceNode>();

  for (const entry of entries) {
    if (!isTraceEntry(entry)) continue;
    if (entry.data?.runId !== runId) continue;
    // Later entries overwrite earlier ones for the same stepIndex
    latestByStep.set(entry.data.node.stepIndex, entry.data.node);
  }

  return Array.from(latestByStep.values()).sort(
    (a, b) => a.stepIndex - b.stepIndex,
  );
}

/**
 * Update the status of a trace node within a workflow run.
 * Appends a new entry with the updated node (append-only persistence).
 * Automatically sets startedAt/completedAt timestamps.
 *
 * @param pi        - ExtensionAPI instance
 * @param ctx       - ExtensionContext
 * @param runId     - Workflow run identifier
 * @param stepIndex - Step index of the node to update
 * @param status    - New status
 * @throws If no node with the given stepIndex is found in the trace
 */
export function updateNodeStatus(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runId: string,
  stepIndex: number,
  status: ExecutionTraceNode["status"],
): void {
  const trace = loadTrace(ctx, runId);
  const node = trace.find((n) => n.stepIndex === stepIndex);
  if (!node) {
    throw new Error(
      `Trace node not found: runId=${runId}, stepIndex=${stepIndex}`,
    );
  }

  const now = new Date().toISOString();
  const updatedNode: ExecutionTraceNode = {
    ...node,
    status,
    startedAt: node.startedAt ?? (status === "running" ? now : undefined),
    completedAt:
      status === "completed" || status === "failed" ? now : undefined,
  };

  appendTraceNode(pi, runId, updatedNode);
}

// ── Summary ─────────────────────────────────────────────────────

export interface TraceSummary {
  /** Total number of trace nodes */
  total: number;
  /** Nodes still in pending status */
  pending: number;
  /** Nodes currently running */
  running: number;
  /** Nodes completed successfully */
  completed: number;
  /** Nodes that failed */
  failed: number;
  /** Wall-clock duration in milliseconds (from earliest startedAt to latest completedAt, or now for still-running) */
  duration: number;
}

/**
 * Compute a summary of trace nodes for a workflow run.
 * Duration is wall-clock time from the earliest startedAt to the latest
 * completedAt (using Date.now() for still-running nodes).
 *
 * @param ctx   - ExtensionContext
 * @param runId - Workflow run identifier
 */
export function getTraceSummary(
  ctx: ExtensionContext,
  runId: string,
): TraceSummary {
  const trace = loadTrace(ctx, runId);
  let completed = 0;
  let failed = 0;
  let pending = 0;
  let running = 0;

  for (const node of trace) {
    switch (node.status) {
      case "completed":
        completed++;
        break;
      case "failed":
        failed++;
        break;
      case "running":
        running++;
        break;
      case "pending":
        pending++;
        break;
    }
  }

  // Calculate wall-clock duration
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = Number.NEGATIVE_INFINITY;

  for (const node of trace) {
    if (node.startedAt) {
      const t = new Date(node.startedAt).getTime();
      if (t < minStart) minStart = t;
    }
    if (node.completedAt) {
      const t = new Date(node.completedAt).getTime();
      if (t > maxEnd) maxEnd = t;
    }
  }

  // For still-running nodes, use now as the end time
  const now = Date.now();
  if (running > 0 && nodeStartedButNotCompleted(trace, running, maxEnd)) {
    maxEnd = now;
  }

  const duration =
    Number.isFinite(minStart) && maxEnd >= minStart ? maxEnd - minStart : 0;

  return {
    total: trace.length,
    completed,
    failed,
    pending,
    running,
    duration,
  };
}

/**
 * Check if there are running nodes that have started but not completed,
 * meaning maxEnd needs to be extended to include their ongoing work.
 */
function nodeStartedButNotCompleted(
  trace: ExecutionTraceNode[],
  running: number,
  maxEnd: number,
): boolean {
  if (running === 0) return false;
  // If maxEnd was set by a completed node and all running nodes started before it,
  // we don't need to extend. Only extend if a running node has a startedAt
  // that is after maxEnd, or if no completedAt exists at all.
  if (maxEnd <= 0) return true;
  return trace.some(
    (n) =>
      n.status === "running" &&
      n.startedAt !== undefined &&
      new Date(n.startedAt).getTime() > maxEnd,
  );
}
