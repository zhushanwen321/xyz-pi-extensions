---
verdict: pass
upstream: issues.md
downstream: (execution-plan consumes)
backfed_from: []
---

# 非功能性设计 — T2 删sync + 并发池分层 + 通知合并

> refactor 模式。7 维度副作用分析，产出缓解项回灌登记表 + 残余风险登记。

## 1. 分析矩阵

| 维度 | #1 sync 删除 | #2 并发池分层 | #3 通知合并 | #4 双重记账 |
|------|:---:|:---:|:---:|:---:|
| **安全** | ✅ | ✅ | ✅ | ✅ |
| **数据** | ✅ | ✅ | ⚠️ | ⚠️ |
| **性能** | ✅ | ⚠️ | ✅ | ✅ |
| **并发** | ✅ | ⚠️ | ✅ | ⚠️ |
| **稳定性** | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| **兼容性** | ⚠️ | ✅ | ⚠️ | ✅ |
| **可观测** | ✅ | ⚠️ | ✅ | ⚠️ |

**统计**：20 项 ✅ 无风险，8 项 ⚠️ 需缓解。

---

## 2. 详细分析（仅展开 ⚠️ 维度）

### Issue #1: sync 模式完全删除

#### 稳定性 ⚠️

**风险**：删除 sync 模式后，依赖 `wait: true` 或默认 sync 行为的 workflow 脚本、coding-workflow skills、用户自定义脚本将失败。

**根因**：`resolveMode()` 当前逻辑为 `wait===undefined + defaultBackground!==true → sync`。删除后此路径不存在，所有未显式 `wait:false` 的调用全部走 background——行为语义从"阻塞等结果"变为"立即返回 id"，调用方若未适配会拿不到执行结果。

**影响范围**：
- coding-workflow 的 `execute-full-workflow` 脚本（ADR-029 后已迁移 background，低风险）
- 用户手写 workflow JS 脚本中 `wait: true` 的调用
- `subagent tool` 的 `action: "start"` 默认行为变化

**关键源码**：`subagent-service.ts` L225-232 `resolveMode()` — 删除后需确认所有调用方已迁移 background。

#### 兼容性 ⚠️

**风险**：`wait` 参数从 tool schema 中完全删除是 breaking change。

**根因**：Pi tool schema 变更后，旧版 session 文件中存储的 tool call payload（含 `wait` 字段）在 replay 时可能因 schema 校验失败。此外 AI 的 prompt 中对 `wait` 参数的描述（agent .md）需要同步清理。

**影响范围**：
- session.jsonl 中历史 tool call 含 `wait` 字段（replay 兼容）
- agent .md prompts 中对 `wait` 的说明
- coding-workflow skills 文档中对 `wait` 的引用

**决策来源**：handoff 用户决策（wait 参数完全删除）。

---

### Issue #2: 并发池分层配额

#### 性能 ⚠️

**风险**：分层配额 `max(1, maxConcurrent-depth)` 在深度嵌套场景下可能限制吞吐量。

**量化分析**：
- `maxConcurrent=6`（默认），depth=0 → 6 槽位，depth=1 → 5 槽位，depth=5 → 1 槽位
- 深层嵌套（depth≥5）退化为串行，吞吐量降为 1/N
- **最坏场景**：depth=6 → 1 槽位，所有 background 排队

**缓解**：保底 1 槽位已保证不饿死（AC-2.3），但吞吐量下降是预期行为——深层嵌套本身应减少并发以保护资源。`MAX_FORK_DEPTH=10` 护栏限制了极端嵌套。

**结论**：可接受的性能退化，非阻断风险。

#### 并发 ⚠️

**风险**：分层配额可能引入排队饥饿或死锁。

**分析**：
- **饥饿**：保底 `max(1, ...)` 已防止 0 槽位饥饿（AC-2.3），但深层 + 大量并发时排队时间显著增加
- **死锁**：分层配额只影响 `acquire` 的有效 maxConcurrent，`release` 逻辑不变——不可能死锁。当前 sync 模式下的死锁场景（注释 L316-323）在 sync 删除后不存在
- **竞态**：`acquire`/`release` 无锁（Promise resolve 队列），与现有实现一致，不引入新竞态

**结论**：饥饿可接受（排队时间增加），死锁已消除（sync 删除），无新增竞态。

#### 稳定性 ⚠️

**风险**：保底 1 槽位防止饥饿，但当 `depth >= maxConcurrent` 时所有深层嵌套共享 1 个槽位。

**最坏场景**：`maxConcurrent=6, depth=6` → 有效配额=1。若此时有 5 个 background 任务排队，等待时间为单任务执行时间 × 5。

**缓解**：`MAX_FORK_DEPTH=10` 硬限制 + `DefaultConcurrencyPool` 的 FIFO 队列保证顺序执行，不会无限等待。

#### 可观测 ⚠️

**风险**：分层配额引入后，需要监控各层（depth）的配额使用情况，否则难以诊断排队瓶颈。

**当前状态**：`ConcurrencyPool` 只暴露 `active` 计数，不区分 depth。

**需要**：
- `active` 按 depth 分组统计（或至少在日志中记录 depth + effectiveMaxConcurrent）
- 排队时间监控（队列等待 > 阈值时 warn）

**缓解**：可在 `acquire` 入口加 debug 日志（depth, effectiveMaxConcurrent, queueLength），不影响逻辑。

---

### Issue #3: 通知机制合并

#### 数据 ⚠️

**风险**：`pending:unregister` 事件 payload 扩展（增加 `result`/`error`/`patchFile` 字段）。

**分析**：
- 当前 payload：`{ id, reason }`（见 `emitPendingUnregister` L75-79）
- T2 扩展为：`{ id, reason, result?, error?, patchFile? }`
- **消费方**：pending-notifications 扩展消费此事件，需适配新字段
- **旧消费方**：如果有其他扩展也监听 `pending:unregister`，新增字段是 additive（向后兼容）

**关键源码**：`subagent-service.ts` L75-79 `emitPendingUnregister()` — 当前只传 `{id, reason}`。

**结论**：payload 扩展是 additive change，旧消费方忽略新字段即可。pending-notifications 扩展需适配。

#### 稳定性 ⚠️

**风险**：删除 `notifier.ts`（BgNotifier 类）后，通知投递机制从 `pi.sendMessage(followUp)` 变为 `pending:unregister` 事件。

**分析**：
- BgNotifier 提供：滑动窗口合并（60s）、去重 TTL、`deliverAs:"followUp"` 唤醒
- 删除后：pending-notifications 扩展需承担合并+唤醒职责
- **丢失行为**：滑动窗口合并（60s 内多个完成合并为一条消息）——pending-notifications 扩展当前无此机制
- **丢失行为**：`deliverAs:"followUp"` 唤醒父 agent——pending-notifications 的 `sendMessage` 需对齐

**关键源码**：`notifier.ts` L53-61 `flushPendingNotifications()` — 合并多条 record 为一条消息 + `triggerTurn:true, deliverAs:"followUp"`。

**缓解**：T3 负责 pending-notifications 扩展适配（ADR-029 范围），T2 只负责删除 + 发事件。

#### 兼容性 ⚠️

**风险**：`pending:unregister` 事件契约扩展是 breaking change（对依赖旧契约的消费方）。

**分析**：
- 当前契约：`{ id: string, reason: string }`
- T2 契约：`{ id: string, reason: string, result?: string, error?: string, patchFile?: string }`
- **breaking 判定**：新增可选字段，TypeScript 结构类型兼容，运行时旧消费方忽略新字段 → **非 breaking**
- **但**：如果消费方做 `Object.keys(payload)` 严格校验或 JSON Schema 校验，新字段可能触发校验失败

**结论**：TypeScript 层面非 breaking，运行时需确认 pending-notifications 扩展的事件处理逻辑是否容忍额外字段。

---

### Issue #4: 通知机制统一 record 管理

#### 数据 ⚠️

**风险**：所有终态路径（done/failed/cancelled）都 emit `pending:unregister` 事件，需确保事件 payload 完整。

**分析**：
- 当前：只有部分终态路径 emit 事件
- T2：统一所有终态路径 emit 事件
- **关键点**：`runAndFinalize` 的 3 个终态（done/failed/cancelled）+ `cancelBackground` 的 CAS 抢锁 + `dispose` 的强制终态化
- **异常路径**：超时（dispose 收尾）、abort（signal 触发）、run 创建期异常（finalizeFailed）

**关键源码**：`subagent-service.ts` L364-386 `finalizeRecord()` — B9 兜底保证 completeRecord/archive 抛错不阻断后续清理。

**缓解**：T2 需确保所有终态路径都 emit `pending:unregister` 事件（与 completeRecord 同步执行）。

#### 并发 ⚠️

**风险**：cancel 和 runAndFinalize 的 CAS 抢锁存在竞态窗口。

**分析**：
- **竞态场景**：`cancelBackground` CAS 抢锁（`tryTransition`）成功后，`kickOffBackground` 的 `.then` 读 `record.status !== "cancelled"` 检查——CAS 保证了互斥，但事件 emit 如果在 CAS 之后异步执行，存在短暂不一致窗口
- **实际影响**：`finalizeRecord` 中 `completeRecord + archive` 是同步的，事件 emit 应在同一调用栈内完成 → 窗口极小

**缓解**：事件 emit 放在 `finalizeRecord` 内（与 `completeRecord` 同步执行），不在事件回调中异步执行。

#### 稳定性 ⚠️

**风险**：异常路径（超时/abort/失败）未 emit 事件时，pending-notifications 中的 record 卡在 active。

**分析**：
- **超时**：当前无显式超时机制，由 Pi 进程管理。超时后进程 kill → `dispose()` → `abortRunningControllers` + `killAllSpawnedChildren` → record 状态依赖 `dispose` 收尾
- **abort**：`cancelBackground` 的 CAS 已覆盖（`tryTransition("cancelled")`）
- **run 创建期异常**：`finalizeFailed` 的 CAS 已覆盖（`tryTransition("failed")`）

**缓解**：T2 需确保 `dispose()` 路径中也 emit `pending:unregister` 事件（当前只调 `store.abortRunningControllers`，未 emit 事件）。

#### 可观测 ⚠️

**风险**：终态路径事件 emit 一致性难以监控，未 emit 时无告警。

**需要**：
- 终态路径事件 emit 断言（debug 模式下校验事件已 emit）
- `dispose()` 路径的终态化日志（哪些 record 被强制终态化）

**缓解**：在 `finalizeRecord` 入口加 debug 日志（recordId, status, hasWorkflowRun），不影响逻辑。

---

## 3. 缓解项回灌登记表

> 缓解项 = 必须在对应 Wave 的实现中落地的措施。回灌到 issues.md 对应 issue 的 AC。

| 缓解项 | 来源 Issue# | 维度 | 回灌去向 | 落地为 | **验收方式** | 状态 |
|--------|------------|------|---------|--------|------------|------|
| 全量搜索 sync 相关引用 | #1 | 稳定性 | ⑤test-matrix | AC-1.3 验证 | 代码测试 | 待落 |
| session.jsonl replay 兼容 | #1 | 兼容性 | ⑤test-matrix | AC-1.4 验证 | 代码测试 | 待落 |
| agent .md prompts 清理 | #1 | 兼容性 | ⑤骨架 | prompt 清理 | 骨架约束 | 待落 |
| 分层配额 debug 日志 | #2 | 性能 | ⑤test-matrix | AC-2.2 验证 | 代码测试 | 待落 |
| 保底 1 槽位单测 | #2 | 并发 | ⑤test-matrix | AC-2.3 验证 | 代码测试 | 待落 |
| 排队超时 warn 日志 | #2 | 可观测 | ⑤test-matrix | 新 AC 验证 | 代码测试 | 待落 |
| emitPendingUnregister payload 扩展 | #3 | 数据 | ⑤test-matrix | AC-3.4 验证 | 代码测试 | 待落 |
| pending-notifications 适配新 payload | #3 | 稳定性 | ⑤test-matrix | AC-3.1 验证 | 代码测试 | 待落 |
| 确认旧消费方容忍额外字段 | #3 | 兼容性 | ⑤test-matrix | AC-3.4 验证 | 代码测试 | 待落 |
| 所有终态路径 emit 事件 | #4 | 数据 | ⑤test-matrix | AC-4.1 验证 | 代码测试 | 待落 |
| 事件 emit 不走异步回调 | #4 | 并发 | ⑤test-matrix | AC-4.2 验证 | 代码测试 | 待落 |
| dispose() 路径 emit 事件 | #4 | 稳定性 | ⑤test-matrix | AC-4.3 验证 | 代码测试 | 待落 |
| finalizeRecord 入口 debug 日志 | #4 | 可观测 | ⑤test-matrix | 新 AC 验证 | 代码测试 | 待落 |

---

## 4. 残余风险登记

> 残余风险 = 缓解后仍无法消除的风险，需用户决策或后续 topic 处理。

| 编号 | 来源 | 风险描述 | 概率 | 影响 | 决策/后续 |
|------|------|---------|------|------|----------|
| R-1 | #1 兼容性 | 历史 session.jsonl 中含 `wait:true` 的 tool call replay 可能行为异常（非 schema 校验失败，而是结果语义变化：从阻塞等变为立即返回） | 低 | 中 | **接受**：session replay 是调试工具，非生产路径。旧 session 可手动处理 |
| R-2 | #2 性能 | 深层嵌套（depth≥3）退化为串行，吞吐量显著下降 | 中 | 低 | **接受**：深层嵌套本身应减少并发以保护资源，这是设计意图而非缺陷 |
| R-3 | #3 稳定性 | BgNotifier 的滑动窗口合并（60s 多完成合并为一条消息）在 T2 后丢失——pending-notifications 扩展（T3 负责）是否重建此机制未确认 | 中 | 中 | **转 T3**：T3 的 pending-notifications 适配需覆盖合并语义。T2 只负责删除 + 发事件 |
| R-4 | #3 稳定性 | BgNotifier 的 `deliverAs:"followUp"` 唤醒父 agent 机制在 T2 后由 pending-notifications 承担，需确认 pending-notifications 的 `sendMessage` 调用参数对齐 | 中 | 中 | **转 T3**：同 R-3，T3 负责 |
| R-5 | #4 稳定性 | `dispose()` 路径（进程退出）中 WorkflowRun 同步终态化依赖 `pi.events.emit`，但 `dispose` 时 pi 可能已 null（session 已 shutdown） | 低 | 低 | **接受**：`emitPendingUnregister` 已做 null guard（`pi?.events.emit`），pi 为 null 时静默跳过——这是预期退化 |
