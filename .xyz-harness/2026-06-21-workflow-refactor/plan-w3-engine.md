# Wave 3: Engine Free Functions — T17-T22

原 Application 层 5 个 Service 降为 Engine free functions（D-12）。依赖 W1（模型）+ W2（infra + workflow-run）。

**拆细关键**：`LifecycleDeps`/`WorkerHandlers` 已在 T2 ports.ts 定义，打破 lifecycle ↔ error-recovery ↔ node-ops 的循环依赖。6 个文件各自独立成 task，依赖清晰的串行/并行链。

**Wave 完成检查：**
```bash
ls extensions/workflow/src/engine/{script-lint,execute-agent-call,error-recovery,node-ops,lifecycle,launcher}.ts
pnpm --filter @zhushanwen/pi-workflow typecheck
pnpm --filter @zhushanwen/pi-workflow test
grep -rnE "from ['\"]@mariozechner" extensions/workflow/src/engine/   # 应无输出
# AC-2: 新代码无旧抽象
grep -rn "OrchestratorCore\|terminateDeps\|errorHandlerContext\|agentCallContext\|budgetCallbacks" extensions/workflow/src/engine/
# 预期：无输出（只在待删除旧代码中残留）
```

---

### T17 — engine/script-lint.ts（从 infra 迁入）

- **依赖:** T6（LintResult 类型 + WorkflowScript.validate 回填）
- **动作:** create `engine/script-lint.ts` + `engine/__tests__/script-lint.test.ts`；modify `engine/models/workflow-script.ts`（回填 validate）
- **参考源:** 旧 `infra/script-lint.ts`（207 行，检查 agent()/parallel()/pipeline() 语法、$ARGS 使用等）
- **关键改动:**
  - 路径 `infra/` → `engine/`
  - 导出 `lintScript(sourceCode): LintResult`
  - 回填 `WorkflowScript.validate()` → `return lintScript(this.sourceCode)`（T6 占位的基检查替换掉）
- **验收:** `test -- script-lint` PASS + WorkflowScript.validate 回填后 workflow-script.test 仍 PASS
- **风险:** 低

---

### T18 — engine/execute-agent-call.ts

- **依赖:** T2（AgentRunner port）, T3（Budget）, T4（Trace）, T5（AgentCall）
- **动作:** create `engine/execute-agent-call.ts` + `engine/__tests__/execute-agent-call.test.ts`
- **参考源:** 旧 `engine/agent-call-handler.ts`（198 行，executeWithRetry 函数 :70）
- **关键改动（D-12 + D.4）:**
  - 从 AgentCall.execute() 上帝方法提取为 free function
  - **参数重组**：AgentCallContext（依赖注入 bag）→ 显式 5 参数 `(call, runner, budget, signal, trace)`
  - 预算超限不重试（直接 markDone）；stale-context 不重试（直接失败）
  - 3 次重试 + 指数退避（BACKOFF_MS=[1000,2000,4000]）
  - STALE_CONTEXT_PATTERNS 从 agent-call-handler.ts:~130 迁移
  - 成功: consume usage（D.4 去掉 as never，构造合法 AgentUsage）+ incrementCallCount + markDone + trace.update(completed)
  - **D.4 修复**: `budget.consume({input: u.input+u.cacheWrite, output: u.output, cacheRead: u.cacheRead, cacheWrite: 0, cost: u.cost, contextTokens: u.contextTokens, turns: u.turns})`（去掉 as never 类型逃逸）
- **验收:** `test -- execute-agent-call` PASS（成功路径 + stale 不重试 + 预算超限不重试 + 3 次退避；参考旧 `__tests__/orchestrator-stale.test.ts`）
- **风险:** 中（重试 + 预算 + stale 矩阵）

---

### T19 — engine/error-recovery.ts

- **依赖:** T2（LifecycleDeps/WorkerHandlers）, T8（ConcurrencyGate 重建）, T16（WorkflowRun）, T18（executeAgentCall）
- **动作:** create `engine/error-recovery.ts` + `engine/__tests__/error-recovery.test.ts`
- **参考源:** 旧 `engine/error-handlers.ts`（191 行）+ 旧 `engine/worker-manager.ts` 的 handleWorkerMessage + domain-models.md §失败处理矩阵
- **关键改动:**
  - 导出 4 个函数: `handleWorkerMessage(run, raw, deps, handlers)`、`handleWorkerError(run, err, retryCount, deps, handlers)`、`handleWorkerExit(run, code, retryCount, deps, handlers)`、`handleScriptError(run, msg, deps, handlers)`
  - 私有 helper `rebuildRuntime(run, deps, handlers)` — 重建 worker+gate+controller，调 `run.replaceRuntime()`（G5-001）。**N1+N2 修复**：实际重建（非注释），handlers 由调用方传入
  - `handleWorkerMessage` 路由: agent_call → executeAgentCall；return → transition done,completed；error → handleScriptError（**M1: 传 handlers**）
  - `handleWorkerError`: retryCount>=MAX(3) → transition done,failed；否则退避 + rebuildRuntime
  - `handleScriptError`: scriptErrorCount++（存 run.meta），>MAX → failed；否则退避 + rebuildRuntime（**N2: 补全重建块**）
  - `handleWorkerExit`: code===0 正常；否则委托 handleWorkerError（竞态防护已在 T9 WorkerHandle.isCurrent + T21 makeHandlers.onExit 完成）
  - `run.meta.workerErrorCount/scriptErrorCount`（C.5）作重试计数载体
- **验收:** `test -- error-recovery` PASS（3 次重试矩阵 + rebuildRuntime + 消息路由）
- **风险:** 高（失败处理矩阵 + worker 重建 + handlers 传递防循环）

---

### T20 — engine/node-ops.ts

- **依赖:** T2（LifecycleDeps）, T16（WorkflowRun）, T18（executeAgentCall）
- **动作:** create `engine/node-ops.ts` + `engine/__tests__/node-ops.test.ts`
- **参考源:** 旧 `orchestrator.ts` 的 retryNode/skipNode
- **关键改动（D.5 修复 - 方案 A）:**
  - `retryNode(runId, callId, deps)` — **不 replaceRuntime 启新 worker**，只重置 call（status=pending, attempts=0）+ 调 executeAgentCall
  - **原因**：retryNode 语义是「重试单个失败 call」，worker 仍在运行，直接主线程重跑该 call。replaceRuntime+启新 worker 是 worker-error-retry（T19）的语义，两者混淆是 D.5 bug
  - **G6-001**: 前置 status==="running"，否则抛错
  - `skipNode(runId, callId, deps)` — call.status="done"（标记跳过）
  - **D.6 修复**: 删除 makeHandlersForRetry no-op stub
- **验收:** `test -- node-ops` PASS（retryNode 前置 running + 重置 call + skipNode）
- **风险:** 中（D.5 语义纠偏）

---

### T21 — engine/lifecycle.ts（旧 lifecycle→legacy 重命名）

- **依赖:** T2（LifecycleDeps/WorkerHandlers）, T8（ConcurrencyGate）, T12（WorkerHostImpl via port）, T16（WorkflowRun）, T19（handleWorker* 函数）
- **动作:** **先重命名旧 `engine/lifecycle.ts` → `engine/lifecycle.legacy.ts`**（旧 index.ts 此时仍走 orchestrator.ts，不直接引用 lifecycle.ts，重命名不破坏旧链路）；再 create 新 `engine/lifecycle.ts` + `engine/__tests__/lifecycle.test.ts`
- **参考源:** 旧 `engine/lifecycle.ts`（477 行，runWorkflow/pauseRun/resumeRun/abortRun）+ 旧 `orchestrator.ts` 相关方法
- **关键改动:**
  - 改为 free function（非 Service 方法）
  - 参数从 OrchestratorCore 改为 `(run/ runId, deps: LifecycleDeps)`
  - `runWorkflow(spec, deps, signal?)` — 创建 WorkflowRun + Runtime(worker+gate+controller) + assignRuntime + transition running + store.save
  - `pauseRun(runId, deps)` — **A4 原子性**: transition 内部 releaseRuntime（cleanup before mutate），失败时 status 不变；G3-001 整个 RunRuntime 丢弃
  - `resumeRun(runId, deps)` — G3-001: assignRuntime 重建 worker/gate/controller + transition running；worker 重跑脚本，已完成调用从 RunState.calls replay
  - `abortRun(runId, deps, reason?)` — done 状态 no-op；A4 cleanup before mutate
  - 私有 `makeHandlers(run, deps): WorkerHandlers` — 路由 onMessage/onError/onExit 到 T19 handle* 函数；onExit 检查 `handle.isCurrent`（G-025）；递增 `run.meta.workerErrorCount`
  - maxConcurrency=4（D-13）
- **验收:** `test -- lifecycle` PASS（run 创建 + pause/resume 跨 runtime + abort A4 原子性 + 非法转换抛错）
- **风险:** **高**（A4 原子性 + 跨 session 状态恢复 + handlers 闭包防循环）；先重命名 legacy 避免编译冲突
- **注意:** 完成后旧 `lifecycle.legacy.ts` 仍存在（被旧 orchestrator.ts 间接引用链保留），W5 T29 删除

---

### T22 — engine/launcher.ts

- **依赖:** T14（registry）, T21（runWorkflow/abortRun）, T2（LifecycleDeps）
- **动作:** create `engine/launcher.ts` + `engine/__tests__/launcher.test.ts`
- **参考源:** 旧 `engine/lifecycle.ts` 的 runWorkflowAndWait（:442）
- **关键改动（AC-4 + C.7）:**
  - `runAndWait(name, args, deps & {registry}, signal?, timeoutMs?=15min): Promise<WorkflowRunResult>`
  - `WorkflowRunResult = { status:"done"; reason: DoneReason; scriptResult?; error?; runId }`（**D-8 新签名**）
  - 流程: registry.get → validate → toExecutable → runWorkflow → 轮询至 done
  - **C.7 修复**: timeout → transition done,time_limited（补全 time_limited 转换）
  - signal.aborted → abortRun + reason=aborted
  - `toResult(run)`: reason=run.state.reason ?? "failed"
- **验收:** `test -- launcher` PASS（正常完成 + timeout→time_limited + abort→aborted + not found→failed）
- **风险:** 中（轮询 + timeout/abort 竞态）
