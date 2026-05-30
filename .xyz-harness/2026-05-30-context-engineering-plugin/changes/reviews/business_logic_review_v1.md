---
verdict: fail
must_fix: 1
review_metrics:
  files_reviewed: 5
  issues_found: 6
  must_fix_count: 1
  low_count: 3
  info_count: 2
  summary: "业务逻辑审查完成，第1轮，1条MUST FIX，需修改后重审"

statistics:
  total_issues: 6
  must_fix: 1
  must_fix_resolved: 0
  low: 3
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "context-engineering/src/compressor.ts:compressContext()"
    title: "L0 始终执行，config.l0.enabled 未被检查"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "context-engineering/src/compressor.ts:processL2()"
    title: "L2 fallback 估算使用硬编码 200k 上下文窗口"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "context-engineering/src/compressor.ts:processL0() → processL1()"
    title: "L0 过期 L1 已压缩的消息时，recall 存储的是压缩后文本而非原始内容"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "context-engineering/src/recall-store.ts"
    title: "Recall store 无 GC 机制，长 session 中条目无限累积"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: INFO
    location: "context-engineering/src/recall-store.ts:store()"
    title: "8 字符 UUID 存在极低概率碰撞风险，无碰撞检测"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: INFO
    location: "context-engineering/src/compressor.ts:processL0()"
    title: "hasUserAfter 仅检查 user 消息，不检查 bashExecution"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 业务逻辑审查 v1

## 评审记录
- 评审时间：2026-05-31 14:00
- 评审类型：业务逻辑审查（编码评审子集，聚焦 UC 正确性）
- 评审对象：context-engineering 插件全部源代码
- 对照基准：use-cases.md 中的 4 个 UC

## UC 逐条验证

### UC-1: 长时间编码会话的上下文保持

**验证结论：基本正确，有 1 个 recall 语义问题（LOW #3）**

| 检查点 | 代码位置 | 结果 |
|--------|---------|------|
| Main Flow 3: 超 30min tool_result 替换为过期标记 | `processL0()` L128-139 | ✅ `age > config.expireMinutes * 60000` 正确计算过期，`expireToolResult()` 生成含 ID 的过期标记 |
| Main Flow 4: 超 4000 字符 bash 输出截断 | `processL0()` L141-148 | ✅ `msg.output.length > config.bashTruncateChars` 检查，`{ ...msg, output: truncatedOutput }` 展开创建新对象，不修改原消息 |
| Main Flow 5: 超 5 分钟空闲 thinking 清空 | `processL0()` L150-164 | ✅ `thinkingExpired && !hasUserAfter[i]` 双重条件正确 |
| Main Flow 6: LLM 可通过 recall ID 取回原始内容 | `recall_context` tool | ✅ `store.recall(params.id)` 返回原始内容 |
| Alt A1: recall_context 返回原始内容 | `index.ts` L82-94 | ✅ 返回 `stored.original` 完整文本 |
| Alt A2: Session reload → store 清空 → not found | `index.ts` L72-79 | ✅ session_start 重建 store，recall 返回 not found 提示 |
| ToolResultMessage.content 类型处理 | 全局 | ✅ `content` 始终以 `(TextContent \| ImageContent)[]` 结构处理，替换时构造 `[{ type: "text", text: ... }]` |
| BashExecutionMessage.output 替换 | `processL0()` L146 | ✅ `{ ...msg, output: truncatedOutput }` 正确使用展开运算符创建新对象 |

**问题 #3（LOW）— L0 过期 L1 已压缩消息时的 recall 语义断裂：**

时序：
1. T=0 context event：L0 跳过（未过期）→ L1 压缩为 `[Condensed (ID: ctx-aaa): summary]`，ctx-aaa 存储原始文本
2. T=31min context event：L0 读取 `getToolResultText(msg)` 得到压缩文本 → 存储压缩文本为 ctx-bbb → 替换为 `[Tool result expired. ID: ctx-bbb. Use recall_context(ctx-bbb) to retrieve the original content.]`

问题：ctx-bbb 指向压缩后的文本，不是原始内容。过期消息说 "retrieve the original content" 但 recall 返回的是 L1 摘要而非原始文本。ctx-aaa（含原始内容）仍在 store 中，但 LLM 无法从对话上下文中看到 ctx-aaa。

**严重程度判定**：功能上没有数据丢失（ctx-aaa 仍在 store 中），但 recall 语义与过期消息文案不符。降级为 LOW。如果认为 L0 过期后原始内容确实不再需要，可以不改代码，但应更新过期消息文案。

### UC-2: 大文件读取后的上下文释放

**验证结论：正确**

| 检查点 | 代码位置 | 结果 |
|--------|---------|------|
| Main Flow 2: L1 检测超阈值 | `processL1()` L175-180 | ✅ `text.length > config.summaryThresholdChars` (8000) |
| Main Flow 3: 提取 import/定义/首尾行 | `condenseToolResult()` L78-104 | ✅ `IMPORT_EXPORT_RE` + `DEFINITION_RE` 正则提取，`keepHeadLines` + `keepTailLines` 保留首尾 |
| Main Flow 4: 生成 [Condensed] 格式 | `processL1()` L178 | ✅ `[Condensed (ID: ${id}): ${summary}]` 格式正确 |
| Main Flow 5: 原始内容保存到 recall store | `processL1()` L176 | ✅ `store.store(text, "l1-condensed")` |
| Main Flow 6: L0 后续过期 | 依赖 UC-1 的 L0 逻辑 | ✅ 同 UC-1 分析 |
| Alt A1: 非代码文件 → 正则无匹配 → fallback | `condenseToolResult()` | ✅ `result.length > content.length * 0.4` → `fallbackTruncate(content)` |
| L1 fallback >40% 截断逻辑 | `condenseToolResult()` L99-101 | ✅ 结构化摘要超过原始 40% 时触发 `fallbackTruncate()`，截取 head 20% + tail 20% + 标记 |

**L1 fallback 验证详情：**

```
输入: 12000 字符, 200 行 TypeScript
keepHeadLines=10, keepTailLines=5
→ head=10行, tail=5行, middle=185行
→ 从 middle 中提取 import/定义行（假设 30 行匹配）
→ result ≈ 45 行 ≈ ~3000 字符 (25%)
→ 25% < 40% → 使用结构化摘要 ✅

极端情况: 12000 字符, 15 行（行数不足）
→ lines.length(15) <= keepHeadLines(10) + keepTailLines(5)
→ fallbackTruncate(12000)
→ budget = 4800, head = 2400, tail = 2400
→ ~4800 字符 + 标记 ≈ 40% ✅
```

### UC-3: 紧急上下文溢出防护

**验证结论：基本正确，有 1 个估算精度问题（LOW #2）**

| 检查点 | 代码位置 | 结果 |
|--------|---------|------|
| Main Flow 2: contextUsage.percent = 0.91 → 触发 L2 | `processL2()` L195-199 | ✅ `usagePercent >= config.emergencyThreshold(0.9)` 触发 |
| Main Flow 4: 最近 3 轮以外全部过期 | `processL2()` L208-218 | ✅ `!isInProtectedTurn(i, turnBoundaries, config.protectRecentTurns)` |
| Main Flow 5: 配对校验 | `validateToolPairing()` L111-126 | ✅ 检查每个 toolResult 有对应 toolCall |
| Alt A1: percent 为 null → chars/4 估算 | `processL2()` L200-204 | ✅ fallback 到 `(totalChars / 4) / 200000` |
| Alt A2: 配对校验失败 → 安全降级 | `compressContext()` L237-239 | ✅ `return { messages, stats: { ...stats, validationFailed: true } }` 返回原始消息 |
| L2 跳过已过期消息 | `processL2()` L210 | ✅ `!isToolResultExpired(msg)` |

**问题 #2（LOW）— L2 fallback 估算使用硬编码 200k 上下文窗口：**

```typescript
// processL2() L200-204
usagePercent = (totalChars / 4) / 200000;
```

当 `contextUsage.percent` 为 null 时，使用 chars/4 估算 token 数再除以硬编码的 200k。问题：
1. 不同模型上下文窗口不同（128k / 200k / 1M），硬编码可能导致误判
2. `ContextUsage` 接口提供了 `tokens` 和 `contextWindow` 字段，当 `percent` 为 null 但 `tokens` 可用时，应优先使用 `tokens / contextWindow`
3. 仅在 `tokens` 也为 null 时才回退到 chars/4 估算

**建议修复**：
```typescript
if (contextUsage && contextUsage.percent != null) {
  usagePercent = contextUsage.percent;
} else if (contextUsage && contextUsage.tokens != null) {
  usagePercent = contextUsage.tokens / contextUsage.contextWindow;
} else {
  // 最后 fallback
  let totalChars = 0;
  for (const msg of messages) {
    totalChars += estimateMessageChars(msg);
  }
  usagePercent = (totalChars / 4) / 200000;
}
```

### UC-4: 插件配置与监控

**验证结论：有 1 个 MUST_FIX**

| 检查点 | 代码位置 | 结果 |
|--------|---------|------|
| Main Flow 1: /context-engineering 显示配置+统计 | `commands.ts:handleContextEngineeringCommand()` | ✅ 无参数时 `formatConfigSummary() + formatStats()` |
| Main Flow 3: /context-engineering l1 off 禁用 L1 | `commands.ts` L85-86 | ✅ `config.l1.enabled = false` |
| Main Flow 4: 后续 context 事件只执行 L0 和 L2 | `compressContext()` L225-230 | ✅ L1/L2 有 `if (config.l1.enabled)` / `if (config.l2.enabled)` 检查 |
| Main Flow 5: /context-stats 查看统计 | `commands.ts:handleContextStatsCommand()` | ✅ |
| Alt A1: /context-engineering off → 全局禁用 | `commands.ts` L82-83 | ✅ `config.enabled = false`，`compressContext` 开头检查 |
| Alt A2: 无效参数 → 使用帮助 | `commands.ts` L76-78 | ✅ `parseLevelArgs()` 返回 null → 显示 USAGE_HELP |
| 配置修改立即生效 | commands.ts mutate config | ✅ 命令处理器直接 mutate config 对象，context 事件闭包引用同一对象 |

**问题 #1（MUST_FIX）— L0 始终执行，`config.l0.enabled` 未被检查：**

```typescript
// compressContext() L220-221
// L0 — 无 if (config.l0.enabled) 检查！
const l0 = processL0(messages, config.l0, store, now, boundaries);
```

对比 L1 和 L2：
```typescript
// L1
if (config.l1.enabled) { ... }
// L2
if (config.l2.enabled) { ... }
```

L0 跳过了 `enabled` 检查。当用户执行 `/context-engineering l0 off` 时：
- 命令处理器正确设置 `config.l0.enabled = false`
- 但 `compressContext()` 仍然无条件执行 `processL0()`
- 结果：L0 无法通过命令禁用

这违反了 UC-4 的 postcondition "配置修改立即生效"。

**修复方向**：在 `compressContext()` 中 L0 调用前加 `if (config.l0.enabled)` 检查。

**等级判定**：功能失效 — 用户通过命令禁用 L0 后，L0 仍在执行。属于"某段代码因注册/调用/时序问题从未被执行"的等价情况（配置开关不生效）。

### 额外发现（非 UC 对照）

**问题 #4（LOW）— Recall store 无 GC 机制：**

CLAUDE.md 规定："自行实现 GC（splice 旧 entries），防止长 session 中 entries 无限积累"。当前 recall store 仅在 session_start 时重建清空，session 内部无任何淘汰逻辑。长时间编码 session 可能积累大量条目（每条包含完整的 tool result 原文），内存持续增长。

建议：添加最大条目数限制（如 500），超过时淘汰最旧的条目。或添加 TTL 机制（如 2 小时后淘汰）。

**问题 #5（INFO）— 8 字符 UUID 碰撞风险：**

`store.store()` 使用 `randomUUID().slice(0, 8)` 生成 32 位 ID。理论上在 ~77,000 条目时有 50% 碰撞概率（生日悖论）。实际使用中单个 session 极少超过数百条目，风险极低。如需防御，可在 `entries.set()` 前检查 ID 是否已存在。

**问题 #6（INFO）— hasUserAfter 仅检查 user 消息：**

```typescript
// processL0() 中预计算 hasUserAfter
if (messages[i].role === "user") seenUser = true;
```

`findTurnBoundaries()` 将 `user` 和 `bashExecution` 都视为 turn boundary，但 `hasUserAfter` 只检查 `user`。理论上 bash 执行后 thinking 仍可能被误清，但实际场景中 bash 是 agent 发起的，与 thinking 活跃度无关。当前行为合理，仅标记为一致性观察。

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | `compressor.ts:compressContext()` L220 | `config.l0.enabled` 未检查，L0 无法通过命令禁用 | 在 L0 调用前加 `if (config.l0.enabled)` |
| 2 | LOW | `compressor.ts:processL2()` L200-204 | L2 fallback 使用硬编码 200k 上下文窗口，忽略可用的 `contextUsage.tokens` | 三级 fallback：percent → tokens/contextWindow → chars/4 / 200000 |
| 3 | LOW | `compressor.ts:processL0()` → `processL1()` 交互 | L0 过期 L1 已压缩消息时，recall 存储压缩文本而非原始内容，过期消息文案误导 | 选项 A：L0 过期时检查 content 是否包含 `[Condensed`，从已有 store 中提取原始内容；选项 B：更新过期消息文案为 "retrieve the compressed content" |
| 4 | LOW | `recall-store.ts` | 无 GC 机制，长 session 条目无限累积 | 添加 maxEntries 限制或 TTL 淘汰 |
| 5 | INFO | `recall-store.ts:store()` | 8 字符 UUID 无碰撞检测 | 风险极低，可忽略 |
| 6 | INFO | `compressor.ts:processL0()` hasUserAfter | 仅检查 user 消息，与 turn boundary 检测不一致 | 当前行为合理，仅记录 |

## 结论

需修改后重审。1 条 MUST_FIX：`compressContext()` 缺少 `config.l0.enabled` 检查，导致 L0 无法通过命令禁用。修复后可重审。

### Summary

业务逻辑审查完成，第1轮，1条MUST FIX，需修改后重审。
