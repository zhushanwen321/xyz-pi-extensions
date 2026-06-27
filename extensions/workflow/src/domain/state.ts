/**
 * Workflow Extension — State Model & State Machine
 *
 * Status lifecycle:
 *   running ↔ paused → completed | failed | aborted | budget_limited | time_limited | state_lost
 *
 * Terminal states are irreversible. paused ↔ running is the only bidirectional
 * transition. state_lost is only assigned externally by reconstructState
 * (infra/state-store.ts) when a state file is missing/corrupt — never produced
 * by the internal state machine.
 *
 * Persistence (see infra/state-store.ts for the real mechanism):
 *   - Each run writes an independent <sessionDir>/workflow-state/<runId>.jsonl
 *     file, overwritten on every mutation (rewrite mode — no append, no GC).
 *   - A lightweight "workflow-state-link" pointer entry is appended to the
 *     session JSONL so reconstructState can find each run's latest snapshot.
 *   - deserializeInstance is backward-compatible (missing fields get defaults;
 *     legacy "created" status maps to "running").
 *
 * NOTE: serializeState/deserializeState + ENTRY_TYPE below are a LEGACY public
 * API kept for backward compatibility and covered by tests — the current
 * persistence layer uses serializeInstance/deserializeInstance instead.
 */

// ── Status type ───────────────────────────────────────────────

export type WorkflowStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "aborted"
  | "budget_limited"
  | "time_limited"
  | "state_lost";

export const ALL_STATUSES: readonly WorkflowStatus[] = [
  "running",
  "paused",
  "completed",
  "failed",
  "aborted",
  "budget_limited",
  "time_limited",
  "state_lost",
] as const;

// ── Supporting types ──────────────────────────────────────────

// ── Tool call tracking (FR-7) ──────────────────────────────
// Canonical definition — agent-pool.ts re-exports from here.

export interface ToolCallEntry {
  /** Tool name. */
  name: string;
  /** Args preview string. */
  input: string;
}

export interface WorkflowBudget {
  maxTokens?: number;
  maxCost?: number;
  maxTimeMs?: number;
  usedTokens: number;
  usedCost: number;
  /** Internal: whether 90% budget warning has been sent */
  _budgetWarningSent?: boolean;
}

export interface AgentResult {
  content: string;
  /** Validated data object from structured-output tool (when schema was provided). Source: tool_execution_end.result.details */
  parsedOutput?: unknown;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
  };
  durationMs?: number;
  error?: string;
  /** Tool calls collected from agent JSONL stream (FR-7). */
  toolCalls?: ToolCallEntry[];
}

export interface ExecutionTraceNode {
  stepIndex: number;
  agent: string;
  task: string;
  model: string;
  status: "pending" | "running" | "completed" | "failed";
  /** Phase name for TUI grouping. Set from explicit opts.phase or global _currentPhase. */
  phase?: string;
  startedAt?: string;
  completedAt?: string;
  result?: AgentResult;
  error?: string;
  verifyStrategy?: "internal" | "follow-up" | "none";
  /**
   * Pi session ID (uuidv7) for the subagent process.
   * Used to locate the session JSONL for post-run inspection.
   */
  sessionId?: string;
}

export interface WorkflowInstance {
  runId: string;
  name: string;
  description?: string;
  status: WorkflowStatus;
  callCache: Map<number, AgentResult>;
  trace: ExecutionTraceNode[];
  worker: string;
  startedAt?: string;
  pausedAt?: string;
  completedAt?: string;
  budget: WorkflowBudget;
  error?: string;
  /** Captured return value from workflow script (set on "return" message) */
  scriptResult?: unknown;
  /**
   * Worker-emitted console.* entries captured before failure. Surfaced
   * inside the TUI widget via renderLevel2 — never leaked to the input area.
   */
  errorLogs?: Array<{ level: "log" | "warn" | "error" | "info"; message: string }>;
}

// ── Serialization types ───────────────────────────────────────

interface SerializedCallCacheEntry {
  key: number;
  value: AgentResult;
}

type SerializedExecutionTraceNode = Omit<ExecutionTraceNode, "verifyStrategy">;

interface SerializedWorkflowInstance {
  runId: string;
  name: string;
  description?: string;
  status: WorkflowStatus;
  callCache: SerializedCallCacheEntry[];
  trace: SerializedExecutionTraceNode[];
  worker: string;
  startedAt?: string;
  pausedAt?: string;
  completedAt?: string;
  budget?: WorkflowBudget;
  error?: string;
  scriptResult?: unknown;
  errorLogs?: Array<{ level: "log" | "warn" | "error" | "info"; message: string }>;
}

export interface WorkflowStateEntry {
  type: typeof ENTRY_TYPE;
  instances: SerializedWorkflowInstance[];
}

// ── State machine ─────────────────────────────────────────────

export const TERMINAL_STATUSES: readonly WorkflowStatus[] = [
  "completed",
  "failed",
  "aborted",
  "budget_limited",
  "time_limited",
  "state_lost",
] as const;

/** All transitions defined. Empty array = terminal state (no outgoing transitions). */
export const VALID_TRANSITIONS: Record<WorkflowStatus, WorkflowStatus[]> = {
  running: ["paused", "completed", "failed", "aborted", "budget_limited", "time_limited"],
  paused: ["running", "aborted"],
  completed: [],
  failed: [],
  aborted: [],
  budget_limited: [],
  time_limited: [],
  // state_lost: set when external state file is missing/corrupt during rehydrate.
  // No internal transition reaches this state — it is assigned externally by
  // reconstructState when a pointer entry points to an unreadable file.
  // Currently reconstructState creates a state_lost placeholder instance so
  // the user can see the run existed (see index.ts reconstructState).
  state_lost: [],
};

export function isTerminal(status: WorkflowStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/**
 * Transition instance status. Throws if transition is invalid.
 * Terminal states (completed/failed/aborted/budget_limited/time_limited) cannot be exited.
 */
export function transitionStatus(instance: WorkflowInstance, to: WorkflowStatus): WorkflowStatus {
  if (!canTransition(instance.status, to)) {
    throw new Error(
      `Invalid state transition: ${instance.status} → ${to}. ` +
        `Allowed: [${VALID_TRANSITIONS[instance.status].join(", ")}]`,
    );
  }
  instance.status = to;
  return to;
}

// ── Entry type constant ───────────────────────────────────────

export const ENTRY_TYPE = "workflow-state";

// ── Serialization ─────────────────────────────────────────────

export function serializeInstance(instance: WorkflowInstance): SerializedWorkflowInstance {
  return {
    runId: instance.runId,
    name: instance.name,
    description: instance.description,
    status: instance.status,
    callCache: Array.from(instance.callCache.entries()).map(([key, value]) => ({ key, value })),
    trace: instance.trace.map(({ verifyStrategy: _verifyStrategy, ...rest }) => rest),
    worker: instance.worker,
    startedAt: instance.startedAt,
    pausedAt: instance.pausedAt,
    completedAt: instance.completedAt,
    budget: instance.budget,
    error: instance.error,
    scriptResult: instance.scriptResult,
    errorLogs: instance.errorLogs && instance.errorLogs.length > 0 ? instance.errorLogs : undefined,
  };
}

/**
 * Deserialize a stored workflow instance.
 * Backward compatible: missing budget fields get defaults.
 */
export function deserializeInstance(data: SerializedWorkflowInstance): WorkflowInstance {
  // Backward compat: old "created" status is dead after removing the create action
  const rawStatus = data.status as string;
  const status: WorkflowStatus = rawStatus === "created" ? "running" : data.status;
  return {
    runId: data.runId,
    name: data.name,
    description: data.description,
    status,
    callCache: new Map(
      (data.callCache ?? []).map((entry: SerializedCallCacheEntry) => [entry.key, entry.value]),
    ),
    trace: data.trace ?? [],
    worker: data.worker,
    startedAt: data.startedAt,
    pausedAt: data.pausedAt,
    completedAt: data.completedAt,
    budget: data.budget ?? { usedTokens: 0, usedCost: 0 },
    error: data.error,
    scriptResult: data.scriptResult,
    errorLogs: data.errorLogs,
  };
}

export function serializeState(instances: Map<string, WorkflowInstance>): WorkflowStateEntry {
  return {
    type: ENTRY_TYPE,
    instances: Array.from(instances.values()).map(serializeInstance),
  };
}

/**
 * Deserialize state entry into a Map<runId, WorkflowInstance>.
 * Returns empty Map for missing, malformed, or incompatible entries.
 */
export function deserializeState(entry: unknown): Map<string, WorkflowInstance> {
  const data = entry as WorkflowStateEntry | undefined;
  if (!data || typeof data !== "object" || data.type !== ENTRY_TYPE) {
    return new Map();
  }
  const instances = new Map<string, WorkflowInstance>();
  if (Array.isArray(data.instances)) {
    for (const inst of data.instances) {
      try {
        const instance = deserializeInstance(inst);
        instances.set(instance.runId, instance);
      // eslint-disable-next-line taste/no-silent-catch
      } catch {
        // Skip malformed entries for backward compatibility
      }
    }
  }
  return instances;
}

// ── Factory ───────────────────────────────────────────────────

export function createInstance(params: {
  runId: string;
  name: string;
  worker: string;
  budget?: Partial<WorkflowBudget>;
  status?: WorkflowStatus;
}): WorkflowInstance {
  return {
    runId: params.runId,
    name: params.name,
    status: params.status ?? "running",
    callCache: new Map(),
    trace: [],
    worker: params.worker,
    budget: {
      maxTokens: params.budget?.maxTokens,
      maxCost: params.budget?.maxCost,
      maxTimeMs: params.budget?.maxTimeMs,
      usedTokens: 0,
      usedCost: 0,
    },
  };
}
