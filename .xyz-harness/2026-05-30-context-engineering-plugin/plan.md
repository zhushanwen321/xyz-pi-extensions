---
verdict: pass
complexity: L1
---

# Context Engineering Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Pi 的 `context` 事件中实现渐进式消息压缩，降低上下文消耗速率，让原生 compact 触发更晚。

**Architecture:** Pi 扩展，通过 `context` 事件拦截每次 LLM 调用前的消息列表，执行 L0（过期/截断/清理）→ L1（规则化摘要）→ L2（紧急压缩）三级渐进压缩。压缩后的原始内容保存在内存 Map 中，通过 `recall_context` 工具按 ID 恢复。不替代原生 compact，不修改 session entries。

**Tech Stack:** TypeScript, Pi Extension API (`@mariozechner/pi-coding-agent`), typebox, pi-tui, Node.js `fs`/`crypto`

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `context-engineering/index.ts` | create | BG1 | 入口，re-export src/index.ts |
| `context-engineering/package.json` | create | BG1 | 扩展元数据 |
| `context-engineering/src/index.ts` | create | BG1 | 扩展工厂函数，注册事件/工具/命令 |
| `context-engineering/src/config.ts` | create | BG1 | 配置类型定义、默认值、settings.json 读取 |
| `context-engineering/src/recall-store.ts` | create | BG1 | 原始内容存储（Map + CRUD） |
| `context-engineering/src/compressor.ts` | create | BG1 | L0/L1/L2 压缩逻辑 + 配对校验 |
| `context-engineering/src/commands.ts` | create | BG1 | /context-engineering 和 /context-stats 命令处理 |

---

## Interface Contracts

### Module: config

#### Class: ConfigManager (闭包函数集合，非 class)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| loadConfig | (settingsPath?: string) => ContextEngineeringConfig | ContextEngineeringConfig | 文件不存在/解析失败 → 返回 DEFAULT_CONFIG | FR-9 |
| parseLevelArgs | (args: string) => { target: "global" \| "l0" \| "l1" \| "l2"; action: "on" \| "off" } \| null | parsed result \| null | 无参数 → null；无效参数 → null | FR-9 |

#### Data: ContextEngineeringConfig

| Field | Type | Description |
|-------|------|-------------|
| enabled | boolean | 全局启用开关 |
| l0.enabled | boolean | L0 启用开关 |
| l0.expireMinutes | number | tool_result 过期分钟数 |
| l0.bashTruncateChars | number | bash 输出截断阈值 |
| l0.thinkingExpireMinutes | number | thinking 空闲清理分钟数 |
| l0.protectRecentTurns | number | 保护最近 N 轮 |
| l1.enabled | boolean | L1 启用开关 |
| l1.summaryThresholdChars | number | L1 摘要触发阈值 |
| l1.keepHeadLines | number | 保留首 N 行 |
| l1.keepTailLines | number | 保留尾 M 行 |
| l2.enabled | boolean | L2 启用开关 |
| l2.emergencyThreshold | number | 紧急压缩触发阈值 (0-1) |
| l2.protectRecentTurns | number | L2 保护最近 N 轮 |

### Module: recall-store

#### Data: StoredContent

| Field | Type | Description |
|-------|------|-------------|
| id | string | 压缩 ID (ctx-{uuid8}) |
| original | string | 原始内容 |
| compressedAt | number | 压缩时间戳 |
| level | "l0-expired" \| "l0-truncated" \| "l1-condensed" \| "l2-emergency" | 压缩级别 |

#### Functions

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| createRecallStore | () => RecallStore | RecallStore | — | FR-5 |
| RecallStore.store | (content: string, level: string) => string | id | — | FR-5 |
| RecallStore.recall | (id: string) => StoredContent \| undefined | StoredContent \| undefined | ID 不存在 → undefined | FR-5 |
| RecallStore.clear | () => void | void | — | FR-5 |

### Module: compressor

#### Functions

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| compressContext | (messages: AgentMessage[], config: ContextEngineeringConfig, store: RecallStore, contextUsage: ContextUsage \| undefined) => { messages: AgentMessage[]; stats: CompressionStats } | { messages, stats } | config.enabled=false → 返回原始 messages | FR-1~8 |
| processL0 | (messages: AgentMessage[], config: L0Config, store: RecallStore, now: number, turnBoundaries: TurnBoundary[]) => { messages: AgentMessage[]; stats: L0Stats } | { messages, stats } | 空 messages → 直接返回 | FR-1, FR-2, FR-3 |
| processL1 | (messages: AgentMessage[], config: L1Config, store: RecallStore) => { messages: AgentMessage[]; stats: L1Stats } | { messages, stats } | L1 disabled → 跳过 | FR-4 |
| processL2 | (messages: AgentMessage[], config: L2Config, store: RecallStore, contextUsage: ContextUsage \| undefined, turnBoundaries: TurnBoundary[]) => { messages: AgentMessage[]; stats: L2Stats } | { messages, stats } | usage < threshold → 跳过 | FR-7 |
| condenseToolResult | (content: string, config: L1Config) => string | condensed content | 正则异常 → fallback 截断 | FR-4 |
| expireToolResult | (content: string, id: string) => string | expired marker string | — | FR-1 |
| truncateBashOutput | (output: string, maxChars: number, id: string) => string | truncated string | output ≤ maxChars → 原样返回 | FR-2 |
| expireThinking | () => string | "[thinking expired]" | — | FR-3 |
| validateToolPairing | (messages: AgentMessage[]) => boolean | isPaired | — | FR-6 |
| findTurnBoundaries | (messages: AgentMessage[]) => TurnBoundary[] | boundaries | — | FR-1, FR-7 |

#### Data: TurnBoundary

| Field | Type | Description |
|-------|------|-------------|
| startIndex | number | turn 起始消息索引 |
| endIndex | number | turn 结束消息索引（不含） |
| timestamp | number | turn 开始时间戳 |

#### Data: CompressionStats

| Field | Type | Description |
|-------|------|-------------|
| l0Expired | number | L0 过期数量 |
| l0Truncated | number | L0 截断数量 |
| l0ThinkingCleared | number | L0 thinking 清理数量 |
| l1Condensed | number | L1 摘要数量 |
| l2Triggered | boolean | L2 是否触发 |

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 Tool Result 过期清理 | processL0 → expireToolResult | context event → scan toolResult → check age + turn boundary → expireToolResult → store | Task 3 |
| AC-2 Bash 输出截断 | processL0 → truncateBashOutput | context event → scan bashExecution → check length → truncateBashOutput → store | Task 3 |
| AC-3 Thinking 清理 | processL0 → expireThinking | context event → scan assistant → check thinking + idle → expireThinking | Task 3 |
| AC-4 ToolCall/ToolResult 配对 | validateToolPairing | compressContext → all levels → validateToolPairing → pass/abort | Task 4 |
| AC-5 Recall 完整性 | RecallStore.store / RecallStore.recall | compress → store original → recall by ID → return original | Task 2 |
| AC-6 不干扰原生 Compact | compressContext | context event → return messages → Pi compaction unaffected | Task 5 |
| AC-7 L1 规则化摘要 | processL1 → condenseToolResult | context event → scan toolResult → check size → condenseToolResult (regex extract) → store | Task 3 |
| AC-8 Level 2 紧急压缩 | processL2 | context event → getContextUsage → check threshold → expire all outside turns | Task 3 |
| AC-9 压缩统计命令 | commands → read stats | context event → accumulate stats → command reads closure var | Task 5 |
| AC-10 配置与启停 | ConfigManager + commands | command → modify closure config → next context uses new config | Task 5 |

---

## Spec Metrics Traceability

| Spec AC | 采纳状态 | 对应 Task |
|---------|---------|----------|
| AC-1 Tool Result 过期清理 | adopted | Task 3 |
| AC-2 Bash 输出截断 | adopted | Task 3 |
| AC-3 Thinking 清理 | adopted | Task 3 |
| AC-4 ToolCall/ToolResult 配对 | adopted | Task 4 |
| AC-5 Recall 完整性 | adopted | Task 2 |
| AC-6 不干扰原生 Compact | adopted | Task 5 |
| AC-7 L1 规则化摘要 | adopted | Task 3 |
| AC-8 Level 2 紧急压缩 | adopted | Task 3 |
| AC-9 压缩统计命令 | adopted | Task 5 |
| AC-10 配置与启停 | adopted | Task 5 |

---

## Task List

### Task 1: 项目骨架 + 配置模块

**Type:** backend

**Files:**
- Create: `context-engineering/index.ts`
- Create: `context-engineering/package.json`
- Create: `context-engineering/src/config.ts`

- [ ] **Step 1: 创建扩展目录和 package.json**

创建 `context-engineering/package.json`：

```json
{
  "name": "pi-extension-context-engineering",
  "version": "0.1.0",
  "description": "Progressive context compression for Pi — L0 zero-cost cleanup, L1 rule-based condensation, L2 emergency truncation, with recall mechanism.",
  "main": "src/index.ts",
  "keywords": ["pi", "extension", "context", "compression"],
  "license": "MIT"
}
```

创建 `context-engineering/index.ts`：

```typescript
export { default } from "./src/index.ts";
```

- [ ] **Step 2: 实现配置模块 config.ts**

`context-engineering/src/config.ts` 定义所有配置类型、默认值、settings 读取逻辑：

- `ContextEngineeringConfig` 接口（含 l0/l1/l2 嵌套配置）
- `DEFAULT_CONFIG` 常量
- `loadConfig()` 函数：尝试从 `~/.pi/agent/settings.json` 读取 `context-engineering` section（Pi 使用 `.json` 扩展名而非 `.jsonl`），使用 `fs.readFileSync` + `JSON.parse`，文件不存在或解析失败时返回 `DEFAULT_CONFIG`
- `parseLevelArgs()` 函数：解析命令参数字符串，返回 `{ target, action }` 或 null

配置接口必须与 spec C-4 中的 JSON 格式完全对应。

- [ ] **Step 3: 类型检查通过**

Run: `cd context-engineering && npx tsc --noEmit`
Expected: 无错误（此时 src/index.ts 还不存在，但 config.ts 自身应该类型正确）

- [ ] **Step 4: Commit**

```bash
git add context-engineering/
git commit -m "feat(context-engineering): scaffold + config module"
```

### Task 2: Recall Store

**Type:** backend

**Depends on:** Task 1

**Files:**
- Create: `context-engineering/src/recall-store.ts`

- [ ] **Step 1: 实现 RecallStore**

`context-engineering/src/recall-store.ts`：

- `StoredContent` 接口：`{ id, original, compressedAt, level }`
- `createRecallStore()` 工厂函数，返回闭包对象：
  - 内部 `Map<string, StoredContent>` 存储
  - `store(content, level)`: 生成 `ctx-{uuid8}` 格式 ID，保存原始内容，返回 ID
  - `recall(id)`: 返回 `StoredContent | undefined`
  - `clear()`: 清空 Map
  - `size()`: 返回当前存储条目数（用于统计展示）
- UUID 生成使用 `crypto.randomUUID()` 截取前 8 字符

- [ ] **Step 2: 类型检查通过**

Run: `cd context-engineering && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add context-engineering/src/recall-store.ts
git commit -m "feat(context-engineering): recall store module"
```

### Task 3: 压缩引擎（L0 + L1 + L2）

**Type:** backend

**Depends on:** Task 2

**Files:**
- Create: `context-engineering/src/compressor.ts`

这是核心模块，包含所有压缩逻辑。

- [ ] **Step 1: 实现辅助函数**

`context-engineering/src/compressor.ts` 先实现以下纯函数：

1. `findTurnBoundaries(messages)`: 扫描消息列表，按 C-9 定义（user/bashExecution 消息为 turn 起点）划分 turn 边界，返回 `TurnBoundary[]`
2. `isInProtectedTurn(msgIndex, boundaries, protectCount)`: 判断消息索引是否在最近 N 轮保护范围内
3. `getMessageTimestamp(msg)`: 从消息中提取时间戳（兼容不同消息类型）
4. `getToolResultContent(msg)`: 从 toolResult 消息中提取文本内容
5. `getBashOutput(msg)`: 从 bashExecution 消息中提取 output 字段

- [ ] **Step 2: 实现 L0 过期/截断/清理**

`processL0(messages, config, store, now, turnBoundaries)` 函数：

- 遍历 messages，对每条消息判断类型：
  - **toolResult**: 检查 `now - timestamp > expireMinutes * 60000` 且不在保护 turn 内 → 调用 `store.store()` 保存原始内容 → 替换 content 为过期标记
  - **bashExecution**: 检查 `output.length > bashTruncateChars` → 调用 `store.store()` 保存原始 output → 调用 `truncateBashOutput()` 截断 → 替换 msg.output（注意：BashExecutionMessage.output 是直接字段，不是 content）
  - **assistant (含 thinking)**: 检查 thinking 块 + 空闲时间 → 清空 thinking 内容

- 所有替换操作使用展开运算符 `{ ...msg, content: newContent }` 创建新对象（不动原始 msg）
- 返回 `{ messages: newMessages, stats }`

- [ ] **Step 3: 实现 L1 规则化摘要**

`processL1(messages, config, store)` 函数：

- 遍历 messages，对 toolResult 消息：
  - 跳过已过期的（content 已含过期标记）
  - 检查 `content.length > summaryThresholdChars`
  - 调用 `condenseToolResult(content, config)` 生成摘要
  - 调用 `store.store()` 保存原始内容
  - 替换 content 为 `[Condensed (ID: {id}): {summary}]`

`condenseToolResult(content, config)` 函数：
  1. 按行分割
  2. 提取 import/export 行：`/^(import|export)\s/` 匹配
  3. 提取定义行：`/(function|class|interface|type|const|let|var)\s+\w+/` 匹配
  4. 保留首 `keepHeadLines` 行
  5. 保留尾 `keepTailLines` 行
  6. 中间行：只保留步骤 2 和 3 匹配的行，其余用 `[... {N} lines omitted]` 替代
  7. 如果结果 > 原始的 40% → fallback 到 L0 截断策略（首尾各半）

- [ ] **Step 4: 实现 L2 紧急压缩**

`processL2(messages, config, store, contextUsage, boundaries)` 函数：

- 计算使用率：优先 `contextUsage.percent`，null 时用 chars/4 估算
- 如果使用率 < `emergencyThreshold` → 跳过
- 遍历 messages，对 toolResult：
  - 不在保护 turn 内 → 强制过期（无视 expireMinutes）
  - 调用 `store.store()` 保存原始内容
  - 替换 content 为过期标记

- [ ] **Step 5: 实现 compressContext 主函数**

`compressContext(messages, config, store, contextUsage)` 函数：

1. 如果 `!config.enabled` → 返回 `{ messages, stats: zeroStats }`
2. 调用 `findTurnBoundaries(messages)`
3. `let result = processL0(messages, config.l0, store, Date.now(), boundaries)`
4. 如果 `config.l1.enabled` → `result = processL1(result.messages, config.l1, store)`
5. 如果 `config.l2.enabled` → `result = processL2(result.messages, config.l2, store, contextUsage, boundaries)`
6. 调用 `validateToolPairing(result.messages)`
7. 如果校验失败 → 返回原始 messages + 日志
8. 返回 `{ messages: result.messages, stats: aggregatedStats }`

- [ ] **Step 6: 类型检查通过**

Run: `cd context-engineering && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 7: Commit**

```bash
git add context-engineering/src/compressor.ts
git commit -m "feat(context-engineering): compression engine (L0/L1/L2)"
```

### Task 4: 配对校验

**Type:** backend

**Depends on:** Task 3

**Files:**
- Modify: `context-engineering/src/compressor.ts`

- [ ] **Step 1: 实现 validateToolPairing**

在 `compressor.ts` 中添加 `validateToolPairing(messages)` 函数：

1. 创建两个 Set：`pendingToolCalls`（string[]）、`seenToolResults`（string[]）
2. 遍历 messages：
   - assistant 消息：检查 content 中 type=toolCall 的项，将其 id 加入 `pendingToolCalls`
   - toolResult 消息：检查 toolCallId 是否在 `pendingToolCalls` 中，在则移除，不在则 return false（孤儿 toolResult）
3. 遍历结束：`pendingToolCalls` 非空则 return false（孤儿 toolCall）
4. return true

注意：Pi 的 AssistantMessage 的 content 是数组，其中 `type: "toolCall"` 的项有 `id` 字段。ToolResultMessage 有 `toolCallId` 字段。

- [ ] **Step 2: 集成到 compressContext**

在 Task 3 的 Step 5 中，compressContext 已调用 validateToolPairing。本步骤确认集成正确：校验失败时返回原始 messages，并在 stats 中标记 `validationFailed: true`。

- [ ] **Step 3: 类型检查通过**

Run: `cd context-engineering && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add context-engineering/src/compressor.ts
git commit -m "feat(context-engineering): tool pairing validation"
```

### Task 5: 扩展入口（事件注册 + 工具 + 命令）

**Type:** backend

**Depends on:** Task 4

**Files:**
- Create: `context-engineering/src/index.ts`
- Create: `context-engineering/src/commands.ts`

- [ ] **Step 1: 实现命令模块 commands.ts**

`context-engineering/src/commands.ts`：

- `handleContextEngineeringCommand(args, config, stats)`: 
  - 无参数 → 返回配置摘要 + 统计的格式化文本
  - "on"/"off" → 修改 `config.enabled`
  - "l0 on"/"l0 off" → 修改 `config.l0.enabled`
  - "l1 on"/"l1 off" → 修改 `config.l1.enabled`
  - "l2 on"/"l2 off" → 修改 `config.l2.enabled`
  - 无效参数 → 返回使用帮助
- `handleContextStatsCommand(stats)`:
  - 返回累计统计的格式化文本

- [ ] **Step 2: 实现扩展入口 index.ts**

`context-engineering/src/index.ts` — `export default function contextEngineeringExtension(pi: ExtensionAPI)`：

1. 创建闭包变量：
   - `let config = loadConfig()` — 配置
   - `const store = createRecallStore()` — recall 存储
   - `let cumulativeStats = { l0Expired: 0, l0Truncated: 0, l0ThinkingCleared: 0, l1Condensed: 0, l2Triggered: 0 }` — 累计统计

2. `pi.on("session_start", ...)` → 重置 store 和 cumulativeStats，重新加载 config

3. `pi.on("context", (event, ctx) => ...)` → try-catch 包裹：调用 `compressContext(event.messages, config, store, ctx.getContextUsage())` → 异常时返回 void（不修改消息，安全降级） → 成功时累加 stats → 返回 `{ messages: result.messages }`

4. `pi.registerTool("recall_context", ...)` → 参数 schema `{ id: string }` → 调用 `store.recall(id)` → 找到则返回原始内容，否则返回错误文本

5. `pi.registerCommand("context-engineering", ...)` → 调用 `handleContextEngineeringCommand`

6. `pi.registerCommand("context-stats", ...)` → 调用 `handleContextStatsCommand`

7. `pi.appendSystemPrompt(...)` → 添加简要说明，告知 LLM recall_context 工具的存在和用法

- [ ] **Step 3: Symlink 安装**

```bash
ln -sf $(pwd)/context-engineering ~/.pi/agent/extensions/context-engineering
```

- [ ] **Step 4: 全项目类型检查**

Run: `cd /Users/zhushanwen/Code/xyz-pi-extensions-workspace/refactor-infinite-context && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: ESLint 检查**

Run: `cd /Users/zhushanwen/Code/xyz-pi-extensions-workspace/refactor-infinite-context && npm run lint`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add context-engineering/ ~/.pi/agent/extensions/context-engineering
git commit -m "feat(context-engineering): extension entry point with events, tools, and commands"
```

### Task 6: 端到端验证

**Type:** backend

**Depends on:** Task 5

**Files:**
- Create: `context-engineering/src/__tests__/compressor.test.ts`

- [ ] **Step 1: 编写压缩引擎单元测试**

测试文件 `context-engineering/src/__tests__/compressor.test.ts`，使用 vitest：

1. **AC-1 过期清理**: 构造 35 分钟前的 toolResult + 保护 turn 内的 toolResult → 验证过期的被替换、保护的保留
2. **AC-2 Bash 截断**: 构造 10000 字符 bash output → 验证截断为首 2000 + 标记 + 尾 2000
3. **AC-3 Thinking 清理**: 构造 6 分钟前的 assistant thinking → 验证清空
4. **AC-4 配对校验**: 构造 assistant(toolCall) → toolResult 序列 → 验证压缩后配对完整；构造损坏序列 → 验证校验失败
5. **AC-7 L1 摘要**: 构造含 import/function/export 的 12000 字符 toolResult → 验证摘要保留关键行
6. **AC-8 L2 紧急**: mock contextUsage=0.91 → 验证保护 turn 外的 toolResult 被强制过期
7. **AC-10 全局禁用**: config.enabled=false → 验证返回原始消息

- [ ] **Step 2: 运行测试**

Run: `npx vitest run context-engineering/src/__tests__/compressor.test.ts`
Expected: 全部 PASS

- [ ] **Step 3: Commit**

```bash
git add context-engineering/src/__tests__/
git commit -m "test(context-engineering): compressor unit tests"
```

---

## Execution Groups

#### BG1: 压缩引擎全栈

**Description:** 所有后端逻辑——配置、recall 存储、压缩引擎、配对校验、扩展入口、命令处理。这些模块紧密耦合（compressor 依赖 config 和 recall-store，index 依赖所有模块），放在同一组。

**Tasks:** Task 1, Task 2, Task 3, Task 4, Task 5, Task 6

**Files (预估):** 8 个文件（7 create + 1 modify，含 1 个测试文件）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择 |
| 注入上下文 | spec.md（完整）、CLAUDE.md（项目约束）、Pi messages.ts 和 types.ts（消息类型参考） |
| 读取文件 | `goal/src/index.ts`（扩展模式参考）、`/Users/zhushanwen/GitApp/pi-mono/packages/coding-agent/src/core/messages.ts`、`/Users/zhushanwen/GitApp/pi-mono/packages/coding-agent/src/core/extensions/types.ts` |
| 修改/创建文件 | `context-engineering/` 目录下所有文件 |

**Execution Flow (BG1 内部):** 串行执行，Task 1→2→3→4→5→6 按依赖顺序。

**Dependencies:** 无

**设计细节:** 直接写在此 plan.md 中（L1 复杂度，无子文档）

---

## Dependency Graph & Wave Schedule

```
Task 1 (骨架+配置) ──→ Task 2 (recall-store) ──→ Task 3 (压缩引擎) ──→ Task 4 (配对校验) ──→ Task 5 (入口) ──→ Task 6 (测试)
```

| Wave | Tasks | 说明 |
|------|-------|------|
| Wave 1 | Task 1 | 骨架+配置，无依赖 |
| Wave 2 | Task 2 | recall-store，依赖 Task 1 的类型定义 |
| Wave 3 | Task 3 | 压缩引擎，依赖 Task 2 的 store 接口 |
| Wave 4 | Task 4 | 配对校验，修改 Task 3 的 compressor.ts |
| Wave 5 | Task 5 | 扩展入口，依赖所有上游 |
| Wave 6 | Task 6 | 端到端验证 |

---

## ADR Evaluation

**已评估 Phase 2 新决策：**

1. **配置通过 fs.readFileSync 读取 settings.json** — 不满足三条件（可逆转、常规做法、无真实权衡），不创建 ADR
2. **recall store 使用内存 Map** — 不满足三条件（spec 已明确约束 C-3），不创建 ADR
3. **L1 使用正则匹配而非 LLM 摘要** — 已在 spec 阶段确定（审查 Issue #3），非 Phase 2 新决策

**结论：Phase 2 无新决策满足三条件，不产出 ADR。**

---

## Self-Check Checklist

### Scope 覆盖声明
- [x] 10 个 AC 全部标注为 adopted，无 rejected/postponed
- [x] 无 spec 指标被静默忽略
- [x] 无 scope 缩减

### Task 粒度
- [x] 单个 Task 不超过 10 步
- [x] 每个 Task 对应一个清晰的实现单元

### 禁止实现代码
- [x] plan 中不包含函数体或完整类定义
- [x] 只包含接口签名和调用关系描述

### 伪代码数据来源
- [x] 消息类型引用自 Pi 源码 `messages.ts` 和 `types.ts`（已验证字段名）
