/**
 * Workflow Orchestrator Events — Subscription API (FR-5)
 *
 * Provides per-runId event subscription for real-time TUI updates.
 * Orchestrator emits events at status transitions and trace updates;
 * views subscribe to receive them and trigger re-renders.
 *
 * Tick interval lifecycle:
 *   - Starts when first subscriber registers
 *   - Stops when last subscriber unsubscribes (prevents idle CPU waste)
 *   - Tick events fire every 1000ms with Date.now()
 */

import type { WorkflowStatus } from "./state.js";

// ── Public types ──────────────────────────────────────────────

export interface WorkflowEvent {
  type: "status" | "trace" | "node-update" | "tick";
  status?: WorkflowStatus;
  node?: {
    stepIndex: number;
    agent: string;
    status: string;
    phase?: string;
  };
  stepIndex?: number;
  now?: number;
}

// ── Constants ─────────────────────────────────────────────────

const TICK_INTERVAL_MS = 1000;

// ── WorkflowEventEmitter ──────────────────────────────────────

export class WorkflowEventEmitter {
  private readonly listeners = new Map<string, Set<(event: WorkflowEvent) => void>>();
  private tickTimer: ReturnType<typeof setInterval> | undefined = undefined;

  /**
   * Subscribe to events for a given runId.
   * Returns an unsubscribe function.
   * First subscription starts the tick interval.
   */
  subscribe(runId: string, listener: (event: WorkflowEvent) => void): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);

    // Start tick interval on first subscriber
    if (this.totalSubscriptionCount === 1) {
      this.startTick();
    }

    return () => {
      set!.delete(listener);
      if (set!.size === 0) {
        this.listeners.delete(runId);
      }
      // Stop tick when no subscribers remain
      if (this.totalSubscriptionCount === 0) {
        this.stopTick();
      }
    };
  }

  /**
   * Get the number of subscribers for a given runId.
   */
  getSubscriptionCount(runId: string): number {
    return this.listeners.get(runId)?.size ?? 0;
  }

  /**
   * Emit an event to all subscribers for a given runId.
   * Exceptions in listeners are caught and logged — never affect the caller.
   */
  emit(runId: string, event: WorkflowEvent): void {
    const set = this.listeners.get(runId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch (err) {
        console.error("[workflow-events] listener error:", err);
      }
    }
  }

  /** Total subscribers across all runIds. */
  private get totalSubscriptionCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) {
      count += set.size;
    }
    return count;
  }

  private startTick(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      const now = Date.now();
      // Snapshot listeners to avoid mutation during iteration.
      // A listener may call unsubscribe() synchronously, which would
      // modify the map/set while we're iterating it.
      const snapshot = [...this.listeners.entries()].map(
        ([runId, set]) => [runId, [...set]] as const,
      );
      for (const [_runId, listeners] of snapshot) {
        for (const listener of listeners) {
          try {
            listener({ type: "tick", now });
          } catch (err) {
            console.error("[workflow-events] tick listener error:", err);
          }
        }
      }
    }, TICK_INTERVAL_MS);
    // Don't prevent process exit
    if (this.tickTimer && typeof this.tickTimer === "object" && "unref" in this.tickTimer) {
      this.tickTimer.unref();
    }
  }

  private stopTick(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }
}
