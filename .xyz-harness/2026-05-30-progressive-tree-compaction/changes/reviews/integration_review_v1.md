---
review:
  type: integration_review
  round: 1
  timestamp: "2026-05-30T16:30:00"
  target: "infinite-context/src/{types,segment-tracker,tree-compactor,context-handler,index}.ts"
  verdict: pass
  summary: "集成审查通过，0 条 MUST FIX，6 个集成点全部正确 wired，数据流无断裂"

statistics:
  total_issues: 2
  must_fix: 0
  low: 1
  info: 1
---

# Integration Review v1

## 评审记录
- 评审时间：2026-05-30 16:30
- 评审类型：集成审查（integration point wiring + 数据流完整性）
- 评审对象：Progressive Tree Compaction 5 个源文件的跨模块调用链
- 评审基准：BLR v1 报告 + spec.md AC/FR + git diff `072c755..HEAD`

## 集成点逐项审查

### (a) types.ts exports → segment-tracker.ts / tree-compactor.ts 导入 ✅

| 导出 | 导入者 | 状态 |
|------|--------|------|
| `RETENTION_GRADIENT` | `segment-tracker.ts:L16` | ✅ `import { RETENTION_GRADIENT } from "./types"` |
| `RETENTION_GRADIENT` | `tree-compactor.ts:L17` | ✅ `import { COMPRESSION_CONFIG, RETENTION_GRADIENT } from "./types"` |
| `COMPRESSION_CONFIG` | `tree-compactor.ts:L17` | ✅ 同上 |
| `IContextUsage` | 未直接导入（index.ts 用 `ctx.getContextUsage()` 返回推断类型） | ✅ 合理，接口文档用途 |

**结论**：所有新增 export 均被正确导入，无孤立导出，无遗漏导入。旧的 `RETENTION_CONFIG` 导出已移除，两处旧导入均已更新。

### (b) segment-tracker.getRetentionWindow(usagePercent) → index.ts context handler ✅

**调用链**：
```
index.ts:L82  tracker.getRetentionWindow(usagePercent)
```

**参数来源**：
```
index.ts:L79  const contextUsage = ctx.getContextUsage();
index.ts:L82  const usagePercent = contextUsage?.percent ?? 50;
```

**签名匹配**：
- 声明：`getRetentionWindow(usagePercent: number): readonly Segment[]`
- 调用：`tracker.getRetentionWindow(usagePercent)` — `usagePercent: number` ✅

**数据流验证**：
1. `ctx.getContextUsage()` → 返回 `{ contextWindow, usedTokens, percent }` 或 `undefined`
2. `contextUsage?.percent ?? 50` → `number`
3. `getRetentionWindow(50)` → 查梯度表 `< 50` 匹配 `retainCount: 9999` → 保留所有段 ✅
4. `getRetentionWindow(85)` → `< 91` 匹配 `retainCount: 2` → 保留最近 2 个 ✅

**结论**：参数类型匹配，梯度查找语义正确，默认值 50 安全（低占用 → 不压缩）。

### (c) tree-compactor.computeCompressionScope → triggerCompression 正确调用 ✅

**调用链**（tree-compactor.ts 内部）：
```
tree-compactor.ts:L742-743
const scope = this.computeCompressionScope(retentionSegs, historySegments, existingTree);
historySegments = scope.targetSegs;
```

**签名匹配**：
- 声明：`computeCompressionScope(retentionSegs, historySegs, existingTree): { targetSegs, estimatedAfterTokens }`
- 调用参数：`retentionSegs: Segment[]`，`historySegments: Segment[]`，`existingTree: CompactTree | undefined` ✅

**返回值使用**：`scope.targetSegs` 赋值回 `historySegments`，后续用于 `historySegments.length === 0` 守卫和 `buildSegmentDigests(historySegments, ...)` ✅

**结论**：内部调用正确，scope 结果被合理消费。

### (d) tree-compactor.getCompressedSegIds() → index.ts context handler 传递到 assembleMessages ✅

**调用链**：
```
index.ts:L87  compactor.getCompressedSegIds()
index.ts:L84-88
assembler.assembleMessages(
    event.messages, tree, segments, retentionWindow,
    compactor.getCompressedSegIds(),  // ← 5th positional arg
    contextWindow,                    // ← 6th positional arg
);
```

**签名匹配**：
- `getCompressedSegIds(): Set<string>` → 返回 `Set<string>` 拷贝
- `assembleMessages` 第 5 参数：`compressedSegIds?: Set<string> | number` → `Set<string>` 匹配 ✅
- `assembleMessages` 第 6 参数：`contextWindow: number = DEFAULT_CONTEXT_WINDOW` → `contextWindow: number` 匹配 ✅

**向后兼容层验证**：
```
context-handler.ts:L165-170
if (compressedSegIds instanceof Set) {
    effectiveCompressedSegIds = compressedSegIds;
} else if (typeof compressedSegIds === "number") {
    effectiveContextWindow = compressedSegIds;
}
```
当 `index.ts` 传 `Set<string>` 时，走 `instanceof Set` 分支 → `effectiveCompressedSegIds` 正确赋值 ✅

**结论**：`getCompressedSegIds()` 的返回值正确传递到 `assembleMessages`，向后兼容层不影响新调用路径。

### (e) context-handler.assembleMessages(compressedSegIds) → 正确处理过滤 ✅

**过滤逻辑**（context-handler.ts:L175-197）：
1. 计算 `userMsgCount = segments.filter(s => compressedSegIds.has(s.segId)).length`
2. 遍历 `filtered` 数组，数 user 消息计数，找到 N 个 user+assistant 对后确定 `toSkip`
3. `filtered = filtered.slice(toSkip)` 跳过已压缩段的原始消息

**前置条件验证**：
- `effectiveCompressedSegIds && effectiveCompressedSegIds.size > 0 && tree` — 三个条件缺一不可 ✅
- 无 tree 时跳过过滤（无压缩发生过）✅
- 空 Set 时跳过过滤 ✅

**注入策略**（AC-4 验证）：
- 无 tree：返回 `filtered`（已去除旧 IC 注入） ✅
- 有 tree + 不膨胀：`[recallMsg, ...summaryMessages, ...filtered]` ✅
- 有 tree + 膨胀：`[recallMsg, ...truncatedSummaries, ...retainedMessages]` ✅

**结论**：过滤逻辑在正确的条件下触发，注入策略保持一致。

### (f) triggerCompression(usagePercent) → index.ts turn_end handler 正确调用 ✅

**调用链**：
```
index.ts:L39-46
const ctxUsage = ctx.getContextUsage();
const usagePercent = ctxUsage?.percent ?? 50;
compactor.triggerCompression(
    pi, ctx, segments, compactor.getTree(),
    usagePercent, onCompleteFactory(ctx),
);
```

**签名匹配**：
- 声明：`triggerCompression(pi, ctx, segments, existingTree, usagePercent=50, onComplete?)`
- 调用：6 个参数，位置完全对齐 ✅
- `usagePercent` 默认值 50 → `triggerCompression` 内 AC-6 守卫 `usagePercent < 50` 会阻止（50 不 < 50）✅
- `onComplete` 回调 → `onCompleteFactory(ctx)` 返回 `(result: CompactResult) => void` ✅

**触发条件链**：
1. `!compactor.isCompressing()` — 不在压缩中
2. `needsCompressionRef.value` — context handler 置位
3. 守卫通过 → `needsCompressionRef.value = false` 复位
4. `triggerCompression` 内 `usagePercent < 50` → early return（AC-6）

**结论**：触发条件正确，参数传递完整，AC-6 守卫有效。

## 数据流完整性验证

### Flow 1: contextUsage → usagePercent → getRetentionWindow → retentionSegs

```
ctx.getContextUsage()
  → { percent: number } | undefined
  → usagePercent = contextUsage?.percent ?? 50

tracker.getRetentionWindow(usagePercent)
  → 查 RETENTION_GRADIENT 表
  → completedSegments.slice(-retainCount)
  → 追加 activeSegment
  → retentionSegs: Segment[]
```

**完整性**：✅ 无断裂。`getContextUsage()` 可返回 `undefined`，由 `?? 50` 兜底。

### Flow 2: getSegments() → triggerCompression → computeCompressionScope → runCompression

```
tracker.getSegments()
  → segments: Segment[]

compactor.triggerCompression(pi, ctx, segments, tree, usagePercent, onComplete)
  → AC-6 guard: usagePercent < 50 → return
  → 梯度表查 retentionSegs
  → historySegments = segments - retentionSegs - activeSegs
  → computeCompressionScope(retentionSegs, historySegments, existingTree)
    → { targetSegs, estimatedAfterTokens }
  → historySegments = scope.targetSegs
  → historySegments.length === 0 → return
  → buildSegmentDigests(historySegments, ctxCwd)
  → runCompression(pi, ctx, historySegments, existingTree, 0, onComplete)
```

**完整性**：✅ 无断裂。每个路径都有守卫和合理的 early return。

### Flow 3: compressedSegIds → getCompressedSegIds() → assembleMessages(compressedSegIds)

```
[压缩成功/重试/fallback时]
  → for (seg of segments) this.compressedSegIds.add(seg.segId)

[restoreState时]
  → collectCompressedSegIds(tree.root) → BFS 收集所有 leaf.segId

[index.ts context handler]
  → compactor.getCompressedSegIds() → new Set(this.compressedSegIds)  // 拷贝
  → assembler.assembleMessages(..., compressedSegIds, contextWindow)
  → 过滤已压缩段的原始消息
```

**完整性**：✅ 无断裂。`getCompressedSegIds()` 返回拷贝，避免外部修改内部状态。所有压缩路径（首次成功、retry 成功、fallback）都执行 `compressedSegIds.add(seg.segId)`。`restoreState` 重建时也收集树中的 segIds。

## session_start 恢复链验证

```
pi.on("session_start", handler)
  → tracker.restoreState(entries) — 从 ic-segment entries 重建 segments
  → compactor.restoreState(entries) — 从 ic-compact-tree entry 重建 tree + compressedSegIds
```

**时序正确性**：tracker 先恢复（提供 segments），compactor 后恢复（提供 tree + compressedSegIds）。context handler 在下次 LLM 调用时才触发，不依赖 restoreState 的完成顺序。✅

## session_before_compact 取消逻辑

```
pi.on("session_before_compact", () => {
    if (compactor.getTree()) return { cancel: true };
    return undefined;
});
```

**验证**：仅在 `compactor.getTree()` 存在时取消原生 compact。无树时让原生 compact 正常执行，避免首次压缩前丢失原生能力。✅

## TypeScript 类型检查

```
$ npx tsc --noEmit
(no output — 0 errors)
```

全量类型检查通过，无类型不匹配。✅

## 发现的问题

| # | 优先级 | 位置 | 描述 | 影响 |
|---|--------|------|------|------|
| 1 | LOW | context-handler.ts:L175-197 | `compressedSegIds` 过滤通过数 user 消息来确定跳过范围，依赖"消息顺序 = 段顺序"假设。当前 Pi 架构下成立（每个 user message 触发新段），但如果消息模型变化（如 tool result 消息计入 user 角色计数），可能误切。BLR #2 已记录。 | 不阻塞 — 当前架构安全 |
| 2 | INFO | tree-compactor.ts | `_buildPreviousSummarySection` 和 `_buildIncrementalPrompt` 以下划线前缀保留为 deprecated 但未删除（约 50 行）。BLR #3 已记录。 | 不阻塞 — 纯死代码 |

## 集成矩阵总览

| 集成点 | 调用方 | 被调用方 | 参数匹配 | 返回值消费 | 状态 |
|--------|--------|----------|---------|-----------|------|
| (a) types exports | types.ts | segment-tracker / tree-compactor | — | — | ✅ |
| (b) getRetentionWindow(%) | index.ts | segment-tracker.ts | `number → number` | `Segment[] → retentionWindow` | ✅ |
| (c) computeCompressionScope | triggerCompression | tree-compactor (self) | 3 args match | scope.targetSegs consumed | ✅ |
| (d) getCompressedSegIds | index.ts | tree-compactor.ts | 0 args | `Set<string> → assembleMessages 5th param` | ✅ |
| (e) assembleMessages filtering | index.ts | context-handler.ts | 6 args match | AssembleResult.messages | ✅ |
| (f) triggerCompression(%) | index.ts turn_end | tree-compactor.ts | 6 args match | fire-and-forget + callback | ✅ |

## 结论

**通过**。6 个集成点全部正确 wired，3 条数据流无断裂，TypeScript 编译 0 error。2 条 LOW/INFO 沿用 BLR 已记录项，不阻塞集成。
