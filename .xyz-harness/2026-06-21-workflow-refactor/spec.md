---
verdict: pass
---

# Workflow Extension 整体重构

## Background

`extensions/workflow` 现状：分层做了（Interface/Engine/Domain/Infra），但核心模型建模错误。核心问题：`RunResources` 把生命周期完全不同的 6 个字段打包成扁平 struct；状态机 8 态混入"终止原因"；5 个重叠 dependency interface 各自重发明；`WorkflowScript` / `WorkerHandle` 等模型散落在 infra 文件没有被建模；`AgentPool` 名实不符（是并发闸门，不是进程池）。

本次重构目标：**建立长期合理的三层架构（Interface / Engine / Infra）+ 核心模型**，提升可维护性和可扩展性。workflow 本质是技术编排引擎而非业务系统——没有真正的领域规则，只有执行机制（预算/重试/线程/信号量/日志）。因此不套 DDD 四层，承认 Engine 层是核心，模型作为「数据结构 + 不变式守卫」存在于 Engine 层。不是功能扩展，是架构重建。详见 D-12。

## Functional Requirements

### FR-1: 核心模型重建

详见 [domain-models.md](./domain-models.md)。模型作为数据结构 + 不变式守卫存在于 Engine 层（非独立 Domain 层）：

| 模型 | 类型 | 替换的现状 |
|------|------|-----------|
| WorkflowRun | 聚合根 | RunResources 扁平 struct + orchestrator.ts God Facade |
| AgentCall | 数据 + 不变式 | agent-call-handler.ts 过程式代码（删除 execute 上帝方法） |
| Budget | 值对象（计数器） | state.budget 字段 + 散落检查（删除 softWarningSent + setBudget + maybeEmitSoftWarning 副作用链） |
| Trace | 事件流 | instance.trace 数组 |
| WorkflowScript | 实体 | 5 个 infra 文件散落逻辑 |
| WorkflowScriptRegistry | 仓库 | config-loader.ts 过程式模块 |
| WorkerHandle | 技术资源封装 | 裸 Worker + 散落操作（Infra 具体类，不造 interface） |
| RunRuntime | 聚合内资源 | RunResources 的部分字段（Engine 层，持具体类） |

> 表格列出 8 个核心模型（ApprovalPolicy 删除——降为 Interface 层 helper，见 D-11）。domain-models.md 定义 11 个编号类型（§1-§11，含未上表的 RunSpec §2 / RunState §3 / ConcurrencyGate §11）+ Ports 接口节（3 个 port）。ConcurrencyGate 实现详见 FR-7。

### FR-2: 三层架构（D-12）

```
Interface (Pi API 表面)
  ├─ tools: workflow / workflow-script (2 个，收口)
  ├─ command: /workflows (仅 1 个，查看用)
  ├─ views/ (TUI 渲染)
  └─ helper 函数 (非类):
      • confirmTmp()   ← 吞并 ApprovalPolicy (D-11)
      • notifyDone()   ← 吞并 NotificationService
Engine (编排核心，不依赖 Pi SDK)
  ├─ WorkflowRun 聚合根 + 核心模型 (RunState/RunRuntime/Budget/AgentCall/Trace/WorkflowScript)
  └─ free functions (非 Service 类):
      run/pause/resume/abortWorkflow
      retryNode / skipNode
      handleWorkerError / handleScriptError  (3 次重试+退避)
      executeAgentCall  (重试+预算+stale 检测)
      runAndWait (pi.__workflowRun 入口)
Infrastructure (技术资源)
  ├─ 3 个 Port 实现: WorkerHostImpl / SubprocessRunner / JsonlRunStore
  ├─ ConcurrencyGate (重命名自 AgentPool, 保持 maxConcurrency=4, D-13)
  ├─ WorkerHandle (线程句柄封装，竞态防护)
  └─ WorkflowScriptRegistryImpl (扫描+缓存+去重)
```

**为什么不套四层 DDD（D-12）**：workflow 无业务领域规则，所有「模型」都是技术概念（预算计数器/执行日志/线程句柄/信号量）。强行建 Domain 层会沦为空壳，且为满足「Domain 零依赖」教条需造 IWorkerHandle / IConcurrencyGate 双层 interface + ApprovalStore port——只有一个实现的 interface 是伪抽象。三层承认 Engine 是核心，技术资源在 Infra 给具体类。原四层 spec 的真实改进（状态机简化、RunState/RunRuntime 分离、Context 收敛、tool 收口）全部保留。

### FR-3: 状态机简化

8 态 → 3 态 + doneReason：

```
type RunStatus = "running" | "paused" | "done"
type DoneReason = "completed" | "failed" | "aborted" | "budget_limited" | "time_limited"

合法转换：
  (init) → running
  running ↔ paused
  running → done(reason)
  paused → done(reason)
```

资源转换由状态推导，消除 terminateInstance 的 4 个 boolean flag（cleanupWorker/keepController/cleanupTempFiles/deletePool）。

### FR-4: dependency 收敛

5 个重叠 interface（OrchestratorCore / ErrorHandlerContext / AgentCallContext / BudgetCallbacks / TerminateDeps）→ 3 个 port：

- `AgentRunner` — 执行 agent 调用（spawn pi）
- `RunStore` — 持久化 workflow run
- `WorkerHost` — Worker 线程生命周期

### FR-5: tool 收口

4 个 tool → 2 个：

| 新 tool | actions | 合并自 |
|---------|---------|--------|
| `workflow` | run / status / pause / resume / abort / retry-node / skip-node | workflow + workflow-run（运行领域），**不包含 restart（废弃）** |
| `workflow-script` | generate / lint / save / delete / list | workflow-generate + workflow-lint（脚本领域） |

### FR-6: command 收口

`/workflow run|list|abort|save|delete` 全部移除（功能由 tool 或 /workflows 面板承担）。仅保留 `/workflows` 打开交互式面板。

### FR-7: ConcurrencyGate（原 AgentPool）

- 重命名：`AgentPool` → `ConcurrencyGate`（语义对齐"并发闸门"）
- maxConcurrency: **保持 4**（D-13，无数据支撑改为其他值）
- 职责瘦身：soft limit 移到 Budget 的 `isSoftLimitReached()` 查询；setBudget 移除
- Engine 层直接用具体类（不造 IConcurrencyGate interface，D-12）
- 保留：per-run 实例化（避免跨 run 互相阻塞）、FIFO 队列、abort 传播

## Acceptance Criteria

### AC-1: 架构合规（三层，D-12）
- 三层依赖方向严格向下：Factory → Interface → Engine → Infra
- Engine 层不依赖 Pi SDK（@mariozechner/*），但可用 node:worker_threads 等 Node 原生类型（承认技术资源的技术属性）
  验证：`grep -rnE "from ['\"]@mariozechner" extensions/workflow/src/engine/` 无输出
- Interface 层依赖 Engine + Infra，不散落领域逻辑
- 无循环依赖（engine 模块不再经 OrchestratorCore 回调自己）
  验证：`grep -rn "OrchestratorCore" extensions/workflow/src/` 无输出
- **不再要求** Domain 零依赖教条（无 Domain 层）；**不再要求** Application 层不 import Infra（无 Application 层，Engine 直接用 Infra 具体类）

### AC-2: 重复消除
- `terminateDepsFrom*` adapter（2 个：terminateDepsFromBudget / terminateDepsFromCtx）+ `terminateDeps()` factory method 全部消失
  验证：`grep -rn "terminateDeps" extensions/workflow/src/` 无输出（覆盖 adapter / factory 函数定义 / bare 调用 / interface 声明 / 方法实现 / 调用点 全部形态）
- 4 个 Context factory（errorHandlerContext / agentCallContext / budgetCallbacks / terminateDeps）消失
  验证：`grep -rn "errorHandlerContext\|agentCallContext\|budgetCallbacks" extensions/workflow/src/` 无输出
- OrchestratorCore 接口消失
  验证：`grep -rn "OrchestratorCore" extensions/workflow/src/` 无输出
- terminateInstance 的 4 个 boolean flag（cleanupWorker / keepController / cleanupTempFiles / deletePool）消失
  验证：`grep -rn "cleanupWorker\|keepController\|cleanupTempFiles\|deletePool" extensions/workflow/src/` 无输出

### AC-3: 模型封装
- RunRuntime 字段不再被 Interface 层直接赋值，通过 WorkflowRun.assignRuntime / releaseRuntime / replaceRuntime 变更
  验证：`grep -rnE "\.worker\s*=|\.controller\s*=|\.gate\s*=" extensions/workflow/src/interface/` 无输出（Engine 内部赋值除外）
- WorkflowScript 的 meta 提取/lint/包装/保存操作收敛为方法
  验证：infra 层不再导出独立 lint 函数（lint 逻辑内聚于 WorkflowScript.validate）
- WorkerHandle 封装竞态防护（currentWorker !== exitedWorker 不再散在 handler）
  验证：`grep -rn "currentWorker\|exitedWorker" extensions/workflow/src/interface/` 无输出（封装进 Infra 层 WorkerHandle）

### AC-4: 外部契约保持
- workflow 脚本格式不变（`.js` 里的 agent()/parallel()/pipeline()/$ARGS/$BUDGET）
- `pi.__workflowRun` 签名调整（同步修改 2 个 gate caller 文件）：
  ```ts
  pi.__workflowRun?: (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ) => Promise<{
    status: "done";
    reason: "completed" | "failed" | "aborted" | "budget_limited" | "time_limited";
    scriptResult?: unknown;
    error?: string;
    runId: string;
  }>
  ```
- coding-workflow 的 2 个 gate caller 文件（review-gate.ts / test-fix-loop.ts）同步改**全部 `wfResult.status` 引用**（每个文件 5 处，避免诊断/details 语义退化）：
  - 类型签名（line ~39）：`{ status: string; ... }` → `{ status: "done"; reason: DoneReason; scriptResult?: unknown; error?: string; runId: string }`
  - 条件判断（line ~76）：`status !== "completed"` → `reason !== "completed"`
  - 诊断消息（line ~79）：`status=${wfResult.status}` → `reason=${wfResult.reason}`（避免退化为 `status=done` 常量丢失 failed/aborted/budget_limited/time_limited 区分）
  - details 字段（line ~80, ~89）：`status: wfResult.status` → `reason: wfResult.reason`（下游 gate-reviewer 消费 details 时能区分失败类型）
  - 验证：`grep -rn "wfResult\.status\|status: string" extensions/coding-workflow/lib/gates/` 无输出

### AC-5: 测试
- 旧测试全部重写（针对新 domain 模型）
- Engine 层模型测试不 mock Pi 运行时（纯数据 + 不变式逻辑）
- 现有 workflow 脚本能在新架构上跑通（含 pause/resume 跨 session 恢复）

### AC-6: 类型检查零容忍
- `pnpm -r typecheck` 零错误
- `pnpm -r lint` 零错误
- 禁止 `any`，禁止 `as unknown as T`

## Constraints

- **破坏性变更允许度：方案 C（最大自由度）**——仅保留 workflow 脚本格式（用户资产）不可变。pi.__workflowRun 签名调整（D-8），同步修改 2 个 gate caller。JSONL 持久化格式、WorkflowStatus 枚举、tool/command 名称、内部 API 全部允许破坏。代价：旧 session 历史 run 无法在新版本恢复（可接受，workflow run 是短生命周期执行实例）。
- 技术栈：TypeScript + Pi Extension API + typebox + pi-tui + pnpm workspace
- 禁止 `any`（用 `unknown` 或具体类型）
- 单文件 ≤ 1000 行，函数 ≤ 80 行
- Worker 线程执行模型保留（每 run 一个 Worker 跑用户脚本）
- pi 每次 agent 调用都 spawn 新进程，不复用——ConcurrencyGate 是并发闸门，不是进程池

## 业务用例

### UC-1: AI 驱动 workflow 执行（主路径）
- **Actor**: AI agent（通过 workflow tool 调用）
- **场景**: AI 收到"执行 PR 的 workflow"类需求，调用 `workflow { action: "run", name: "...", mode: "auto" }`，系统 fuzzy 匹配脚本、确认后启动、后台执行、完成时通过 completion notification 唤醒 AI 处理结果
- **预期结果**: workflow 完成，AI 收到 scriptResult 和 trace，可继续后续动作

### UC-2: 外部扩展程序化调用（pi.__workflowRun）
- **Actor**: coding-workflow 的 gate（review-gate / test-fix-loop）
- **场景**: gate 调用 `pi.__workflowRun("phase1-review-gate", args, signal, timeoutMs)`，等待执行完成，消费 scriptResult 判断 pass/fail
- **预期结果**: gate 拿到结构化结果，决定是否通过 + 给出 fixGuidance

### UC-3: 用户交互式查看
- **Actor**: 人类用户
- **场景**: 用户输入 `/workflows`，打开三级导航 TUI 面板，浏览 phase → agent → detail，查看实时进度和 trace
- **预期结果**: 用户看到当前所有 run 的状态和执行细节

## 决策记录

| ID | 决策 | 理由 |
|----|------|------|
| D-1 | 破坏性变更选方案 C | 用户明确：AI 可发起调用，外部兼容性不是约束 |
| D-2 | tool 收口为 2 个（workflow + workflow-script） | 单入口 schema 膨胀；按领域（运行 vs 脚本）划分语义清晰 |
| D-3 | ConcurrencyGate 重命名（保持 maxConcurrency=4） | "Pool"名实不符误导；并发度 4 是现状经验值，无数据支撑变更（见 D-13） |
| D-4 | state_lost 移出状态机 | reconstruct 时状态文件损坏 → 标 failed + error="state lost"，不进状态机，与其他 failed run 一致处理 |
| D-5 | JSONL 格式不兼容旧 session | 配合新模型，旧 run 历史价值低 |
| D-6 | 8 态 → 3 态 + doneReason | 消除 5 处重复 terminateInstance 调用 |
| D-7 | Worker 线程模型保留 | 隔离正确，换 VM sandbox 风险大无收益 |
| D-8 | pi.__workflowRun 签名改为 `{status:"done", reason}` | 内部对外一致用 done+reason，语义更清晰；同步改 2 个 gate caller 文件（review-gate.ts / test-fix-loop.ts） |
| D-9 | 废弃 restart 操作 | AI 用 run 新建语义等价；TUI 快捷键和 orchestrator.restart 一起删 |
| D-10 | trace 单一来源 = instance.trace | 废弃 appendEntry workflow-trace 双写，trace 随 state 文件内聚持久化 |
| D-11 | ApprovalPolicy 删除（降为 Interface 层 helper） | 现状就 1 个 Set + 2 行代码（isTmp \|\| !approved → add + appendEntry），建模成 domain 值对象 + port 是过度设计。helper 函数是正确实现 |
| D-12 | 架构从四层（DDD）改为三层（Interface/Engine/Infra） | workflow 是技术编排引擎，无业务领域规则。Domain 层会沦为空壳（Budget/Trace/AgentCall 全是技术概念）。为满足「Domain 零依赖」教条需造 IWorkerHandle/IConcurrencyGate 双层 + ApprovalStore port（只有一个实现的 interface = 伪抽象）。三层承认 Engine 是核心，砍空壳层 + 伪 port + 上帝对象方法（AgentCall.execute）+ 值对象副作用（Budget.onConsume）。原四层 spec 的真实改进（状态机简化、RunState/RunRuntime 分离、Context 收敛、tool 收口）全部保留 |
| D-13 | maxConcurrency 保持 4（不改为 5） | D-3 原提「4→5」无任何数据/需求支撑，属无理由数值变更。保持现状经验值 |

## Out of Scope

- workflow 脚本格式变更（agent/parallel/pipeline API、$ARGS/$BUDGET/$WORKSPACE 全局）
- 新功能开发（checkpoint、条件分支等脚本语法）
- TUI 完全重新设计（WorkflowsView 适配新 domain 接口即可，保留现有三级导航 + 现有快捷键集，移除 'r' restart 快捷键因 D-9）
- Worker 线程执行模型替换（保留现状）
