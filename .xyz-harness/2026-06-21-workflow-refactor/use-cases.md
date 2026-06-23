---
verdict: pass
---

# Use Cases — Workflow Extension 整体重构

从 spec.md 的「业务用例」章节提取并细化。每个 UC 包含 Actor、Preconditions、Main Flow、Alternative/Exception Paths、Postconditions、Module Boundaries。

## 覆盖映射表

| UC | Spec 来源 | 覆盖的 AC |
|----|----------|----------|
| UC-1 | spec UC-1 | AC-4, AC-5 |
| UC-2 | spec UC-2 | AC-4 |
| UC-3 | spec UC-3 | FR-6, D-9 |

---

## UC-1: AI 驱动 workflow 执行（主路径）

**Actor:** AI agent（通过 `workflow` tool 调用）

**Preconditions:**
- Pi 已启动，workflow extension 已加载
- 目标 workflow 脚本存在于 `.pi/workflows/`（saved）或 `.pi/workflows/.tmp/`（tmp）
- 脚本通过 lint 检查（无 error 级 finding）

**Module Boundaries:**
- Interface 层：`tool-workflow.ts`（action=run）接收调用 + `helpers.confirmTmp()`（D-11 吞并 ApprovalPolicy）
- Engine 层：`lifecycle.runWorkflow()` 编排 + `WorkflowRun`（状态机）、`RunRuntime`（worker 生命周期）
- Infrastructure 层：`WorkerHostImpl`（启动 Worker 线程）、`ConcurrencyGate`（并发控制，maxConcurrency=4 D-13）

**Main Flow:**
1. AI 调用 `workflow { action: "run", name: "...", mode: "auto" }`
2. Interface 层 reentry guard 检查（防止并发 run 冲突）
3. `WorkflowScriptRegistry.get(name)` fuzzy 匹配脚本
4. 如果脚本是 tmp 或未批准 → `helpers.requiresConfirmation()` 返回 true → 向 AI 发确认请求
5. AI 确认后，`WorkflowScript.validate()` pre-flight 检查（调 engine/script-lint.ts）
6. `WorkflowScript.toExecutable()` strip export → scriptSource
7. `runWorkflow()` 构造 `WorkflowRun`（status=running）+ `RunRuntime`（worker 已启动）
8. Worker 线程执行脚本，通过 `agent()` 调用触发 agent 执行
9. agent 调用经 `ConcurrencyGate.enqueue()` → `SubprocessAgentRunner.run()` → spawn pi 子进程
10. 每个调用结果记录到 `AgentCall` + `Trace.update()`
11. 脚本 `return` → Worker 发送 `{type:"return", result}` → lifecycle 设置 scriptResult
12. `WorkflowRun.transition("done", "completed")` + `releaseRuntime()`
13. `helpers.notifyDone()` 发送 completion notification 唤醒 AI

**Alternative/Exception Paths:**

- **A1: 脚本不存在** → Step 3 返回 undefined → 抛 `Workflow '${name}' not found`
- **A2: Lint 失败** → Step 5 lintResult.valid === false → 抛 lint error 列表
- **A3: 预算超限** → Step 9-10 期间 `Budget.isExceeded()` → `transition("done", "budget_limited")`
- **A4: 超时** → `scheduleTimeBudgetCheck` 触发 → `transition("done", "time_limited")`
- **A5: Worker error** → `error-recovery.handleWorkerError()` → 3 次重试或 `transition("done", "failed")`
- **A6: Script error** → `error-recovery.handleScriptError()` → 3 次重试或 `transition("done", "failed")`
- **A7: Stale context** → `AgentCall.execute()` 检测 STALE_CONTEXT_PATTERNS → 不重试，标记该 call failed
- **A8: AI 中途 pause** → `workflow { action: "pause" }` → `lifecycle.pauseRun()` → `releaseRuntime()`（整个 RunRuntime 丢弃）

**Postconditions:**
- `WorkflowRun.state.status === "done"` + `reason` 有值
- `RunRuntime` 已释放（runtime=undefined）
- `RunStore.save()` 已持久化最终状态
- AI 收到 `{status:"done", reason, scriptResult, error?, runId}`

---

## UC-2: 外部扩展程序化调用（pi.__workflowRun）

**Actor:** coding-workflow 的 gate（review-gate / test-fix-loop）

**Preconditions:**
- Pi 已启动，workflow extension + coding-workflow extension 均已加载
- `pi.__workflowRun` 已在 session_start 时挂载（Interface 层 factory）
- 目标 workflow 脚本存在且通过 lint

**Module Boundaries:**
- Interface 层：`index.ts` factory 挂载 `pi.__workflowRun` → `launcher.runAndWait()`
- Engine 层：`launcher.runAndWait()` 编排 run + 等待完成
- 下游同 UC-1（lifecycle → Engine models → Infra）

**Main Flow:**
1. gate 调用 `await pi.__workflowRun("phase1-review-gate", args, signal, 900000)`
2. `launcher.runAndWait()` 调用 `lifecycle.runWorkflow()` 启动 workflow
3. 注册 completion callback（Promise resolve）
4. 可选：schedule timeout（timeoutMs → reason="time_limited"）
5. await workflow 完成（内部走 UC-1 的 Step 8-12）
6. 从 `WorkflowRun.state` 构造返回值 `{status:"done", reason, scriptResult?, error?, runId}`
7. gate 消费返回值：`if (reason !== "completed" || error) → fail + fixGuidance`

**Alternative/Exception Paths:**

- **A1: signal abort** → gate 外部 abort → `reason="aborted"`
- **A2: timeout** → timeoutMs 到期 → `reason="time_limited"`
- **A3: 脚本执行失败** → Worker/script error 重试耗尽 → `reason="failed"` + error 消息
- **A4: workflow 不存在** → `lifecycle.runWorkflow()` 抛错 → launcher 捕获 → 返回 `{status:"done", reason:"failed", error: "not found"}`

**Postconditions:**
- 返回值类型为 `{status: "done", reason: DoneReason, scriptResult?, error?, runId}`
- gate 根据 `reason` 判断是否通过

---

## UC-3: 用户交互式查看（/workflows 面板）

**Actor:** 人类用户

**Preconditions:**
- Pi 已启动，有至少一个 workflow run（running/paused/done）

**Module Boundaries:**
- Interface 层：`commands.ts`（/workflows 注册）→ `WorkflowsView`（TUI 渲染）
- Engine 层：`WorkflowRun`（只读访问 state/trace）

**Main Flow:**
1. 用户输入 `/workflows`
2. `commands.ts` 注册的 command handler 启动 `WorkflowsView`
3. WorkflowsView 从 Engine 的 `runs Map` 获取所有 runs 列表
4. TUI 渲染三级导航：L1（run 列表）→ L2（phase 分组）→ L3（agent detail）
5. 用户用方向键导航，查看实时 trace 和 budget

**Alternative/Exception Paths:**

- **A1: 无 run** → 显示空状态提示
- **A2: run 在查看期间状态变化** → event 驱动更新（trace update / status change）

**Postconditions:**
- 用户退出面板（Esc/E）
- 面板状态不持久化（纯查看，不修改 run）

**注意（D-9）：** 面板**不提供** restart 快捷键。旧版 'r' restart 已移除。用户要重新执行 workflow，使用 `workflow { action: "run" }` 新建。
