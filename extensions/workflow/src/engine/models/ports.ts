/**
 * Workflow Extension — Engine Ports + 编排层共享类型（W1-T2）
 *
 * 3 个注入 Port（AgentRunner / RunStore / WorkerHost）——Engine 定义、Infra 实现，
 * 是真需要 mock 测试的依赖（子进程/文件系统/线程）。
 *
 * 编排层共享类型（WorkerHandlers / LifecycleDeps）——W3 拆细的关键，打破
 * lifecycle ↔ error-recovery ↔ node-ops 循环依赖：3 个 engine 函数文件各自独立成 task，
 * 共用同一组依赖签名（D-12）。
 *
 * 层归属：Engine。零 infra 依赖（AC-1）。
 *
 * ───────────────────────────────────────────────────────────────
 * FORWARD REF 状态（T9 已完成 / T7 已完成）
 * ───────────────────────────────────────────────────────────────
 * RunSpec 已由 T7 创建（下方真实 import）。
 * WorkerHandle 已由 T9 创建（下方真实 import，Infra 层技术类型，Engine 允许引用，D-12）。
 * WorkflowRun 仍由 T16 创建，下方保留占位：
 *   - WorkflowRun  → T16 (engine/models/workflow-run.ts)
 * 对应 task 完成后：删除占位块，改为
 *   import type { WorkflowRun } from "./workflow-run.js";
 */
import type { WorkerHandle } from "../../infra/worker-handle.js";
import type { RunSpec } from "./run-spec.js";
import type { AgentCallOpts, AgentResult } from "./types.js";

// ── FORWARD REF 占位（待 T16 替换为真实 import） ────────────
// 真实 WorkflowRun 见 domain-models.md §1（聚合根）。
export interface WorkflowRunPlaceholder {
  /** 占位——T16 后由真实 WorkflowRun 替换。 */
  readonly runId: string;
}

// ── Port 1: AgentRunner ───────────────────────────────────────

/**
 * Agent 子进程执行 port。Infra 实现：SubprocessAgentRunner（T10，原 pi-runner）。
 *
 * run() 在子进程中执行单次 agent 调用，返回结构化结果（含 usage/toolCalls）。
 * signal 用于 abort 传播（kill subprocess）。
 */
export interface AgentRunner {
  run(opts: AgentCallOpts, signal: AbortSignal): Promise<AgentResult>;
}

// ── Port 2: RunStore ──────────────────────────────────────────

/**
 * WorkflowRun 持久化 port。Infra 实现：JsonlRunStore（T13，原 state-store）。
 *
 * save() 在每次状态变更后持久化整个 WorkflowRun（聚合根）；
 * loadAll() 在 session_start 时重水合（D-5：JSONL 不向后兼容旧 session，旧格式返回空）。
 */
export interface RunStore {
  save(run: WorkflowRunPlaceholder): Promise<void>;
  loadAll(): Promise<WorkflowRunPlaceholder[]>;
}

// ── Port 3: WorkerHost ────────────────────────────────────────

/**
 * Worker 线程启动 port。Infra 实现：WorkerHostImpl（T12，原 worker-manager）。
 *
 * start() 创建一个 Worker thread 运行 workflow 脚本，返回 WorkerHandle。
 * handlers 绑定 message/error/exit 回调（见 WorkerHandlers）。
 */
export interface WorkerHost {
  start(
    spec: RunSpec,
    args: Record<string, unknown>,
    handlers: WorkerHandlers,
  ): WorkerHandle;
}

// ── 编排层共享类型 1: WorkerHandlers ───────────────────────────

/**
 * Worker 线程事件回调集合——WorkerHost.start() 的入参，由 lifecycle（T21）
 * 构造并注入。3 个 engine 文件（lifecycle / error-recovery / node-ops）共用此签名，
 * 避免各自定义形状不一致的 handler bag（打破循环依赖）。
 *
 * 所有回调返回 Promise——允许 engine 层在回调内做 await persistState() 等异步操作。
 */
export interface WorkerHandlers {
  /** Worker → Main 的业务消息（agent-call / return / error / log）。 */
  onMessage(raw: unknown): Promise<void>;
  /** Worker 线程 uncaught error。 */
  onError(err: Error): Promise<void>;
  /** Worker 线程 exit（含 code，用于区分正常退出 vs 崩溃）。handle 用于竞态防护 G-025。 */
  onExit(code: number, handle: WorkerHandle): Promise<void>;
}

// ── 编排层共享类型 2: LifecycleDeps ────────────────────────────

/**
 * lifecycle / error-recovery / node-ops 3 个 engine 函数文件的共同依赖 bag。
 *
 * 取代旧 4 个 Context factory（errorHandlerContext / agentCallContext /
 * budgetCallbacks / terminateDeps，AC-2 目标）。函数签名 `(deps: LifecycleDeps, ...)`
 * 让每个 free function 自包含依赖，无需 OrchestratorCore 中介。
 *
 * - store: 持久化（RunStore port）
 * - workerHost: 启动 worker（WorkerHost port）
 * - runner: 执行 agent（AgentRunner port）
 * - runs: 内存中的活动 run 聚合根索引（runId → WorkflowRun），替代旧 6 张并行 map
 */
export interface LifecycleDeps {
  store: RunStore;
  workerHost: WorkerHost;
  runner: AgentRunner;
  runs: Map<string, WorkflowRunPlaceholder>;
}
