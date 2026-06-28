# Core Models — Workflow 重构

核心模型的字段、不变式、关系定义。这些模型作为数据结构 + 不变式守卫存在于 Engine 层（非独立 Domain 层，D-12）。Engine 层不依赖 Pi SDK（@mariozechner/*），但可使用 node:worker_threads 等 Node 原生模块的技术类型——因为 WorkerHandle/RunRuntime/ConcurrencyGate 本就是技术资源封装，承认其技术属性比强行造 interface 更诚实。

## 模型关系图

```
WorkflowScript ──discovered──→ WorkflowScriptRegistry
      │
      │ toExecutable()
      ▼
WorkflowRun (聚合根)
├── spec: RunSpec                    ← 不可变（脚本源+参数+预算上限）
├── state: RunState                  ← 可持久化
│   ├── status: "running"|"paused"|"done"
│   ├── reason?: DoneReason          ← done 时必有
│   ├── budget: Budget
│   ├── calls: Map<number, AgentCall>← 实体集合（替换 callCache）
│   ├── trace: Trace                 ← 事件流（唯一来源）
│   └── errorLogs: WorkerLogEntry[]  ← run 级诊断
├── runtime?: RunRuntime             ← 仅 running 时存在
└── meta: { startedAt, completedAt?, pausedAt?, workerErrorCount?, scriptErrorCount? }

AgentCall (数据+不变式，在 RunState.calls 内)
├── id, opts, status, attempts, result?, sessionId?
└── 无 execute() 方法（执行编排由 Engine executeAgentCall() 函数承担，D-12）

RunRuntime (聚合内，仅 running 时存在)
├── worker: WorkerHandle
├── gate: ConcurrencyGate
└── controller: AbortController
```

## 1. WorkflowRun（聚合根）

```ts
class WorkflowRun {
  readonly runId: string;
  readonly spec: RunSpec;          // 不可变
  state: RunState;                 // 可变，可持久化
  runtime?: RunRuntime;            // running 时存在，paused/done 时 undefined
  meta: { startedAt: string; completedAt?: string; pausedAt?: string; workerErrorCount?: number; scriptErrorCount?: number };
}
```

**不变式**：
- `state.status === "running" ⟺ runtime !== undefined`
- `state.status === "done" ⟹ state.reason !== undefined`
- 所有字段变更通过方法（transition / assignRuntime / releaseRuntime），engine 模块不直接打洞

**操作**：
- `transition(target, reason?)` — 状态机转换，内部联动 runtime 生命周期
- `assignRuntime(rt)` — run/resume 时绑定（前置：runtime===undefined）
- `releaseRuntime()` — pause/done 时解绑（runtime 置 undefined）
- `replaceRuntime(newRt)` — retryNode/worker-error-retry 的原地替换（G5-001）：原子释放旧 runtime + 绑定新 runtime，全程保持不变式 `status==="running" ⟺ runtime!==undefined`。与 assign/release 的区别：replaceRuntime 不改变 status（保持 running），中间不经过 runtime===undefined 的可见状态（内部同步完成，外部观察不到违反不变式的瞬间）。**前置条件：status==="running"**（G6-001）——retryNode 在 paused 状态被拒绝（要 retry 先 resume）

## 2. RunSpec（值对象，不可变）

```ts
interface RunSpec {
  scriptSource: string;            // 已 strip export 的可执行源
  args: Record<string, unknown>;
  budgetTokens?: number;
  budgetTimeMs?: number;
  scriptName: string;
  scriptPath: string;
  description?: string;
}
```

## 3. RunState（值对象，可持久化）

```ts
interface RunState {
  status: "running" | "paused" | "done";
  reason?: DoneReason;             // done 时必填
  budget: Budget;
  calls: Map<number, AgentCall>;   // 按 callId 索引
  trace: Trace;
  errorLogs: WorkerLogEntry[];     // run 级诊断（Worker console.* 捕获）
  error?: string;                  // done && reason !== completed 时可有
  scriptResult?: unknown;          // done && reason === completed 时有
}

type DoneReason = "completed" | "failed" | "aborted" | "budget_limited" | "time_limited";
```

## 4. Budget（值对象）

```ts
class Budget {
  maxTokens?: number;
  maxCost?: number;
  maxTimeMs?: number;
  usedTokens: number;
  usedCost: number;
  totalCallCount: number;          // soft limit 计数（从 ConcurrencyGate 迁入）

  consume(usage: AgentUsage): void;
  isExceeded(): boolean;
  isSoftLimitReached(): boolean;   // totalCallCount > 500，由调用方查询后发通知
}
```

**不变式**：maxTokens>0 守卫（===0 视为不限制，避免首个 agent 完成误判 budget_limited）。

**设计决策（D-12）**：删除 `softWarningSent + setBudget + maybeEmitSoftWarning + _budgetWarningSent` 副作用链（值对象不应持可变状态 + 跨层回调）。soft limit 通知由 Engine 层在 `consume()` 后查 `isSoftLimitReached()` 发出，职责分离。

## 5. AgentCall（实体）

```ts
class AgentCall {
  readonly id: number;
  readonly opts: AgentCallOpts;
  status: "pending" | "running" | "done";
  attempts: number;
  result?: AgentResult;
  sessionId?: string;              // pi subprocess uuidv7（G-017 归此）
  traceNode: ExecutionTraceNode;
}
```

**设计决策（D-12）**：AgentCall 只持数据 + 不变式守卫。现状执行逻辑已是 free function `executeWithRetry(ctx: AgentCallContext, runId, callId, ...)`（agent-call-handler.ts:70），本决策做的是**参数重组**：AgentCallContext（依赖注入 bag）→ 显式 5 参数 `(call, runner, budget, signal, trace)`，消除 errorHandlerContext/agentCallContext/budgetCallbacks 3 个 Context factory（AC-2 目标）。新的 Engine 层 free function 命名为 `executeAgentCall`。

**AgentCallOpts.timeoutMs**（per-call wall-clock）归此实体（G-027）。

## 6. Trace（值对象，事件流，唯一来源 D-10）

```ts
class Trace {
  private nodes: ExecutionTraceNode[];  // append-only
  append(node: ExecutionTraceNode): void;
  update(callId: number, patch: TracePatch): void;  // G-018 单一来源
  toArray(): readonly ExecutionTraceNode[];
}
```

**不变式**：nodes 只增不改索引顺序；update 只改单个 node 的 status/result/completedAt/sessionId。

**verifyStrategy 字段删除**（G-020 死字段，不迁移）。

## 7. WorkflowScript（实体，新增）

```ts
class WorkflowScript {
  readonly name: string;
  readonly source: WorkflowSource;  // "saved" | "tmp"
  readonly path: string;
  sourceCode: string;               // 可编辑
  meta: WorkflowMeta;               // { name, description, phases[] }
  available: boolean;               // meta 提取是否成功

  validate(): LintResult;           // 静态检查（合并 script-lint.ts）
  toExecutable(): string;           // strip export + wrap（合并 worker-script.ts 的源处理）
  save(newName?: string): Promise<string>;  // tmp → saved
  static delete(name: string, isRunning: (n: string) => boolean): string;
}
```

## 8. WorkflowScriptRegistry（仓库接口，新增）

```ts
interface WorkflowScriptRegistry {
  loadAll(): Promise<WorkflowScript[]>;
  get(name: string): Promise<WorkflowScript | undefined>;
  invalidate(): void;
}
// 实现在 Infrastructure 层（WorkflowScriptRegistryImpl：扫描+缓存+去重）
```

**优先级**：tmp > project > user。60s TTL，按 workspaceRoot 分桶。

## 9. WorkerHandle（技术资源封装，Infra 层具体类）

**设计决策（D-12）**：WorkerHandle 是线程句柄的技术封装，不是领域概念。删 `IWorkerHandle` interface（为 domain 零依赖教条造的双层无意义——WorkerHandle 只有一个实现，不需要多态）。直接定义具体 class，RunRuntime 直接持有。

```ts
class WorkerHandle {  // Infra 层，Engine 直接 import 使用
  private worker: Worker;           // node:worker_threads.Worker
  readonly isCurrent: boolean;      // 竞态防护（G-025）
  postMessage(msg: unknown): void;
  terminate(): Promise<void>;
  // 绑定 onMessage/onError/onExit 回调
}
```

**不变式**：一个 run 可经历多个 WorkerHandle（pause/resume/retry），terminate 后 isCurrent=false，旧 handle 的 exit 事件被忽略。

## 10. RunRuntime（聚合内，仅 running 时存在）

```ts
class RunRuntime {
  worker: WorkerHandle;            // 具体类（D-12 删 interface）
  gate: ConcurrencyGate;           // per-running-segment 实例（G3-001）
  controller: AbortController;     // per-running-segment（AbortController 一次性，无法复用）

  release(mode: "pause" | "terminal"): void;
  // pause: 销毁 worker + tempFiles；整个 RunRuntime 被丢弃，resume 时 assignRuntime 全部重建
  //   （AbortController 一次性语义决定 controller 无法跨 pause/resume 保留）
  // terminal: 全释放
  // 消除 terminateInstance 的 4 个 boolean flag
  // 注：mode 参数语义实际等价（pause 和 terminal 都全释放，区别仅在调用方语境）
  //     保留枚举是为可读性，调用方表达意图
}
```

**层归属（D-12）**：RunRuntime 是 Engine 层类型，持有 WorkerHandle / ConcurrencyGate 具体类（不造 interface）。承认这是技术资源聚合，强行用 interface 解耦只会增加间接层无实际收益。

**pause/resume 生命周期（G3-001）**：与 WorkflowRun 不变式 `status==="running" ⟺ runtime!==undefined` 一致——pause 时 `releaseRuntime()` 使整个 RunRuntime 丢弃（runtime=undefined），resume 时 `assignRuntime(new RunRuntime(...))` 重建 worker/gate/controller 三个实例。gate 语义从"per-run 保留"调整为"per-running-segment 重建"（行为变化但语义无害：worker 重跑脚本 + callCache replay 使 gate 队列清空无影响）。

## 11. ConcurrencyGate（原 AgentPool，重命名）

**设计决策（D-12）**：并发信号量的技术封装，删 `IConcurrencyGate` interface，直接定义具体 class。RunRuntime 直接持有。

```ts
class ConcurrencyGate {  // Infra 层，Engine 直接 import 使用
  constructor(opts: { maxConcurrency: number; runName: string });
  enqueue(opts: AgentCallOpts, signal?: AbortSignal): Promise<AgentResult>;
  readonly activeCount: number;
  readonly queueLength: number;
  // FIFO 队列 + abort 传播
}
```

**变更**：maxConcurrency **保持 4**（D-13，无数据支撑改 5）；移除 setBudget / maybeEmitSoftWarning（soft limit 移到 Budget.isSoftLimitReached() 查询）。

## ~~12. ApprovalPolicy~~（删除 —— D-11/D-12）

现状是 1 个 Set + 2 行代码（`isTmp || !sessionApprovals.has(name)` → `add + appendEntry`）。建模成 domain 值对象 + ApprovalStore port 是过度设计。重构后降为 **Interface 层 helper 函数**（tool-workflow-run.ts 内）：

```ts
// Interface 层 tool-workflow-run.ts 内
function requiresConfirmation(script, approved: Set<string>): boolean {
  return script.source === "tmp" || !approved.has(script.name);
}
```

session_start 时从 entries 重建 Set（现有逻辑保留），RPC 降级（sendUserMessage）也在 Interface 层。不进 Engine/Infra。

## Ports（3 个，Engine 定义，Infra 实现）

```ts
interface AgentRunner {
  run(opts: AgentCallOpts, signal: AbortSignal): Promise<AgentResult>;
}

interface RunStore {
  save(run: WorkflowRun): Promise<void>;
  loadAll(): Promise<WorkflowRun[]>;
}

interface WorkerHost {
  start(spec: RunSpec, args, handlers): WorkerHandle;
}
```

**为什么只留 3 个 port（D-12）**：AgentRunner / RunStore / WorkerHost 是真需要 mock 测试的依赖（子进程/文件系统/线程）。其余 3 个原 port（ApprovalStore / IWorkerHandle / IConcurrencyGate）是为 domain 零依赖教条造的伪 port——删 domain 层后，WorkerHandle/ConcurrencyGate 直接是 Infra 具体类，ApprovalPolicy 降为 Interface helper，无需 port。

## 隐式契约保留清单（Round 1 追踪登记）

以下现状机制 spec 必须保留，重构时迁移到对应层：

| 契约 | 迁移目标 |
|------|---------|
| reentry-guard（2 tool 共享） | Interface 层 |
| tool_call 自动注入 SKILL.md | generate action 的 execute 内部 |
| `_render` descriptor（跨扩展 GUI） | Interface 层 notifyDone() helper 保留 |
| session_tree 强制 paused | session 事件处理（Interface 层） |
| session_shutdown pause-all | session 事件处理；kill -9 留 running 的 reconstruct 时转 failed |
| per-call AbortController 合并（signal+timeoutMs） | ConcurrencyGate.enqueue 内部 |
| stale-context 检测不重试 | Engine executeAgentCall() 内部 |
| Worker 3 次重试 + 指数退避 | Engine handleWorkerError() |
| Agent 3 次重试 + 指数退避 | Engine executeAgentCall() |

## 失败处理矩阵（Engine 错误处理 free functions，G-021/G-022/G-023）

| 失败类型 | 重试上限 | 退避 | 特殊规则 |
|---------|---------|------|---------|
| Worker error/exit（非零） | 3 次 | 指数 1s/2s/4s | 重试前重建 controller+worker（G3-001: 整个 RunRuntime 重建） |
| Script error（type:"error"） | 3 次 | 指数 1s/2s/4s | retryCount 累加，超限转 failed |
| Agent call 失败 | 3 次 | 指数 1s/2s/4s | 预算超限时不重试（走 checkBudget） |
| Stale context | 0 次（不重试） | — | 命中 STALE_CONTEXT_PATTERNS 直接失败 |
| Budget exceeded | 0 次 | — | 转 budget_limited 终态 |
| Time exceeded | 0 次 | — | 转 time_limited 终态 |

**resume/retry 时重建语义（G3-001/G5-001/G6-001）**：
- pause→resume：assignRuntime 重建（status: paused→running）
- worker error retry：replaceRuntime 原地重建（status 保持 running）
- retryNode：replaceRuntime 原地重建（status 保持 running），**前置条件 status==="running"**（paused 下拒绝，要 retry 先 resume）
- callCache 保留（在 RunState 里，跨 runtime 存活），worker 重跑脚本时已完成调用从 callCache replay

## 测试不变式清单（G-028）

迁移后必须保留测试覆盖：
- 状态机转换合法性（8 态→3 态+reason，非法转换抛错）
- Budget 阈值（maxTokens>0 守卫、90% 预警、超限转 budget_limited）
- cleanup-before-mutate 顺序（A4 原子性，terminate 失败时 status 不变）
- 跨 session pause/resume（callCache 保留、worker 重建）
- stale-context 不重试
- Worker error 3 次重试 + 指数退避
- Worker exit 竞态防护（old worker exit 不误判 new worker）
- per-call timeoutMs 与外部 signal 合并
- trace append-only + update 单一来源
- retryNode 前置条件：status==="running"（paused 下拒绝）（G6-001）

## 层归属（D-12 三层架构）

三层（Interface / Engine / Infra），依赖方向严格向下。Engine 是核心，不依赖 Pi SDK（@mariozechner/*），但承认技术资源封装可直接用 node 原生模块类型。

| 模型 | 层 | 说明 |
|------|----|------|
| WorkflowRun / RunSpec / RunState / Budget / AgentCall / Trace / WorkflowScript | Engine | 数据结构 + 不变式守卫 |
| RunRuntime | Engine | 聚合内资源，持 WorkerHandle/ConcurrencyGate 具体类 |
| WorkerHandle / ConcurrencyGate | Infra | 技术资源具体类（无 interface 双层） |
| WorkflowScriptRegistry | Engine repository interface + Infra 实现 | 需 mock（文件扫描），是 repository（§8）不是 Ports 节的注入 port |
| 3 个注入 Port（AgentRunner / RunStore / WorkerHost） | Engine 定义，Infra 实现 | 需 mock 测试的真依赖（在 Ports 节） |

**砍掉的伪抽象（D-12）**：
- IWorkerHandle / IConcurrencyGate interface（只有一个实现，不需多态）
- ApprovalStore port + ApprovalPolicy class（降为 Interface 层 helper）
- NotificationService class（降为 Interface 层 notifyDone helper）
- AgentCall.execute() 上帝方法 → 实为参数重组（executeWithRetry 已是函数，AgentCallContext → 显式 5 参数 executeAgentCall）
- Budget softWarningSent + setBudget + maybeEmitSoftWarning 副作用链（改查询式 isSoftLimitReached）
- 原四层 spec 的 Application 层 3 个 Service（RunLifecycleService/NodeOpsService/ErrorRecoveryService）降为 Engine free function
