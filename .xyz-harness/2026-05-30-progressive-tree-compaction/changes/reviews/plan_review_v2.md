---
review:
  type: plan_review
  round: 2
  timestamp: "2026-05-30T23:30:00"
  target: ".xyz-harness/2026-05-30-progressive-tree-compaction/plan.md"
  verdict: pass
  summary: "计划评审第2轮，0条MUST FIX（5条已修复），所有核心问题已解决，通过"

statistics:
  total_issues: 10
  must_fix: 0
  must_fix_resolved: 5
  low: 4
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 3 (Change D)"
    title: "compressedSegIds 仅存内存，session 重启后丢失"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 4"
    title: "Task 4 过滤逻辑设计不自洽"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 3
    severity: MUST_FIX
    location: "plan.md:Task 3 (Change B)"
    title: "computeCompressionScope 估算公式与 spec FR-2 不一致"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 4
    severity: MUST_FIX
    location: "plan.md:Task 3 (Change C)"
    title: "增量提示词 buildIncrementalPrompt 要求重写整棵树，与追加模式冲突"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 5
    severity: MUST_FIX
    location: "plan.md:Task 3 (Change A → runCompression)"
    title: "现有 runCompression 每次创建全新 root，append 逻辑无处落地"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 6
    severity: LOW
    location: "plan.md:Task 1"
    title: "RETENTION_GRADIENT 使用 Infinity 值的类型问题"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 7
    severity: LOW
    location: "plan.md:Spec Coverage Matrix"
    title: "AC-5 在 e2e-test-plan.md 中无对应验证场景"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 8
    severity: LOW
    location: "plan.md:Task 2"
    title: "getRetentionWindow 双重守卫增加理解成本"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 9
    severity: LOW
    location: "plan.md:Task 5"
    title: "triggerCompression 入口与 lookupRetentionCount 双重守卫冗余"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 10
    severity: INFO
    location: "plan.md:Execution Groups"
    title: "tree-compactor.ts 加上变更后可能超 1000 行限制"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v2

## 评审记录
- 评审时间：2026-05-30 23:30
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-30-progressive-tree-compaction/plan.md` + `spec.md`
- 评审轮次：2（增量审查）

## MUST FIX 修复验证

### [FIXED] Issue #1: compressedSegIds session 重启丢失
**v1 问题**：`compressedSegIds` 仅存内存，`restoreState()` 未包含重建逻辑，session 重启后已压缩段会被重复压缩。

**修复确认**：Task 3 Change D 现在包含完整的重建链路：
- `restoreState()` 清空 `compressedSegIds`，找到最后一个 `ic-compact-tree` entry 后调用 `collectCompressedSegIds(this.tree.root)`
- `collectCompressedSegIds()` 递归遍历树的所有节点，收集 `segId`（包括 leaf 节点）
- 压缩成功后也显式 `this.compressedSegIds.add(seg.segId)` 做增量更新
- ✅ 修复充分，无遗漏

### [FIXED] Issue #2: Task 4 过滤逻辑自相矛盾
**v1 问题**：Task 4 经历多次自我否定，最终给出 `truncateByEstimatedChars` 按字符砍，不区分段归属。

**修复确认**：Task 4 现在设计清晰：
- `assembleMessages()` 接受可选 `compressedSegIds: Set<string>` 参数
- 过滤策略：先从 `segments` 中筛选属于 `compressedSegIds` 的段，计数 `userMsgCount`，然后从 `filtered` 数组头部跳过 N 个 user 消息及其 assistant 回复
- 依赖前提："compressed segments are always the oldest"（与 FR-2 一致：从最旧段开始压缩）
- `AssembleResult` 新增 `compressedSegIds` 字段用于监控
- ✅ 设计自洽，策略明确

### [FIXED] Issue #3: computeCompressionScope 公式不一致
**v1 问题**：分母缺少系统提示词估算，`perSegmentTokens` 与额外 `groupOverheadTokenPerSeg` 叠加导致每段估了 75 tokens 而非 spec 的 63。

**修复确认**：
- `perSegmentTokens = 63`（注释明确 "包含 leaf 摘要 ~50t + group 开销 ~13t"），无额外的 group 开销参数
- 分母包含 `systemPromptEstimate = 4000`
- 公式与 spec FR-2 对齐：`estimatedAfter = segs.length * 63 + existingTreeSize`，`denominator = existingTreeSize + retentionMsgSize + historyTotalDigest + 4000`
- ✅ 公式已对齐

### [FIXED] Issue #4: 增量提示词与追加模式冲突
**v1 问题**：`buildIncrementalPrompt` 指令要求 "Output a JSON array of ALL tree nodes"，与追加语义矛盾。

**修复确认**：plan 明确声明 "废弃 `buildIncrementalPrompt`"。当 `existingTree` 存在时：
- 使用单一 `buildInitialPrompt`（含 `existingGroupsContext` 段落）
- LLM 只输出新段的 groups，不重写旧 groups
- 代码层面在 `runCompression` 成功回调中做 append
- ✅ 提示词与代码逻辑一致

### [FIXED] Issue #5: runCompression 缺少 append 逻辑
**v1 问题**：`runCompression` close handler 总是创建全新 root，旧 groups 被丢弃。

**修复确认**：Task 3 Change E 明确展示了 append 逻辑：
- 当 `existingTree` 存在时：`root.children = [...oldChildren, ...newChildren]`
- 首次压缩：保持原有逻辑不变
- ✅ append 逻辑完整

## LOW/INFO 状态更新

### [FIXED] Issue #6: Infinity 类型问题
改用 `9999` sentinel 值替代 `Infinity`，避免 `as const` 类型推导问题。✅

### [FIXED] Issue #7: AC-5 e2e 验证场景缺失
e2e-test-plan.md 新增 Scenario 8: "Compression ratio stability (AC-5)"，覆盖了连续 3 次压缩的预估/实际比例偏差 ≤ ±20pp 验证。✅

### [OPEN] Issue #8: 双重守卫理解成本
getRetentionWindow 的梯度表首项 `usageMax=50, retainCount=9999` 与 triggerCompression 的 < 50% 跳过逻辑重叠。不阻塞，但建议在代码注释中说明意图。

### [OPEN] Issue #9: 触发阈值冗余
createTurnEndHandler 不检查 usagePercent < 50% 就调用 triggerCompression，triggerCompression 内部通过 lookupRetentionCount 处理。两层逻辑语义相同但位置不同。不阻塞，实现时统一即可。

### [OPEN] Issue #10: tree-compactor.ts 行数风险
当前 958 行 + 新增代码可能接近 1060 行。如果超 1000 行限制，需提取 helper 函数。实现时注意即可。

## 回归检查

未发现修复引入的新问题。各 Task 之间的接口签名（参数、返回值）在 plan 中保持一致：
- Task 2 `getRetentionWindow(usagePercent)` → Task 5 调用处传参一致
- Task 3 `triggerCompression(..., usagePercent, existingTree, ...)` → Task 5 调用处一致
- Task 3 `getCompressedSegIds()` → Task 4 + Task 5 调用处一致
- Task 4 `assembleMessages(..., compressedSegIds?, ...)` → Task 5 调用处一致

## 结论

通过。第 1 轮的 5 条 MUST FIX 全部已修复，无回归，无新增 MUST FIX。

### Summary

计划评审完成，第2轮通过，0条MUST FIX（5条已修复）。
