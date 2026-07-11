/**
 * Workflow Extension — Engine Ports + 编排层共享类型
 *
 * 3 个注入 Port（AgentRunner / RunStore / WorkerHost）——Engine 定义、Infra 实现，
 * 是真需要 mock 测试的依赖（子进程/文件系统/线程）。
 *
 * 编排层共享类型（WorkerHandlers / LifecycleDeps）——打破 lifecycle ↔
 * error-recovery ↔ node-ops 循环依赖：3 个 engine 函数文件各自独立，共用同一组
 * 依赖签名（D-12）。
 *
 * 层归属：Engine。零 infra 依赖（AC-1）。
 */
import type { AgentEvent } from "../../shared/agent-event.ts";
import type { AgentRegistry } from "../agent-discovery.ts";
import type { WorkerHandle } from "../worker-handle.ts";
import type { RunSpec } from "./run-spec.ts";
import type { AgentCallOpts, AgentResult } from "./types.ts";
import type { WorkflowRun } from "./workflow-run.ts";

// ── Port 1: AgentRunner ───────────────────────────────────────

/**
 * Agent 子进程执行 port。Infra 实现：SubprocessAgentRunner。
 *
 * run 执行单次 agent 调用（委托 SubagentService.executeAndAwait），返回结构化结果。
 * signal 用于 abort 传播。
 *
 * onEvent（可选）：强类型 AgentEvent 回调，供调用方实时更新 live record 供 TUI 展示进度。
 * 不传则不回调（向后兼容；现有调用点不传不受影响）。
 *
 * D-005: onEvent 签名从 raw Record<string,unknown> 升级为 AgentEvent——委托后不再有
 * raw JSONL 中间层（executeAndAwait 直接出 AgentEvent，session-runner handleSdkEvent 出口）。
 */
export interface AgentRunner {
  run(opts: AgentCallOpts, signal: AbortSignal, onEvent?: (event: AgentEvent) => void): Promise<AgentResult>;
}

// ── Port 2: RunStore ──────────────────────────────────────────

/**
 * WorkflowRun 持久化 port。Infra 实现：JsonlRunStore。
 *
 * save 在每次状态变更后持久化整个 WorkflowRun（聚合根）；
 * loadAll 在 session_start 时重水合（D-5：JSONL 不向后兼容旧 session，旧格式返回空）。
 */
export interface RunStore {
  save(run: WorkflowRun): Promise<void>;
  loadAll(): Promise<WorkflowRun[]>;
}

// ── Port 3: WorkerHost ────────────────────────────────────────

/**
 * Worker 线程启动 port。Infra 实现：WorkerHostImpl。
 *
 * start 创建一个 Worker thread 运行 workflow 脚本，返回 WorkerHandle。
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
 * Worker 线程事件回调集合——WorkerHost.start 的入参，由 lifecycle
 * 构造并注入。3 个 engine 文件（lifecycle / error-recovery / node-ops）共用此签名，
 * 避免各自定义形状不一致的 handler bag（打破循环依赖）。
 *
 * 所有回调返回 Promise——允许 engine 层在回调内做 await persistState 等异步操作。
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
 * budgetCallbacks / 旧 terminate bag，AC-2 目标）。函数签名 `(deps: LifecycleDeps, ...)`
 * 让每个 free function 自包含依赖，无需 God Facade 中介。
 *
 * - store: 持久化（RunStore port）
 * - workerHost: 启动 worker（WorkerHost port）
 * - runner: 执行 agent（AgentRunner port）
 * - runs: 内存中的活动 run 聚合根索引（runId → WorkflowRun），替代旧 6 张并行 map
 * - onRunDone?: run 到达 done 终态时的回调（C-4 修复，可选）。由 Interface 层
 * factory 注入（notifyDone —— 唤醒 parent agent 消费结果）。Engine 层不依赖
 * Pi SDK，通过 callback 把完成信号外推到 Interface 层。所有 transition("done", ...)
 * 路径（handleReturn / handleWorkerError / handleScriptError / abortRun /
 * dispatchAgentCall budget 终止）调完 transition + save 后触发本回调。
 */
export interface LifecycleDeps {
  store: RunStore;
  workerHost: WorkerHost;
  runner: AgentRunner;
  runs: Map<string, WorkflowRun>;
 /** run 到达 done 终态时的回调（C-4 修复，可选）。Interface 层注入 notifyDone。 */
  onRunDone?: (run: WorkflowRun) => void;
 /**
 * 跨扩展事件总线（pending-notifications register/unregister 信号灯）。
 *
 * runWorkflow 启动时 emit pending:register；所有 transition("done") 路径 emit
 * pending:unregister。两处均通过本端口（Engine 不直接依赖 Pi SDK）。可选——
 * 无 pending-notifications 扩展时 no-op（向后兼容）。
 */
  eventBus?: { emit(channel: string, data: unknown): void };
 /**
 * 调试日志端口（Engine 不直接依赖 Pi SDK）。Interface 层注入实现。
 * 关键路径记录 run 启动、保存、pending 注册/注销，便于排查异步操作状态。
 */
  log?: (level: "debug" | "info" | "warn" | "error", component: string, message: string, data?: unknown) => void;
 /**
 * BL-1：agent/skill/schema 解析依赖（per-session，可选）。
 *
 * Interface 层 factory 在 session_start 注入：agentRegistry（扫描 .agents/agents 等
 * 7 路径）、sessionDir（临时文件根）、activeTempFiles（session_shutdown 回收集合）。
 * error-recovery.dispatchAgentCall 用这 3 项调 resolveAgentOpts，把
 * `agent({agent,skill,schema})` 的 inline override 解析成 systemPromptFiles /
 * skillPath / schemaEnv，否则 pi 子进程只收到原始 prompt（D-12 重构误删导致回归）。
 * 全部可选——测试 makeDeps 工厂无需改。
 */
  agentRegistry?: AgentRegistry;
  sessionDir?: string;
  activeTempFiles?: Set<string>;
 /**
 * D-12 regression fix (round-2 #2)：rebuildRuntime 重新调度 run 级墙钟预算计时器。
 *
 * worker/script 错误重试走 replaceRuntime，旧 RunRuntime 的 release 会 clearTimeout
 * 旧计时器（run-runtime.release）。新 runtime 必须重排 scheduleTimeBudget，否则带
 * budgetTimeMs 的 run 命中一次错误重试后时间预算静默失效（直到下次 pause/resume 才重排）。
 * 由 Interface 层 factory 注入——闭包捕获 deps，内部调 lifecycle.scheduleTimeBudget。
 *
 * 可选——旧测试 deps 不注入时 rebuildRuntime 不重排计时器（兼容，不影响无时间预算的 run）。
 */
  scheduleTimeBudget?: (
    runId: string,
    budgetTimeMs: number,
  ) => ReturnType<typeof setTimeout> | undefined;
 /**
 * workflow() 嵌套调用回调（可选）。Worker 脚本内调 workflow(name, args) 时触发。
 *
 * 由 Interface 层 makeDeps 注入（闭包捕获 registry + deps）。Engine 层的
 * error-recovery.handleWorkerMessage 收到 workflow-call 消息后调本回调，
 * 拿到子 workflow 执行结果后 postMessage(workflow-result) 回 worker。
 *
 * 不注入时 workflow() 返回 error result（向后兼容，不影响非嵌套场景）。
 */
  onWorkflowCall?: (
    name: string,
    args: Record<string, unknown>,
    parentRun: WorkflowRun,
  ) => Promise<unknown>;
}
