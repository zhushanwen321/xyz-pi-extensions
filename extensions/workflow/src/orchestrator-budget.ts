import { isTerminal, transitionStatus, type WorkflowInstance } from "./domain/state.js";

const BUDGET_WARNING_THRESHOLD = 0.9;

export interface BudgetCallbacks {
  postMessage(runId: string, msg: unknown): void;
  terminateWorker(runId: string): void;
  cleanupAllTempFiles(): void;
  persistState(): Promise<void>;
  onCompletion?(runId: string): void;
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

  if (b.maxTokens !== undefined && b.usedTokens >= b.maxTokens) {
    exceeded = true;
    reason = `Token budget exceeded: ${b.usedTokens} >= ${b.maxTokens}`;
  } else if (b.maxCost !== undefined && b.usedCost >= b.maxCost) {
    exceeded = true;
    reason = `Cost budget exceeded: ${b.usedCost} >= ${b.maxCost}`;
  }

  // Send warning at 90% threshold (only once)
  if (!exceeded && !b._budgetWarningSent && b.maxTokens !== undefined && b.usedTokens >= b.maxTokens * BUDGET_WARNING_THRESHOLD) {
    b._budgetWarningSent = true;
    callbacks.postMessage(runId, {
      type: "budget-warning",
      budget: b,
      reason: `Token budget warning: ${b.usedTokens} >= ${Math.floor(b.maxTokens * BUDGET_WARNING_THRESHOLD)} (90%)`,
    });
  }

  if (exceeded) {
    callbacks.postMessage(runId, { type: "budget-warning", budget: b, reason });
    callbacks.terminateWorker(runId);
    // Cleanup in-flight agent temp files that were killed mid-flight.
    callbacks.cleanupAllTempFiles();

    instance.error = reason;
    instance.completedAt = new Date().toISOString();
    transitionStatus(instance, "budget_limited");
    await callbacks.persistState();
    callbacks.onCompletion?.(runId);
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
      callbacks.postMessage(runId, {
        type: "budget-warning",
        budget: instance.budget,
        reason: `Time budget exceeded: ${elapsed}ms >= ${maxTimeMs}ms`,
      });
      callbacks.terminateWorker(runId);
      // Cleanup in-flight agent temp files that were killed mid-flight.
      callbacks.cleanupAllTempFiles();

      instance.error = `Time budget exceeded: ${elapsed}ms >= ${maxTimeMs}ms`;
      instance.completedAt = new Date().toISOString();
      transitionStatus(instance, "time_limited");
      await callbacks.persistState();
      callbacks.onCompletion?.(runId);
    }
  }, maxTimeMs);
  timer.unref();
}
