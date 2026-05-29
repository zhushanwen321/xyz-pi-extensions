---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-29T18:00:00"
  target: "infinite-context/src/ (module integration)"
  verdict: fail
  summary: "集成审查 v1，6 条 MUST FIX：段文件读写路径不匹配、压缩后原始消息未移除、自动压缩永不触发、session_before_compact 条件性取消、retention window 逻辑重复且方向错误、recall 独立加载树与 compactor 状态不一致"

statistics:
  total_issues: 11
  must_fix: 6
  must_fix_resolved: 0
  low: 3
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "infinite-context/src/recall-tool.ts:L141-L148 ↔ infinite-context/src/segment-tracker.ts:L192-L196"
    title: "段文件读写路径不匹配，recall content 模式永远找不到文件"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "infinite-context/src/context-handler.ts:L106-L124"
    title: "assembleMessages 计算了 retentionSegIds 和 treeSegIds 但从未用于过滤消息，压缩后原始消息未移除"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "infinite-context/src/index.ts:L94-L97"
    title: "自动压缩触发条件使用 treeContextTokens（仅摘要 token），导致自动压缩永不触发"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: MUST_FIX
    location: "infinite-context/src/index.ts:L103-L107 ↔ tree-compactor.ts:L104-L110"
    title: "session_before_compact 仅在子进程运行时取消 Pi 原生 compaction，其余情况 Pi compaction 正常执行"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: MUST_FIX
    location: "infinite-context/src/tree-compactor.ts:L80-L92"
    title: "triggerCompression 重复实现 retention window 逻辑，且与 SegmentTracker 相同的 max 方向错误"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: MUST_FIX
    location: "infinite-context/src/recall-tool.ts:L159-L170"
    title: "recall-tool 通过 loadTreeFromEntries 独立加载树，与 compactor.getTree() 可能返回不同版本"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "infinite-context/src/commands.ts:L42"
    title: "/tree-compact onComplete 回调 void result，手动压缩结果不通知用户"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: LOW
    location: "infinite-context/src/index.ts:L63-L64"
    title: "needsCompression 为模块级闭包变量，多 session 共享时状态串扰"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: LOW
    location: "infinite-context/src/context-handler.ts:L110-L112"
    title: "_treeSegIds 被 void 丢弃，注释说'后续版本使用'但它是 Issue #2 的关键数据"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 10
    severity: INFO
    location: "infinite-context/src/context-handler.ts:L146"
    title: "bfsFlatten 的 nextLevel 按 currentLevel（原始顺序）收集子节点，下一轮 reverse 实现同层 newest→oldest，语义正确但缺乏注释"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 11
    severity: INFO
    location: "infinite-context/src/tree-compactor.ts:L176"
    title: "handleCompressionFailure 中重试逻辑完整复制 runCompression 的 spawn+收集+校验流程，可提取为共用方法"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 集成审查 v1 — Infinite Context Engine

## 评审记录
- 评审时间：2026-05-29 18:00
- 评审类型：编码评审（集成专项）
- 评审对象：`infinite-context/src/` 全部 7 个模块间的数据流和事件生命周期
- 对照基准：BLR v1 的模拟业务数据和执行路径 + spec FR/AC
- 输入依赖：business_logic_review_v1.md（5 条 BLR MUST FIX 已知）

## 评审方法

本审查以 BLR v1 的 5 条模拟执行路径为基础，逐条追踪跨模块数据流，验证：
1. 数据在模块边界处的格式是否匹配
2. 数据传递的时序是否正确（先写后读）
3. 事件生命周期中的状态转换是否完整
4. 上游 BLR 问题对下游集成的影响

## 集成点 1: segment-tracker → tree-compactor（段数据传入压缩触发）

### 数据流追踪

```
[index.ts:turn_end]
  tracker.getSegments()           → readonly Segment[]
  compactor.triggerCompression(
    pi, ctx, segments,            ← 完整段列表传入
    compactor.getTree(),          ← 当前树
    onComplete
  )

[tree-compactor.ts:triggerCompression]
  接收 segments: readonly Segment[]
  → completedSegments = segments.filter(s => s.completed)
  → 重复实现 retention window 过滤（Issue #5）
  → historySegments = 排除 retention + active
  → runCompression(pi, ctx, historySegments, ...)
```

### 问题分析

**Issue #5 (MUST FIX): triggerCompression 重复实现 retention window 逻辑**

`SegmentTracker.getRetentionWindow()` 已实现了 retention window 计算（虽然 BLR #1 指出其 max 方向错误），但 `TreeCompactor.triggerCompression()` 没有复用它，而是在方法内部重新实现了一遍——且方向同样错误。

当前代码：
```typescript
// tree-compactor.ts:L86-L92
const byCount = completedSegments.slice(-RETENTION_CONFIG.maxSegments);
// ...
const retentionSegs = byCount.length >= byTurns.length ? byCount : byTurns;
// 取"段数较多的"（更宽松窗口）— 错误，应取 min
```

spec C-6 约束："取两者最小值"（更严格约束）。

**影响链**：`index.ts:turn_end` 传入完整段列表，tree-compactor 内部自行过滤 → 过滤逻辑与 segment-tracker 不一致 → 两个模块各自维护 retention window 定义，修复时需同步两处。

**验证路径 4（BLR）场景**：
- 10 个已完成段，每个只有 1 turn，当前 turn=30
- byCount = 2 个段，byTurns = 8 个段（全在最近 8 turns 内）
- 当前代码：`2 >= 8` → false → 取 byTurns（8 个段）
- 正确：min(2, 8) = 2 个段
- 结果：压缩少压缩了 6 个本应收纳的段，context 膨胀

**修改方向**：
1. 统一由 `SegmentTracker.getRetentionWindow()` 提供 retention 结果
2. `index.ts` 传入 `tracker.getRetentionWindow()` 给 `triggerCompression`，替代在 compactor 内部重复实现
3. 修复 `getRetentionWindow()` 的方向：`byCount.length <= byTurns.length ? byCount : byTurns`

---

## 集成点 2: tree-compactor → context-handler（压缩树传入消息组装）

### 数据流追踪

```
[index.ts:context event]
  tree = compactor.getTree()      → CompactTree | undefined
  retentionWindow = tracker.getRetentionWindow()

  assembler.assembleMessages(
    event.messages,               ← Pi 的完整消息列表
    tree,                         ← 压缩树
    segments,                     ← 全部段
    retentionWindow,              ← 保留窗口段
  )
```

### 问题分析

**Issue #2 (MUST FIX): assembleMessages 计算了 retentionSegIds 和 treeSegIds 但从未用于过滤消息**

这是最严重的集成缺陷。`assembleMessages` 的核心职责是：将已压缩段的原始消息替换为摘要。但当前实现只做了"注入摘要"，没有做"移除原始消息"。

代码追踪：
```typescript
// context-handler.ts:L106-L112
const retentionSegIds = new Set(retentionWindow.map((s) => s.segId));
const activeSegment = segments.find((s) => !s.completed);
if (activeSegment) retentionSegIds.add(activeSegment.segId);
// ↑ 计算了但从未使用

const _treeSegIds = collectTreeSegIds(tree.root);
void _treeSegIds;
// ↑ 也计算了但 void 丢弃
```

`retentionSegIds` 本应用于：从 `filtered` 消息中排除属于"已压缩段"的消息（即不属于 retention window 的消息）。`_treeSegIds` 本应用于：确定哪些段已被纳入树中，标记其消息为可替换。

但代码实际执行的是：
1. 过滤掉旧 ic-summary / ic-recall-prompt
2. 如果有树 → 注入摘要消息到开头
3. 返回 = 过滤后的全部原始消息 + 新注入的摘要

**这意味着 context 不是被压缩（替换），而是被膨胀（追加）**。

**验证路径 1（BLR）场景**：
- 20 turns, 8 segments, seg_0~seg_4 已压缩进树
- 期望 context = [recall prompt] + [seg_0~seg_4 摘要] + [seg_5~seg_6 原文] + [seg_7 当前原文]
- 实际 context = [recall prompt] + [seg_0~seg_4 摘要] + [seg_0~seg_7 全部原始消息]
- 结果：context 体积 = 原始 + 摘要，比压缩前更大

**修改方向**：
1. 使用 `_treeSegIds` 确定哪些段的原始消息需要替换
2. 使用 `retentionSegIds` 确定哪些段的消息必须保留
3. 从 `filtered` 中移除"已被树压缩且不在 retention window 内"的段的消息
4. 移除 `void _treeSegIds`，改为实际消费该变量

---

## 集成点 3: context-handler → index.ts → Pi（组装消息返回）

### 数据流追踪

```
[index.ts:context event]
  result = assembler.assembleMessages(...)
  return { messages: result.messages as typeof event.messages }
```

### 问题分析

消息返回格式本身没有问题（`result.messages` 是 `MinimalAgentMessage[]`，通过 `as typeof event.messages` 类型断言传回 Pi）。但返回的数据内容有问题——如 Issue #2 所述，原始消息未被移除。

此外，还有一个独立的严重问题：

**Issue #3 (MUST FIX): 自动压缩触发条件使用 treeContextTokens（仅摘要 token），导致自动压缩永不触发**

代码追踪：
```typescript
// index.ts:L94-L97
const contextUsage = ctx.getContextUsage();
if (contextUsage) {
    const limit = contextUsage.contextWindow;
    needsCompression = assembler.shouldCompress(result.treeContextTokens, limit);
}
```

`result.treeContextTokens` 的来源：
```typescript
// context-handler.ts:assembleMessages
treeContextTokens = summaryMessages.reduce(
    (sum, msg) => sum + estimateTokens(...),
    0,
);
```

这仅计算了**树摘要**的 token 数量，不包括原始消息。

**场景分析**：
- 无树时：`treeContextTokens = 0` → `shouldCompress(0, 200000) = false` → 永不触发
- 有树时：假设 5 个摘要共 500 tokens → `500 / 200000 = 0.25%` → 永不触发
- 即使 context 实际已 90% 满，只要摘要小，就不会触发压缩

**结果：自动压缩路径完全失效。** 用户只能通过 `/tree-compact` 手动触发。

**修改方向**：
使用 Pi 报告的实际 context usage 或 `assembler.estimateTreeContext(result.messages)` 计算**全部消息**的 token 数量，而非仅摘要：
```typescript
// 方案 A：使用 Pi 报告的实际使用量
needsCompression = (contextUsage.tokens / contextUsage.contextWindow) >= 0.7;

// 方案 B：使用独立估算
const totalTokens = assembler.estimateTreeContext(result.messages);
needsCompression = assembler.shouldCompress(totalTokens, limit);
```

---

## 集成点 4: recall-tool ↔ tree-compactor + segment 文件（检索集成）

### 数据流追踪

```
[recall-tool.ts:register → execute]
  sessionId = ctx.sessionManager.getSessionId()
  tree = loadTreeFromEntries(ctx)     ← 独立从 entries 加载
  self.executeRecall(nodeId, mode, tree, sessionId, ctx)

[recall-tool.ts:readSegmentFile]
  segPath = join(
    ctx.sessionManager.getSessionDir(),    // {cwd}/.pi/sessions/{sid}
    "..", "..",                            // {cwd}/.pi
    ".pi", "infinite-context", sessionId,
    `seg_${segIndex}.json`
  )
  // 解析为 {cwd}/.pi/.pi/infinite-context/{sid}/seg_N.json
```

对比段文件写入路径：
```
[segment-tracker.ts:writeSegmentFile]
  segDir = join(ctx.cwd, ".pi", "infinite-context", ctx.sessionManager.getSessionId())
  // 解析为 {cwd}/.pi/infinite-context/{sid}/
```

### 问题分析

**Issue #1 (MUST FIX): 段文件读写路径不匹配**

读取路径比写入路径多了一层 `.pi/` 目录：
- 写入：`{cwd}/.pi/infinite-context/{sid}/seg_N.json`
- 读取：`{cwd}/.pi/.pi/infinite-context/{sid}/seg_N.json`

根因：`getSessionDir()` 返回 `{cwd}/.pi/sessions/{sessionId}`（已验证 Pi 源码），`../..` 回到 `{cwd}/.pi`，然后又拼了 `.pi`，导致多了一层。

**注意**：BLR #2 标记 writeSegmentFile 为空实现，但当前代码版本已实现了写入逻辑。路径不匹配是独立的集成问题——即使写入正确，读取也会失败。

**验证路径 2（BLR）场景**：
- LLM 调用 `recall({ nodeId: "node_seg_0", mode: "content" })`
- `readSegmentFile` 构建路径 = `{cwd}/.pi/.pi/infinite-context/{sid}/seg_0.json`
- `existsSync(segPath)` → false（文件在 `{cwd}/.pi/infinite-context/{sid}/seg_0.json`）
- 返回 "(段文件不存在或无法读取)"

**修改方向**：
recall-tool 的 `readSegmentFile` 应直接使用 `ctx.cwd` 构建路径，与写入端保持一致：
```typescript
const segPath = join(ctx.cwd, ".pi", "infinite-context", sessionId, `seg_${segIndex}.json`);
```

---

**Issue #6 (MUST FIX): recall-tool 独立加载树，与 compactor 内存状态可能不一致**

`recall-tool.ts` 的 `register()` 中 `execute()` 通过 `loadTreeFromEntries(ctx)` 从 entries 重新查找最新 `ic-compact-tree`。而 `index.ts` 的 context handler 使用 `compactor.getTree()` 获取内存中的树。

在正常流程下（appendEntry 同步写入、entries 立即可读），两者应返回相同结果。但在以下场景下可能不一致：

1. **压缩刚完成、entries 尚未同步**：虽然 `appendEntry` 是同步的，但极端情况下 `ctx.sessionManager.getEntries()` 的缓存可能未更新
2. **session 恢复**：session_start 后，compactor.restoreState 和 recall-tool.loadTreeFromEntries 各自独立扫描 entries，如果 entries 格式异常或恢复顺序不确定，可能读到不同版本

更根本的问题是**架构冗余**：recall-tool 应接受外部注入的 tree 引用，而非自行加载。这样：
- 消除两个独立数据源的不一致风险
- 避免每次 recall 都遍历全部 entries 的性能开销
- 与 Pi 扩展的依赖注入模式一致

**修改方向**：
recall-tool 的 `register()` 改为接受 tree provider 函数：
```typescript
register(pi: ExtensionAPI, getTree: () => CompactTree | undefined): void
```
在 `execute()` 中调用 `getTree()` 而非 `loadTreeFromEntries(ctx)`。

---

## 集成点 5: commands ↔ tree-compactor（命令集成）

### 数据流追踪

```
[commands.ts:registerTreeCompactCommand]
  segments = tracker.getSegments()
  compactor.triggerCompression(pi, ctx, segments, compactor.getTree(), onComplete)
  // onComplete: void result → 不通知用户

[commands.ts:registerContextStatusCommand]
  segments = tracker.getSegments()
  retentionWindow = tracker.getRetentionWindow()
  tree = compactor.getTree()
  contextUsage = ctx.getContextUsage()
  flatNodes = assembler.bfsFlatten(tree)  ← 直接调用 assembler 的公开方法
```

### 问题分析

**Issue #7 (LOW): /tree-compact onComplete 回调忽略结果**

`commands.ts:L42` 中 `onComplete` 回调直接 `void result`，不通知用户压缩结果。对比 `index.ts:turn_end` 中的 `onComplete` 有完整的 `ctx.ui.notify` 逻辑。

手动执行 `/tree-compact` 的用户看到的是 "树压缩已启动..." 的初始提示，但永远看不到最终结果（成功/失败/降级）。

**修改方向**：在 commands.ts 的 onComplete 回调中添加 `ctx.ui.notify` 通知，复用 index.ts 中的通知逻辑。

---

## 集成点 6: 事件生命周期（session_start → turn_end → context → ...）

### 事件时序图

```
session_start
  → tracker.restoreState(entries)     ← 恢复段索引
  → compactor.restoreState(entries)   ← 恢复压缩树

[Turn N]
  context event                       ← Pi 准备发送消息给 LLM
    → assembler.assembleMessages()    ← 重组消息
    → shouldCompress() → needsCompression = true/false
    → return { messages }
    → Pi 发送给 LLM

  turn_end event                      ← LLM + tool calls 完成
    → tracker.handleTurnEnd()         ← 更新段索引
    → if needsCompression:
        → compactor.triggerCompression()  ← 异步 spawn 子进程

  [如果 Pi 触发 native compaction]
  session_before_compact event
    → compactor.cancelPiCompaction()  ← 仅当子进程运行时取消

[Turn N+1]
  context event                       ← 新一轮
    → ...
```

### 问题分析

**Issue #4 (MUST FIX): session_before_compact 条件性取消**

代码追踪：
```typescript
// index.ts:L103-L107
pi.on("session_before_compact", (_event, _ctx) => {
    return compactor.cancelPiCompaction();
});

// tree-compactor.ts:L104-L110
cancelPiCompaction(): { cancel: boolean } {
    if (this.currentProcess && !this.currentProcess.killed) {
        this.currentProcess.kill("SIGTERM");
        this.currentProcess = undefined;
        this.compressing = false;
        return { cancel: true };
    }
    return { cancel: false };
}
```

**问题**：`cancelPiCompaction()` 的语义是"取消正在运行的子进程"，但 `session_before_compact` 事件需要的语义是"阻止 Pi 的原生 compaction"。这两个职责被错误地合并在一个方法中。

**场景分析**：
1. Context 达到 70% → `needsCompression = true`（Issue #3 导致不会发生，但假设修复后）
2. turn_end 触发 `triggerCompression` → spawn 子进程 → `this.currentProcess` 有值
3. 如果 Pi 同时触发 `session_before_compact` → `cancelPiCompaction()` 返回 `{ cancel: true }` → 正确
4. **但如果 `session_before_compact` 在 `triggerCompression` 之前触发**（Pi 先检测到 context 满再触发 compaction）：
   - `this.currentProcess` = undefined → 返回 `{ cancel: false }`
   - Pi 的原生 compaction 正常执行 → 与树压缩机制冲突
5. **更常见的情况**：没有子进程在运行时 Pi 触发 compaction → `{ cancel: false }` → Pi compaction 运行 → 原生 compaction 删除消息 → 但 segment-tracker 不知道 → 段索引与实际消息不同步

**时序竞争**：`context` 事件 → `needsCompression = true` → Pi 检测到 context 满 → `session_before_compact`（此时子进程未启动）→ Pi compaction 运行 → `turn_end`（此时触发 triggerCompression 但部分消息已被 Pi 删除）

**修改方向**：
```typescript
// 方案：始终取消 Pi 原生 compaction
pi.on("session_before_compact", () => {
    return { cancel: true };
});
```
将"取消子进程"和"阻止 Pi compaction"拆分为两个独立方法。

---

## 跨集成点的串联验证

### 串联路径 A: 完整自动压缩流程（Issues #2 + #3 + #4 串联）

```
1. Context 达到 70% → context event
   → needsCompression = shouldCompress(treeContextTokens=0, 200000) = false
   → [Issue #3] 自动压缩未触发

2. Context 继续增长到 90% → Pi 触发 native compaction
   → session_before_compact → cancelPiCompaction() → { cancel: false }
   → [Issue #4] Pi compaction 运行，删除部分消息
   → segment-tracker 不知道消息被删除 → 段索引与实际消息不同步

3. 下一 turn → context event
   → assembleMessages: 不移除压缩段消息 [Issue #2]
   → 注入摘要 + 全部原始消息 → context 更大

结论：三个问题串联导致 "自动压缩不触发 → Pi compaction 误运行 → 数据不一致 → context 膨胀"
```

### 串联路径 B: recall 两次调用（Issues #1 + #6 串联）

```
1. LLM 调用 recall({ nodeId: "group_1", mode: "structure" })
   → loadTreeFromEntries(ctx) 加载树
   → [Issue #6] 可能与 compactor.getTree() 不同版本
   → 但通常一致，返回正确的结构描述

2. LLM 调用 recall({ nodeId: "node_seg_0", mode: "content" })
   → readSegmentFile(sessionId, "seg_0", ctx)
   → [Issue #1] 路径不匹配 → 文件不存在
   → 返回 "(段文件不存在或无法读取)"

结论：recall 的 content 模式完全不可用，即使段文件实际已正确写入
```

### 串联路径 C: 手动压缩流程（Issues #5 + #7）

```
1. 用户执行 /tree-compact
   → segments = tracker.getSegments()
   → compactor.triggerCompression(pi, ctx, segments, tree, onComplete)
   → [Issue #5] retention window 在 compactor 内重复计算，方向错误
   → 可能保留过多段，压缩效率降低

2. 压缩完成 → onComplete(result)
   → [Issue #7] void result → 不通知用户
   → 用户看到 "树压缩已启动..." 但无最终结果

3. 下一 context event
   → [Issue #2] 摘要注入但原始消息未移除
   → context 体积增大而非减小
```

---

## BLR MUST FIX 对集成的影响评估

| BLR # | BLR 标题 | 对集成的影响 |
|-------|---------|-------------|
| BLR #1 | getRetentionWindow max 方向错误 | 直接影响集成点 1（段→压缩器）。本审查 Issue #5 指出该逻辑在 tree-compactor 中被重复实现，修复需同步两处 |
| BLR #2 | writeSegmentFile 空实现 | **当前版本已修复**。但集成点 4 发现了新的路径不匹配问题（Issue #1），效果等同于 BLR #2：recall content 不可用 |
| BLR #3 | triggerCompression 缺少 maxTurns 约束 | 被本审查 Issue #5 包含。triggerCompression 内的 retention window 是重复实现，未使用 SegmentTracker 已有的逻辑 |
| BLR #4 | BFS 展平顺序 | 集成验证确认：BFS 展平逻辑本身正确（Level 1→2→3, 同层 newest→oldest）。本审查标记为 INFO #10（缺注释） |
| BLR #5 | recall 默认 mode | 不影响集成，是参数定义问题 |

---

## 发现的问题

### MUST FIX

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | recall-tool.ts:L141-L148 ↔ segment-tracker.ts:L192-L196 | **段文件读写路径不匹配**。Writer: `join(ctx.cwd, ".pi", "infinite-context", sid)`。Reader: `join(getSessionDir(), "..", "..", ".pi", ...)` = `join(cwd, ".pi", ".pi", "infinite-context", sid)`。getSessionDir() 返回 `{cwd}/.pi/sessions/{sid}`（已验证 Pi 源码），`../..` 到 `{cwd}/.pi`，再加 `.pi` 导致多一层。Recall content 模式永远返回"段文件不存在" | recall-tool 的 readSegmentFile 改用 `ctx.cwd` 构建路径，与 writer 一致：`join(ctx.cwd, ".pi", "infinite-context", sessionId, ...)` |
| 2 | MUST FIX | context-handler.ts:L106-L124 | **assembleMessages 不移除已压缩段的原始消息**。`retentionSegIds` 和 `_treeSegIds` 计算后被 void 丢弃。压缩摘要被追加到消息开头，但对应段的原始消息仍在列表中。Context 体积不降反升（原始+摘要），压缩机制的核心价值失效 | 用 `_treeSegIds` 标记已被树收纳的段，从 `filtered` 中移除这些段的消息（保留 retention window 内的段消息）。移除 `void _treeSegIds` |
| 3 | MUST FIX | index.ts:L94-L97 | **自动压缩永不触发**。`shouldCompress(result.treeContextTokens, limit)` 中 `treeContextTokens` 仅计算摘要 token（无树时=0，有树时≈500），远小于 contextWindow（200k）。0/200000 = 0% < 70% → 始终返回 false。自动压缩路径完全失效 | 改用实际 context usage：`shouldCompress(contextUsage.tokens, limit)` 或 `shouldCompress(estimateTreeContext(result.messages), limit)` |
| 4 | MUST FIX | index.ts:L103-L107 ↔ tree-compactor.ts:L104-L110 | **session_before_compact 仅在子进程运行时取消 Pi compaction**。无子进程时返回 `{ cancel: false }` → Pi 原生 compaction 执行 → 消息被删除但 segment-tracker 不知道 → 段索引与消息不同步。该事件应始终返回 `{ cancel: true }` | 拆分职责：`session_before_compact` 始终返回 `{ cancel: true }`。"取消子进程"独立为 `killSubprocess()` 方法 |
| 5 | MUST FIX | tree-compactor.ts:L80-L92 | **triggerCompression 重复实现 retention window 逻辑**，且方向与 SegmentTracker.getRetentionWindow() 相同错误（取 max 而非 min）。两处独立实现需同步修复，违反 DRY 原则 | 删除 compactor 内部的 retention window 逻辑，由 index.ts 传入 `tracker.getRetentionWindow()` 的结果。同时修复 SegmentTracker 中的方向错误 |
| 6 | MUST_FIX | recall-tool.ts:L159-L170 | **recall-tool 独立从 entries 加载树**（loadTreeFromEntries），不引用 compactor.getTree()。两个独立数据源在极端情况下可能返回不同版本（如 entries 缓存延迟）。架构上冗余——recall 工具每次调用遍历全部 entries 查找树 | recall 改为接受 `getTree: () => CompactTree \| undefined` 函数注入，消除独立数据源。register 签名改为 `register(pi, getTree)` |

### LOW

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 7 | LOW | commands.ts:L42 | `/tree-compact` 的 onComplete 回调 `void result`，不通知用户压缩结果。用户看到"树压缩已启动..."后无后续反馈 | 添加 `ctx.ui.notify` 通知，复用 index.ts 中的通知逻辑 |
| 8 | LOW | index.ts:L63-L64 | `needsCompression` 是闭包级变量，在 `session_start` 中未重置。多 session 共享同一扩展实例时（Pi 进程内），前一个 session 的 `needsCompression` 可能影响新 session | 在 `session_start` handler 中重置 `needsCompression = false` |
| 9 | LOW | context-handler.ts:L110-L112 | `_treeSegIds` 被 `void` 丢弃，注释说"后续版本使用"。但它是 Issue #2（不移除压缩段消息）的关键数据。如果修复 Issue #2，此变量必须被消费 | 移除 `void _treeSegIds`，将其用于过滤 compressed segment 的消息 |

### INFO

| # | 优先级 | 文件/位置 | 描述 |
|---|--------|----------|------|
| 10 | INFO | context-handler.ts:L146 | bfsFlatten 的 nextLevel 收集逻辑假设 children 数组中 index 越大越新。注释不够明确，建议添加假设说明 |
| 11 | INFO | tree-compactor.ts:L176 | handleCompressionFailure 中重试逻辑完整复制了 runCompression 的 spawn + 收集 + 校验流程（约 50 行），可提取为共用方法减少重复 |

## 结论

**需修改后重审**。6 条 MUST FIX 中，Issue #2（压缩后原始消息未移除）和 Issue #3（自动压缩永不触发）是最严重的——它们串联后导致整个自动压缩机制完全失效：不会自动触发，即使手动触发也不减少 context 体积。Issue #1（路径不匹配）使 recall content 模式不可用，与 BLR #2 的效果相同但根因不同。Issue #4（条件性取消 Pi compaction）可能导致 Pi 原生 compaction 误运行，破坏段索引一致性。

### Summary

集成审查完成，第 1 轮，6 条 MUST FIX，需修改后重审。核心压缩管线（自动触发 → 段压缩 → 消息替换 → 压缩结果持久化 → recall 检索）在 4 个环节中有断裂。
