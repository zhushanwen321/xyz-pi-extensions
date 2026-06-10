---
verdict: pass
---

# Use Cases — Workflow Fullscreen TUI View

## UC-1: 用户监控长跑 workflow 进度

- **Actor**: 开发者
- **Preconditions**: 至少一个 workflow 处于 running/paused 状态
- **Main Flow**:
  1. 用户输入 `/workflows`
  2. 系统弹出 SelectList，列出所有 active+paused workflow（按 startedAt 倒序）
  3. 用户选中目标 workflow
  4. 系统进入全屏视图，显示 header 两行（name + description + elapsed）、sidebar phases 树、main 区当前节点详情
  5. 视图每秒刷新 elapsed time；节点状态变化时实时更新 sidebar ● 颜色和 main 区内容
- **Alternative Paths**:
  - UC-1a: 用户输入 `/workflows <runId-prefix>` → 跳过 SelectList 直接进入视图
  - UC-1b: 无 active workflow → SelectList 为空，notify "No active workflows"
- **Postconditions**: 用户看到实时进度，无需查看 terminal log
- **Module Boundaries**: commands.ts（SelectList）→ orchestrator-events.ts（订阅）→ WorkflowsView.ts（渲染）
- **AC Coverage**: AC-1, AC-2, AC-4, AC-11

## UC-2: 用户中途停止失败 workflow

- **Actor**: 开发者
- **Preconditions**: 全屏视图已打开，workflow 状态为 running
- **Main Flow**:
  1. 用户按 `x`
  2. 系统弹出 confirm dialog "Stop this workflow?"
  3. 用户确认
  4. orchestrator.abort(runId) 触发
  5. 视图实时显示节点状态变为 aborted
- **Alternative Paths**:
  - UC-2a: workflow 已 terminal → 按 `x` 直接 notify "Workflow already <status>"，不弹 dialog
  - UC-2b: 用户取消 confirm → 回到视图，无操作
- **Postconditions**: workflow 状态变为 aborted，不再消耗 token
- **Module Boundaries**: WorkflowsView.ts（按键）→ orchestrator.ts（abort）
- **AC Coverage**: AC-17, AC-18

## UC-3: 用户排查失败节点

- **Actor**: 开发者
- **Preconditions**: 全屏视图已打开，workflow 有 failed 节点
- **Main Flow**:
  1. 用户按 `↓` 在 sidebar 中导航到 failed 节点
  2. main 区显示该节点详情：状态行（● Failed · model）、统计行、Activity 结构化列表
  3. Activity 区域显示 `ToolName(argsPreview)` 格式的工具调用列表
  4. 用户定位失败原因
- **Alternative Paths**:
  - UC-3a: 用户按 `👉` 展开 prompt section 查看完整 task prompt
  - UC-3b: 节点仍在 running → Outcome 显示 "Still running..."
- **Postconditions**: 用户理解失败原因
- **Module Boundaries**: WorkflowsView.ts（导航 + 渲染）← agent-pool.ts（toolCalls 数据）
- **AC Coverage**: AC-8, AC-9, AC-11, AC-12, AC-13, AC-14

## UC-4: 用户保存 workflow trace

- **Actor**: 开发者
- **Preconditions**: 全屏视图已打开
- **Main Flow**:
  1. 用户按 `s`
  2. 系统将当前 workflow 的 trace 序列化为 markdown
  3. 写入 `~/.pi/agent/workflow-traces/<runId>.md`
  4. notify 文件路径
- **Postconditions**: trace 文件持久化到磁盘
- **Module Boundaries**: WorkflowsView.ts（按键）→ fs 写入
- **AC Coverage**: AC-19

## UC-5: 用户重启 workflow

- **Actor**: 开发者
- **Preconditions**: 全屏视图已打开，sidebar 选中具体 agent 节点
- **Main Flow**:
  1. 用户按 `r`（仅节点详情视图 footer 可见）
  2. 系统弹出 confirm dialog "Restart from scratch?"
  3. 用户确认
  4. orchestrator.run(name, args, tokens, timeMs) 触发
  5. notify 新 runId
- **Alternative Paths**:
  - UC-5a: 概览视图（无 agent 选中）→ footer 无 `r` 键，无法触发
- **Postconditions**: 新 workflow 启动，旧 workflow 状态不变
- **Module Boundaries**: WorkflowsView.ts（按键）→ orchestrator.ts（run）
- **AC Coverage**: AC-20

## AC 覆盖映射表

| UC | AC 覆盖 |
|----|---------|
| UC-1 | AC-1, AC-2, AC-4, AC-11 |
| UC-2 | AC-17, AC-18 |
| UC-3 | AC-8, AC-9, AC-11, AC-12, AC-13, AC-14 |
| UC-4 | AC-19 |
| UC-5 | AC-20 |
| — | AC-3 (esc 关闭), AC-5 (sidebar 格式), AC-6 (双栏布局), AC-7 (no phase 组), AC-10 (context title), AC-15 (subscribe), AC-16 (tick 清理), AC-21 (widget 删除), AC-22 (shortcut 删除), AC-23 (toolCalls 类型), AC-24 (80×24 不溢出) |
