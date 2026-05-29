---
review:
  type: code_review
  round: 2
  timestamp: "2026-05-29T18:00:00"
  target: "infinite-context/src/"
  verdict: fail
  summary: "业务逻辑审查 v2。v1 的 5 条 MUST FIX 中 3 条已修、1 条未修（retention 取 max）、1 条修出回归（writeSegmentFile 每次覆盖丢失 turn 数据）。新增 2 条 MUST FIX。"

statistics:
  total_issues: 10
  must_fix: 2
  low: 5
  info: 3
  files_reviewed: 8
  issues_found: 10
  must_fix_count: 2
  low_count: 5
  info_count: 3

issues:
  - id: 1
    severity: MUST_FIX
    location: "infinite-context/src/segment-tracker.ts:L206"
    title: "getRetentionWindow 仍取 max(byCount, byTurns)，spec C-6 要求取 min"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    note: "v1 #1 未修。注释明确写'取两者中段数较多的（更宽松的窗口）'，方向完全反了"

  - id: 2
    severity: MUST_FIX
    location: "infinite-context/src/segment-tracker.ts:L147-L155"
    title: "writeSegmentFile 在每次 turn_end 都被调用，覆盖已累积的 turn 数据"
    status: open
    raised_in_round: 2
    resolved_in_round: null
    note: "v1 #2 修出了回归：writeSegmentFile 不再为空，但现在每 turn 覆盖文件→前 N-1 个 turn 的 message/toolResults 数据丢失"

  - id: 3
    severity: LOW
    location: "infinite-context/src/tree-compactor.ts:L131-L146"
    title: "triggerCompression 重复实现 retention window 逻辑且包含同款 min/max bug"
    status: open
    raised_in_round: 2
    resolved_in_round: null
    note: "与 Issue #1 是同一 bug 的第二处。应直接复用 tracker.getRetentionWindow()"

  - id: 4
    severity: LOW
    location: "infinite-context/src/segment-tracker.ts:L178-L186"
    title: "appendTurnToSegFile 的 catch 块为空，违反 no-silent-catch 规则"
    status: open
    raised_in_round: 2
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "infinite-context/src/context-handler.ts:L94-L99"
    title: "retentionSegIds 被计算但从未使用，死代码"
    status: open
    raised_in_round: 2
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "infinite-context/src/commands.ts:L39"
    title: "/tree-compact 的 onComplete 回调 void 掉 result，用户无完成通知"
    status: open
    raised_in_round: 2
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "infinite-context/src/context-handler.ts:L22"
    title: "DEFAULT_CONTEXT_WINDOW 硬编码 200000，应从 Pi API 获取"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    note: "v1 #7 未修，保持 LOW"

  - id: 8
    severity: INFO
    location: "infinite-context/src/context-handler.ts:L99-L108"
    title: "isIcSummary 仅检查 customType，未检查 role（风险极低）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    note: "v1 #13 未修，保持 INFO"

  - id: 9
    severity: INFO
    location: "infinite-context/src/recall-tool.ts:L94"
    title: "recall 的 execute 内联在 register() 闭包中，独立测试不便"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    note: "v1 #12 未修，保持 INFO"

  - id: 10
    severity: INFO
    location: "infinite-context/src/types.ts:L57"
    title: "CompactTree 持久化依赖 as 强制转换，类型安全依赖运行时数据一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    note: "v1 #11 未修，保持 INFO"
---

# 业务逻辑审查 v2 — Infinite Context Engine

## 评审记录
- 评审时间：2026-05-29 18:00
- 评审类型：编码评审（业务逻辑专项，v2 重审）
- 评审对象：`infinite-context/src/` 全部 8 个源文件
- 对照基准：spec.md FR-1~FR-6 + AC-1~AC-6
- 上轮结果：v1 发现 5 条 MUST FIX → 本轮验证修复状态

## v1 MUST FIX 逐条验证

### v1 #1 — getRetentionWindow 取 max 而非 min — ❌ 未修

**位置**：`segment-tracker.ts:L206`

**当前代码**：
```typescript
// 取两者中段数较多的（更宽松的窗口）
return byCount.length >= byTurns.length ? byCount : byTurns;
```

**问题**：注释明确写了"取两者中段数较多的（更宽松的窗口）"。Spec C-6 要求"取两者最小值"——即更严格的约束。`tree-compactor.ts:L145` 同样有这个 bug（且注释写"取较宽松的窗口"）。

**影响**：当段很短（1 turn/段）时，`byTurns` 可能包含 7-8 个段，而 `byCount` 只有 2 个。当前代码返回 7-8 个段（远超 spec 的 2 段约束），导致保留窗口过大、压缩效率低下。

**修复**：
```typescript
// 取两者中段数较少的（更严格的约束 = min）
return byCount.length <= byTurns.length ? byCount : byTurns;
```

### v1 #2 — writeSegmentFile 空实现 — ✅ 已修，但引入回归 → 新 MUST FIX #2

**原问题**：`writeSegmentFile` 方法体为空，段原始数据从未写入文件系统。

**修复状态**：`writeSegmentFile` 现在有完整实现（创建目录、写入 JSON）。同时新增了 `appendTurnToSegFile` 方法追加 turn 数据。段文件写入路径与 `readSegmentFile` 一致，recall content 模式可正常读取。

**但引入新 bug**：`handleTurnEnd` 在每次 turn_end 都调用 `writeSegmentFile` + `appendTurnToSegFile`。`writeSegmentFile` 写入的是不含 `turns` 数组的基础数据，会覆盖上一轮追加的 turn 数据。多 turn 段只有最后一个 turn 的数据能保留。

**详见新 Issue #2（MUST FIX）**。

### v1 #3 — triggerCompression 缺少 maxTurns 约束 — ✅ 已修

**原问题**：`triggerCompression` 仅按 `slice(-RETENTION_CONFIG.maxSegments)` 过滤，未实现 maxTurns。

**修复状态**：`tree-compactor.ts:L134-L144` 现在完整实现了 `byCount` + `byTurns` 双策略过滤。maxTurns 约束已加入。

**附带问题**：min/max 选择方向错误（同 v1 #1），但原 issue 描述的"缺少 maxTurns"本身已修。

### v1 #4 — BFS 展平同层顺序注释缺失 — ✅ 已修

**原问题**：bfsFlatten 中 reverse() 的假设未注释。

**修复状态**：`context-handler.ts:bfsFlatten()` 方法注释和行内注释明确写了：
- JSDoc: "同层内 newest-to-oldest（children 数组最后添加的 = newest）"
- 行内: "同层 newest-to-oldest：children 数组最后添加的 = newest / reverse 使 newest 排在前面"

### v1 #5 — recall 参数未设 mode 默认值 — ✅ 已修

**原问题**：`StringEnum` 未配置 `default: "structure"`。

**修复状态**：`recall-tool.ts:L57` 的 `RecallParams` 现在有 `default: "structure"`。

## 新发现的问题

### MUST FIX

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | segment-tracker.ts:L206, tree-compactor.ts:L145 | **retention window 取 max 而非 min**（v1 #1 未修，两处都有）。spec C-6 要求 min(2段, 8turn覆盖) 约束 | 改为 `byCount.length <= byTurns.length ? byCount : byTurns`；TreeCompactor 应直接复用 `tracker.getRetentionWindow()` |
| 2 | MUST FIX | segment-tracker.ts:L147-L155 | **writeSegmentFile 每次 turn_end 覆盖文件，丢失前 N-1 个 turn 数据**。多 turn 段只有最后一个 turn 的 message/toolResults 能保留到段文件，recall content 模式只能拿到不完整数据 | 方案 A：只在 `isUserMessage` 创建新段时调用 `writeSegmentFile`，后续 turn 只调用 `appendTurnToSegFile`。方案 B：合并 writeSegmentFile 和 appendTurnToSegFile 为原子操作（read → merge → write） |

### LOW

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 3 | LOW | tree-compactor.ts:L131-L146 | triggerCompression 重复实现 retention window 逻辑（且包含同款 bug）。应复用 `tracker.getRetentionWindow()` | 删除 TreeCompactor 内的过滤逻辑，从外部传入 `retentionWindow` |
| 4 | LOW | segment-tracker.ts:L178-L186 | `appendTurnToSegFile` 的 catch 块为空 `catch {}`，违反 no-silent-catch 规则 | 至少 `console.warn("[infinite-context] Failed to append turn data:", err)` |
| 5 | LOW | context-handler.ts:L94-L99 | `retentionSegIds` 被计算但从未使用，注释写"仅用于信息记录"实际也没用 | 移除或实际用于 filtered messages 的段级过滤 |
| 6 | LOW | commands.ts:L39 | `/tree-compact` 的 onComplete 回调 `void result`，用户无法在 TUI 看到 compression 完成结果 | 添加 `ctx.ui.notify(...)` 通知压缩结果 |
| 7 | LOW | context-handler.ts:L22 | DEFAULT_CONTEXT_WINDOW 硬编码 200000，应从 Pi API 获取 | 将 `contextWindow` 作为参数传入 `assembleMessages()` |

### INFO

| # | 优先级 | 文件/位置 | 描述 |
|---|--------|----------|------|
| 8 | INFO | context-handler.ts:L99-L108 | `isIcSummary` 仅检查 `customType`，未检查 `role`（Pi 的 CustomMessage 总有 role: "custom"，风险极低） |
| 9 | INFO | recall-tool.ts:L94 | recall 工具的 `execute` 内联在 `register()` 闭包中，独立测试需要 mock 整个 pi.registerTool |
| 10 | INFO | types.ts:L57 | CompactTree 持久化通过 `as CompactTree` 强制转换，类型安全依赖运行时数据格式一致 |

## 模拟业务数据验证（聚焦回归 bug）

### 回归场景：多 turn 段数据丢失

```
Precondition: 会话进行中，seg_2 为当前活跃段

Timeline:
  1. [turn_end: turnIndex=5, message.role="assistant"]
     → handleTurnEnd:
       a. writeSegmentFile(ctx, seg_2)
          → 写入: { segId: "seg_2", turnRange: {...}, userMessage: "...", timestamp: ... }
          → 文件内容: 无 turns 数组
       b. appendTurnToSegFile(ctx, seg_2, { turnIndex: 5, message, toolResults })
          → 读取文件 → 添加 turns: [{ turnIndex: 5, ... }] → 写回
          → 文件内容: { ..., turns: [{ turnIndex: 5, message, toolResults }] }

  2. [turn_end: turnIndex=6, message.role="assistant"]
     → handleTurnEnd:
       a. writeSegmentFile(ctx, seg_2)
          → 写入: { segId: "seg_2", turnRange: {...}, userMessage: "...", timestamp: ... }
          → **覆盖了 turn 5 的数据！turns 数组丢失**
       b. appendTurnToSegFile(ctx, seg_2, { turnIndex: 6, message, toolResults })
          → 读取文件 → 添加 turns: [{ turnIndex: 6, ... }] → 写回
          → 文件内容: { ..., turns: [{ turnIndex: 6, message, toolResults }] }

  3. [turn_end: turnIndex=7, message.role="user"]
     → handleTurnEnd:
       a. 标记 seg_2 completed
       b. 创建 seg_3
       c. writeSegmentFile(ctx, seg_3) → 写入 seg_3 基础数据
       d. appendTurnToSegFile(ctx, seg_3, { turnIndex: 7, ... })

  此时如果执行 recall({ nodeId: "node_seg_2", mode: "content" })：
    → 读取 seg_2.json → turns 数组只有 [{ turnIndex: 6, ... }]
    → turn 5 的数据已丢失 ❌
    → turn 6 的 assistant message 和 toolResults 保留 ✅
    → 但 turn 5（可能包含重要的工具调用结果）丢失

结论：seg_2 的 3 个 turn 中只有最后一个 turn 的数据被保留。
      如果 turn 5 包含关键的代码搜索结果或 recall 结果，这些信息在 recall content 时无法恢复。
```

### 保留窗口 min/max bug 验证

```
Precondition: 12 completed segments (seg_0 ~ seg_11), current turn=24
              每段约 1 turn（快速短对话场景）

  getRetentionWindow():
    byCount = [seg_10, seg_11] (2 segments)
    latestTurnEnd = 24
    cutoffTurn = 24 - 8 + 1 = 17
    byTurns = segments with turnRange.end >= 17
      → 假设: seg_10(end=23), seg_11(end=24), seg_9(end=22), seg_8(end=21),
              seg_7(end=20), seg_6(end=19), seg_5(end=18), seg_4(end=17)
      → byTurns = [seg_4, seg_5, seg_6, seg_7, seg_8, seg_9, seg_10, seg_11] (8 segments)

    当前代码: byCount.length(2) >= byTurns.length(8) → false → returns byTurns (8 segments)
    Spec 要求: min(2, 8) = 2 segments → 应返回 [seg_10, seg_11]

  影响：
    → 8 个段被保留，只有 seg_0~seg_3 被压缩
    → 压缩效率: 预期压缩 10 个历史段，实际只压缩 4 个
    → Context 膨胀: 保留了 6 个多余的完整段原文
    → 在长对话中，这个 bug 会导致压缩迟迟无法释放足够的 context 空间
```

## FR/AC 合规矩阵（仅更新 v2 有变化的项）

| AC | 场景 | v1 状态 | v2 状态 | 变化说明 |
|----|------|---------|---------|----------|
| AC-1.3 | 段原始数据写入 | ❌ | ⚠️ | 段文件现在会被写入，但多 turn 段只有最后一个 turn 的数据 |
| AC-2.5 | LLM 返回有效 JSON | ✅ | ✅ | 无变化 |
| AC-3.1 | 当前段+保留窗口用完整原文 | ⚠️ | ⚠️ | 保留窗口计算 bug 仍存在，但段文件写入已修复 |
| AC-4.2 | mode:content 返回原始内容 | ❌ | ⚠️ | 段文件现在存在且可读，但多 turn 段数据不完整 |

## 结论

**需修改后重审**。v1 的 5 条 MUST FIX 修复质量参差：
- 3 条干净修复（#3 maxTurns、#4 BFS 注释、#5 recall 默认 mode）
- 1 条未修（#1 min/max 方向）
- 1 条修出回归（#2 段文件写入导致 turn 数据丢失）

2 条新 MUST FIX 中，Issue #2（turn 数据覆盖）是功能性数据丢失——recall content 模式在多 turn 段上只能返回部分数据。Issue #1（retention min/max）虽然从 v1 沿用，但已出现在两个位置且注释明确写了错误方向，需要一并修复。
