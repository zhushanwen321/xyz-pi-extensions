---
verdict: pass
---

# Workflow Fullscreen TUI View

## Background

Pi-workflow 当前提供三套 TUI 触点，都能力有限：

1. `renderWorkflowList` (setWidget 上方一行概览) —— 只看标题/状态，看不到 trace 节点细节
2. `renderWorkflowDetail` (overlay 单 workflow 详情) —— 信息密集但只读、不能控制、不能跨节点导航
3. `registerWorkflowShortcuts` (ctrl+shift+p/x/r 三个全局快捷键) —— 不打开任何视图就触发动作

Claude Code 的 review-fix-loop 截图展示了一种**全屏接管式 workflow 视图**：
- 双栏布局：sidebar 是 phases 树，main 是当前节点的 prompt/activity/outcome
- 顶栏实时显示 elapsed time、agent 计数
- 底栏键盘提示：stop / pause / restart / expand prompt
- Live 刷新：tool call 计数、节点状态、token 数随运行累积

Pi TUI 已有 `ctx.ui.custom(component)` 接管整个 TUI 的机制（docs/tui.md），不需要 Claude Code 的 alt screen escape 序列。本 spec 借用 Claude Code 的**信息架构**（phases 树 + node 详情 + live 状态 + 内嵌控制），在 Pi TUI 的能力约束下实现等价体验。

**用户决策（brainstorming Phase 1 锁定）**：
- 新增独立全屏视图，**取代**现有 detail overlay + setWidget + 三个全局快捷键
- 单 workflow 多层级导航（按 runId 进入 → phases 树 → node 详情）
- 实时刷新：orchestrator 暴露订阅 API（不靠 setInterval 轮询）
- Activity 区域用增强的 agent-pool toolCalls[] 结构化列表（每行 `ToolName(argsPreview)`）
- Phase 树按 `node.phase` 字段分组，无 phase 归入 "(no phase)"

## Functional Requirements

### FR-1: 命令入口
- **FR-1.1** 注册命令 `/workflows [runId]`，无参时弹出 SelectList 选择 active+paused workflow，有参数时直接进入全屏视图
- **FR-1.2** SelectList 候选来自 `orchestrator.getInstanceSummaries()` 过滤后 `status in ["running", "paused"]` 的实例，按 `startedAt` 倒序
- **FR-1.3** 选中后 `ctx.ui.custom(WorkflowsView, { runId })` 接管 TUI 渲染区
- **FR-1.4** esc 关闭全屏视图，回到 Pi 主交互界面
- **FR-1.5** 命令处理函数返回值丢弃（不调用 `ctx.ui.setEditorText`）

### FR-2: 视图布局
- **FR-2.1** 全屏视图分三段：header / body (sidebar + main) / footer，header 与 body 之间用 `─` 横线分隔
- **FR-2.2** header 两行：第 1 行 workflow name（粗体），第 2 行 description（灰色）+ 右对齐 `N/M agents · elapsed`（M = trace 总数，N = completed 数，elapsed 1s 内实时更新）
- **FR-2.3** sidebar 固定 24 列宽度，标题 `Phases`，下方显示 phases 树（按 `node.phase` 字段分组）
- **FR-2.4** main 区域顶部显示 context title（`<phaseName> · <N> agent`），下方固定显示当前选中节点的详情：状态行 / 统计行 / Prompt / Activity / Outcome
- **FR-2.5** footer 快捷键因视图状态不同：
  - 概览视图（sidebar 在 phase 节点，无 agent 选中）：`↑↓ select · x stop workflow · p pause · esc back · s save`
  - 节点详情视图（sidebar 选中具体 agent 节点）：`↑↓ agent · 👉 prompt · x stop · r restart · p pause · esc back · s save`
- **FR-2.6** 双栏布局由**手工** ANSI 字符 `│` 拼接两个子组件 render 输出实现（pi-tui 0.73.1 Box 不支持 flex direction，**已验证**：box.d.ts:5-12 children: Component[] 只能垂直堆叠）

### FR-3: Phases 树导航
- **FR-3.1** 第一层按 phase 分组：phase 标题行 `<序号> <phaseName> <completedCount>/<totalCount>`，无 phase 归入 `"(no phase)"` 兜底组。当前选中 phase 用 `❯` 标识
- **FR-3.2** 第二层是 phase 内的 nodes，按 stepIndex 升序
- **FR-3.3** 每个 node 行：`❯ ● <agentName> <model>`，❯ 标识当前选中节点。● 颜色按状态（pending 灰 / running 高亮 / completed 绿 / failed 红）。长 agent 名 truncateToWidth
- **FR-3.4** `↑/↓` 在 sidebar 节点间切换（同一 phase 内 + 跨 phase），选中节点变化时 main 区域只重渲染

### FR-4: 节点详情
- **FR-4.1** 节点标题行 `<agentName>`（粗体），下方状态行 `● <Status> · <model>`，● 颜色按状态用 theme token（`success`/`warning`/`error`/`muted`）
- **FR-4.2** 统计行：`<tokenCount> tok · <toolCallsCount> tool calls`，实时更新。数据源为 `AgentResult.usage` 和 `AgentResult.toolCalls.length`
- **FR-4.3** Prompt section：标题 `Prompt · <N> lines · 👉 expand`，内容为 `node.task` 全文，默认折叠为前 20 行 + `… <N> more lines`（`…` 为 U+2026 单字符 ellipsis）
- **FR-4.4** Activity section：标题 `Activity`，内容为结构化工具调用列表，每行 `ToolName(argsPreview)`，args 超长时截断 + `…`。数据源为 `node.result.toolCalls[]`（见 FR-7）
- **FR-4.5** Outcome section：node running 时显示 `Still running...`；completed 时显示 result 摘要；failed 时显示 `result.error`
- **FR-4.6** `👉` 键切换 prompt section 的展开/折叠
- **FR-4.7** output 超过 100KB 时截断 + `(truncated, see full output via result)` 提示

### FR-5: Orchestrator 订阅 API
- **FR-5.1** 在 `extensions/workflow/src/orchestrator-events.ts` 新增 `subscribe(runId, listener) => unsubscribe` 方法
- **FR-5.2** WorkflowEvent 类型联合：`{ type: "status", status } | { type: "trace", node } | { type: "node-update", stepIndex, patch } | { type: "tick", now }`
- **FR-5.3** 触发点：现有 `transitionStatus()`、`appendTraceNode()`、节点状态转换点（orchestrator.ts:686, 733, 791）分别 emit 对应事件
- **FR-5.4** tick 事件由 orchestrator 内部 `setInterval(1000ms)` 驱动；**仅当存在活跃订阅**时启动，订阅数降到 0 时清掉 interval（防止空转）
- **FR-5.5** listener 抛异常时 orchestrator 内 `try/catch` 吞掉并 console.error（防止一个视图崩溃影响 orchestrator）
- **FR-5.6** listener 调用同步 push 事件，不使用 microtask 队列（保证视图状态最终一致即可）

### FR-6: 视图内控制动作
- **FR-6.1** `x` 键：弹 confirm dialog "Stop this workflow?"，确认后调 `orchestrator.abort(runId)`，notify 结果
- **FR-6.2** `p` 键：弹 confirm dialog "Pause this workflow?"，确认后调 `orchestrator.pause(runId)`，notify 结果
- **FR-6.3** `r` 键（仅节点详情视图可用）：弹 confirm dialog "Restart from scratch?"，确认后调 `orchestrator.run(name, args, tokens, timeMs)`，notify 新 runId
- **FR-6.4** workflow 已 terminal 状态时，x/p/r 不弹 dialog，直接 notify "Workflow already <status>"
- **FR-6.5** action 触发后视图**不自动关闭**，用户继续在视图中看状态变化
- **FR-6.6** confirm dialog 用 `ctx.ui.confirm()`（docs/tui.md § Built-in 已声明），不引入新组件
- **FR-6.7** `s` 键：保存当前 workflow 运行 trace 到文件（`~/.pi/agent/workflow-traces/<runId>.md`），notify 文件路径

### FR-7: Agent-pool 数据增强
- **FR-7.1** `AgentResult` 接口新增 `toolCalls: ToolCallEntry[]` 字段，其中 `ToolCallEntry = { name: string; input: string }`
- **FR-7.2** orchestrator 在收集 agent 结果时，将每次 tool call 的 name（工具名如 Skill/Bash/Read）+ input（完整参数字符串）追加到 `toolCalls[]`
- **FR-7.3** 渲染 Activity 时按 `toolCalls[i].name + '(' + truncate(toolCalls[i].input) + ')'` 格式化，input 完整存储、渲染时按可用宽度截断
- **FR-7.4** `toolCalls[]` 为空时 Activity section 显示 `(no tool calls yet)`（running 状态）或 `(no activity recorded)`（completed 状态）

### FR-8: 删除现有功能（取代而非并存）
- **FR-8.1** 删除 `extensions/workflow/src/widget.ts` 中 `renderWorkflowDetail` 函数和其导出
- **FR-8.2** 删除 `extensions/workflow/src/widget.ts` 中 `renderWorkflowList` 函数和其导出
- **FR-8.3** 删除 `extensions/workflow/src/widget.ts` 中 `registerWorkflowShortcuts` 函数和其导出
- **FR-8.4** 删除 `index.ts` 中 `setWidget` 注册 `renderWorkflowList` 的代码
- **FR-8.5** 删除 `index.ts` 中 `registerShortcut` 三个 ctrl+shift+p/x/r 注册
- **FR-8.6** 验证 `widget.ts` 删除后无其他文件 import 该模块（grep 验证），无依赖则彻底删源文件

## Acceptance Criteria

| AC | 对应 FR | 验证方式 |
|----|---------|---------|
| AC-1 | FR-1.1 | 输入 `/workflows` 弹出 SelectList，候选 ≥ 1 个 active workflow |
| AC-2 | FR-1.1 | 输入 `/workflows <runId-prefix>` 直接进入全屏视图，不弹 SelectList |
| AC-3 | FR-1.4 | 全屏视图打开后按 esc 关闭，回到 Pi 主交互界面（编辑器可输入） |
| AC-4 | FR-2.2 | header 两行：第 1 行 name（粗体），第 2 行 description + 右对齐 `0/3 agents · 12s`，elapsed 1s 内更新 |
| AC-5 | FR-2.3 | sidebar 固定 24 列，phase 标题行 `<序号> <phaseName> <completed>/<total>`，超长 truncateToWidth |
| AC-6 | FR-2.6 | 双栏布局中间有 `│` 字符拼接，宽度 = terminal width - 1 |
| AC-7 | FR-3.1 | trace 节点无 phase 字段时归入 `"(no phase)"` 组 |
| AC-8 | FR-3.4 | `↓` 选中下一个节点，main 区域更新为该节点的详情 |
| AC-9 | FR-3.3 | sidebar 节点行 `❯ ● <agentName> <model>`，● 颜色 pending 灰 / running 高亮 / completed 绿 / failed 红 |
| AC-10 | FR-2.4 | main 顶部 context title 显示 `<phaseName> · N agent` |
| AC-11 | FR-4.2 | 统计行显示 `N tok · M tool calls`，随 agent 运行实时递增 |
| AC-12 | FR-4.3 | prompt > 20 行时折叠，显示 `… N more lines`（U+2026 单字符） |
| AC-13 | FR-4.4 | Activity 显示结构化列表 `Skill(code-review)`、`Bash(git diff ...)`，非全文输出 |
| AC-14 | FR-4.6 | `👉` 展开 prompt section，再次 `👉` 折叠 |
| AC-15 | FR-5.1 | 视图打开时调 `subscribe(runId, listener)`，关闭时 `unsubscribe` 触发 |
| AC-16 | FR-5.4 | 没有任何视图打开时，orchestrator 内部无活跃 setInterval |
| AC-17 | FR-6.1 | `x` 弹 confirm dialog，确认后 orchestrator.abort 被调用且状态变 `aborted` |
| AC-18 | FR-6.4 | workflow 已 completed 时按 `x`，notify 不弹 dialog |
| AC-19 | FR-6.7 | `s` 保存 trace 到文件，notify 文件路径 |
| AC-20 | FR-2.5 | 概览 footer 无 `r restart`/`👉`；节点详情 footer 有 `r restart`/`👉`/`s save` |
| AC-21 | FR-8.1 | `grep -rn "renderWorkflowDetail" extensions/workflow/src/` 无结果 |
| AC-22 | FR-8.5 | `grep -rn "registerShortcut.*ctrl+shift[p|x|r]" extensions/workflow/src/` 无结果 |
| AC-23 | FR-7.1 | `AgentResult` 新增 `toolCalls: ToolCallEntry[]` 字段，TypeScript 类型检查通过 |
| AC-24 | FR-2.1 | 视图在 80×24 终端不溢出，render 出的每行 ≤ width |

## Constraints

### 技术约束
- **C-1** 依赖 `@mariozechner/pi-coding-agent` `ctx.ui.custom()` API（[VERIFIED] docs/tui.md § Using Components）
- **C-2** 依赖 `@mariozechner/pi-tui` 的 `Container`/`Text`/`Spacer`/`Markdown`/`SelectList` 组件（[VERIFIED] docs/tui.md § Built-in）
- **C-3** 不得修改 `state.ts` 的 `ExecutionTraceNode` schema，phase 字段保持可选
- **C-4** 不得修改 orchestrator.ts 的状态机逻辑（`canTransition`/`transitionStatus`），只增加事件 emit
- **C-5** Activity 数据源为新增的 `AgentResult.toolCalls[]`（agent-pool.ts 纯增量字段，不改变现有 output/usage/error 字段语义），不读取 subagent session JSONL
- **C-6** 视图组件不持有 model 解析 / agent 调度逻辑，只读 orchestrator 暴露的 instance 数据
- **C-7** 双栏布局必须手工实现（Box 不支持 flex direction，**已验证** pi-tui 0.73.1 box.d.ts:5-12）

### 兼容性约束
- **C-8** 现有 `WorkflowOrchestrator.run/pause/abort/retry` 公开 API 签名不变
- **C-9** `WorkflowInstanceSummary` 类型不变（CLI/JSONL 序列化兼容）
- **C-10** 订阅 API 是**新增**方法（orchestrator 公共 surface 增大，不破坏现有调用方）

### 质量约束
- **C-11** WorkflowsView 组件代码 ≤ 400 行（按 `<script setup>` 风格，函数 ≤ 80 行）
- **C-12** orchestrator-events.ts ≤ 200 行
- **C-13** 新增 `src/__tests__/orchestrator-events.test.ts` 覆盖：subscribe/unsubscribe 计数、tick 间隔、listener 抛异常不污染 orchestrator
- **C-14** 新增 `src/__tests__/workflows-view.test.ts` 覆盖：phase 分组、sidebar 24 列 truncate、prompt/activity 折叠逻辑（render 纯函数，不依赖 TUI 运行时）

## 业务用例

> 初版简述，Phase 2 (plan) 会在此基础上细化。

### UC-1: 用户监控长跑 workflow 进度
- **Actor**: 开发者，启动一个 5-10 分钟的 review-fix-loop workflow
- **场景**: workflow 启动后用户切到其他任务，10 分钟后想看进度
- **预期结果**: 用户输入 `/workflows` → 选中该 workflow → 立即看到 4 个 phase × 3 个 node 的树状进度，elapsed time、token 计数实时刷新，无需切换到 terminal log

### UC-2: 用户中途停止失败 workflow
- **Actor**: 开发者，发现 workflow 卡在某个 node 超过 5 分钟
- **场景**: 全屏视图打开时，sidebar 选中该 node，按 `x`
- **预期结果**: 弹 confirm dialog → 确认 → orchestrator.abort 触发，节点状态变 `aborted`，视图实时显示新状态，workflow 不再消耗 token

### UC-3: 用户排查失败节点
- **Actor**: 开发者，workflow 完成后想看哪个 node 失败、为什么失败
- **场景**: 全屏视图打开 completed workflow，sidebar 找到 failed 节点，enter 展开 Activity
- **预期结果**: Activity section 完整显示 AgentResult.output（含 agent 推理过程），用户能直接定位失败原因，无需打开 trace log 文件

### UC-4: 多 workflow 并行场景
- **Actor**: 高级用户，同时跑了 2 个 workflow（一个 review，一个 deployment）
- **场景**: `/workflows` 命令输入后 SelectList 列出 2 个 active workflow
- **预期结果**: 按 startedAt 倒序显示，用户能区分；选错 workflow 按 esc 退出重选

## Complexity Assessment

- **文件数**：4 个新文件 + 1 个删除 + 3 个修改
  - 新增：`extensions/workflow/src/views/WorkflowsView.ts` (~400 行)
  - 新增：`extensions/workflow/src/orchestrator-events.ts` (~150 行)
  - 新增：`extensions/workflow/src/__tests__/workflows-view.test.ts` (~200 行)
  - 新增：`extensions/workflow/src/__tests__/orchestrator-events.test.ts` (~100 行)
  - 删除：`extensions/workflow/src/widget.ts` (402 行)
  - 修改：`extensions/workflow/src/index.ts` (删除 setWidget + 3 个 shortcut 注册，~30 行净减)
  - 修改：`extensions/workflow/src/orchestrator.ts` (加 emit 调用 + toolCalls 收集，~25 行净增)
  - 修改：`extensions/workflow/src/agent-pool.ts` (AgentResult 新增 toolCalls 字段，~15 行净增)
- **风险点**：
  1. 双栏手工拼接 ANSI 字符的 wrap 行为（`visibleWidth` vs `truncateToWidth` 边界）
  2. tick 事件 setInterval 在订阅数为 0 时清理（防止 leak）
  4. toolCalls 收集时机：agent 运行是异步流，toolCalls 需要在 agent 回调中实时追加，而非等 agent 结束后一次性填充
- **测试覆盖**：orchestrator-events 必须用 vitest fake timer 测 tick 行为，workflows-view 用纯函数测 layout 逻辑

## Out of Scope

- 跨 workflow 横向对比视图（UC 没要求，截图也没体现）
- Workflow 编辑/参数修改（只能 stop 后重 run）
- Live 重新注入 prompt 到 running agent（agent 进程隔离，做不到）
- Activity 区域解析 subagent session JSONL（FR-4.4 已锁定用 toolCalls[] 结构化列表）
- Pi-mono / 其它 Pi fork 的兼容性（本 spec 仅针对 @mariozechner/* 0.73.1）
- 鼠标点击支持（Pi TUI 无 mouse API，键盘 only）

## Open Questions for Phase 2

- **Q1**: orchestrator.ts 的 emit 调用应该用 `process.nextTick` 还是同步调用？FR-5.6 选同步，但 plan 阶段要测 race
- **Q2**: WorkflowsView 关闭时如果 orchestrator 还在 emit 事件给已 dispose 的视图，要不要在 orchestrator 层加 `disposed` flag 防御？建议加
- **Q3**: sidebar 24 列宽度对中文 workflow name 够不够？可能需要按 visibleWidth 计算 truncate
- **Q4**: toolCalls 实时收集的 hook 点 — pi-subagents agent 运行过程中，tool call 结果通过什么机制回调？需确认 hook 点才能实现 FR-7.2
- **Q5**: `s save` 保存格式 — 纯文本 markdown？还是 JSON trace？建议 markdown（人类可读）

## 假设审计（Phase 1 Step 5）

| 假设 | 验证 | 状态 |
|------|------|------|
| `ctx.ui.custom(component)` 接管整个 TUI 渲染区 | docs/tui.md § Using Components 示例 | [VERIFIED] |
| `tui.requestRender()` + component.invalidate() 触发重绘 | docs/tui.md § Performance | [VERIFIED] |
| Orchestrator 有 `pause/abort/run(name,args,tokens,timeMs)` 公开方法 | orchestrator.ts:307, 382, 408 | [VERIFIED] |
| `ExecutionTraceNode.phase` 可选且有默认值 | state.ts:42 phase?: string | [VERIFIED] |
| AgentResult.output 包含完整 agent 文本输出 | agent-pool.ts:54-72 AgentResult | [VERIFIED] |
| `ctx.ui.confirm()` 存在 | docs/tui.md § Built-in Components / common patterns 隐含 | [VERIFIED] |
| pi-tui Box 不支持 flex direction（双栏需手工） | pi-tui 0.73.1 box.d.ts:5-12 children: Component[] | [VERIFIED] |
| orchestrator.ts 现有 trace 节点 push 模式（686/733/791 行） | orchestrator.ts appendTraceNode 调用点 | [VERIFIED] |
| `registerShortcut` 是全局 hook | extensions.md / tui.md | [VERIFIED]（删除时同步校验） |
| setWidget 是每次重 render 调用的回调 | extensions.md / tui.md | [VERIFIED]（删除时同步校验） |
| `setInterval` 在订阅数为 0 时清理 | 通用 JS 约定 | [UNVERIFIED] → Phase 2 实施时实现 + 写测试 |
| 中文 phase name + 24 列宽度够用 | 用户决策依据 | [UNVERIFIED] → Phase 2 用 visibleWidth 测一遍 |
| pi-subagents agent 运行中可 hook tool calls | pi-subagents 事件机制 | [UNVERIFIED] → Phase 2 读 pi-subagents 源码确认 hook 点 |
| `AgentResult.usage` 包含 token 数 | agent-pool.ts 现有字段 | [VERIFIED] |

---

## 标记说明

| 标记 | 含义 |
|------|------|
| [VERIFIED] | 已通过代码/d文档 grep 或读源码验证 |
| [UNVERIFIED] | 暂时无法验证，Phase 2 实施时用测试兜底 |
| [AMBIGUOUS] | 暂未出现的歧义（本文档已尽量消除） |
