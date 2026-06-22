# Tracing Round 3

## 收敛判定：NOT CONVERGED

完整重跑 5 视角后发现 **1 个新 gap**（D 类，RunRuntime 生命周期语义内部矛盾）。Round 1 的 28 个 gap + Round 2 的 2 个 gap 均已被主 agent 处理（domain-models.md 字段定义 + D-8/9/10/11 + 隐式契约保留清单 + G2-001/G2-002 层归属策略），未重复报告。

新 gap 的根因：**domain-models.md 对 RunRuntime 在 pause 时的生命周期存在两处自相矛盾的描述**——WorkflowRun 的不变式 + releaseRuntime() 要求 pause 时丢弃整个 RunRuntime，而 RunRuntime.release("pause") 的注释却说"保留 gate+controller（为 resume）"。两者不可能同时成立，且 AbortController 一次性语义使"保留 controller"在技术上不可能。

## 追踪范围

- **spec 版本**：spec.md（verdict: pass）+ domain-models.md（12 个模型 + Ports + 层归属策略 + 失败矩阵 + 测试不变式）+ clarification.md（含 Round 1 D-8/9/10/11 + Round 2 G2-001/G2-002 决策）
- **追踪的视角**（完整重跑，非增量）：
  - P1 User Journey — 适用（AI/外部扩展/人类 3 类 actor，UC-1/2/3）
  - P2 Data Lifecycle — 部分适用（WorkflowRun/WorkflowScript/AgentCall 有生命周期，非 CRUD）
  - P3 API Contract — 适用（2 个 tool 收口 + pi.__workflowRun + /workflows）
  - P4 State Machine — 强适用（FR-3 状态机简化）
  - P5 Failure Path — 适用（重试/budget/abort/竞态路径密集）

无降级视角——本重构同时变更数据模型/API 表面/状态机，5 视角都是核心审查对象。

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G3-001 | D | State Machine | P4 / domain-models RunRuntime × WorkflowRun 不变式 × AbortController 语义 | **RunRuntime 在 pause 时的生命周期描述自相矛盾**。domain-models.md 有三处互相冲突的描述：(1) WorkflowRun 不变式 `state.status === "running" ⟺ runtime !== undefined` —— pause（status=paused）时 runtime 必须 undefined；(2) WorkflowRun.releaseRuntime() 注释"pause/done 时解绑（runtime 置 undefined）"—— pause 时整个 RunRuntime 被丢弃；(3) RunRuntime.release(mode) 注释"pause: 销毁 worker + tempFiles，**保留 gate+controller（为 resume）**"—— 暗示 gate/controller 跨 pause 存活供 resume 复用。若 (1)(2) 成立（RunRuntime 被丢弃），则 (3) 的"保留"无意义——对象都没了，保留什么？若 (3) 成立（RunRuntime 存活），则违反 (1) 的不变式。进一步：AbortController 是一次性对象，一旦 abort() 无法 un-abort，"保留 controller（为 resume）"在技术上不可能——当前代码 resumeRun 调 recreateRunAbortController 创建**新** controller（lifecycle.ts:207），而非复用旧的。**现状代码事实**：pauseRun 传 `keepController:true, deletePool:false`（lifecycle.ts:174/176），terminateWorker(keepController=true) 仍调 controller.abort()（worker-manager.ts:143）只是不置空引用，resume 时 recreateRunAbortController 新建。即现状 controller 被 abort 后丢弃、resume 重建；pool（gate）跨 pause 保留（deletePool:false）。新模型需决策：(a) pause 丢弃整个 RunRuntime（遵循不变式），resume 时 assignRuntime 全新 worker+gate+controller——此时 release("pause") 注释应改为"销毁 worker+tempFiles，gate/controller 随 RunRuntime 丢弃，resume 全部重建"，且 gate 从"per-run"实际降级为"per-running-segment"（行为变化：现状 deletePool:false 保留 pool，新模型不保留；但 worker 重跑脚本+callCache replay 使 gate 队列清空无关紧要，语义无害）；(b) RunRuntime 跨 pause 缓存在别处（非 WorkflowRun.runtime 字段），resume 时重绑——需引入未指定的缓存机制，且 controller 仍必须重建（一次性）。两种方案都需主 agent 明确，否则实现者读 domain-models 会卡在"pause 时到底保留还是丢弃 RunRuntime"。 |

## 追踪明细

### P1: User Journey

- **OP-U01 AI 启动 run（UC-1）**：run → fuzzy 匹配 → confirm → 后台 → completion notification。reentry-guard（G-009 隐式契约登记"2 tool 共享 → Interface 层"）、tmp/unapproved confirm（G-008/D-11 ApprovalPolicy 值对象 + ApprovalStore port）、completion notification（G-011 _render 保留）均闭合。无新 gap。
- **OP-U02 外部扩展 pi.__workflowRun（UC-2）**：D-8 签名 `{status:"done", reason: DoneReason, scriptResult?, error?, runId}` 闭合 G-001/G-004/G-026。timeout/unknown 边缘值映射到 reason 属 plan 实现细节（DoneReason 枚举已含 time_limited/failed）。无新 gap。
- **OP-U03 /workflows 交互（UC-3）**：spec Out of Scope 已声明"WorkflowsView 适配新 domain 接口即可"。restart 快捷键随 D-9 删除。无新 gap。

### P2: Data Lifecycle

- **WorkflowRun**：Create/Read/Update 闭合（RunLifecycleService + transition/assignRuntime/releaseRuntime + RunStore port）。Delete：restart 废弃后（D-9）deleteRun 无调用者，终态 run 随 session 结束清理——与现状一致，非 gap。
- **WorkflowScript**：validate/toExecutable/save/delete 闭合。delete 的 isRunning 回调签名保留，新 tool 如何注入是 plan 细节（G-007 覆盖）。
- **AgentCall/Budget/Trace/WorkerHandle/RunRuntime/ConcurrencyGate/ApprovalPolicy**：字段定义齐全。Round 2 G2-001（ApprovalStore port）+ G2-002（IWorkerHandle/IConcurrencyGate 拆 interface/impl）已闭合层归属。
- **共享数据类型归属**（AgentCallOpts/AgentResult/AgentUsage/WorkerLogEntry/WorkflowMeta/WorkflowSource/TracePatch/LintResult）：domain-models 的纯 domain 模型引用这些类型，它们当前散落在 infra/engine 文件。属纯数据接口迁移（无副作用、无决策），"层归属与依赖注入策略"表只列带副作用的模型，这些纯类型自然归 domain——实现者会自然迁移，非 gap。
- **callCache 持久化**（G-019）：domain-models 改为 `calls: Map<number, AgentCall>`，rewrite 模式保留。长 trace 性能是现状也有的问题，重构不引入——非 gap。

### P3: API Contract

- **workflow tool**（run/status/pause/resume/abort/retry-node/skip-node）：FR-5 列出 actions。retry-node/skip-node 参数 schema（runId+callId）与现有 pause/resume/abort 同等——plan 细节，非 gap。
- **workflow-script tool**（generate/lint/save/delete/list）：FR-5 列出。list 输出由 WorkflowScriptRegistry.loadAll() 投影——plan 细节，非 gap。
- **pi.__workflowRun**：D-8 闭合。
- **/workflows command**：仅查看，闭合。

### P4: State Machine（新 gap 集中在此视角）

- **3 态 + doneReason**：FR-3 + D-6 + WorkflowRun.transition 闭合。合法转换、非法转换抛错、终态不可离开均明确。
- **state_lost**：D-4 移出状态机，reconstruct 标 failed + error="state lost"。闭合。
- **doneReason 存储**：RunState.reason 闭合 G-004。
- **RunRuntime 生命周期（G3-001）**：**pause 时 RunRuntime 保留还是丢弃，domain-models 自相矛盾**——见 gap 列表。WorkflowRun 不变式 + releaseRuntime() 要求丢弃，RunRuntime.release("pause") 注释要求保留 gate+controller，AbortController 一次性语义使"保留 controller"不可能。现状代码 resume 时 recreateRunAbortController（新建 controller），pause 时 deletePool:false（保留 pool）。新模型未澄清。
- **状态停留时间**：running 无上限（靠 budget/time 终止），paused 无超时（跨 session 恢复，现状行为，AC-5 保留）。非 gap。
- **僵尸状态**：done 终态不可离开，running/paused 是仅有的非终态——无僵尸。非 gap。

### P5: Failure Path

- **失败处理矩阵**（domain-models 登记表）：Worker 3 次重试、Script error 3 次重试、Agent call 3 次重试、Stale context 0 次、Budget/Time 0 次——参数明确，闭合 G-021/G-022/G-023。
- **AbortController 重建**：RunRuntime.controller + release(mode) 的机制存在（G-025），但 pause 语义矛盾见 G3-001（controller 必须重建而非保留）。
- **Worker exit 竞态**：IWorkerHandle.isCurrent 闭合 G-025。
- **per-call timeoutMs**：AgentCallOpts.timeoutMs 归 AgentCall（G-027），ConcurrencyGate.enqueue 内部合并 signal+timeoutMs（隐式契约登记）。闭合。
- **soft limit**：Budget.isSoftLimitReached + onConsume 回调闭合 G-024。
- **AgentCall.execute 与 gate 的调用链**：AgentCall.execute(runner, budget, signal) 取 AgentRunner 而非 IConcurrencyGate。一致解读：Application 层调 gate.enqueue(opts, signal)，gate 内部（获得 slot 后）调 AgentCall.execute 传入 runner + 合并后的 perCallSignal，AgentCall 内部 retry 直接调 runner.run（retry 在 gate slot 内不重新排队）。此调用链可从签名推导，非矛盾，属 plan 实现细节——非 gap。
- **cleanup-before-mutate**：测试不变式清单登记。闭合。

## 追踪统计

- 总新 gap 数：**1**
- 类型分布：D（Decision）= 1，F = 0，K = 0
- 视角分布：State Machine = 1（RunRuntime 生命周期语义）
- 阻塞型：0（注释矛盾，plan 阶段可定，但不澄清会导致实现时对 pause 行为判断错误——要么违反不变式保留 RunRuntime，要么困惑"保留 controller"如何实现）
- 非阻塞但影响实现正确性：1（G3-001 关系 FR-3"资源转换由状态推导"能否无歧义落地）

## 建议

G3-001 根因单一——**domain-models.md 需统一 RunRuntime 在 pause 时的生命周期描述**。推荐方案 (a)（与不变式一致，最简）：

1. WorkflowRun.releaseRuntime() 保持现状（pause 时 runtime=undefined，RunRuntime 丢弃）
2. RunRuntime.release(mode) 的 pause 分支注释改为："销毁 worker + tempFiles；gate/controller 随 RunRuntime 丢弃，resume 时 assignRuntime 全部重建（AbortController 一次性，无法复用）"
3. 明确 gate 语义从"per-run 保留"调整为"per-running-segment 重建"（行为变化但语义无害：worker 重跑脚本 + callCache replay 使 gate 队列清空无影响）
4. （可选）在失败处理矩阵或测试不变式补一条"resume 时 controller/gate 均为新建实例"

主 agent 处理后（改 domain-models.md 注释 + 可选补测试不变式），Round 4 复核应能收敛。
