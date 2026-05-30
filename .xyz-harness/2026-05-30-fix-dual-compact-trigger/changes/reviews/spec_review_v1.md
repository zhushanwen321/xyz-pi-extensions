---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-30T22:30:00"
  target: ".xyz-harness/2026-05-30-fix-dual-compact-trigger/spec.md"
  verdict: pass
  summary: "计划评审完成，第1轮，0条MUST FIX，spec 质量高，问题根因和方案描述准确"

statistics:
  total_issues: 4
  must_fix: 0
  low: 2
  info: 2

issues:
  - id: 1
    severity: LOW
    location: "spec.md > AC-2"
    title: "AC-2 验证方法只检查 await，未验证 TUI 渲染是否真正异步"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "spec.md > FR-5"
    title: "spawn vs spawnSync 的选择理由未解释为何不能继续用 spawnSync"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: INFO
    location: "spec.md > Constraints"
    title: "firstKeptEntryId 的来源 event.preparation 需确认 Pi API 是否已稳定提供"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: INFO
    location: "spec.md > 全文"
    title: "缺少边界情况：spawn 子进程超时时的 compaction 结果处理"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v1

## 评审记录
- 评审时间：2026-05-30 22:30
- 评审类型：计划评审（spec 完整性）
- 评审对象：`.xyz-harness/2026-05-30-fix-dual-compact-trigger/spec.md`

## 1. spec 完整性

### 1.1 目标明确性 — ✅ 通过

目标一句话可概括：**将 infinite-context 扩展的双轨压缩机制统一为 Pi 原生 compact 单一触发路径**。

Background 章节对三个问题的根因分析精确，与源码实现一致：

| 问题 | spec 描述 | 源码验证 |
|------|----------|---------|
| 问题1：Cancel 无副作用 → 重复触发 | `session_before_compact` 返回 `{ cancel: true }` 时无 entry 写入 | ✅ `createBeforeCompactHandler` 确实只返回 `{ cancel: true }`，不执行任何压缩 |
| 问题2：首次压缩时两套竞争 | tree 不存在时返回 `{ cancel: false }`，两套同时运行 | ✅ 当 `compactor.getTree()` 为 undefined 时返回 `{ cancel: false }`，turn_end 中 `compressAsync` 同时跑 |
| 问题3：异步不阻塞对话流 | `void compressAsync` fire-and-forget | ✅ `turn_end` handler 中 `void compressAsync(...)` |

### 1.2 范围合理性 — ✅ 通过

范围精确到 `infinite-context` 扩展的 3 个 handler 函数（`createBeforeCompactHandler`、`createTurnEndHandler`、`createContextHandler`），符合 Complexity Assessment 的 "Low-Medium" 评估。

不涉及 Pi 核心代码修改，Constraint 明确声明。

### 1.3 验收标准可测试性

| AC | 可测试性 | 评价 |
|----|---------|------|
| AC-1 | ✅ 可通过 mock `_checkCompaction` 返回值验证 | 精确 |
| AC-2 | ⚠️ 验证方法写的是"handler 是 await 的"，但这只验证了同步语义 | 见 Issue #1 |
| AC-3 | ✅ 可通过 mock spawn 验证事件循环不阻塞 | 精确 |
| AC-4 | ✅ 可通过检查 createContextHandler 代码验证 | 精确 |
| AC-5 | ✅ 可通过检查 createTurnEndHandler 代码验证 | 精确 |
| AC-6 | ✅ 可通过模拟 segments.length < 3 或全重试失败验证 | 精确 |

### 1.4 待决议项 — ✅ 无

无 `[待决议]` 标记。

## 2. FR 覆盖度

逐条对照三个已知问题：

| 问题 | 对应 FR | 覆盖 |
|------|--------|------|
| 问题1：Cancel 循环 | FR-2（返回 compaction 结果而非 cancel） | ✅ |
| 问题2：首次竞争 | FR-6（segments 不足时 fallback） + FR-1（统一触发） | ✅ |
| 问题3：异步不阻塞 | FR-1（利用 Pi await） + FR-5（spawn + await） | ✅ |

额外 FR：
- FR-3（context 事件只组装）— 清理冗余逻辑，合理
- FR-4（turn_end 不触发压缩）— 清理冗余逻辑，合理

**覆盖完整，无遗漏。**

## 3. 方案技术准确性

对照源码逐条验证 FR 的可行性：

### FR-1：统一压缩触发路径
- Pi 的 `_runAutoCompaction` 确实是 await 的 — ✅
- Pi 的 compaction entry 写入 — ✅（spec 依赖此行为）
- `session_before_compact` handler 可以是 async — 需确认 Pi 是否支持 async handler（见 Issue #3），但 spec 在 Constraints 中声明了 handler 接收的 event 类型，隐含假设 Pi 支持

### FR-2：返回 compaction 结果
- `SessionBeforeCompactResult` 的 `compaction` 字段 — 需确认 Pi API 是否支持返回 `compaction` 而非仅 `cancel`（见 Issue #3）
- `summary`、`firstKeptEntryId`、`tokensBefore` 的约束合理

### FR-5：spawn + await 模式
- `triggerCompressionAsync` 已存在且使用 `spawn`（非 `spawnSync`）— ✅ 可直接复用
- 对话流同步：Pi await handler → handler 内 await spawn → ✅
- TUI 异步：spawn 不阻塞事件循环 → ✅

### FR-6：首次 fallback
- segments.length < 3 作为阈值 — 合理，与 tree-compactor 中 group 逻辑一致

## 4. 边界情况审查

### 已覆盖
- ✅ segments 不足时的 fallback（FR-6、AC-6）
- ✅ tree-compact 全部重试失败时的 fallback（FR-6）

### 需关注的边界（INFO 级别）
- spawn 子进程超时（60s）：spec 未明确说明 handler 中 spawn 超时后应返回什么。当前 `triggerCompressionAsync` 有超时机制（kill SIGTERM），但 handler 需决定：返回空让 Pi fallback，还是返回 error（见 Issue #4）
- `session_before_compact` handler 执行中，用户输入新消息：这在 Pi 侧已由 `_runAutoCompaction` 的 await 机制保证——handler 完成前不会处理新 prompt。spec 隐含依赖此行为，无需额外说明
- 多 session 隔离：spec 未提及，但 infinite-context 当前通过闭包变量管理状态，扩展入口每次 `session_start` 重建。不构成风险

## 5. 架构约束合规

- ✅ 不修改 Pi 核心代码
- ✅ `session_before_compact` handler 符合 Pi Extension API 模式
- ✅ 返回值约束（`summary`、`firstKeptEntryId`、`tokensBefore`）明确
- ✅ 复用现有 `triggerCompressionAsync` 而非重写压缩逻辑

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | LOW | spec.md > AC-2 | AC-2 的验证方法只描述了"handler 是 await 的"，但这只能验证对话流同步。AC-2 标题是"对话流同步"，验证方法与标题匹配，但 AC-3（TUI 可渲染）与 AC-2 存在隐含依赖：如果 handler 阻塞了事件循环，AC-2 通过但 AC-3 失败。建议在 AC-2 中增加一条验证：确认 handler 内部使用 spawn 而非 spawnSync | 可在 AC-2 验证方法中补充"确认 handler 使用 spawn（非 spawnSync）" |
| 2 | LOW | spec.md > FR-5 | FR-5 说"用 spawn 而非 spawnSync"，但未解释为什么不能用 spawnSync。当前 turn_end 使用 spawnAsync（fire-and-forget），但 session_before_compact 场景下 Pi await handler，spawnSync 也能工作（只是阻塞事件循环）。应在 FR-5 中说明：spawnSync 会阻塞事件循环导致 TUI 卡死，所以必须用 spawn | 在 FR-5 中补充"spawnSync 会阻塞 Node.js 事件循环，TUI 无法渲染 spinner" |
| 3 | INFO | spec.md > Constraints | Constraints 提到 `firstKeptEntryId` 从 `event.preparation` 获取，需确认 Pi 的 `SessionBeforeCompactEvent` 是否已稳定提供 `preparation` 字段。这是外部依赖假设 | 执行前确认 Pi API 文档 |
| 4 | INFO | spec.md > 全文 | 缺少 spawn 子进程超时时的行为说明。当 `triggerCompressionAsync` 超时（60s）后，handler 应返回什么？返回空让 Pi 执行原生 compact（fallback）？还是返回 error？FR-6 只说"tree-compact 失败时 fallback"，但超时是否算"失败"未明确 | 在 FR-6 或新增 FR 中明确：spawn 超时视为 tree-compact 失败，触发 Pi 原生 fallback |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

## 结论

**通过**

Spec 质量高：问题根因分析准确（与源码一致），方案与现有代码架构匹配（复用 `triggerCompressionAsync`、不修改 Pi 核心），FR 完整覆盖三个已知问题，AC 可测试。4 条 LOW/INFO 建议可在执行阶段处理，不阻塞。

### Summary

计划评审完成，第1轮通过，0条MUST FIX。
