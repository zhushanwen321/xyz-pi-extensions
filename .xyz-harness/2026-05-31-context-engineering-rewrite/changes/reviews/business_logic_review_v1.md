---
verdict: fail
must_fix: 2
review_metrics:
  files_reviewed: 6
  issues_found: 4
  must_fix_count: 2
  low_count: 1
  info_count: 1
  duration_estimate: "25"
---

# Dev Business Logic Review v1

## 审查记录
- 审查时间：2026-05-31 22:30
- 审查模式：Dev
- 审查对象：use-cases.md + git diff + 源代码（compressor.ts, frozen-fresh.ts, config.ts, index.ts, commands.ts）
- 模拟数据路径数：6

## UC 覆盖追踪

| UC 编号 | UC 名称 | 覆盖状态 | 执行路径 | 发现的问题 |
|---------|---------|---------|----------|-----------|
| UC-1 | Microcompact Time-Based 清理 | ✅ 完整 | processMicrocompact → 时间判定 → 候选收集 → keepRecent 保护 → 清理 | — |
| UC-2 | Tool Result Budget 预算控制 | ⚠️ 部分 | processBudget → 分组 → 计算 chars → 持久化最大 | 步骤 10 循环缺失（#2 MUST_FIX） |
| UC-3 | Frozen/Fresh 状态保持 | ❌ 未覆盖 | compressContext 每次创建新 FrozenFreshState | 跨 turn 状态丢失（#1 MUST_FIX） |
| UC-4 | Compact Boundary 感知 | ✅ 完整 | findCompactBoundary → MC/L1/L2 边界跳过 | — |
| UC-5 | L1 Protected Turn 保护 | ✅ 完整 | processL1 → isInProtectedTurn → 跳过保护范围 | — |
| UC-6 | 配置启停 | ✅ 完整 | handleContextEngineeringCommand → parseLevelArgs → toggle config | — |

## 问题清单

| # | 严重度 | UC 编号 | 描述 | 文件 | 行号/位置 | 修改建议 |
|---|--------|---------|------|------|----------|---------|
| 1 | MUST_FIX | UC-3 | `compressContext` 每次调用创建新 `FrozenFreshState`，跨 turn 冻结决策丢失。`index.ts` 中声明的 `frozenFreshState` 从未传入 `compressContext`，是死代码 | compressor.ts ~L730, index.ts ~L56 | `const ffState = createFrozenFreshState()` | 1. `compressContext` 签名增加 `ffState: FrozenFreshState` 参数；2. `index.ts` 中 `pi.on("context")` 传入持久化的 `frozenFreshState`；3. 删除 `compressContext` 内部的 `createFrozenFreshState()` 调用 |
| 2 | MUST_FIX | UC-2 | `processBudget` 每个 user 消息分组只持久化 1 个 toolResult，不循环重评估。UC-2 步骤 10 明确要求"重新计算该 user 消息的 toolResult 总大小，若仍超预算，重复步骤 6-9" | compressor.ts processBudget | `if (totalFreshChars > ...)` 分支 | 改为 `while` 循环：持久化最大 → 重新计算 freshEntries 和 totalFreshChars → 直到 totalFreshChars ≤ 预算 或 freshEntries 为空 |
| 3 | LOW | UC-4 | `findCompactBoundary` 用 `content.includes("compactionSummary")` 字符串匹配检测边界，仅在 `typeof content === "string"` 时生效。若 Pi 运行时使用 array 格式 content 的 compactionSummary 消息，将漏检 | compressor.ts findCompactBoundary | for 循环内 | 增加 array 格式 content 的检测：遍历 content 数组查找 text 包含 "compactionSummary" |
| 4 | INFO | UC-3 | `index.ts` 声明了 `let frozenFreshState: FrozenFreshState = createFrozenFreshState()` 并在 `session_start` 中重建，但该变量从未被任何函数使用 | index.ts | L56 | 与 #1 修复一同处理：传入 `compressContext` 即激活此变量 |

## 执行路径详情（Dev 模式）

### UC-1: Microcompact Time-Based 清理

**模拟数据：**
```json
{
  "messages": [
    {"role": "user", "content": "task", "timestamp": 70000},
    {"role": "assistant", "content": [{"type": "toolCall", "id": "c1", "name": "read", "arguments": {}}], "timestamp": 68000},
    {"role": "toolResult", "toolCallId": "c1", "toolName": "read", "content": [{"type": "text", "text": "content-1"}], "timestamp": 67000},
    {"role": "toolResult", "toolCallId": "c2", "toolName": "read", "content": [{"type": "text", "text": "content-2"}], "timestamp": 66000},
    {"role": "toolResult", "toolCallId": "c3", "toolName": "read", "content": [{"type": "text", "text": "content-3"}], "timestamp": 66000},
    {"role": "toolResult", "toolCallId": "c4", "toolName": "read", "content": [{"type": "text", "text": "content-4"}], "timestamp": 66000},
    {"role": "toolResult", "toolCallId": "c5", "toolName": "read", "content": [{"type": "text", "text": "content-5"}], "timestamp": 66000},
    {"role": "toolResult", "toolCallId": "c6", "toolName": "read", "content": [{"type": "text", "text": "content-6"}], "timestamp": 66000},
    {"role": "toolResult", "toolCallId": "c7", "toolName": "read", "content": [{"type": "text", "text": "content-7"}], "timestamp": 66000},
    {"role": "toolResult", "toolCallId": "c8", "toolName": "read", "content": [{"type": "text", "text": "content-8"}], "timestamp": 66000},
    {"role": "assistant", "content": [{"type": "text", "text": "done"}], "timestamp": 65000}
  ],
  "config": {"enabled": true, "gapThresholdMinutes": 60, "keepRecent": 5},
  "now": 100000
}
```

**执行路径：**
```
compressContext(messages, config, store, undefined)
→ findCompactBoundary(messages) → null (无 compactionSummary)
→ processMicrocompact(messages, config.mc, 100000, null)
  → lastAssistantTs = 65000
  → 100000 - 65000 = 35000ms = 0.58min < 60min → 不触发
```

**修正：now = 100000 + 65*60000 = 400000**
```
→ 400000 - 65000 = 335000ms = 5.58min → 仍 < 60min
```

**再修正：now = 65000 + 65*60000 = 3965000**
```
→ 3965000 - 65000 = 3900000ms = 65min > 60min → 触发
→ 候选收集: c1-c8 全部 compactable (toolName="read")，无已过期
→ 8 候选，keepRecent=5 → keepFrom=3 → toClear=[c1,c2,c3]
→ c1,c2,c3 替换为 "[Old tool result content cleared]"
→ stats: {triggered: true, cleared: 3}
→ 无 recall ID ✓
```

**异常路径 A1（无 assistant 消息）：**
```
→ lastAssistantTs = 0 → 条件 "lastAssistantTs === 0" → return {triggered: false, cleared: 0} ✓
```

**异常路径 A2（候选 ≤ keepRecent）：**
```
→ candidateIdxs.length <= 5 → return {triggered: true, cleared: 0} ✓
```

---

### UC-2: Tool Result Budget 预算控制

**模拟数据：**
```json
{
  "messages": [
    {"role": "user", "content": "task", "timestamp": 1000},
    {"role": "assistant", "content": [
      {"type": "toolCall", "id": "c1", "name": "read", "arguments": {}},
      {"type": "toolCall", "id": "c2", "name": "read", "arguments": {}},
      {"type": "toolCall", "id": "c3", "name": "read", "arguments": {}},
      {"type": "toolCall", "id": "c4", "name": "read", "arguments": {}},
      {"type": "toolCall", "id": "c5", "name": "read", "arguments": {}}
    ], "timestamp": 1001},
    {"role": "toolResult", "toolCallId": "c1", "toolName": "read", "content": [{"type": "text", "text": "a"*20000}], "timestamp": 1002},
    {"role": "toolResult", "toolCallId": "c2", "toolName": "read", "content": [{"type": "text", "text": "a"*20000}], "timestamp": 1002},
    {"role": "toolResult", "toolCallId": "c3", "toolName": "read", "content": [{"type": "text", "text": "a"*20000}], "timestamp": 1002},
    {"role": "toolResult", "toolCallId": "c4", "toolName": "read", "content": [{"type": "text", "text": "a"*20000}], "timestamp": 1002},
    {"role": "toolResult", "toolCallId": "c5", "toolName": "read", "content": [{"type": "text", "text": "B"*170000}], "timestamp": 1003}
  ],
  "budget": {"enabled": true, "maxToolResultCharsPerMessage": 200000, "previewSize": 2000}
}
```

**执行路径：**
```
compressContext → processBudget
→ 分组: groupStart=0, groupEnd=8 (第一条 user 消息 index=0, 下一条 user 在 index=8=长度)
  → groupStart=0 → 扫描 [0, 8)
  → toolResults: c1(20K), c2(20K), c3(20K), c4(20K), c5(170K)
  → 全部 fresh (新 ffState)
  → totalFreshChars = 4*20000 + 170000 = 250000 > 200000
  → 找最大: c5 (170K)
  → store.store("BBB...", "budget-persisted") → id = "ctx-xxx"
  → replacement = "[Persisted output (ID: ctx-xxx). Preview: BBB...(2000)... Total: 170000 chars]"
  → ffState.markFrozen("c5", replacement)
  → persisted=1
→ ✅ c5 被持久化，c1-c4 保留
→ ❌ 但不循环: 如果场景改为 5 个各 60K = 300K，持久化一个 60K 后剩余 240K > 200K，未继续持久化
```

**⚠️ 问题 #2 确认：循环缺失。** 以 5 个各 60K = 300K 为例：

```json
{
  "fresh_toolResults": [
    {"id": "c1", "chars": 60000},
    {"id": "c2", "chars": 60000},
    {"id": "c3", "chars": 60000},
    {"id": "c4", "chars": 60000},
    {"id": "c5", "chars": 60000}
  ],
  "totalFreshChars": 300000,
  "budget": 200000
}
```

**预期行为（UC-2 步骤 10）：**
```
迭代 1: 持久化 c1(60K) → 剩余 4*60K = 240K > 200K → 继续
迭代 2: 持久化 c2(60K) → 剩余 3*60K = 180K < 200K → 停止
```

**实际行为：**
```
只持久化 c1(60K) → 剩余 240K > 200K → 不继续 → 超预算 40K
```

---

### UC-3: Frozen/Fresh 状态保持

**模拟数据（Turn 1）：**
```json
{
  "turn": 1,
  "messages": [
    {"role": "user", "content": "read big file"},
    {"role": "assistant", "content": [{"type": "toolCall", "id": "c1", "name": "read"}]},
    {"role": "toolResult", "toolCallId": "c1", "toolName": "read", "content": [{"type": "text", "text": "X"*200000}]}
  ]
}
```

**Turn 1 执行路径：**
```
compressContext → processBudget
→ ffState = createFrozenFreshState() [新建！]
→ c1: fresh, 200K chars > 200K budget? → totalFreshChars=200000, 不超（200000 ≤ 200000）
→ 不持久化
```

**模拟数据（Turn 2，假设有更多 toolResult 导致 c1 所在 user message 超预算）：**
```json
{
  "turn": 2,
  "messages": [
    {"role": "user", "content": "task 1"},
    {"role": "assistant", "content": [{"type": "toolCall", "id": "c1", "name": "read"}]},
    {"role": "toolResult", "toolCallId": "c1", "toolName": "read", "content": [{"type": "text", "text": "X"*200000}]},
    {"role": "assistant", "content": [{"type": "text", "text": "ok"}]},
    {"role": "user", "content": "task 2"},
    {"role": "assistant", "content": [{"type": "toolCall", "id": "c2", "name": "read"}]},
    {"role": "toolResult", "toolCallId": "c2", "toolName": "read", "content": [{"type": "text", "text": "Y"*30000}]}
  ]
}
```

**Turn 2 执行路径（预期 vs 实际）：**

**预期（UC-3 要求）：**
```
→ ffState 应包含 Turn 1 的决策: c1 已被评估过（frozen 状态）
→ c1: isFrozen("c1")=true → 用之前的 replacement → wire prefix 一致
→ c2: fresh → 正常评估
```

**实际：**
```
→ compressContext 内部: ffState = createFrozenFreshState() [新建！Turn 1 的决策丢失]
→ c1: isFrozen("c1")=false → 被当作 fresh 处理
→ 可能产生不同的替换决策 → wire prefix 不一致 → prompt cache miss
```

**❌ 问题 #1 确认：跨 turn 状态丢失。** `compressContext` 每次调用创建新的 `FrozenFreshState`，`index.ts` 中的 `frozenFreshState` 闭包变量从未传入。

**异常路径 E1（replacements 缺失）：**
```
由于每次新建状态，seenIds 始终为空，不存在 "已知 ID 但无 replacement" 的场景。
但 ffState.getReplacement(msg.toolCallId)! 中的非空断言（!）在状态持久化后存在风险：
如果未来修复 #1 后，markFrozen 失败但 isFrozen 返回 true，! 断言会抛出运行时错误。
建议：改为 defensive check，若 replacement 为 undefined 则降级为 fresh 处理。
```

---

### UC-4: Compact Boundary 感知

**模拟数据：**
```json
{
  "messages": [
    {"role": "user", "content": "t0", "timestamp": 7200000},
    {"role": "assistant", "content": [{"type": "toolCall", "id": "c0"}], "timestamp": 7140000},
    {"role": "toolResult", "toolCallId": "c0", "toolName": "read", "content": [{"type": "text", "text": "old-1"}], "timestamp": 7140000},
    {"role": "user", "content": "compactionSummary: summary of prior work", "timestamp": 6000000},
    {"role": "assistant", "content": [{"type": "toolCall", "id": "c3"}], "timestamp": 4800000},
    {"role": "toolResult", "toolCallId": "c3", "toolName": "read", "content": [{"type": "text", "text": "fresh-1"}], "timestamp": 4740000},
    {"role": "assistant", "content": [{"type": "text", "text": "done"}], "timestamp": 3900000}
  ]
}
```

**执行路径：**
```
findCompactBoundary(messages)
→ 扫描: index 0 (user, "t0") → 不含 "compactionSummary"
→ index 3 (user, "compactionSummary: summary of prior work") → typeof content === "string" ✓, includes("compactionSummary") ✓ → lastIdx = 3
→ 返回 3

processMicrocompact: compactBoundaryIdx=3
→ 候选收集: c0 (index 2) → i <= 3 → 跳过 ✓
→ c3 (index 5) → i > 3 → 收集 ✓
→ 边界前的 old-1 不被 MC 处理 ✓

processL1: compactBoundaryIdx=3
→ index 2 (c0): 2 < 3 → 跳过 ✓
→ index 5 (c3): 5 >= 3 → 正常评估 ✓

processL2: compactBoundaryIdx=3
→ 同理: index 2 跳过, index 5 正常评估 ✓
```

**⚠️ LOW 问题 #3：** 如果 compactionSummary 消息的 content 是 array 格式（如 `[{"type": "text", "text": "compactionSummary: ..."}]`），`typeof msg.content === "string"` 为 false，漏检。

---

### UC-5: L1 Protected Turn 保护

**模拟数据：**
```json
{
  "messages": [
    {"role": "user", "content": "task", "timestamp": 60000},
    {"role": "assistant", "content": [{"type": "toolCall", "id": "c1", "name": "read"}], "timestamp": 60000},
    {"role": "toolResult", "toolCallId": "c1", "toolName": "read", "content": [{"type": "text", "text": "x"*12000}], "timestamp": 30000},
    {"role": "user", "content": "followup", "timestamp": 1000}
  ],
  "l1": {"enabled": true, "summaryThresholdChars": 8000, "protectRecentTurns": 2}
}
```

**执行路径：**
```
compressContext → findTurnBoundaries
→ boundaries = [
    {startIndex: 0, endIndex: 3, timestamp: 60000},
    {startIndex: 3, endIndex: 4, timestamp: 1000}
  ]

processL1 → index 2 (c1, 12000 chars > 8000 threshold)
→ isInProtectedTurn(2, boundaries, 2)
  → protectCount=2, protectedStart=max(0, 2-2)=0
  → boundaries[0]: startIndex=0, endIndex=3 → 2 in [0,3) → true → 保护 ✓
→ 跳过 condense → 原文保留 ✓

L2 protectRecentTurns=3 → 2 turns total, protectStart=0 → 全部保护
→ stats.l2Triggered = false ✓
```

**保护范围外场景：**
```json
{
  "messages": [
    {"role": "user", "content": "old task", "timestamp": 600000},
    {"role": "assistant", "content": [{"type": "toolCall", "id": "c1"}], "timestamp": 600000},
    {"role": "toolResult", "toolCallId": "c1", "content": [{"type": "text", "text": "line\n"*3000}], "timestamp": 540000},
    {"role": "user", "content": "task 2", "timestamp": 300000},
    {"role": "assistant", "content": [{"type": "toolCall", "id": "c2"}], "timestamp": 300000},
    {"role": "toolResult", "toolCallId": "c2", "content": [{"type": "text", "text": "small"}], "timestamp": 240000},
    {"role": "user", "content": "task 3", "timestamp": 60000}
  ]
}
```

```
boundaries = [
  {startIndex: 0, endIndex: 3},
  {startIndex: 3, endIndex: 6},
  {startIndex: 6, endIndex: 7}
]

processL1 → index 2 (c1, ~15K chars > 8000)
→ isInProtectedTurn(2, boundaries, 2)
  → protectCount=2, protectedStart=max(0, 3-2)=1
  → boundaries[1]: [3,6) → 2 not in [3,6) → false
  → boundaries[2]: [6,7) → 2 not in [6,7) → false
  → 不保护 ✓
→ condenseToolResult → 生成摘要 → stats.l1Condensed=1 ✓
```

---

### UC-6: 配置启停

**模拟数据：** 命令 `"/context-engineering mc off"`

**执行路径：**
```
handleContextEngineeringCommand("mc off", config, stats)
→ parseLevelArgs("mc off") → {target: "mc", action: "off"}
→ switch("mc") → config.mc.enabled = false
→ 返回 "MC (Microcompact) disabled."
→ 下次 context 事件: config.mc.enabled=false → processMicrocompact 直接 return ✓
→ config.budget.enabled 仍为 true ✓
→ config.l0/l1/l2 不受影响 ✓
```

**异常路径 A1（无效层级）：**
```
→ parseLevelArgs("unknown off") → validTargets 不含 "unknown" → 返回 null
→ 返回 USAGE_HELP ✓
```

## 结论

**需修改：2 条 MUST FIX 问题阻塞通过。**

1. **#1 (UC-3)** — Frozen/Fresh 状态跨 turn 丢失是最严重的问题。当前 `compressContext` 每次创建新 `FrozenFreshState`，导致前序 turn 的冻结决策完全丢失。这直接破坏了 UC-3 的核心保证：wire prefix 一致性（prompt cache 稳定性）。修复方案明确：将 `index.ts` 中的 `frozenFreshState` 通过参数传入 `compressContext`。

2. **#2 (UC-2)** — Budget 循环缺失。当单个 user 消息内多个 toolResult 合计超预算且最大一个的移除不足以回到预算内时，代码不会继续持久化。违反 UC-2 步骤 10 的明确要求。
