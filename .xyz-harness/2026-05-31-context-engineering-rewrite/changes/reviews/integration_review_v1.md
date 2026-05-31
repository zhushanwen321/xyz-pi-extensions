---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 6
  boundaries_checked: 9
  issues_found: 2
  must_fix_count: 0
  low_count: 1
  info_count: 1
  duration_estimate: "15"
---

# Integration Review v1

## 审查记录
- 审查时间：2026-05-31 20:30
- 上游 BLR: business_logic_review_v2.md
- 模块边界点数：9
- 模拟数据验证路径数：6

## 模块地图

| 模块 | 文件 | 职责 |
|------|------|------|
| index.ts | 扩展入口 | Pi Extension 注册、session 生命周期、事件胶水 |
| compressor.ts | 压缩引擎 | L0/L1/L2/MC/Budget 五级压缩流水线 |
| frozen-fresh.ts | 状态跟踪 | Budget 跨 turn 的 frozen/fresh 标记 |
| config.ts | 配置管理 | 默认配置 + 文件加载 + 深合并 + 命令参数解析 |
| commands.ts | 命令处理 | `/context-engineering` 和 `/context-stats` 命令 UI |
| recall-store.ts | 内容存储 | 压缩原文的内存存储和 ID 检索 |

## 边界检查矩阵

| UC 编号 | 边界点 | D1 格式转换 | D2 错误传播 | D3 契约一致 | 问题 |
|---------|--------|------------|------------|------------|------|
| UC-1 | index→compressor (compressContext) | ✅ | ✅ | ✅ | — |
| UC-1 | compressor 内部 (compressContext→processMicrocompact) | ✅ | — | ✅ | — |
| UC-2 | index→compressor (ffState 传递) | ✅ | — | ✅ | — |
| UC-2 | compressor→frozen-fresh (isFrozen/markFrozen) | ✅ | — | ✅ | — |
| UC-2 | compressor→recall-store (store) | ✅ | — | ✅ | — |
| UC-3 | index→frozen-fresh (createFrozenFreshState + session_start) | ✅ | — | ✅ | — |
| UC-4 | compressor 内部 (findCompactBoundary→各 process*) | ✅ | — | ✅ | — |
| UC-5 | compressor 内部 (findTurnBoundaries→isInProtectedTurn) | ✅ | — | ✅ | — |
| UC-6 | index→config (loadConfig) | ✅ | ✅ | ✅ | — |
| UC-6 | commands→config (parseLevelArgs) | ✅ | — | ✅ | — |
| UC-6 | commands→compressor (CompressionStats 类型) | ✅ | — | ✅ | — |
| UC-tool | index→recall-store (recall_result 工具) | ✅ | ✅ | ✅ | — |

> 注：D4（前后端上下游）不适用于本扩展（纯后端 Pi 进程内执行，无 HTTP API）。

## 问题清单

| # | 严重度 | UC | 边界点 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-----|--------|------|------|------|------|---------|
| 1 | LOW | UC-2 | compressor→frozen-fresh | D1 | frozen entry 的 replacement 长度未计入 `totalFreshChars`，group 总大小可能略超预算（每个 frozen entry 约 2K，影响极小） | compressor.ts processBudget | L250-270 | 可在 frozen 分支中将 `replacement.length` 累加到 `totalFreshChars`，使预算计数严格精确。不阻塞。 |
| 2 | INFO | UC-6 | commands→compressor | D3 | `CompressionStats.validationFailed` 字段在 `formatStats()` 中未展示（纯内部标志，非用户面向数据） | commands.ts formatStats | L50-58 | 无需修改。`validationFailed` 用于 compressContext 内部决策（校验失败时回退原始消息），不是用户关注指标。 |

## 模拟数据验证详情

### UC-1: Microcompact Time-Based 清理 — index→compressor

**模拟数据：**
```json
{
  "messages": [
    {"role": "user", "content": "task", "timestamp": 1000},
    {"role": "assistant", "content": [{"type": "toolCall", "id": "c1", "name": "read"}], "timestamp": 1001},
    {"role": "toolResult", "toolCallId": "c1", "toolName": "read", "content": [{"type": "text", "text": "..."}], "timestamp": 1002}
  ],
  "config.mc": {"enabled": true, "gapThresholdMinutes": 60, "keepRecent": 5},
  "now": 1000 + 61 * 60000
}
```

**调用方传递：** `compressContext(msgs, config, store, ctx, frozenFreshState)`
→ 内部调用：`processMicrocompact(current, config.mc, now, compactBoundaryIdx)`

**被调用方期望：** `(messages: AgentMessage[], config: McConfig, now: number, compactBoundaryIdx: number | null)`

**结论：** ✅ 匹配。`config.mc` 类型为 `McConfig`，与 `processMicrocompact` 参数类型一致。返回 `{ messages, stats: McStats }` 被 compressContext 正确消费。

### UC-2: Tool Result Budget 预算控制 — compressor→frozen-fresh + recall-store

**模拟数据（BLR v2 Turn 1）：**
```json
{
  "turn": 1,
  "messages": [
    {"role": "user", "content": "task"},
    {"role": "assistant", "content": [{"type": "toolCall", "id": "c1"}, {"type": "toolCall", "id": "c2"}]},
    {"role": "toolResult", "toolCallId": "c1", "content": [{"type": "text", "text": "A"*150000}]},
    {"role": "toolResult", "toolCallId": "c2", "content": [{"type": "text", "text": "B"*150000}]}
  ],
  "budget": {"maxToolResultCharsPerMessage": 200000, "previewSize": 2000},
  "ffState": "createFrozenFreshState()"  // 空 Map
}
```

**执行路径推演：**

1. `compressContext` → `processBudget(current, config.budget, store, ffState, null)`
   - `config.budget` 类型 `BudgetConfig` ✅
   - `store` 类型 `RecallStore` ✅
   - `ffState` 类型 `FrozenFreshState` ✅

2. **边界 compressor→frozen-fresh：**
   - `ffState.isFrozen("c1")` → `false`（空 Map）→ 进入 fresh 分支 ✅
   - `ffState.isFrozen("c2")` → `false` → 进入 fresh 分支 ✅
   - while 循环：maxEntry=c1(150K) → `ffState.markFrozen("c1", replacement)` → `frozen.set("c1", replacement)` ✅

3. **边界 compressor→recall-store：**
   - `store.store(text, "budget-persisted")` → 返回 `"ctx-xxxxx"` → 用于 replacement 文本 ✅
   - `level` 参数 `"budget-persisted"` ∈ `StoredContent["level"]` 联合类型 ✅

**结论：** ✅ 匹配。所有边界处类型、数据格式、方法调用均正确。

### UC-2: Tool Result Budget 预算控制 — compressor→frozen-fresh（跨 turn）

**模拟数据（BLR v2 Turn 2）：**
```json
{
  "turn": 2,
  "ffState": {"c1": "[Persisted output (ID: ctx-aaa). Preview: AAA...(2000)... Total: 150000 chars]"},
  "messages": [
    "...(Turn 1 消息)...",
    {"role": "user", "content": "followup", "timestamp": 2000},
    {"role": "assistant", "content": [{"type": "toolCall", "id": "c3"}], "timestamp": 2001},
    {"role": "toolResult", "toolCallId": "c3", "content": [{"type": "text", "text": "C"*80000}], "timestamp": 2002}
  ]
}
```

**执行路径推演：**

1. **index.ts 闭包验证：**
   - `frozenFreshState` 在 Turn 1 后持有 `{c1 → replacement}`
   - `session_start` 未触发 → `frozenFreshState` 保持不变 ✅
   - context 事件传入同一个 `frozenFreshState` 对象 ✅

2. **边界 compressor→frozen-fresh：**
   - Group [0, 5): c1 → `ffState.isFrozen("c1")` = `true` ✅
   - `ffState.getReplacement("c1")` → 返回与 Turn 1 完全相同的 replacement 字符串 ✅
   - Wire prefix 一致 → prompt cache 可命中 ✅
   - c2: `ffState.isFrozen("c2")` = `false` → fresh, chars=150K ✅
   - Group [5, 8): c3: fresh, chars=80K ✅

**结论：** ✅ 匹配。跨 turn 状态持久化正确，replacement 字符串一致性得到保证。

### UC-3: Frozen/Fresh 状态保持 — index→frozen-fresh（session 重启）

**模拟数据（BLR v2 异常路径 E1）：**
```json
{
  "event": "session_start",
  "frozenFreshState": "重建为空的 createFrozenFreshState()"
}
```

**执行路径推演：**
1. `pi.on("session_start")` → `frozenFreshState = createFrozenFreshState()` → 空 Map
2. 下一 context 事件：c1 → `ffState.isFrozen("c1")` = `false` → 当作 fresh
3. 符合 UC-3 A1："session 重启后所有 toolResult 变为 fresh" ✅

**结论：** ✅ 匹配。session 重启后状态正确重置。

### UC-6: 配置启停 — commands→config + commands→compressor

**模拟数据：**
```
用户输入: "/context-engineering mc off"
```

**执行路径推演：**
1. `handleContextEngineeringCommand("mc off", config, cumulativeStats)`
2. **边界 commands→config：** `parseLevelArgs("mc off")` → `{ target: "mc", action: "off" }` ✅
3. **边界 commands→config（config 突变）：** `config.mc.enabled = false` → 突变 index.ts 闭包中的同一对象
4. 下次 context 事件：`compressContext` 检查 `config.mc.enabled` → `false` → 跳过 MC ✅
5. **边界 commands→compressor（stats 类型）：** `formatStats(cumulativeStats)` 访问全部 9 个字段，与 `CompressionStats` 接口一致 ✅

**结论：** ✅ 匹配。配置突变通过闭包共享对象正确传播。

### UC-tool: recall_context 工具 — index→recall-store

**模拟数据：**
```json
{"id": "ctx-aaa"}
```

**执行路径推演：**
1. Tool execute: `recallResult("ctx-aaa", store)`
2. `store.recall("ctx-aaa")` → 返回 `StoredContent | undefined`
3. 找到 → `{ content: [{ type: "text", text: "[Recalled content (budget-persisted, ...)]\n\n..." }], details: { found: true, id: "ctx-aaa", level: "budget-persisted" } }` ✅
4. 未找到 → `{ content: [{ type: "text", text: '[recall_context] ID "ctx-aaa" not found...' }], details: { found: false, id: "ctx-aaa" } }` ✅

**`store` 闭包验证：**
- `recallResult` 是模块级函数，接收 `store` 参数
- Tool execute handler 关闭 over 工厂函数的 `let store` 变量
- `session_start` 重赋值 `store = createRecallStore()` → execute handler 看到新 store（因为关闭的是变量引用，不是值） ✅

**结论：** ✅ 匹配。recall 路径正确，session 隔离通过闭包变量重赋值实现。

## 关键边界交叉验证

### index.ts 的双重类型断言安全性

```typescript
// index.ts
const msgs = event.messages as unknown as CompressorMessage[];
const result = compressContext(msgs, config, store, ...);
return { messages: result.messages as unknown as (typeof event.messages)[number][] };
```

**风险分析：**
- Pi 的 `event.messages` 类型和 compressor 的 `AgentMessage` 类型定义相同结构但位于不同包，TypeScript 无法跨包验证
- 运行时依赖 Pi 实际消息格式与 compressor 预期格式一致
- **防护措施：** 整个调用包裹在 `try/catch` 中，失败时返回 `{}`（原始消息不变）
- `DEBUG_CONTEXT_ENGINEERING` 环境变量控制错误日志输出

**结论：** ✅ 合理的跨包类型桥接策略。有 graceful degradation 保护。

### config 对象共享突变模式

```
index.ts: let config = loadConfig()
  → 传入 commands.ts: handleContextEngineeringCommand(args, config, stats)
    → commands.ts 直接突变: config.mc.enabled = false
  → index.ts context handler: compressContext(msgs, config, ...)
    → 读到最新突变后的 config
```

**分析：**
- `config` 是对象引用，commands.ts 的突变立即对 index.ts 可见
- `session_start` 时 `config = loadConfig()` 重新加载，覆盖所有运行时突变
- 这是 Pi 扩展的标准模式（闭包共享可变状态）

**结论：** ✅ 正确。session_start 作为状态重置的安全阀。

### RecallStore 的 session 隔离

```
index.ts: let store = createRecallStore()
  → session_start: store = createRecallStore()  // 重建
  → recall_result tool: execute 回调关闭 over `store` 变量
  → compressor: store 通过参数传入
```

**分析：**
- Tool execute handler 和 context handler 都关闭 over 同一个 `let store` 变量
- `session_start` 重赋值后，两个 handler 都看到新 store
- recall-store 内部 Map 无外部引用泄漏

**结论：** ✅ 正确。session 隔离通过变量重赋值实现，无泄漏风险。

## 结论

**verdict: PASS**

9 个模块边界点全部通过检查，无 MUST_FIX 问题。

- **D1（数据格式转换）：** 所有边界处类型匹配，跨包类型断言有 graceful degradation 保护
- **D2（错误传播）：** compressContext 调用有 try/catch 保护，recall_result 正确处理 found/not-found
- **D3（接口契约一致性）：** 所有函数签名与调用方传参类型一致，CompressionStats 全部 9 字段被正确消费

2 个遗留问题（1 LOW + 1 INFO）均不影响功能正确性：
- LOW #1：frozen replacement 长度未计入预算（BLR v2 #5 的同一问题，跨边界可见）
- INFO #2：`validationFailed` 未在统计 UI 展示（纯内部标志）
