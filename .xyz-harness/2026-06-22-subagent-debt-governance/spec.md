# subagents 技术债治理规格说明

## 背景

`extensions/subagents` 总代码量约 10800 行（core 2089 / runtime 1753 / tools 584 / tui 1956 / types 408 / 其余 index 等）。代码审查发现三类问题：

1. **过度抽象**：EventBridge 翻译了几乎相同的事件结构、RecordStore 三 Map 迁移、session-factory 四步碎片化
2. **伪需求**：三层模型解析的中间层、概率性 GC、BgNotifier 滑动窗口合并
3. **意图偏移**：分层初衷是可测性但 duck-typed 接口反而翻倍代码量、list-view 从简单列表变成 700 行 TUI 应用

## 治理目标

| 指标 | 当前 | 目标 |
|------|------|------|
| 总代码行数 | ~10800 | ~7500（-30%） |
| core 层文件数 | 10 | 7 |
| runtime 层文件数 | 7 | 5 |
| duck-typed 接口数 | 8 | 3 |
| 最大单文件行数 | 468 (subagent-actions.ts) | < 400 |

## 约束

- **功能不变**：所有 wave 完成后行为完全一致（tool schema、renderResult、TUI 渲染、history 持久化）
- **不改 types.ts 的公共接口**：`SubagentToolResult`、`ExecutionHandle`、`ExecuteOptions` 等对外契约不动
- **不改 index.ts 的注册逻辑**：tool 注册、event handler、command 不动
- **每 wave 可独立验证**：`pnpm --filter @zhushanwen/pi-subagents typecheck && pnpm --filter @zhushanwen/pi-subagents test` 通过

## 实现偏差说明

上述约束在后续 ExecutionRecord 收口架构重构中被突破。此重构把分散的执行数据
（eventLog 切片 / _currentTurnText 缓冲 / 闭包累积器 / session.messages）收口进
`ExecutionRecord.turns: Turn[]` 单一数据源。下列偏差经架构合理性论证后采纳：

### D-1: `AgentEventLogEntry.type` 移除 `text_output` / `thinking`

**约束突破**：master spec AC-STATE #4 要求「eventLog 在 background 路径完整
（text_output/thinking 条目不丢失——修复 updateRecordEventLog 的 sink reset bug）」。

**偏差理由**：text_output/thinking 原本是 100 字切片的碎片副产物（含残余尾巴 bug：
compact view 显示 `text: }` 尾巴而非开头）。收口后完整内容存于
`record.turns[].text` / `.thinking`（流式累积完整文本，非切片），
由 `getCurrentActivity()` / `getFullText()` 派生消费。eventLog 退化为只承载离散语义事件
（tool 调用 / turn 边界 / error），不再存储流式文本碎片——从根上消灭残余尾巴 bug。

**行为变化**：`SubagentToolDetails.eventLog` / `SubagentRecord.eventLog` 不再包含
text_output/thinking 条目。需要流式文本的消费方改读 `currentActivity.label`（running 态）
或 `result`（终态）。

### D-2: `SyncResponse` 保留为字面量 `mode:"sync"` 子类型

**设计**：原 `SyncResponse` 是独立 interface（`mode: "sync"` 字面量）。重构一度把它
合并为 `type SyncResponse = SubagentToolDetails`（mode 宽化为 ExecutionMode），
code-review 后恢复为 `interface extends SubagentToolDetails { mode: "sync" }`——
既消除 liftSync 字段搬运（结构兼容，直接 return），又保留 mode 字面量收窄的
类型安全性（TS 在 adapter 层静态保证 syncResponse 只能来自 sync 路径）。

**行为变化**：无运行时行为变化（sync 路径投影 mode 必为 "sync"）。

### D-3: `RecordSnapshot` 移除 `eventLog` 字段

**约束突破**：RecordSnapshot 原含 `eventLog: AgentEventLogEntry[]`。

**偏差理由**：snapshot 的消费点（cancel 判 mode/status、hasRunning 判 mode、
toNotifyRecord 取 result/error）均不读 eventLog。需要 eventLog 的场景用 `project()`
投影的 SubagentToolDetails。eventLog 是派生视图（每次现算），不应冗余存于快照。

**行为变化**：`RecordSnapshot.eventLog` 字段移除。TUI list 视图改从 SubagentRecord
（合并自四源，仍含 eventLog）读取 eventLog。

### D-4: `ExecutionRecord` 数据模型重构（turns[] 替代分散存储）

**约束突破**：ExecutionRecord 原有 eventLog/_currentTurnText/_currentThinking 等字段。

**偏差理由**：消灭结构性数据发散——text 原有 3 份并行副本（session.messages /
_currentTurnText 切片 / eventLog 碎片），eventLog 副本是劣化的（100 字切片 + 残余尾巴 +
ring buffer 淘汰头部）。收口为 `turns: Turn[]` 后：

- `eventLog` / `currentActivity` / `result` 文本均从 turns[] 派生（getEventLog /
  getCurrentActivity / getFullText），不再独立存储切片或缓冲
- session-runner 闭包的 5 个旁路累积器（turnCount/toolCalls/usage/lastError/pendingTools）
  收口进 record（仅 pendingTools 保留——SDK 契约补全层，非结果数据）
- result.text 源从 `collectResponseText(session.messages)` 改为 `getFullText(record)`
  聚合 turns[].text

**新增类型**：`Turn`（一个 turn 的完整内容）、`InternalToolCall`（ToolCall + _status
进行中标记 + startedTs，仅 Core 内部，跨边界导出由 getAllToolCalls strip）。

### D-5: `AgentUsageTotal` 增加 `cost` 字段

**约束突破**：AgentUsageTotal 原 4 字段 + total（无 cost）。

**偏差理由**：旧 toUsageTotal/session-runner 累积 cost 但 AgentUsageTotal 类型未声明，
类型与运行时不一致。重构后显式声明 cost 字段，getTotalUsage 累加 turns[].usageDelta.cost
（来自 SdkEvent.message.usage.cost.total，message_end 时拍平传入）。

### D-6: `BgNotifier` 滑动窗口保留（偏离 plan W5）

**plan 目标**：plan Wave 5 计划砍掉 `BgNotifier` 的滑动窗口合并，改为直接 `sendMessage`——
删除 `pending` 队列、`dedup` Map、`timer`。理由是「用户几乎不会同时启动多个 background
subagent 让它们同时完成」，合并窗口（plan 当时写 2000ms）让通知不及时。

**采纳偏差（保留滑动窗口）**：经评估决定**保留** `BgNotifier` 的滑动窗口架构
（`pending[]` + `dedup` Map + timer）。理由：

1. **批量合并是真实价值**：workflow 场景（如 `evolve`、`review-gate`）会一次性 fan-out
   多个 background subagent，密集完成时合并为一条通知避免对话流被刷屏。
2. **延迟可调**：窗口从 plan 提到的 2000ms 改为 `MERGE_WINDOW_MS = 60_000`，配合
   「无 running background 时立即 flush」——最后一批不等窗口，兼顾合并与及时性。
3. **dedup 有语义**：cancel 与 detached 完成回调的竞态由 CAS 抢锁解决（见 execution-flow §4），
   但 dedup TTL 是通知层的二重防御（防同 id 短时间内重复 notify），非冗余。

**行为**：`notify()` → dedup TTL 检查 → 入 pending → 无 running 立即 flush / 否则重启窗口 timer。
窗口到期或 session_shutdown 时 flush 全部 pending 为一条消息（多条时列 bullet list）。

**plan 状态标注**：plan Wave 5 标注为「未按 plan 执行（有意偏差）」，非遗漏。
