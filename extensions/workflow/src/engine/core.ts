/**
 * Engine 层共享访问契约。worker-manager/lifecycle/error-handlers 等模块通过此契约访问 orchestrator 状态。
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { RunResources } from "../domain/run-resources.js";
import type { WorkflowInstance } from "../domain/state.js";
import type { AgentRegistry } from "../infra/agent-discovery.js";
import type { AgentCallOpts } from "../infra/agent-pool.js";
import type { AgentCallContext } from "./agent-call-handler.js";
import type { ErrorHandlerContext } from "./error-handlers.js";
import type { BudgetCallbacks } from "./orchestrator-budget.js";
import type { WorkflowEventEmitter } from "./orchestrator-events.js";
import type { TerminateDeps } from "./terminate-instance.js";

/**
 * The slice of WorkflowOrchestrator that worker-manager / lifecycle functions
 * may touch. The orchestrator class `implements OrchestratorCore`; extracted
 * modules receive `this` and stay decoupled from the concrete class.
 *
 * Fields are `readonly` (the orchestrator owns mutation); methods are the
 * delegated entry points the modules call into.
 */
export interface OrchestratorCore {
  // ── State ──
  readonly pi: ExtensionAPI;
  readonly events: WorkflowEventEmitter;
  readonly sessionDir: string;
  readonly agentRegistry: AgentRegistry;
  readonly activeTempFiles: Set<string>;
  readonly runs: ReadonlyMap<string, RunResources>;
  onTraceUpdate?: (runId: string) => void;
  onCompletion?: (runId: string) => void;

  // ── Run map accessors ──
  getRun(runId: string): RunResources | undefined;
  setRun(runId: string, run: RunResources): void;
  deleteRun(runId: string): void;

  // ── Persistence / cleanup ──
  persistState(): Promise<void>;
  cleanupTempFile(fp: string): void;
  cleanupAllTempFiles(): void;

  // ── Worker-manager delegated methods (implemented in this module) ──
  startWorker(runId: string, instance: WorkflowInstance, scriptSource: string, args: Record<string, unknown>): void;
  terminateWorker(runId: string, keepController?: boolean): void;
  postMessage(runId: string, msg: unknown): void;
  handleWorkerMessage(runId: string, raw: unknown): Promise<void>;
  handleAgentCall(runId: string, instance: WorkflowInstance, callId: number, opts: AgentCallOpts, phase?: string): Promise<void>;
  pauseOnSignal(runId: string): void;
  recreateRunAbortController(runId: string): void;
  resolveAgentOpts(opts: AgentCallOpts): { opts: AgentCallOpts; error?: string };

  // ── Context factories (implemented in this module) ──
  errorHandlerContext(): ErrorHandlerContext;
  agentCallContext(): AgentCallContext;
  budgetCallbacks(): BudgetCallbacks;
  terminateDeps(): TerminateDeps;
}
