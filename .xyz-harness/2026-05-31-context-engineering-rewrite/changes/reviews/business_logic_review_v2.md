---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 4
  issues_found: 2
  must_fix_count: 0
  low_count: 1
  info_count: 1
  duration_estimate: "20"
---

# Dev Business Logic Review v2（修复验证轮）

## 审查记录
- 审查时间：2026-05-31
- 审查模式：Dev（修复验证）
- 审查对象：BLR v1 MUST_FIX #1/#2 修复后的 compressor.ts + index.ts
- 基准文档：business_logic_review_v1.md

## MUST_FIX 修复验证

### MUST_FIX #1（UC-3）: FrozenFreshState 跨 turn 传递 — ✅ 已修复

**v1 问题**：`compressContext` 内部创建 `createFrozenFreshState()`，`index.ts` 的闭包变量 `frozenFreshState` 是死代码。

**v2 修复验证**：

1. **compressor.ts** — `compressContext` 签名已增加 `ffState: FrozenFreshState` 参数：
   ```typescript
   export function compressContext(
     messages: AgentMessage[],
     config: ContextEngineeringConfig,
     store: RecallStore,
     contextUsage: ContextUsage | undefined,
     ffState: FrozenFreshState,  // ← 新增参数
   )
   ```

2. **compressor.ts** — `processBudget` 签名已增加 `ffState: FrozenFreshState` 参数：
   ```typescript
   export function processBudget(
     messages: AgentMessage[],
     config: BudgetConfig,
     store: RecallStore,
     ffState: FrozenFreshState,  // ← 新增参数
     compactBoundaryIdx: number | null,
   )
   ```

3. **compressor.ts** — `compressContext` 内部**无** `createFrozenFreshState()` 调用，直接将 `ffState` 传递给 `processBudget`。

4. **index.ts** — 闭包变量 `frozenFreshState` 声明 → `session_start` 重建 → `context` 事件传入 `compressContext`：
   ```typescript
   let frozenFreshState: FrozenFreshState = createFrozenFreshState();
   // session_start 重建
   pi.on("session_start", () => { frozenFreshState = createFrozenFreshState(); });
   // context 传入
   const result = compressContext(msgs, config, store, ctx.getContextUsage()..., frozenFreshState);
   ```

**结论**：ffState 生命周期正确绑定到 session，跨 turn 状态持久化。`index.ts` 的 `frozenFreshState` 不再是死代码。

---

### MUST_FIX #2（UC-2）: Budget while 循环重评估 — ✅ 已修复

**v1 问题**：`processBudget` 用 `if` 单次持久化，不循环重评估，违反 UC-2 步骤 10。

**v2 修复验证**：

```typescript
// compressor.ts processBudget — 修复后的循环
while (totalFreshChars > config.maxToolResultCharsPerMessage && freshEntries.length > 0) {
    // 1. 找最大 fresh toolResult
    let maxEntry = freshEntries[0];
    for (const entry of freshEntries) {
        if (entry.chars > maxEntry.chars) maxEntry = entry;
    }
    // 2. 持久化 + 替换
    const msg = messages[maxEntry.idx] as ToolResultMessage;
    const text = getToolResultText(msg);
    const id = store.store(text, "budget-persisted");
    const replacement = `[Persisted output (ID: ${id}). Preview: ${text.slice(0, config.previewSize)}... Total: ${text.length} chars]`;
    ffState.markFrozen(maxEntry.toolCallId, replacement);
    result[maxEntry.idx] = { ...msg, content: [{ type: "text", text: replacement }] };
    // 3. 增量更新预算计数
    totalFreshChars -= maxEntry.chars;
    totalFreshChars += replacement.length;
    freshEntries.splice(freshEntries.indexOf(maxEntry), 1);
    persisted++;
}
```

**循环正确性分析**：
- 终止条件：`freshEntries.length > 0` 保证每轮移除 1 个 entry，必然收敛
- 预算更新：`totalFreshChars -= maxEntry.chars; totalFreshChars += replacement.length` 增量更新，数学等价于重新计算
- frozen 标记：`ffState.markFrozen` 确保后续 turn 不会重复评估

**5 × 60K = 300K 场景（v1 报告中的反例）重验证**：

```
迭代 1: freshEntries=[c1:60K, c2:60K, c3:60K, c4:60K, c5:60K], totalFreshChars=300K > 200K
  → maxEntry=c1(60K) → persist → replacement≈2K
  → totalFreshChars = 300K - 60K + 2K = 242K, freshEntries=[c2,c3,c4,c5]
迭代 2: totalFreshChars=242K > 200K
  → maxEntry=c2(60K) → persist → replacement≈2K
  → totalFreshChars = 242K - 60K + 2K = 184K, freshEntries=[c3,c4,c5]
迭代 3: totalFreshChars=184K ≤ 200K → 退出
→ persisted=2, c3/c4/c5 保留原文 ✅
```

**结论**：UC-2 步骤 10 的循环重评估逻辑已正确实现。

---

## UC 全覆盖追踪（重新验证）

| UC 编号 | UC 名称 | v1 状态 | v2 状态 | 说明 |
|---------|---------|---------|---------|------|
| UC-1 | Microcompact Time-Based 清理 | ✅ | ✅ | 无变更，路径不变 |
| UC-2 | Tool Result Budget 预算控制 | ⚠️ 部分 | ✅ 完整 | while 循环已修复 |
| UC-3 | Frozen/Fresh 状态保持 | ❌ | ✅ 完整 | ffState 参数传递已修复 |
| UC-4 | Compact Boundary 感知 | ✅ | ✅ | 无变更 |
| UC-5 | L1 Protected Turn 保护 | ✅ | ✅ | 无变更 |
| UC-6 | 配置启停 | ✅ | ✅ | 无变更 |

---

## UC-3 执行路径重验证（核心修复验证）

### Turn 1: 首次超预算场景

**模拟数据**：
```json
{
  "turn": 1,
  "messages": [
    {"role": "user", "content": "task", "timestamp": 1000},
    {"role": "assistant", "content": [{"type": "toolCall", "id": "c1", "name": "read"}, {"type": "toolCall", "id": "c2", "name": "read"}], "timestamp": 1001},
    {"role": "toolResult", "toolCallId": "c1", "toolName": "read", "content": [{"type": "text", "text": "A"*150000}], "timestamp": 1002},
    {"role": "toolResult", "toolCallId": "c2", "toolName": "read", "content": [{"type": "text", "text": "B"*150000}], "timestamp": 1003}
  ],
  "budget": {"maxToolResultCharsPerMessage": 200000, "previewSize": 2000}
}
```

**执行路径**：
```
compressContext(msgs, config, store, ctx, frozenFreshState)  // ← ffState 从外部传入
→ frozenFreshState.isFrozen("c1") = false → fresh
→ frozenFreshState.isFrozen("c2") = false → fresh
→ freshEntries = [{c1:150K}, {c2:150K}], totalFreshChars = 300K > 200K
→ while 循环:
    迭代 1: max=c1(150K) → persist → id=ctx-aaa
      → replacement = "[Persisted output (ID: ctx-aaa). Preview: AAA...(2000)... Total: 150000 chars]"
      → frozenFreshState.markFrozen("c1", replacement)  // ← 标记冻结
      → totalFreshChars = 300K - 150K + ~2K = 152K ≤ 200K → 退出
→ c2 保留原文, c1 替换为 persisted 预览
→ stats.budgetPersisted = 1 ✅
```

### Turn 2: 跨 turn 冻结验证

**模拟数据**：
```json
{
  "turn": 2,
  "messages": [
    {"role": "user", "content": "task", "timestamp": 1000},
    {"role": "assistant", "content": [{"type": "toolCall", "id": "c1"}, {"type": "toolCall", "id": "c2"}], "timestamp": 1001},
    {"role": "toolResult", "toolCallId": "c1", "toolName": "read", "content": [{"type": "text", "text": "A"*150000}], "timestamp": 1002},
    {"role": "toolResult", "toolCallId": "c2", "toolName": "read", "content": [{"type": "text", "text": "B"*150000}], "timestamp": 1003},
    {"role": "assistant", "content": [{"type": "text", "text": "done"}], "timestamp": 1004},
    {"role": "user", "content": "followup", "timestamp": 2000},
    {"role": "assistant", "content": [{"type": "toolCall", "id": "c3", "name": "read"}], "timestamp": 2001},
    {"role": "toolResult", "toolCallId": "c3", "toolName": "read", "content": [{"type": "text", "text": "C"*80000}], "timestamp": 2002}
  ]
}
```

**执行路径**：
```
compressContext(msgs, config, store, ctx, frozenFreshState)
→ frozenFreshState 来自 Turn 1 闭包: {c1 → "[Persisted output (ID: ctx-aaa)...]"}
→ Group [0, 5):
  → c1: frozenFreshState.isFrozen("c1") = true → replacement = "[Persisted output (ID: ctx-aaa)...]"
  → c2: isFrozen("c2") = false → fresh, chars=150K
  → totalFreshChars = 150K ≤ 200K → 不持久化
→ Group [5, 8):
  → c3: fresh, chars=80K ≤ 200K → 不持久化
→ c1 使用与 Turn 1 完全相同的 replacement → wire prefix 一致 → prompt cache 命中 ✅
→ c2, c3 保持原文 ✅
```

**异常路径 E1（session 重启）**：
```
→ pi.on("session_start") → frozenFreshState = createFrozenFreshState() → 空
→ c1: isFrozen("c1") = false → 当作 fresh 处理
→ 符合 UC-3 A1: "session 重启后所有 toolResult 变为 fresh" ✅
```

---

## 新发现问题清单

| # | 严重度 | UC 编号 | 描述 | 位置 | 说明 |
|---|--------|---------|------|------|------|
| 5 | LOW | UC-2 | `totalFreshChars` 未计入 frozen entries 的 replacement 长度 | compressor.ts processBudget | group 内 frozen entries 的 replacement 文本（如 Turn 1 持久化后的 ~2K 预览）不计入 `totalFreshChars`，实际 group 总大小可能略超预算。影响极小（每个 frozen entry 仅 ~2K），但严格来说与 UC-2 步骤 3"所有 toolResult 的字符总数"不完全一致。不阻塞通过。 |
| 6 | INFO | UC-2 | `totalFreshChars` 命名在 while 循环执行后不再准确反映其语义 | compressor.ts processBudget | 循环体内 `totalFreshChars` 包含了本轮新增的 replacement chars，已不仅是 "fresh" 的 chars。纯命名问题，不影响正确性。 |

---

## 遗留问题（v1 LOW/INFO，未修复，不阻塞）

| # | 严重度 | 状态 | 描述 |
|---|--------|------|------|
| 3 | LOW | 遗留 | `findCompactBoundary` 仅处理 string 格式 content，array 格式 compactionSummary 可能漏检 |
| 4 | INFO | 已解决 | `index.ts` 中 `frozenFreshState` 变量（原死代码）已通过 #1 修复激活 |

---

## 结论

**v2 verdict: PASS**

两个 MUST_FIX 问题均已正确修复：

1. **#1 (UC-3)** — `ffState` 通过参数从 `index.ts` 传入 `compressContext` → `processBudget`，跨 turn 状态持久化，wire prefix 一致性得到保证。
2. **#2 (UC-2)** — `processBudget` 使用 `while` 循环重评估，每轮持久化最大 fresh toolResult 后增量更新预算计数，直到在预算内或无更多 fresh entries。

6 个 UC 全部覆盖完整，无 MUST_FIX 问题遗留。
