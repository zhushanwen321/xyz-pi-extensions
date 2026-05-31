---
phase: pr
verdict: pass
---

# Context-Engineering V2 链路分析 — Bug 清单

## 分析方法

用以下场景模拟完整执行链路 MC → Budget → L0 → L1 → L2：

```
T=0min   user "分析代码"
T=1min   read → 15000 chars
T=2min   read → 50000 chars
T=3min   read → 8000 chars
T=4min   assistant text response
T=65min  user "继续重构"    ← 60min+ 间隔
T=66min  read → 50000 chars
T=67min  bash → 5000 chars
T=67min  edit → 50 chars
         *** Pi native compact ***
T=68min  user (compactionSummary)
T=68min  user "运行测试"
T=69min  bash → 5000 chars
T=70min  read → 50000 chars
T=71min  assistant "测试通过"
```

逐层推演输入/处理/输出，验证每层的正确性。

## Bug 清单

### BUG-1 [HIGH] MC 清理不存 recall store，原始内容永久丢失

**位置**: `compressor.ts` processMicrocompact(), ~line 363

**现象**: MC 把 toolResult 替换为 `"[Old tool result content cleared]"`，不存 recall store，不生成 ID。Agent 无法通过 `recall_context` 取回原始内容。

**触发条件**: 最后 assistant 消息 > 60min 前，且 compactable toolResult 数量 > keepRecent(5)。

**链路影响**:
1. MC 清理 index 2 的 toolResult → 文本变成 `"[Old tool result content cleared]"`
2. L0 看到 index 2 的 toolResult，age=70min > 30min，不在 protected turn，不在 keepRecent → L0 过期它
3. L0 调用 `store.store(getToolResultText(msg), "l0-expired")` → 存入的是 `"[Old tool result content cleared]"` 而不是原始 15000 chars
4. Agent `recall_context(ctx-xxx)` 取回的是 MC 的占位符文本

**根因**: MC 清理时跳过了 recall store，但后续层不知道 toolResult 已被 MC 处理。

**修复**:
```ts
// processMicrocompact 中替换为：
const originalText = getToolResultText(msg);
const id = store.store(originalText, "mc-cleared");
result[idx] = {
  ...msg,
  content: [{ type: "text", text: `[Old tool result expired. ID: ${id}. Use recall_context(${id}) to retrieve original.]` }],
};
```
同时需要更新 `isToolResultExpired` 或添加 `isAlreadyProcessed` 检查，让 L0/L1/L2 跳过 MC 已处理的 toolResult。

---

### BUG-2 [MEDIUM] Budget while 循环在"大量小 toolResult"场景下过度持久化

**位置**: `compressor.ts` processBudget(), ~line 410

**现象**: 持久化一个 toolResult 后，`totalFreshChars -= maxEntry.chars; totalFreshChars += replacement.length`。当原文 < replacement 长度时，totalFreshChars 反而增加。

**触发条件**: 一个 user 段内有大量小 fresh toolResult（每个 < previewSize），总和略微超过预算。
- 例：201 个 toolResult 各 1000 chars = 201K > 200K budget
- 持久化最大的（1000 chars）：replacement ≈ 2200 chars
- totalFreshChars = 201K - 1K + 2.2K = 202.2K（增加了！）
- 循环继续持久化下一个，totalFreshChars 继续增加
- 最终所有 201 个都被持久化（while 退出因为 `freshEntries.length === 0`）

**影响**: 不会死循环，但过度持久化。recall store 被填满（MAX_ENTRIES=500），触发 LRU 淘汰可能丢失重要内容。

**修复**: 移除 `totalFreshChars += replacement.length` 行，或者添加守卫：
```ts
if (maxEntry.chars <= replacement.length) break; // 持久化不会减少总大小
```

---

### BUG-3 [HIGH] MC 和 L0/L1/L2 之间缺少"已处理"标记

**位置**: `compressor.ts` processL0/L1/L2 中的跳过逻辑

**现象**: MC 清理后的 toolResult（文本 `"[Old tool result content cleared]"`）不被 L0 的 `isToolResultExpired` 识别（它只匹配 `"[Tool result expired"`）。L0 会正常处理已被 MC 清理的 toolResult，存入 recall store 的是占位符而非原始内容。

同理，L1 压缩后的 toolResult（文本 `"[Condensed (ID: ..."`）不被 L2 的 `isToolResultExpired` 识别。L2 会再次 force-expire L1 已压缩的内容，导致同一原始内容被存入 store 两次。

**影响**:
- MC→L0: 原始内容丢失（BUG-1 的链路后果）
- L1→L2: 同一内容存入 store 两次，L2 存入的是 L1 的压缩输出而非原始内容。Agent recall L2 的 ID 会得到 L1 的压缩文本，产生混淆。

**修复**: 添加通用的 `isAlreadyProcessed` 检查：
```ts
function isAlreadyProcessed(msg: ToolResultMessage): boolean {
  const text = getToolResultText(msg);
  return text.startsWith("[Tool result expired") ||
         text.startsWith("[Old tool result") ||
         text.startsWith("[Condensed") ||
         text.startsWith("[Persisted output");
}
```
在 L0/L1/L2 的 toolResult 处理入口统一检查。

---

### BUG-4 [MEDIUM] findCompactBoundary 格式假设未验证

**位置**: `compressor.ts` findCompactBoundary()

**现象**: 用 `msg.content.includes("compactionSummary")` 检测 compact boundary。但 Pi native compact 的消息格式未经验证。

**触发条件**: Pi 的 compact 消息格式变化（如用 array content 而非 string content，或用不同的 key）。

**影响**: findCompactBoundary 返回 null → 无 boundary → 所有消息参与压缩。安全降级但可能导致过度压缩。

**状态**: 需要在真实 Pi session 中验证。当前代码无法确认正确性。

**修复**: 读取 Pi 源码 `compaction.ts` 确认实际格式。

---

### BUG-5 [LOW] estimateMessageChars 忽略 ImageContent

**位置**: `compressor.ts` estimateMessageChars()

**现象**: toolResult 的 chars 估算只计算 TextContent，忽略 ImageContent（base64 data）。

**触发条件**: `contextUsage.percent` 为 null（fallback 路径）且 toolResult 包含图片。

**影响**: L2 的 usagePercent 估算偏低，可能不触发紧急压缩。

**修复**: 在 estimateMessageChars 的 toolResult case 中加入 ImageContent 的 data.length。

---

### BUG-6 [LOW] Budget compactBoundary 检查用 <= 而非 <

**位置**: `compressor.ts` processBudget(), ~line 398

**现象**: `if (compactBoundaryIdx != null && j <= compactBoundaryIdx) continue`。边界处的消息（index === compactBoundaryIdx）被跳过。但 compactBoundaryIdx 指向 compactionSummary user 消息，不是 toolResult，所以实践无害。

**影响**: 无实际影响（边界处是 user 消息，不是 toolResult）。

---

## 非 Bug 确认项

| 问题 | 结论 |
|------|------|
| turn boundaries 只算一次 | ✅ 安全。boundaries 基于 role，MC/Budget 只改 content 不改 role |
| Budget group 分段遗漏最后 group | ✅ 安全。`i === messages.length` 触发最后一个 group 的处理 |
| `as unknown as` 类型断言 | ✅ 设计权衡。catch 块提供降级 |
| config 闭包变量跨 session | ✅ session_start 重建 |

## 优先修复建议

1. **BUG-1 + BUG-3** 一起修：MC 存入 recall store + 添加 `isAlreadyProcessed` 通用检查
2. **BUG-2**: Budget while 循环添加守卫
3. **BUG-4**: 验证 Pi compact 消息格式
4. **BUG-5/6**: 低优先级，不影响核心功能
