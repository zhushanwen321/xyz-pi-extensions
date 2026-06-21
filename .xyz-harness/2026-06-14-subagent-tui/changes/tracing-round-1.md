# Tracing Round 1

> 由独立追踪 subagent（fresh context）产出。主 agent 代写入文件（subagent 为只读模式）。

## 追踪范围
- spec 初稿版本：subagent-tui 增强（FR-1 ~ FR-4 + 4 个 AC）
- 追踪的视角：P1 User Journey（完整）、P2 Data Lifecycle（完整）、P3 API Contract（完整）、P4 State Machine（完整）、P5 Failure Path（完整）

## 降级视角记录

无降级。本需求虽是 TUI/工具类，但涉及数据结构变更（FR-1 eventLog ring buffer）、命令接口（FR-3 `/subagents list`）、状态转换（agent lifecycle running→done/failed），5 视角全部适用。

---

## P1: User Journey

### OP-U01: 开发者运行 subagent 工具，观察 inline widget 滚动消息
- **Actor**: 开发者（在 Pi 对话中）
- **Precondition**: Pi session 已启动（session_start 注入 modelRegistry），UI 可用（hasUI=true）
- **Main Path**:
  1. 开发者（或主 agent）调用 `subagent` 工具 → `SubagentRuntime.runAgent()` 注册 widget（`run-${seq}`）→ status="running" [VERIFIED: runtime.ts:189-197]
  2. SDK 触发 `tool_execution_start` → event-bridge 映射为 `tool_start` → `updateWidgetFromEvent` push 到 eventLog → widget 重渲染 [VERIFIED: event-bridge.ts:39-42, runtime.ts:199-208]
  3. SDK 触发 `tool_execution_end` → `tool_end` push（status=done/failed）[VERIFIED: event-bridge.ts:45-51]
  4. SDK 触发 `turn_end` → turn 计数+1，turn 摘要 push [VERIFIED: event-bridge.ts:59-63]
  5. 完成 → status="done/failed"，5 秒后 `removeAgent` 清理 [VERIFIED: runtime.ts:216-225]

- **Branches**:
  - **B1**: eventLog 超过 MAX_EVENT_LOG_ENTRIES (20)
    - When: agent 执行超过 20 个事件
    - Path: push 后 shift() 移除最旧条目（FIFO ring buffer）[VERIFIED: spec FR-1.2/1.3 设计；runtime.ts 当前未实现]
  - **B2**: widget 行数超 12 行
    - When: eventLog 投影 + status summary > 12 行
    - Path: 省略最旧条目，不显示省略号 [VERIFIED: spec FR-2.3]
    - **[GAP G-001]**: 多个 running agent 并存时如何分配 12 行？spec 未说明。

### OP-U02: 开发者打开 `/subagents list` 全屏视图
- **Main Path**:
  1. 输入 `/subagents list` → 命令 handler → hasUI 守卫 → `ctx.ui.custom()` overlay [VERIFIED: spec FR-3.1/3.6]
  2. Level 0 列表渲染：合并 `_bgRecords` + `widget.agents` [VERIFIED: spec FR-3.2 设计]
  3. j/k 导航 → Enter 进入 Level 1 详情
  4. q/Esc 退出
- **Branches**:
  - **B1**: `/subagents list <id>` id 不存在 → **[GAP G-002]** 未定义错误路径
  - **B2**: 无执行记录 → 显示空状态 [VERIFIED]
  - **B3**: running agent 在视图打开期间完成 → **[GAP G-003 高]**: spec FR-3.4 说"overlay 视图订阅 widget 渲染周期"，但 widget timer 只调 `ui.setWidget`，不触发 overlay 的 `requestRender()`。实时刷新机制未打通。

### OP-U03: 开发者全屏查看详情
- **B1**: background agent 已完成 → **[GAP G-005 严重]**: widget 5 秒淡出后 eventLog 随 removeAgent 丢失。BgRecord 无 eventLog 字段，详情视图数据源缺失。
- **B2**: sync agent 已完成 → **[GAP G-005 同源]**: sync agent 不进 _bgRecords，完成后两个数据源都不持有它。完成的 sync agent 在列表中彻底消失。

---

## P2: Data Lifecycle

### E01: AgentEventLogEntry
- **[GAP G-009 F]**: ts 时间戳来源未定义。AgentEvent 无 timestamp，需在 updateWidgetFromEvent 内 Date.now()。
- **[GAP G-010 F/D]**: label 定义矛盾——FR-1.1 说 "label = toolName"，FR-2.1 示例带文件路径。

### E02: WidgetAgentState 扩展
- **[GAP G-011 F]**: eventLog 初始值未定义（runtime.ts:191-196 创建时未初始化）。
- **[GAP G-012 D]**: 是否归档已完成 agent 的 eventLog？选项 A（扩展 BgRecord）/ B（单独 _completedAgents Map）/ C（接受消失）。

### E03: BgRecord（现有）
- **[GAP G-006 严重 F]**: 无 eventLog 字段。Level 1 详情 "Event log 区域" 对 background agent 无数据源。
- **[GAP G-013 F]**: 无 agent 字段。列表 "Agent" 列数据源缺失（opts.agent 未持久化到 record）。

---

## P3: API Contract

### OP-A01: `/subagents list` 命令
- **[GAP G-014 F]**: 命令解析逻辑——新增 `list` 如何与现有 `/subagents`、`/subagents config` 分支共存。
- **[GAP G-015 F]**: ctx.ui.custom() 的 done() 何时调用未定义。
- **[GAP G-016 F]**: runtime 未初始化时 list 子命令的守卫未定义。
- **[GAP G-017 D]**: 重复输入 `/subagents list` 是否允许叠加多个 overlay？

### OP-A02: overlay 组件契约
- **[GAP G-018 F]**: 组件必须返回 invalidate() 方法 + handleInput 返回 boolean。spec FR-4.1 未提。

---

## P4: State Machine

- **[GAP G-019 F]**: spec 漏了 cancelled 状态（agent-widget.ts:32 有 4 值 union）。cancelled 在列表/详情如何展示？
- **[GAP G-020 D]**: done/failed/cancelled 在全屏列表中的相对排序未定义。

---

## P5: Failure Path

- **[GAP G-021 高 F]**: failed agent 的 eventLog 5s 后丢失（G-005 同源）。UC-3 排查失败场景无法可靠满足。
- **[GAP G-022 D]**: 终端行数过小时全屏视图如何降级？
- **[GAP G-023 高 F]**: background agent 同时在 _bgRecords 和 widget.agents 中（startBackground 调 runAgent 注册 widget）。去重逻辑未定义——列表会重复显示？

---

## Gap 列表（汇总）

| ID | Type | Severity | Question |
|----|------|----------|----------|
| G-001 | D | 中 | 多个 running agent 并存时，12 行如何在 agents 间分配？ |
| G-002 | D | 中 | `/subagents list <id>` 的 id 不存在时如何处理？ |
| G-003 | F | **高** | 全屏视图实时刷新机制未打通——widget timer 不触发 overlay requestRender |
| G-005 | F | **高（阻断）** | widget 5 秒淡出后 eventLog 丢失。已完成 agent 全屏详情无 event log 数据源 |
| G-006 | F | **高（阻断）** | BgRecord 无 eventLog 字段。FR-3.3 Level 1 详情对 background agent 无数据源 |
| G-007 | K | 低 | 用户能否在 widget 阶段取消正在运行的 subagent？ |
| G-008 | K | 低 | widget 是否需要超时兜底？ |
| G-009 | F | 低 | AgentEventLogEntry.ts 时间戳来源未定义 |
| G-010 | F/D | 中 | label 是纯 toolName 还是 toolName+args？FR-1.1 与 FR-2.1 矛盾 |
| G-011 | F | 低 | WidgetAgentState.eventLog 初始值未定义 |
| G-012 | D | **高** | 是否归档已完成 agent 的 eventLog？选项 A/B/C |
| G-013 | F | 中 | BgRecord/BackgroundStatus 无 agent 字段 |
| G-014 | F | 低 | 命令解析逻辑——list 如何与 config 分支共存 |
| G-015 | F | 低 | ctx.ui.custom() done() 何时调用 |
| G-016 | F | 低 | runtime 未初始化时 list 守卫 |
| G-017 | D | 低 | 重复 /subagents list 是否叠加 overlay |
| G-018 | F | 中 | overlay 组件契约缺 invalidate() 和 handleInput 返回值 |
| G-019 | F | 中 | cancelled 状态展示遗漏 |
| G-020 | D | 低 | done/failed/cancelled 相对排序 |
| G-021 | F | **高** | failed agent eventLog 5s 后丢失（G-005 同源） |
| G-022 | D | 低 | 终端过小时降级 |
| G-023 | F | **高** | background agent 数据源重叠，去重未定义 |

---

## 优先级排序

### P0 阻断级
1. **G-005 + G-006 + G-021 + G-012**（同源架构问题）：已完成 agent 的 eventLog 留存。合并为单一决策。
2. **G-023**：background/sync 数据源重叠去重。
3. **G-003**：全屏视图实时刷新机制。

### P1 重要级
4. G-013（agent 字段）、G-010（label 矛盾）、G-019（cancelled 状态）、G-018（组件契约）

### P2 中等 / P3 低
G-001/G-002/G-020/G-007/G-008/G-009/G-011/G-014/G-015/G-016/G-017/G-022

---

## U1/U2 追踪结论

- **U1 (tool_start args)**：F 类。SDK 原始 `tool_execution_start` 带 args（event-bridge.test.ts:11），但 event-bridge.ts:42 丢弃了。需增强 event-bridge 透传 args。
- **U2 (turn_end 文本)**：F 类。`turn_end` 不带文本，但 `text_delta` 事件提供增量文本流。可在 updateWidgetFromEvent 内累加 text_delta，turn_end 时切片生成摘要。
