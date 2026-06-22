# Plan 独立审查报告 Round 2（收敛复核）

**审查对象**：`.xyz-harness/2026-06-21-workflow-refactor/` 下的 plan.md + 4 个子 plan（24 task）
**审查标准**：writing-plans SKILL.md 三维度（规格覆盖 / 占位符扫描 / 类型一致性）+ Round 1 must_fix/should_fix 落地验证 + 新引入矛盾扫描
**审查方法**：read + grep 验证所有事实声明，对照 `extensions/workflow/src/` 和 `extensions/coding-workflow/lib/gates/` 现有源码
**审查日期**：2026-06-22
**审查结论**：**未收敛（NOT CONVERGED）**——Round 1 的 8 项 must_fix 全部正确落地，但本轮补码过程引入了 **3 项新 must_fix**（2 个核心控制流占位 + 1 个验证 claim 与事实矛盾）+ 8 项新 should_fix。

---

## 收敛判定

**NOT CONVERGED**。阻断项：

| # | 新 must_fix | 性质 |
|---|------------|------|
| N1 | `handleWorkerError` 的 `deps.workerHost.start(spec, args, /* handlers */)` 第三参数是注释占位 → typecheck 报「Expected 3 arguments, got 2」；且无 handlers 则新 worker 消息无人路由 | 核心控制流（worker error retry 的 worker 重建）缺关键参数 |
| N2 | `handleScriptError` 的 worker 重建是纯注释 `// worker 重建（同 handleWorkerError） // ... replaceRuntime ...` | 核心控制流（script error retry）body 缺失 |
| N3 | Task 23 Step 4 声称 `pnpm typecheck` 删除后必须通过，但实际有 **12 个测试文件** import 已删除的源文件（agent-pool/config-loader/state-store/state/state-budget/state-machine/script-lint/worker-script/worker-runtime/orchestrator-events/commands-generate/workflows-view），typecheck 必然失败 | plan 的验证 claim 与事实矛盾 |

**已核查通过的维度**（见 Part A/B/C）：Round 1 的 C.1-C.7 + B.1/B.2/B.3 全部正确落地；5/7 should_fix 修复；类型一致性（Budget/WorkflowRun.meta/ConcurrencyGate/WorkerHost/executeAgentCall 五组签名）无新矛盾。

---

## Part A: Round 1 must_fix 修复验证（8/8 全部通过）

### A.1 C.1（Task 8 测试 stub RunRuntime）— ✓ FIXED

`plan-w1-engine.md` Task 8 Step 1：

```ts
function makeStubRuntime(): RunRuntime {
  return { release: () => {} } as unknown as RunRuntime;
}
```

grep 验证：`grep -n "{} as RunRuntime" plan-w1-engine.md` → 0 hits。所有 stub 统一为 `makeStubRuntime()`，stub 有 `release` 方法。releaseRuntime/replaceRuntime 调 `runtime.release(...)` 不再抛 TypeError。

### A.2 C.2（Task 11 worker-bootstrap.js）— ✓ FIXED

`plan-w2-infra.md` Task 11 Step 1：

```ts
const workerCode = buildWorkerScript(spec.scriptSource);
const worker = new Worker(workerCode, { eval: true, workerData: { ... } });
```

grep 验证：`grep -n "require.resolve\|worker-bootstrap" plan-w2-infra.md` → 0 hits。与 Task 12 的 `buildWorkerScript` 保留一致。现状 `worker-manager.ts:43,49` 也是 `eval: true` + `buildWorkerScript`，方案对齐。

### A.3 C.3（WorkerHandlers.onExit 签名一致性）— ✓ FIXED

ports.ts 定义（Task 1）：
```ts
onExit(code: number, handle: WorkerHandle): Promise<void>;
```

makeHandlers 返回（Task 18 lifecycle.ts）：
```ts
onExit: async (code: number, handle: WorkerHandle) => {
  if (!handle.isCurrent) return; // G-025 竞态防护
  ...
}
```

签名一致（都带 `handle`），且 onExit 内用 `handle.isCurrent` 替代旧的 `currentWorker !== exitedWorker`。竞态防护链路闭合。

### A.4 C.4（retryNode 重跑 call）— ✓ FIXED（带设计副作用，见 D.5）

`plan-w3-iface.md` Task 18 node-ops.ts retryNode：

```ts
call.status = "pending";
call.attempts = 0;
await executeAgentCall(call, deps.runner, run.state.budget, newController.signal, run.state.trace);
```

retryNode 现在重置 call 状态 + 实际调 executeAgentCall。FR-1 retryNode 名实相符。**但补码引入新设计矛盾**（retryNode 既 replaceRuntime 启新 worker，又直接 executeAgentCall，两者语义冲突；且 makeHandlersForRetry 是 no-op stub）——见 Part D.5/D.6。

### A.5 C.5（retryCount 载体）— ✓ FIXED

`plan-w1-engine.md` Task 8 WorkflowRun.meta：
```ts
meta: { startedAt: string; completedAt?: string; pausedAt?: string;
        workerErrorCount?: number; scriptErrorCount?: number };
```

Task 18 lifecycle.ts onError/onExit：
```ts
const retryCount = run.meta.workerErrorCount ?? 0;
run.meta.workerErrorCount = retryCount + 1;
await handleWorkerError(run, err, retryCount, deps);
```

Task 18 error-recovery.ts handleScriptError：
```ts
const retryCount = run.meta.scriptErrorCount ?? 0;
run.meta.scriptErrorCount = retryCount + 1;
```

retryCount 载体明确（meta 字段，跨 runtime 存活），workerErrorCount（worker error+exit 共享）与 scriptErrorCount 分离，符合失败处理矩阵两行语义。**注**：domain-models.md §1 WorkflowRun.meta 未同步更新（仍为 `{ startedAt, completedAt?, pausedAt? }`），属轻微 spec 漂移——见 D.9。

### A.6 C.6（handleScriptError 退避 + 累加）— ✓ FIXED

`plan-w3-iface.md` Task 18 handleScriptError：

```ts
const retryCount = run.meta.scriptErrorCount ?? 0;
const newCount = retryCount + 1;
run.meta.scriptErrorCount = newCount;
if (newCount > MAX_WORKER_RETRIES) { run.transition("done", "failed"); ... return; }
await sleep(BACKOFF_MS[retryCount]);
```

退避 sleep + retryCount 累加 + 超限转 failed 全部补齐。手算 4 次 error 序列：sleep 1000/2000/4000 后第 4 次超限 → 3 次重试正确。**但 worker 重建部分仍是注释**（`// worker 重建（同 handleWorkerError）`）——见 N2。

### A.7 C.7（time_limited 转换）— ✓ FIXED

`plan-w3-iface.md` Task 18 launcher.ts runAndWait：

```ts
const timer = setTimeout(() => {
  const run = deps.runs.get(runId);
  if (run && run.state.status === "running") {
    run.transition("done", "time_limited");
  }
}, timeoutMs);
```

+ deadline 轮询超时后 `return { ..., reason: "time_limited", ... }`。DoneReason 5 值全部有实现路径（completed/failed/aborted/budget_limited/time_limited）。AC-4 契约表面闭合。

### A.8 B.1/B.2/B.3（核心 function body）— ✓ FIXED

| Round 1 编号 | function | Round 2 验证 |
|------------|----------|-------------|
| B.1 | makeHandlers（onMessage/onError/onExit） | ✓ 三 handler 均有实际路由代码（handleWorkerMessage/handleWorkerError+retryCount/handleWorkerExit+isCurrent） |
| B.2 | launcher.runAndWait | ✓ 有完整代码（registry.get → validate → toExecutable → runWorkflow → setTimeout(timeout) → 轮询 → toResult） |
| B.3 | executeAgentCall | ✓ 有完整 attemptCall 递归（预算检查 → markRunning → runner.run → budget.consume → stale 检测 → trace.update → 指数退避重试） |

三个最高风险 function 的核心控制流（dispatch / timeout / retry loop）从纯注释升级为可执行代码。

---

## Part B: Round 1 should_fix 修复验证（5 fixed + 2 partial）

### B.1 D.2（Task 10 WorkerHandle prose）— ✓ FIXED

`plan-w2-infra.md` Task 10 迁移要点：

> WorkerHandle 是**新增类**（现状无此类，裸 Worker 散落在两个位置）。整合两个来源：
> - `worker-manager.ts:73` 的 `run.worker = worker`（bare Worker 字段）→ 封装为 `WorkerHandle.worker` private 字段
> - `error-handlers.ts:83,92,93` 的 `currentWorker !== exitedWorker` 竞态守卫 → 封装为 `WorkerHandle.isCurrent` getter

grep 验证：`worker-manager.ts:73` 确为 `run.worker = worker`；`error-handlers.ts:83,92,93` 确为竞态检查（worker-manager.ts 内 grep `currentWorker\|exitedWorker` 为空）。prose 归属正确，不再自相矛盾。

### B.2 D.3（Budget.onConsume 框架）— ✓ FIXED

domain-models.md §4 + Task 2 测试：

> **设计决策（D-12）**：删除 `softWarningSent + setBudget + maybeEmitSoftWarning + _budgetWarningSent` 副作用链

Task 2 测试：
```ts
expect("softWarningSent" in b).toBe(false);
expect((b as unknown as { setBudget?: unknown }).setBudget).toBeUndefined();
```

grep 验证现状：`onConsume` 在 `extensions/workflow/src/` 内 0 hits（从未存在）；`softWarningSent` 在 `infra/agent-pool.ts:147`、`setBudget` 在 `:163`、`maybeEmitSoftWarning` 在 `:367`（真实删除项）。框架 prose 与测试均改为测真实删除项。

### B.3 D.4（AgentCall.execute 框架）— ✓ FIXED

domain-models.md §5：

> 现状执行逻辑已是 free function `executeWithRetry(ctx: AgentCallContext, ...)`，本决策做的是**参数重组**：AgentCallContext（依赖注入 bag）→ 显式 5 参数 `(call, runner, budget, signal, trace)`

grep 验证：`executeWithRetry` 确为 `agent-call-handler.ts:70` 的 free function（非 AgentCall 方法）；`class AgentCall` 在 `domain/state.ts` 内 0 hits（AgentCall 现状是 interface 无 execute）。框架从「提取上帝方法」改为「参数重组」，与现状一致。Task 17 实现也匹配（5 显式参数 + attemptCall 递归）。

### B.4 C.8（Task 19 helpers inline import type）— ⚠ PARTIAL（仅 helpers.ts 修复）

`plan-w3-iface.md` Task 19 helpers.ts：
```ts
import type { WorkflowRun } from "../engine/models/workflow-run.js"; // C.8: 提到顶部
```
✓ helpers.ts 的 `notifyDone` 参数已提到顶部 import。

**但** grep `import("` 在 plan-w3-iface.md 返回 4 处残留 inline import type：

| 行号 | 位置 | 代码 |
|------|------|------|
| 230 | Task 18 lifecycle.ts LifecycleDeps | `runner: import("./models/ports.js").AgentRunner;` |
| 624 | Task 19 tool-workflow.ts registerWorkflowTool | `registry: import("../engine/models/workflow-script-registry.js").WorkflowScriptRegistry` |
| 685 | Task 19 tool-workflow-script.ts registerWorkflowScriptTool | `registry: import("../engine/models/workflow-script-registry.js").WorkflowScriptRegistry` |
| (lifecycle.ts 顶部已有 `import type { RunStore, WorkerHost } from "./models/ports.js"`) | | AgentRunner 可直接加入该 import，无需 inline |

这 3 处违反 `taste/no-inline-import-type`（CLAUDE.md 明确列出，pre-commit 拦截）。其中 lifecycle.ts 的 `runner` 尤其荒谬——同文件顶部已 import 同模块的 RunStore/WorkerHost，AgentRunner 只需加到同一 import 语句。→ 见 D.3（should_fix）。

### B.5 B.5（Task 19 tool schema）— ✓ FIXED

tool-workflow.ts：
```ts
const params = Type.Object({
  action: StringEnum(["run","status","pause","resume","abort","retry-node","skip-node"]),
  name: Type.Optional(Type.String()), runId: Type.Optional(Type.String()),
  callId: Type.Optional(Type.Number()), args: Type.Optional(Type.Record(...)),
  mode: Type.Optional(StringEnum(["auto","force"])),
});
```
+ `switch (args.action)` 7 分支 execute dispatch + reentry-guard。

tool-workflow-script.ts：
```ts
const params = Type.Object({
  action: StringEnum(["generate","lint","save","delete","list"]), ...
});
```
+ `switch (args.action)` 5 分支。两个 tool 都有 typebox schema + execute 骨架。

### B.6 B.4（Task 9 ConcurrencyGate.enqueue body）— ✓ MARGINALLY FIXED

enqueue body 仍是注释：
```ts
async enqueue(opts: AgentCallOpts, signal?: AbortSignal): Promise<AgentResult> {
  // 从 agent-pool.ts enqueue 方法迁移，删除 budget 检查...
  // 保留 per-call AbortController 合并（signal + timeoutMs）
}
```

但「迁移要点」补了 `逐行对照 agent-pool.ts，保留 enqueue/drain/runPrivate/abort 传播逻辑。删除所有 budgetRef 引用`——符合 Round 1 建议的第二个选项（「显式声明逐行对照并给出关键函数名」）。agent-pool.ts 385 行可读、enqueue 逻辑明确。**接受为最低门槛通过**（非完美但够用）。

### B.7 D.6（Task 24 测试三态清单）— ✗ NOT FIXED（升级为新 must_fix N3）

Task 24 仍只说「Keep: Wave 1-3 已写的 / Rewrite: index.test.ts / Add: 集成测试」，**未列 18 个现有 `__tests__/` 文件的三态归属**。更严重的是，Task 23 只删 3 个测试文件（orchestrator/orchestrator-stale/error-handlers），但 grep 验证有 **12 个测试文件** import Task 23 删除的源文件：

| 测试文件 | import 的已删除源 | Task 23 处理 |
|---------|-----------------|-------------|
| `__tests__/agent-pool.test.ts` | `../infra/agent-pool`（删） | 未处理 |
| `__tests__/config-loader.test.ts` | `../infra/config-loader`（删） | 未处理 |
| `__tests__/state-store.test.ts` | `../domain/state.js`（删） | 未处理 |
| `__tests__/state.test.ts` | `../domain/state`（删） | 未处理 |
| `__tests__/state-budget.test.ts` | `../domain/state`（删） | 未处理 |
| `__tests__/state-machine.test.ts` | `../domain/state`（删） | 未处理 |
| `__tests__/script-lint.test.ts` | `../infra/script-lint`（删/迁） | 未处理 |
| `__tests__/worker-script.test.ts` | `../engine/worker-script`（删/迁） | 未处理 |
| `__tests__/worker-runtime.test.ts` | `../engine/worker-script`（删/迁） | 未处理 |
| `__tests__/orchestrator-events.test.ts` | `../engine/orchestrator-events.js`（删） | 未处理 |
| `__tests__/commands-generate.test.ts` | `../interface/tool-generate`+`../domain/state`（删） | 未处理 |
| `__tests__/workflows-view.test.ts` | `../domain/state.js`+`../orchestrator.js`（删） | 未处理 |

Task 23 Step 4 声称 `pnpm --filter @zhushanwen/pi-workflow typecheck` 必须通过——但删除源文件后这 12 个测试文件会全部报「Cannot find module」，typecheck 必然失败。这是 plan 的验证 claim 与事实的直接矛盾。→ 升级为 **must_fix N3**。

---

## Part C: 类型一致性核查（5 组签名，无新矛盾）

### C.1 Budget.consume（Task 2）vs executeAgentCall 调用（Task 17）— ✓ 一致（带 taste-lint warning）

- Task 2 签名：`consume(usage: AgentUsage): void`
- Task 17 调用：`budget.consume({ input: ..., output: ..., cacheRead, cacheWrite: 0, cost, contextTokens, turns } as never)`

签名一致，但 `as never` 是类型逃逸（见 D.4）。consume 实现只累加 `input+output`/`cost`，传入的 cacheRead/contextTokens/turns 被忽略——不是类型错误，是意图模糊（「四项 token」注释说合并 input+cacheWrite，但 consume 不区分）。建议 consume 显式取所需字段。

### C.2 WorkflowRun.meta（Task 8）vs lifecycle/error-recovery 使用（Task 18）— ✓ 一致

- Task 8 meta 定义含 `workerErrorCount?: number; scriptErrorCount?: number`
- lifecycle.onError/onExit 读写 `run.meta.workerErrorCount`
- error-recovery.handleScriptError 读写 `run.meta.scriptErrorCount`

字段名、可空性、读写位置全一致。**retryCount 语义手算**（以 workerErrorCount 为例）：
- onError 第 1 次：retryCount=0 传入 handleWorkerError，0>=3 false，sleep [0]=1000，重建 ✓
- 第 2 次：retryCount=1，sleep [1]=2000 ✓
- 第 3 次：retryCount=2，sleep [2]=4000 ✓
- 第 4 次：retryCount=3，3>=3 true，transition failed ✓（3 次重试正确）

handleScriptError 用 `newCount > MAX` 判定，序列同构（newCount=1,2,3 重建；4 失败）。两个函数 retryCount 语义一致（第 N 次错误 → 第 N 次重试），仅累加位置不同（worker 在 caller 累加、script 在 callee 累加）——设计不统一但功能正确。

### C.3 ConcurrencyGate 构造器（Task 9）vs Task 18 实例化 — ✓ 一致

- Task 9 签名：`constructor(opts: { maxConcurrency: number; runName: string })`
- 4 处实例化（runWorkflow/resumeRun/retryNode/handleWorkerError）全为 `new ConcurrencyGate({ maxConcurrency: 4, runName: ... })`

D-13 maxConcurrency=4 在所有调用点一致。

### C.4 WorkerHostImpl.start 返回值（Task 11）vs Task 18 使用 — ✓ 一致

- Task 11 签名：`start(spec, args, handlers): WorkerHandle`
- Task 18 4 处调用：`const worker = deps.workerHost.start(...)` 然后 `run.assignRuntime({ worker, ... })` / `run.replaceRuntime({ worker: newWorker, ... })`

返回类型 WorkerHandle 与 RunRuntime.worker 字段一致。**但 handleWorkerError 调用 `start(spec, args, /* handlers */)` 第三参数缺失** → 见 N1。

### C.5 executeAgentCall 参数（Task 17）vs Task 18 调用 — ✓ 一致

- Task 17 签名：`(call: AgentCall, runner: AgentRunner, budget: Budget, signal: AbortSignal, trace: Trace)`
- Task 18 retryNode 调用：`executeAgentCall(call, deps.runner, run.state.budget, newController.signal, run.state.trace)` — 5 参数顺序/类型全匹配

---

## Part D: 新引入的占位符 / 矛盾 / taste-lint 违规

### D.1 【MUST FIX N1】handleWorkerError 的 `/* handlers */` 是 type error

`plan-w3-iface.md` Task 18 error-recovery.ts line 385：

```ts
const newWorker = deps.workerHost.start(run.spec, run.spec.args, /* handlers */);
```

**问题**：`/* handlers */` 是注释，第三参数实际未传。ports.ts 定义 `start(spec, args, handlers: WorkerHandlers): WorkerHandle`——handlers 是必填参数。TS 报 TS2554（Expected 3 arguments, got 2）。即使强行运行，新 worker 的 onMessage/onError/onExit 全 undefined，worker 发的 agent_call 消息无人路由、error 无人恢复、exit 无人处理——worker error 重试的 worker 重建完全失效。

**这是 Round 1 B.1 修复 makeHandlers 时遗漏的对称点**：lifecycle.makeHandlers 有实际 handlers，但 error-recovery 的 worker 重建路径没复用 makeHandlers，而是留了 `/* handlers */` 占位。

**修复**：error-recovery.ts 应接受 handlers 参数（或从 deps 取 makeHandlers 工厂）：
```ts
export async function handleWorkerError(run, err, retryCount, deps: LifecycleDeps & { makeHandlers: (...) => WorkerHandlers }) {
  ...
  const newWorker = deps.workerHost.start(run.spec, run.spec.args, deps.makeHandlers(run, deps));
  ...
}
```
或把 makeHandlers 提取到独立模块供 lifecycle + error-recovery 共用。

### D.2 【MUST FIX N2】handleScriptError 的 worker 重建是纯注释

`plan-w3-iface.md` Task 18 error-recovery.ts handleScriptError：

```ts
await sleep(BACKOFF_MS[retryCount]);
// worker 重建（同 handleWorkerError）
// ... replaceRuntime ...
await deps.store.save(run);
```

**问题**：sleep 之后直接 save，worker 重建（start + replaceRuntime）完全是注释。script error 重试的 worker 重建链路断裂——sleep 完不做任何事就 save，run.state 不变，下一次 script error 还是同一个 worker 在跑（没重建），重试无意义。

按 Round 1 审查标准「核心控制流（retry loop / dispatch / timeout / 状态转换）只有注释无代码 = 问题」，script error retry 是失败处理矩阵明确的一行（3 次重试 + 退避 + worker 重建），worker 重建是该控制流的核心动作。注释占位不可接受。

**修复**：handleScriptError 复制 handleWorkerError 的 worker 重建代码块（start + ConcurrencyGate + replaceRuntime），或提取为公共 `rebuildRuntime(run, deps)` 函数供两者共用。

### D.3 【MUST FIX N3】Task 23 typecheck claim 与 12 个孤儿测试文件矛盾

见 Part B.7。Task 23 Step 4 声称删除后 `pnpm typecheck` 必须通过，但 12 个测试文件 import 已删除源文件，typecheck 必然失败。plan 的验证 claim 是错的。

**修复**（二选一）：
- 方案 A：Task 23 Step 3 把 12 个孤儿测试文件全部加入删除/重写清单（按 Part B.7 表格逐文件判定：agent-pool/config-loader/state-store/state/state-budget/state-machine/script-lint/worker-script/worker-runtime/orchestrator-events/commands-generate/workflows-view 对应的源全删了，测试应删或并到新模块的 __tests__）
- 方案 B：Task 23 Step 4 的 typecheck gate 移到 Task 24 之后（Task 24 重写完测试才 typecheck）

推荐方案 A（在 Task 23 一次性清理，Task 24 专注新增集成测试）。

### D.4 【SHOULD FIX】executeAgentCall 的 `as never` 类型逃逸

`plan-w3-iface.md` Task 17 line 140：

```ts
budget.consume({
  input: u.input + u.cacheWrite, output: u.output, cacheRead: u.cacheRead,
  cacheWrite: 0, cost: u.cost, contextTokens: u.contextTokens, turns: u.turns,
} as never);
```

`as never` 是类型逃逸，违反 taste-lint `no-unsafe-cast`（CLAUDE.md：`as never` 会绕过类型检查，warn 标记）。对象字面量已含 AgentUsage 全部字段，`as never` 多余——若类型不匹配应修 consume 签名或字面量，不应逃逸。修复：去掉 `as never`，若 TS 报错则补齐缺失字段。

### D.5 【SHOULD FIX】retryNode 设计矛盾：既启新 worker 又直接 executeAgentCall

`plan-w3-iface.md` Task 18 node-ops.ts retryNode：

```ts
const newWorker = deps.workerHost.start(run.spec, run.spec.args, makeHandlersForRetry(run, deps));
run.replaceRuntime({ worker: newWorker, gate: newGate, controller: newController });
call.status = "pending"; call.attempts = 0;
await executeAgentCall(call, deps.runner, run.state.budget, newController.signal, run.state.trace);
```

**设计矛盾**：
- worker-manager 的执行模型是 **worker 跑用户脚本 → 脚本调 agent() → 发 agent_call 消息 → 主线程 handleWorkerMessage 路由到 executeAgentCall**
- retryNode 同时做了两件互斥的事：
  1. `workerHost.start` + `replaceRuntime`：启动新 worker 重跑脚本（worker 会重新发 agent_call）
  2. `executeAgentCall(call, ...)`：主线程直接跑这个 call（绕过 worker）
- 结果：新 worker 重跑脚本时，已完成调用从 callCache replay，但**目标 callId** 被主线程直接执行了；worker 发的消息又进 no-op handlers（见 D.6）被丢弃。两条路径产出无法合并。

**修复**（二选一，需在 plan 明确选哪个）：
- 方案 A（推荐）：retryNode 不启新 worker，只重置 call + 调 executeAgentCall。适用于「单个 call 失败，worker 已继续往后跑或已退出」的场景。remove replaceRuntime 相关代码。
- 方案 B：retryNode 只 replaceRuntime 启新 worker，让它从 callCache replay 自然重跑目标 call（不直接调 executeAgentCall）。需 makeHandlersForRetry 用真实 handlers（非 no-op）。

当前 plan 两者都做，逻辑不能自洽。

### D.6 【SHOULD FIX】makeHandlersForRetry 返回 no-op stub

`plan-w3-iface.md` Task 18 node-ops.ts：

```ts
function makeHandlersForRetry(run: WorkflowRun, deps: LifecycleDeps) {
  // 同 lifecycle.ts makeHandlers（为简洁省略，实际应提取为公共函数）
  return { onMessage: async () => {}, onError: async () => {}, onExit: async () => {} };
}
```

三个 handler 全 no-op。retryNode 启的新 worker 发的任何消息（agent_call/return/error）都被吞掉。配合 D.5 的矛盾，这条 worker 路径完全是死代码。plan 注释「实际应提取为公共函数」承认是占位。

**修复**：把 lifecycle.makeHandlers 提取到独立可导出位置（如 `engine/handlers.ts`），lifecycle 和 node-ops 共用，删除 no-op stub。

### D.7 【SHOULD FIX】3 处新 inline import type（C.8 未彻底修）

见 Part B.4。plan-w3-iface.md 4 处 `import("`：
- lifecycle.ts:230 `runner: import("./models/ports.js").AgentRunner`
- tool-workflow.ts:624 `registry: import("...workflow-script-registry.js").WorkflowScriptRegistry`
- tool-workflow-script.ts:685 同上

违反 `taste/no-inline-import-type`。lifecycle.ts 顶部已 `import type { RunStore, WorkerHost } from "./models/ports.js"`，AgentRunner 加到同一行即可；两个 tool 同理加顶部 import type。pre-commit hook 会拦这 3 处。

### D.8 【SHOULD FIX】Task 21 session_tree/session_shutdown 仍注释占位（Round 1 B.6 遗留）

`plan-w3-iface.md` Task 21 index.ts line 812：

```ts
// ... session_tree / session_shutdown 事件处理（保留现有逻辑，调 Engine 函数）
```

Round 1 已标为中危险（B.6）：session_tree 强制 paused + session_shutdown pause-all 是 spec domain-models.md §隐式契约保留清单明确要求保留的，plan 仍一行注释带过。本轮未修。虽非核心控制流，但属 spec 明确列出的保留契约，应有至少 handler 注册的骨架代码（`pi.on("session_tree", ...)` + `pi.on("session_shutdown", ...)`）。

### D.9 【LOW】WorkflowRun.meta 新增字段未同步 domain-models.md

plan-w1-engine.md Task 8 给 meta 加了 `workerErrorCount?/scriptErrorCount?`（C.5 载体），但 domain-models.md §1 仍是 `meta: { startedAt, completedAt?, pausedAt? }`。spec 与 plan 漂移。建议 domain-models.md §1 同步更新 meta 类型（或在 §失败处理矩阵补一句「retryCount 载体为 meta.workerErrorCount/scriptErrorCount」）。

### D.10 【LOW】handleWorkerError 用动态 import，与 lifecycle 静态 import 不一致

`plan-w3-iface.md` error-recovery.ts line 384：

```ts
const { ConcurrencyGate } = await import("../infra/concurrency-gate.js");
```

lifecycle.ts 静态 `import { ConcurrencyGate } from "../infra/concurrency-gate.js"`，error-recovery 用动态 await import。无循环依赖（concurrency-gate 不反向 import error-recovery），动态 import 多余且不一致。修复：改静态 import。

### D.11 【LOW】registerWorkflowTool 内 2 处参数占位

`plan-w3-iface.md` tool-workflow.ts：
- line 644：`await pi.sendUserMessage(/* 确认提示 */);` — 确认消息内容占位
- line 648：`const runId = await runWorkflow(/* spec */, deps);` — spec 构造占位（应由 `script.toExecutable()` + args + scriptName + scriptPath 组装）

runWorkflow 的 spec 占位较关键（spec 是 runWorkflow 的核心入参），但 run action 的上下文已展示 script 拿到 + toExecutable 在 launcher 用过，执行者可推断。接受为低危险。

---

## Part E: 整体评价

### 修复成效

Round 1 的 8 项 must_fix 全部正确落地，且修复质量高：
- C.1 makeStubRuntime 干净统一
- C.2 eval:true 与 Task 12 buildWorkerScript 对齐
- C.3 onExit 签名 + isCurrent 竞态防护闭环
- C.5 retryCount 载体（meta 字段）设计合理，retryCount 序列手算正确（3 次重试）
- C.7 time_limited 双路径覆盖（setTimeout + deadline 轮询）
- B.1/B.2/B.3 三个核心 function 从注释升级为可执行代码，控制流完整

### 本轮引入的新问题

补码过程中，error-recovery.ts 的 worker 重建链路（handleWorkerError 的 handlers 参数 + handleScriptError 的整个重建块）成了新的占位重灾区。这是典型的「修了 makeHandlers（lifecycle 侧）但忘了对称修 error-recovery 侧」。加上 Task 23 测试清理不完整（验证 claim 与事实矛盾），共 3 项新 must_fix。

### 可进入 Phase 3 的前置条件

1. 修 N1（handleWorkerError 补 handlers 参数 / 提取 makeHandlers 公共）
2. 修 N2（handleScriptError 补 worker 重建代码 / 提取 rebuildRuntime 公共）
3. 修 N3（Task 23 补 12 个孤儿测试文件的删除/重写清单，或把 typecheck gate 移到 Task 24 后）
4. 建议（非阻断）一并修 D.5/D.6（retryNode 设计矛盾 + no-op stub，否则 retryNode 跑起来是死的）、D.7（3 处 inline import type，pre-commit 会拦）、D.4（`as never`）

### 结论

Round 1 的骨架修补扎实，但 error-recovery 的 worker 重建对称性遗漏 + Task 23 测试清理不完整，构成 3 项新 must_fix。**NOT CONVERGED，需 Round 3 修补后再进 Phase 3**。建议主 agent 集中处理 N1/N2/N3（+ D.5/D.6/D.7），这 6 项集中在 Task 18 和 Task 23/24，改动范围可控。
