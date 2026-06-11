# Wave 4b: orchestrator.ts 拆分方案

## 目标

从 `orchestrator.ts`（971 行）提取两个新文件到 `src/engine/`：
- `worker-manager.ts` — Worker 线程生命周期管理
- `agent-executor.ts` — Agent 调用执行 + 重试

拆分后 orchestrator 缩小到约 530 行。

## 提取方案概述

### 职责划分

| 文件 | 职责 | 核心原则 |
|------|------|---------|
| **worker-manager.ts** | Worker 线程 CRUD、AbortController 管理、Worker 事件分发 | 只管线程本身，不关心消息内容语义 |
| **agent-executor.ts** | Agent 调用处理、重试、缓存、模型解析、stale context 检测 | 只管 agent 调用逻辑，不关心 Worker 线程管理 |
| **orchestrator.ts** | 公共 API（run/pause/resume/abort/retryNode/skipNode）、消息路由、Worker 错误恢复、状态持久化 | 协调者，委托给 worker-manager 和 agent-executor |

### 解耦策略

**不传递 `instances` Map 引用**。orchestrator 作为协调者：
- 调用 worker-manager 方法时，传递 instance 的特定字段（如 `instance.worker`、`instance.callCache`）
- 调用 agent-executor 方法时，直接传递 `instance` 对象引用（JS 对象是 by-reference，agent-executor 读取的 `instance.status` 始终是最新值）
- Worker 事件（message/error/exit）通过回调接口上抛到 orchestrator 路由

### 数据所有权

| 数据结构 | 归属 | 访问方式 |
|----------|------|---------|
| `instances` Map | orchestrator | orchestrator 直接访问；agent-executor 通过参数接收单个 instance |
| `workers` Map | worker-manager | 内部私有，暴露 `has(runId)` 查询 |
| `runAbortControllers` Map | worker-manager | 内部私有，暴露 `getSignal(runId)` 给 agent-executor |
| `runPools` Map | agent-executor | 内部私有 |
| `retryCounts` Map | agent-executor | 内部私有 |
| `runMetaMap` Map | orchestrator | 不传递给子模块；handleScriptError 留在 orchestrator 部分因为这个原因 |
| `activeTempFiles` Set | orchestrator | 通过参数/回调传递 |

### 关键决策：handleScriptError 留在 orchestrator

`handleScriptError` 需要同时访问：
- `retryCounts`（可移到 agent-executor）
- `runMetaMap`（获取 scriptSource/args 以重启 Worker）
- `startWorker()`（worker-manager 方法）
- `terminateWorker()`（worker-manager 方法）
- `recreateRunAbortController()`（worker-manager 方法）
- `instances`（状态更新）
- `events`（事件发射）

它横跨三个模块的职责，放在任何子模块都会引入大量回调/依赖。保持 **orchestrator 持有 handleScriptError**，通过 worker-manager 的公共方法操作 Worker。

同理 `handleWorkerError` 和 `handleWorkerExit` 也留在 orchestrator —— 它们直接操作 instance 状态机，与 orchestrator 的公共 API 方法（pause/abort）属于同一抽象层。

---

## 接口设计

### 1. WorkerManager 回调接口

```typescript
// worker-manager.ts

/** Worker 事件回调 —— 由 orchestrator 实现，WorkerManager 在 Worker 事件触发时调用 */
export interface WorkerEventCallbacks {
  /** Worker 发来消息（agent-call / return / error 等） */
  onMessage(runId: string, raw: unknown): void;
  /** Worker 线程抛出未捕获异常 */
  onError(runId: string, err: Error): void;
  /** Worker 线程退出 */
  onExit(runId: string, code: number, worker: Worker): void;
}
```

### 2. AgentExecutor 上下文接口

```typescript
// agent-executor.ts

/** AgentExecutor 所需的外部依赖 —— 由 orchestrator 构造并传入 */
export interface AgentExecutorContext {
  pi: ExtensionAPI;
  agentRegistry: AgentRegistry;
  sessionDir: string;
  activeTempFiles: Set<string>;
  events: WorkflowEventEmitter;
  /** 获取 per-run AbortController 的 signal（从 worker-manager 获取） */
  getRunSignal(runId: string): AbortSignal | undefined;
  /** 向 Worker 发消息（委托给 worker-manager） */
  postMessage(runId: string, msg: unknown): void;
  /** 持久化状态（委托给 orchestrator.persistState） */
  persistState(): Promise<void>;
  /** trace 更新回调 */
  onTraceUpdate?(runId: string): void;
  /** 清理单个临时文件 */
  cleanupTempFile(fp: string): void;
  /** 预算检查后的回调（终止 Worker、完成通知等） */
  checkBudget(instance: WorkflowInstance | undefined, runId: string): Promise<void>;
}
```

`checkBudget` 封装了 orchestrator-budget.ts 的调用 + 后续的 terminateWorker/cleanupAllTempFiles/persistState/onCompletion。这样 agent-executor 不需要知道 BudgetCallbacks 的全部细节。

### 3. Orchestrator 到子模块的委托关系

```
orchestrator
  ├── workerManager: WorkerManager
  │     .startWorker(runId, scriptPath, callCache, budget, args)
  │     .terminateWorker(runId)
  │     .postMessage(runId, msg)
  │     .recreateRunAbortController(runId, signal?)
  │     .has(runId): boolean
  │     .getSignal(runId): AbortSignal | undefined
  │
  └── agentExecutor: AgentExecutor
        .handleAgentCall(runId, instance, callId, opts, phase?)
        .setPool(runId, pool)
        .deleteRetryCount(runId)
```

---

## worker-manager.ts 完整代码

```typescript
/**
 * Worker Manager — Worker thread lifecycle management.
 *
 * Owns the `workers` and `runAbortControllers` Maps. Provides CRUD
 * operations for Worker threads and AbortController management.
 * Worker events (message/error/exit) are forwarded to the orchestrator
 * via the WorkerEventCallbacks interface.
 */

import { Worker } from "node:worker_threads";

import type { WorkflowBudget } from "../domain/state.js";
import { buildWorkerScript } from "./worker-script.js";

// ── Types ────────────────────────────────────────────────────

/** Worker event callbacks — implemented by orchestrator. */
export interface WorkerEventCallbacks {
  onMessage(runId: string, raw: unknown): void;
  onError(runId: string, err: Error): void;
  onExit(runId: string, code: number, worker: Worker): void;
}

// ── WorkerManager ─────────────────────────────────────────────

export class WorkerManager {
  private readonly workers = new Map<string, Worker>();
  private readonly runAbortControllers = new Map<string, AbortController>();
  private readonly callbacks: WorkerEventCallbacks;

  constructor(callbacks: WorkerEventCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Create and wire a Worker thread for a given run.
   *
   * @param runId       - Workflow run ID
   * @param scriptPath  - Original script file path (for workerData.scriptPath)
   * @param scriptSource - Transformed script source (export stripped, eval'd)
   * @param callCache   - Preserved call cache for resume
   * @param budget      - Current budget snapshot
   * @param args        - Workflow arguments (will be augmented with _runId)
   * @param workspace   - Current working directory
   */
  startWorker(
    runId: string,
    scriptPath: string,
    scriptSource: string,
    callCache: Map<number, unknown>,
    budget: WorkflowBudget,
    args: Record<string, unknown>,
    workspace: string,
  ): void {
    const workerCode = buildWorkerScript(scriptSource);
    const workerArgs = { ...args, _runId: runId };

    const worker = new Worker(workerCode, {
      eval: true,
      workerData: {
        scriptPath,
        args: workerArgs,
        callCache,
        budget,
        workspace,
        meta: {},
      },
    });

    worker.on("message", (raw: unknown) => {
      this.callbacks.onMessage(runId, raw);
    });

    worker.on("error", (err: Error) => {
      this.callbacks.onError(runId, err);
    });

    worker.on("exit", (code: number) => {
      this.callbacks.onExit(runId, code, worker);
    });

    this.workers.set(runId, worker);
  }

  /**
   * Terminate and clean up a worker thread. Also aborts all in-flight
   * agent subprocesses via the per-run AbortController.
   */
  terminateWorker(runId: string): void {
    const controller = this.runAbortControllers.get(runId);
    if (controller) {
      this.runAbortControllers.delete(runId);
      controller.abort();
    }

    const worker = this.workers.get(runId);
    if (worker) {
      this.workers.delete(runId);
      worker.terminate().catch(() => {
        console.warn(`Failed to terminate worker for ${runId}`);
      });
    }
  }

  /**
   * Post a message to the worker thread.
   */
  postMessage(runId: string, msg: unknown): void {
    const worker = this.workers.get(runId);
    if (worker) {
      worker.postMessage(msg);
    }
  }

  /**
   * Recreate AbortController for a run after terminateWorker aborted the old one.
   * Also re-wires the tool-level signal to the new controller if provided.
   */
  recreateRunAbortController(runId: string, signal?: AbortSignal): void {
    const newController = new AbortController();
    this.runAbortControllers.set(runId, newController);
    if (signal && !signal.aborted) {
      const onToolAbort = () => newController.abort();
      signal.addEventListener("abort", onToolAbort, { once: true });
    }
  }

  /**
   * Create a fresh AbortController for a run (used in `run()` setup).
   * Returns the controller so the caller can store or inspect it.
   */
  createAbortController(runId: string): AbortController {
    const controller = new AbortController();
    this.runAbortControllers.set(runId, controller);
    return controller;
  }

  /** Check if a worker is active for the given run. */
  has(runId: string): boolean {
    return this.workers.has(runId);
  }

  /** Get the AbortSignal for a run (used by agent-executor for subprocess cancellation). */
  getSignal(runId: string): AbortSignal | undefined {
    return this.runAbortControllers.get(runId)?.signal;
  }

  /** Remove the worker entry without terminating (for cases like "return" message where worker exits naturally). */
  removeWorker(runId: string): void {
    this.workers.delete(runId);
  }
}
```

**行数估算：~155 行**

---

## agent-executor.ts 完整代码

```typescript
/**
 * Agent Executor — handles agent call dispatch, retry logic,
 * stale context detection, and model resolution.
 *
 * Owns the `runPools` and `retryCounts` Maps. Orchestrator creates
 * pools in `run()` and passes them via `setPool()`. All agent-call
 * processing is delegated here.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { AgentCallOpts } from "../agent-pool.js";
import { cleanupTempFile as cleanupFile } from "../infra/agent-opts-resolver.js";
import { resolveAgentOpts as resolveOpts } from "../infra/agent-opts-resolver.js";
import { AgentRegistry } from "../infra/agent-discovery.js";
import { appendTraceNode } from "../execution-trace.js";
import { resolveModel } from "./model-resolver.js";
import { WorkflowEventEmitter } from "./orchestrator-events.js";
import {
  type AgentResult as StateAgentResult,
  type ExecutionTraceNode,
  type WorkflowInstance,
} from "../domain/state.js";

// ── Constants ─────────────────────────────────────────────────

const MAX_AGENT_RETRIES = 3;
const RETRY_BACKOFF_MS = 1000;
const EXPONENTIAL_BACKOFF_BASE = 2;

// P1-5: Stale context detection patterns
const STALE_CONTEXT_PATTERNS = [
  "stale context",
  "stalecontext",
  "context canceled",
  "aborted",
];

// ── Context interface ─────────────────────────────────────────

/** External dependencies provided by the orchestrator. */
export interface AgentExecutorContext {
  pi: ExtensionAPI;
  agentRegistry: AgentRegistry;
  sessionDir: string;
  activeTempFiles: Set<string>;
  events: WorkflowEventEmitter;
  getRunSignal(runId: string): AbortSignal | undefined;
  postMessage(runId: string, msg: unknown): void;
  persistState(): Promise<void>;
  onTraceUpdate?: (runId: string) => void;
  cleanupTempFile(fp: string): void;
  checkBudget(instance: WorkflowInstance | undefined, runId: string): Promise<void>;
}

// ── Helpers ───────────────────────────────────────────────────

function isStaleContextErrorMsg(msg: string | undefined): boolean {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return STALE_CONTEXT_PATTERNS.some((p) => lower.includes(p));
}

// ── AgentExecutor ─────────────────────────────────────────────

export class AgentExecutor {
  private readonly runPools = new Map<string, import("../agent-pool.js").AgentPool>();
  private readonly retryCounts = new Map<string, number>();
  private readonly ctx: AgentExecutorContext;

  constructor(ctx: AgentExecutorContext) {
    this.ctx = ctx;
  }

  /** Store a pool created by the orchestrator for a specific run. */
  setPool(runId: string, pool: import("../agent-pool.js").AgentPool): void {
    this.runPools.set(runId, pool);
  }

  /** Remove retry count for a run (used by retryNode). */
  deleteRetryCount(runId: string): void {
    this.retryCounts.delete(runId);
  }

  /**
   * Process an agent-call from the worker. Checks callCache first;
   * on miss, resolves agent opts, records trace, and executes with retry.
   */
  handleAgentCall(
    runId: string,
    instance: WorkflowInstance,
    callId: number,
    opts: AgentCallOpts,
    phase?: string,
  ): void {
    const cached = instance.callCache.get(callId);
    if (cached) {
      this.ctx.postMessage(runId, {
        type: "agent-result",
        callId,
        result: cached,
        cached: true,
      });
      return;
    }

    // Agent resolution
    const resolved = resolveOpts(
      opts,
      this.ctx.agentRegistry,
      this.ctx.sessionDir,
      this.ctx.activeTempFiles,
    );
    if (resolved.error) {
      const errorResult: StateAgentResult = { content: "", error: resolved.error };
      instance.callCache.set(callId, errorResult);
      this.ctx.postMessage(runId, {
        type: "agent-result",
        callId,
        result: errorResult,
        cached: false,
      });
      return;
    }
    let enrichedOpts = resolved.opts;

    // Resolve model from scene if needed (async, but we fire-and-forget
    // the top-level handleAgentCall, so we need to await inline)
    this.resolveAndExecute(runId, callId, enrichedOpts, instance, phase);
  }

  /** Resolve model then kick off execution with retry. */
  private async resolveAndExecute(
    runId: string,
    callId: number,
    opts: AgentCallOpts,
    instance: WorkflowInstance,
    phase?: string,
  ): Promise<void> {
    const resolvedModel = await resolveModel(opts);
    const enrichedOpts = resolvedModel ? { ...opts, model: resolvedModel } : opts;

    // Record pending trace node
    const now = new Date().toISOString();
    const node: ExecutionTraceNode = {
      stepIndex: callId,
      agent: opts.description ?? opts.agent ?? "unknown",
      task: opts.prompt,
      model: enrichedOpts.model ?? "default",
      status: "running",
      phase,
      startedAt: now,
    };
    instance.trace.push(node);
    appendTraceNode(this.ctx.pi, runId, node);
    this.ctx.events.emit(runId, {
      type: "trace",
      node: {
        stepIndex: node.stepIndex,
        agent: node.agent,
        status: node.status,
        phase: node.phase,
      },
    });
    this.ctx.onTraceUpdate?.(runId);

    this.executeWithRetry(runId, callId, enrichedOpts, instance, node);
  }

  /**
   * Execute an agent call with retry logic. Retries up to MAX_AGENT_RETRIES
   * on failure with exponential backoff (1s, 2s, 4s).
   */
  private async executeWithRetry(
    runId: string,
    callId: number,
    opts: AgentCallOpts,
    instance: WorkflowInstance,
    node: ExecutionTraceNode,
    attempt = 1,
  ): Promise<void> {
    const pool = this.runPools.get(runId);
    if (!pool) return; // Pool cleaned up — workflow terminated

    const signal = this.ctx.getRunSignal(runId);
    pool.enqueue(opts, signal).then(async (poolResult) => {
      // P0-2: Stale state check
      if (instance.status !== "running") return;

      // P1-5: Stale context — no retry, surface immediately
      if (!poolResult.success && isStaleContextErrorMsg(poolResult.error)) {
        this.handleStaleContext(runId, callId, instance, opts, poolResult);
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
          if (instance.status !== "running") return;
          if (!this.runPools.has(runId)) return;
          this.executeWithRetry(runId, callId, opts, instance, node, attempt + 1);
        }, delay);
        return;
      }

      // Cache result
      instance.callCache.set(callId, result);

      // Send result back to worker
      this.ctx.postMessage(runId, {
        type: "agent-result",
        callId,
        result,
        cached: false,
      });

      // Update trace node
      const traceNode = instance.trace.find((n) => n.stepIndex === callId);
      if (traceNode) {
        traceNode.status = poolResult.success ? "completed" : "failed";
        traceNode.sessionId = poolResult.sessionId;
        traceNode.result = result;
        traceNode.completedAt = new Date().toISOString();
        appendTraceNode(this.ctx.pi, runId, traceNode);
        this.ctx.events.emit(runId, {
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

      // Budget tracking
      if (poolResult.usage) {
        instance.budget.usedTokens += poolResult.usage.input + poolResult.usage.output;
        instance.budget.usedCost += poolResult.usage.cost;
      }

      // Push budget update to worker
      this.ctx.postMessage(runId, {
        type: "budget-update",
        budget: {
          usedTokens: instance.budget.usedTokens,
          usedCost: instance.budget.usedCost,
        },
      });

      // Budget enforcement (delegates to orchestrator which calls checkBudget)
      await this.ctx.checkBudget(instance, runId);

      await this.ctx.persistState();
      this.ctx.onTraceUpdate?.(runId);

      // Cleanup temp files
      if (opts.systemPromptFiles) {
        for (const fp of opts.systemPromptFiles) {
          this.ctx.cleanupTempFile(fp);
        }
      }
    });
  }

  /** Handle stale context error — surface immediately without retry. */
  private async handleStaleContext(
    runId: string,
    callId: number,
    instance: WorkflowInstance,
    opts: AgentCallOpts,
    poolResult: import("../agent-pool.js").AgentResult,
  ): Promise<void> {
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
      appendTraceNode(this.ctx.pi, runId, traceNode);
      this.ctx.events.emit(runId, {
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

    this.ctx.postMessage(runId, {
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

    await this.ctx.persistState();
    this.ctx.onTraceUpdate?.(runId);

    // Cleanup temp files
    if (opts.systemPromptFiles) {
      for (const fp of opts.systemPromptFiles) {
        this.ctx.cleanupTempFile(fp);
      }
    }
  }
}
```

**行数估算：~280 行**

---

## orchestrator.ts 修改后的关键代码

### 新增 import

```typescript
import { WorkerManager, type WorkerEventCallbacks } from "./engine/worker-manager.js";
import { AgentExecutor, type AgentExecutorContext } from "./engine/agent-executor.js";
```

### 移除的 import

```typescript
// 移到 worker-manager.ts:
// import { Worker } from "node:worker_threads";
// import { buildWorkerScript } from "./engine/worker-script.js";

// 移到 agent-executor.ts:
// import { type AgentCallOpts } from "./agent-pool.js";
// import { resolveAgentOpts as resolveOpts, ... } from "./infra/agent-opts-resolver.js";
// import { appendTraceNode } from "./execution-trace.js";
// import { resolveModel } from "./engine/model-resolver.js";
```

### 移除的常量/类型（移到子模块）

```typescript
// 移到 agent-executor.ts:
// MAX_AGENT_RETRIES, RETRY_BACKOFF_MS, EXPONENTIAL_BACKOFF_BASE
// STALE_CONTEXT_PATTERNS, isStaleContextErrorMsg

// 移到 worker-manager.ts:
// (无独有常量)
```

### 保留在 orchestrator 的常量

```typescript
const MAX_WORKER_RETRIES = 3;
const RETRY_BACKOFF_MS = 1000;
const EXPONENTIAL_BACKOFF_BASE = 2;
const RUNID_RADIX = 36;
const RUNID_SLICE_START = 2;
const RUNID_SLICE_LENGTH = 8;
```

> 注意：`MAX_WORKER_RETRIES`、`RETRY_BACKOFF_MS`、`EXPONENTIAL_BACKOFF_BASE` 被 handleScriptError 使用，留在 orchestrator。agent-executor 有自己的同名常量（独立值）。如果未来想统一，可以抽到 shared constants 文件，但目前两处独立使用没问题。

### 类字段变更

```typescript
export class WorkflowOrchestrator {
  // 保留：
  private readonly instances = new Map<string, WorkflowInstance>();
  private readonly runMetaMap = new Map<string, RunMeta>();
  private readonly agentRegistry: AgentRegistry;
  private readonly activeTempFiles = new Set<string>();
  private cleanupTempFile = (fp: string) => cleanupFile(fp, this.activeTempFiles);
  cleanupAllTempFiles = () => cleanupAllFiles(this.activeTempFiles);
  private readonly pi: ExtensionAPI;
  private readonly ctx: ExtensionContext;
  private readonly sessionDir: string;
  onTraceUpdate?: (runId: string) => void;
  onCompletion?: (runId: string) => void;
  readonly events = new WorkflowEventEmitter();

  // 新增：子模块实例
  private readonly workerMgr: WorkerManager;
  private readonly agentExec: AgentExecutor;

  // 移除（移到 worker-manager）：
  // private readonly workers = new Map<string, Worker>();
  // private readonly runAbortControllers = new Map<string, AbortController>();

  // 移除（移到 agent-executor）：
  // private readonly runPools = new Map<string, AgentPool>();
  // private readonly retryCounts = new Map<string, number>();
```

### constructor 变更

```typescript
constructor(pi, ctx, _maxConcurrency?, _poolOptions?) {
  // ... 现有初始化不变 ...

  // 初始化子模块
  const eventCallbacks: WorkerEventCallbacks = {
    onMessage: (runId, raw) => this.handleWorkerMessage(runId, raw),
    onError: (runId, err) => this.handleWorkerError(runId, err),
    onExit: (runId, code, worker) => this.handleWorkerExit(runId, code, worker),
  };
  this.workerMgr = new WorkerManager(eventCallbacks);

  const executorCtx: AgentExecutorContext = {
    pi: this.pi,
    agentRegistry: this.agentRegistry,
    sessionDir: this.sessionDir,
    activeTempFiles: this.activeTempFiles,
    events: this.events,
    getRunSignal: (runId) => this.workerMgr.getSignal(runId),
    postMessage: (runId, msg) => this.workerMgr.postMessage(runId, msg),
    persistState: () => this.persistState(),
    onTraceUpdate: (runId) => this.onTraceUpdate?.(runId),
    cleanupTempFile: (fp) => this.cleanupTempFile(fp),
    checkBudget: (instance, runId) => this.runBudgetCheck(instance, runId),
  };
  this.agentExec = new AgentExecutor(executorCtx);
}
```

### 新增私有辅助方法：runBudgetCheck

封装 `checkBudget` 调用 + 后续操作，作为 agent-executor 的回调：

```typescript
private async runBudgetCheck(instance: WorkflowInstance | undefined, runId: string): Promise<void> {
  await checkBudget(instance, runId, {
    postMessage: (id, msg) => this.workerMgr.postMessage(id, msg),
    terminateWorker: (id) => this.workerMgr.terminateWorker(id),
    cleanupAllTempFiles: () => this.cleanupAllTempFiles(),
    persistState: () => this.persistState(),
    onCompletion: (id) => this.onCompletion?.(id),
  });
}
```

### run() 变更

```typescript
async run(name, args, budgetTokens?, budgetTimeMs?, signal?): Promise<string> {
  // ... 前置检查、scriptSource、lint 不变 ...

  // 创建 AbortController → workerMgr
  const runAbortController = this.workerMgr.createAbortController(runId);

  // 创建 AgentPool → agentExec
  const pool = new AgentPool({ ... });
  pool.setBudget(instance.budget);
  this.agentExec.setPool(runId, pool);

  // signal → recreateRunAbortController 改为直接调 workerMgr
  if (signal) {
    const onToolAbort = () => runAbortController.abort();
    signal.addEventListener("abort", onToolAbort, { once: true });
  }

  // signal → pause 逻辑不变

  // startWorker 委托
  this.workerMgr.startWorker(
    runId,
    instance.worker,
    scriptSource,
    instance.callCache,
    instance.budget,
    args,
    process.cwd(),
  );

  // time budget check 回调改用 workerMgr
  if (budgetTimeMs) {
    scheduleTimeBudgetCheck(
      (id) => this.instances.get(id),
      runId,
      budgetTimeMs,
      {
        postMessage: (id, msg) => this.workerMgr.postMessage(id, msg),
        terminateWorker: (id) => this.workerMgr.terminateWorker(id),
        cleanupAllTempFiles: () => this.cleanupAllTempFiles(),
        persistState: () => this.persistState(),
        onCompletion: (id) => this.onCompletion?.(id),
      },
    );
  }

  return runId;
}
```

### pause() 变更

```typescript
async pause(runId: string): Promise<void> {
  // ... 状态检查不变 ...
  instance.pausedAt = new Date().toISOString();
  transitionStatus(instance, "paused");
  this.events.emit(runId, { type: "status", status: "paused" });
  this.workerMgr.terminateWorker(runId);  // ← 委托
  this.cleanupAllTempFiles();
  await this.persistState();
}
```

### resume() 变更

```typescript
async resume(runId: string): Promise<void> {
  // ... 状态检查不变 ...
  transitionStatus(instance, "running");
  this.events.emit(runId, { type: "status", status: "running" });

  const meta = this.runMetaMap.get(runId);
  if (meta) {
    this.workerMgr.recreateRunAbortController(runId, meta.signal);  // ← 委托
    this.workerMgr.startWorker(                                      // ← 委托
      runId, instance.worker, meta.scriptSource,
      instance.callCache, instance.budget, meta.args, process.cwd(),
    );
    // ... time budget reschedule 不变（用 workerMgr 方法） ...
  }
  await this.persistState();
}
```

### abort() 变更

```typescript
async abort(runId: string): Promise<void> {
  // ... 状态检查不变 ...
  transitionStatus(instance, "aborted");
  this.events.emit(runId, { type: "status", status: "aborted" });
  this.workerMgr.terminateWorker(runId);  // ← 委托
  this.cleanupAllTempFiles();
  await this.persistState();
  this.onCompletion?.(runId);
}
```

### retryNode() 变更

```typescript
async retryNode(runId: string, callId: number): Promise<void> {
  // ... 状态检查 + cache/trace 重置不变 ...
  this.workerMgr.terminateWorker(runId);              // ← 委托
  this.agentExec.deleteRetryCount(runId);             // ← 委托

  const meta = this.runMetaMap.get(runId);
  if (meta) {
    this.workerMgr.recreateRunAbortController(runId, meta.signal);  // ← 委托
    this.workerMgr.startWorker(                                      // ← 委托
      runId, instance.worker, meta.scriptSource,
      instance.callCache, instance.budget, meta.args, process.cwd(),
    );
  }
  await this.persistState();
}
```

### skipNode() 变更

```typescript
async skipNode(runId: string, callId: number): Promise<void> {
  // ... cache/trace 注入不变 ...
  if (this.workerMgr.has(runId)) {              // ← 委托
    try {
      this.workerMgr.postMessage(runId, { ... });  // ← 委托
    } catch (err) {
      console.warn(`skipNode: failed to post message for ${runId}:`, err);
    }
  }
  await this.persistState();
}
```

### handleWorkerMessage() — 消息路由（保留在 orchestrator）

```typescript
private async handleWorkerMessage(runId: string, raw: unknown): Promise<void> {
  const msg = raw as WorkerInMsg;
  const instance = this.instances.get(runId);
  if (!instance) return;

  switch (msg.type) {
    case "agent-call":
      // 委托给 agent-executor
      this.agentExec.handleAgentCall(runId, instance, msg.callId, msg.opts, msg.phase);
      break;
    case "return": {
      if (isTerminal(instance.status) || instance.status === "budget_limited" || instance.status === "paused") return;
      instance.scriptResult = msg.result;
      instance.completedAt = new Date().toISOString();
      transitionStatus(instance, "completed");
      this.events.emit(runId, { type: "status", status: "completed" });
      this.workerMgr.removeWorker(runId);  // ← 委托（自然退出，不 terminate）
      await this.persistState();
      this.onTraceUpdate?.(runId);
      this.onCompletion?.(runId);
      break;
    }
    case "error": {
      if (isTerminal(instance.status) || instance.status === "budget_limited" || instance.status === "paused") return;
      this.handleScriptError(runId, msg.error);  // ← 保留在 orchestrator
      break;
    }
  }
}
```

### handleWorkerError() / handleWorkerExit() / handleScriptError() — 保留在 orchestrator

这三个方法保持不变，仅将 `this.workers.delete()` 替换为 `this.workerMgr.removeWorker()`：

```typescript
private async handleWorkerError(runId: string, err: Error): Promise<void> {
  const instance = this.instances.get(runId);
  if (!instance || isTerminal(instance.status)) return;

  this.workerMgr.removeWorker(runId);   // ← 变更点
  instance.error = err.message;
  instance.completedAt = new Date().toISOString();
  transitionStatus(instance, "failed");
  this.events.emit(runId, { type: "status", status: "failed" });
  this.cleanupAllTempFiles();
  await this.persistState();
  this.onCompletion?.(runId);
}

private async handleWorkerExit(runId: string, code: number, exitedWorker: Worker): Promise<void> {
  // ... 不变，但 this.workers.get → this.workerMgr 的内部方法 ...
  // 注意：当前代码需要比较 worker 引用。WorkerManager 需要暴露一个方法：
  // isCurrentWorker(runId, worker): boolean
  // 或者在 onExit 回调中，WorkerManager 已经验证了 worker 身份
}
```

> **设计微调**：`handleWorkerExit` 需要比较退出的 Worker 是否是当前的。两种方案：
> 1. WorkerManager 内部处理 worker 身份验证，只在确实是当前 worker 时才回调 `onExit`
> 2. WorkerManager 暴露 `isCurrentWorker(runId, worker)` 方法
>
> **推荐方案 1**：WorkerManager 在 `on("exit")` handler 中检查 worker 身份，只有当前 worker 才回调 `onExit`。这样 orchestrator 的 `handleWorkerExit` 不再需要 `exitedWorker` 参数和身份验证逻辑。

### 修改后的 handleWorkerExit（orchestrator 侧）

```typescript
// WorkerEventCallbacks.onExit 签名变更：
// onExit(runId: string, code: number): void;  // 不再传 worker，WM 已验证身份

private async handleWorkerExit(runId: string, code: number): Promise<void> {
  const instance = this.instances.get(runId);
  if (!instance) return;
  // WorkerManager 已经验证了 worker 身份，不再需要此处比较

  if (instance.status === "paused" || isTerminal(instance.status)) return;

  if (code !== 0 && !instance.error) {
    instance.error = `Worker exited with code ${code}`;
    instance.completedAt = new Date().toISOString();
    transitionStatus(instance, "failed");
    this.events.emit(runId, { type: "status", status: "failed" });
    await this.persistState();
    this.onCompletion?.(runId);
  }
}
```

### WorkerManager.startWorker 中 exit handler 更新

```typescript
// worker-manager.ts 中的 exit handler：
worker.on("exit", (code: number) => {
  // 身份验证：只回调当前 worker 的退出
  if (this.workers.get(runId) === worker) {
    this.workers.delete(runId);
    this.callbacks.onExit(runId, code);
  }
});
```

### list() / getInstance() / restoreInstances() / runAndWait() / persistState()

**完全不变**。

---

## WorkerInMsg 类型归属

`AgentCallMsg`、`ReturnMsg`、`ErrorMsg`、`WorkerInMsg` 是消息路由类型，仅 `handleWorkerMessage` 使用。**保留在 orchestrator.ts**，不移动。

---

## 行数估算

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/engine/worker-manager.ts` | ~155 | Worker 线程 CRUD + AbortController + 事件分发 |
| `src/engine/agent-executor.ts` | ~280 | Agent 调用 + 重试 + stale context + 模型解析 |
| `src/orchestrator.ts`（修改后） | ~530 | 公共 API + 消息路由 + Worker 错误恢复 + 状态持久化 |
| **减少量** | -971 + 965 = +6 行 | 拆分增加接口/胶水代码约 6 行净增 |

### orchestrator.ts 行数细目（修改后）

| 区块 | 行数 | 说明 |
|------|------|------|
| Imports | ~25 | 减少 Worker/agent 相关 import |
| 常量 | ~12 | MAX_WORKER_RETRIES 等 + runId 常量 |
| WorkflowInstanceSummary | ~18 | 不变 |
| RunMeta / WorkerInMsg | ~20 | 内部类型保留 |
| 类字段 + constructor | ~75 | 新增 workerMgr/agentExec 初始化 |
| getAgentCount / getAgents | ~13 | 不变 |
| run() | ~110 | 委托调用取代直接操作 |
| pause() | ~25 | 委托 workerMgr |
| resume() | ~50 | 委托 workerMgr |
| abort() | ~16 | 委托 workerMgr |
| retryNode() | ~35 | 委托 workerMgr + agentExec |
| skipNode() | ~35 | 委托 workerMgr |
| list / getInstance / restoreInstances | ~25 | 不变 |
| handleWorkerMessage | ~30 | 路由逻辑 |
| handleWorkerError | ~16 | 用 workerMgr |
| handleWorkerExit | ~15 | 简化（无 worker 身份验证） |
| handleScriptError | ~40 | 用 workerMgr |
| runBudgetCheck (新增) | ~12 | 封装 checkBudget 回调 |
| runAndWait | ~38 | 不变 |
| persistState | ~8 | 不变 |
| **合计** | **~530** | |

---

## 依赖关系图

```
                    orchestrator.ts
                   /                \
          worker-manager.ts    agent-executor.ts
              |          \        /          |
         worker-script.ts  orchestrator-events.ts
                           model-resolver.ts
                           execution-trace.ts
                           agent-opts-resolver.ts
```

- orchestrator → worker-manager（直接引用）
- orchestrator → agent-executor（直接引用）
- agent-executor → model-resolver、execution-trace、agent-opts-resolver、orchestrator-events（独立依赖）
- worker-manager → worker-script（独立依赖）
- agent-executor **不依赖** worker-manager（通过回调 `getRunSignal` 间接获取 signal）
- worker-manager **不依赖** agent-executor

两个子模块之间零直接依赖，通过 orchestrator 的回调接口解耦。

---

## 执行顺序建议

1. **创建 `worker-manager.ts`** — 先创建文件 + 单元测试骨架
2. **创建 `agent-executor.ts`** — 先创建文件 + 单元测试骨架
3. **修改 `orchestrator.ts`** — 替换内部方法为委托调用
4. **类型检查** — `pnpm --filter @zhushanwen/pi-workflow typecheck`
5. **全量测试** — `pnpm --filter @zhushanwen/pi-workflow test`
