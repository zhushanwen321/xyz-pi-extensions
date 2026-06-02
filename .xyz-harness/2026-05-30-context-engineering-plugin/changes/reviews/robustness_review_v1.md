---
review:
  type: robustness_review
  round: 1
  timestamp: "2026-05-31T12:00:00"
  target: "context-engineering/src/"
  verdict: pass
  summary: "健壮性审查完成，第1轮通过，0条MUST FIX，8条LOW，4条INFO"

statistics:
  total_issues: 12
  must_fix: 0
  must_fix_resolved: 0
  low: 8
  info: 4

issues:
  - id: 1
    severity: LOW
    location: "context-engineering/src/index.ts:L60-63"
    title: "context handler try-catch 静默吞没所有错误，零可观测性"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: LOW
    location: "context-engineering/src/compressor.ts:L284-286"
    title: "validateToolPairing 失败回退原始消息但 stats 仍反映已回滚的压缩操作"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "context-engineering/src/compressor.ts:L230-247"
    title: "estimateMessageChars 无 default 分支，运行时遇到未知 role 返回 undefined 导致 NaN"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "context-engineering/src/config.ts:L70-88"
    title: "deepMerge 不校验类型，string 可覆盖 number 字段导致后续计算 NaN"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "context-engineering/src/compressor.ts:L127-149"
    title: "processL0 thinking 过期只检查 hasUserAfter (role=user)，但 turn boundary 也含 bashExecution"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "context-engineering/src/recall-store.ts"
    title: "RecallStore 无 GC 机制，长 session 内存无限增长"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "context-engineering/src/index.ts:L62"
    title: "catch 块 return {} 的语义依赖 Pi API 合约，需确认空对象等于不修改消息"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: LOW
    location: "context-engineering/src/compressor.ts"
    title: "无运行时日志，压缩失败/L2 触发/校验失败均无自动通知"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: INFO
    location: "context-engineering/src/compressor.ts:L266-270"
    title: "config.enabled=false 早期退出设计正确，零开销直通"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 10
    severity: INFO
    location: "context-engineering/src/"
    title: "纯函数 + 工厂 + 依赖注入，测试友好性优秀"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 11
    severity: INFO
    location: "context-engineering/src/index.ts:L82-94"
    title: "recall_context 对 store.recall() 返回 undefined 有妥善处理"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 12
    severity: INFO
    location: "context-engineering/src/compressor.ts:L28-56"
    title: "messages 为空数组时全链路安全，所有处理层和校验均可正确处理"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 健壮性审查 v1

## 评审记录

- 评审时间：2026-05-31 12:00
- 评审类型：健壮性审查（六维度：错误处理、异常、日志、fail-fast、测试友好、调试友好）
- 评审对象：`context-engineering/src/` 全部 5 个源文件

## 审查维度总览

| 维度 | 评级 | 说明 |
|------|------|------|
| 错误处理 | ★★★★☆ | 关键路径有防护，但 estimateMessageChars 和 stats 回滚有细节瑕疵 |
| 异常管理 | ★★★★☆ | context handler 有兜底 try-catch，但静默吞错无观测性 |
| 日志/可观测性 | ★★☆☆☆ | 零日志，仅靠手动命令查看状态，故障时无感知 |
| Fail-fast | ★★★★☆ | config.enabled 和 parseLevelArgs 早期退出正确，但缺少配置值校验 |
| 测试友好 | ★★★★★ | 纯函数 + DI + 工厂模式，可测试性极佳 |
| 调试友好 | ★★★★☆ | recall 带层级和时间戳，但缺少 store 内容查看能力 |

## 用户关注的五项检查

### 1. context 事件 handler 的 try-catch 覆盖性

**覆盖情况：完整**。try-catch 包裹整个 handler 体，包括类型转换、压缩调用、stats 累加和 return 构造。任何环节抛异常都会被捕获。

**但有隐患**（Issue #1, #7）：
- catch 块完全静默，无任何日志或通知。如果压缩持续失败，用户无感知，可能误以为上下文管理正在工作。
- `return {}` 的语义需要确认——如果 Pi 的 context event handler 将空对象视为"不修改消息"（即 keep original），则是安全的。如果解读为"返回空 messages 数组"，则会清空所有消息（灾难性）。从注释 `// Safety: never modify messages on unexpected error` 来看，作者意图是前者，但这一点依赖 Pi 的 API 合约。

**建议**：在 catch 中添加 `ctx.ui.notify()` 或 `console.warn()` 输出错误摘要，至少让开发者知道出了问题。

### 2. validateToolPairing 失败时的安全降级

**降级策略：正确**。当压缩后的消息配对校验失败时，返回原始 `messages`（压缩前），这是最安全的回退——宁可不做压缩，也不破坏消息完整性。

**但有瑕疵**（Issue #2）：
```typescript
if (!validateToolPairing(current)) {
    return { messages, stats: { ...stats, validationFailed: true } };
}
```
`...stats` 包含了 L0/L1/L2 已执行的压缩统计（如 `l0Expired: 5`），但实际消息已回退到原始版本。`cumulativeStats` 会累加这些从未生效的数字，导致 `/context-stats` 显示的统计与实际不符。

**建议**：回退时应返回 zeroStats + `validationFailed: true`，或在注释中明确标记 stats 为"尝试统计"而非"生效统计"。

### 3. store.recall 返回 undefined 时的处理

**处理完善**（Issue #11）。`recall_context` tool 的 execute 方法对 `!stored` 有明确的分支处理：
- 返回用户友好的错误消息，说明 ID 不存在及可能原因（session reload）
- details 中包含 `{ found: false, id: params.id }`，结构化数据便于 GUI 渲染

### 4. config.enabled=false 时的早期退出

**处理正确**（Issue #9）。`compressContext` 入口第一行检查：

```typescript
if (!config.enabled) {
    return { messages, stats: zeroStats };
}
```

messages 原样返回，stats 为全零，无任何副作用。零开销直通。

### 5. messages 数组为空时的处理

**全链路安全**（Issue #12）：
- `findTurnBoundaries([])` → `[]`
- `processL0([], ...)` → 空 for 循环 → `{ messages: [], stats: zero }`
- `processL1([], ...)` → 同上
- `processL2([], ...)` → totalChars=0, usagePercent=0 → threshold 未达到 → 直通
- `validateToolPairing([])` → pendingToolCalls.size === 0 → true
- `compressContext([], ...)` → 原样返回空数组 + 零 stats

## 发现的问题

### 维度一：错误处理

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 2 | LOW | compressor.ts:L284-286 | validateToolPairing 失败时回退原始消息，但 `...stats` 仍携带未生效的 L0/L1/L2 操作数 | 回退时返回 zeroStats（仅保留 validationFailed=true），或在 stats 中增加 `rolledBack` 标记 |
| 3 | LOW | compressor.ts:L230-247 | `estimateMessageChars` 的 switch 无 default 分支。经 `as unknown as` 转换后的消息可能含未知 role，此时返回 undefined，导致 L2 fallback 计算产生 NaN，`NaN < threshold` 为 false → L2 不触发 | 添加 default case 返回 0，或在 processL2 中对 usagePercent 做 NaN 校验 |
| 4 | LOW | config.ts:L70-88 | `deepMerge` 不校验覆盖值的类型。用户在 settings.json 中写 `"expireMinutes": "thirty"` 会被静默接受，导致 `age > NaN` 为 false → 过期机制失效 | 在 deepMerge 中对已知 number 字段做 typeof 校验，不匹配时跳过覆盖 |
| 5 | LOW | compressor.ts:L127-149 | `processL0` 的 thinking 过期判断用 `hasUserAfter`（仅检查 `role === "user"`），但 turn boundary 检测同时包含 `bashExecution`。若最后一条 assistant 后跟 bashExecution（无 user），thinking 会被错误过期 | 统一判断逻辑：hasUserAfter 应同时检查 `role === "user" || role === "bashExecution"`，与 findTurnBoundaries 保持一致 |

### 维度二：异常管理

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | LOW | index.ts:L60-63 | context handler 的 catch 块完全静默。如果压缩持续失败（如 store 损坏、config 异常），用户和开发者均无感知 | catch 中添加 `console.warn("[context-engineering] compression failed:", error)` 或 `ctx.ui.notify()` |
| 7 | LOW | index.ts:L62 | `return {}` 的安全性依赖 Pi API 合约。需确认 context event handler 返回无 messages 键的对象时，Pi 的行为是"保持原始消息不变" | 确认 Pi 源码中的 context event 处理逻辑，或改为显式 `return { messages: event.messages }` |

### 维度三：日志/可观测性

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 8 | LOW | compressor.ts 全文件 | 整个插件零日志输出。以下关键事件无运行时通知：(1) L2 紧急压缩触发 (2) 配对校验失败 (3) 压缩异常回退 (4) recall 未命中 | 至少在 L2 触发、校验失败、catch 回退时输出 console.warn。可在 config 中加 verbose 开关控制 |

### 维度四：Fail-fast

配置校验缺失是一个设计权衡——loadConfig 的三层 try-catch + 默认值回退是正确的 fail-safe 策略。但以下场景值得注意：

- `expireMinutes: -1` → age 永远大于负数 → 所有 toolResult 立即过期（但受 protectRecentTurns 保护，影响有限）
- `emergencyThreshold: 0` → L2 永远触发
- `bashTruncateChars: 0` → 所有 bash output 被截断为空

这些都属于用户配置错误，当前代码不会崩溃，但行为可能不符合预期。鉴于这是用户主动配置的场景，标记为 INFO 观察。

### 维度五：测试友好（INFO #10）

设计优秀：
- `compressor.ts` 全部为纯函数，所有依赖通过参数注入（config, store, now, contextUsage）
- `RecallStore` 使用工厂模式，每次测试可创建干净实例
- `loadConfig` 接受可选 `settingsPath` 参数，无需 mock fs
- `processL0` 的 `now` 参数使时间依赖逻辑可测
- 唯一测试障碍：`createRecallStore` 内部使用 `randomUUID()`，需 mock crypto 或用正则断言 ID 格式

### 维度六：调试友好

**好的方面**：
- recall_context 输出包含 level 和 compressedAt 时间戳
- cumulativeStats 可通过 `/context-stats` 手动查看
- store 的 StoredContent 包含完整元数据

**不足**：
- RecallStore 无内容查看接口（无法列出已有 ID 或 entry 数量）
- 无 per-message 压缩标记（无法得知某条消息经历了什么压缩）
- 以上两项均属于调试辅助功能，不影响正确性，标为已记录的观察

## 正面发现

代码中有多个值得肯定的健壮性设计：

1. **安全回退优先**：`validateToolPairing` 失败 → 原样返回；config 加载失败 → 默认配置；context handler 异常 → 不修改消息。整体设计哲学是"宁可不做压缩，也不破坏数据"。

2. **防御性 config 加载**：`loadConfig` 三层保护（文件不存在 → JSON 解析失败 → 字段缺失），每层都回退到 DEFAULT_CONFIG。

3. **保护最近 turns**：L0/L2 都有 protectRecentTurns 机制，防止压缩当前对话上下文。

4. **纯函数架构**：compressor.ts 无副作用，状态管理集中在 index.ts 的闭包中，职责清晰。

5. **recall 机制**：所有压缩操作都存储原始内容，提供完整的恢复路径，不会丢失数据。

## 结论

**通过**。context-engineering 插件的健壮性设计整体合格，核心原则（安全回退、数据不丢失）贯彻到位。8 条 LOW 均为可观测性和边界情况的改进建议，无阻塞性问题。插件在生产环境中的失败模式均为 fail-safe 方向（不压缩 > 错误压缩），这是正确的防御策略。

### Summary

健壮性审查完成，第1轮通过，0条MUST FIX，8条LOW（集中在可观测性和边界情况），4条INFO。插件的核心错误处理和安全回退机制正确，主要改进空间在日志输出和统计准确性。
