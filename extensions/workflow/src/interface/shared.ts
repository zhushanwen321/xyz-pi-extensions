/**
 * Shared types, constants, and helpers for workflow interface tools.
 *
 * Extracted from index.ts to allow each tool file (tool-workflow /
 * tool-workflow-run / tool-lint) to register independently without
 * duplicating the render/summary plumbing.
 */

import { isTerminal,type WorkflowStatus } from "../domain/state.js";
import { type WorkflowInstanceSummary,WorkflowOrchestrator } from "../orchestrator.js";

// ── Constants ─────────────────────────────────────────────────

export const MS_PER_SEC = 1000;
export const RUNID_SLICE_LENGTH = 20;
export const RUNID_SHORT_LENGTH = 16;
export const INPUT_WORD_MIN_LENGTH = 2;

// ── Details type for TUI / _render ────────────────────────────

export interface InstanceSummary {
  runId: string;
  name: string;
  status: WorkflowStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface WorkflowRenderDescriptor {
  type: "summary-table";
  data: {
    title: string;
    columns: Array<{ key: string; label: string; width?: number; valueType?: "text" | "status" | "duration" | "number" }>;
    rows: Record<string, unknown>[];
  };
  summary?: string;
}

export interface WorkflowDetails {
  action: string;
  instances: InstanceSummary[];
  agents?: Array<{ name: string; source: string; model?: string }>;
  _render?: WorkflowRenderDescriptor;
}

// ── Helpers ───────────────────────────────────────────────────

export function buildRender(
  summaries: WorkflowInstanceSummary[],
): WorkflowRenderDescriptor {
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
            ? `${((new Date(inst.completedAt).getTime() - new Date(inst.startedAt).getTime()) / MS_PER_SEC).toFixed(0)}s`
            : inst.startedAt
              ? `${((Date.now() - new Date(inst.startedAt).getTime()) / MS_PER_SEC).toFixed(0)}s (running)`
              : "-";
        return { name: inst.name, status: inst.status, worker: inst.worker, duration };
      }),
    },
  };
}

export function toInstanceSummary(summary: WorkflowInstanceSummary): InstanceSummary {
  return {
    runId: summary.runId,
    name: summary.name,
    status: summary.status,
    startedAt: summary.startedAt,
    completedAt: summary.completedAt,
    error: summary.error,
  };
}

// ── Shared dependency surface passed from the factory ─────────

/**
 * Per-factory state that the lifecycle tools (workflow / workflow-run)
 * need from the extension entry. The factory owns these so they are
 * scoped to a single extension instance and not shared module-globally.
 */
export interface WorkflowToolDeps {
  /** Session-id → orchestrator map owned by the factory. */
  orchestrators: Map<string, WorkflowOrchestrator>;
  /** Tracks last session id for session_shutdown (which receives no ctx). */
  lsRef: { lastSessionId: string };
  /** Reentry guard shared by workflow + workflow-run lifecycle actions. */
  guard: { isProcessing: boolean };
}
