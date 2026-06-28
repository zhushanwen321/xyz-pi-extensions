# Wave 2: Infra 实现 + 运行时模型 — T8-T16

技术资源实现 + 依赖 infra 的运行时模型（run-runtime / workflow-run）。依赖 W1 的 Engine ports（T2）。

**关键差异（vs 旧四层 plan，D-12）**：WorkerHandle / ConcurrencyGate 是 Infra **具体类**（非 implements interface）。Engine 直接 import 这些具体类。只有 AgentRunner / RunStore / WorkerHost 是 port（真需 mock）。

**Wave 完成检查：**
```bash
ls extensions/workflow/src/infra/{concurrency-gate,worker-handle,worker-host,subprocess-agent-runner,worker-script-builder,jsonl-run-store,workflow-script-registry-impl}.ts
ls extensions/workflow/src/engine/models/{run-runtime,workflow-run}.ts
pnpm --filter @zhushanwen/pi-workflow typecheck   # T2 ports.ts forward ref 全部生效
pnpm --filter @zhushanwen/pi-workflow test
```

---

### T8 — infra/concurrency-gate.ts（原 agent-pool）

- **依赖:** T1
- **动作:** create `infra/concurrency-gate.ts` + `infra/__tests__/concurrency-gate.test.ts`
- **参考源:** 旧 `infra/agent-pool.ts`（385 行，逐行迁移 enqueue/drain/runPrivate/abort 传播）
- **关键改动:**
  - 类名 `AgentPool` → `ConcurrencyGate`（**无 Impl 后缀**，D-12 直接具体类）
  - **maxConcurrency 保持 4**（D-13）
  - **删除** budget 相关：`setBudget()` / `maybeEmitSoftWarning()` / `budgetRef` / `totalCallCount`（soft limit 移到 T3 Budget，Engine executeAgentCall 调 `budget.incrementCallCount()`）
  - **保留** FIFO 队列、per-run 实例化、per-call AbortController 合并（外部 signal + timeoutMs）
  - `enqueue(opts, signal?)` / `activeCount` getter / `queueLength` getter
- **验收:** `test -- concurrency-gate` PASS（FIFO、maxConcurrency=4、abort 传播；删除 budget 测试）
- **风险:** 中（abort 合并逻辑复杂，逐行对照）

---

### T9 — infra/worker-handle.ts

- **依赖:** 无（node:worker_threads）
- **动作:** create `infra/worker-handle.ts` + `infra/__tests__/worker-handle.test.ts`
- **参考源:** 旧 `engine/worker-manager.ts:73`（bare Worker 字段）+ 旧 `engine/error-handlers.ts:83,92,93`（currentWorker !== exitedWorker 竞态守卫）+ domain-models.md §9
- **关键改动（D-12 + G-025）:**
  - **新增类**（现状无此类，裸 Worker 散落两处）。封装 `node:worker_threads.Worker`
  - `postMessage(msg)` / `async terminate()`（幂等，置 current=false）
  - `isCurrent` getter — terminate 后 false（竞态防护）
  - `onMessage/onError/onExit(handler)` — 内部检查 isCurrent，旧 handle 回调不触发
- **验收:** `test -- worker-handle` PASS（postMessage 透传、terminate 后 isCurrent=false、旧 handle 回调不触发）
- **风险:** 中（竞态测试需用真实 Worker 或精细 mock）

---

### T10 — infra/subprocess-agent-runner.ts（原 pi-runner）

- **依赖:** T1, T2（AgentRunner port）
- **动作:** create `infra/subprocess-agent-runner.ts` + `infra/__tests__/subprocess-agent-runner.test.ts`
- **参考源:** 旧 `infra/pi-runner.ts`（185 行，runPiProcess：spawn pi 子进程 + JSONL 通信 + 超时）
- **关键改动:**
  - 类名 `runPiProcess` → `SubprocessAgentRunner` implements `AgentRunner`
  - import 路径 `domain/types.js` → `engine/models/types.js`
  - `run(opts, signal): Promise<AgentResult>` — 每次 spawn 新进程（不复用，spec Constraints）
- **验收:** `test -- subprocess-agent-runner` PASS（spawn + 通信 + abort/timeout）
- **风险:** 中（child_process 测试需 mock 或真实 pi 进程）

---

### T11 — infra/worker-script-builder.ts（原 engine/worker-script）

- **依赖:** 无（源码字符串包装）
- **动作:** create `infra/worker-script-builder.ts` + `infra/__tests__/worker-script-builder.test.ts`
- **参考源:** 旧 `engine/worker-script.ts`（269 行）
- **关键改动:**
  - 路径 `engine/` → `infra/`
  - 保留 `buildWorkerScript(source)` 逻辑（strip export + wrap + 注入 agent()/parallel()/pipeline()/$ARGS/$BUDGET 全局）
  - **AC-4 要求**：脚本格式不变（用户资产）
- **验收:** `test -- worker-script-builder` PASS（生成的脚本能被 node:worker_threads eval 执行）
- **风险:** 低

---

### T12 — infra/worker-host.ts

- **依赖:** T2（WorkerHost/WorkerHandlers port）, T9（WorkerHandle）, T11（buildWorkerScript）, T7（RunSpec）
- **动作:** create `infra/worker-host.ts` + `infra/__tests__/worker-host.test.ts`
- **参考源:** 旧 `engine/worker-manager.ts` 的 startWorker 函数 + domain-models.md §Ports
- **关键改动:**
  - `WorkerHostImpl implements WorkerHost`
  - `start(spec, args, handlers): WorkerHandle` — 创建 Worker（eval:true，不用 bootstrap 文件，避免 C.2）+ 绑定 handle.onMessage/onError/onExit 到 handlers
  - `onExit` 传 handle 给 handlers.onExit（C.3 修复）
  - workerData: { scriptPath, args, workspace, meta }
  - temp file 清理逻辑移到 Engine lifecycle（T21），本处不管
- **验收:** `test -- worker-host` PASS（start 返回 WorkerHandle 且回调触发）
- **风险:** 中（真实 Worker 集成测试）

---

### T13 — infra/jsonl-run-store.ts（原 state-store）

- **依赖:** T2（RunStore port）, T16（WorkflowRun 类型）
- **动作:** create `infra/jsonl-run-store.ts` + `infra/__tests__/jsonl-run-store.test.ts`
- **参考源:** 旧 `infra/state-store.ts`（115 行，persistState 逻辑）
- **关键改动:**
  - `JsonlRunStore implements RunStore`
  - `save(run)`: 序列化 RunState 到 JSONL
  - `loadAll(): WorkflowRun[]` — **D-5: 旧格式返回空**（reconstruct 时检查格式版本，不向后兼容旧 session）
- **验收:** `test -- jsonl-run-store` PASS（save/loadAll 往返 + 旧格式返回空）
- **风险:** 中（D-5 兼容性测试）

---

### T14 — infra/workflow-script-registry-impl.ts + 5 保留文件改 import

- **依赖:** T6（WorkflowScriptRegistry interface）
- **动作:** create `infra/workflow-script-registry-impl.ts` + `infra/__tests__/workflow-script-registry-impl.test.ts`；modify 5 个保留文件改 import
- **参考源:** 旧 `infra/config-loader.ts`（321 行 loadAgentWorkflows + fuzzy 匹配）+ 旧 `infra/workflow-files.ts`（86 行）
- **关键改动:**
  - `WorkflowScriptRegistryImpl implements WorkflowScriptRegistry`
  - `loadAll()`: 优先级 tmp > project > user（保留）、去重（保留）、60s TTL 缓存（保留）、meta 提取（phases/description 保留）
  - `get(name)`: fuzzy 匹配（保留）
  - `invalidate()`: 清缓存
  - WorkflowScript 实例化用 T6 构造器
  - **5 个保留文件**（`jsonl-parser/agent-opts-resolver/agent-discovery/skill-discovery/constants.ts`）改 import：`from "../domain/state.js"` → `from "../engine/models/types.js"`，类型名不变
- **验收:** `test -- workflow-script-registry-impl` PASS + `typecheck` 0 errors（5 文件 import 改完）
- **风险:** 中（fuzzy 匹配 + 缓存逻辑需逐行对照）

---

### T15 — engine/models/run-runtime.ts

- **依赖:** T8（ConcurrencyGate）, T9（WorkerHandle）
- **动作:** create `engine/models/run-runtime.ts` + `engine/models/__tests__/run-runtime.test.ts`
- **参考源:** 旧 `domain/run-resources.ts`（54 行）+ domain-models.md §10
- **关键改动（D-12 + G3-001）:**
  - 持 `WorkerHandle` / `ConcurrencyGate` **具体类**（非 interface，D-12 允许 Engine import Infra 技术类型）
  - 字段: worker, gate, controller(AbortController)
  - `release(mode: "pause" | "terminal")` — 消除 terminateInstance 的 4 boolean flag；幂等（重复调用 no-op）
  - **G3-001**: pause 时整个 RunRuntime 被调用方丢弃（AbortController 一次性无法复用），resume 时 assignRuntime 重建
  - mode 参数语义实际等价（都全释放），保留枚举为可读性
- **验收:** `test -- run-runtime` PASS（release 幂等 + 终止 worker/controller）
- **风险:** 中（依赖 T8/T9 具体类，测试需 mock worker.terminate）

---

### T16 — engine/models/workflow-run.ts（聚合根）

- **依赖:** T7（RunSpec/RunState）, T15（RunRuntime）, T1, T3（Budget）, T4（Trace）
- **动作:** create `engine/models/workflow-run.ts` + `engine/models/__tests__/workflow-run.test.ts`
- **参考源:** 旧 `domain/state.ts`（transitionStatus 状态机）+ domain-models.md §1 + clarification.md G3-001/G5-001/G6-001
- **关键改动:**
  - **3 态状态机** + DoneReason（替换旧 8 态）
  - 合法转换: running→{paused,done}, paused→{running,done}, done→[]（僵尸）
  - 字段: runId, spec, state, runtime?, meta{startedAt,completedAt?,pausedAt?,workerErrorCount?,scriptErrorCount?}
  - **不变式（必须全测）**:
    - `status==="running" ⟺ runtime!==undefined`（transition to running 需先 assignRuntime）
    - `status==="done" ⟹ reason!==undefined`（transition to done 需传 reason）
  - 方法: `transition(target, reason?)`（非法抛错）、`assignRuntime(rt)`（已有则抛错）、`releaseRuntime()`（undefined 时 no-op）、`replaceRuntime(rt)`（**G6-001: 前置 status==="running"，否则抛错**；G5-001: 原子释放旧+绑定新，status 保持 running）
  - transition 副作用: →paused 时 releaseRuntime（G3-001 丢弃 runtime）、→done 时 releaseRuntime + 设 completedAt
  - `meta.workerErrorCount/scriptErrorCount`（C.5: 跨 runtime 存活，W3 T19 重试计数载体）
- **验收:** `test -- workflow-run` PASS（全部不变式 + 状态机合法/非法转换 + assign/release/replace + G3/G5/G6）
- **风险:** 高（聚合根是架构核心，不变式集中在此；用 stub RunRuntime 避免依赖真实 worker）
