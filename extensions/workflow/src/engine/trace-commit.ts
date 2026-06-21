/**
 * Trace node commit helper.
 *
 * Centralises the repeated "find trace node → mutate → append → emit" sequence
 * used by agent-call-handler.ts for both stale-context and normal completion paths.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { AgentResult, WorkflowInstance } from "../domain/state.js";
import { appendTraceNode } from "../infra/execution-trace.js";
import type { WorkflowEventEmitter } from "./orchestrator-events.js";

export interface TraceCommitPatch {
	status: "completed" | "failed";
	result: AgentResult;
	sessionId?: string;
}

/**
 * Update an existing trace node and synchronise it to persistence + events.
 * Silently returns if the node does not exist.
 */
export function commitTraceNode(
	pi: ExtensionAPI,
	events: WorkflowEventEmitter,
	instance: WorkflowInstance,
	runId: string,
	callId: number,
	patch: TraceCommitPatch,
): void {
	const traceNode = instance.trace.find((n) => n.stepIndex === callId);
	if (!traceNode) return;

	traceNode.status = patch.status;
	traceNode.sessionId = patch.sessionId;
	traceNode.result = patch.result;
	traceNode.completedAt = new Date().toISOString();

	appendTraceNode(pi, runId, traceNode);

	events.emit(runId, {
		type: "node-update",
		stepIndex: callId,
		node: {
			stepIndex: traceNode.stepIndex,
			agent: traceNode.agent,
			status: traceNode.status,
			phase: traceNode.phase,
		},
	});
}
