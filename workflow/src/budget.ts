/**
 * Workflow Extension — Budget Tracker
 *
 * Budget utilities — reserved for future use.
 * Current budget enforcement is in orchestrator.ts checkBudget().
 *
 * Pure calculation utility for token budget enforcement.
 * Does not depend on orchestrator, Pi API, or process concerns.
 *
 * Usage:
 *   const budget = new BudgetTracker(100_000, 30);
 *   budget.addUsage(500, 200);
 *   if (budget.isExhausted) { ... }
 *   if (budget.isTimeLimited) { ... }
 */

// ── BudgetTracker ─────────────────────────────────────────────

export class BudgetTracker {
  private readonly _total: number;
  private readonly _timeLimitMs: number | undefined;
  private readonly _startTime: number;
  private _used: number;

  /**
   * @param total  Total token budget (must be > 0)
   * @param timeLimitMinutes  Optional time limit in minutes (> 0 if set)
   */
  constructor(total: number, timeLimitMinutes?: number) {
    if (total <= 0) {
      throw new Error(`BudgetTracker: total must be positive, got ${total}`);
    }
    if (timeLimitMinutes !== undefined && timeLimitMinutes <= 0) {
      throw new Error(
        `BudgetTracker: timeLimitMinutes must be positive, got ${timeLimitMinutes}`,
      );
    }
    this._total = total;
    this._timeLimitMs =
      timeLimitMinutes !== undefined ? timeLimitMinutes * 60 * 1000 : undefined;
    this._startTime = Date.now();
    this._used = 0;
  }

  /**
   * Record token usage for an agent call.
   * Negative values throw; over-budget is silently accepted (caller checks isExhausted).
   */
  addUsage(inputTokens: number, outputTokens: number): void {
    if (inputTokens < 0 || outputTokens < 0) {
      throw new Error(
        `BudgetTracker: token counts cannot be negative, got input=${inputTokens}, output=${outputTokens}`,
      );
    }
    this._used += inputTokens + outputTokens;
  }

  /** Total tokens used so far. */
  get used(): number {
    return this._used;
  }

  /** Remaining tokens (clamped to 0). */
  get remaining(): number {
    return Math.max(0, this._total - this._used);
  }

  /** True when used >= total. */
  get isExhausted(): boolean {
    return this._used >= this._total;
  }

  /** True when used / total >= 0.9 (90 % warning threshold). */
  get isWarning(): boolean {
    return this._used / this._total >= 0.9;
  }

  /** True when a time limit was set and elapsed time exceeds it. */
  get isTimeLimited(): boolean {
    if (this._timeLimitMs === undefined) return false;
    return Date.now() - this._startTime > this._timeLimitMs;
  }

  /** Usage as a percentage (0–100). */
  get usagePercent(): number {
    return (this._used / this._total) * 100;
  }
}
