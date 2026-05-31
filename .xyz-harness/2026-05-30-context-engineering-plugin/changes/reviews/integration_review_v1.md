---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-31T22:00:00"
  target: "context-engineering/src/*.ts"
  verdict: fail
  summary: "集成审查完成，第1轮，1条MUST FIX（闭包捕获bug），需修改后重审"

statistics:
  total_issues: 6
  must_fix: 1
  must_fix_resolved: 0
  low: 3
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "context-engineering/src/index.ts:registerRecallTool() + registerCommands()"
    title: "session_start 后 tool/command handler 引用过期 store/config/stats"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "context-engineering/src/config.ts:loadConfig()"
    title: "shallow copy 导致 DEFAULT_CONFIG 被命令 mutation 污染"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "context-engineering/src/index.ts:context handler"
    title: "validation failure 时 stats 记录了未实际生效的压缩操作"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "context-engineering/src/index.ts:context handler catch block"
    title: "context handler 吞掉异常无任何日志"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: INFO
    location: "context-engineering/src/compressor.ts ↔ index.ts"
    title: "as unknown as 类型桥接不可避免但缺乏运行时保障"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: INFO
    location: "context-engineering/src/compressor.ts:compressContext()"
    title: "boundaries 从原始消息计算一次，当前正确但未来修改可能破坏"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 集成审查 v1

## 评审记录
- 评审时间：2026-05-31
- 评审类型：集成审查（编码评审子集，聚焦模块间接口、类型转换、事件生命周期、闭包引用）
- 评审对象：context-engineering 插件全部源代码（5 个模块）
- 对照基准：BLR v1/v2 产出 + 源代码交叉验证

## 审查维度

本次审查覆盖以下集成检查点：

| 维度 | 检查范围 |
|------|---------|
| 模块间接口对齐 | config → compressor, recall-store → compressor, compressor → index |
| 类型安全 | compressor 的 AgentMessage vs Pi 的 AgentMessage |
| 事件生命周期 | session_start → context → recall 查询 |
| 命令 handler | 闭包变量引用是否正确指向 session-scoped 状态 |

---

## 1. 模块间接口对齐

### 1.1 config → compressor

**结论：✅ 完全对齐**

`compressor.ts` 从 `config.ts` 导入 `L0Config`, `L1Config`, `L2Config`, `ContextEngineeringConfig`。

| compressContext 使用 | config.ts 定义 | 匹配 |
|---------------------|---------------|------|
| `config.enabled` | `ContextEngineeringConfig.enabled: boolean` | ✅ |
| `config.l0` → `processL0()` | `L0Config` 所有字段均被使用 | ✅ |
| `config.l1` → `processL1()` | `L1Config` 所有字段均被使用 | ✅ |
| `config.l2` → `processL2()` | `L2Config` 所有字段均被使用 | ✅ |

逐层字段验证：

```
L0Config: expireMinutes ✅, bashTruncateChars ✅, thinkingExpireMinutes ✅, protectRecentTurns ✅, enabled ✅
L1Config: summaryThresholdChars ✅, keepHeadLines ✅, keepTailLines ✅, enabled ✅
L2Config: emergencyThreshold ✅, protectRecentTurns ✅, enabled ✅
```

### 1.2 recall-store → compressor

**结论：✅ 完全对齐**

`RecallStore` 接口：`store(content: string, level: ...): string`, `recall(id: string): StoredContent | undefined`

compressor 中所有 `store.store()` 调用的 level 参数：

| 调用位置 | level 值 | StoredContent.level 联合成员 | 匹配 |
|---------|----------|---------------------------|------|
| `processL0()` L128 | `"l0-expired"` | ✅ | ✅ |
| `processL0()` L141 | `"l0-truncated"` | ✅ | ✅ |
| `processL1()` L176 | `"l1-condensed"` | ✅ | ✅ |
| `processL2()` L208 | `"l2-emergency"` | ✅ | ✅ |

返回值（id: string）均被正确用于 `expireToolResult()` / `truncateBashOutput()` / `[Condensed]` 格式化。

### 1.3 compressor → index

**结论：⚠️ 有类型桥接问题（见 Issue #5），但运行时安全**

`index.ts` 导入 `compressContext`, `CompressionStats`, `AgentMessage as CompressorMessage`。

调用签名匹配：

```typescript
compressContext(
  messages,                     // CompressorMessage[] ← via cast ✅
  config,                       // ContextEngineeringConfig ✅
  store,                        // RecallStore ✅
  ctx.getContextUsage() | undefined  // ContextUsage ← via cast ✅
): { messages: CompressorMessage[]; stats: CompressionStats }
```

`CompressionStats` 字段在 `index.ts` 中的使用：

- `accumulateStats()` 正确累加所有 6 个字段 ✅
- `zeroStats()` 正确初始化所有字段 ✅
- `handleContextStatsCommand()` 正确读取所有字段 ✅

### 1.4 commands ← config + compressor

**结论：✅ 接口对齐（但闭包引用有问题，见 Issue #1）**

`commands.ts` 导入 `ContextEngineeringConfig`, `parseLevelArgs` (from config), `CompressionStats` (from compressor)。

`parseLevelArgs` 返回值在 `handleContextEngineeringCommand` 中的 switch 匹配所有 4 个 target（global/l0/l1/l2）和 2 个 action（on/off）。✅

---

## 2. 类型安全分析

### 2.1 AgentMessage 类型桥接

`index.ts` 中两处关键类型转换：

```typescript
// 入：Pi messages → compressor
const messages = event.messages as unknown as CompressorMessage[];

// 出：compressor result → Pi messages
return { messages: result.messages as unknown as (typeof event.messages)[number][] };
```

**为什么需要 `as unknown as`**：compressor 定义了自己的 `AgentMessage` 联合（含 `BashExecutionMessage`），Pi 的 `ContextEvent.messages` 使用 Pi agent-core 的 `AgentMessage` 类型。两者结构兼容但 TypeScript 无法跨包验证结构等价性。

**运行时安全性分析**：

compressor 对每种消息类型只访问以下字段：

| 消息类型 | 读取字段 | 写入方式 | 安全性 |
|---------|---------|---------|--------|
| `user` | `role`, `content`, `timestamp` | 直接 push（不修改） | ✅ |
| `assistant` | `role`, `content`, `timestamp` | `{ ...msg, content: newContent }` | ✅ 展开保留所有原始字段 |
| `toolResult` | `role`, `content`, `timestamp`, `toolCallId` | `{ ...msg, content: [...] }` | ✅ 展开保留 `details`, `isError` 等 |
| `bashExecution` | `role`, `output`, `timestamp` | `{ ...msg, output: truncated }` | ✅ 展开保留 `command`, `exitCode` 等 |

**关键设计模式**：所有修改使用 `{ ...msg, modifiedField }` 展开运算符。这意味着：
1. compressor 不删除任何 Pi 消息的原始字段
2. Pi 可能添加的新字段自动保留
3. compressor 的接口定义不需要是 Pi 类型的超集——只需是子集

**但存在隐患**（Issue #5）：如果 Pi 未来重命名某个字段（如 `content` → `blocks`），TypeScript 不会报错，运行时才会失败。这是一个架构层面的脆弱性，不是当前 bug。

### 2.2 ContextUsage 类型桥接

```typescript
ctx.getContextUsage() as unknown as Parameters<typeof compressContext>[3]
// 即 ContextUsage | undefined
```

compressor 的 `ContextUsage`：`{ tokens: number | null, contextWindow: number, percent: number | null }`

compressor 的 null 处理链：
1. `contextUsage.percent != null` → 直接使用 ✅
2. 否则 → chars/4 估算 fallback ✅
3. `contextUsage` 为 `undefined` → 直接走 fallback ✅

安全。

---

## 3. 事件生命周期验证

### 3.1 生命周期流程

```
Extension 加载
  ├─ loadConfig() → config
  ├─ createRecallStore() → store
  ├─ zeroStats() → cumulativeStats
  ├─ pi.on("session_start", ...)  ← 注册
  ├─ pi.on("context", ...)        ← 注册
  ├─ registerRecallTool(pi, store) ← ⚠️ 传入 store 值
  └─ registerCommands(pi, config, cumulativeStats) ← ⚠️ 传入值

session_start 事件
  ├─ config = loadConfig()         ← 外层变量重赋值
  ├─ store = createRecallStore()   ← 外层变量重赋值
  └─ cumulativeStats = zeroStats() ← 外层变量重赋值

context 事件
  ├─ 读取 config, store（外层变量） ← 获取 session_start 后的新值 ✅
  ├─ compressContext(messages, config, store, ...)
  └─ accumulateStats(cumulativeStats, result.stats)

recall_context tool 调用
  └─ store.recall(id)              ← 读取注册时的 store 值 ❌ 不是外层变量！
```

### 3.2 关键发现：闭包捕获断裂（Issue #1）

**问题本质**：`registerRecallTool(pi, store)` 和 `registerCommands(pi, config, cumulativeStats)` 将外层变量作为**函数参数**传入。函数内部的 handler 闭包捕获的是**参数绑定**，不是外层变量。`session_start` 重赋值外层变量后，handler 仍引用旧对象。

**逐个影响**：

#### recall_context tool

```typescript
function registerRecallTool(pi: ExtensionAPI, store: RecallStore): void {
  pi.registerTool({
    execute: async (...) => {
      const stored = store.recall(params.id);  // ← 参数 `store`，非外层变量
    },
  });
}
```

- **影响**：session_start 后，recall 查询旧 store，新 session 压缩的内容无法 recall
- **触发条件**：Pi 进程内第二个及后续 session

#### /context-engineering 命令

```typescript
function registerCommands(pi: ExtensionAPI, config: ContextEngineeringConfig, stats: CompressionStats): void {
  pi.registerCommand("context-engineering", {
    handler: async (_args, ctx) => {
      const output = handleContextEngineeringCommand(_args, config, stats);
      // ← 参数 `config`/`stats`，非外层变量
    },
  });
}
```

- **影响 1**：`/context-engineering l0 off` 修改旧 config 对象，`context` handler 读取新 config → 命令无效
- **影响 2**：`/context-stats` 显示旧 session 的统计数据
- **影响 3**：`/context-engineering`（无参数）显示旧 config + 旧 stats

#### 累计对比

```typescript
pi.on("context", (event, ctx) => {
  accumulateStats(cumulativeStats, result.stats);  // ← 外层变量 ✅
});
```

context handler 正确读取外层 `cumulativeStats`，但 command handler 读取参数绑定。**两边看到不同对象**。

### 3.3 正确的引用路径对比

| 组件 | 引用方式 | session_start 后 | 正确？ |
|------|---------|-----------------|--------|
| `pi.on("context")` handler | 直接读取外层变量 `config`, `store`, `cumulativeStats` | 获取新对象 | ✅ |
| `pi.on("session_start")` handler | 直接重赋值外层变量 | 创建新对象 | ✅ |
| `recall_context` tool execute | 读取 `registerRecallTool` 参数 `store` | 仍引用旧对象 | ❌ |
| `/context-engineering` command | 读取 `registerCommands` 参数 `config`, `stats` | 仍引用旧对象 | ❌ |
| `/context-stats` command | 读取 `registerCommands` 参数 `stats` | 仍引用旧对象 | ❌ |

### 3.4 修复方向

**方案 A（推荐）**：去掉辅助函数，在 `contextEngineeringExtension` 内部直接注册 tool/command，让 handler 闭包直接捕获外层变量：

```typescript
export default function contextEngineeringExtension(pi: ExtensionAPI): void {
  let config = loadConfig();
  let store = createRecallStore();
  let stats = zeroStats();

  pi.on("session_start", () => { config = ...; store = ...; stats = ...; });

  pi.registerTool({
    execute: async (...) => {
      const stored = store.recall(params.id);  // ← 外层变量，随 session_start 更新
    },
  });

  pi.registerCommand("context-engineering", {
    handler: async (_args, ctx) => {
      const output = handleContextEngineeringCommand(_args, config, stats);  // ← 外层变量
    },
  });
}
```

**方案 B**：使用稳定引用容器：

```typescript
const session = { config, store, stats };
pi.on("session_start", () => {
  session.config = loadConfig();
  session.store = createRecallStore();
  session.stats = zeroStats();
});
registerRecallTool(pi, session);  // 传入容器，属性可变
```

---

## 4. 压缩流水线数据流验证

### 4.1 L0 → L1 → L2 管道

```typescript
let current = messages;    // 原始消息
if (config.l0.enabled) {   // L0 处理
  const l0 = processL0(messages, ...);
  current = l0.messages;   // 替换为 L0 输出
}
if (config.l1.enabled) {   // L1 处理 L0 的输出
  const l1 = processL1(current, ...);
  current = l1.messages;
}
if (config.l2.enabled) {   // L2 处理 L1 的输出
  const l2 = processL2(current, ...);
  current = l2.messages;
}
```

**验证结论**：管道正确，每层接收上一层的输出。

**索引一致性**：L0/L1/L2 都保持消息数组长度不变（不添加不删除消息，只替换），因此 `findTurnBoundaries(messages)` 计算的索引在所有阶段都有效。✅

### 4.2 L1 跳过已过期消息

```typescript
// processL1
if (isToolResultExpired(msg)) {
  result.push(msg);  // 跳过已过期消息
  continue;
}
```

L0 可能将 tool result 标记为 expired。L1 检测到已过期消息后跳过，避免对过期内容再次压缩。✅

### 4.3 L2 跳过已过期消息

```typescript
// processL2
if (!isToolResultExpired(msg) && !isInProtectedTurn(...)) {
  // 只过期未过期的 tool result
}
```

L2 不会重复过期已被 L0/L1 处理过的消息。✅

### 4.4 validation failure 回退路径

```typescript
if (!validateToolPairing(current)) {
  return { messages, stats: { ...stats, validationFailed: true } };
}
```

验证失败时返回**原始 messages 参数**，不是 `current`。正确——安全第一。但 stats 中包含了已执行但被回退的压缩操作计数（Issue #3）。

---

## 5. 命令与配置集成

### 5.1 命令参数 → config mutation

`handleContextEngineeringCommand()` 直接 mutate 传入的 `config` 对象：

```typescript
case "global": config.enabled = onOff;
case "l0": config.l0.enabled = onOff;
case "l1": config.l1.enabled = onOff;
case "l2": config.l2.enabled = onOff;
```

**时序验证**：

```
T1: /context-engineering l0 off → config.l0.enabled = false
T2: context event → compressContext(messages, config, ...)
    → if (config.l0.enabled) { ... } → false → 跳过 L0 ✅
```

如果闭包正确（Issue #1 修复后），config mutation 立即生效。✅

### 5.2 DEFAULT_CONFIG mutation 泄漏（Issue #2）

`loadConfig()` 无 override 时返回 `{ ...DEFAULT_CONFIG }`（shallow copy）。`DEFAULT_CONFIG.l0` 是共享引用。

```
T1: loadConfig() → config = { ..., l0: DEFAULT_CONFIG.l0 (同一对象) }
T2: /context-engineering l0 off → config.l0.enabled = false
    → 同时修改了 DEFAULT_CONFIG.l0.enabled = false ！
T3: session_start → loadConfig() → config = { ..., l0: DEFAULT_CONFIG.l0 }
    → l0.enabled 已经是 false（从上次的 mutation）
```

影响：用户在 session A 禁用某层后，session B 会继承该禁用状态，即使 settings.json 中没有对应配置。违反"每次 session_start 应从干净状态开始"的预期。

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | `index.ts:registerRecallTool()` + `registerCommands()` | session_start 后 tool/command handler 通过函数参数捕获旧 store/config/stats，无法获取 session 重建后的新对象 | 方案 A：去掉辅助函数，在入口函数内直接注册 tool/command，让闭包捕获外层变量；方案 B：传入稳定引用容器 |
| 2 | LOW | `config.ts:loadConfig()` L94 | `{ ...DEFAULT_CONFIG }` shallow copy 导致嵌套对象共享引用，命令 mutation 泄漏到 DEFAULT_CONFIG | 改为 deep clone：`JSON.parse(JSON.stringify(DEFAULT_CONFIG))` 或结构化递归拷贝 |
| 3 | LOW | `index.ts:context handler` + `compressor.ts:compressContext()` | validation failure 时返回原始 messages，但 stats 中记录了已执行但被回退的 L0/L1/L2 操作计数 | 在 validation failure 路径中清零 stats（或用 zeroStats），或在 index.ts 中检查 `result.stats.validationFailed` 后不调用 `accumulateStats` |
| 4 | LOW | `index.ts:context handler` catch block | `catch { return {}; }` 吞掉所有异常无任何日志，集成问题极难调试 | 至少添加 `console.error("[context-engineering] compression error:", error)` 或 Pi 的日志 API |
| 5 | INFO | `compressor.ts` ↔ `index.ts` 类型桥接 | `as unknown as` 绕过编译期类型检查，Pi 端字段重命名不会报编译错误 | 可接受。如需加固，可在 compressContext 入口添加运行时类型守卫（仅 dev 模式） |
| 6 | INFO | `compressor.ts:compressContext()` L264 | `findTurnBoundaries(messages)` 从原始消息计算一次，L0/L1/L2 复用同一 boundaries | 当前正确（L0/L1 不改变数组长度）。如果未来某层添加/删除消息，需要重新计算。记录备忘 |

## 结论

**需修改后重审。** 1 条 MUST_FIX：`registerRecallTool` 和 `registerCommands` 通过函数参数捕获 store/config/stats，session_start 后外层变量重赋值无法传递到 handler 闭包。这是标准的 JavaScript 闭包语义陷阱——函数参数遮蔽了外层同名变量。

该 bug 在单 session 使用中不会触发（初始对象一致），但在 Pi 进程内第二个 session 开始后，所有 tool/command handler 将引用过期状态，导致：
1. recall_context 无法取回新 session 的压缩内容
2. /context-engineering 命令修改旧 config，不影响实际压缩行为
3. /context-stats 显示旧 session 的累计统计

### Summary

集成审查完成，第1轮，1条MUST FIX（闭包捕获断裂），需修改后重审。
