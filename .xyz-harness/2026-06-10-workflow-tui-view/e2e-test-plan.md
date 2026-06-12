---
verdict: pass
---

# E2E Test Plan — Workflow Fullscreen TUI View

## Test Scenarios

### TS-1: 命令入口（FR-1）

**覆盖 AC:** AC-1, AC-2, AC-3

1. 输入 `/workflows`，确认弹出 SelectList 且包含 ≥1 个 running workflow
2. 输入 `/workflows <valid-runId-prefix>`，确认直接进入全屏视图，不弹 SelectList
3. 全屏视图打开后按 esc，确认回到 Pi 主交互界面

### TS-2: 视图布局（FR-2）

**覆盖 AC:** AC-4, AC-5, AC-6, AC-10, AC-24

1. 打开视图，确认 header 两行：第 1 行粗体 name，第 2 行 description + 右对齐 `N/M agents · elapsed`
2. 确认 sidebar 固定 24 列，phase 标题行格式 `<序号> <phaseName> <completed>/<total>`
3. 确认双栏中间有 `│` 拼接
4. 确认 main 顶部 context title 显示 `<phaseName> · N agent`
5. 在 80×24 终端验证不溢出

### TS-3: Phases 树导航（FR-3）

**覆盖 AC:** AC-7, AC-8, AC-9

1. 确认无 phase 字段的节点归入 "(no phase)" 组
2. 按 `↓`，确认 sidebar 选中下一个节点，main 区更新
3. 确认节点行 `❯ ● <agentName> <model>`，● 颜色正确（pending 灰 / running 高亮 / completed 绿 / failed 红）

### TS-4: 节点详情（FR-4）

**覆盖 AC:** AC-11, AC-12, AC-13, AC-14

1. 选中 running 节点，确认统计行 `N tok · M tool calls` 随运行递增
2. 确认 prompt > 20 行时折叠，显示 `… N more lines`（U+2026）
3. 确认 Activity 显示结构化列表 `Skill(code-review)`、`Bash(git diff ...)` 格式
4. 按 `👉`，确认 prompt 展开；再按 `👉`，确认折叠

### TS-5: 控制动作（FR-6）

**覆盖 AC:** AC-17, AC-18, AC-19, AC-20

1. running workflow 按 `x`，确认弹 confirm → 确认 → abort 触发
2. terminal workflow 按 `x`，确认 notify 不弹 dialog
3. 按 `s`，确认 trace 保存到文件，notify 显示路径
4. 确认概览 footer 无 `r restart`/`👉`；节点详情 footer 有

### TS-6: 订阅生命周期（FR-5）

**覆盖 AC:** AC-15, AC-16

1. 打开视图，确认 subscribe 调用；关闭视图，确认 unsubscribe 触发
2. 关闭所有视图后，确认 orchestrator 内部无活跃 setInterval

### TS-7: 删除验证（FR-8）

**覆盖 AC:** AC-21, AC-22

1. `grep -rn "renderWorkflowDetail" extensions/workflow/src/` → 无结果
2. `grep -rn "registerShortcut.*ctrl+shift[p|x|r]" extensions/workflow/src/` → 无结果

## Test Environment

- Pi coding agent 运行中（TUI 模式，非 RPC）
- 至少一个 workflow 处于 running 状态
- 终端尺寸 ≥ 80×24
- 测试由人工手动执行（TUI 交互无法自动化）

## Manual Test Checklist

由于 Pi TUI 全屏视图无法通过 vitest 做端到端自动化测试，以下用 checklist 形式：

- [ ] `/workflows` → SelectList → 选中 → 全屏视图打开
- [ ] Header 两行正确
- [ ] Sidebar 24 列，phase 分组正确
- [ ] `↑↓` 导航正常，main 区实时更新
- [ ] ● 颜色 pending/running/completed/failed 正确
- [ ] 统计行 tok · tool calls 实时递增
- [ ] Activity 显示 ToolName(args) 格式
- [ ] `👉` 展开/折叠 prompt
- [ ] `x` abort（running + terminal 两种情况）
- [ ] `s` save trace to file
- [ ] `r` restart（仅节点详情视图）
- [ ] `esc` 关闭视图
- [ ] 80×24 终端不溢出
