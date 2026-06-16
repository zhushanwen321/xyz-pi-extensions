/**
 * Agent call execution with retry + budget enforcement.
 * Extracted from orchestrator.ts to keep it under the 1000-line limit.
 *
 * executeWithRetry: pool.enqueue → accumulate budget → stale-context guard →
 * retry with exponential backoff → cache result + trace + budget check.
 *
 * Context injection mirrors orchestrator.errorHandlerContext() — the handler
 * stays stateless; all orchestrator state is passed via AgentCallContext.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { type AgentCallOpts, AgentPool } from "../infra/agent-pool.js";
import { appendTraceNode } from "../infra/execution-trace.js";
import { type BudgetCallbacks, checkBudget } from "./orchestrator-budget.js";
import { WorkflowEventEmitter } from "./orchestrator-events.js";
import {
	type AgentResult as StateAgentResult,
	type ExecutionTraceNode,
	type WorkflowInstance,
} from "../domain/state.js";

// ── Constants ─────────────────────────────────────────────────

const RETRY_BACKOFF_MS = 1000;
const MAX_AGENT_RETRIES = 3;
const EXPONENTIAL_BACKOFF_BASE = 2;

// P1-5: Stale context detection — matches patterns reported when
// pi's session context was compacted or canceled between agent calls.
export const STALE_CONTEXT_PATTERNS = ["stale context", "stalecontext", "context canceled", "aborted"];

/** Check if an error message indicates a stale/canceled pi session context. */
export function isStaleContextErrorMsg(msg: string | undefined): boolean {
	if (!msg) return false;
	const lower = msg.toLowerCase();
	return STALE_CONTEXT_PATTERNS.some((p) => lower.includes(p));
}

/** Check if a workflow instance has exhausted its token or cost budget. */
export function isBudgetExceeded(instance: WorkflowInstance): boolean {
	const b = instance.budget;
	return (b.maxTokens !== undefined && b.maxTokens > 0 && b.usedTokens >= b.maxTokens)
		|| (b.maxCost !== undefined && b.maxCost > 0 && b.usedCost >= b.maxCost);
}

/** Dependencies injected from WorkflowOrchestrator (see orchestrator.agentCallContext()). */
export interface AgentCallContext {
	pi: ExtensionAPI;
	events: WorkflowEventEmitter;
	runPools: Map<string, AgentPool>;
	runAbortControllers: Map<string, AbortController>;
	postMessage: (runId: string, msg: unknown) => void;
	persistState: () => Promise<void>;
	budgetCallbacks: () => BudgetCallbacks;
	/** Remove a single temp file (agent systemPrompt / schema instruction). Spawn 路径必需。 */
	cleanupTempFile: (filePath: string) => void;
	onTraceUpdate?: (runId: string) => void;
}

/**
 * Execute an agent call with retry logic. Retries up to MAX_AGENT_RETRIES
 * on failure with exponential backoff (1s, 2s, 4s).
 *
 * Budget semantics: if budget is exceeded when a retry is due, checkBudget
 * terminates the workflow instead of retrying (retrying past budget is pointless).
 */
export async function executeWithRetry(
	ctx: AgentCallContext,
	runId: string,
	callId: number,
	opts: AgentCallOpts,
	instance: WorkflowInstance,
	node: ExecutionTraceNode,
	attempt = 1,
): Promise<void> {
	const pool = ctx.runPools.get(runId);
	if (!pool) {
		// Pool already cleaned up (workflow terminated) — skip
		return;
	}
	// P1-2: Use per-run AbortController signal so terminateWorker can kill subprocesses
	const runController = ctx.runAbortControllers.get(runId);
	pool.enqueue(opts, runController?.signal).then(async (poolResult) => {
		// P0-2: Stale state check — instance may have been paused/aborted during agent call
		if (instance.status !== "running") return;

		// Round 5 MF#4 + Round 6 MF#5: 累加四项 token（对齐 agent-pool contextTokens），
		// retry 间的真实计费如实记录，否则 budget 限制被 retry/cache 双重放大/低估。
		if (poolResult.usage) {
			const u = poolResult.usage;
			instance.budget.usedTokens += u.input + u.output + u.cacheRead + u.cacheWrite;
			instance.budget.usedCost += u.cost;
		}

		// P1-5: Stale context detection — do not retry when pi's session context
		// is stale (e.g. after compact). Retrying the same call would just fail again.
		if (!poolResult.success && isStaleContextErrorMsg(poolResult.error)) {
			const traceNode = instance.trace.find((n) => n.stepIndex === callId);
			if (traceNode) {
				traceNode.status = "failed";
				traceNode.sessionId = poolResult.sessionId;
				traceNode.result = {
					content: poolResult.output,
					parsedOutput: poolResult.parsedOutput,
					usage: poolResult.usage,
					durationMs: poolResult.durationMs,
					error: poolResult.error,
					toolCalls: poolResult.toolCalls,
				};
				traceNode.completedAt = new Date().toISOString();
				appendTraceNode(ctx.pi, runId, traceNode);
				ctx.events.emit(runId, { type: "node-update", stepIndex: callId, node: { stepIndex: traceNode.stepIndex, agent: traceNode.agent, status: traceNode.status, phase: traceNode.phase } });
			}
			ctx.postMessage(runId, {
				type: "agent-result",
				callId,
				result: {
					content: poolResult.output,
					usage: poolResult.usage,
					error: poolResult.error,
					toolCalls: poolResult.toolCalls,
				},
				cached: false,
			});
			await ctx.persistState();
			ctx.onTraceUpdate?.(runId);
			// Cleanup temp file on stale context early return
			if (opts.systemPromptFiles) {
				for (const fp of opts.systemPromptFiles) ctx.cleanupTempFile(fp);
			}
			return;
		}

		const result: StateAgentResult = {
			content: poolResult.output,
			parsedOutput: poolResult.parsedOutput,
			usage: poolResult.usage,
			durationMs: poolResult.durationMs,
			error: poolResult.success ? undefined : poolResult.error,
			toolCalls: poolResult.toolCalls,
		};

		// Retry on failure with exponential backoff
		if (!poolResult.success && attempt < MAX_AGENT_RETRIES) {
			const delay = RETRY_BACKOFF_MS * Math.pow(EXPONENTIAL_BACKOFF_BASE, attempt - 1);
			setTimeout(() => {
				// P0-2 + Round 6 MF#6: stale state / abort / budget recheck before retry.
				// Budget 超限 → checkBudget 终止流程，不重试（重试只会突破预算且无意义）。
				// executeWithRetry 内部已 .catch pool.enqueue 的 rejection，无需外层兜底。
				if (instance.status !== "running" || !ctx.runAbortControllers.has(runId)) return;
				if (isBudgetExceeded(instance)) {
					void checkBudget(instance, runId, ctx.budgetCallbacks()).catch((err: unknown) => {
						console.error(`[workflow] budget check failed in retry path: ${err instanceof Error ? err.message : String(err)}`);
					});
					return;
				}
				void executeWithRetry(ctx, runId, callId, opts, instance, node, attempt + 1);
			}, delay);
			return;
		}

		// Cache the result for potential pause/resume
		instance.callCache.set(callId, result);

		// Send result back to worker
		ctx.postMessage(runId, { type: "agent-result", callId, result, cached: false });

		// Update trace node
		const traceNode = instance.trace.find((n) => n.stepIndex === callId);
		if (traceNode) {
			traceNode.status = poolResult.success ? "completed" : "failed";
			traceNode.sessionId = poolResult.sessionId;
			traceNode.result = result;
			traceNode.completedAt = new Date().toISOString();
			appendTraceNode(ctx.pi, runId, traceNode);
			ctx.events.emit(runId, { type: "node-update", stepIndex: callId, node: { stepIndex: traceNode.stepIndex, agent: traceNode.agent, status: traceNode.status, phase: traceNode.phase } });
		}
		// Push budget update to worker for dynamic budget functions
		ctx.postMessage(runId, {
			type: "budget-update",
			budget: { usedTokens: instance.budget.usedTokens, usedCost: instance.budget.usedCost },
		});

		// Enforce budget limits
		await checkBudget(instance, runId, ctx.budgetCallbacks());

		await ctx.persistState();
		ctx.onTraceUpdate?.(runId);

		// Cleanup temp file if it was created for agent system prompt
		if (opts.systemPromptFiles) {
			for (const fp of opts.systemPromptFiles) ctx.cleanupTempFile(fp);
		}
	})
		// Round 4 S2: 挂 catch 避免 unhandled rejection——worker.postMessage / persistState
		// 在 worker 已 terminate 的竞态下可能抛错，Node 默认 --unhandled-rejections=throw
		// 会使进程崩溃。错误已无关业务结果（state 同步失败由下次 persistState 修正）。
		.catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[workflow] executeWithRetry unhandled error for ${runId}/${callId}: ${message}`);
		});
}
