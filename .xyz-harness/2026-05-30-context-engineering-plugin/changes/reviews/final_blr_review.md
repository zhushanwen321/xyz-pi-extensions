---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-31T01:30:00"
  target: "context-engineering/src/"
  verdict: fail
  summary: "BLR编码评审完成，第1轮，2条MUST FIX，需修改后重审"

statistics:
  total_issues: 8
  must_fix: 2
  must_fix_resolved: 0
  low: 4
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "context-engineering/src/compressor.ts:L106-111"
    title: "Bash截断首尾比例不符合spec — spec要求首尾各一半阈值，代码用40%/40%"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "context-engineering/src/compressor.ts:L224-229"
    title: "L2 stats.triggered语义不一致 — 无任何toolResult可过期时triggered=false但usagePercent已超阈值"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "context-engineering/src/compressor.ts:L143-149"
    title: "Thinking清理条件与spec不完全匹配 — spec要求'该thinking块之后无user消息>=5min'，代码用'reverse hasUserAfter + 整条消息age>5min'"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "context-engineering/src/commands.ts:L90-99"
    title: "/context-engineering on|off 解析与spec不一致 — spec写'on|off'，代码要求'global on|off'"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "context-engineering/src/config.ts:L87"
    title: "settings.jsonl 实际读取 settings.json — C-4写settings.jsonl但代码读settings.json"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "context-engineering/src/compressor.ts:L160"
    title: "L1 condenseToolResult 压缩比下界检查缺失 — spec要求20-40%，代码只检查上界40%"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: INFO
    location: "context-engineering/src/index.ts:L62-69"
    title: "context事件handler中catch块为空 — 与项目CLAUDE.md中no-silent-catch规则冲突"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: INFO
    location: "context-engineering/src/recall-store.ts:L28"
    title: "ID格式ctx-{uuid8}可能碰撞 — UUID前8字符碰撞概率极低但非零"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# BLR 编码评审 v1 — Context Engineering Plugin

## 评审记录
- 评审时间：2026-05-31 01:30
- 评审类型：编码评审（Business Logic Review）
- 评审对象：context-engineering/src/ 全部源码 + 测试
- 评审范围：spec 一致性（FR 覆盖、AC 验证、Constraint 遵守）

---

## 一、FR → 实现对照表

| FR | 描述 | 实现位置 | 覆盖状态 | 备注 |
|----|------|---------|---------|------|
| FR-1 | Tool Result 过期清理 (L0) | `compressor.ts:L196-216` processL0 中 toolResult 分支 | ✅ 完整 | 过期时间、protectRecentTurns、替换格式、ID分配均实现 |
| FR-2 | Bash Execution 输出截断 (L0) | `compressor.ts:L218-226` processL0 中 bashExecution 分支 | ⚠️ 部分偏差 | **截断比例不符**：spec 要求"首尾各保留 bashTruncateChars/2"，代码用 40%/40%（见 Issue #1） |
| FR-3 | Thinking 块空闲清理 (L0) | `compressor.ts:L228-244` processL0 中 assistant 分支 | ⚠️ 部分偏差 | 清理条件实现有差异（见 Issue #3），但功能意图已覆盖 |
| FR-4 | Tool Result 规则化摘要 (L1) | `compressor.ts:L102-170` condenseToolResult + processL1:L258-284 | ✅ 完整 | 正则匹配、head/tail保留、import/definition提取、fallback均实现 |
| FR-5 | 原始内容 Recall | `recall-store.ts` 全文 + `index.ts:L37-47` recallResult | ✅ 完整 | store/recall/clear、闭包变量、session_start重建、错误处理不throw |
| FR-6 | ToolCall/ToolResult 配对完整性 | `compressor.ts:L172-190` validateToolPairing + `compressor.ts:L313-316` 调用点 | ✅ 完整 | 双向校验（orphan toolResult + unmatched toolCall）、失败安全降级 |
| FR-7 | 紧急压缩 (L2) | `compressor.ts:L290-325` processL2 | ⚠️ 部分偏差 | stats.triggered 语义有误（见 Issue #2），功能意图已覆盖 |
| FR-8 | 压缩动作统计 | `compressor.ts` CompressionStats + `index.ts:L18-27` addStats + `commands.ts` | ✅ 完整 | 累计计数器、/context-stats、/context-engineering 均展示统计 |
| FR-9 | 配置与启停 | `config.ts` loadConfig + `commands.ts` handleContextEngineeringCommand | ⚠️ 部分偏差 | 全局 on/off 需要前缀 "global"（见 Issue #4），与 spec 描述不一致 |

---

## 二、AC → 测试 对照表

| AC | 场景 | 覆盖状态 | 测试位置 | 备注 |
|----|------|---------|----------|------|
| AC-1 | 过期 tool_result 被替换 + recall | ✅ | compressor.test.ts: "AC-1" + integration.test.ts: TC-1-01, TC-1-02 | 35min过期、protectRecentTurns保护、recall获取原始内容均有验证 |
| AC-2 | Bash 输出截断 | ⚠️ | compressor.test.ts: "AC-2" + integration.test.ts: TC-2-01, TC-2-02 | 测试验证了截断发生，但未验证首尾比例精确为 threshold/2（与 Issue #1 关联） |
| AC-3 | Thinking 清理 | ✅ | compressor.test.ts: "AC-3" + integration.test.ts: TC-3-01 | 6分钟空闲清理验证通过 |
| AC-4 | ToolCall/ToolResult 配对 | ✅ | compressor.test.ts: "AC-4" + integration.test.ts: TC-4-01, TC-4-02 | 正常序列+损坏序列+安全降级均覆盖 |
| AC-5 | Recall 完整性 | ✅ | integration.test.ts: TC-5-01, TC-5-02 | 存在ID + 不存在ID 均覆盖 |
| AC-6 | 不干扰原生 Compact | ❌ | **无测试** | 无自动化测试验证（合理——这需要集成环境，但应标记） |
| AC-7 | L1 规则化摘要 | ✅ | compressor.test.ts: "AC-7" + integration.test.ts: TC-7-01, TC-7-02 | TypeScript代码摘要 + 非代码fallback均覆盖 |
| AC-8 | Level 2 紧急压缩 | ✅ | compressor.test.ts: "AC-8" + integration.test.ts: TC-8-01, TC-8-02 | 91%触发 + 85%不触发均验证 |
| AC-9 | 压缩统计命令 | ✅ | integration.test.ts: TC-9-01 | 统计数字包含验证 |
| AC-10 | 配置与启停 | ✅ | compressor.test.ts: "AC-10" + integration.test.ts: TC-10-01, TC-10-02 | 全局禁用 + 独立级别启停均覆盖 |

---

## 三、Constraint → 实现对照表

| Constraint | 描述 | 遵守状态 | 实现位置 | 备注 |
|-----------|------|---------|---------|------|
| C-1 | 不替代原生 Compact | ✅ | index.ts — 未注册 session_before_compact 事件 | 无任何 cancel:true 返回 |
| C-2 | 不修改 Session Entries | ✅ | 全部代码 — 无 appendEntry 调用 | 只在 context 事件返回值中操作深拷贝 |
| C-3 | 原始内容不持久化 | ✅ | recall-store.ts — Map<string, StoredContent> 闭包变量 | session_start 时 clear+重建 |
| C-4 | 配置格式 | ⚠️ | config.ts:L87 — 读取 `settings.json` | **文件扩展名不一致**（见 Issue #5） |
| C-5 | 配对安全校验 | ✅ | compressor.ts:L172-190 + L313-316 | 双向校验 + 失败安全降级 |
| C-6 | 性能约束 | ✅ | 全部代码 — 纯字符串/正则操作 | 无 LLM 调用、无网络请求 |
| C-7 | 不修改消息结构 | ✅ | processL0/L1/L2 — 只替换 content/output 字段 | role/toolCallId/timestamp 等元数据不变 |
| C-8 | 流水线顺序 L0→L1→L2 | ✅ | compressContext:L296-320 | 按顺序调用，每级独立扫描 |
| C-9 | Turn 定义 | ✅ | compressor.ts:L76-98 findTurnBoundaries | user/bashExecution 作为 turn 边界 |

---

## 四、发现的问题

### Issue #1 — MUST_FIX: Bash截断首尾比例与spec不符

**位置**: `compressor.ts:L106-111`（truncateBashOutput 函数）

**Spec 要求**:
> 首尾各保留 `bashTruncateChars / 2` 字符

即阈值 4000 时，保留首 2000 + 尾 2000，总共保留 4000 字符。

**实际代码**:
```typescript
const headChars = Math.floor(maxChars * 0.4);  // 4000 * 0.4 = 1600
const tailChars = Math.floor(maxChars * 0.4);  // 4000 * 0.4 = 1600
// 总共保留 3200 字符，而非 4000
```

**数据推演**: 输入 10000 字符，bashTruncateChars=4000
- Spec 预期：head=2000, tail=2000, 截断标记 ~100字符, 总输出 ~4100
- 实际输出：head=1600, tail=1600, 截断标记 ~100字符, 总输出 ~3300

**影响**: 截断比 spec 预期更激进，可能丢失有用信息。同时 AC-2 描述的"前 2000 + 后 2000"不成立。

**修改方向**: `Math.floor(maxChars * 0.4)` → `Math.floor(maxChars / 2)`

---

### Issue #2 — MUST_FIX: L2 stats.triggered 语义错误

**位置**: `compressor.ts:L316-324`（processL2 函数）

**Spec 要求** (FR-7):
> 执行时更新压缩统计计数器

FR-8:
> L2 紧急触发次数

**实际代码**:
```typescript
// L320: L2 判定条件满足，进入压缩循环
// L316-324: anyForceExpired 只在有 toolResult 被实际过期时为 true
// 如果所有 toolResult 都已被 L0 过期，或都在保护 turn 内
// → L2 判定条件满足（usagePercent >= threshold）
// → 但 anyForceExpired = false → stats.triggered = false
```

**数据推演**:
- usagePercent = 0.95（超过 0.9 阈值）
- 消息列表中只有已被 L0 过期的 toolResult
- L2 进入循环，`isToolResultExpired(msg)` = true → 跳过 → `anyForceExpired = false`
- 结果：`stats.triggered = false`
- 但 L2 确实被触发了（进入了压缩路径，执行了扫描）

**影响**: /context-stats 和 /context-engineering 显示的 "L2 triggered: false" 误导用户。L2 被判定触发但无实际操作时，统计不反映真实情况。

**修改方向**: 在进入 L2 压缩循环之前就设置 triggered = true（当 usagePercent >= threshold 时），或者在 compressContext 层面根据 usagePercent 判断是否触发，而非依赖 anyForceExpired。

---

### Issue #3 — LOW: Thinking清理条件与spec描述不完全匹配

**位置**: `compressor.ts:L143-149`（processL0 中 thinking 分支）

**Spec 要求**:
> 该 thinking 块所在消息之后，有 >= thinkingExpireMinutes 分钟无新 user 消息

**实际代码**:
```typescript
const hasUserAfter = new Array<boolean>(messages.length).fill(false);
// ... 反向扫描，标记每个位置之后是否有 user 消息

const age = now - msg.timestamp;
const thinkingExpired = age > config.thinkingExpireMinutes * 60000;

if (thinkingExpired && !hasUserAfter[i]) {
```

**分析**:
- 代码要求 `age > 5min AND 之后无任何 user 消息`
- Spec 要求 `该 thinking 之后 >= 5min 无新 user 消息`

差异：假设消息序列 `[assistant(thinking, 10min前), user(3min前)]`
- Spec：thinking 之后 3min 有 user → 未过期 → thinking 保留（但距离现在已 10min）
- 代码：age=10min > 5min → thinkingExpired=true, hasUserAfter=true → 保留 → 结果一致

再假设 `[assistant(thinking, 10min前), user(8min前), assistant(6min前, thinking), user(1min前)]`
- 对于第一个 thinking（10min前）：age=10min > 5min, hasUserAfter=true → 保留
- 对于第二个 thinking（6min前）：age=6min > 5min, hasUserAfter=true → 保留

实际上代码的 `hasUserAfter` 是布尔值（是否有任何后续 user），不是"是否超过 5 分钟无 user"。代码等价于 "消息整体 age > 5min 且之后无任何 user"，比 spec 的 "之后 >= 5min 无 user" 更严格。

但在实际场景中，thinking 块的清理时机差异很小——只要后面有 user 消息就说明 turn 还在进行，不应清理。两种语义在 99% 场景下等价。

**修改方向**: 如果要精确匹配 spec，需要计算"最后一个后续 user 消息到现在的时间差"而非简单的布尔值。但当前实现在实践中可接受。

---

### Issue #4 — LOW: /context-engineering on|off 解析与 spec 不一致

**位置**: `commands.ts:L90-99` + `config.ts:L108-131` parseLevelArgs

**Spec 要求** (FR-9):
> 命令：`/context-engineering on|off` — 全局启用/禁用

**实际代码**:
```typescript
// parseLevelArgs 要求 tokens.length >= 2
// 有效 target: "global" | "l0" | "l1" | "l2"
// 有效 action: "on" | "off"
```

用户执行 `/context-engineering on` → `parseLevelArgs("on")` → tokens = ["on"] → length < 2 → return null → 显示 USAGE_HELP。

**修改方向**: 在 parseLevelArgs 中支持单参数 "on"/"off" 等价于 "global on"/"global off"，或在 handleContextEngineeringCommand 中特殊处理。

---

### Issue #5 — LOW: 配置文件扩展名不一致

**位置**: `config.ts:L87`

**Spec 要求** (C-4):
> 所有配置通过 `settings.jsonl` 的 `context-engineering` key 管理

**实际代码**:
```typescript
const filePath = settingsPath ?? join(homedir(), ".pi", "agent", "settings.json");
```

代码读取 `settings.json`，spec 写的是 `settings.jsonl`。需确认 Pi 实际使用的文件名。如果 Pi 使用 JSONL 格式（每行一个 JSON），当前 JSON.parse 会解析失败（多行 JSON 不合法），但 catch 会 fallback 到默认配置，不会报错。

**修改方向**: 确认 Pi 实际配置文件格式后统一 spec 和代码。

---

### Issue #6 — LOW: L1 摘要压缩比下界未检查

**位置**: `compressor.ts:L160`（condenseToolResult）

**Spec 要求** (FR-4):
> 最终摘要长度目标：原始的 20-40%

**实际代码**:
```typescript
if (result.length > content.length * 0.4) {
  return fallbackTruncate(content);
}
return result;
```

代码只检查上界（> 40% 时 fallback），不检查下界（< 20%）。当中间部分几乎没有 import/definition 行时，结果可能非常短（远低于 20%），虽然这不是功能错误（更短意味着更好的压缩），但与 spec 的 20-40% 目标范围不完全匹配。

**修改方向**: 可忽略——压缩比目标实际是软约束，"目标"不等于"必须"。

---

### Issue #7 — INFO: context 事件 handler 空 catch

**位置**: `index.ts:L62-69`

```typescript
pi.on("context", (event, ctx) => {
  try {
    // ...
  } catch { return {}; }
});
```

项目 CLAUDE.md 中有 `no-silent-catch` 规则。这里的空 catch 块虽然在扩展环境下可以理解（不想因压缩失败影响主流程），但违反了项目编码规范。

**修改方向**: 考虑至少加 `console.error` 或用 Pi 的日志 API 记录异常。

---

### Issue #8 — INFO: ctx-{uuid8} 碰撞概率

**位置**: `recall-store.ts:L28`

```typescript
const uuid8 = randomUUID().slice(0, 8);
```

UUID v4 前 8 个十六进制字符只有 32 bit 摘要空间。根据生日悖论，存储约 65000 条内容时碰撞概率约 1%。实际场景中一个 session 不太可能压缩 65000 条消息，风险极低。

**修改方向**: 无需修改，记录观察即可。

---

## 五、模拟数据推演

### 推演 1: AC-1 完整流程

```
输入:
  messages = [
    User("task", age=36min),
    Assistant([tc("c1")], age=35min),
    ToolResult("5000-char-content", age=35min, toolCallId="c1"),
    User("followup", age=1min),
  ]
  config.l0.expireMinutes = 30
  config.l0.protectRecentTurns = 2

执行路径:
  1. findTurnBoundaries → [Turn0: [0,3), Turn1: [3,4)]
  2. processL0:
     - msg[2] toolResult: age = 35min > 30min → expired = true
     - isInProtectedTurn(2, boundaries, 2):
       - protectedStart = max(0, 2-2) = 0
       - 检查 Turn0[0,3): 2 ∈ [0,3) → protected = true!
     - expired && protected → 不过期 → 保留原文 ⚠️

  问题发现: ToolResult 在 Turn0（第 1 个 turn），protectRecentTurns=2 保护最近 2 个 turn，
  而 Turn0 是倒数第 2 个 turn（共 2 个 turn），所以在保护范围内。
  
  需要 3 个 turn 才能让 Turn0 不被保护：
  messages = [
    User("task", age=36min),
    Assistant([tc("c1")], age=35min),
    ToolResult("5000-char-content", age=35min, toolCallId="c1"),  // Turn0
    User("task2", age=20min),
    Assistant([tc("c2")], age=19min),
    ToolResult("short", age=19min, toolCallId="c2"),  // Turn1
    User("followup", age=1min),  // Turn2
  ]
  protectRecentTurns=2 → 保护 Turn1 和 Turn2
  Turn0 不被保护 → toolResult 过期 ✅

  这与 compressor.test.ts 中 AC-1 测试的构造一致（3个 turn，Turn0 不被保护）。
```

### 推演 2: L0→L1→L2 流水线

```
输入:
  messages = [
    User("read big file", age=25min),
    Assistant([tc("c1")], age=25min),
    ToolResult("12000-char-code", age=25min, toolCallId="c1"),  // 25min < 30min, > 8000chars
    User("another", age=1min),
  ]
  contextUsage.percent = 0.92

执行路径:
  L0: toolResult age=25min < 30min → 不过期. bash: 无. thinking: 无.
  L1: toolResult text=12000chars > 8000 → condenseToolResult → 摘要.
      store.store("12000-char-code", "l1-condensed") → id="ctx-abc12345"
      替换为 "[Condensed (ID: ctx-abc12345): ...]"
  L2: usagePercent=0.92 > 0.90 → 进入紧急压缩
      msg[2] toolResult → isToolResultExpired? 
        getToolResultText → "[Condensed (ID: ctx-abc12345): ...]"
        .includes("[Tool result expired") → false
      → 未过期 → 检查保护 turn
      → isInProtectedTurn(2, boundaries, 3) → 在保护 turn 内 → 保留
  
  结果: 只有 L1 生效，L2 不操作（消息在保护范围内）。stats.l2Triggered=false ✅

  补充推演: 如果有 5 个 turn，L2 protectRecentTurns=3:
    Turn0 的 toolResult(12000chars, L1已摘要) → 不在保护范围 →
    isToolResultExpired → false (L1摘要不含 "[Tool result expired") →
    L2 会再次过期，覆盖 L1 的摘要。这是预期行为？→ 是的，L2 更激进。
```

### 推演 3: L1 摘要 fallback 路径

```
输入: 纯 JSON 数组，12000 字符，无 import/function/class 行

执行路径:
  condenseToolResult:
    lines.length > 15 (10+5) → 进入 head/middle/tail 分支
    head = 前10行, tail = 后5行
    middle 遍历: 无行匹配 IMPORT_EXPORT_RE 或 DEFINITION_RE → 全部 omit
    keptMiddle = ["[... N lines omitted]"]
    result = head + ["[... N lines omitted]"] + tail
    result.length 检查: JSON 通常紧凑，head+tail 可能 < 40% → 返回 result
    
    如果 JSON 是压缩的（少数长行）:
    lines.length 可能 < 15 → 直接 fallbackTruncate
    fallbackTruncate: 12000 * 0.4 = 4800, head=2400, tail=2400
    结果: 首 2400 字符 + "[... truncated for space]" + 尾 2400 字符

  integration.test.ts TC-7-02 验证了这条路径 ✅
```

### 推演 4: 配对校验失败安全降级

```
输入:
  messages = [
    ToolResult("orphan", toolCallId="c-missing"),  // 无对应 toolCall
  ]

执行路径:
  L0: msg[0] toolResult, age < 30min → 不过期 → push
  L1: text < 8000 → 不摘要 → push
  L2: 假设 usagePercent < 0.9 → 不触发
  validateToolPairing(current):
    msg[0] role=toolResult, toolCallId="c-missing"
    pendingToolCalls = Set{} → !has("c-missing") → return false
  → return { messages: original, stats: { validationFailed: true } }

  integration.test.ts TC-4-02 验证了这条路径 ✅
```

### 推演 5: L2 triggered 语义问题验证（Issue #2）

```
输入:
  messages = [
    User("t1", 40min),
    Assistant([tc("c1")], 40min),
    ToolResult("content", 35min, "c1"),  // 已被 L0 过期
    User("t2", 1min),
  ]
  contextUsage.percent = 0.95

执行路径:
  L0: toolResult age=35min > 30min → 已过期 → 替换为 "[Tool result expired. ID: ctx-xxx...]"
  L1: isToolResultExpired(msg) → true → 跳过
  L2: usagePercent=0.95 > 0.90 → 进入压缩循环
      msg[2] toolResult → isToolResultExpired → true → 跳过
      → anyForceExpired = false → stats.triggered = false
  
  结果: stats.l2Triggered = false, 但 L2 判定条件确实满足了（0.95 > 0.90）
  用户看到 "L2 triggered: false" → 误解为 L2 从未触发 ⚠️
```

---

## 六、测试覆盖分析

### 测试文件清单

| 文件 | 行数 | 覆盖范围 |
|------|------|---------|
| compressor.test.ts | 306 | 单元级 FR 验证（AC-1/2/3/4/7/8/10） |
| integration.test.ts | 390 | 集成级端到端验证（TC-1 到 TC-10） |

### 测试缺失项

| 缺失 | 严重性 | 说明 |
|------|--------|------|
| AC-6 不干扰原生 Compact | INFO | 需集成环境，合理缺失 |
| L0 + L1 + L2 联合流水线测试 | LOW | 各级独立测试充分，但联合测试仅有 AC-8 中隐含覆盖 |
| 并发/session_start 状态重置测试 | LOW | 闭包变量重置逻辑未测试 |
| config.ts 的 loadConfig 单元测试 | LOW | 配置文件读取、deep merge、fallback 未独立测试 |
| L2 fallback 到 chars/4 估算路径 | LOW | 只测了 contextUsage.percent 非 null 的路径 |

---

## 七、结论

需修改后重审。2 条 MUST FIX 需要修复：

1. **Issue #1**: Bash 截断比例 `0.4` → `0.5`，一行代码修改
2. **Issue #2**: L2 triggered 统计语义，需要区分"判定触发"和"实际过期了内容"

### Summary

编码评审完成，第1轮，2条MUST FIX，需修改后重审。
