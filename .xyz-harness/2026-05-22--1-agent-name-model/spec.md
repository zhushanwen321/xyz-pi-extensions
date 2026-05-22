---
verdict: pass
---

# Subagent TUI 渲染统一与优化

## Background

当前 subagent extension 的 TUI 渲染（renderCall + renderResult）在不同模式（single/parallel/chain/background）之间存在不一致：header 行格式不统一，运行中缺少实时计时，状态图标混杂 ANSI 颜色和符号，活动流只显示 tool calls 但不显示 text 输出。collect_subagent 工具在 background 自动注入功能已实现后不再需要。

用户需要一次彻底的渲染管线重构，确保所有模式下信息展示格式一致、语义清晰、实时反馈直观。

## Functional Requirements

### F1: 统一 Header 格式（renderCall + renderResult）

所有模式、所有状态（Running / Done / Failed）的 header 必须使用三层结构：

- **Line 1**: `⏳|✅|❌` + 模式名（`single`/`parallel`/`chain`）+ `#` + session ID（前 8 位 UUIDv7）
- **Line 2**: agent name + model 名 + thinking level + 经过时间（Running 时每秒刷新，Done 时固定）
- **Line 3+**: 活动流（tool call + text output，按时间顺序交错排列）

示例 — Running:
```
⏳ single #0196a3b2
  general-purpose  ds-flash/high  3.2s
→ $ grep "pattern" src/
→ read src/a.ts:10-30
  Found 2 matches
```

示例 — Done:
```
✅ single #0196a3b2
  general-purpose  ds-flash/high  5.1s  3 turns ↑1.2k ↓800  $0.012

→ $ npx tsc --noEmit
→ read src/render.ts:45-80
  All type errors fixed.
```

### F2: 实时计时更新

Running 状态的每个 subagent 显示自启动以来的流逝时间，每秒刷新。

- 实现机制：`setInterval(() => context.invalidate(), 1000)`（Pi bash tool 已有成熟模式）
- Running 时 elapsed 显示为 `warning` 色（黄）
- Done 时显示固定耗时，使用 `dim` 色（灰）

### F3: 活动流优化

活动流交错显示 tool call 和 text output：

- **Tool call**：`→` 前缀，使用 `formatToolCall()` 格式化（已存在）
- **Text output**：缩进显示，仅显示前 3 行（配置常数 `TEXT_PREVIEW_LINES = 3`），避免刷屏
- **Thinking 块**：从 JSONL messages 中过滤（`part.type === "thinking"`），不显示
- 展开（expanded）时显示全部 text output（Markdown 渲染）

### F4: 按模式可视化执行顺序

各模式 header 行突出显示执行拓扑：

| 模式 | Header 示例 | 说明 |
|------|------------|------|
| Single | `⏳ single #id` | 单 agent，无顺序信息 |
| Parallel | `⏳ parallel #id  2/4 done, 2 running  8.3s` | 表格展示所有 agent |
| Chain | `⏳ chain #id  1/3 done, 1 running  6.1s` | 编号步骤 + 流转 |

Parallel 模式下，第二行显示共享 model 信息，表格区每行一个 agent。
Chain 模式下，按步骤编号显示，pending 步骤显示 `○`，running 显示 `⏳`，done 显示 `✅`。

### F5: collapsible 联动

- Collapsed（Ctrl+O 前）：精简信息，每个 agent 最后 N 个 display items
- Expanded（Ctrl+O 后）：完整信息，包含 task 描述、所有 tool calls + text、最终 Markdown 输出、usage 统计

各模式的 collapsed 条数配置：

| 模式 | 常量 | 默认值 | 说明 |
|------|------|--------|------|
| Single | `COLLAPSED_ITEM_COUNT` | 10 | 与当前行为一致 |
| Parallel | `COLLAPSED_ITEM_COUNT` | 10 | 展开前显示精简汇总表 |
| Chain | `CHAIN_COLLAPSED_ITEM_COUNT` | 5 | 每步条目数，链式步骤多时避免刷屏 |

### F6: 移除 collect_subagent 工具

Background 模式的结果已经通过 `pi.sendMessage()` 自动注入到聊天中，不再需要手动收集。

移除内容：
- `collect_subagent` 工具的注册代码（`pi.registerTool({name: "collect_subagent", ...})`）
- `SpawnManager` 中的 `getActiveJobs()`、`getJobEvents()`、`getSessionJobFiles()` 方法（如无其他用途）
- 相关的 poll 逻辑、job event 监昕

保留（供扩展或调试用，不暴露为工具）：
- `SpawnManager` 内部的 background job cleanup
- `session_shutdown` 时 cleanup

### F7: renderCall 统一

renderCall 也使用新的 icon + 格式：

```
⏳ single #id
  agent-name  model/thinking  [...]
  task preview
```

### F8: 状态语义化

| 状态 | Icon | Theme Token | ANSI 颜色 |
|------|------|-------------|-----------|
| Running | ⏳ | `warning` | 黄 |
| Succeeded | ✅ | `success` | 绿 |
| Failed | ❌ | `error` | 红 |
| Pending | ○ | `muted` | 灰 |

ICON 通过 theme.fg() 着色，不硬编码 ANSI 颜色码。

## Acceptance Criteria

### AC1: Single 模式
- [ ] renderCall 显示 `⏳ single #id` + agent/model/thinking
- [ ] renderResult Running 时：header 1/2 行 + 活动流，⏳ 黄色，elapsed 每秒刷新
- [ ] renderResult Done 成功：✅ 绿色，固定耗时 + usage 统计
- [ ] renderResult Done 失败：❌ 红色，显示 error message
- [ ] 活动流包含 tool calls 和 text output（filter thinking）
- [ ] Collapsed 显示最后 10 条 display items
- [ ] Expanded 显示完整 detail（Container + Markdown）

### AC2: Parallel 模式
- [ ] renderCall 显示 `⏳ parallel #id (N tasks)` + 任务列表
- [ ] renderResult Running 时：进度 `m/n done, n-m running` + elapsed
- [ ] renderResult Done：`✅ parallel #id  m/n succeeded` + 聚合统计
- [ ] 表格每行：agent 名 + icon + duration + turns + tokens + cost
- [ ] Running 的 agent 行显示 elapsed（实时更新）
- [ ] 展开时所有 agent 以 renderAgentDetail 显示

### AC3: Chain 模式
- [ ] renderCall 显示 `⏳ chain #id (N steps)` + 步骤列表
- [ ] renderResult Running 时：进度 + elapsed，每步独立 header + 活动流
- [ ] Pending 步骤显示 `○`，running 显示 `⏳`，done 显示 `✅`
- [ ] Done：聚合统计
- [ ] 每步最多显示最后 5 个 display items（collapsed）

### AC4: Background 模式
- [ ] renderCall 显示 `⏳ single #id [bg]`，无 onUpdate 流
- [ ] 返回 Job ID 信息文字
- [ ] Background 结果自动注入聊天后，以 Single 模式 renderResult 显示
- [ ] collect_subagent 工具已移除

### AC5: 实时计时
- [ ] Running 状态下 elapsed 每秒更新
- [ ] Done 时 elapsed 固定，不再变化
- [ ] setInterval 在 component unmount / abort 时清理
- [ ] 不触发不必要的 re-render（requestRender coalesce 机制）

### AC6: 移除 collect_subagent
- [ ] `collect_subagent` 工具不存在于注册列表中
- [ ] 后台 job 的 temp files 仍会在 session_shutdown 时 cleanup
- [ ] 不抛出因移除而产生的运行时错误

## Out of Scope

- **不涉及进程管理逻辑改动**：spawn.ts 的进程 spawn/cleanup/abort 逻辑保持不变
- **不涉及模型选择逻辑**：model.ts 的 taskComplexity 路由/fallback 不变
- **不涉及 agent 发现逻辑**：agents.ts 的 frontmatter 解析/目录扫描不变
- **不涉及 pi-tui 组件库**：不使用新组件，仅重构现有 Text/Container/Spacer/Markdown 用法
- **不涉及其他扩展**（goal/todo）：互不影响
- **不涉及 data format 变化**：`SubagentDetails` / `SingleResult` / `AgentResultView` 等类型保持兼容
- **不涉及 api surface 变化**：工具参数、返回结构不变（仅移除 collect_subagent）

## Constraints

| 约束 | 说明 |
|------|------|
| **Theme 约束** | Icon 通过 `theme.fg()` 使用语义 token 着色，禁止硬编码 ANSI |
| **TUI API 约束** | 只能使用 pi-tui 已有组件（Text， Container， Spacer， Markdown） |
| **性能约束** | setInterval(1s) 不引起显著性能问题（diff-render 只改变化行） |
| **Session 隔离** | 渲染状态放在闭包或 context.state 中，不在模块级变量 |
| **向后兼容** | background 的 auto-inject 保持现有格式（SubagentDetails 结构） |
| **Collect 移除范围** | 不删除 `SpawnManager` 中 cleanup 方法，仅移除工具注册和相关测试 |
| **Coding-workflow 约束** | 本 spec 只覆盖 Specification，不覆盖 implementation 细节 |

## Complexity Assessment

**评级：中等（Medium）**

复杂度原因：
1. 渲染逻辑分散在 render.ts（4个render函数 + 多个文本构建函数）
2. 需要同时在 renderCall 和 renderResult 中实现新的 header 结构
3. 实时计时需要理解 context.invalidate() 生命周期
4. 活动流过滤 thinking 需要理解 Message.content 结构
5. 移除 collect_subagent 需要确保不影响 background auto-inject

低复杂度部分：
- 状态图标替换（theme token → emoji）
- header 格式调整
- 移除工具注册代码

建议拆分为以下独立工作单元：
1. render.ts — 重构 header 结构 + 活动流优化
2. render.ts — 实时计时器集成
3. index.ts — 移除 collect_subagent 工具
4. index.ts — renderCall 统一
