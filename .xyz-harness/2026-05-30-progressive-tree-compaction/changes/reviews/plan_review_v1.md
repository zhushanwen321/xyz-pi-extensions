---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-30T22:15:00"
  target: ".xyz-harness/2026-05-30-progressive-tree-compaction/plan.md"
  verdict: fail
  summary: "计划评审第1轮，5条MUST FIX：compressedSegIds 恢复丢失、Task 4 过滤逻辑自我否定、computeCompressionScope 公式与 spec 不一致、增量提示词未适配追加模式、append 树逻辑与现有 runCompression 冲突"

statistics:
  total_issues: 10
  must_fix: 5
  must_fix_resolved: 0
  low: 4
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 3 (Change D)"
    title: "compressedSegIds 仅存内存，session 重启后丢失"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 4"
    title: "Task 4 前半段声明需要过滤，后半段又否定，设计不自洽"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "plan.md:Task 3 (Change B)"
    title: "computeCompressionScope 估算公式与 spec FR-2 不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: MUST_FIX
    location: "plan.md:Task 3 (Change C)"
    title: "增量提示词 buildIncrementalPrompt 要求重写整棵树，与追加模式冲突"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: MUST_FIX
    location: "plan.md:Task 3 (Change A → runCompression)"
    title: "现有 runCompression 每次创建全新 root，append 逻辑无处落地"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "plan.md:Task 1"
    title: "RETENTION_GRADIENT 使用 Infinity 值，与 ReadonlyArray + as const 的类型推导冲突"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: LOW
    location: "plan.md:Spec Coverage Matrix"
    title: "AC-5 标注为 Post-Task 3 verification，但 e2e-test-plan.md 中无对应验证场景"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: LOW
    location: "plan.md:Task 2"
    title: "getRetentionWindow 梯度表首项 usageMax=50 会导致 usagePercent=0 时返回 all，但 spec 要求 <50% 不压缩"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 9
    severity: LOW
    location: "plan.md:Task 5"
    title: "createTurnEndHandler 中 usagePercent < 50 时直接不调用 triggerCompression，但 triggerCompression 内部也有 <50 跳过逻辑，双重守卫冗余"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 10
    severity: INFO
    location: "plan.md:Execution Groups"
    title: "BG1 标注 5 个文件全修改，但未考虑 tree-compactor.ts 当前 958 行，加上所有变更可能超 1000 行限制"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-30 22:15
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-30-progressive-tree-compaction/plan.md` + `spec.md`
- 评审轮次：1

## 1. spec 完整性

### 目标明确性 ✅
spec 开头用一段话清晰说明了目标：将 Tree Compactor 改造为渐进式压缩引擎。Background 部分列出了三个具体问题，功能需求 FR-1~FR-7 都是对这三个问题的直接回应。

### 范围合理性 ✅
范围限定在 `infinite-context` 扩展内的 4-5 个文件，不涉及其他扩展或 Pi 核心。4 个 source files + index.ts 的修改量适中。

### 验收标准可量化 ✅
AC-1~AC-6 均可写测试验证。AC-5 的 "±20 个百分点" 是量化指标。无模糊描述。

### 待决议项 ✅
无 `[待决议]` 标记。

### 小结
spec 质量较高，目标清晰，范围合理，AC 可量化。无阻塞问题。

## 2. plan 可行性

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plan.md:Task 3 (Change D) | **compressedSegIds 仅存内存，session 重启后丢失**。plan 声明 `compressedSegIds` 是 TreeCompactor 的内存字段（`Set<string>`），但 `restoreState()` 只恢复最后一个 `ic-compact-tree` entry。如果 session 中途 Pi 重启，`compressedSegIds` 清空，会导致已压缩的段被重复压缩。non-functional-design.md 第 2 节提到"从 entries 重建（推断哪些 segId 被压缩）"，但 plan 的 Task 3 没有包含重建逻辑的实现。 | Task 3 中必须增加 `restoreState` 的重建逻辑：遍历树中所有 leaf 节点的 `segId`，加入 `compressedSegIds`。这是确定性操作，不需要额外持久化。 |
| 2 | MUST FIX | plan.md:Task 4 | **Task 4 设计自相矛盾**。前半段 spec 要求 "过滤已压缩段的原文（不再传给 LLM）"（对应 AC-4），但 Task 4 的设计过程经历了几次自我否定：先写 "better alternative"，又说 "push complexity up"，然后说 "keep current truncation behavior"，最后给出了一个 `truncateByEstimatedChars` 实现。这个实现按 chars 从 messages 开头砍，完全不区分哪些 messages 属于被压缩段，可能误砍保留窗口内的 messages。 | 需要明确选择一种策略：要么（A）实现精确的 segId→message 映射过滤，要么（B）承认现有 budget truncation 已经隐式处理并删除 Task 4 的过滤逻辑。当前 "用 chars 估算从头部砍" 的方案既不精确也不安全。 |
| 3 | MUST FIX | plan.md:Task 3 (Change B) | **computeCompressionScope 估算公式与 spec FR-2 不一致**。spec FR-2 定义的分母是 `当前上下文总大小（包含所有原始段 digest、旧树、保留段）`，但 plan 的实现中分母只包含 `existingTreeSize + retentionMsgSize + historyTotalDigest`，缺少了 `系统提示词` 部分（spec 的公式明确提到分母包含系统提示词）。另外，spec 的单段预估公式是 `63 tokens/段`（包含 leaf 摘要 50 tokens + group 开销 25 tokens/4 = ~13 tokens），但 plan 中 `perSegmentTokens=63` 加上额外的 `groupOverheadTokenPerSeg=12`，等于每段实际估了 63+12=75 tokens，与 spec 的 63 不一致。 | 对齐 spec FR-2 的公式。如果 `perSegmentTokens=63` 已包含 group 开销，则应删除 `groupOverheadTokenPerSeg`。如果不含，则 spec 中的 63 应修正。同时考虑是否需要在分母中加入系统提示词估算。 |
| 4 | MUST FIX | plan.md:Task 3 (Change C) | **增量提示词与追加模式冲突**。现有 `buildIncrementalPrompt` 的指令是 "Output a JSON array of ALL tree nodes (both old and new, fully merged)"，要求 LLM 重写整棵树。但 spec FR-3 明确要求追加模式："新产出的 group 追加到旧树的 root.children 末尾。旧树中已有的 group 原封不动保留"。plan 虽然添加了 `buildExistingGroupsSection` 告知 LLM 旧 groups 存在，但 `buildIncrementalPrompt` 的主干指令仍然是 "Output a JSON array of ALL tree nodes"。LLM 会困惑于 "只输出新 groups" 还是 "输出全部 nodes"。 | 有两种修法：（A）将增量提示词改为只要求输出新增的 groups（配合代码层面做 append），或（B）保留现有全量输出模式但在代码中将旧 groups 保留、仅替换 LLM 输出的新 groups。需要明确选择一种并保持提示词与代码逻辑一致。 |
| 5 | MUST FIX | plan.md:Task 3 (Change A) | **现有 runCompression 每次创建全新 root，append 逻辑无处落地**。当前 `tree-compactor.ts` 的 `runCompression` 成功回调中（line ~640-660）总是创建新的 `root` 和 `tree`：`const root = { nodeId: "root", children: result }`。而 spec FR-3 要求旧 groups 保留、新 groups 追加。plan 的 Change A 展示了新的 `triggerCompression` 调用 `runCompression`，但没有展示 `runCompression` 成功回调中如何做 append 而非替换。如果不修改 `runCompression` 的 close handler，每次压缩都会用新 root 覆盖旧 root，违背追加语义。 | Task 3 必须明确修改 `runCompression`（或新增回调逻辑）中树构建的代码：当 `existingTree` 存在时，`root.children = [...existingTree.root.children, ...newGroups]`。 |
| 6 | LOW | plan.md:Task 1 | **RETENTION_GRADIENT 使用 `Infinity` 值，与 `as const` 的类型推导可能冲突**。`ReadonlyArray<{ usageMax: number; retainCount: number }` 中 `retainCount: Infinity` 在 TypeScript strict 模式下推导为 `number`（非字面量类型），`as const` 会让它变成 `Infinity`（number 的特殊值）。虽然运行时正确，但 `Infinity >= completedSegments.length` 的比较在类型层面可能引发 taste-lint 的 `no-magic-numbers` 警告（虽然 Infinity 不算 magic number，但整个 gradient 表的 `50, 70, 80, 90, 100` 都是 magic numbers）。 | 考虑将梯度表改为函数 + if-else/if-else chain，或定义具名常量 `const ALL_SEGMENTS = Number.MAX_SAFE_INTEGER` 替代 `Infinity`。 |
| 7 | LOW | plan.md:Spec Coverage Matrix | **AC-5 标注为 "Post-Task 3 verification"，但 e2e-test-plan.md 中无对应验证场景**。e2e-test-plan.md 的 8 个场景中没有任何一个明确验证 "连续 3 次触发压缩，偏差 ≤ ±20pp"。Scenario 4 验证了 append-only，但不验证比例偏差。 | e2e-test-plan.md 中应增加一个 Scenario 或在 Scenario 3 中增加 AC-5 的偏差验证步骤。 |
| 8 | LOW | plan.md:Task 2 | **getRetentionWindow 的梯度查找逻辑与 spec FR-1 语义不对齐**。梯度表首项 `{ usageMax: 50, retainCount: Infinity }`，代码用 `if (usagePercent <= entry.usageMax)` 查找。当 `usagePercent = 30` 时匹配首项返回 Infinity（全部保留），这是正确的（< 50% 不压缩）。但 spec FR-6 的触发条件是 "≥ 50% → 触发"，这意味着 < 50% 时压缩根本不触发，`getRetentionWindow` 的返回值不会被使用。两层逻辑重叠——`getRetentionWindow` 自身处理了 < 50% 的情况，但调用方（triggerCompression）也会跳过 < 50%。 | 这不是 bug，但增加了理解成本。建议在 plan 或代码注释中明确说明双重守卫的意图：< 50% 的跳过发生在 triggerCompression 入口，getRetentionWindow 中的 Infinity 是防御性兜底。 |
| 9 | LOW | plan.md:Task 5 | **双重守卫冗余**。Task 5 的 `createTurnEndHandler` 不检查 usagePercent < 50%（直接调用 triggerCompression），但 Task 3 的 triggerCompression 内部用 `lookupRetentionCount` 检查。而 `createContextHandler` 中的 `needsCompressionRef.value` 的设置依赖 `shouldCompress`（阈值 70%），与 spec FR-6 的 50% 触发阈值不同。三处逻辑的阈值不一致：context handler 用 70%、triggerCompression 用 50%梯度、spec 说 50%。 | 明确唯一的触发决策点。建议在 index.ts 的 turn_end handler 中做 `usagePercent >= 50` 判断后再调用 triggerCompression，triggerCompression 内部不再做阈值判断（只做 isCompressing 和无历史段的守卫）。 |
| 10 | INFO | plan.md:Execution Groups | **tree-compactor.ts 当前 958 行**，加上 Change A~E（新增 computeCompressionScope ~40 行、buildExistingGroupsSection ~10 行、compressedSegIds 相关 ~15 行、lookupRetentionCount ~10 行，修改 triggerCompression ~30 行），总计可能接近 1060 行，超过 CLAUDE.md 的 1000 行限制。 | 如果实现后超限，需要将 helper 函数（如 buildExistingGroupsSection、computeCompressionScope 的纯函数部分）提取到独立文件。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

### 结论

需修改后重审。

## 3. spec 与 plan 一致性

逐条对照：

| Spec 条目 | Plan 覆盖 | 一致性 | 备注 |
|-----------|----------|--------|------|
| FR-1 动态保留窗口 | Task 1 + Task 2 | ✅ | 梯度表与 spec 表格一致 |
| FR-2 动态压缩范围 | Task 3 (Change B) | ⚠️ | 公式细节不一致（见 Issue #3） |
| FR-3 追加式树结构 | Task 3 (Change A) | ⚠️ | runCompression 未做 append（见 Issue #5） |
| FR-4 上下文注入策略 | Task 4 | ⚠️ | 过滤逻辑设计不自洽（见 Issue #2） |
| FR-5 LLM 提示词 | Task 3 (Change C) | ⚠️ | 增量提示词与追加模式冲突（见 Issue #4） |
| FR-6 压缩触发时机 | Task 5 | ⚠️ | 阈值不一致（见 Issue #9） |
| FR-7 压缩失败处理 | Task 3 | ✅ | 明确说 "已有逻辑不变" |
| AC-1 保留窗口动态化 | Task 2 | ✅ | |
| AC-2 压缩范围动态化 | Task 3 | ⚠️ | 公式偏差（见 Issue #3） |
| AC-3 树只追加不重写 | Task 3 | ⚠️ | append 逻辑缺失（见 Issue #5） |
| AC-4 上下文注入包含全部节点 | Task 4 | ⚠️ | 过滤设计混乱（见 Issue #2） |
| AC-5 压缩比稳定 | — | ❌ | 无 task 覆盖，无 e2e 场景验证（见 Issue #7） |
| AC-6 低占用不压缩 | Task 5 | ✅ | |
| C-1 异步 fire-and-forget | — | ✅ | 现有行为不变 |
| C-2 30 秒超时 | — | ✅ | 现有行为不变 |
| C-3 向后兼容 | — | ✅ | 现有行为不变 |
| C-4 单段预估允许误差 | Task 1 + Task 3 | ✅ | |

## 4. Execution Groups 合理性

### 分组合理性 ✅
BG1 只有 1 个 group，5 个文件全部后端，无混合类型。文件数 ≤ 10，合理。

### 依赖关系 ✅
串行链 Task 1 → 2 → 3 → 4 → 5 符合类型依赖方向：types → tracker → compactor → handler → index。

### Wave 编排 ✅
单一 Wave，无并行，无冲突。

### Subagent 配置 ⚠️
注入上下文描述了 "spec.md + plan.md interface contracts + existing code"，但 Task 3 的复杂度（同时涉及 5 个 change）对单个 subagent 来说工作量较大。不过因为是串行执行且有 TDD 步骤，可以接受。

### Summary

计划评审完成，第1轮，5条MUST FIX，需修改后重审。核心问题是：compressedSegIds 持久化遗漏、Task 4 过滤设计自相矛盾、压缩范围公式与 spec 不一致、增量提示词未适配追加模式、runCompression 缺少 append 逻辑。建议修复后提交第 2 轮评审。
