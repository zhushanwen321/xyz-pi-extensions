# Plan 独立审查报告 Round 3（收敛复核）

**审查对象**：`.xyz-harness/2026-06-21-workflow-refactor/` 下的 plan.md + 4 个子 plan（24 task）
**审查标准**：writing-plans SKILL.md 三维度（规格覆盖 / 占位符扫描 / 类型一致性）+ Round 2 N1/N2/N3 + D.4/D.5/D.6/D.7/D.9/B.6/D.11 落地验证 + 本轮补码新引入矛盾扫描
**审查方法**：read + grep 验证所有事实声明，对照 `extensions/workflow/src/` 现有源码（22 个测试文件清单）
**审查日期**：2026-06-22
**审查结论**：**未收敛（NOT CONVERGED）**——Round 2 的 3 项 must_fix 中 N1/N2 正确落地，N3 修复覆盖不全（12/15）；本轮补码过程再次引入 **1 项补码对称性 must_fix**（handleScriptError 加 handlers 参数但调用点 handleWorkerMessage 未同步，与 Round 2 N1 同类）+ **1 项 N3 延续 must_fix**（Task 23 三态清单漏 3 个孤儿测试文件，Task 24 后 typecheck 仍失败）+ 1 项 should_fix（handleWorkerMessage agent_call 分支注释占位，Round 1 B.1 延留）。

---

## 收敛判定

**NOT CONVERGED**。阻断项：

| # | 新 must_fix | 性质 | 来源 |
|---|------------|------|------|
| M1 | `handleScriptError` 签名 `(run, errorMsg, deps, handlers)` 4 参数 vs `handleWorkerMessage` 调用 `handleScriptError(run, ..., deps)` 3 参数不一致 → TS2554 Expected 4 arguments, got 3。且 `handleWorkerMessage` 自身签名也只有 3 参数（无 handlers），无法向下游传 | 补码对称性遗漏（N2 修复给 handleScriptError 加 handlers 参数但忘了更新调用点，与 Round 2 N1 同类错误） | 本轮新引入 |
| M2 | Task 23 Step 3 三态清单覆盖 19/22 个测试文件，漏 3 个孤儿：`engine/__tests__/orchestrator-budget.test.ts` / `engine/__tests__/terminate-instance.test.ts` / `infra/__tests__/workflow-files.test.ts`。这 3 个文件 import 的源（orchestrator-budget.ts / terminate-instance.ts / workflow-files.ts + domain/state.ts + domain/run-resources.ts + config-loader.ts）在 Task 23 Step 2 全部删除，但既不在 Task 23 删除清单，也不在 Task 24 重写清单。Task 23 Step 4 声称「Task 24 完成后 typecheck 全绿」无法兑现 | N3 修复覆盖不全（Round 2 列 12 个，主 agent 按 12 个修；实际 15 个孤儿） | N3 延续 |

**已核查通过的维度**（见 Part A/B/C）：
- N1/N2/D.4/D.5/D.6/D.7/D.9/B.6/D.11 共 10 项修复全部正确落地
- D.10（动态 import 改静态）额外修复
- 类型一致性（rebuildRuntime 参数 / makeHandlers 返回 WorkerHandlers / retryNode controller.signal / handlers lazy 引用）4 组签名无新矛盾
- 本轮补码无新 inline import / 新 `as never` / 新 `await import`

---

## Part A: Round 2 must_fix + should_fix 修复验证

### A.1 N1（handleWorkerError 的 `/* handlers */` 占位）— ✓ FIXED

`plan-w3-iface.md` Task 18 error-recovery.ts：

grep 验证：
- `grep -n 'handlers \*/' plan-w3-iface.md` → 0 hits
- `grep -n '/\* handlers \*/' plan-w3-iface.md` → 0 hits

主 agent 采用「提取 rebuildRuntime 公共函数」方案（优于 Round 2 建议的「deps.makeHandlers 工厂」方案，因为 lifecycle.makeHandlers 已存在，提取 rebuildRuntime 让 error-recovery 内部复用更内聚）：

```ts
// line 365-375
async function rebuildRuntime(
  run: WorkflowRun,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): Promise<void> {
  const newWorker = deps.workerHost.start(run.spec, run.spec.args, handlers); // N1: 补 handlers 参数
  const newGate = new ConcurrencyGate({ maxConcurrency: 4, runName: run.spec.scriptName });
  const newController = new AbortController();
  run.replaceRuntime({ worker: newWorker, gate: newGate, controller: newController });
}
```

`workerHost.start` 第三参数 `handlers` 是实际变量（非注释），worker 重建后消息路由/错误恢复/exit 处理全部可用。handleWorkerError 签名 `(run, err, retryCount, deps, handlers)` 5 参数，line 391 调 `rebuildRuntime(run, deps, handlers)` 传 3 参数 ✓。

### A.2 N2（handleScriptError 的 worker 重建纯注释）— ✓ FIXED（但引入 M1，见 Part C）

`plan-w3-iface.md` Task 18 handleScriptError（line 396-417）：

```ts
export async function handleScriptError(
  run: WorkflowRun,
  errorMsg: string,
  deps: LifecycleDeps,
  handlers: WorkerHandlers, // N2: handlers 参数
): Promise<void> {
  const retryCount = run.meta.scriptErrorCount ?? 0;
  const newCount = retryCount + 1;
  run.meta.scriptErrorCount = newCount;
  if (newCount > MAX_WORKER_RETRIES) {
    run.state.error = `Script error after ${MAX_WORKER_RETRIES} retries: ${errorMsg}`;
    run.transition("done", "failed");
    await deps.store.save(run);
    return;
  }
  await sleep(BACKOFF_MS[retryCount]);
  await rebuildRuntime(run, deps, handlers); // N2: 实际重建（非注释）
  await deps.store.save(run);
}
```

退避 sleep + retryCount 累加 + 超限转 failed + rebuildRuntime 实际调用全部补齐。N2 语义层面修复 ✓。**但** N2 给 handleScriptError 加了第 4 个必填参数 `handlers`，调用点 `handleWorkerMessage` 没同步 → 见 Part C M1。

### A.3 N3（Task 23 typecheck claim 与孤儿测试矛盾）— ⚠ PARTIAL（升级为 M2）

`plan-w4-cleanup.md` Task 23 Step 3 现有四态清单：

| 态 | 文件数 | 文件 |
|----|--------|------|
| 删除 | 12 | agent-pool / commands-generate / config-loader / orchestrator / orchestrator-events / orchestrator-stale / state / state-budget / state-machine / state-store / tool-generate / engine/__tests__/error-handlers |
| 迁移 | 3 | script-lint（Task 16）/ worker-script（Task 12）/ worker-runtime（Task 10） |
| 保留 | 2 | agent-discovery / jsonl-parser |
| 重写 | 2 | index（Task 24）/ workflows-view（Task 24） |
| **合计** | **19** | |

**但实际 `extensions/workflow/src/` 现有 22 个测试文件**（`find ... -name "*.test.ts"` 验证）：

```
__tests__/ (18) + engine/__tests__/ (3) + infra/__tests__/ (1) = 22
```

Task 23 三态清单漏了 3 个：

| 漏掉的测试文件 | import 的已删除源 | Task 23 处理 |
|---------------|-----------------|-------------|
| `engine/__tests__/orchestrator-budget.test.ts` | `../orchestrator-budget.js`（line 112 删）+ `../../domain/state.js`（line 128 rm -rf domain/） | 未处理 |
| `engine/__tests__/terminate-instance.test.ts` | `../terminate-instance.js`（line 114 删）+ `../../domain/run-resources.js`（删）+ `../../domain/state.js`（删） | 未处理 |
| `infra/__tests__/workflow-files.test.ts` | `../workflow-files.js`（line 125 删）+ `../config-loader.js`（line 124 删） | 未处理 |

**后果**：Task 23 Step 4 声称「Task 23 结束时预期有 2 个测试文件报错（index/workflows-view.test），Task 24 完成后全绿」。实际 Task 23 结束时有 **5 个**测试文件报 Cannot find module（index + workflows-view + orchestrator-budget + terminate-instance + workflow-files），且 Task 24 Step 1-3 只重写 index.test.ts，不处理另外 4 个。Task 24 完成后 typecheck 仍失败，AC-6 无法满足。

**注**：Round 2 Part B.7 的表格本身也只列了 12 个孤儿（漏了这 3 个），主 agent 按 Round 2 清单修，自然延续遗漏。Round 3 独立审查发现实际孤儿数是 15（不是 12）。→ 升级为 **M2**。

**typecheck gate 时机说明**本身已修（Task 23 Step 4 明确「Task 24 完成后全绿」，不再要求 Task 23 后 typecheck 通过），这部分 ✓。问题在清单完整性。

### A.4 D.4（executeAgentCall 的 `as never` 类型逃逸）— ✓ FIXED

grep 验证：`grep -n 'as never' plan-w3-iface.md` → 1 hit，且是修复说明注释：

```
132:      // D.4 修复：去掉 as never 类型逃逸，构造合法 AgentUsage
```

line 134-142 的 `budget.consume({...})` 已去掉 `as never`，对象字面量含 AgentUsage 全部字段（input/output/cacheRead/cacheWrite/cost/contextTokens/turns）：

```ts
budget.consume({
  input: u.input + u.cacheWrite,
  output: u.output,
  cacheRead: u.cacheRead,
  cacheWrite: 0,
  cost: u.cost,
  contextTokens: u.contextTokens,
  turns: u.turns,
});
```

类型逃逸消除 ✓。

### A.5 D.5（retryNode 设计矛盾）— ✓ FIXED

`plan-w3-iface.md` Task 18 node-ops.ts retryNode（line 319-335）采用方案 A：

```ts
export async function retryNode(runId: string, callId: number, deps: LifecycleDeps): Promise<void> {
  const run = deps.runs.get(runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  if (run.state.status !== "running") throw new Error("retryNode requires status === running");
  const call = run.state.calls.get(callId);
  if (!call) throw new Error(`call not found: ${callId}`);

  // D.5 方案 A：只重置 call + 调 executeAgentCall（不 replaceRuntime 启新 worker）
  call.status = "pending";
  call.attempts = 0;
  const runtime = run.runtime;
  if (!runtime) throw new Error("runtime not available");
  await executeAgentCall(call, deps.runner, run.state.budget, runtime.controller.signal, run.state.trace);
  await deps.store.save(run);
}
```

grep 验证 retryNode 函数体（line 319-335）：
- 无 `workerHost.start` 调用 ✓
- 无 `replaceRuntime` 调用 ✓
- 只重置 call + 调 executeAgentCall ✓

设计矛盾消除：retryNode 语义明确为「重试单个失败 call」（主线程直接重跑），与 worker-error-retry 的「整个 worker 崩了重建」（rebuildRuntime + replaceRuntime）分离。prose 注释（line 312-313, 328-330）清晰说明方案 A 的选择理由。

### A.6 D.6（makeHandlersForRetry no-op stub）— ✓ FIXED

grep 验证：`grep -n 'makeHandlersForRetry' plan-w3-iface.md` → 1 hit，仅是修复说明：

```
348: **D.6 修复**：删除 makeHandlersForRetry no-op stub（不再需要，retryNode 不启新 worker）。
```

实际 stub 已删除（line 319-335 的 retryNode 函数内无 makeHandlersForRetry 调用）。D.5 + D.6 联动修复——retryNode 不启新 worker，自然不需要 makeHandlersForRetry。✓

### A.7 D.7（3 处 inline import type）— ✓ FIXED

grep 验证：`grep -n 'import("' plan-w3-iface.md` → 0 hits（exit code 1）。

Round 2 标的 3 处全部消除：
- lifecycle.ts `runner: import("./models/ports.js").AgentRunner` → line 228 `import type { ..., AgentRunner, ... } from "./models/ports.js"` ✓
- tool-workflow.ts `registry: import("...workflow-script-registry.js").WorkflowScriptRegistry` → line 606 顶部 `import type { WorkflowScriptRegistry } from "../engine/models/workflow-script-registry.js"` ✓
- tool-workflow-script.ts 同上 → line 685 顶部 import ✓

### A.8 D.9（domain-models.md §1 WorkflowRun.meta 同步）— ✓ FIXED

grep 验证 domain-models.md：

```
22: └── meta: { startedAt, completedAt?, pausedAt?, workerErrorCount?, scriptErrorCount? }
42:   meta: { startedAt: string; completedAt?: string; pausedAt?: string; workerErrorCount?: number; scriptErrorCount?: number };
```

模型关系图（line 22）+ WorkflowRun class 定义（line 42）两处都同步加了 `workerErrorCount?/scriptErrorCount?`。与 plan-w1-engine.md Task 8 WorkflowRun.meta 定义 + plan-w3-iface.md Task 18 lifecycle/error-recovery 使用一致。spec 漂移消除 ✓。

### A.9 B.6（Task 21 session_tree/session_shutdown 注释占位）— ✓ FIXED

`plan-w3-iface.md` Task 21 index.ts（line 823-836）：

```ts
// session_tree：切分支前强制 pause 所有 running run（隐式契约保留）
pi.on("session_tree", async (_event, ctx) => {
  for (const run of runs.values()) {
    if (run.state.status === "running") {
      try { await pauseRun(run.runId, deps); } catch { /* already terminal */ void undefined; }
    }
  }
});

// session_shutdown：pause 所有 running run + 清理 temp files（隐式契约保留）
pi.on("session_shutdown", async () => {
  const running = Array.from(runs.values()).filter((r) => r.state.status === "running");
  await Promise.allSettled(running.map((r) => pauseRun(run.runId, deps)));
  // temp file cleanup（从旧 orchestrator.cleanupAllTempFiles 迁移）
});
```

两个 handler 都有骨架代码（`pi.on(...)` 注册 + 遍历 runs + pauseRun 调用 + Promise.allSettled）。session_shutdown 的 temp file cleanup 仍是注释，但属「迁移指针」（明确指向旧 orchestrator.cleanupAllTempFiles），按任务约束「非核心可留迁移指针」可接受。spec §隐式契约保留清单的两个契约（session_tree 强制 paused + session_shutdown pause-all）均有实现路径 ✓。

### A.10 D.11（runWorkflow spec 构造占位）— ✓ FIXED

`plan-w3-iface.md` Task 19 tool-workflow.ts run action（line 651-659）：

```ts
// D.11 修复：spec 由 script.toExecutable() + args + scriptName + scriptPath 构造
const runId = await runWorkflow(
  { scriptSource: script.toExecutable(), args: args.args ?? {}, scriptName: args.name!, scriptPath: script.path, budgetTokens: undefined, budgetTimeMs: undefined },
  deps,
);
```

spec 对象完整构造，含 RunSpec 必填字段（scriptSource / args / scriptName / scriptPath）+ 可选字段（budgetTokens / budgetTimeMs 显式 undefined）。与 RunSpec interface（plan-w1-engine.md Task 6）签名一致 ✓。

**注**：`budgetTokens: undefined, budgetTimeMs: undefined` 显式传 undefined 略冗余（RunSpec 这两个字段是 optional，省略即可），但非错误，属代码品味问题，不标。

### A.11 D.10 额外修复（动态 import 改静态）— ✓ FIXED

Round 2 D.10 标为 LOW：error-recovery.ts 用 `await import("../infra/concurrency-gate.js")`。

grep 验证：`grep -n 'await import\|import(' plan-w3-iface.md` → 0 hits。已改静态 `import { ConcurrencyGate } from "../infra/concurrency-gate.js"`（line 355）。主 agent 主动修复了 Round 2 的 LOW 项 ✓。

---

## Part B: 类型一致性核查（4 组签名，无新矛盾）

### B.1 rebuildRuntime 参数 vs handleWorkerError/handleScriptError 调用 — ✓ 一致

- rebuildRuntime 签名（line 365）：`(run: WorkflowRun, deps: LifecycleDeps, handlers: WorkerHandlers)` — 3 参数
- handleWorkerError 调用（line 391）：`rebuildRuntime(run, deps, handlers)` — 3 参数 ✓
- handleScriptError 调用（line 413）：`rebuildRuntime(run, deps, handlers)` — 3 参数 ✓

### B.2 makeHandlers 返回 WorkerHandlers vs error-recovery 接收 — ✓ 一致

- ports.ts WorkerHandlers（Task 1）：`{ onMessage(raw), onError(err), onExit(code, handle) }`
- lifecycle.makeHandlers 返回（line 286-300）：`{ onMessage: async (raw) => {...}, onError: async (err) => {...}, onExit: async (code, handle) => {...} }` ✓
- error-recovery handleWorkerError/handleScriptError/handleWorkerExit 接收 `handlers: WorkerHandlers` ✓
- rebuildRuntime 接收 `handlers: WorkerHandlers` ✓
- rebuildRuntime 内部 `deps.workerHost.start(run.spec, run.spec.args, handlers)` — 第 3 参数传 handlers（WorkerHandlers 类型），与 ports.ts WorkerHost.start 签名 `start(spec, args, handlers: WorkerHandlers)` 一致 ✓

### B.3 retryNode 用 run.runtime.controller.signal vs executeAgentCall 第 4 参数 — ✓ 一致

- retryNode（line 332）：`executeAgentCall(call, deps.runner, run.state.budget, runtime.controller.signal, run.state.trace)` — 5 参数
- executeAgentCall 签名（Task 17 line 20）：`(call: AgentCall, runner: AgentRunner, budget: Budget, signal: AbortSignal, trace: Trace)` — 5 参数 ✓
- `runtime.controller.signal` 类型 `AbortSignal`（AbortController.signal 标准 API）✓
- `run.state.budget` 类型 `Budget`（RunState.budget）✓
- `run.state.trace` 类型 `Trace`（RunState.trace）✓

### B.4 makeHandlers onError/onExit 递归传 handlers（lazy 引用）— ✓ 正确

lifecycle.makeHandlers（line 284-300）用闭包自引用模式：

```ts
function makeHandlers(run: WorkflowRun, deps: LifecycleDeps): WorkerHandlers {
  const handlers: WorkerHandlers = {
    onMessage: async (raw) => { await handleWorkerMessage(run, raw, deps); },
    onError: async (err) => {
      const retryCount = run.meta.workerErrorCount ?? 0;
      run.meta.workerErrorCount = retryCount + 1;
      await handleWorkerError(run, err, retryCount, deps, handlers); // 闭包引用 handlers
    },
    onExit: async (code, handle) => {
      if (!handle.isCurrent) return;
      const retryCount = run.meta.workerErrorCount ?? 0;
      run.meta.workerErrorCount = retryCount + 1;
      await handleWorkerExit(run, code, retryCount, deps, handlers); // 闭包引用 handlers
    },
  };
  return handlers;
}
```

**正确性分析**：
- `handlers` 是 `const` 声明，对象字面量赋值后引用不变
- onError/onExit 是 async 函数，内部引用 `handlers` 是闭包变量
- 闭包在 onError/onExit **被调用时**才求值 `handlers`，此时 `handlers` 已完成赋值并 return
- JS 闭包语义保证：即使对象字面量内部的属性引用 `handlers`，只要在 `return handlers` 之后调用，`handlers` 必然已绑定

**handlers 传递链**：makeHandlers 生成 handlers → workerHost.start(spec, args, handlers) → worker 绑定回调 → worker error/exit 触发 → makeHandlers.onError/onExit 调 handleWorkerError/handleWorkerExit(run, ..., handlers) → rebuildRuntime(run, deps, handlers) → workerHost.start(spec, args, handlers)（新 worker 绑定同一 handlers 对象）

这条链路使重建后的新 worker 复用同一组 handlers（含同样的 retryCount 累加 + rebuildRuntime 触发），避免 handlers 在 worker 重建后失效。设计正确 ✓。

---

## Part C: 新引入的占位符 / 矛盾 / 类型不一致

### C.1 【MUST FIX M1】handleScriptError 签名 vs handleWorkerMessage 调用不一致（N2 补码对称性遗漏）

`plan-w3-iface.md` Task 18：

**handleScriptError 签名**（line 396-402）：
```ts
export async function handleScriptError(
  run: WorkflowRun,
  errorMsg: string,
  deps: LifecycleDeps,
  handlers: WorkerHandlers, // N2: handlers 参数
): Promise<void>
```
4 个参数。

**handleWorkerMessage 调用点**（line 442）：
```ts
await handleScriptError(run, String(msg.message ?? ""), deps);
```
3 个参数（缺 handlers）。

**TS 报错**：TS2554 Expected 4 arguments, but got 3。

**根因**：N2 修复给 handleScriptError 加了第 4 个必填参数 `handlers`（为了调 rebuildRuntime），但调用点 handleWorkerMessage 没同步更新。这是与 Round 2 N1 同类的「补码对称性遗漏」——N1 是 handleWorkerError 的 `/* handlers */` 占位（修了），N2 又在 handleScriptError 的调用点犯了同样的错。

**更深层问题**：handleWorkerMessage 自身签名（line 430-434）也只有 3 参数（无 handlers）：
```ts
export async function handleWorkerMessage(
  run: WorkflowRun,
  raw: unknown,
  deps: LifecycleDeps,
): Promise<void>
```
所以即使 handleWorkerMessage 想向 handleScriptError 传 handlers，自己也拿不到。makeHandlers.onMessage 调用（line 289-290）也没传 handlers：
```ts
onMessage: async (raw: unknown) => {
  await handleWorkerMessage(run, raw, deps);
},
```

**修复链**（3 处联动）：
1. `handleWorkerMessage` 签名加 `handlers: WorkerHandlers` 第 4 参数
2. `makeHandlers.onMessage` 调用传 handlers：`handleWorkerMessage(run, raw, deps, handlers)`
3. `handleWorkerMessage` 内部调 `handleScriptError` 传 handlers：`handleScriptError(run, errorMsg, deps, handlers)`

**严重程度**：must_fix（typecheck TS2554 阻断，AC-6 无法满足）。修复成本极低（3 处加一个参数），但必须修。

### C.2 【MUST FIX M2】Task 23 三态清单漏 3 个孤儿测试文件（N3 修复覆盖不全）

见 Part A.3。Task 23 Step 3 四态清单覆盖 19/22，漏：

| 文件 | 路径 | import 的已删源 |
|------|------|----------------|
| orchestrator-budget.test.ts | `engine/__tests__/` | `../orchestrator-budget.js` + `../../domain/state.js` |
| terminate-instance.test.ts | `engine/__tests__/` | `../terminate-instance.js` + `../../domain/run-resources.js` + `../../domain/state.js` |
| workflow-files.test.ts | `infra/__tests__/` | `../workflow-files.js` + `../config-loader.js` |

这 3 个文件 100% 是孤儿（所有 import 的源都在 Task 23 Step 2 删除清单内）。Task 23 Step 4 声称「Task 24 完成后 typecheck 全绿」无法兑现——Task 24 Step 1-3 只重写 index.test.ts + 补集成测试 + 补不变式覆盖，不处理这 3 个。

**修复**（二选一）：
- **方案 A（推荐）**：Task 23 Step 3 删除清单补这 3 个：
  ```bash
  rm extensions/workflow/src/engine/__tests__/orchestrator-budget.test.ts  # engine/orchestrator-budget 删，budget 测试在 budget.test（Task 2）
  rm extensions/workflow/src/engine/__tests__/terminate-instance.test.ts   # engine/terminate-instance 删，A4 原子性在 lifecycle.test（Task 18）
  rm extensions/workflow/src/infra/__tests__/workflow-files.test.ts        # infra/workflow-files 删，被 registry-impl.test 替代（Task 14）
  ```
  并把 Task 23 Step 4 的「预期有 2 个测试文件报错」改为「预期有 2 个测试文件报错（index/workflows-view，在 Task 24 重写）」——这个数字不变，因为补的 3 个是直接删除（不会报错）。
- **方案 B**：Task 24 Step 1 扩展为「重写 index.test.ts + 删除 3 个孤儿测试」，但这会把清理工作混进测试重写 task，职责不清。

推荐方案 A（在 Task 23 一次性清理，与 N3 修复意图一致）。

### C.3 【SHOULD FIX S1】handleWorkerMessage 的 agent_call 分支是注释占位（Round 1 B.1 延留）

`plan-w3-iface.md` Task 18 handleWorkerMessage（line 436-438）：

```ts
if (msg.type === "agent_call") {
  // 路由到 executeAgentCall（callId/opts 从 msg 取）
} else if (msg.type === "return") {
```

`agent_call` 分支是注释占位，无实际路由代码。`return` 和 `error` 分支有代码。

**性质评估**：worker 执行模型的核心 dispatch 入口——worker 跑用户脚本时，脚本调 `agent()` 会发 `agent_call` 消息，主线程 handleWorkerMessage 必须路由到 executeAgentCall（从 msg 取 callId/opts → 构造 AgentCall → 调 executeAgentCall）。这是 worker 能正常跑 agent 调用的关键路径，注释占位意味着 agent 调用永远不执行。

按任务约束「核心控制流（retry/dispatch/timeout/状态转换）有代码即可，非核心可留迁移指针」——`agent_call` 路由属于 dispatch 核心控制流。但 Round 1 B.1 已经验证过 makeHandlers.onMessage 有实际路由代码（onMessage → handleWorkerMessage 调用链有代码），Round 2 A.8 也标 ✓。本轮未新引入此问题，属 Round 1 B.1 延留（Round 1/2 审查关注的是 onMessage handler 本身的路由代码，未深入 handleWorkerMessage 内部分支）。

**严重程度**：should_fix（非本轮新引入，但存在）。建议补完 agent_call 分支代码：
```ts
if (msg.type === "agent_call") {
  const { callId, opts } = msg as { callId: number; opts: AgentCallOpts };
  const call = new AgentCall({ id: callId, opts, traceNode: { id: callId, status: "running" } as ExecutionTraceNode });
  run.state.calls.set(callId, call);
  const runtime = run.runtime;
  if (!runtime) throw new Error("runtime not available");
  await executeAgentCall(call, deps.runner, run.state.budget, runtime.controller.signal, run.state.trace);
}
```

### C.4 新引入占位符扫描 — ✓ 无新问题

本轮补码（rebuildRuntime 提取 + retryNode 方案 A + handlers 传递 + D.7/D.9/D.10/D.11 修复）未引入新占位符 / 新 inline import / 新 `as never` / 新 `await import` / 新签名不一致（除 M1）。

grep 验证：
- `grep -n 'import("' plan-w3-iface.md` → 0 hits（D.7 修复彻底）
- `grep -n 'as never' plan-w3-iface.md` → 仅 1 hit 注释说明（D.4 修复彻底）
- `grep -n 'await import' plan-w3-iface.md` → 0 hits（D.10 修复彻底）
- `grep -n 'TBD\|TODO\|FIXME' plan-w3-iface.md` → 0 hits

---

## Part D: 整体评价

### 修复成效

Round 2 的 3 项 must_fix + 8 项 should_fix 中：
- **N1**：✓ 完美修复（rebuildRuntime 提取方案优于 Round 2 建议，error-recovery 内部复用更内聚）
- **N2**：⚠ 语义修复（handleScriptError 内部 rebuildRuntime 实际调用），但补码时给函数加 handlers 参数忘了更新调用点 → M1
- **N3**：⚠ 部分修复（typecheck gate 时机说明正确，但三态清单覆盖不全 19/22）→ M2
- **D.4/D.5/D.6/D.7**：✓ 全部正确修复（D.5 方案 A 选择合理 + D.6 联动删除 + D.7 清零 + D.4 去逃逸）
- **D.9**：✓ 两处同步（模型关系图 + class 定义）
- **B.6**：✓ 两个 handler 骨架完整（session_shutdown temp cleanup 留迁移指针可接受）
- **D.11**：✓ spec 构造完整
- **D.10**（Round 2 LOW）：✓ 额外主动修复

**10 项修复中 8 项完美 + 2 项有连带遗漏**（N2→M1, N3→M2）。

### 本轮新问题

| # | 问题 | 性质 | 与 Round 2 关系 |
|---|------|------|----------------|
| M1 | handleScriptError 调用点漏 handlers 参数 | 补码对称性遗漏（TS2554） | N2 修复的连带遗漏，与 N1 同类 |
| M2 | Task 23 三态清单漏 3 个孤儿测试 | N3 覆盖不全（19/22） | Round 2 N3 清表本身漏了这 3 个，主 agent 按表修自然延续 |
| S1 | handleWorkerMessage agent_call 分支注释占位 | 非核心 dispatch 细节占位 | Round 1 B.1 延留，非本轮新引入 |

**M1 和 M2 都是「上一轮审查遗漏的对称延续」**：
- M1 是 N1 的对称点（N1 修了 handleWorkerError 的 handlers 占位，M1 漏了 handleScriptError 的调用点）
- M2 是 N3 的覆盖延续（N3 列了 12 个孤儿，M2 补发现还有 3 个）

这反映出一个模式：**补码时只关注当前 task 的直接修改点，未扫描同模块的对称调用点 / 同类文件清单**。建议主 agent 修复时执行对称性自查（改函数签名 → grep 所有调用点；列删除清单 → find 同目录所有测试文件对照）。

### 可进入 Phase 3 的前置条件

1. 修 M1（handleScriptError 调用链 3 处加 handlers 参数）
2. 修 M2（Task 23 Step 3 补 3 个孤儿测试到删除清单）
3. 建议（非阻断）修 S1（handleWorkerMessage agent_call 分支补代码）

### 结论

Round 2 的骨架修补质量高（10 项修复 8 项完美），但 N2 补码时再次犯了对称性遗漏（M1），N3 清表覆盖不全（M2）。两项都是低成本修复（M1 加 3 处参数，M2 加 3 行 rm），但必须修完才能进 Phase 3。**NOT CONVERGED，需 Round 4 修补 M1 + M2 后再进 Phase 3**。

建议主 agent 修复时执行对称性自查：
- 修 M1 时：`grep -n 'handleScriptError\|handleWorkerMessage' plan-w3-iface.md` 确认所有调用点都传 handlers
- 修 M2 时：`find extensions/workflow/src -name "*.test.ts" | sort` 逐文件对照三态清单，确认 22/22 覆盖
