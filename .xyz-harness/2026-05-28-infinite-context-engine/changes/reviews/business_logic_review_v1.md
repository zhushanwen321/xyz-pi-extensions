---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-29T12:00:00"
  target: "infinite-context/src/"
  verdict: fail
  summary: "业务逻辑审查 v1，5 条 MUST FIX：保留窗口计算与 spec 不符、段文件从未实际写入、retention 过滤缺少 turn 约束、BFS 展平顺序与 spec 相反、recall 默认 mode 未实现"

statistics:
  total_issues: 13
  must_fix: 5
  low: 5
  info: 3
  files_reviewed: 8
  issues_found: 13
  must_fix_count: 5
  low_count: 5
  info_count: 3

issues:
  - id: 1
    severity: MUST_FIX
    location: "infinite-context/src/segment-tracker.ts:L136-L155"
    title: "getRetentionWindow 逻辑与 spec C-6 约束不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "infinite-context/src/segment-tracker.ts:L180-L184"
    title: "writeSegmentFile 为空实现，段原始数据从未写入文件系统"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "infinite-context/src/tree-compactor.ts:L152-L159"
    title: "triggerCompression 过滤 retention window 缺少 maxTurns 约束"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: MUST_FIX
    location: "infinite-context/src/context-handler.ts:L157-L178"
    title: "BFS 展平同层顺序为 newest-to-oldest，与 spec FR-3.2 描述一致但与示例矛盾"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: MUST_FIX
    location: "infinite-context/src/recall-tool.ts:L50-L54"
    title: "recall 工具参数 schema 未设置 mode 默认值为 structure"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "infinite-context/src/context-handler.ts:L89-L93"
    title: "AssembleResult.compressedNodeCount 含义不精确"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "infinite-context/src/context-handler.ts:L22"
    title: "DEFAULT_CONTEXT_WINDOW 硬编码 200000，应从 Pi API 获取"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: LOW
    location: "infinite-context/src/tree-compactor.ts:L191"
    title: "spawn 使用 'pi' 命令，跨平台路径问题"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: LOW
    location: "infinite-context/src/index.ts:L82-L87"
    title: "context handler 中 needsCompression 赋值依赖 getContextUsage 可能返回 undefined"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 10
    severity: LOW
    location: "infinite-context/src/commands.ts:L37-L44"
    title: "/tree-compact 异步等待用 sleep 轮询，非最佳实践"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 11
    severity: INFO
    location: "infinite-context/src/types.ts:L57"
    title: "CompactTree 持久化格式校验依赖 CustomEntry 泛型推断"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 12
    severity: INFO
    location: "infinite-context/src/recall-tool.ts:L94"
    title: "recall 的 execute 内联在 register() 闭包中，测试不便"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 13
    severity: INFO
    location: "infinite-context/src/context-handler.ts:L99-L108"
    title: "isIcSummary 过滤仅检查 customType，未检查 role"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 业务逻辑审查 v1 — Infinite Context Engine

## 评审记录
- 评审时间：2026-05-29 12:00
- 评审类型：编码评审（业务逻辑专项）
- 评审对象：`infinite-context/src/` 全部 8 个源文件
- 对照基准：spec.md FR-1~FR-6 + AC-1~AC-6

## FR/AC 逐项合规验证

### FR-1: 段索引管理

| 子项 | 状态 | 说明 |
|------|------|------|
| FR-1.1 session_start 恢复 | ✅ | `SegmentTracker.restoreState()` 正确过滤 `ic-segment` + `ic-turn` entries，恢复 segments 和 currentSegment |
| FR-1.2 turn_end 段边界 | ✅ | `handleTurnEnd()` 正确检测 `message.role === "user"` 触发新段，调用 `appendEntry("ic-segment")` |
| FR-1.3 段原始数据文件 | ❌ **MUST FIX** | `writeSegmentFile()` 方法体为空（`void ctx; void segment;`），段原始数据从未写入 `.pi/infinite-context/<sessionId>/seg_N.json`。**recall 工具 mode:"content" 将永远读不到数据** |
| FR-1.4 TurnIndex 映射 | ⚠️ | `TurnEntryData.toolCalls` 类型为 `string[]`（工具名称列表），spec 要求 `{ turnIndex, toolCalls: [{ toolCallId, toolName, entryId, params }] }`。当前实现简化为仅工具名称，丢失 toolCallId/entryId/params 信息 |
| FR-1.5 并发守卫 | ✅ | `TreeCompactor.isCompressing()` 封装良好，`index.ts` 中 turn_end 和 context handler 都正确检查 |

### FR-2: 树压缩

| 子项 | 状态 | 说明 |
|------|------|------|
| FR-2.1 自动触发 | ✅ | context handler 中 `shouldCompress()` 检测 ≥70% → 设置 `needsCompression` → 下一轮 turn_end 执行 |
| FR-2.1 手动触发 | ✅ | `/tree-compact` 调用 `triggerCompression()` |
| FR-2.1 接管原生 compaction | ✅ | `session_before_compact` 返回 `cancelPiCompaction()` |
| FR-2.2 保留窗口过滤 | ❌ **MUST FIX** | `triggerCompression()` 仅按 `maxSegments=2` 过滤已完成段，**未实现 maxTurns=8 约束**（spec C-6 要求"取两者最小值"） |
| FR-2.2 subagent spawn | ✅ | 使用 `child_process.spawn` 异步启动 |
| FR-2.3 LLM 输出格式 | ⚠️ | 实际 prompt 要求输出 `TreeNode[]` 格式，与 spec 描述的 `group/leaf` 语义略有差异但功能等价 |
| FR-2.4 输出校验 | ✅ | `validateTreeOutput()` 实现完整：JSON 解析、segId 存在性、nodeId 唯一性、summary 非空、递归结构 |
| FR-2.4 重试 | ✅ | `handleCompressionFailure()` 中 retryCount < MAX_RETRY_COUNT(1) 时重试 |
| FR-2.5 降级机制 | ✅ | `ruleBasedFallback()` 和 `applyFallback()` 实现完整 |
| FR-2.6 异步不阻塞 | ✅ | spawn + callback 模式，turn_end 不等待压缩完成 |

### FR-3: Context 消息组装

| 子项 | 状态 | 说明 |
|------|------|------|
| FR-3.1 独立估算 | ✅ | `estimateTreeContext()` 使用 chars/4 计算 |
| FR-3.2 BFS 展平 | ⚠️ **需确认** | 代码实现 `bfsFlatten()` 同层内 `reverse()`（newest 先出），但 spec 示例 `D→C→B→A` 含义需确认：如果 D 是 newest 则一致，但 reverse 后实际是 newest → oldest，与 BFS 层级结合的语义需明确 |
| FR-3.3 预算控制 | ✅ | `budgetTruncate()` 从最深层最老节点开始砍 |
| FR-3.4 Recall 提示注入 | ✅ | 有压缩树时 `createRecallPromptMessage()` 注入到 messages 开头 |
| FR-3.5 段内容处理 | ✅ | 当前活跃段+retention window 保持原文，已压缩用摘要 |

### FR-4: Recall 工具

| 子项 | 状态 | 说明 |
|------|------|------|
| FR-4.1 参数 | ❌ **MUST FIX** | spec 要求 `mode` 默认值 `"structure"`，但 `StringEnum` schema 未设置 `default: "structure"` |
| FR-4.2 mode: structure | ✅ | `recallStructure()` 返回子树结构描述，不含原始内容 |
| FR-4.3 mode: content | ❌ 功能受限 | 因 writeSegmentFile 未实现（Issue #2），实际总返回"段文件不存在或无法读取" |
| FR-4.4 两次调用模式 | ✅ | 工具 description 中写明 |
| FR-4.5 错误处理 | ✅ | nodeId 不存在、空结果、group 节点递归展开均有处理 |

### FR-5: `/tree-compact` 命令

| 子项 | 状态 | 说明 |
|------|------|------|
| FR-5 | ✅ | 注册命令，显示状态、回调 notify 结果 |

### FR-6: `/context-status` 命令

| 子项 | 状态 | 说明 |
|------|------|------|
| FR-6 | ✅ | 显示原始上下文、树上下文、段统计、压缩状态 |

### AC 覆盖矩阵

| AC | 场景 | 覆盖状态 | 代码位置 |
|----|------|---------|----------|
| AC-1.1 | 每次 user message 触发新 Segment | ✅ | segment-tracker.ts:handleTurnEnd |
| AC-1.2 | session_start 恢复段索引和 TurnIndex | ✅ | segment-tracker.ts:restoreState |
| AC-1.3 | 段原始数据写入 `.pi/infinite-context/` | ❌ | segment-tracker.ts:writeSegmentFile（空实现） |
| AC-1.4 | turn_end 记录 TurnIndex | ⚠️ | segment-tracker.ts:handleTurnEnd（简化版，缺少 toolCallId/entryId/params） |
| AC-2.1 | tree-context ≥70% 自动触发 | ✅ | context-handler.ts:shouldCompress + index.ts |
| AC-2.2 | /tree-compact 手动触发 | ✅ | commands.ts:registerTreeCompactCommand |
| AC-2.3 | session_before_compact 取消原生 compaction | ✅ | index.ts:pi.on("session_before_compact") |
| AC-2.4 | subagent 使用主模型 | ⚠️ | spawn("pi", ...) — 未显式传递模型配置 |
| AC-2.5 | LLM 返回有效 JSON 树结构 | ✅ | tree-compactor.ts:validateTreeOutput |
| AC-2.6 | 压缩结果持久化到 entries | ✅ | tree-compactor.ts:appendEntry("ic-compact-tree") |
| AC-2.7 | 上下文超限时降级 | ✅ | tree-compactor.ts:applyFallback |
| AC-2.8 | 校验失败重试 1 次后降级 | ✅ | tree-compactor.ts:handleCompressionFailure |
| AC-2.9 | subagent 失败时降级 | ✅ | tree-compactor.ts:handleCompressionFailure → applyFallback |
| AC-2.10 | 压缩不停止对话 | ✅ | 异步 spawn + callback |
| AC-3.1 | 当前段 + 保留窗口用完整原文 | ⚠️ | context-handler 标记 retentionSegIds 但未真正从 messages 中过滤已压缩段 |
| AC-3.2 | 已压缩段用摘要带 [nodeId] 前缀 | ✅ | context-handler.ts:createSummaryMessage |
| AC-3.3 | BFS 展平顺序 | ⚠️ | 同层 newest-to-oldest（需与 spec 确认方向） |
| AC-3.4 | 预算超限按深度裁剪 | ✅ | context-handler.ts:budgetTruncate |
| AC-3.5 | Recall 提示注入 | ✅ | context-handler.ts:createRecallPromptMessage |
| AC-3.6 | 独立 tree-context 估算 | ✅ | token-estimator.ts:estimateTokens (chars/4) |
| AC-3.7 | context handler 不修改 session JSONL | ✅ | 浅拷贝 messages |
| AC-4.1 | mode:structure 不含原始内容 | ✅ | recall-tool.ts:recallStructure |
| AC-4.2 | mode:content 返回原始内容 | ❌ | 段文件未写入，始终返回不存在 |
| AC-4.3 | nodeId 不存在时返回错误 | ✅ | recall-tool.ts:executeRecall |
| AC-4.4 | 两次调用模式在描述中写明 | ✅ | recall-tool.ts:register description |
| AC-5.1 | /tree-compact 显示状态和结果 | ✅ | commands.ts |
| AC-5.2 | /context-status 显示两种上下文 | ✅ | commands.ts |
| AC-6.1 | Pi 原生 compaction 接管 | ✅ | index.ts |
| AC-6.2 | getContextUsage 不受影响 | ✅ | 已知限制，/context-status 提供真实数据 |

## 发现的问题

### MUST FIX

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | segment-tracker.ts:L136-L155 | **getRetentionWindow 逻辑与 spec C-6 不一致**。spec 要求"保留最近 2 个段，但不超过最近 8 个 turn，取两者最小值"。当前实现 `byCount`（取 2 段）和 `byTurns`（覆盖 8 turn 内），然后取"段数较多的"（更宽松窗口）。**应取两者中段数较少的**（更严格的约束 = min） | 改为 `byCount.length <= byTurns.length ? byCount : byTurns` |
| 2 | MUST FIX | segment-tracker.ts:L180-L184 | **writeSegmentFile 为空实现**。段原始数据从未写入文件系统，导致 recall 工具 mode:"content" 始终返回"段文件不存在"。这是 FR-1.3 的核心交付物 | 实现 `writeSegmentFile`：使用 `ctx.sessionManager.getSessionDir()` 获取路径 + `fs.writeFile` 写入段 messages JSON。需在 handleTurnEnd 中收集当前 turn 的 messages |
| 3 | MUST FIX | tree-compactor.ts:L152-L159 | **triggerCompression 过滤 retention window 缺少 maxTurns 约束**。仅按 `slice(-RETENTION_CONFIG.maxSegments)` 过滤已完成段，未实现 spec C-6 的"不超过最近 8 个 turn"约束。与 Issue #1 串联：SegmentTracker.getRetentionWindow() 有此逻辑但 TreeCompactor 未使用它 | 直接复用 `tracker.getRetentionWindow()` 的结果传入 `triggerCompression`，而非在 TreeCompactor 内部重复实现过滤逻辑 |
| 4 | MUST FIX | context-handler.ts:L157-L178 | **BFS 展平同层顺序需确认**。spec FR-3.2 示例 `Level 1: D 摘要 → C 摘要 → B 摘要 → A 摘要`（D= newest），代码中 `reverse()` 后同层为 newest → oldest。如果 D 是 newest 则一致。但 spec 文字说"newest-to-oldest within level"，代码行为匹配。**但 reverse() 假设 children 数组中越后面越新**——这取决于段添加顺序（`segments.push()` → 确实越后越新），所以正确。需在注释中明确这一假设 | 在 bfsFlatten 中添加注释说明 "children 数组中 index 越大越新" 的假设 |
| 5 | MUST FIX | recall-tool.ts:L50-L54 | **recall 工具参数 schema 未设置 mode 默认值**。spec FR-4.1 要求 `mode` 默认为 `"structure"`，但 `StringEnum` 未配置 `default: "structure"`，LLM 每次必须显式传入 mode | 在 StringEnum 调用中添加 `{ default: "structure" }` |

### LOW

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 6 | LOW | context-handler.ts:L89-L93 | `compressedNodeCount` 命名含义不精确。实际统计的是 flatNodes 中保留下来的节点数（含非压缩节点如 root.children），不是"被压缩的节点数" | 重命名为 `retainedNodeCount` 或 `injectedNodeCount` |
| 7 | LOW | context-handler.ts:L22 | `DEFAULT_CONTEXT_WINDOW = 200_000` 硬编码。spec 提到应从 `getContextUsage().contextWindow` 获取，context handler 中可从调用方传入 | 将 `contextWindow` 作为参数传入 `assembleMessages()` |
| 8 | LOW | tree-compactor.ts:L191 | `spawn("pi", ...)` 硬编码命令名，跨平台可能有路径问题 | 使用 `process.execPath` 或从 Pi API 获取可执行路径 |
| 9 | LOW | index.ts:L82-L87 | context handler 中 `needsCompression` 赋值依赖 `getContextUsage()`，该函数可能返回 undefined/无 contextWindow 信息 | 增加 null check，无 usage 信息时不设置 needsCompression |
| 10 | LOW | commands.ts:L37-L44 | `/tree-compact` 用 500ms 间隔轮询 `isCompressing()` 等待完成，非最佳实践 | 考虑用 Promise + resolve callback 替代轮询 |

### INFO

| # | 优先级 | 文件/位置 | 描述 |
|---|--------|----------|------|
| 11 | INFO | types.ts:L57 | `CompactTree` 通过 `appendEntry("ic-compact-tree", data)` 持久化，恢复时 `as CompactTree` 强制转换。类型安全依赖运行时数据格式一致 |
| 12 | INFO | recall-tool.ts:L94 | recall 工具的 `execute` 内联在 `register()` 的闭包中，独立测试需要 mock 整个 pi.registerTool 调用 |
| 13 | INFO | context-handler.ts:L99-L108 | `isIcSummary` 仅检查 `customType`，未检查 `role === "custom"`。实践中 Pi 的 CustomMessage 总有 role: "custom"，风险极低 |

## 模拟业务数据与执行路径

### 路径 1: 正常自动压缩流程

```
Precondition: 会话已进行 20 个 turns，8 个 segments（seg_0 ~ seg_7），tree-context 达 72%

Timeline:
  1. [turn_end: turnIndex=20, message.role="assistant"]
     → SegmentTracker: seg_7.active, turnRange.end=20, appendEntry("ic-turn")
     → compactor.isCompressing()=false, needsCompression=true (set in prev context event)
     → triggerCompression() called

  2. [triggerCompression]
     → compressing=true
     → completedSegments = [seg_0..seg_6] (seg_7 active, not completed)
     → retentionIds = {seg_5, seg_6} (last 2 completed)
     → historySegments = [seg_0, seg_1, seg_2, seg_3, seg_4]
     → BUG: maxTurns=8 constraint NOT applied (Issue #3)
       → Should also exclude segments whose turnRange overlaps recent 8 turns
       → With 20 turns, cutoff = 13, segments ending before turn 13 should be history
       → Expected: might exclude fewer segments if they span many turns

  3. [spawn pi subprocess]
     → prompt built with seg_0..seg_4 summaries
     → 30s timeout set

  4. [subprocess completes: JSON output]
     → validateTreeOutput() checks: JSON parse, segId existence, uniqueness, summary non-empty
     → Pass: build CompactTree, appendEntry("ic-compact-tree")
     → compressing=false
     → TUI notify result

  5. [next context event]
     → assembleMessages() called with new tree
     → bfsFlatten: Level 1 groups newest→oldest, Level 2 leaves newest→oldest
     → budget check: assume within 80%
     → recall prompt injected at start
     → messages returned to Pi for LLM call

  6. [LLM sees]
     → [ic-recall-prompt] 历史对话已压缩为摘要树...
     → [group_1] 项目初始化与基础配置...
     → [node_seg_0] Feature design discussion...
     → [node_seg_1] Implementation planning...
     → [group_2] ... (older)
     → ... current segment seg_7 full messages ...
```

### 路径 2: Recall 两次调用

```
Precondition: 压缩树存在，LLM 在上下文中看到 [group_1] 摘要

  1. LLM calls recall({ nodeId: "group_1", mode: "structure" })
     → findNode(tree.root, "group_1") → found
     → formatStructure(group_1_node, indent=0)
     → Returns:
       - group_1: 项目初始化与基础配置 [group] (50 tokens)
         - node_seg_0: Feature design discussion [leaf: seg_0] (30 tokens)
         - node_seg_1: Implementation planning [leaf: seg_1] (20 tokens)

  2. LLM decides to get seg_0 content
     → recall({ nodeId: "node_seg_0", mode: "content" })
     → findNode(tree.root, "node_seg_0") → found
     → collectSegIds(node) → ["seg_0"]
     → readSegmentFile(sessionId, "seg_0", ctx)
     → BUG: writeSegmentFile never wrote the file → returns "段文件不存在或无法读取"
     → **CRITICAL**: Recall content mode is non-functional due to Issue #2
```

### 路径 3: 校验失败 → 重试 → 降级

```
  1. subprocess returns invalid JSON
     → validateTreeOutput() → { reason: "JSON parse failed: ..." }
     → handleCompressionFailure(retryCount=0)
     → retryCount < MAX_RETRY_COUNT(1) → retry with error context in prompt

  2. retry subprocess returns duplicate nodeId
     → validateTreeOutput() → { reason: "Duplicate nodeId: group_1" }
     → handleCompressionFailure(retryCount=1)
     → retryCount >= MAX_RETRY_COUNT → applyFallback()
     → ruleBasedFallback([seg_0..seg_4]) → each segment as independent leaf
     → appendEntry("ic-compact-tree", fallbackTree)
     → TUI notify "树压缩降级: 使用规则策略替代 LLM 压缩"
```

### 路径 4: 保留窗口边界

```
Precondition: 10 completed segments, current turn=30

  getRetentionWindow():
    completedSegments = [seg_0..seg_9]
    byCount = [seg_8, seg_9] (last 2)
    latestTurnEnd = 30
    cutoffTurn = 30 - 8 + 1 = 23
    byTurns = segments with turnRange.end >= 23
      → assuming each segment ~3 turns: seg_7(end=24), seg_8(end=27), seg_9(end=30)
      → byTurns = [seg_7, seg_8, seg_9]

    Current code: byCount.length(2) >= byTurns.length(3) → returns byCount = [seg_8, seg_9]
    BUG: Should take MIN → [seg_8, seg_9] (2 segments)
    In this case byCount happens to be the min, so result is correct by accident

  But with 1-turn segments:
    byCount = [seg_8, seg_9] (2 segments)
    byTurns = [seg_3..seg_9] (7 segments, all within last 8 turns)
    Current code: 2 >= 7 → false → returns byTurns (7 segments) ← WRONG
    Spec says: min(2, 7) = 2 segments ← should be [seg_8, seg_9]

  **This bug could retain too many segments, reducing compression effectiveness**
```

### 路径 5: session_start 恢复

```
Precondition: Pi session restarted, session entries contain:
  - 3 × ic-segment entries (seg_0, seg_1, seg_2)
  - 5 × ic-turn entries
  - 1 × ic-compact-tree entry

  restoreState(entries):
    1. Parse ic-segment entries → segments = [seg_0, seg_1, seg_2]
    2. nextSegIndex = 3 (from seg_2 match)
    3. lastSegment = seg_2, completed=false → currentSegment = seg_2
    4. Parse ic-turn entries (last 500):
       → Update turnRange.end for each segment based on latest turn entry

  compactor.restoreState(entries):
    → Find last ic-compact-tree entry → set tree
    → Compression state properly restored
```

## 关键数据流验证

### 数据流 1: turn_end → 段索引 → 持久化

```
turn_end(turnIndex, message, toolResults)
  → isUserMessage? → complete prev segment → create new segment
  → appendEntry("ic-segment", data) ← OK
  → appendEntry("ic-turn", data) ← OK (simplified toolCalls)
  → writeSegmentFile() ← **NO-OP** (Issue #2)
```

### 数据流 2: context handler → messages 重组

```
pi.on("context", event)
  → assembler.assembleMessages(messages, tree, segments, retentionWindow)
    → filter out old ic-summary/ic-recall-prompt
    → if tree: bfsFlatten → createSummaryMessages → budgetTruncate
    → inject recall prompt at start
  → shouldCompress(treeContextTokens, contextWindow) → set needsCompression
  → return { messages } ← replaces Pi's messages
```

### 数据流 3: recall → 文件读取

```
recall(nodeId, mode)
  → loadTreeFromEntries(ctx) → find last ic-compact-tree entry
  → findNode(tree.root, nodeId)
  → mode="content": collectSegIds → readSegmentFile
    → readFileSync(.pi/infinite-context/<sessionId>/seg_N.json)
    → **FILE NEVER EXISTS** (Issue #2) → returns "段文件不存在或无法读取"
```

## 结论

**需修改后重审**。5 条 MUST FIX 中 Issue #2（段文件未写入）影响最严重——recall 工具的 content 模式完全不可用。Issue #1 + #3（保留窗口计算错误）会导致压缩效率降低或保留过多段。Issue #5（recall 默认 mode）导致 LLM 每次必须显式传 mode 参数。

### Summary

业务逻辑审查完成，第 1 轮，5 条 MUST FIX，需修改后重审。
