/**
 * Workflow Extension — State Model & State Machine
 *
 * Status lifecycle:
 *   created → running ↔ paused → completed | failed | aborted | budget_limited | time_limited
 *
 * Terminal states (completed, failed, aborted, budget_limited, time_limited)
 * are irreversible. paused ↔ running is the only bidirectional transition.
 *
 * Persistence:
 *   - pi.appendEntry("workflow-state", serializedState) on every mutation
 *   - session_start rehydrates from Session JSONL entries
 *   - deserializeState is backward-compatible (missing fields get defaults)
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
  /** Structured output parsed from agent response when schema was provided */
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
}

export interface ExecutionTraceNode {
  stepIndex: number;
  agent: string;
  task: string;
  model: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
  result?: AgentResult;
  error?: string;
  verifyStrategy?: "internal" | "follow-up" | "none";
}

export interface WorkflowInstance {
  runId: string;
  name: string;
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
