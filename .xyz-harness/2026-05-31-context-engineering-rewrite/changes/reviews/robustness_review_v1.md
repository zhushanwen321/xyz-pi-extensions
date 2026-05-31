---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 6
  dimensions_checked: 6
  issues_found: 5
  must_fix_count: 0
  low_count: 4
  info_count: 1
  duration_estimate: "25"
---

# Robustness Review v1

## 审查记录
- 审查时间：2026-05-31 16:00
- 审查文件数：6（compressor.ts, index.ts, config.ts, frozen-fresh.ts, recall-store.ts, commands.ts）
- 审查维度：D1-D6（全量）
- 审查基准：feat-context-engineering-v2 分支 diff（+1269 行），相对 main 分支

## 维度评分概览

| 维度 | 检查项数 | 通过 | 问题 | 评分 |
|------|---------|------|------|------|
| D1 错误处理 | 12 | 11 | 1 | 9/10 |
| D2 异常处理 | 8 | 7 | 1 | 9/10 |
| D3 日志 | 6 | 6 | 0 | 9/10 |
| D4 Fail-fast | 10 | 9 | 1 | 8/10 |
| D5 测试友好性 | 8 | 5 | 3 | 7/10 |
| D6 调试友好性 | 6 | 6 | 0 | 9/10 |

## 问题清单

| # | 严重度 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|------|------|------|------|---------|
| 1 | LOW | D5 | compressContext 每次调用创建新的 FrozenFreshState，index.ts 中声明的 frozenFreshState 从未被使用 | compressor.ts L741 | L741 | 将 index.ts 的 frozenFreshState 传入 compressContext → processBudget，使跨调用 frozen 状态生效 |
| 2 | LOW | D5 | processBudget 的 frozen 检测逻辑在每次 compressContext 调用时重置，跨调用无法跳过已 frozen 的 toolResult | compressor.ts L741 | L741 | 同上，使用 session 级的 frozenFreshState 而非每次新建 |
| 3 | LOW | D1,D4 | processMicrocompact 对 `messages` 为空数组时行为正确但缺少显式守卫，与 processBudget 的 `enabled` 守卫风格不一致 | compressor.ts L333 | L333 | 无需修改，行为正确。记录为风格观察 |
| 4 | LOW | D4 | processBudget 在 freshEntries 为空但 totalFreshChars 超阈值时（理论上不可能，因为空数组 totalFreshChars=0），跳过持久化。无守卫但有隐式保护 | compressor.ts L432 | L432 | 无需修改。逻辑正确 |
| 5 | INFO | D5 | FrozenFreshState.reset() 在 index.ts 中声明但无调用点。session_start 用 createFrozenFreshState() 重建而非调用 reset | frozen-fresh.ts L32 | L32 | 可接受：重建等价于 reset。reset 为未来跨 session 复用预留 |

## 特别关注项审查

### 1. compressContext 的 try-catch 是否完整

**结论：完整，设计合理。**

- `compressContext` 本身无 try-catch（纯函数，不应有副作用）
- 调用方 `index.ts` 的 `pi.on("context")` handler 有完整的 try-catch（L68-L77）
- catch 中降级返回 `{}`（原始消息不变），符合 CLAUDE.md 要求的「不返回错误成功模式」
- 错误日志有 `DEBUG_CONTEXT_ENGINEERING` 环境变量控制，避免生产环境日志噪音

**评估：✅ 无问题。异常传播链完整，降级路径存在且正确。**

### 2. processMicrocompact/processBudget 对 null/undefined 输入的处理

**结论：类型系统保护，运行时无风险。**

- `processMicrocompact(messages: AgentMessage[])` — messages 为 null/undefined 时 TypeScript 编译报错。Pi 进程内运行时，event.messages 保证为数组
- `config: McConfig` / `config: BudgetConfig` — 由 `compressContext` 传入，来自 `DEFAULT_CONFIG` 或 `loadConfig()` 的深合并，两个函数都有 fallback 默认值
- `compactBoundaryIdx: number | null` — 显式处理了 null（不限制边界）和具体值
- `now: number` — 由 `Date.now()` 传入，不可能为 null
- `store: RecallStore` — 由 `createRecallStore()` 工厂创建，不可能为 null

**评估：✅ 无问题。TypeScript 类型系统 + 工厂模式 + 默认配置保证了输入合法性。**

### 3. FrozenFreshState 的 reset 是否有竞态风险

**结论：无竞态风险，但有功能缺陷。**

- **竞态风险**：不存在。Pi 扩展在单进程单线程事件循环中运行，`context` 事件是同步处理的
- **功能缺陷（#1/#2）**：`compressContext` L741 每次创建新的 `ffState`，导致：
  - 第一次调用：toolResult A 被持久化并 markFrozen
  - 第二次调用：新的 ffState 不知道 A 已 frozen，会重复处理 A
  - 但这不会导致崩溃——`store.store()` 会创建新 ID，recall_store 会多存一份冗余数据
  - 实际影响：轻微的内存浪费 + recall_store 条目膨胀，不影响正确性
- **index.ts L56 的 frozenFreshState**：声明但未传入 compressContext，是代码残留

**评估：⚠️ 功能瑕疵但不影响健壮性。标记为 LOW（#1/#2），非 MUST FIX。**

### 4. processBudget 中 recall store 满时的行为

**结论：有 LRU 淘汰，行为合理。**

- `recall-store.ts` 的 `store()` 函数（L30-L36）：超过 `MAX_ENTRIES=500` 时淘汰最早的条目
- `processBudget` 中 `store.store(text, "budget-persisted")` 会触发淘汰
- 淘汰后旧的 recall ID 失效，`recall_context` 会返回 "not found" 错误信息
- 错误信息清晰：`[recall_context] ID "${id}" not found. Content may have been lost on session reload.`

**评估：✅ 无问题。LRU 淘汰 + 清晰的错误信息。MAX_ENTRIES=500 对单 session 足够。**

## 逐文件详情

### compressor.ts（核心引擎，~770 行）

**D1 错误处理:**
- ✅ L333-335: processMicrocompact 的 `enabled` 守卫，正确短路
- ✅ L349-350: `lastAssistantTs === 0` 守卫，无 assistant 时不触发
- ✅ L384-386: processBudget 的 `enabled` 守卫，正确短路
- ✅ L416-423: frozen 检测 + replacement 替换，`!` 非空断言安全（因为前面 `isFrozen` 已确认存在）
- ✅ L527-528: processL0 的 `keepRecent > 0` 守卫，避免空集合操作
- ✅ L595-598: processL1 的 `compactBoundaryIdx` 和 protected turn 双重守卫
- ✅ L670-673: processL2 的 `compactBoundaryIdx` 守卫
- ⚠️ L741: 每次创建新 ffState，跨调用状态丢失（#1/#2）

**D2 异常处理:**
- ✅ 全部纯函数，无 try-catch 需求
- ✅ 异常正确冒泡到调用方 index.ts 的 context handler

**D3 日志:**
- ✅ 无直接日志输出（纯函数设计）
- ✅ index.ts 中 DEBUG_CONTEXT_ENGINEERING 环境变量控制

**D4 Fail-fast:**
- ✅ L333: enabled 检查在最前
- ✅ L349: lastAssistantTs === 0 立即返回
- ✅ L518-520: config.enabled 在 compressContext 入口检查
- ⚠️ L741: ffState 重新创建导致 frozen 状态丢失，但不影响正确性

**D5 测试友好性:**
- ✅ 所有处理函数（processMicrocompact, processBudget, processL0, processL1, processL2）接受纯输入参数
- ✅ RecallStore 通过工厂注入，可替换为 mock
- ⚠️ L741: createFrozenFreshState() 硬编码在 compressContext 内部，无法注入（#1）
- ✅ 测试文件直接调用各 process* 函数，覆盖良好

**D6 调试友好性:**
- ✅ CompressionStats 包含 mcTriggered/mcCleared/budgetPersisted 新字段
- ✅ 替换文本包含 ID 和 chars 信息
- ✅ processMicrocompact 的 "[Old tool result content cleared]" 明确标识 MC 行为

### index.ts（扩展入口，~95 行）

**D1 错误处理:**
- ✅ L68-77: context handler 的 try-catch，降级返回 `{}`
- ✅ L76: 错误日志有 DEBUG 环境变量控制

**D2 异常处理:**
- ✅ catch 块不吞异常——有条件日志 + 降级处理
- ✅ `process.env.DEBUG_CONTEXT_ENGINEERING` 检查避免生产噪音

**D3 日志:**
- ✅ console.error 仅在 DEBUG 模式输出，包含原始异常对象
- ✅ 无敏感数据泄露

**D4 Fail-fast:**
- ✅ loadConfig 有多层 fallback（文件读取失败 → JSON 解析失败 → 无 context-engineering 字段 → 返回默认配置）

**D5 测试友好性:**
- ⚠️ L56: frozenFreshState 声明但未使用（#1），会误导维护者
- ⚠️ 闭包变量（config/store/cumulativeStats/frozenFreshState）通过 session_start 重置，符合 CLAUDE.md 要求

**D6 调试友好性:**
- ✅ recallResult 包含 level 和时间戳信息
- ✅ 错误信息包含具体 ID

### config.ts（配置管理，~170 行）

**D1 错误处理:**
- ✅ loadConfig 三层 try-catch：readFileSync → JSON.parse → override 类型检查
- ✅ 每层都有 fallback 到 DEFAULT_CONFIG

**D2 异常处理:**
- ✅ catch 块静默降级（返回默认配置），对配置文件损坏场景合理
- ✅ deepMerge 对 null/Array 有防护

**D4 Fail-fast:**
- ✅ parseLevelArgs 校验 target 和 action 合法性
- ✅ tokens.length < 2 立即返回 null

### frozen-fresh.ts（状态跟踪，~36 行）

**D1 错误处理:**
- ✅ Map.get 对不存在的 key 返回 undefined，getReplacement 正确返回 `string | undefined`

**D4 Fail-fast:**
- ✅ isFrozen 用 has() 检查，不依赖 get 返回值

**D5 测试友好性:**
- ✅ 工厂函数 + 接口模式，可 mock
- ✅ 独立测试文件 frozen-fresh.test.ts 覆盖所有方法

### recall-store.ts（内容存储，~50 行）

**D1 错误处理:**
- ✅ LRU 淘汰机制完善（MAX_ENTRIES=500）
- ✅ store 返回 id，recall 返回 `StoredContent | undefined`

**D3 日志:**
- ✅ 无日志输出（纯数据结构）

**D6 调试友好性:**
- ✅ ID 格式 `ctx-{uuid_prefix}` 可辨识来源
- ✅ StoredContent 包含 level 和 compressedAt 时间戳

### commands.ts（命令处理，~170 行）

**D4 Fail-fast:**
- ✅ parseLevelArgs 返回 null 时回退到 help 输出
- ✅ mc/budget target 正确路由到 config.mc.enabled/config.budget.enabled

**D6 调试友好性:**
- ✅ formatConfigSummary 显示 MC/Budget 状态和参数
- ✅ formatStats 显示 mcTriggered/mcCleared/budgetPersisted

## 结论

**通过。** 代码健壮性良好，核心流水线（MC → Budget → L0 → L1 → L2）的错误处理、降级路径和 fail-fast 逻辑完整。

主要观察：
1. FrozenFreshState 在 compressContext 内每次重建（#1/#2），导致 frozen 状态跨调用失效。功能影响轻微（recall_store 多存冗余数据），不影响正确性和健壮性。
2. index.ts 中 frozenFreshState 变量声明但未使用，属于代码残留。
3. 整体错误处理策略一致：外层 try-catch 降级 + 内层纯函数无副作用，符合 Pi 扩展的运行时约束。

建议后续清理 #1/#2（将 frozenFreshState 从 index.ts 传入 compressContext），但不阻塞合入。
