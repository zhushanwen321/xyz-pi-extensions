# Plan 独立审查报告

**审查对象**：`.xyz-harness/2026-06-21-workflow-refactor/` 下的 plan.md + 4 个子 plan（24 task）
**审查标准**：writing-plans SKILL.md 三维度（规格覆盖 / 占位符扫描 / 类型一致性）+ 迁移映射准确性
**审查方法**：read + grep 验证所有事实声明，对照 `extensions/workflow/src/` 现有源码
**审查日期**：2026-06-22
**审查结论**：**不可直接进入 Phase 3**，存在 8 项 must_fix（阻断）+ 7 项 should_fix

---

## Part A: 规格覆盖矩阵

### A.1 FR（功能需求）覆盖

| FR | 描述 | 覆盖 Task | 状态 | 备注 |
|----|------|----------|------|------|
| FR-1 | 8 个核心模型（Engine 层） | Task 1-8 | ✓ | 8 模型 + 3 port + RunSpec/RunState/RunRuntime 齐全 |
| FR-2 | 三层架构（D-12） | Task 1-21 | ✓ | 目录结构、依赖方向、Engine 不依赖 Pi SDK 均有 grep 验证 |
| FR-3 | 状态机 8→3 态+doneReason | Task 8 | ✓ | workflow-run.ts transition + VALID_TRANSITIONS 表完整 |
| FR-4 | dependency 收敛 5→3 port | Task 1 (ports.ts) | ✓ | AgentRunner/RunStore/WorkerHost，砍 IWorkerHandle/IConcurrencyGate/ApprovalStore 有说明 |
| FR-5 | tool 收口 4→2 | Task 19 | 部分 | tool 划分正确，但 tool-workflow.ts / tool-workflow-script.ts 只有 action 注释，无 schema/execute 代码 |
| FR-6 | command 收口仅 /workflows | Task 20 | ✓ | commands.ts 瘦身 + 移除 restart 快捷键 |
| FR-7 | ConcurrencyGate 重命名，maxConcurrency=4 | Task 9 | ✓ | D-13 一致性已验证（见 A.3） |

### A.2 AC（验收标准）覆盖

| AC | 描述 | 覆盖 Task | 状态 | 备注 |
|----|------|----------|------|------|
| AC-1 | 架构合规（三层向下） | 全 Wave + 最终 grep | ✓ | grep 命令齐全 |
| AC-2 | 重复消除 | Task 7, 18, 23 | ✓ | terminateDeps/Context factory/OrchestratorCore/4 boolean flag 全部 grep 验证 |
| AC-3 | 模型封装 | Task 5, 8, 10 | ✓ | assignRuntime/releaseRuntime/replaceRuntime/WorkerHandle.isCurrent |
| AC-4 | 外部契约（pi.__workflowRun + gate caller） | Task 18, 22 | 部分 | **launcher.ts 为纯注释占位**，time_limited 转换无代码（见 C.7） |
| AC-5 | 测试重写 | Task 24 | 部分 | 测试清单完整，但 Task 8 的测试代码有 runtime bug（见 C.1） |
| AC-6 | typecheck/lint 零容忍 | 每 Wave gate | ✓ | 验证命令齐全 |

### A.3 D-12「砍掉的伪抽象」7 项覆盖检查

| # | 砍掉的抽象 | 对应 Task | 现状验证 | 状态 |
|---|-----------|----------|---------|------|
| 1 | IWorkerHandle interface | Task 10 明确「无 IWorkerHandle interface」 | 现状无此 interface（grep 无结果） | ✓ |
| 2 | IConcurrencyGate interface | Task 9 明确「无 Impl 后缀，无 implements」 | 现状无此 interface | ✓ |
| 3 | ApprovalStore port + ApprovalPolicy class | Task 19 helper requiresConfirmation | **现状并非 class**，是 tool-workflow-run.ts 内联 `sessionApprovals: Set<string>` + 2 行判断 | ✓（D-11 spec 已承认「现状就 1 个 Set + 2 行代码」，Task 19 提取为 helper 准确） |
| 4 | NotificationService class | Task 19 helper notifyDone | **现状并非 class**，是 commands.ts:62 `sendCompletionNotification()` 函数 | ✓（Task 19 重命名为 notifyDone） |
| 5 | AgentCall.execute() 上帝方法 | Task 4（纯数据）+ Task 17（executeAgentCall 函数） | **现状并无 AgentCall.execute() 方法**，executeWithRetry 已是 agent-call-handler.ts:70 的独立函数 | 部分（见 D.1 框架问题） |
| 6 | Budget.onConsume 回调 | Task 2 删除 + 测试 `expect("onConsume" in b).toBe(false)` | **现状并无 onConsume 回调**（grep 无结果），实际是 `softWarningSent + setBudget + maybeEmitSoftWarning + _budgetWarningSent` 副作用链 | 部分（见 D.2 框架问题） |
| 7 | Application 层 3 个 Service | Task 16/18 free functions | 现状无 Application 层（旧 plan 概念） | ✓（plan.md 任务数对比已显式说明 -3） |

### A.4 D-13 maxConcurrency=4 一致性检查

| 位置 | 代码 | 一致 |
|------|------|------|
| Task 9 ConcurrencyGate 构造器 | `this.maxConcurrency = opts.maxConcurrency; // 调用方传 4（D-13）` | ✓ |
| Task 18 runWorkflow | `new ConcurrencyGate({ maxConcurrency: 4, runName: spec.scriptName })` | ✓ |
| Task 18 resumeRun | `new ConcurrencyGate({ maxConcurrency: 4, ... })` | ✓ |
| Task 18 retryNode | `new ConcurrencyGate({ maxConcurrency: 4, ... })` | ✓ |
| 现状 infra/agent-pool.ts:121 | `const DEFAULT_CONCURRENCY = 4;` | ✓（基线一致） |

### A.5 AC-4 gate caller 5 处 status→reason 覆盖检查

grep 验证 `wfResult\.status\|status: string` 在两个文件的确切行号：

| 文件 | 行号 | 当前代码 | Task 22 目标改动 | 覆盖 |
|------|------|---------|----------------|------|
| review-gate.ts | 39 | `Promise<{ status: string; ... }>` | `Promise<{ status: "done"; reason: DoneReason; ... }>` | ✓ |
| review-gate.ts | 76 | `if (wfResult.status !== "completed" \|\| ...)` | `if (wfResult.reason !== "completed" \|\| ...)` | ✓ |
| review-gate.ts | 79 | `failed (status=${wfResult.status}):` | `failed (reason=${wfResult.reason}):` | ✓ |
| review-gate.ts | 80 | `details: { status: wfResult.status, ... }` | `details: { reason: wfResult.reason, ... }` | ✓ |
| review-gate.ts | 89 | `details: { status: wfResult.status, ... }` | `details: { reason: wfResult.reason, ... }` | ✓ |
| test-fix-loop.ts | 39, 76, 79, 80, 89 | 同构 | 同构 | ✓ |

**plan 给出的行号 `~39/~76/~79/~80/~89` 与实际文件完全吻合**。

### A.6 domain-models.md 不变式测试覆盖检查

| 不变式 | 要求 | Task | 测试代码 | 状态 |
|--------|------|------|---------|------|
| G3-001 | pause 丢弃 runtime | Task 8 | `run.transition("paused"); expect(run.runtime).toBeUndefined()` | ✓ 但 **测试会抛异常**（见 C.1） |
| G5-001 | replaceRuntime 原子替换 | Task 8 | `run.replaceRuntime(rt2); expect(run.runtime).toBe(rt2)` | ✓ |
| G6-001 | replaceRuntime 前置 running | Task 8 | `expect(() => run.replaceRuntime(...)).toThrow()` 在 paused 下 | ✓ |

### A.7 domain-models.md §失败处理矩阵覆盖检查

| 失败类型 | 重试 | Task 覆盖 | 状态 |
|---------|------|----------|------|
| Worker error/exit | 3 次 1s/2s/4s | Task 18 error-recovery `BACKOFF_MS=[1000,2000,4000]` | 部分（retryCount 来源未说明，见 C.5） |
| Script error | 3 次 1s/2s/4s | Task 18 handleScriptError | 部分（仅骨架） |
| Agent call 失败 | 3 次 1s/2s/4s | Task 17 executeAgentCall | 部分（**body 全是注释占位**，见 B.4） |
| Stale context | 0 次 | Task 17 STALE_CONTEXT_PATTERNS | 部分（同上） |
| Budget exceeded | 0 次 → budget_limited | Task 17 budget.isExceeded 检查 | 部分（同上） |
| **Time exceeded** | 0 次 → time_limited | **Task 18 launcher.ts** | **未覆盖**（见 C.7） |

---

## Part B: 占位符扫描结果

按危险程度排序。SKILL.md「禁止占位符」明确禁止「只描述做什么而不展示怎么做」「引用未在任何任务中定义的类型/函数/方法」。

### B.1 【高危险】Task 18 makeHandlers 完全是占位

`plan-w3-iface.md` Task 18 Step 1 lifecycle.ts：

```ts
function makeHandlers(run: WorkflowRun, deps: LifecycleDeps) {
  return {
    onMessage: async (raw: unknown) => { /* 从 worker-manager.ts handleWorkerMessage 迁移 */ },
    onError: async (err: Error) => { /* 调 error-recovery.ts handleWorkerError */ },
    onExit: async (code: number) => { /* 调 error-recovery.ts handleWorkerExit */ },
  };
}
```

三个 handler body 都是注释占位。这是整个重构最高风险的 dispatch 入口（Worker 消息路由、错误恢复触发），却没有任何实际代码。违反「禁止占位符」。

### B.2 【高危险】Task 18 launcher.ts 完全是注释

Task 18 Step 4：

```ts
export async function runAndWait(...): Promise<WorkflowRunResult> {
  // 1. registry.get(name) → WorkflowScript
  // 2. toExecutable() → scriptSource
  // 3. runWorkflow(spec, deps, signal)
  // 4. 轮询直到 done
  // 5. 返回 { status: "done", reason: run.state.reason, scriptResult, error, runId }
  // 从 lifecycle.ts runWorkflowAndWait 迁移，改返回 reason（D-8）
}
```

5 步全是注释。这是 AC-4 的契约表面（`pi.__workflowRun` 的实际实现），也是 time_limited 转换的唯一可能位置（见 C.7）。无任何代码。

### B.3 【高危险】Task 17 executeAgentCall body 全是注释

`plan-w3-iface.md` Task 17：

```ts
export async function executeAgentCall(...): Promise<void> {
  // 从 executeWithRetry 迁移：
  // 1. 预算检查（budget.isExceeded() → 不重试）
  // 2. call.markRunning()（attempts++）
  // 3. runner.run(call.opts, signal)
  // 4. stale-context 检测
  // 5. 成功：call.markDone + trace.update + budget.consume
  // 6. 失败：retry（MAX_RETRIES=3，指数退避 1s/2s/4s）
}
```

6 步全是注释。失败处理矩阵的 3 行（Agent call / Stale / Budget）都依赖此函数，但 retry 循环、stale 检测、budget 短路代码均未展示。

### B.4 【中危险】Task 9 ConcurrencyGate.enqueue body 占位

`plan-w2-infra.md` Task 9：

```ts
async enqueue(opts: AgentCallOpts, signal?: AbortSignal): Promise<AgentResult> {
  // 从 agent-pool.ts enqueue 方法迁移，删除 budget 检查（Engine executeAgentCall 查 budget）
  // 保留 per-call AbortController 合并（signal + timeoutMs）
}
```

body 是注释。FIFO 队列、abort 传播、per-call timeoutMs 合并的具体代码缺失。

### B.5 【中危险】Task 19 两个 tool 完全是 action 注释

`plan-w3-iface.md` Task 19 Step 2/3：

```ts
// actions: run / status / pause / resume / abort / retry-node / skip-node
// 不包含 restart（D-9 废弃）
// reentry-guard 保留（共享对象）
```

```ts
// actions: generate / lint / save / delete / list
// generate: tool_call 自动注入 SKILL.md（隐式契约保留）
// lint: 调 engine/script-lint.ts lintScript
```

7 actions + 5 actions 的 schema 定义、execute 分发、reentry-guard 使用方式全部缺失。这是 Interface 层的核心交付物。

### B.6 【中危险】Task 21 index.ts factory 关键事件处理占位

```ts
// ... session_tree / session_shutdown 事件处理（保留现有逻辑，调 Engine 函数）
```

session_tree 强制 paused + session_shutdown pause-all 是 spec 明确要求保留的隐式契约（domain-models.md §隐式契约保留清单），但 plan 只用一行注释带过。

### B.7 【低危险】可接受的迁移指针

以下 task 用「从 X 文件迁移」+ 精确行数描述，**可接受**（因为引用了具体可读的现有文件）：

- Task 12 SubprocessAgentRunner（参考 pi-runner.ts 185 行）
- Task 13 JsonlRunStore（参考 state-store.ts 115 行）
- Task 14 WorkflowScriptRegistryImpl（参考 config-loader.ts 321 行 + workflow-files.ts 86 行）
- Task 16 script-lint（参考 infra/script-lint.ts 207 行）
- Task 20 WorkflowsView（参考现有 WorkflowsView.ts）

---

## Part C: 类型一致性问题

### C.1 【MUST FIX】Task 8 测试用 `{} as RunRuntime` 会运行时崩溃

`plan-w1-engine.md` Task 8 多处：

```ts
const rt = {} as RunRuntime;
run.assignRuntime(rt);
run.transition("running");
run.transition("paused");  // ← 这里抛 TypeError
```

**问题**：Task 7 定义的 `RunRuntime` 有 `release(mode)` 方法，`releaseRuntime()` 会调 `this.runtime.release("pause")`。`{}` 没有 `release` 方法，`transition("paused" | "done")` 会同步抛 `TypeError: this.runtime.release is not a function`。

**受影响测试**（plan-w1-engine.md Task 8）：
- 「running → paused ✓（G3-001）」
- 「paused → running ✓（assignRuntime 重建）」（前置 paused 转换已崩）
- 「running → done(reason) ✓」
- 「done → 任何状态 抛错」（前置 done 转换已崩）
- 「releaseRuntime 置 runtime=undefined」
- 「replaceRuntime 原子替换（G5-001）」（replaceRuntime 内部调 `runtime.release("terminal")`）
- 「replaceRuntime 前置 status==="running"（G6-001）」（前置 paused 转换已崩）

**修复**：所有 `{} as RunRuntime` 改为带 stub release 的对象：

```ts
function makeStubRuntime(): RunRuntime {
  return { release: () => {} } as unknown as RunRuntime;
}
```

或用 vitest `vi.fn()`。

### C.2 【MUST FIX】Task 11 引用不存在的 `./worker-bootstrap.js`

`plan-w2-infra.md` Task 11 WorkerHostImpl.start：

```ts
const scriptPath = require.resolve("./worker-bootstrap.js");
const worker = new Worker(scriptPath, { workerData: { scriptSource: spec.scriptSource, args } });
```

**验证**：`find extensions/workflow -name "worker-bootstrap*"` 返回空。文件不存在。

**与 Task 12 矛盾**：Task 12 明确保留 `buildWorkerScript`（strip export + wrap + 注入 agent/parallel/pipeline/$ARGS/$BUDGET），而现状 `worker-manager.ts:42` 的做法是：

```ts
const workerCode = buildWorkerScript(scriptSource);
const worker = new Worker(workerCode, { eval: true, workerData: {...} });
```

即 `eval: true` + 内联构建的脚本字符串，**不是** require 一个 bootstrap 文件。Task 11 的 `require.resolve` 路径与 Task 12 的 buildWorkerScript 保留直接冲突。

**修复**：Task 11 改为保留现状 `eval: true` 方案：

```ts
start(spec: RunSpec, args, handlers: WorkerHandlers): WorkerHandle {
  const workerCode = buildWorkerScript(spec.scriptSource); // 来自 worker-script-builder.ts (Task 12)
  const worker = new Worker(workerCode, { eval: true, workerData: { scriptPath: spec.scriptPath, args, workspace: process.cwd() } });
  // ...
}
```

或显式声明「新增 worker-bootstrap.js 文件」并补充创建该文件的 sub-step。

### C.3 【MUST FIX】WorkerHandlers.onExit 签名 vs makeHandlers 返回值不一致

Task 1 ports.ts 定义：

```ts
export interface WorkerHandlers {
  onMessage(raw: unknown): Promise<void>;
  onError(err: Error): Promise<void>;
  onExit(code: number, handle: WorkerHandle): Promise<void>;  // ← 带 handle 参数
}
```

Task 18 makeHandlers 返回：

```ts
onExit: async (code: number) => { /* ... */ },  // ← 缺 handle 参数
```

**类型不一致**：TS 会报 TS2416（Property missing 'handle'）。而且 WorkerHandle 的竞态防护（G-025）依赖调用方能拿到 `handle` 并对比 `isCurrent`——onExit 不传 handle，handleWorkerExit 怎么做竞态判断？

**修复**：makeHandlers 的 onExit 签名对齐 `(code, handle) => ...`，并在 handleWorkerExit 内用 `handle.isCurrent` 替代旧的 `currentWorker !== exitedWorker`。

### C.4 【MUST FIX】Task 18 retryNode 不实际重跑 call

`plan-w3-iface.md` Task 18 node-ops.ts：

```ts
export async function retryNode(runId, callId, deps): Promise<void> {
  // ...
  run.replaceRuntime({ worker: newWorker, gate: newGate, controller: newController });
  // 重跑指定 callId（从 RunState.calls 取）
  await deps.store.save(run);
}
```

**问题**：replaceRuntime 之后只有一行注释「重跑指定 callId」，没有任何代码：
- 新 worker 如何被通知重跑？
- gate.enqueue 或 executeAgentCall 在哪里调用？
- callCache replay 逻辑在哪里？

**后果**：retryNode 实际上只重建了 runtime 然后保存，**不会重试任何东西**。spec FR-1「retryNode free function」名存实亡。

**修复**：补充重跑编排代码（至少展示如何从 RunState.calls 取 call + 调 executeAgentCall）。

### C.5 【MUST FIX】Task 18 handleWorkerError 的 retryCount 来源不明

Task 18 error-recovery.ts：

```ts
export async function handleWorkerError(run: WorkflowRun, err: Error, retryCount: number): Promise<void>
```

makeHandlers.onError：

```ts
onError: async (err: Error) => { /* 调 error-recovery.ts handleWorkerError */ },
```

**问题**：`retryCount` 参数从哪里来？makeHandlers 没传，RunRuntime/WorkflowRun 也没有 retryCount 字段（domain-models.md 未定义）。现状代码用 `RunResources.retryCounts: Map<string, number>`（run-resources.ts）+ `ctx.getRun(runId).retryCounts.get(callId)`，但新模型的 RunRuntime 删了 retryCounts。

**修复**：明确 retryCount 的载体。两个选项：
- 在 WorkflowRun/RunRuntime 加 `workerRetryCount: number` 字段
- 或在 handleWorkerError 内部从 RunState.calls 的 attempts 统计

### C.6 【MUST FIX】Task 18 handleScriptError 缺 stale 检测 + 预算检查

失败处理矩阵要求「Script error 3 次重试，retryCount 累加超限 failed」，但 Task 18 handleScriptError 只展示了：

```ts
export async function handleScriptError(run: WorkflowRun, retryCount: number): Promise<void> {
  if (retryCount >= MAX_WORKER_RETRIES) {
    run.transition("done", "failed");
  }
}
```

没有实际的退避 sleep、没有 retryCount 累加逻辑（调用方怎么 +1？）、没有 worker 重建触发。同样是骨架。

### C.7 【MUST FIX】time_limited 转换无任何 task 覆盖

domain-models.md §失败处理矩阵要求「Time exceeded → 0 次重试 → 转 time_limited 终态」。spec FR-3 也把 `time_limited` 列入 DoneReason。

**扫描结果**：
- Task 18 launcher.ts 有 `timeoutMs: number = 15 * 60_000` 参数，但 body 是注释（见 B.2）
- 没有任何 task 展示 `run.transition("done", "time_limited")` 的触发代码
- Task 18 error-recovery 只覆盖 worker/script error，不覆盖 timeout

**后果**：DoneReason 的 5 个值里有 1 个（time_limited）整个 plan 没有实现路径。AC-4 的 gate caller 会收到 `reason: "time_limited"` 类型，但 Engine 永远不会产生这个值。

**修复**：launcher.ts 必须展示 timeout 监测 + transition 代码：

```ts
const timeoutSignal = AbortSignal.timeout(timeoutMs);
timeoutSignal.addEventListener("abort", () => {
  if (run.state.status === "running") {
    run.transition("done", "time_limited");
  }
});
```

### C.8 【SHOULD FIX】Task 19 helpers.ts 使用 inline import type

```ts
export function notifyDone(
  pi: ExtensionAPI,
  runId: string,
  run: import("../engine/models/workflow-run.js").WorkflowRun,  // ← inline import type
  notifiedRunIds: Set<string>,
): void
```

**违反**：项目 taste-lint 规则 `no-inline-import-type`（CLAUDE.md 明确列出）。pre-commit hook 会拦。

**修复**：提到顶部 `import type { WorkflowRun } from "../engine/models/workflow-run.js";`。

---

## Part D: 迁移映射准确性

### D.1 plan.md「文件映射（旧→新）」抽查

| 旧文件 | plan 描述 | 实际验证 | 准确 |
|--------|----------|---------|------|
| `domain/state.ts` | 拆分 → types.ts + run-state.ts + workflow-run.ts | 312 行，含 WorkflowStatus(8态)/WorkflowBudget/AgentResult/ExecutionTraceNode（含 verifyStrategy:92）/ToolCallEntry/WorkflowInstance，拆分映射合理 | ✓ |
| `domain/run-resources.ts` | → run-runtime.ts | 含 RunResources interface（instance/meta/pool/worker/abortController），meta→RunSpec、instance→RunState、worker/pool/abortController→RunRuntime 拆分合理 | ✓ |
| `engine/core.ts` | 删除（OrchestratorCore 消失） | 存在，OrchestratorCore 被 worker-manager/lifecycle/etc 广泛引用（29 处 grep） | ✓ |
| `engine/lifecycle.ts` | → lifecycle.ts（free functions，原位） | 477 行，含 runWorkflow/pauseRun/resumeRun/abortRun + runWorkflowAndWait | ✓ |
| `engine/worker-manager.ts` | → worker-host.ts + worker-handle.ts | 341 行。**但 worker-manager.ts 既不含 WorkerHandle class，也不含 currentWorker/exitedWorker 竞态检查**（见 D.2） | 部分 |
| `engine/agent-call-handler.ts` | → agent-call.ts（数据）+ execute-agent-call.ts（编排） | 198 行，executeWithRetry:70 + AgentCallContext:50，映射准确 | ✓ |
| `engine/error-handlers.ts` | → error-recovery.ts | 191 行。**currentWorker/exitedWorker 竞态检查实际在此文件:83,92,93**，不在 worker-manager.ts | ✓（但 plan Task 10 prose 归属错误，见 D.2） |
| `engine/worker-script.ts` | → infra/worker-script-builder.ts | 269 行，buildWorkerScript 导出存在 | ✓ |
| `infra/agent-pool.ts` | → infra/concurrency-gate.ts（maxConcurrency=4） | 385 行，DEFAULT_CONCURRENCY=4（:121），setBudget:163 + maybeEmitSoftWarning:367 + softWarningSent:147 均存在（Task 9 删除目标准确） | ✓ |
| `infra/pi-runner.ts` | → infra/subprocess-agent-runner.ts | 185 行，runPiProcess:81 导出存在 | ✓ |
| `infra/config-loader.ts + workflow-files.ts` | → workflow-script-registry-impl.ts | 321 + 86 行，合并目标合理 | ✓ |
| `infra/state-store.ts` | → infra/jsonl-run-store.ts | 115 行 | ✓ |
| `infra/script-lint.ts` | → engine/script-lint.ts | 207 行 | ✓ |
| `infra/execution-trace.ts` | → engine/models/trace.ts（appendTraceNode 合并） | appendTraceNode:29 存在；engine/trace-commit.ts:24 commitTraceNode 也存在（双源合并合理） | ✓ |
| `orchestrator.ts` | 拆分到 lifecycle/node-ops/launcher | 359 行，WorkflowOrchestrator class（:78）implements OrchestratorCore，~35 方法（God Facade 名实相符） | ✓ |
| `interface/commands.ts` | 瘦身 + helpers.ts | sendCompletionNotification:62 存在（移到 helpers） | ✓ |

**行数核对**：plan 引用的 11 个文件行数（312/341/477/198/191/321/86/207/185/269/115）全部与实际一致。✓

### D.2 【SHOULD FIX】Task 10 prose 错误归属竞态检查来源

`plan-w2-infra.md` Task 10：

> 迁移要点：`worker-manager.ts` 的 `currentWorker !== exitedWorker` 检查（error-handlers.ts:83,92,93）被 `isCurrent` getter 封装。

**问题**：这句话自相矛盾——既说「worker-manager.ts 的检查」，又给出「error-handlers.ts:83,92,93」的行号。实际验证：

```
$ grep -n "currentWorker\|exitedWorker" extensions/workflow/src/engine/worker-manager.ts
（空）

$ grep -rn "currentWorker\|exitedWorker" extensions/workflow/src/
error-handlers.test.ts:153-161（测试）
error-handlers.ts:83   exitedWorker: Worker,
error-handlers.ts:92   const currentWorker = run?.worker;
error-handlers.ts:93   if (currentWorker !== exitedWorker) return;
```

**事实**：
- `worker-manager.ts` 既没有 WorkerHandle class，也没有 currentWorker/exitedWorker 检查。它只是把 `worker` 作为 bare `Worker` 存在 `run.worker`（:73）。
- 竞态检查完全在 `error-handlers.ts:83,92,93`。

**后果**：执行者按 plan 指引去 worker-manager.ts 找封装逻辑会扑空。WorkerHandle 实际是**新写的类**，整合自：(a) worker-manager.ts 的 `run.worker = worker` 字段模式 + (b) error-handlers.ts 的 `currentWorker !== exitedWorker` 守卫。

**修复**：Task 10 迁移要点改为：

> WorkerHandle 是**新增类**（现状无此类）。整合两个来源：
> - `worker-manager.ts:73` 的 `run.worker = worker`（bare Worker 字段）→ 封装为 `WorkerHandle.worker` private 字段
> - `error-handlers.ts:83,92,93` 的 `currentWorker !== exitedWorker` 竞态守卫 → 封装为 `WorkerHandle.isCurrent` getter（terminate 后 false，所有 onMessage/onError/onExit 回调内部检查 isCurrent）

### D.3 【SHOULD FIX】D-12「Budget.onConsume 回调」框架与现状不符

domain-models.md §4 + D-12：

> 设计决策（D-12）：删除 `onConsume` 回调 + `softWarningSent` 字段。

**验证**：

```
$ grep -rn "onConsume" extensions/workflow/src/
（空）
```

现状代码**根本没有 onConsume 回调**。实际的 budget 副作用链是：

| 现状机制 | 位置 | Task 删除目标 |
|---------|------|-------------|
| `softWarningSent` 字段 | infra/agent-pool.ts:147 | Task 9 ✓ |
| `setBudget(budget)` 方法 | infra/agent-pool.ts:163 | Task 9 ✓ |
| `maybeEmitSoftWarning(budget)` 方法 | infra/agent-pool.ts:367 | Task 9 ✓ |
| `_budgetWarningSent` 字段 | domain/state.ts:58 + orchestrator-budget.ts:67 | Task 2/16（budget 重写时丢弃）✓ |

Task 2 测试 `expect("onConsume" in b).toBe(false)` 测的是一个**从未存在**的字段，永远 pass，无实际验证意义。

**修复**：D-12/domain-models.md §4 改为「删除 `softWarningSent + setBudget + maybeEmitSoftWarning + _budgetWarningSent` 副作用链（值对象不应持可变状态 + 跨层回调）」。Task 2 测试改为 `expect("softWarningSent" in b).toBe(false)` + `expect(b.setBudget).toBeUndefined()`（测真实删除的东西）。

### D.4 【SHOULD FIX】D-12「AgentCall.execute() 上帝方法」框架与现状不符

domain-models.md §5 + D-12：

> 设计决策（D-12）：AgentCall 只持数据 + 不变式守卫，**不持 `execute()` 方法**……执行编排提取为 Engine 层 free function `executeAgentCall`。

**验证**：

```
$ grep -rn "class AgentCall\|\.execute(" extensions/workflow/src/engine/agent-call-handler.ts extensions/workflow/src/domain/
（空，AgentCall 在现状是 interface 不是 class，无 execute 方法）
```

现状 `AgentCall` 是 `domain/state.ts` 里的 interface（纯数据），执行逻辑已经是 free function `executeWithRetry(ctx, runId, callId, opts, instance, node, attempt)`（agent-call-handler.ts:70）。**根本没有「上帝方法」可删**。

Task 17 实际做的是：`executeWithRetry(ctx: AgentCallContext, ...)` → `executeAgentCall(call, runner, budget, signal, trace)`，即**参数重组**（Context factory → 显式参数）+ **文件重命名**，不是「方法提取」。

**修复**：D-12/domain-models.md §5 改为「executeWithRetry 重组：AgentCallContext（依赖注入 bag）→ 显式 5 参数（call/runner/budget/signal/trace），消除 errorHandlerContext/agentCallContext/budgetCallbacks 3 个 Context factory（AC-2 目标）」。

### D.5 现状源码文件清单与 plan 删除目标对齐

Task 23 删除清单（21 个文件 + domain/ 目录）与 `ls extensions/workflow/src/` 实际结构对照：

| plan 删除目标 | 实际存在 | 一致 |
|-------------|---------|------|
| engine/{core,lifecycle,worker-manager,agent-call-handler,error-handlers,orchestrator-budget,orchestrator-events,terminate-instance,trace-commit,worker-script}.ts | 10 个全部存在 | ✓ |
| orchestrator.ts | 存在 | ✓ |
| domain/state.ts + run-resources.ts | 存在 | ✓ |
| infra/{agent-pool,pi-runner,config-loader,workflow-files,state-store,script-lint,execution-trace}.ts | 7 个全部存在 | ✓ |
| interface/{tool-workflow-run,tool-generate,tool-workflow-lint}.ts | 3 个全部存在 | ✓ |
| __tests__/{orchestrator,orchestrator-stale,error-handlers}.test.ts | 存在 | ✓ |

删除清单完整准确。

### D.6 现状测试文件清单（Task 24 重写目标）

`extensions/workflow/src/__tests__/` 现有 18 个测试 + `engine/__tests__/` 3 个。Task 24 重写目标：
- index.test.ts（适配新 factory）✓
- orchestrator.test.ts / orchestrator-stale.test.ts（删除）✓
- error-handlers.test.ts（删除）✓
- 其余（agent-discovery/agent-pool/commands-generate/config-loader/jsonl-parser/orchestrator-events/script-lint/state-budget/state-machine/state-store/state/tool-generate/worker-runtime/worker-script/workflows-view）需逐个评估是否适配新 API——**plan 未列出逐文件处理策略**，只在 Task 24 用「Keep: Wave 1-3 已写的」+「Rewrite: index.test.ts」二分。

**建议**：Task 24 补一个「保留 / 重写 / 删除」三态清单，明确 18 个现有测试文件的归属。

---

## 总结：plan 是否可进入 Phase 3？

### 不可直接进入。8 项 must_fix 阻断。

#### must_fix（阻断，必须修后再进 Phase 3）

| # | 问题 | 影响 | 修复成本 |
|---|------|------|---------|
| C.1 | Task 8 测试 `{} as RunRuntime` 会运行时崩溃 | Wave 1 核心测试无法 pass，gate 卡死 | 低（改 stub） |
| C.2 | Task 11 引用不存在的 worker-bootstrap.js + 与 Task 12 矛盾 | Worker 启动路径无法实现 | 中（对齐 eval:true 或补 bootstrap sub-task） |
| C.3 | WorkerHandlers.onExit 签名 vs makeHandlers 不一致 | typecheck 失败 + 竞态防护断链 | 低（改签名） |
| C.4 | Task 18 retryNode 不实际重跑 call | FR-1 retryNode 名存实亡 | 中（补编排代码） |
| C.5 | Task 18 handleWorkerError retryCount 来源不明 | worker error 重试无法实现 | 中（明确载体） |
| C.6 | Task 18 handleScriptError 缺退避 + 累加 + 重建 | script error 重试无法实现 | 中（补完） |
| C.7 | time_limited 转换无任何 task 覆盖 | DoneReason 5 值缺 1，AC-4 契约表面有洞 | 中（launcher 补 timeout 代码） |
| B.1/B.2/B.3 | Task 17/18 核心 function body 全是注释占位 | 违反「禁止占位符」；执行者无足够信息实现；最高风险 task（executeAgentCall/makeHandlers/launcher）反而是最薄 placeholder | 高（需补完整 retry loop / dispatch / timeout 代码） |

注：B.1/B.2/B.3 合并为一条，因为是同一类问题（Wave 3 BG5 三个核心 function 全是骨架）。单独看每一个都是 must_fix。

#### should_fix（不阻断，建议在对应 Wave 执行前补）

| # | 问题 | 建议 |
|---|------|------|
| D.2 | Task 10 prose 错误归属竞态检查来源（说 worker-manager.ts 实际 error-handlers.ts） | 改 prose，明确 WorkerHandle 是新增类 + 整合两来源 |
| D.3 | D-12「Budget.onConsume 回调」框架与现状不符（onConsume 从未存在） | 改框架为「删除 softWarningSent + setBudget + maybeEmitSoftWarning + _budgetWarningSent 副作用链」；Task 2 测试改测真实删除项 |
| D.4 | D-12「AgentCall.execute() 上帝方法」框架与现状不符（executeWithRetry 已是函数） | 改框架为「executeWithRetry 参数重组 + 文件重命名」 |
| C.8 | Task 19 helpers.ts 用 inline import type（违反 taste-lint） | 提到顶部 import |
| B.4 | Task 9 ConcurrencyGate.enqueue body 占位 | 补 FIFO + abort 传播代码（或显式声明「逐行对照 agent-pool.ts:enqueue」并给出关键行号） |
| B.5 | Task 19 两个 tool 完全是 action 注释 | 补 typebox schema + execute 分发骨架 |
| D.6 | Task 24 未列 18 个现有测试文件的三态归属 | 补「保留/重写/删除」清单 |

### 可进入 Phase 3 的前置条件

1. 修完 8 项 must_fix（C.1-C.7 + B.1/B.2/B.3 合并项）
2. 至少在 plan 层面把 Task 17/18 的核心 function 补成可执行代码（不是注释）
3. 重新跑一次 writing-plans SKILL.md 的「自我审查」第 3 维度（类型一致性），确认 ports.ts 的 forward ref（RunSpec/WorkflowRun/WorkerHandle）在 Task 6/8/10 完成后能无缝恢复

### 整体评价

**优点**：
- 规格覆盖（FR-1~7, AC-1~6）映射清晰，Spec Coverage Matrix 严谨
- 迁移映射的文件清单、行数、删除目标全部经得起 grep 验证（D.1/D.5 全部 ✓）
- D-12/D-13 一致性在所有相关 task 都有体现（A.3/A.4）
- AC-4 gate caller 的 5 处改动行号精确（A.5）
- Wave 划分 + 并行度规划合理，渐进式迁移策略（新旧并存到 Task 21 切换）风险可控

**核心缺陷**：
- **最关键的 Wave 3 BG5（Task 17/18）反而最薄**——executeAgentCall / makeHandlers / launcher / handleWorkerError / retryNode 的核心逻辑全是注释占位，违反 SKILL.md「禁止占位符」最严重的那条（「只描述做什么而不展示怎么做」）
- Task 8 测试代码有运行时崩溃 bug（C.1），是最容易修但影响最大的问题
- Task 11 引用不存在的文件（C.2），说明主 agent 在写 WorkerHostImpl 时没有 read 现有 startWorker 代码

**结论**：plan 骨架健全（架构决策、文件映射、Wave 调度都经得起验证），但**最高风险 task 的实现细节严重不足**。建议主 agent 集中补完 Task 17/18 的实际代码 + 修 C.1-C.7 后，再进 Phase 3。
