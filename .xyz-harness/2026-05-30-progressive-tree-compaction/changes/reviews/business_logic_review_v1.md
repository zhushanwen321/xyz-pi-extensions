---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-30T15:15:00"
  target: "infinite-context/src/{types,segment-tracker,tree-compactor,context-handler,index}.ts"
  verdict: pass
  summary: "BLR编码评审完成，第1轮通过，0条MUST FIX，所有AC/FR正确实现"

statistics:
  total_issues: 3
  must_fix: 0
  must_fix_resolved: 0
  low: 2
  info: 1

issues:
  - id: 1
    severity: LOW
    location: "infinite-context/src/context-handler.ts:L160-167"
    title: "compressedSegIds 参数使用联合类型 Set<string> | number 做向后兼容"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "infinite-context/src/context-handler.ts:L170-191"
    title: "compressedSegIds 过滤逻辑基于消息位置而非 segId 精确匹配"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: INFO
    location: "infinite-context/src/tree-compactor.ts:_buildPreviousSummarySection/_buildIncrementalPrompt"
    title: "两个 deprecated 函数用下划线前缀保留但未删除"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Business Logic Review v1

## 评审记录
- 评审时间：2026-05-30 15:10
- 评审类型：编码评审（BLR dev 模式）
- 评审对象：Progressive Tree Compaction 全部代码变更（5 文件 + 4 测试文件）
- 评审基准：spec.md AC-1~AC-6, FR-1~FR-7

## 变更范围

| 文件 | 变更概要 |
|------|---------|
| `types.ts` | 新增 RETENTION_GRADIENT（5 梯度）、COMPRESSION_CONFIG（ratioMin/Max/perSegmentTokens）、IContextUsage 接口 |
| `segment-tracker.ts` | `getRetentionWindow(usagePercent)` 接受参数，查梯度表，追加活跃段 |
| `tree-compactor.ts` | 新增 `computeCompressionScope`、`compressedSegIds`/`getCompressedSegIds`、append 模式（首次/追加/retry/fallback）、AC-6 守卫 |
| `context-handler.ts` | `assembleMessages` 新增 `compressedSegIds` 参数，过滤已压缩段的原始消息 |
| `index.ts` | 传递 `usagePercent` 和 `compressedSegIds`，wire 上下文使用比例到 tracker/compactor |

## AC 逐条验证

### AC-1: 保留窗口动态化 ✅

| 验证点 | 状态 | 证据 |
|--------|------|------|
| 上下文占用 < 50% → 保留所有 | ✅ | `RETENTION_GRADIENT[0]={usageMax:50, retainCount:9999}`，sentinel 9999 = 保留全部 |
| 50-70% → 保留 8 段 | ✅ | `RETENTION_GRADIENT[1]={usageMax:71, retainCount:8}`，`<71` 匹配 50-70 |
| 70-80% → 保留 4 段 | ✅ | `RETENTION_GRADIENT[2]={usageMax:81, retainCount:4}` |
| 80-90% → 保留 2 段 | ✅ | `RETENTION_GRADIENT[3]={usageMax:91, retainCount:2}` |
| > 90% → 保留 1 段 | ✅ | `RETENTION_GRADIENT[4]={usageMax:101, retainCount:1}` |
| 当前活跃段始终在保留窗口中 | ✅ | `getRetentionWindow` 末尾追加 `activeSegment`（`this.currentSegment ?? segments.find(!completed)`） |
| 段计数优先于 turn 计数 | ✅ | 旧 `maxTurns` 逻辑已移除，仅按段计数 |

**边界语义分析**：spec 说 "50-70%" 对应 8 段。代码用 `usageMax: 71`（即 `< 71`），所以 `usagePercent=70` 落入此区间 → 保留 8 段。`usagePercent=50` 时，`< 50` 不匹配第一行（`usageMax:50`），进入第二行 `< 71` → 保留 8 段。这与 spec 表格完全一致（"≥ 50%" 触发压缩，50% 属于 50-70% 区间）。

### AC-2: 压缩范围动态化 ✅

| 验证点 | 状态 | 证据 |
|--------|------|------|
| 预估比例 < 20% → 继续累加 | ✅ | `computeCompressionScope` 循环中 `ratio >= ratioMin` 才停止 |
| 预估比例落在 20-50% → 停止并提交 | ✅ | `ratio >= ratioMin && ratio <= ratioMax` 返回 |
| 超出上限 → 减一段 | ✅ | `ratio > ratioMax` 时取 `sorted.slice(0, i-1)` |
| 全部累加完仍未达标 → 提交所有 | ✅ | 循环结束后的 fallback 返回 `sorted` 全集 |
| 分母计算（树 + 保留段 digest + 历史 digest + 系统提示词） | ✅ | `denominator = existingTreeSize + retentionMsgSize + historyTotalDigest + systemPromptEstimate` |
| 段按 segId 排序（最旧优先） | ✅ | `sorted = [...historySegs].sort((a,b) => a.segId.localeCompare(b.segId))` |

### AC-3: 树只追加不重写 ✅

| 验证点 | 状态 | 证据 |
|--------|------|------|
| 首次压缩：创建新树 | ✅ | `!existingTree` 分支构建新 root |
| 追加模式：旧 groups 原封不动 | ✅ | `children: [...existingTree.root.children, ...newGroups]` |
| retry 也支持追加 | ✅ | retry 回调中 `if (currentTree)` 分支做追加 |
| fallback 也支持追加 | ✅ | `handleFallback` 中 `if (this.tree)` 分支创建 fallbackGroup 追加 |
| 旧 group summary 未修改 | ✅ | 代码只读取 `existingTree.root.children` 做展开，不修改原对象 |
| 树深度保持 2 | ✅ | 新 group 的 children 都是 leaf（由 LLM 输出或 fallback 产出），不会嵌套 group |
| treeId 保持不变（追加时） | ✅ | `treeId: existingTree.treeId` |

### AC-4: 上下文注入包含全部节点 ✅

| 验证点 | 状态 | 证据 |
|--------|------|------|
| recall 提示注入 | ✅ | `createRecallPromptMessage(now)` 始终在 messages 首位 |
| 所有 group 摘要注入 | ✅ | `bfsFlatten(tree)` 遍历所有节点（含 group）→ `createSummaryMessage` |
| 所有 leaf 摘要注入 | ✅ | bfsFlatten 遍历所有层级，leaf 也包含在 flatNodes 中 |
| 保留段原文注入 | ✅ | 非 bloated 路径 `finalMessages = [recallMsg, ...summaryMessages, ...filtered]` |
| 已压缩段原文被过滤 | ✅ | `compressedSegIds` 过滤逻辑跳过已压缩段的 user+assistant 消息 |
| 不包含原始 seg_N.json 内容 | ✅ | `assembleMessages` 从 event.messages 获取的是 digest，不读取 seg_N.json |

### AC-5: 压缩比稳定 ✅

| 验证点 | 状态 | 证据 |
|--------|------|------|
| 预估比例在 [0.2, 0.5] 范围 | ✅ | `computeCompressionScope` 算法确保返回的比例落在 [ratioMin, ratioMax]（除非段太少） |
| 测试验证连续估算在范围内 | ✅ | 测试用例 "AC-5: stable compression ratio (±20pp)" 验证了 20 段和 15 段场景 |

### AC-6: 低占用不压缩 ✅

| 验证点 | 状态 | 证据 |
|--------|------|------|
| 上下文占用 < 50% 不触发 | ✅ | `triggerCompression` 开头 `if (usagePercent < 50) return` |
| `needsCompressionRef` 正确置位 | ✅ | `createContextHandler` 中 `shouldCompress` 结果写入 `needsCompressionRef.value` |
| `needsCompressionRef` 在触发后复位 | ✅ | `createTurnEndHandler` 中 `needsCompressionRef.value = false` |
| 默认值安全（无 contextUsage 时） | ✅ | `ctxUsage?.percent ?? 50` 默认 50% → 不触发 < 50 守卫，但也不积极压缩 |

## FR 逐条验证

| FR | 状态 | 实现位置 |
|----|------|---------|
| FR-1 动态保留窗口 | ✅ | `RETENTION_GRADIENT` + `getRetentionWindow(usagePercent)` |
| FR-2 动态压缩范围 | ✅ | `computeCompressionScope` + `COMPRESSION_CONFIG` |
| FR-3 追加式树结构 | ✅ | `triggerCompression` 内的 append 分支（首次/retry/fallback 三路径全覆盖） |
| FR-4 上下文注入策略 | ✅ | `assembleMessages` 的 `bfsFlatten` + summary injection |
| FR-5 LLM 提示词 | ✅ | `buildExistingGroupsSection` + `buildInitialPrompt` 拼接 existingGroupsContext |
| FR-6 压缩触发时机 | ✅ | `createTurnEndHandler` + `createContextHandler` 协作 |
| FR-7 压缩失败处理 | ✅ | retry → fallback → ruleBasedFallback 全链路保留 |

## 数据流验证

```
turn_end → tracker.handleTurnEnd()
  → needsCompressionRef? → compactor.triggerCompression(pi, ctx, segs, tree, usagePercent, cb)
    → AC-6 guard (usagePercent < 50 → return)
    → FR-1: gradient lookup → retentionSegs
    → FR-2: computeCompressionScope → historySegments (subset)
    → FR-3: spawn LLM → validate → append to tree (or retry/fallback)
    → compressedSegIds.add(seg.segId) for all compressed segs
    → onComplete → ui.notify

context event → createContextHandler
  → tracker.getRetentionWindow(usagePercent)
  → compactor.getCompressedSegIds()
  → assembler.assembleMessages(msgs, tree, segs, retention, compressedSegIds, ctxWindow)
    → filter compressed seg messages (AC-4)
    → inject tree summaries + recall prompt
    → return modified messages

session_start → restoreState
  → compactor.restoreState → collectCompressedSegIds(tree.root)
  → tracker.restoreState → segments from entries
```

数据流完整，无断裂。

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | LOW | context-handler.ts:L155-167 | `compressedSegIds` 参数使用 `Set<string> \| number` 联合类型做向后兼容。这是因为旧调用者传 5 个位置参数 `(msg, tree, seg, ret, contextWindow)`。现在 index.ts 已经是唯一调用者且已更新为传 Set，向后兼容层可考虑后续移除。 | 后续版本可移除 union type，改为纯 `Set<string> \| undefined` |
| 2 | LOW | context-handler.ts:L170-191 | compressedSegIds 过滤逻辑通过数 user 消息数来确定跳过范围，而非精确匹配 segId。这依赖"消息顺序 = 段顺序"的假设。当前 Pi 架构中该假设成立（每个 user message 触发新段），但如果未来消息顺序与段顺序不一致（如 tool result 消息穿插），此过滤可能误切。 | 当前可行。未来如消息模型变化，需改为基于 segment turnRange 的精确匹配 |
| 3 | INFO | tree-compactor.ts | `_buildPreviousSummarySection` 和 `_buildIncrementalPrompt` 用下划线前缀标记为 deprecated 但未删除，占约 50 行。 | 可在后续清理中删除 |

## 集成验证

- **Hook 注册 → 调用链**：`pi.on("turn_end", ...)` → `createTurnEndHandler` → `compactor.triggerCompression` ✓
- **Hook 注册 → 调用链**：`pi.on("context", ...)` → `createContextHandler` → `assembler.assembleMessages` ✓
- **Hook 注册 → 调用链**：`pi.on("session_start", ...)` → `restoreState` (tracker + compactor) ✓
- **compressedSegIds 生命周期**：`restoreState` 重建 → `triggerCompression` 追加 → `getCompressedSegIds` 暴露 → `assembleMessages` 消费 ✓
- **session_before_compact**：仅在 `compactor.getTree()` 存在时取消原生 compact ✓

## 测试覆盖

| 测试文件 | 用例数 | 覆盖范围 |
|---------|--------|---------|
| types.test.ts | 12 | RETENTION_GRADIENT 梯度值、COMPRESSION_CONFIG 值、IContextUsage shape |
| segment-tracker.test.ts | 15 | getRetentionWindow 全梯度、边界值（0/50/70/80/90/100）、活跃段、空段 |
| tree-compactor.test.ts | 18 | computeCompressionScope 全场景、compressedSegIds 重建/拷贝、append 结构、AC-5/AC-6 |
| context-handler.test.ts | 7 | compressedSegIds 过滤（bloated/not bloated）、向后兼容、无 tree 路径 |
| **合计** | **52** |  |

全部 66 测试通过（52 infinite-context + 14 evolution-engine，evolution-engine 的 process.exit(0) 是预存问题）。

## 结论

**通过**。所有 6 个 AC 和 7 个 FR 均正确实现，数据流完整无断裂，测试覆盖充分。3 条 LOW/INFO 建议不阻塞。

### Summary

BLR编码评审完成，第1轮通过，0条MUST FIX，3条LOW/INFO。
