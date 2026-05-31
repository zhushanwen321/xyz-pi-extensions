---
verdict: pass
complexity: L1
---

# Context-Engineering v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 context-engineering 扩展中复刻 Claude Code 三层上下文管理架构，新增 Microcompact（Time-Based）和 Tool Result Budget（Per-Message + Frozen/Fresh），修复 L1 缺失 protected turn 检查的 bug，增加 Compact Boundary 感知。

**Architecture:** 在现有 `compressor.ts` 的 `compressContext` 管道中，在 L0 之前插入 Microcompact 和 Tool Result Budget 两个新阶段。新增 `frozen-fresh.ts` 管理 Frozen/Fresh 状态。修改 `config.ts` 增加 `mc` 和 `budget` 配置节。所有压缩仍发生在 `context` 事件中，不修改 Pi 核心。

**Tech Stack:** TypeScript, Pi Extension API, typebox, vitest

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `context-engineering/src/config.ts` | modify | BG1 | 增加 McConfig、BudgetConfig 接口和默认值，扩展 parseLevelArgs |
| `context-engineering/src/recall-store.ts` | modify | BG1 | 增加 `"mc-cleared"` level 到 StoredContent |
| `context-engineering/src/frozen-fresh.ts` | create | BG1 | FrozenFreshState 接口 + createFrozenFreshState 工厂函数 |
| `context-engineering/src/compressor.ts` | modify | BG1 | 新增 processMicrocompact、processBudget 函数，修复 L1 protectedTurn，增加 compact boundary 感知 |
| `context-engineering/src/commands.ts` | modify | BG1 | 增加 mc/budget 命令处理，扩展统计展示 |
| `context-engineering/src/index.ts` | modify | BG1 | 闭包新增 frozenFreshState，串联新压缩阶段，注册新命令 |
| `context-engineering/src/__tests__/compressor.test.ts` | modify | BG1 | 新增 AC-1~AC-8 对应的测试用例 |
| `context-engineering/src/__tests__/frozen-fresh.test.ts` | create | BG1 | FrozenFreshState 单元测试 |

---

## Interface Contracts

### Module: frozen-fresh

#### Class: FrozenFreshState (interface)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| isFrozen | (toolUseId: string) => boolean | boolean | 未知 ID 返回 false | AC-3 |
| markFrozen | (toolUseId: string, replacement: string) => void | void | 重复调用覆盖旧值 | AC-3 |
| getReplacement | (toolUseId: string) => string \| undefined | string \| undefined | 未冻结 ID 返回 undefined | AC-3, AC-6 |
| getAllFrozenIds | () => Set\<string\> | Set\<string\> | 空集 | — |
| reset | () => void | void | — | session_start |

### Module: compressor

#### Function: processMicrocompact

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| processMicrocompact | (messages: AgentMessage[], config: McConfig, now: number, compactBoundaryIdx: number \| null) => { messages: AgentMessage[]; stats: McStats } | 见左 | 无 compactable toolResult 时返回原消息；无 assistant 消息时不触发 | AC-1 |

#### Function: processBudget

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| processBudget | (messages: AgentMessage[], config: BudgetConfig, store: RecallStore, ffState: FrozenFreshState, compactBoundaryIdx: number \| null) => { messages: AgentMessage[]; stats: BudgetStats } | 见左 | 所有 toolResult 均 frozen 时不做处理 | AC-2, AC-3 |

#### Function: findCompactBoundary

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| findCompactBoundary | (messages: AgentMessage[]) => number \| null | number \| null | 无 compactionSummary 时返回 null | AC-4, AC-7 |

### Data: McConfig

| Field | Type | Description |
|-------|------|-------------|
| enabled | boolean | 是否启用 |
| gapThresholdMinutes | number | 触发阈值（分钟） |
| keepRecent | number | 保留最近 N 个 compactable toolResult |

### Data: BudgetConfig

| Field | Type | Description |
|-------|------|-------------|
| enabled | boolean | 是否启用 |
| maxToolResultCharsPerMessage | number | 每 user 消息的 toolResult 字符预算 |
| previewSize | number | 替换后预览字节数 |

### Data: McStats

| Field | Type | Description |
|-------|------|-------------|
| triggered | boolean | 是否触发 |
| cleared | number | 清理的 toolResult 数量 |

### Data: BudgetStats

| Field | Type | Description |
|-------|------|-------------|
| persisted | number | 持久化的 toolResult 数量 |

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 | processMicrocompact | messages → findLastAssistant → filter old → clear | Task 1 |
| AC-2 | processBudget | messages → perMessageBudget → persist largest | Task 2 |
| AC-3 | FrozenFreshState.isFrozen/markFrozen | processBudget → ffState → replacement | Task 2 |
| AC-4 | findCompactBoundary | messages → scan → compactBoundaryIdx | Task 3 |
| AC-5 | processL1 (修复) | messages → isInProtectedTurn check | Task 4 |
| AC-6 | FrozenFreshState (间接) | processBudget 的 frozen 逻辑保证同一 ID 不变 | Task 2 |
| AC-7 | findCompactBoundary + compressContext | compactBoundaryIdx → skip pre-boundary | Task 3 |
| AC-8 | handleContextEngineeringCommand | config.mc.enabled toggle | Task 6 |

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 Microcompact Time-Based | adopted | Task 1 |
| AC-2 Tool Result Budget | adopted | Task 2 |
| AC-3 Frozen/Fresh 状态保持 | adopted | Task 2 |
| AC-4 Compact Boundary 感知 | adopted | Task 3 |
| AC-5 L1 Protected Turn | adopted | Task 4 |
| AC-6 Prompt Cache 稳定性 | adopted | Task 2（Frozen/Fresh 保证） |
| AC-7 不干扰原生 Compact | adopted | Task 3（逻辑跳过 compactionSummary） |
| AC-8 配置启停 | adopted | Task 6 |
| FR-5 Bash 截断（保留） | adopted | 不需要改动（v1 已实现） |
| FR-6 Thinking 清理（保留） | adopted | 不需要改动（v1 已实现） |
| FR-8 Recall（保留） | adopted | Task 5（扩展 level 类型） |
| FR-9 L2 紧急压缩（优化） | adopted | Task 4（增加 boundary 感知） |
| FR-10 配对完整性（保留） | adopted | 不需要改动（v1 已实现） |
| FR-11 统计（扩展） | adopted | Task 6 |
| FR-12 配置（扩展） | adopted | Task 6 |

---

## Task List

### Task 1: Microcompact — Time-Based 清理

**Type:** backend

**Files:**
- Modify: `context-engineering/src/config.ts`
- Modify: `context-engineering/src/compressor.ts`
- Test: `context-engineering/src/__tests__/compressor.test.ts`

**实现要点：**

1. **config.ts**：新增 `McConfig` 接口和默认值

```typescript
export interface McConfig {
  enabled: boolean;
  gapThresholdMinutes: number;
  keepRecent: number;
}
```

在 `ContextEngineeringConfig` 中增加 `mc: McConfig` 字段。默认值：`{ enabled: true, gapThresholdMinutes: 60, keepRecent: 5 }`。

2. **compressor.ts**：新增 `processMicrocompact` 函数

```typescript
export function processMicrocompact(
  messages: AgentMessage[],
  config: McConfig,
  now: number,
  compactBoundaryIdx: number | null,
): { messages: AgentMessage[]; stats: McStats }
```

逻辑：
- 找到最后一个 assistant 消息的时间戳
- 如果 `now - lastAssistantTimestamp <= gapThresholdMinutes * 60000`，返回原消息
- 收集所有 compactable toolResult（工具名在 COMPACTABLE_TOOLS 集合中），按顺序记录
- 保留最近 `keepRecent` 个，前面的替换为 `'[Old tool result content cleared]'`
- **不分配压缩 ID，不存储到 recall store**
- `compactBoundaryIdx` 不为 null 时，只处理该索引之后的消息

COMPACTABLE_TOOLS 集合：
```typescript
const COMPACTABLE_TOOLS = new Set([
  "read", "bash", "bash_background", "grep", "glob",
  "web_search", "web_fetch", "edit", "write",
]);
```

3. **CompressionStats** 新增字段：`mcTriggered: boolean`, `mcCleared: number`

4. **compressContext**：在 L0 之前调用 processMicrocompact

**测试：** AC-1 场景——8 个 compactable toolResult，60 分钟后触发，保留最近 5 个，前 3 个被清理为不可 recall 的标记。

---

### Task 2: Tool Result Budget + Frozen/Fresh 状态

**Type:** backend

**Files:**
- Create: `context-engineering/src/frozen-fresh.ts`
- Modify: `context-engineering/src/config.ts`
- Modify: `context-engineering/src/compressor.ts`
- Test: `context-engineering/src/__tests__/frozen-fresh.test.ts`
- Test: `context-engineering/src/__tests__/compressor.test.ts`

**实现要点：**

1. **frozen-fresh.ts**：FrozenFreshState 接口 + 工厂函数

```typescript
export interface FrozenFreshState {
  isFrozen(toolUseId: string): boolean;
  markFrozen(toolUseId: string, replacement: string): void;
  getReplacement(toolUseId: string): string | undefined;
  getAllFrozenIds(): Set<string>;
  reset(): void;
}

export function createFrozenFreshState(): FrozenFreshState
```

内部用 `Map<string, string>` 存储 replacements。闭包变量，session_start 时重建。

2. **config.ts**：新增 `BudgetConfig` 接口和默认值

```typescript
export interface BudgetConfig {
  enabled: boolean;
  maxToolResultCharsPerMessage: number;
  previewSize: number;
}
```

默认值：`{ enabled: true, maxToolResultCharsPerMessage: 200000, previewSize: 2000 }`。

3. **compressor.ts**：新增 `processBudget` 函数

```typescript
export function processBudget(
  messages: AgentMessage[],
  config: BudgetConfig,
  store: RecallStore,
  ffState: FrozenFreshState,
  compactBoundaryIdx: number | null,
): { messages: AgentMessage[]; stats: BudgetStats }
```

逻辑：
- 按 user 消息分组，每组独立计算 toolResult 总字符数
- 对每个 group：
  - 遍历 toolResult，先处理 frozen 的（直接使用缓存的 replacement）
  - 计算剩余 fresh toolResult 的总字符数
  - 如果超过预算，找出最大的 fresh toolResult，持久化到 recall store，替换为 `<persisted-output>` + 预览
  - 持久化后调用 `ffState.markFrozen(toolCallId, replacement)`
- `compactBoundaryIdx` 不为 null 时，只处理该索引之后的消息

4. **recall-store.ts**：StoredContent level 新增 `"budget-persisted"`

5. **CompressionStats** 新增字段：`budgetPersisted: number`

**测试：**
- AC-2：5 个 toolResult 总计 250K chars，最大被替换，可 recall
- AC-3：Turn 1 持久化 toolResult A，Turn 2 时 A 是 frozen 状态
- AC-6：两次 API 调用的 wire prefix 相同（frozen 不变）

---

### Task 3: Compact Boundary 感知

**Type:** backend

**Files:**
- Modify: `context-engineering/src/compressor.ts`
- Test: `context-engineering/src/__tests__/compressor.test.ts`

**实现要点：**

1. **compressor.ts**：新增 `findCompactBoundary` 函数

```typescript
export function findCompactBoundary(messages: AgentMessage[]): number | null
```

逻辑：遍历消息列表，找到最后一个 `compactionSummary` 类型的消息索引。Pi 的 compactionSummary 是一个 `role: "user"` 消息，content 包含 `"compactionSummary"` 关键词。具体检测方式需要验证 Pi 的实际消息格式——可能是 `content` 字段中包含特殊标记，也可能是 `details` 字段中有特定类型。基于之前的源码分析，Pi 的 `buildSessionContext` 在 compact 后会将 `compactionSummary` 作为 user role 消息发出。

检测方式（需要 dev phase 初期验证 Pi 实际格式）：
- 方案 A：检查 `role === "user"` 且 content 是 string 且包含 `"compactionSummary"` 关键词
- 方案 B：检查消息是否有 `details?.type === "compactionSummary"`
- 方案 C：检查 `role === "user"` 且 content 是对象数组且第一项 text 包含 `"compactionSummary"`

建议先用方案 A（最简单），dev phase 验证后调整。

2. **compressContext**：在压缩管道开头调用 `findCompactBoundary`，将结果传给所有压缩函数

3. **所有压缩函数**：增加 `compactBoundaryIdx` 参数，只处理 `>= compactBoundaryIdx` 的消息

**测试：** AC-4 场景——消息索引 5 有 compactionSummary，之前的消息不参与压缩，之后的正常处理。AC-7 场景——compact 后原生 compact 正常执行。

---

### Task 4: L1 Protected Turn 修复 + L2 Compact Boundary 感知

**Type:** backend

**Files:**
- Modify: `context-engineering/src/compressor.ts`
- Test: `context-engineering/src/__tests__/compressor.test.ts`

**实现要点：**

1. **processL1 修复**：增加 `turnBoundaries` 和 `config.protectRecentTurns` 参数

当前 processL1 签名：
```typescript
function processL1(messages, config, store): { messages, stats }
```

修改为：
```typescript
function processL1(
  messages: AgentMessage[],
  config: L1Config,
  store: RecallStore,
  turnBoundaries: TurnBoundary[],
  compactBoundaryIdx: number | null,
): { messages, stats }
```

在 condense 判断前增加 `isInProtectedTurn(i, turnBoundaries, config.protectRecentTurns)` 检查。

L1Config 新增 `protectRecentTurns: number` 字段，默认值 2。

2. **processL2 优化**：增加 `compactBoundaryIdx` 参数

当前 processL2 已经有 `turnBoundaries` 参数，只需增加 `compactBoundaryIdx` 参数，跳过 compact boundary 之前的消息。

3. **compressContext**：将 `turnBoundaries` 和 `compactBoundaryIdx` 传给 processL1 和 processL2

**测试：** AC-5——12K chars 的 toolResult 在最近 2 轮内不被 condense。L2 在 compact boundary 之前的消息不被处理。

---

### Task 5: Recall 扩展 + L0 keepRecent 保护

**Type:** backend

**Files:**
- Modify: `context-engineering/src/recall-store.ts`
- Modify: `context-engineering/src/compressor.ts`
- Test: `context-engineering/src/__tests__/compressor.test.ts`

**实现要点：**

1. **recall-store.ts**：StoredContent level 联合类型增加 `"budget-persisted"` 和 `"mc-cleared"`（虽然 mc-cleared 实际不存储到 recall，但类型定义需要覆盖）

2. **processL0 增加 keepRecent 保护**：

当前 processL0 已有 `protectRecentTurns` 保护，需要增加 `keepRecent` 保护。

L0Config 新增 `keepRecent: number` 字段，默认值 5。

逻辑：在 processL0 中，收集所有 compactable toolResult 的索引，保留最近 `keepRecent` 个不被过期（即使已超时）。

注意：`keepRecent` 和 `protectRecentTurns` 是两个独立的保护机制。`protectRecentTurns` 按 turn 保护，`keepRecent` 按绝对数量保护。两者取并集——任一保护生效都不过期。

**测试：** 8 个 compactable toolResult，前 3 个超 30 分钟，但 keepRecent=5 保护前 5 个中最近的 5 个。

---

### Task 6: 配置扩展 + 命令扩展 + 统计扩展 + index.ts 集成

**Type:** backend

**Files:**
- Modify: `context-engineering/src/config.ts`
- Modify: `context-engineering/src/commands.ts`
- Modify: `context-engineering/src/index.ts`
- Test: `context-engineering/src/__tests__/integration.test.ts`

**实现要点：**

1. **config.ts**：
   - `parseLevelArgs` 增加 `"mc"` 和 `"budget"` target
   - `ContextEngineeringConfig` 增加 `mc: McConfig` 和 `budget: BudgetConfig`
   - `DEFAULT_CONFIG` 增加两个新 section

2. **commands.ts**：
   - `formatConfigSummary` 增加 mc 和 budget section 展示
   - `formatStats` 增加 mcTriggered、mcCleared、budgetPersisted 展示
   - `handleContextEngineeringCommand` 增加 mc/budget 分支
   - `USAGE_HELP` 增加 mc/budget 命令说明

3. **index.ts**：
   - 闭包新增 `frozenFreshState` 变量
   - `session_start` handler 中调用 `frozenFreshState.reset()`（实际是重建：`frozenFreshState = createFrozenFreshState()`）
   - `context` handler 中串联新管道：`findCompactBoundary` → `processMicrocompact` → `processBudget` → `processL0` → `processL1` → `processL2`
   - `addStats` 增加 mc 和 budget 字段累加

4. **integration.test.ts**：新增测试覆盖 AC-8（mc/budget 命令启停）

---

## Execution Groups

#### BG1: 上下文压缩管道重写

**Description:** 所有 Task 都在 context-engineering 扩展内部，修改压缩管道和配置。这些 Task 有强依赖关系（共享 compressor.ts 和 config.ts），必须串行。

**Tasks:** Task 1, Task 2, Task 3, Task 4, Task 5, Task 6

**Files (预估):** 8 个文件（3 create + 5 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high, tdd-coder: medium, reviewer: medium） |
| 注入上下文 | Task 描述 + spec AC + 编码规范（CLAUDE.md） |
| 读取文件 | `context-engineering/src/*.ts`, `context-engineering/src/__tests__/*.ts` |
| 修改/创建文件 | 见各 Task Files 列表 |

**Execution Flow (BG1 内部):** 串行派遣，每个 Task 走完整 subagent 链后再开始下一个 Task。

  Task 1 (Microcompact):
    1. general-purpose (read xyz-harness-test-driven-development) → 写失败测试
    2. general-purpose → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 2 (Budget + Frozen/Fresh): depends on Task 1
    1. general-purpose → 写失败测试
    2. general-purpose → 写实现代码
    3. general-purpose → spec 合规检查

  Task 3 (Compact Boundary): depends on Task 1
    1. general-purpose → 写失败测试
    2. general-purpose → 写实现代码
    3. general-purpose → spec 合规检查

  Task 4 (L1 fix + L2 boundary): depends on Task 3
    1. general-purpose → 写失败测试
    2. general-purpose → 写实现代码
    3. general-purpose → spec 合规检查

  Task 5 (Recall + L0 keepRecent): depends on Task 2
    1. general-purpose → 写失败测试
    2. general-purpose → 写实现代码
    3. general-purpose → spec 合规检查

  Task 6 (Config + Commands + Integration): depends on Task 1-5
    1. general-purpose → 写实现代码（集成测试为主）
    2. general-purpose → spec 合规检查

**Dependencies:** 无

---

## Dependency Graph & Wave Schedule

```
Task 1 ──┬──→ Task 2 ──┬──→ Task 6
         │             │
         ├──→ Task 3 ──┤
         │             │
         │     Task 4 ──┘ (depends on Task 3)
         │
         └──→ Task 5 (depends on Task 2)
```

| Wave | Tasks | 说明 |
|------|-------|------|
| Wave 1 | Task 1 | Microcompact 基础，无依赖 |
| Wave 2 | Task 2, Task 3 | Budget + Frozen/Fresh；Compact Boundary。可并行但共享 compressor.ts，建议串行 |
| Wave 3 | Task 4, Task 5 | L1 修复 + L2 boundary；Recall + L0 keepRecent。可并行但共享 compressor.ts，建议串行 |
| Wave 4 | Task 6 | 集成 + 配置 + 命令，依赖前面所有 Task |

> **注意：** Task 2 和 Task 3 都修改 `compressor.ts`，实际执行时必须串行（即使依赖关系允许并行）。同一文件不允许多个 subagent 同时修改。所以 BG1 内部全部串行。
