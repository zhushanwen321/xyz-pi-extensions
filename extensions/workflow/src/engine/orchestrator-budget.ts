import type { RunResources } from "../domain/run-resources.js";
import {
  isTerminal,
  type WorkflowInstance,
  type WorkflowStatus,
} from "../domain/state.js";
import { type TerminateDeps,terminateInstance } from "./terminate-instance.js";

const BUDGET_WARNING_THRESHOLD = 0.9;

export interface BudgetCallbacks {
  postMessage(runId: string, msg: unknown): void;
  terminateWorker(runId: string, keepController?: boolean): void;
  cleanupAllTempFiles(): void;
  persistState(): Promise<void>;
  onCompletion?(runId: string): void;
  /** Wave 5: lookup per-run resources so terminateInstance can run the unified pipeline. */
  getRun(runId: string): RunResources | undefined;
  /** Wave 5: nullify the pool on terminal transitions. */
  deletePool(runId: string): void;
  /** Wave 5: emit status event (passed through to terminateInstance). */
  emit(runId: string, event: { type: "status"; status: WorkflowStatus }): void;
}

/**
 * Build TerminateDeps from BudgetCallbacks (shared by checkBudget /
 * scheduleTimeBudgetCheck). Eliminates the duplicated 6-line literal.
 */
function terminateDepsFromBudget(callbacks: BudgetCallbacks): TerminateDeps {
  return {
    terminateWorker: (id, keepController) => callbacks.terminateWorker(id, keepController),
    cleanupAllTempFiles: () => callbacks.cleanupAllTempFiles(),
    emit: callbacks.emit,
    persistState: () => callbacks.persistState(),
    deletePool: callbacks.deletePool,
    onCompletion: callbacks.onCompletion,
  };
}

/**
 * Check token and cost budgets. If exceeded, send a budget-warning
 * to the Worker, terminate it, and mark the instance as
 * budget_limited (terminal).
 */
export async function checkBudget(
  instance: WorkflowInstance | undefined,
  runId: string,
  callbacks: BudgetCallbacks,
): Promise<void> {
  if (!instance || isTerminal(instance.status)) return;

  const b = instance.budget;
  let exceeded = false;
  let reason = "";

  // Round 3 MF3: maxTokens>0 守卫——maxTokens===0 时 usedTokens>=0 恒真，
  // 首个 agent 完成即误判 budget_limited。maxTokens 缺省或为 0 视为不限制。
  if (b.maxTokens !== undefined && b.maxTokens > 0 && b.usedTokens >= b.maxTokens) {
    exceeded = true;
    reason = `Token budget exceeded: ${b.usedTokens} >= ${b.maxTokens}`;
  } else if (b.maxCost !== undefined && b.maxCost > 0 && b.usedCost >= b.maxCost) {
    exceeded = true;
    reason = `Cost budget exceeded: ${b.usedCost} >= ${b.maxCost}`;
  }

  // Send warning at 90% threshold (only once)
  if (!exceeded && !b._budgetWarningSent && b.maxTokens !== undefined && b.maxTokens > 0 && b.usedTokens >= b.maxTokens * BUDGET_WARNING_THRESHOLD) {
    b._budgetWarningSent = true;
    callbacks.postMessage(runId, {
      type: "budget-warning",
      budget: b,
      reason: `Token budget warning: ${b.usedTokens} >= ${Math.floor(b.maxTokens * BUDGET_WARNING_THRESHOLD)} (90%)`,
    });
  }

  if (exceeded) {
    callbacks.postMessage(runId, { type: "budget-warning", budget: b, reason });
    // postMessage fires BEFORE termination so the worker receives the
    // budget-warning before being killed (preserves prior observable
    // behavior: worker logs the reason before exit).
    const run = callbacks.getRun(runId);
    // run 不存在 = 已被 deleteRun 清理，无需也无从终止。
    if (!run) return;
    await terminateInstance(
      run,
      {
        status: "budget_limited",
        error: reason,
        cleanupWorker: true,
        cleanupTempFiles: true,
        deletePool: true,
      },
      terminateDepsFromBudget(callbacks),
    );
  }
}

/**
 * Schedule a one-shot time budget check. Fires after maxTimeMs
 * and marks the instance as time_limited if still running.
 */
export function scheduleTimeBudgetCheck(
  getInstance: (runId: string) => WorkflowInstance | undefined,
  runId: string,
  maxTimeMs: number,
  callbacks: BudgetCallbacks,
): void {
  const timer = setTimeout(async () => {
    const instance = getInstance(runId);
    if (!instance || isTerminal(instance.status) || instance.status !== "running") return;
    if (!instance.startedAt) return;

    const elapsed = Date.now() - new Date(instance.startedAt).getTime();
    if (elapsed >= maxTimeMs) {
      const reason = `Time budget exceeded: ${elapsed}ms >= ${maxTimeMs}ms`;
      callbacks.postMessage(runId, {
        type: "budget-warning",
        budget: instance.budget,
        reason,
      });
      const run = callbacks.getRun(runId);
      // run 不存在 = 已被 deleteRun 清理，无需也无从终止。
      if (!run) return;
      await terminateInstance(
        run,
        {
          status: "time_limited",
          error: reason,
          cleanupWorker: true,
          cleanupTempFiles: true,
          deletePool: true,
        },
        terminateDepsFromBudget(callbacks),
      );
    }
  }, maxTimeMs);
  timer.unref();
}
