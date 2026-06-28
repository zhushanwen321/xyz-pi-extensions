# Wave 1: 纯模型层 — T1-T7

Engine 层模型作为「数据结构 + 不变式守卫」存在（D-12）。**零 infra 依赖**——T1-T7 不 import 任何 infra 文件，可独立编译测试。

设计基础：[domain-models.md](./domain-models.md) §1-§8（§12 ApprovalPolicy 已删除）。

**Wave 完成检查：**
```bash
ls extensions/workflow/src/engine/models/{types,ports,budget,trace,agent-call,workflow-script,workflow-script-registry,run-spec,run-state}.ts
pnpm --filter @zhushanwen/pi-workflow typecheck   # ports.ts 的 forward ref 此时注释掉
pnpm --filter @zhushanwen/pi-workflow test
grep -rnE "from ['\"]@mariozechner" extensions/workflow/src/engine/models/   # 应无输出
```

---

### T1 — engine/models/types.ts

- **依赖:** 无（全局基础）
- **动作:** create `engine/models/types.ts` + `engine/models/__tests__/types.test.ts`
- **参考源:** 旧 `domain/state.ts`（迁移 AgentResult/AgentUsage/ExecutionTraceNode/ToolCallEntry）+ 旧 `infra/agent-pool.ts`（迁移 AgentCallOpts）+ 旧 `engine/error-handlers.ts`（迁移 WorkerLogEntry）
- **关键改动:**
  - 新状态机：`RunStatus = "running" | "paused" | "done"` + `DoneReason = "completed" | "failed" | "aborted" | "budget_limited" | "time_limited"`（替换旧 8 态 WorkflowStatus）
  - 删除 `WorkflowStatus` / `WorkflowInstance` / `WorkflowBudget`（被新模型替代）
  - 新增 `TracePatch`（update 用，字段全可选：status/result/error/completedAt/sessionId）
  - 删除 `ExecutionTraceNode.verifyStrategy`（G-020 死字段）
  - `AgentCallOpts` 字段不变（prompt/schema/model/scene/timeoutMs/skill/skillPath/description/agent/systemPromptFiles/schemaEnv）
- **验收:** `pnpm --filter @zhushanwen/pi-workflow test -- types` PASS + typecheck 0 errors
- **风险:** 低

---

### T2 — engine/models/ports.ts（3 port + 编排层共享类型）

- **依赖:** T1
- **动作:** create `engine/models/ports.ts`
- **参考源:** domain-models.md §Ports（3 个 port）
- **关键改动:**
  - **3 个 port**: `AgentRunner`（run(opts, signal)→Promise<AgentResult>）、`RunStore`（save(run)/loadAll()）、`WorkerHost`（start(spec, args, handlers)→WorkerHandle）
  - **新增编排层共享类型**（W3 拆细的关键，打破 lifecycle/error-recovery/node-ops 循环依赖）：
    ```ts
    export interface WorkerHandlers {
      onMessage(raw: unknown): Promise<void>;
      onError(err: Error): Promise<void>;
      onExit(code: number, handle: WorkerHandle): Promise<void>;
    }
    export interface LifecycleDeps {
      store: RunStore;
      workerHost: WorkerHost;
      runner: AgentRunner;
      runs: Map<string, WorkflowRun>;
    }
    ```
  - **forward ref**（type-only，编译期抹除；W2/W3 完成后自动生效，无需注释）：`RunSpec`(T7)、`WorkflowRun`(T16)、`WorkerHandle`(T9 infra)。T2 完成时这些类型不存在，**typecheck 会报错——在 T2 卡片标注「forward ref 报错是预期，W2 T16 完成后恢复，或暂时注释 forward ref import」**
- **验收:** 文件存在；types.test 覆盖 port interface 形状（用 mock 对象赋值校验）
- **风险:** 低（注意 forward ref 处理）

---

### T3 — engine/models/budget.ts

- **依赖:** T1
- **动作:** create `engine/models/budget.ts` + `__tests__/budget.test.ts`
- **参考源:** 旧 `engine/orchestrator-budget.ts`（checkBudget）+ 旧 `infra/agent-pool.ts`（totalCallCount/soft limit 计数）
- **关键改动（D-12）:**
  - **删除** `onConsume` 回调 + `softWarningSent` 字段 + `setBudget()` + `maybeEmitSoftWarning()`（值对象不应持可变回调）
  - `consume(usage)`: 累加 usedTokens（input+output）/ usedCost
  - `incrementCallCount()`: totalCallCount++
  - `isExceeded()`: maxTokens>0 && usedTokens>maxTokens，或 maxCost/ maxTimeMs 超限；**maxTokens===0 视为不限制（守卫）**
  - `isSoftLimitReached()`: totalCallCount > 500
- **验收:** `test -- budget` PASS（覆盖 maxTokens===0 守卫、超限、soft limit、无回调断言）
- **风险:** 低

---

### T4 — engine/models/trace.ts

- **依赖:** T1
- **动作:** create `engine/models/trace.ts` + `__tests__/trace.test.ts`
- **参考源:** 旧 `engine/trace-commit.ts`（commitTraceNode）+ 旧 `infra/execution-trace.ts`（appendTraceNode）
- **关键改动:**
  - `append(node)`: append-only，nodes 只增不改索引顺序（D-10 单源）
  - `update(callId, patch)`: 按 TracePatch 改单个 node 字段；callId 不存在时 no-op
  - `toArray()`: readonly 返回
  - 无 `verifyStrategy` 字段（G-020）
- **验收:** `test -- trace` PASS（append-only + update + 不存在 callId no-op）
- **风险:** 低

---

### T5 — engine/models/agent-call.ts

- **依赖:** T1
- **动作:** create `engine/models/agent-call.ts` + `__tests__/agent-call.test.ts`
- **参考源:** 旧 `engine/agent-call-handler.ts`（数据部分）+ domain-models.md §5
- **关键改动（D-12）:**
  - **纯数据 + 不变式，无 execute/executeWithRetry 上帝方法**（执行编排移到 T18 execute-agent-call.ts）
  - 字段: id, opts, status("pending"|"running"|"done"), attempts, result?, sessionId?, traceNode
  - 方法: `markRunning()`(status=running, attempts++)、`markDone(result)`、`setSessionId(id)`
- **验收:** `test -- agent-call` PASS（含断言 `call.execute === undefined`）
- **风险:** 低

---

### T6 — engine/models/workflow-script.ts + workflow-script-registry.ts

- **依赖:** T1
- **动作:** create `engine/models/workflow-script.ts` + `workflow-script-registry.ts` + `__tests__/workflow-script.test.ts`
- **参考源:** 旧 `infra/script-lint.ts`（validate 基础检查）+ 旧 `engine/worker-script.ts`（toExecutable strip export）+ 旧 `infra/workflow-files.ts`（save/delete 接口）+ domain-models.md §7/§8
- **关键改动:**
  - `WorkflowScript` 实体: 字段(name/source:"saved"|"tmp"/path/sourceCode/meta/available)
  - `validate(): LintResult` — **T17 前用基础检查**（含 agent()/parallel()/pipeline() 之一），T17 迁入 script-lint 后回填调用 `lintScript(this.sourceCode)`
  - `toExecutable(): string` — strip export + wrap（脚本格式不变 AC-4）
  - `WorkflowScriptRegistry` interface: loadAll()/get(name)/invalidate()
- **验收:** `test -- workflow-script` PASS（validate 基础 + toExecutable）
- **风险:** 低（注意 validate 的 T17 回填占位）

---

### T7 — engine/models/run-spec.ts + run-state.ts

- **依赖:** T3, T4, T5（RunState 引用 Budget/AgentCall Map/Trace）
- **动作:** create `engine/models/run-spec.ts` + `run-state.ts` + `__tests__/run-state.test.ts`
- **参考源:** domain-models.md §2/§3
- **关键改动:**
  - `RunSpec`（不可变）: scriptSource/args/budgetTokens?/budgetTimeMs?/scriptName/scriptPath/description?
  - `RunState`（可持久化）: status/reason?/budget/calls(Map<callId,AgentCall>)/trace/errorLogs/error?/scriptResult?
- **验收:** `test -- run-state` PASS（RunState 类型可构造 + 字段可读写）
- **风险:** 低
