/**
 * Execution Trace — Append-only trace logging for workflow runs.
 *
 * Each trace node is persisted via pi.appendEntry("workflow-trace", { runId, node })
 * as a CustomEntry in the session's JSONL.
 *
 * Entry type: "workflow-trace"
 * Data shape: { runId: string; node: ExecutionTraceNode }
 *
 * Note: trace reading/aggregation helpers were removed as dead code.
 * Re-add from git history if a trace-inspection surface is needed.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { ExecutionTraceNode } from "../domain/state.js";

/** Entry type used for pi.appendEntry and reading trace entries. */
const TRACE_ENTRY_TYPE = "workflow-trace";

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
