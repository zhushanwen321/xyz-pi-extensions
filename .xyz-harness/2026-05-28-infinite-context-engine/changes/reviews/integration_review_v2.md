---
review:
  type: code_review
  round: 2
  timestamp: "2026-05-29T20:00:00"
  target: "infinite-context/src/ (module integration, re-review after fixes)"
  verdict: fail
  summary: "v2 重审：v1 的 6 条 MUST FIX 已修复 4 条（#1 路径、#2 截断、#3 触发、#4 取消），#5 方向+DRY 未修，#6 降级为 LOW。新发现 1 条 MUST FIX（assembleMessages 硬编码 200k context window）。剩余 2 条 MUST FIX 需修复后三审。"

statistics:
  total_issues: 8
  must_fix: 2
  must_fix_resolved: 4
  low: 3
  info: 2

issues:
  - id: 5
    severity: MUST_FIX
    location: "tree-compactor.ts:L89 ↔ segment-tracker.ts:L210"
    title: "triggerCompression 重复实现 retention window，方向仍为 max（注释写 min 但代码取 max）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 12
    severity: MUST_FIX
    location: "context-handler.ts:assembleMessages L107"
    title: "assembleMessages 使用硬编码 DEFAULT_CONTEXT_WINDOW(200k) 计算 totalBudget，非 200k 窗口模型上会超出上下文限制"
    status: open
    raised_in_round: 2
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "recall-tool.ts:L200 (register→execute)"
    title: "recall-tool 仍通过 loadTreeFromEntries 独立加载树，未注入 compactor.getTree()"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 13
    severity: LOW
    location: "context-handler.ts:truncateFromStart L180"
    title: "truncateFromStart 对数组 content 估算 token 为 0（仅处理 string），可能导致截断后仍超预算"
    status: open
    raised_in_round: 2
    resolved_in_round: null

  - id: 14
    severity: LOW
    location: "context-handler.ts:L109"
    title: "retentionSegIds 计算后未使用，注释'仅用于信息记录'但实际无记录逻辑"
    status: open
    raised_in_round: 2
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "commands.ts:L42"
    title: "/tree-compact onComplete 回调 void result，手动压缩结果不通知用户"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: INFO
    location: "index.ts:L63"
    title: "needsCompression 未在 session_start 中重置，多 session 时可能串扰"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 15
    severity: INFO
    location: "segment-tracker.ts:L168"
    title: "Segment.filePath 存储为 'infinite-context/{sid}/seg_N.json'（无 .pi 前缀），与实际写入路径不一致，当前无代码读取此字段"
    status: open
    raised_in_round: 2
    resolved_in_round: null

resolved_issues:
  - id: 1
    resolved_in_round: 2
    resolution: "recall-tool readSegmentFile 改用 ctx.cwd 构建路径（join(ctx.cwd, '.pi', 'infinite-context', sessionId, ...)），与 segment-tracker writeSegmentFile 一致"

  - id: 2
    resolved_in_round: 2
    resolution: "assembleMessages 重构为双分支：totalWithSummary > totalBudget 时通过 truncateFromStart 从头部截断旧消息，仅保留尾部最新消息 + 摘要注入。不再依赖 retentionSegIds 过滤，改用位置性截断替代段感知过滤"

  - id: 3
    resolved_in_round: 2
    resolution: "treeContextTokens 改为 estimateTreeContext(finalMessages)（全部消息 tokens），而非仅摘要 tokens。自动压缩触发路径恢复"

  - id: 4
    resolved_in_round: 2
    resolution: "session_before_compact 始终返回 { cancel: true }，不再条件性判断。取消子进程逻辑保留在 cancelPiCompaction() 中供其他场景使用"
---

# 集成审查 v2 — Infinite Context Engine

## 评审记录
- 评审时间：2026-05-29 20:00
- 评审类型：编码评审（集成专项，v2 重审）
- 评审对象：`infinite-context/src/` 全部 7 个模块
- 对照基准：v1 的 6 条 MUST FIX + 跨模块数据流验证
- 输入依赖：integration_review_v1.md

## v1 MUST FIX 逐条验证

### Issue #1: 段文件读写路径不匹配 — ✅ 已修复

**v1 问题**：recall-tool 的 `readSegmentFile` 使用 `getSessionDir() + "../.." + ".pi"` 构建路径，比 segment-tracker 的写入路径多一层 `.pi/`。

**当前代码验证**：

recall-tool.ts `readSegmentFile`（L155-L165）：
```typescript
const segPath = join(
    ctx.cwd,
    ".pi",
    "infinite-context",
    sessionId,
    `seg_${segIndex}.json`,
);
```

segment-tracker.ts `writeSegmentFile`（L192-L193）：
```typescript
const segDir = join(ctx.cwd, ".pi", "infinite-context", ctx.sessionManager.getSessionId());
```

两端路径一致：`{ctx.cwd}/.pi/infinite-context/{sessionId}/seg_N.json`。

**验证结论**：路径匹配，recall content 模式可正常读取段文件。

---

### Issue #2: assembleMessages 不移除已压缩段的原始消息 — ✅ 已修复（方案变更）

**v1 问题**：`retentionSegIds` 和 `_treeSegIds` 计算后被 void 丢弃，压缩摘要被追加但不移除对应原始消息，context 膨胀。

**当前代码验证**：

context-handler.ts `assembleMessages` 已完全重构：

```typescript
// L108-L119: 计算 totalWithSummary
const rawTokens = this.estimateTreeContext(filtered);
const summaryTokens = summaryMessages.reduce(...);
const totalWithSummary = rawTokens + summaryTokens + recallTokens;

// L121: 预算阈值
const totalBudget = DEFAULT_CONTEXT_WINDOW * BUDGET_RATIO;

// L127-L150: 分支处理
if (totalWithSummary > totalBudget) {
    // 膨胀路径：截断旧消息 + 注入摘要
    const retainedMessages = this.truncateFromStart(filtered, availableForRetention);
    finalMessages = [recallMsg, ...truncatedSummaries, ...retainedMessages];
} else {
    // 未膨胀路径：全部保留 + 注入摘要
    finalMessages = [recallMsg, ...summaryMessages, ...filtered];
}
```

**关键变化**：
1. 删除了 `collectTreeSegIds` 和 `void _treeSegIds`
2. 不再尝试段感知过滤（AgentMessage 无 segId 字段，段感知不可行）
3. 改用位置性截断：`truncateFromStart` 从头部丢弃旧消息，保留尾部最新消息
4. 膨胀路径下，原始消息被截断（移除），仅保留摘要 + 尾部保留窗口

**验证路径 1**（v1 BLR 场景）：
- 20 turns, 8 segments, seg_0~seg_4 已压缩
- rawTokens ≈ 150k, summaryTokens ≈ 2k → totalWithSummary ≈ 152k
- totalBudget = 200k * 0.8 = 160k
- 152k < 160k → 走未膨胀分支：全部保留 + 摘要注入
- 实际 context ≈ 152k tokens，在预算内
- 如果 turns 增长使 rawTokens ≈ 170k → totalWithSummary ≈ 172k > 160k → 走膨胀分支
- `truncateFromStart(filtered, 112k)` 保留尾部 ≈ 112k 的消息
- 最终 context = recall(~100) + summaries(~2k) + retained(112k) ≈ 114k，远小于 200k

**结论**：压缩后原始消息通过位置性截断被移除，context 不再膨胀。方案从段感知过滤改为位置性截断，设计合理。

---

### Issue #3: 自动压缩永不触发 — ✅ 已修复

**v1 问题**：`shouldCompress(result.treeContextTokens, limit)` 中 `treeContextTokens` 仅计算摘要 token（0 或 ≈500），始终 < 70% 阈值。

**当前代码验证**：

context-handler.ts L152-L153：
```typescript
// 5. treeContextTokens = 最终 messages 的总 tokens（用于 shouldCompress 判断）
const treeContextTokens = this.estimateTreeContext(finalMessages);
```

index.ts L88-L91：
```typescript
const contextUsage = ctx.getContextUsage();
if (contextUsage) {
    const limit = contextUsage.contextWindow;
    needsCompression = assembler.shouldCompress(result.treeContextTokens, limit);
}
```

`treeContextTokens` 现在是**全部最终消息**（摘要 + 原文 + recall）的 token 估算值。当总 token 达到 contextWindow 的 70% 时，自动压缩正确触发。

**验证场景**：
- 200k 窗口，已使用 150k tokens → `shouldCompress(150000, 200000)` → `0.75 >= 0.7` → `true`
- `needsCompression = true` → 下一个 `turn_end` 触发 `triggerCompression`

**结论**：自动压缩触发路径恢复。

---

### Issue #4: session_before_compact 条件性取消 — ✅ 已修复

**v1 问题**：`cancelPiCompaction()` 仅在子进程运行时返回 `{ cancel: true }`，其余情况返回 `{ cancel: false }`，Pi 原生 compaction 可执行并破坏段索引。

**当前代码验证**：

index.ts L96-L98：
```typescript
// eslint-disable-next-line @typescript-eslint/no-unused-vars
pi.on("session_before_compact", (_event, _ctx) => {
    return { cancel: true };
});
```

始终返回 `{ cancel: true }`，无条件取消 Pi 原生 compaction。注释说明"我们的树压缩接管了上下文管理"。

`cancelPiCompaction()` 方法仍保留在 tree-compactor.ts 中（L112-L119），用于子进程管理（kill），但不再连接到 `session_before_compact` 事件。

**结论**：Pi 原生 compaction 被始终阻止，段索引一致性得到保障。

---

### Issue #5: triggerCompression 重复实现 retention window 逻辑，方向错误 — ❌ 未修复

**v1 问题**：`triggerCompression` 内部重复实现 retention window 过滤，与 `SegmentTracker.getRetentionWindow()` 各自维护，且方向均为 max（取段数较多的）而非 spec 要求的 min。

**当前代码验证**：

tree-compactor.ts L80-L93：
```typescript
// 2. 过滤 retention window：最近 maxSegments 个已完成段 + 当前活跃段
const completedSegments = segments.filter((s) => s.completed);
// 保留窗口: min(2 个已完成段, 覆盖最近 8 turns 的段)   ← 注释说 min
const byCount = completedSegments.slice(-RETENTION_CONFIG.maxSegments);
const latestTurnEnd = Math.max(...completedSegments.map((s) => s.turnRange.end));
const cutoffTurn = latestTurnEnd - RETENTION_CONFIG.maxTurns + 1;
const byTurns = completedSegments.filter((s) => s.turnRange.end >= cutoffTurn);
// 取较宽松的窗口（段数较多的）                        ← 注释说 max
const retentionSegs = byCount.length >= byTurns.length ? byCount : byTurns;
```

**问题不变**：
1. **DRY 违反**：retention window 逻辑仍在 compactor 内重复实现，未复用 `tracker.getRetentionWindow()`
2. **方向错误**：`byCount.length >= byTurns.length ? byCount : byTurns` 取较大集合（更宽松），spec C-6 要求取 min（更严格）
3. **注释矛盾**：L82 注释写 "min"，L89 注释写 "取较宽松的窗口"，代码实际取 max。三处互相矛盾

segment-tracker.ts L210：
```typescript
// 取两者中段数较多的（更宽松的窗口）
return byCount.length >= byTurns.length ? byCount : byTurns;
```
同方向错误，两处代码应一并修复。

**影响分析**：
- 5 个已完成段，全部在最近 8 turns 内：byCount=2, byTurns=5 → 当前取 5（宽松）→ 仅 0 段被压缩 → 压缩几乎不发生
- 正确取 min(2,5)=2 → 3 段被压缩 → 压缩正常工作
- 结果：compression 效率显著降低，history 段积累

**修改建议**：
1. `index.ts:turn_end` 传入 `tracker.getRetentionWindow()` 给 `triggerCompression`，替代 compactor 内部计算
2. 修复方向：`byCount.length <= byTurns.length ? byCount : byTurns`

---

### Issue #6: recall-tool 独立加载树与 compactor 状态不一致 — 降级为 LOW

**v1 问题**：recall-tool 通过 `loadTreeFromEntries(ctx)` 独立从 entries 加载树，不引用 `compactor.getTree()`，两个独立数据源可能返回不同版本。

**当前代码验证**：

recall-tool.ts L196-L207（register → execute）：
```typescript
async execute(..., ctx: ExtensionContext) {
    const sessionId = ctx.sessionManager.getSessionId();
    const tree = loadTreeFromEntries(ctx);  // ← 仍然独立加载
    return self.executeRecall(params.nodeId, params.mode, tree, sessionId, ctx);
}
```

代码未变，仍独立加载。

**降级理由**：
1. `pi.appendEntry` 是同步操作，`this.tree = tree` 在 `appendEntry` 之前设置（tree-compactor.ts L166-L167）。由于 JS 单线程，两个数据源在正常流程下返回相同结果
2. v1 提到的"极端场景"（entries 缓存延迟、session 恢复顺序不确定）在实践中几乎不发生
3. 主要问题是架构冗余（每次 recall 遍历全部 entries）和违反 DI 原则，不是功能 bug
4. 修改方向是重构（注入 `getTree` 回调），不是 bug 修复

**保留为 LOW**，建议后续重构时一并处理。

---

## 新发现的问题

### MUST FIX #12: assembleMessages 使用硬编码 DEFAULT_CONTEXT_WINDOW

**位置**：context-handler.ts L107

```typescript
const totalBudget = DEFAULT_CONTEXT_WINDOW * BUDGET_RATIO;
// DEFAULT_CONTEXT_WINDOW = 200_000, BUDGET_RATIO = 0.8
// totalBudget = 160_000
```

**问题**：`assembleMessages` 使用硬编码的 200,000 计算 truncation budget，而非实际的 model context window。但 `index.ts:context` handler 中的 compression trigger 使用 `ctx.getContextUsage().contextWindow`（实际值）。

**影响场景**：
- **模型 context window = 128k**（如某些 GPT-4 变体）：
  - `assembleMessages` 允许最多 160k tokens（200k * 0.8）
  - 实际模型限制仅 128k
  - 消息 > 128k 时不会被截断 → API 调用失败
- **模型 context window = 200k**：无影响（硬编码值匹配）
- **模型 context window > 200k**：截断过早，context 利用率不足（LOW 级别）

**修改建议**：

方案 A：`assembleMessages` 接受 `contextWindow` 参数：
```typescript
assembleMessages(
    messages: MinimalAgentMessage[],
    tree: CompactTree | undefined,
    segments: readonly Segment[],
    retentionWindow: readonly Segment[],
    contextWindow: number,  // 新增
): AssembleResult
```

index.ts 传入实际值：
```typescript
const contextUsage = ctx.getContextUsage();
const windowSize = contextUsage?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
assembler.assembleMessages(event.messages, tree, segments, retentionWindow, windowSize);
```

方案 B：先调用 `ctx.getContextUsage()` 获取实际窗口大小，传入 `assembleMessages`。

---

### LOW #13: truncateFromStart 对数组 content 消息估算 token 为 0

**位置**：context-handler.ts L180

```typescript
private truncateFromStart(messages, budget) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const content = messages[i].content;
        const text = typeof content === "string" ? content : "";  // ← 数组 content → ""
        const msgTokens = estimateTokens(text);                    // → 0
```

对比 `estimateTreeContext`（正确处理数组 content）：
```typescript
function extractMessageTextLength(msg) {
    if (typeof content === "string") return content.length;
    if (Array.isArray(content)) {
        return content.reduce(...);  // ← 正确累加各 part.text
    }
}
```

**影响**：tool result 消息（content 为数组）在截断预算中被计为 0 tokens，可能导致截断后实际 token 数超出预算。但最终 `treeContextTokens = estimateTreeContext(finalMessages)` 会正确反映实际总量，compression trigger 会正确检测，形成自纠正。

**修改建议**：复用 `extractMessageTextLength` 逻辑，或调用 `estimateTreeContext([msg])` 估算单条消息。

---

### LOW #14: retentionSegIds 计算后未使用

**位置**：context-handler.ts L109

```typescript
// 保留窗口段 ID（仅用于信息记录）
const retentionSegIds = new Set(retentionWindow.map((s) => s.segId));
const activeSegment = segments.find((s) => !s.completed);
if (activeSegment) {
    retentionSegIds.add(activeSegment.segId);
}
// ← retentionSegIds 再未被引用
```

v1 的 `retentionSegIds` 被标记为关键数据（Issue #2），v2 重构后不再需要段感知过滤。当前代码仍计算但未使用，注释"仅用于信息记录"但实际无日志逻辑。

**修改建议**：删除此块代码（如果确认不需要），或改为实际消费（如传给 render result details）。

---

### INFO #15: Segment.filePath 与实际写入路径不一致

**位置**：segment-tracker.ts L168

```typescript
const filePath = `${CONTEXT_DIR_NAME}/${sessionId}/${segId}.json`;
// = "infinite-context/{sid}/seg_N.json"
```

实际写入路径：
```typescript
const segDir = join(ctx.cwd, ".pi", "infinite-context", sessionId);
// = "{cwd}/.pi/infinite-context/{sid}/"
```

`filePath` 缺少 `.pi/` 前缀和 `ctx.cwd` 前缀。该字段通过 `appendEntry` 持久化，但无代码读取此字段来定位文件（recall-tool 独立构建路径）。当前无功能影响，但数据完整性问题可能在未来使用 `filePath` 时暴露。

---

## 跨集成点的串联验证（v2 重新追踪）

### 串联路径 A: 完整自动压缩流程（v1 的 #2+#3+#4 串联 → 已修复）

```
1. Context 达到 70% → context event
   → treeContextTokens = estimateTreeContext(finalMessages)（含全部消息）✅
   → shouldCompress(150000, 200000) = true ✅
   → needsCompression = true ✅

2. turn_end → triggerCompression
   → compactor 内部 retention window 计算（方向错误，Issue #5）⚠️
   → 但最终会压缩一部分段

3. Pi 检测到 context 满 → session_before_compact
   → 始终返回 { cancel: true } ✅
   → Pi 原生 compaction 不执行 ✅

4. 下一 context event → assembleMessages
   → 如果 totalWithSummary > totalBudget → truncateFromStart 移除旧消息 ✅
   → context 体积下降 ✅

结论：v1 串联路径 A 的核心问题已修复。
剩余风险：Issue #5 导致压缩效率降低（保留过多段），但截断机制兜底
```

### 串联路径 B: recall 两次调用（v1 的 #1+#6 串联）

```
1. recall({ nodeId: "group_1", mode: "structure" })
   → loadTreeFromEntries(ctx) 加载树 ✅
   → 返回正确的结构描述 ✅

2. recall({ nodeId: "node_seg_0", mode: "content" })
   → readSegmentFile: join(ctx.cwd, ".pi", "infinite-context", sid, "seg_0.json") ✅
   → 路径与写入端一致 ✅
   → 返回段文件内容 ✅

结论：v1 串联路径 B 已完全修复。recall 双模式可正常工作
```

### 串联路径 C: 非 200k 模型场景（新发现，Issue #12）

```
1. 模型 context window = 128k
2. Context event → assembleMessages
   → totalBudget = 200k * 0.8 = 160k
   → rawTokens = 140k, summaryTokens = 3k → totalWithSummary = 143k
   → 143k < 160k → 走未膨胀分支：全部保留 + 摘要注入
   → 最终 messages ≈ 143k tokens

3. Pi 发送给模型
   → 143k > 128k → API 调用失败（context_length_exceeded）

结论：非 200k 窗口模型上，截断阈值过高，可能发送超出限制的消息
```

---

## 问题汇总

### MUST FIX（2 条，需修复后三审）

| # | 来源 | 文件/位置 | 描述 | 修改建议 |
|---|------|----------|------|---------|
| 5 | v1 未修 | tree-compactor.ts:L89 ↔ segment-tracker.ts:L210 | **retention window 方向错误 + DRY 违反**。两处均取 max（更宽松），spec C-6 要求 min。注释矛盾（L82 写 min，L89 写 max，代码取 max）。影响：压缩效率显著降低 | 由 index.ts 传入 `tracker.getRetentionWindow()`；修复方向为 `byCount.length <= byTurns.length ? byCount : byTurns` |
| 12 | v2 新发现 | context-handler.ts:L107 | **硬编码 200k context window**。`totalBudget = DEFAULT_CONTEXT_WINDOW * 0.8 = 160k`。非 200k 模型上截断阈值过高，可能发送超出限制的消息导致 API 错误 | `assembleMessages` 新增 `contextWindow` 参数，由 index.ts 传入 `ctx.getContextUsage().contextWindow` |

### LOW（3 条）

| # | 来源 | 文件/位置 | 描述 |
|---|------|----------|------|
| 6 | v1 降级 | recall-tool.ts:L200 | recall 仍独立从 entries 加载树，架构冗余。实践风险低（appendEntry 同步，单线程无竞争），建议后续重构时注入 `getTree` 回调 |
| 13 | v2 新发现 | context-handler.ts:L180 | `truncateFromStart` 对数组 content 消息估算 token 为 0，可能导致截断后超出预算。最终 `treeContextTokens` 正确反映实际量，compression trigger 自纠正 |
| 14 | v2 新发现 | context-handler.ts:L109 | `retentionSegIds` 计算后未使用，注释"仅用于信息记录"但无记录逻辑。建议删除或实际消费 |
| 7 | v1 遗留 | commands.ts:L42 | `/tree-compact` onComplete `void result`，不通知用户压缩结果 |

### INFO（2 条）

| # | 来源 | 描述 |
|---|------|------|
| 8 | v1 遗留 | `needsCompression` 未在 session_start 中重置，多 session 共享时可能串扰 |
| 15 | v2 新发现 | `Segment.filePath` 存储为相对路径（缺 `.pi/` 前缀），与实际写入路径不一致，当前无代码读取此字段 |

---

## 修复建议优先级

1. **Issue #12**（MUST FIX，新发现）：影响非 200k 模型正确性，改动量小（新增参数 + 传参）
2. **Issue #5**（MUST FIX，v1 遗留）：删除 compactor 内部重复逻辑 + 修复方向，改动量中（涉及 index.ts 传参 + tree-compactor.ts 删除重复代码 + segment-tracker.ts 修复方向）

两条 MUST FIX 修复后可进入 v3 终审。
