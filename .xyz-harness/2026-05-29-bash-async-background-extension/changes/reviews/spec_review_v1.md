---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-30T14:00:00"
  target: ".xyz-harness/2026-05-29-bash-async-background-extension/spec.md"
  verdict: fail
  summary: "Spec 评审第1轮，5条 MUST FIX（核心架构与 Pi API 不兼容），需修改后重审"

statistics:
  total_issues: 9
  must_fix: 5
  must_fix_resolved: 0
  low: 2
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md FR-2 (超时 detach)"
    title: "BashOperations.exec() 超时会 kill 进程，与「不 kill」需求不可兼得"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "spec.md FR-1 #1, #2"
    title: "getShellConfig / getShellEnv 不是公开 API，无法从 createLocalBashOperations 提取"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "spec.md FR-3 (Background 模式)"
    title: "BashOperations.exec() 是阻塞调用，无法「spawn 后立即返回」"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: MUST_FIX
    location: "spec.md FR-1 #7"
    title: "设置读取机制未明确：ToolCallEvent 不暴露其他工具的 settings"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: MUST_FIX
    location: "spec.md FR-3 (sendMessage)"
    title: "Background job 完成回调缺少生命周期安全描述"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "spec.md FR-8 (TUI 渲染)"
    title: "setInterval + context.invalidate() 对 background job 不可用"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "spec.md 全文"
    title: "未限制最大并发 background job 数量"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: INFO
    location: "spec.md FR-7"
    title: "临时文件清理策略仅覆盖 session_shutdown，长 session 可能膨胀"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: INFO
    location: "spec.md FR-9"
    title: "工具描述中应明确说明 sync 超时后的 AI 行为引导"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v1

## 评审记录
- 评审时间：2026-05-30 14:00
- 评审类型：计划评审（spec 完整性专项）
- 评审对象：`.xyz-harness/2026-05-29-bash-async-background-extension/spec.md`
- 参考文档：`CLAUDE.md`、`CONTEXT.md`、Pi `@mariozechner/pi-coding-agent` 公开 API（`bash.d.ts`、`bash.js` 源码）

---

## 检查维度 1：Spec 完整性

### 1.1 目标明确性 ✅
目标一段话能说清楚：创建 `bash-async` 扩展覆盖内置 bash，增加 background 执行、超时 detach、poll 和 kill 四种能力。**通过。**

### 1.2 范围合理性 ✅
四个模式（sync/background/poll/kill）边界清晰，没有蔓延到不相关领域。**通过。**

### 1.3 验收标准可量化 ⚠️
12 条 AC 大部分可量化（exitCode、jobId 存在性、进程状态）。但以下 AC 需加强：
- AC-13 "使用 createLocalBashOperations() 生成的 ops 执行命令" — 这依赖的 API 不可用（见 MUST FIX #2），需重写
- AC-14 "截断格式与内置 bash 一致" — "一致"缺乏可量化判据，建议明确为"使用同一 truncateTail 函数，输出包含相同的 `[Showing lines X-Y of Z]` 格式"

### 1.4 [待决议] / [AMBIGUOUS] 项 ✅
无未决议标记。**通过。**

---

## 检查维度 1（深入）：功能覆盖与边界

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | FR-2 | **BashOperations.exec() 超时机制与「不 kill 进程」需求根本冲突**。审查了 Pi 源码 `bash.js`：`createLocalBashOperations` 内部的 timeout handler 直接调用 `killProcessTree(child.pid)`，然后抛出 `timeout:N` 错误。FR-2 要求「超时后**不 kill 进程**」，这两者不可兼得。 | 二选一：(A) 放弃 `BashOperations.exec()`，改用 `child_process.spawn` 直接管理进程生命周期（与 subagent 扩展的模式一致），自行实现 shell 发现和 env 组装；(B) 修改需求为「超时后 kill 进程并返回已收集输出」，放弃 detach 能力。推荐方案 A。 |
| 2 | MUST FIX | FR-1 #1, #2 | **getShellConfig / getShellEnv 不是公开 API**。`createLocalBashOperations()` 返回 `BashOperations` 接口，只暴露 `exec()` 方法。shell 发现逻辑（`getShellConfig`：Windows 优先 Git Bash，Unix 优先 /bin/bash → PATH bash → sh fallback）和 env 组装（`getShellEnv`）是闭包内部实现，不作为独立函数导出。spec 引用了不存在的公开 API。 | (A) 若选方案 A（直接 spawn），需要自行实现 shell 发现逻辑（参照 bash.js 内部实现约 30 行代码），并注明这是一个需要在 plan 阶段验证的风险点；(B) 向 Pi 上游提 issue 请求导出 `getShellConfig` / `getShellEnv`，并在 spec 中标记为前置依赖。 |
| 3 | MUST FIX | FR-3 | **Background 模式与 BashOperations.exec() 不兼容**。`BashOperations.exec()` 是 `async` 方法，返回的 Promise 只在进程退出后 resolve。Background 模式要求「spawn 后立即返回 jobId」，但：(1) 不 await exec() 就无法获得 onData 回调；(2) 即使用 Promise.race 做超时，exec 内部的 spawn 生命周期与外部无法解耦。 | 统一采用 `child_process.spawn` 直接管理。这与 subagent 扩展使用 `spawn` 的模式一致（是 CLAUDE.md 中「已知的例外」）。FR-1 需要重写，从「使用 createLocalBashOperations」改为「自行实现 shell 发现（参照 Pi 内部逻辑）+ child_process.spawn 直接管理」。 |
| 4 | MUST FIX | FR-1 #7 | **设置读取机制未明确**。原文：「通过 `tool_call` 事件读取 bash 工具的 settings（shellPath、commandPrefix）」。但 `ToolCallEvent` 类型只有 `toolName` 和 `args`，不暴露其他工具的配置。`BashToolOptions` 是在 agent-session 内部创建 bash tool 时传入的，扩展无渠道读取。 | 明确设置读取方式：(A) 在 `session_start` 时从 Pi 的 settings 文件（如 `~/.pi/agent/settings.json`）直接读取 `shellPath` 和 `commandPrefix` 字段，不依赖 tool_call 事件；(B) 接受扩展级别的配置文件 `bash-async.json`，由用户手动配置 shellPath。建议方案 A + 已有的 FR-10 配置文件作为 fallback。 |
| 5 | MUST FIX | FR-3 (sendMessage) | **Background job 完成回调缺少生命周期安全描述**。FR-3 说用 `pi.sendMessage({ customType: "bash-async-result", deliverAs: "followUp", triggerTurn: true })` 注入结果，但未描述：(1) `pi` 引用如何在 execute() 返回后保持有效；(2) session 结束时 running job 的 sendMessage 调用是否安全（参考 subagent/src/spawn.ts:429 注释："sendMessage may fail if session is shutting down"）；(3) sendMessage 失败时的 fallback 行为。 | 参考 subagent 扩展的 background 模式实现（spawn.ts:409-430）：(1) 将 `pi` 引用存储在 session_start 闭包中；(2) sendMessage 调用需 try-catch，session shutdown 时忽略 sendMessage 错误；(3) 在 FR-6 Session 隔离中补充：sendMessage 的错误不传播到调用者。 |
| 6 | LOW | FR-8 | **setInterval + context.invalidate() 对 background job 不适用**。TUI 的 renderResult 在 execute() 返回时被调用一次。Background 模式下 execute() 立即返回，不存在持续渲染周期。Running 状态的 job 无法通过 setInterval 刷新显示——除非扩展自行维护一个全局渲染循环，但这超出正常扩展渲染模型。 | 修改为：sync 模式执行中（timeout 到达之前）使用 setInterval 刷新耗时显示（与内置 bash 一致）。Background 模式 execute() 返回时显示「已启动，jobId=xxx」静态信息，后续状态查询通过 poll 模式。 |
| 7 | LOW | 全文 | **未限制最大并发 background job 数量**。AI agent 理论上可以无限启动 background job，耗尽系统资源。 | 增加 FR-13：默认最大并发 background job 数量为 10（可配置）。超过时返回错误提示「已达最大并发数，请先 kill 已有 job」。 |
| 8 | INFO | FR-7 | **临时文件清理策略不完整**。仅在 session_shutdown 时清理。如果 AI 在长 session 中频繁 poll 一个产生大量输出的 job，临时文件可能膨胀到很大。 | 考虑：(1) poll 读取后截断临时文件（保留写入位置但清理已读部分）；(2) 或在 spec 中明确说明「临时文件在 session 期间持续增长，session_shutdown 时清理」作为已知限制。 |
| 9 | INFO | FR-9 | **工具描述中应更精确地引导 AI 在超时 detach 后的行为**。当前描述了四种模式，但未明确说明：超时 detach 后 AI 应该使用 poll 而非重新执行命令（这会导致重复执行）。虽然 FR-9 #5 提到了这一点，但在 description 中应更强地突出。 | 在 description 的 sync 模式说明中加粗或提前强调：「**重要：超时后进程仍在运行，不要重新执行同一命令，应使用 pollJobId 查询。**」 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## 检查维度：回归风险（相比内置 bash 丢失的能力）

逐项对照内置 bash 功能，检查 spec 是否有遗漏：

| 内置 bash 能力 | spec 覆盖 | 风险 |
|---------------|----------|------|
| Shell 发现（Git Bash / bash / sh） | FR-1 #1 引用但 API 不可用（MUST FIX #2） | 高 |
| Shell env（PATH 注入） | FR-1 #2 引用但 API 不可用（MUST FIX #2） | 高 |
| 进程组 kill（detached） | FR-1 #3 提到 detached 选项 | 低 |
| commandPrefix 注入 | FR-1 #4 提到但读取方式不明（MUST FIX #4） | 中 |
| 流式输出到 TUI（onUpdate） | FR-2 提到但机制未详述 | 低（与内置一致的行为描述足够） |
| truncateTail 截断 | FR-7 详细覆盖 | 无 |
| 非零退出码 throw Error | FR-12 覆盖 | 无 |
| AbortSignal 支持 | **未提及** | 中（见下文） |
| waitForChildProcess（处理 detached 子进程 stdio） | **未提及** | 低 |

**遗漏风险：AbortSignal 传播。** 内置 bash 通过 `ops.exec()` 接收 `signal` 参数，支持用户中断（Ctrl+C）时终止进程。Spec 中 sync 模式应支持 AbortSignal：当 AI 取消当前 tool call 时，正在运行的 sync 进程应被终止。这不需要新增 FR，但应在 FR-2 中补充说明。

**建议**：在 FR-2 补充一条：「Sync 模式支持 AbortSignal：当 tool call 被取消时（用户中断），向进程发送 SIGTERM 终止。」

---

## 检查维度：错误路径覆盖

| 错误场景 | spec 覆盖 | 评估 |
|---------|----------|------|
| spawn 失败（ENOENT / EACCES） | FR-11 ✅ | 覆盖完整 |
| 非零退出码 | FR-12 ✅ | 覆盖完整（sync throw / bg 标注 FAILED） |
| Job 不存在 | AC-8 ✅ | 覆盖完整（poll + kill 都处理） |
| Shell 不存在 | FR-11 ✅（作为 spawn 失败的子集） | 覆盖 |
| 工作目录不存在 | **未提及** | 缺失（内置 bash 会检查 cwd 存在性并抛错） |
| stdout/stderr pipe 断裂 | **未提及** | 低风险（罕见） |
| sendMessage 注入失败 | MUST FIX #5 已指出 | 需补充 |
| 配置文件损坏（非法 JSON） | **未提及** | 低风险，但应有 graceful fallback |
| 临时文件写入失败（磁盘满） | **未提及** | 低风险 |

**建议补充**：
1. FR-2 补充：「如果 cwd 不存在，throw Error 包含 'Working directory does not exist' 提示（与内置 bash 一致）。」
2. FR-10 补充：「配置文件 JSON 解析失败时使用默认值，不报错。」

---

## 根因分析：核心架构冲突

Issue #1/#2/#3 共享一个根因：**spec 试图同时使用 `BashOperations` API 和直接进程管理，但 `BashOperations` 封装了完整的进程生命周期，不支持「detach 后继续运行」的语义。**

```
内置 bash 执行模型：
  execute() → ops.exec() → spawn → wait → exit → return
                                      ↑ timeout kills here

bash-async 需要的执行模型：
  execute() → spawn → wait OR timeout → [不kill] → detach → return jobId
                       ↑ 需要在这里"放手"但进程继续跑
```

**推荐的整体架构修正**：

1. 不使用 `BashOperations.exec()`，改用 `child_process.spawn` 直接管理
2. 从 Pi 的 `createLocalBashOperations` 源码中提取 shell 发现逻辑（约 30 行），在扩展内自行实现
3. 从 Pi settings 文件直接读取 `shellPath` 和 `commandPrefix`
4. 仍然使用 Pi 导出的 `truncateTail` / `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES` / `formatSize`（这些是纯工具函数，无进程耦合）

这种模式与 subagent 扩展一致——subagent 也使用 `child_process.spawn`（CLAUDE.md 注明的已知例外）。

---

## 结论

**需修改后重审。**

Spec 的业务需求（四种模式、超时 detach、background 执行）是合理且有价值的。但技术方案依赖的 `BashOperations` API 与需求存在根本性的语义冲突——`BashOperations.exec()` 的 timeout 会 kill 进程，而 spec 需要 detach 不 kill。这不是实现细节问题，而是 API 选型问题。

5 条 MUST FIX 中，Issue #1/#2/#3 是同一根因的三面表现，修复方案是统一的：改用 `child_process.spawn` + 自行实现 shell 发现。Issue #4 和 #5 是独立的机制性问题。

### Summary

Spec 评审完成，第1轮，5条 MUST FIX（核心架构与 Pi 公开 API 不兼容），需修改后重审。
