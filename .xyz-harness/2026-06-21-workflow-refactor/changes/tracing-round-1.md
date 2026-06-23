# Tracing Round 1

## 追踪范围

- **spec 初稿版本**：spec.md（verdict: pass），引用 `./domain-models.md` 但**该文件不存在**（见 G-016）
- **clarification 版本**：4 轮讨论确认的 7 项核心决策 + pi.__workflowRun 真实使用场景 + AgentPool 事实
- **追踪的视角**：
  - P1 User Journey — 适用（有 AI/人类/外部扩展 3 类 actor 的操作路径）
  - P2 Data Lifecycle — **部分适用**（WorkflowRun/WorkflowScript/AgentCall 有生命周期，但非 CRUD；受 G-016 阻塞，只能追踪 spec 已列出的字段维度）
  - P3 API Contract — 适用（tool/action 是接口契约，2 个新 tool 收口）
  - P4 State Machine — **强适用**（状态机简化是核心需求 FR-3）
  - P5 Failure Path — 适用（Worker 重试、agent-call 重试、abort、budget 触发等失败路径密集）

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G-001 | D | State Machine | P4 / FR-3 × AC-4 | **pi.__workflowRun 返回的 `status` 字段在状态机简化后的语义**。FR-3 定义 `RunStatus = "running" \| "paused" \| "done"`，但 AC-4 说签名 `{status, scriptResult?, error?, runId}` 不变。消费者（review-gate.ts:76 / test-fix-loop.ts:76）硬编码检查 `wfResult.status !== "completed"`。若返回 `"done"`，所有 gate 永远失败；若返回 doneReason（completed/failed/...），则 status 字段类型与 RunStatus 不一致。这是 spec 内部矛盾，必须明确决策。 |
| G-002 | F | State Machine | P4 / D-4 × reconstructState | **state_lost 在新模型中的建模路径**。clarification D-4 说"state_lost 移出状态机归 error handling"，但 spec FR-3 的状态转换表完全没列 state_lost。当前 reconstructState 在 state 文件损坏时创建 `status: "state_lost"` 的 placeholder instance（state-store.ts:99）。新模型中它属于 WorkflowRun 的哪种状态？doneReason 里也没有它。用户在 /workflows 面板看到 state_lost run 时如何处置（重试/丢弃）？ |
| G-003 | F | State Machine | P4 / state.ts:109 | **pausedAt 字段在新模型的位置**。当前 WorkflowInstance 有 pausedAt（pause 时设置、resume 时清空），terminateInstance 特意不碰它。spec 9 个模型列表没提 pausedAt 归属 WorkflowRun 还是 RunRuntime。它影响 /workflows 面板的"已暂停 X 秒"显示。 |
| G-004 | D | State Machine | P4 / FR-3 | **doneReason 的存储字段和设置者**。spec 说 `running → done(reason)`，但没说 reason 存在 WorkflowRun 的哪个字段、由谁负责把当前的 5 处 terminateInstance 调用（每个传入不同 status）映射到 doneReason。terminateInstance 当前直接把 status 写入 instance.status——新模型是保留 5 值 status（与 FR-3 矛盾）还是改成 status="done" + reason 字段？ |
| G-005 | F | API Contract | P3 / FR-5 | **workflow tool 新增 retry-node / skip-node 的契约**。spec FR-5 列出 actions 含 retry-node/skip-node，但当前这两个操作**只存在于 orchestrator 内部**（retryRunNode/skipRunNode），**从未暴露到 tool surface**。新 tool 契约未定义：参数 schema（runId + callId 必填？）、前置条件（status 必须是 running 还是 paused 也允许？对应 lifecycle.ts:295 的校验）、与 reentry-guard 的关系、错误码、幂等性。 |
| G-006 | F | API Contract | P3 / FR-5 × WorkflowsView:451 | **restart 操作的去留**。spec FR-5 的 workflow actions 列表**没有 restart**，但当前 WorkflowsView 有 'r' restart 快捷键（line 451 触发 orchestrator.restart）+ orchestrator.restart 公开 API + lifecycle.ts:366 restartRun 实现。restart 是被废弃？还是保留为 TUI-only（不进 tool）？若废弃，AC-4 "外部契约保持" 是否包含 TUI 行为契约？ |
| G-007 | F | API Contract | P3 / FR-5 × workflow-files.ts | **workflow-script tool 的 save / delete / list actions 契约**。当前这些是 `/workflow save|delete` 命令（commands.ts:344-381），不在任何 tool。新 tool 收口后：(1) save 参数（tmpName + newName?）；(2) delete 参数（name）和行为——deleteWorkflow 需要 `isRunning` 回调判断 workflow 是否在运行（workflow-files.ts:65），新 tool 怎么获取这个信息（注入 orchestrator 实例？通过 WorkflowRun 查询？）；(3) list 的输出 schema。 |
| G-008 | F | API Contract | P3 / FR-1 ApprovalPolicy | **ApprovalPolicy 领域服务的边界**。spec FR-1 说 ApprovalPolicy 替换"裸 Set + 散落条件分支"，但实际代码只有**一处** approval 逻辑（tool-workflow-run.ts:113 的 `shouldConfirm = isTmp || !sessionApprovals.has(name)` + appendEntry "workflow-approval-memory"）。这个"领域服务"封装什么？是否包含 RPC 模式的 sendUserMessage 降级（tool-workflow-run.ts:124）？sessionApprovals Set 的 session 生命周期归属 WorkflowLauncher 还是单独的 ApprovalService？ |
| G-009 | F | API Contract | P3 / reentry-guard.ts | **reentry-guard 在新架构的去留**。当前 tool-workflow 和 tool-workflow-run 共享 `ReentryGuardRef { isProcessing }`（index.ts:52）防止并发 tool 调用 clobber orchestrator state。spec 完全没提这个机制。2 个新 tool 是否仍共享 guard？retry-node/skip-node 加入后 guard 覆盖范围是否扩大？ |
| G-010 | F | API Contract | P3 / index.ts:173 | **tool_call 事件钩子的迁移**。当前 index.ts:173 监听 `tool_call`，在 workflow-generate 调用时自动注入 `skills/workflow-script-format/SKILL.md` 内容作为 steering message。spec 没提。tool 收口后，这个 hook 应该迁移到 `workflow-script { action: generate }` 还是保留为 Extension 级 hook？若迁移，触发条件怎么判断（action 字段）？ |
| G-011 | F | API Contract | P3 / commands.ts:73 | **completion notification 的 _render descriptor 保留**。当前 sendCompletionNotification 发送带 `_render: { type: "task-list", data: {...} }` 的 customType:"workflow-result" 消息（commands.ts:73），供 xyz-agent GUI 渲染。这是跨扩展 GUI 协议。spec 没提。新架构 NotificationService 是否保留这个协议？trace items 的字段映射是否变？ |
| G-012 | F | User Journey | P1 / index.ts:111 | **session_tree 切分支时强制转 paused 的行为**。当前 index.ts:111-138 在 session_tree 事件时：(1) cleanupAllTempFiles 旧 orchestrator；(2) 创建新 orchestrator；(3) 遍历 running runs 强制 transitionStatus(inst, "paused")（line 130，catch 噪声）。spec 没说这个跨 session 恢复语义是否保留。新版 RunLifecycleService 是否承担这个责任？ |
| G-013 | F | User Journey | P1 / index.ts:144 | **session_shutdown pause-all 行为**。当前 index.ts:144 在 session_shutdown 时 `Promise.allSettled(running.map(inst => orch.pause(inst.runId)))`。spec 没说这个清理路径是否保留。若 Pi 进程被 kill -9，这个 cleanup 不会触发——在途 run 的状态文件会留下 "running" 状态，下次 session_start reconstructState 时如何处理（当前是保留 running 状态，但 Worker 已死）？ |
| G-014 | D | User Journey | P1 / WorkflowsView 快捷键 | **TUI 操作集合的变化**。spec Out of Scope 说"TUI 完全重新设计（WorkflowsView 适配新 domain 接口即可）"，但当前 TUI 有 6 个操作（'x' stop / 'p' pause-resume / 'r' restart / 's' save / 'S' trace 导出 / esc）。其中 'r' restart 对应的 tool action 已不在 FR-5 列表（见 G-006），'s' save 现在改为 tool action（FR-5 workflow-script.save）。TUI 操作集合是否跟随 tool 收口变化？'S' trace 导出是否保留？ |
| G-015 | F | Data Lifecycle | P2 / FR-1 | **`./domain-models.md` 文件不存在**。spec FR-1 明确说"详见 [domain-models.md](./domain-models.md)"，并在表格中列出 9 个模型但只给"类型"和"替换的现状"两列。**没有字段定义、不变式、模型间关系**。这阻塞 Data Lifecycle 视角对 WorkflowRun / AgentCall / Budget / Trace / RunRuntime 的字段级追踪。本 round 所有 P2 gap 都是因此降级为"基于现有代码反推"。 |
| G-016 | F | Data Lifecycle | P2 / state.ts:119 | **errorLogs 字段归属**。当前 WorkflowInstance.errorLogs 是 Worker 捕获的 `console.*` 日志数组（用于 TUI 在失败时展示诊断，不泄漏到 input area）。spec 9 个模型没说它归属 Trace（作为事件流的一部分）还是 WorkflowRun（作为 run 级诊断）还是 RunRuntime（运行时短期状态）。影响 serialize/deserialize 策略。 |
| G-017 | F | Data Lifecycle | P2 / state.ts:97 | **ExecutionTraceNode.sessionId 字段归属**。当前 trace node 有 sessionId（pi subprocess uuidv7，用于 post-run 检查 session JSONL）。spec 把 Trace 建模为事件流、AgentCall 建模为实体——sessionId 应归 AgentCall 实体（标识一次 agent 调用的 subprocess）还是 Trace 节点？影响 AgentCall 实体的字段定义。 |
| G-018 | F | Data Lifecycle | P2 / state.ts:92 × execution-trace.ts | **trace 双写机制的去留**。当前 trace 同时存在两处：(1) `WorkflowInstance.trace` 数组，随 instance serialize 到 `<sessionDir>/workflow-state/<runId>.jsonl`；(2) 每次 trace 节点变化时 `pi.appendEntry("workflow-trace", { runId, node })`（execution-trace.ts:34）写入 session JSONL（append-only）。spec 说 Trace 模型替换 instance.trace 数组成"事件流"——那 appendEntry 的 workflow-trace entries 是废弃？还是成为 Trace 重建的唯一来源？两者数据冗余当前是有意为之还是历史包袱？ |
| G-019 | F | Data Lifecycle | P2 / state.ts:66 | **callCache 的建模和持久化**。当前 `callCache: Map<number, AgentResult>` 序列化到 state 文件（serializeInstance 把 Map 转 entry 数组）。spec 把 AgentCall 建模为实体——callCache 是否变成 AgentCall 实体集合（按 callId 索引）？AgentResult 的 parsedOutput/usage/toolCalls 字段是否全部归入 AgentCall？persist 策略当前是 rewrite 整个 instance 文件——这在新模型下性能是否可接受（长 trace + 大 callCache）？ |
| G-020 | F | Data Lifecycle | P2 / state.ts:209 | **verifyStrategy 字段被序列化时 omit 的原因**。当前 `SerializedExecutionTraceNode = Omit<ExecutionTraceNode, "verifyStrategy">`（state.ts:129），serializeInstance 显式剥离它（line 217）。这个字段来源不明（代码里没找到写入点），但保留在类型里。新模型的 AgentCall/Trace 是否需要这个字段？若不需要应明确删除，避免迁移时把它当历史包袱带过去。 |
| G-021 | F | Failure Path | P5 / error-handlers.ts:21 | **Worker error retry 策略在新模型的位置**。当前 MAX_WORKER_RETRIES=3 + 指数退避（1s/2s/4s）在 error-handlers.ts:21。spec FR-2 把 ErrorRecoveryService 列在 Application 层但**完全没说参数**。迁移后：重试上限是否保留 3？退避策略是否保留指数？retryCount 存储位置（当前在 RunResources.retryCount，spec 说 RunRuntime 替换部分字段）？ |
| G-022 | F | Failure Path | P5 / agent-call-handler.ts:14 | **agent-call retry 策略**。当前 MAX_AGENT_RETRIES=3 + 指数退避在 agent-call-handler.ts:14，且 agent-call 与 worker 两套重试独立。spec 没说 agent-call 层的重试是否保留、归到 ErrorRecoveryService 还是 AgentRunner port。两套重试叠加（worker 3 × agent 3 = 9 次最坏情况）是否有意为之？ |
| G-023 | F | Failure Path | P5 / agent-call-handler.ts:18 | **stale-context 检测的去留**。当前 agent-call-handler.ts 有 STALE_CONTEXT_PATTERNS（"stale context"/"context canceled"/"aborted"）检测——命中则不重试直接失败（避免 compact 后无效重试）。spec 完全没提这个机制。新模型是否保留？归 ErrorRecoveryService 还是 AgentRunner？ |
| G-024 | F | Failure Path | P5 / orchestrator-budget.ts + agent-pool.ts:43 | **soft limit warning 迁移后的细节**。spec FR-7 说"soft limit 预警移到 Budget 领域对象"，当前在 AgentPool.maybeEmitSoftWarning（阈值 SOFT_MAX_AGENTS_WARNING=500，per-pool totalCallCount）。迁移后：(1) 阈值是 per-run 还是全局？(2) 触发回调签名（当前 `{runName, totalCalls, budget}`）；(3) totalCallCount 计数器存哪——Budget 值对象自己持有还是 ConcurrencyGate 持有？ |
| G-025 | F | Failure Path | P5 / worker-manager.ts:78 | **AbortController per-run 重建逻辑**。当前 recreateRunAbortController 用于 resume/retry 后重建 controller + 重注册 pause-on-signal listener（worker-manager.ts:78）。spec FR-3 说"资源转换由状态推导，消除 terminateInstance 的 4 个 boolean flag"——但 AbortController 重建是 resume 路径的硬需求（旧 controller 已 abort）。新模型如何用"状态推导"覆盖这个逻辑？keepController 这个 boolean 真的能消除吗？ |
| G-026 | F | Failure Path | P5 / lifecycle.ts:458-476 | **runAndWait 的非枚举 status 返回值**。当前 runAndWait 可能返回 `status: "timeout"`（超时）、`status: "unknown"`（instance 丢失）、`status: "aborted"`（信号触发）——前两个**不在 WorkflowStatus 枚举里**（lifecycle.ts:458/462/476）。状态机简化后这些边缘值怎么处理？消费者（review-gate）目前只检查 `!== "completed"`，timeout/unknown 会被当 failed 处理——这个行为是有意的吗？ |
| G-027 | F | Failure Path | P5 / agent-pool.ts:230 | **per-call timeoutMs 与 per-run AbortController 合并逻辑**。当前 agent-pool.ts:230 为每次 agent call 创建独立 AbortController，合并外部 signal + opts.timeoutMs（per-call wall-clock）。spec 没说这个 per-call timeout 机制是否保留、归 AgentRunner 还是 ConcurrencyGate。AgentCallOpts.timeoutMs 字段是否进 AgentCall 实体？ |
| G-028 | F | Data Lifecycle | P2 / AC-5 | **现有 22 个测试文件的迁移策略**。spec AC-5 说"旧测试全部重写"。当前测试覆盖：state-machine.test（转换合法性）、state-budget.test（budget 阈值）、orchestrator-events.test（事件订阅 tick）、orchestrator-stale.test（stale context）、terminate-instance.test（A4 顺序）、worker-runtime.test 等。spec 没给测试覆盖度目标——哪些场景必须保留测试（如 stale context、A4 cleanup-before-mutate 顺序、跨 session pause/resume）？否则可能丢失当前已验证的不变式。 |

## 降级视角记录

本需求是架构重构，按 scenario-tracing.md 的「视角适用性与降级」表，重构类需求默认降级 Data Lifecycle / API Contract / State Machine。但本需求 clarification.md 明确指出「State Machine 视角强适用」「API Contract 适用」「Data Lifecycle 部分适用」，所以**未做降级**，5 视角全部完整追踪。

降级理由不适用——本重构同时变更数据模型（9 个新模型）、API 表面（tool/command 收口）、状态机（8→3 态），三视角都是核心审查对象。

## 关键 gap 摘要（供主 agent 优先处理）

**🔥 阻塞型（必须先解决才能进入 plan 阶段）：**

1. **G-016 domain-models.md 缺失** — 9 个领域模型没有任何字段定义，所有 P2 追踪都是反推。主 agent 必须先写这个文件。
2. **G-001 pi.__workflowRun status 语义矛盾** — FR-3 与 AC-4 直接冲突。若按 FR-3 字面执行（返回 "done"），coding-workflow 的 review-gate 和 test-fix-loop 全部失效。这是 spec 内部不一致，必须用户决策。

**⚠️ 高影响（改变外部契约或破坏当前已验证不变式）：**

3. **G-005 / G-006 retry-node/skip-node/restart 的 tool surface 决策** — retry-node/skip-node 是新增 tool action（当前不在 surface），restart 是删除 tool action（当前在 TUI）。两者都没有契约定义。
4. **G-018 trace 双写机制** — 当前 instance.trace 数组 + appendEntry workflow-trace 双写。Trace 模型事件流化后必须明确数据来源单一化，否则持久化层会出现一致性问题。
5. **G-021/G-022/G-023 retry/stale-context 策略** — 当前有完整的 worker 3 次 + agent 3 次 + stale 不重试的失败处理矩阵。spec 把 ErrorRecoveryService 列在 Application 层但参数全缺。迁移时漏掉任何一个都会导致 regression。

**📋 中影响（实现细节，plan 阶段可决策）：**

G-002 state_lost 建模 / G-003 pausedAt 归属 / G-004 doneReason 字段 / G-007 workflow-script tool 契约 / G-008 ApprovalPolicy 边界 / G-009 reentry-guard / G-010 tool_call 钩子 / G-011 _render descriptor / G-012/G-013 session_tree/shutdown 行为 / G-014 TUI 操作集 / G-016-G-020 字段归属 / G-024-G-027 失败路径细节 / G-028 测试覆盖度。

## 追踪统计

- 总 gap 数：**28**
- 类型分布：F（Fact）= 21，D（Decision）= 5，K（Knowledge）= 0（无纯业务知识 gap，本需求是内部重构）
- 视角分布：State Machine = 4，API Contract = 7，User Journey = 3，Data Lifecycle = 6，Failure Path = 8
- 阻塞型：2（G-001, G-016）
