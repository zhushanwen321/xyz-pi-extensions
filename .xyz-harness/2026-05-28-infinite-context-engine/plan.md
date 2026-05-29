---
verdict: pass
complexity: L1
---

# 无限上下文引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 Pi Extension，通过 LLM 驱动的树结构上下文压缩，使 AI coding agent 永远不会触达上下文窗口上限。

**Architecture:** Extension 注册 `context`/`turn_end`/`session_start`/`session_before_compact` 四个事件 handler。`turn_end` 中以异步子进程触发 LLM 压缩，`context` handler 中做 BFS 展平 + 预算裁剪。段索引和树结构通过 `pi.appendEntry()` 持久化到 session JSONL。

**Tech Stack:** TypeScript, Pi Extension API (`@mariozechner/pi-coding-agent`), typebox, pi-tui, `child_process.spawn`

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `infinite-context/index.ts` | create | BG1 | 入口 re-export |
| `infinite-context/package.json` | create | BG1 | 扩展元数据 |
| `infinite-context/src/index.ts` | create | BG1 | 扩展工厂函数，注册所有 handler/tool/command |
| `infinite-context/src/types.ts` | create | BG1 | 所有类型定义（Segment, TreeNode, CompactionResult 等） |
| `infinite-context/src/segment-tracker.ts` | create | BG1 | 段索引管理（FR-1） |
| `infinite-context/src/tree-compactor.ts` | create | BG1 | 树压缩执行（FR-2：subagent 调用、校验、重试、降级） |
| `infinite-context/src/context-handler.ts` | create | BG2 | Context handler：BFS 展平、预算控制、tree-context 估算（FR-3） |
| `infinite-context/src/recall-tool.ts` | create | BG2 | Recall 工具实现（FR-4） |
| `infinite-context/src/commands.ts` | create | BG2 | `/tree-compact` 和 `/context-status` 命令（FR-5/6） |
| `infinite-context/src/token-estimator.ts` | create | BG1 | chars/4 token 估算工具 |

---

## Interface Contracts

### Module: segment-tracker

#### Class: SegmentTracker

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| handleTurnEnd | `(ctx: ExtensionContext, turnIndex: number, message: unknown, toolResults: unknown[]) => void` | `void` | First turn (no prior segment); consecutive user messages | AC-1 |
| restoreState | `(entries: SessionEntry[]) => void` | `void` | Empty entries; entries with missing fields | AC-1 |
| getSegments | `() => readonly Segment[]` | `readonly Segment[]` | No segments | AC-1 |
| getCurrentSegment | `() => Segment \| undefined` | `Segment \| undefined` | Before first turn | AC-1 |
| getRetentionWindow | `() => readonly Segment[]` | `readonly Segment[]` | Fewer than 2 segments | AC-3 |

#### Data: Segment

| Field | Type | Description |
|-------|------|-------------|
| segId | `string` | 格式 `seg_N`，N 为递增整数 |
| turnRange | `{ start: number; end: number }` | 起止 turnIndex |
| userMessage | `string` | 触发该段的 user message 文本 |
| completed | `boolean` | 是否已完成（新 user message 标记前段完成） |
| filePath | `string` | 段原始数据文件路径 |

### Module: tree-compactor

#### Class: TreeCompactor

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| triggerCompression | `(ctx: ExtensionContext, segments: readonly Segment[], existingTree: CompactTree \| undefined, onComplete?: (result: CompactResult) => void) => void` | `void` | isCompressing=true; 0 segments; subagent timeout; invalid JSON | AC-2 |
| cancelPiCompaction | `() => { cancel: boolean }` | `{ cancel: boolean }` | — | AC-6 |
| getTree | `() => CompactTree \| undefined` | `CompactTree \| undefined` | Before first compression | AC-3 |
| isCompressing | `() => boolean` | `boolean` | — | AC-2 |

#### Data: CompactTree

| Field | Type | Description |
|-------|------|-------------|
| children | `TreeNode[]` | 根节点的子节点列表 |
| createdAt | `number` | 压缩时间戳 |
| segmentCount | `number` | 被压缩的段数量 |
| fallbackUsed | `boolean` | 是否使用了规则降级 |

#### Data: TreeNode

| Field | Type | Description |
|-------|------|-------------|
| type | `"group" \| "leaf"` | 节点类型 |
| nodeId | `string` | `gN` (group) 或 `seg_N` (leaf) |
| summary | `string` | 摘要文本 |
| children | `TreeNode[]` | 仅 group 有 |

### Module: context-handler

#### Class: ContextAssembler

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| assembleMessages | `(messages: AgentMessage[], tree: CompactTree \| undefined, segments: readonly Segment[], retentionWindow: readonly Segment[]) => AssembleResult` | `AssembleResult` | No tree; no segments; budget overflow | AC-3 |
| estimateTreeContext | `(messages: AgentMessage[]) => number` | `number` | Empty messages | AC-3 |
| shouldCompress | `(treeContextTokens: number, contextWindow: number) => boolean` | `boolean` | — | AC-2 |

#### Data: AssembleResult

| Field | Type | Description |
|-------|------|-------------|
| messages | `AgentMessage[]` | 组装后的 messages |
| treeContextTokens | `number` | 独立 tree-context 估算值 |
| compressedNodeCount | `number` | 被压缩的节点数量 |

### Module: recall-tool

#### Class: RecallTool

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| executeRecall | `(nodeId: string, mode: "structure" \| "content", tree: CompactTree, sessionId: string) => RecallResult` | `RecallResult` | nodeId not found; group content mode; empty content | AC-4 |

#### Data: RecallResult

| Field | Type | Description |
|-------|------|-------------|
| content | `Array<{ type: string; text: string }>` | Pi tool result content |
| details | `object` | 详情数据 |

### Module: token-estimator

#### Function: estimateTokens

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| estimateTokens | `(text: string) => number` | `number` | Empty string | AC-3 |

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1.1 | SegmentTracker.handleTurnEnd | turn_end → detectNewUserMessage → appendEntry | Task 1 |
| AC-1.2 | SegmentTracker.restoreState | session_start → filterEntries → restoreSegments | Task 1 |
| AC-1.3 | SegmentTracker.handleTurnEnd (file write) | turn_end → writeSegFile | Task 1 |
| AC-1.4 | SegmentTracker.handleTurnEnd (turn map) | turn_end → recordTurnIndex → appendEntry | Task 1 |
| AC-2.1 | ContextAssembler.shouldCompress → TreeCompactor.triggerCompression | context_handler → setFlag → turn_end → spawn | Task 2 |
| AC-2.2 | TreeCompactor.triggerCompression | command → triggerCompression | Task 4 |
| AC-2.3 | TreeCompactor.cancelPiCompaction | session_before_compact → {cancel:true} | Task 2 |
| AC-2.4 | TreeCompactor.triggerCompression (subagent spawn) | spawn pi --mode json | Task 2 |
| AC-2.5 | TreeCompactor.triggerCompression (validate JSON) | parse → validate → store | Task 2 |
| AC-2.6 | TreeCompactor.triggerCompression (persist) | appendEntry ic-compact-tree | Task 2 |
| AC-2.7 | TreeCompactor.triggerCompression (fallback) | timeout → ruleBasedFallback | Task 2 |
| AC-2.8 | TreeCompactor.triggerCompression (retry) | validate fail → retry once | Task 2 |
| AC-2.9 | TreeCompactor.triggerCompression (rule fallback) | subagent error → ruleStrategy | Task 2 |
| AC-2.10 | TreeCompactor.triggerCompression (async) | spawn async → isCompressing guard | Task 2 |
| AC-3.1 | ContextAssembler.assembleMessages | current + retention → full text | Task 3 |
| AC-3.2 | ContextAssembler.assembleMessages | tree nodes → [nodeId] summary | Task 3 |
| AC-3.3 | ContextAssembler.assembleMessages | BFS flatten → level-by-level | Task 3 |
| AC-3.4 | ContextAssembler.assembleMessages | budget check → depth truncation | Task 3 |
| AC-3.5 | ContextAssembler.assembleMessages | inject recall hint | Task 3 |
| AC-3.6 | ContextAssembler.estimateTreeContext | chars/4 sum | Task 3 |
| AC-3.7 | ContextAssembler.assembleMessages | messages copy only | Task 3 |
| AC-4.1 | RecallTool.executeRecall (structure) | tree traverse → nodeId+summary only | Task 5 |
| AC-4.2 | RecallTool.executeRecall (content) | segFile → raw messages | Task 5 |
| AC-4.3 | RecallTool.executeRecall (error) | nodeId lookup → error message | Task 5 |
| AC-4.4 | Recall tool description | tool schema description | Task 5 |
| AC-5.1 | commands.ts /tree-compact | command → triggerCompression → TUI notify | Task 4 |
| AC-5.2 | commands.ts /context-status | command → estimateTreeContext → TUI render | Task 4 |
| AC-6.1 | cancelPiCompaction | session_before_compact handler | Task 2 |
| AC-6.2 | /context-status display | both values shown | Task 4 |

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1: 段管理（4 项） | adopted | Task 1 |
| AC-2: 树压缩（10 项） | adopted | Task 2 |
| AC-3: Context 组装（7 项） | adopted | Task 3 |
| AC-4: Recall 工具（4 项） | adopted | Task 5 |
| AC-5: 命令（2 项） | adopted | Task 4 |
| AC-6: 兼容性（2 项） | adopted | Task 2, Task 4 |
| C-1: 不改 Pi 核心 | adopted | 所有 Task |
| C-2: 原始数据完整性 | adopted | Task 3 |
| C-3: 压缩模型（主模型 memory 模式） | adopted | Task 2 |
| C-4: 性能（30s 超时、50ms handler） | adopted | Task 2, Task 3 |
| C-5: 段边界（user message） | adopted | Task 1 |
| C-6: 保留窗口（min(2seg, 8turn)） | adopted | Task 1 |
| C-7: Token 估算（chars/4） | adopted | Task 3 |
| C-8: getContextUsage 限制 | adopted | Task 4 |

---

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | 段索引追踪器 + Token 估算器 | backend | — | BG1 |
| 2 | 树压缩引擎（subagent 调用 + 校验 + 降级） | backend | 1 | BG1 |
| 3 | Context Handler（BFS 展平 + 预算控制） | backend | 1, 2 | BG2 |
| 4 | Commands + 扩展入口注册 | backend | 1, 2, 3 | BG2 |
| 5 | Recall 工具 | backend | 2, 3 | BG2 |
| 6 | 集成验证 + TUI 渲染 | backend | 1-5 | BG2 |

---

## Execution Groups

#### BG1: 基础设施（段追踪 + 压缩引擎）

**Description:** 核心数据层——段索引管理和树压缩执行。这两个组件构成整个扩展的底座。

**Tasks:** Task 1, Task 2

**Files (预估):** 7 个文件（6 create + 1 create package.json）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high、tdd-coder: medium） |
| 注入上下文 | spec FR-1/FR-2、types.ts 类型定义、goal 扩展模式参考 |
| 读取文件 | `goal/src/index.ts`（handler 注册模式）、`goal/src/state.ts`（状态管理模式） |
| 修改/创建文件 | `infinite-context/index.ts`, `infinite-context/package.json`, `infinite-context/src/types.ts`, `infinite-context/src/segment-tracker.ts`, `infinite-context/src/tree-compactor.ts`, `infinite-context/src/token-estimator.ts` |

**Execution Flow (BG1 内部):** 串行派遣。

  Task 1:
    1. general-purpose (read xyz-harness-backend-dev) → 写实现代码 + type-level 验证
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 2 (depends on Task 1):
    1. general-purpose (read xyz-harness-backend-dev) → 写实现代码 + type-level 验证
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** 无

**注意：** Pi 扩展无单元测试框架。Task 使用 type-level 验证（tsc --noEmit）+ 手动集成测试（e2e-test-plan.md），不执行 TDD 流程。

---

#### BG2: Context 组装 + 命令 + Recall + 集成

**Description:** 消费 BG1 产出的段索引和压缩树，实现 context handler 组装、recall 工具、命令和扩展入口注册。

**Tasks:** Task 3, Task 4, Task 5, Task 6

**Files (预估):** 5 个文件（4 create + 1 modify index.ts）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high、tdd-coder: medium） |
| 注入上下文 | spec FR-3/FR-4/FR-5/FR-6、BG1 产出的 types.ts、context handler 注册模式 |
| 读取文件 | BG1 产出的所有文件 |
| 修改/创建文件 | `infinite-context/src/context-handler.ts`, `infinite-context/src/recall-tool.ts`, `infinite-context/src/commands.ts`, `infinite-context/src/index.ts`（modify） |

**Execution Flow (BG2 内部):** 串行派遣。

  Task 3 (depends on Task 1, 2):
    1. general-purpose (read xyz-harness-backend-dev) → 写实现代码 + type-level 验证
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 4 (depends on Task 3):
    1. general-purpose (read xyz-harness-backend-dev) → 写命令实现
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 5 (depends on Task 2, 3):
    1. general-purpose (read xyz-harness-backend-dev) → 写实现代码 + type-level 验证
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 6 (depends on Task 1-5):
    1. general-purpose (read xyz-harness-expert-reviewer) → 全链路集成审查 + entry GC

**Dependencies:** BG1（需要 BG1 产出的 types.ts、segment-tracker.ts、tree-compactor.ts）

**注意：** Pi 扩展无单元测试框架。Task 使用 type-level 验证（tsc --noEmit）+ 手动集成测试（e2e-test-plan.md），不执行 TDD 流程。

---

## Dependency Graph & Wave Schedule

```
BG1 (基础设施) ──→ BG2 (组装+命令+Recall)

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | 段追踪 + 压缩引擎，无依赖 |
| Wave 2 | BG2 | Context 组装 + 命令 + Recall + 集成，依赖 BG1 |
```

---

## Task Details

### Task 1: 段索引追踪器 + Token 估算器

**Type:** backend

**Files:**
- Create: `infinite-context/index.ts`
- Create: `infinite-context/package.json`
- Create: `infinite-context/src/types.ts`
- Create: `infinite-context/src/segment-tracker.ts`
- Create: `infinite-context/src/token-estimator.ts`

**覆盖 AC:** AC-1 (全部 4 项)

- [ ] **Step 1:** 创建 `types.ts` — 定义 Segment, SegmentIndex, TurnIndexMap, TreeNode, CompactTree 等核心类型。类型必须与 Interface Contracts 中的定义完全对齐。
- [ ] **Step 2:** 创建 `token-estimator.ts` — 导出 `estimateTokens(text: string): number`，实现 `Math.ceil(text.length / 4)`。
- [ ] **Step 3:** 创建 `segment-tracker.ts` — 实现 `SegmentTracker` 类，核心方法：
  - `restoreState(entries)`: 从 entries 过滤 `ic-segment` 和 `ic-turn` 类型恢复闭包状态
  - `handleTurnEnd(ctx, turnIndex, message, toolResults)`: 检测段边界（message.role === "user"），创建新段，写入 `seg_N.json`，appendEntry
  - `getSegments()`: 返回只读段列表
  - `getCurrentSegment()`: 返回当前活跃段
  - `getRetentionWindow()`: 返回 min(2 段, 8 turns) 范围内的段
- [ ] **Step 4:** 创建 `index.ts` 和 `package.json` — 骨架入口，re-export `src/index.ts`。`src/index.ts` 暂时只导出工厂函数骨架（后续 Task 4 完善）。
- [ ] **Step 5:** Commit — `feat(infinite-context): add segment tracker and token estimator`

---

### Task 2: 树压缩引擎

**Type:** backend

**Depends on:** Task 1

**Files:**
- Create: `infinite-context/src/tree-compactor.ts`
- Modify: `infinite-context/src/types.ts`（追加压缩相关类型）

**覆盖 AC:** AC-2 (全部 10 项), AC-6.1

- [ ] **Step 1:** 扩展 `types.ts` — 添加 `CompactTree`, `TreeNode`, `CompactResult`, `ValidateError` 类型。`isCompressing` 状态由 `TreeCompactor` 内部管理（私有属性），无需在 types.ts 中定义。
- [ ] **Step 2:** 创建 `tree-compactor.ts` — `TreeCompactor` 类（**isCompressing 由 TreeCompactor 内部管理，封装性好**）:
  - `triggerCompression(ctx, segments, existingTree, onComplete?)`: 核心压缩方法，**fire-and-forget + 回调模式**
    - 检查 `isCompressing` 守卫（内部状态）
    - 设置 `isCompressing = true`
    - 计算保留窗口外的历史段
    - 构建 subagent prompt（包含段概要列表 + 输出 JSON schema 示例）
    - `child_process.spawn` 异步启动 `pi --mode json -p "<prompt>"`
    - 30 秒超时 kill
    - 完成后调用 `validateTreeOutput` 校验
    - 校验失败：构建 error feedback → 最多重试 1 次
    - 持久化到 `appendEntry("ic-compact-tree", result)`
    - 重置 `isCompressing = false`
    - **调用 `onComplete(result)` 回调通知命令/TUI**
  - `validateTreeOutput(output, segments)`: 校验 JSON 合法性、segId 存在性、无重复、无环、summary 非空
  - `ruleBasedFallback(segments)`: 规则降级——所有段为独立 leaf，summary = 用户消息第一句话
  - `cancelPiCompaction()`: 返回 `{ cancel: true }`
  - `getTree()`: 返回当前树
- [ ] **Step 3:** Commit — `feat(infinite-context): add tree compactor with validation and fallback`

---

### Task 3: Context Handler（BFS 展平 + 预算控制）

**Type:** backend

**Depends on:** Task 1, Task 2

**Files:**
- Create: `infinite-context/src/context-handler.ts`

**覆盖 AC:** AC-3 (全部 7 项)

- [ ] **Step 1:** 创建 `context-handler.ts` — `ContextAssembler` 类：
  - `assembleMessages(messages, tree, segments, retentionWindow)`:
    1. 浅拷贝 messages（不修改原始）
    2. 计算保留窗口：当前段 + 最近 2 段（不超过 8 turn）→ 完整原文
    3. 已压缩段 → BFS 展平为 `[nodeId] summary` 格式的 CustomMessage
    4. 未压缩的旧段 → 完整原文
    5. 预算检查：`estimateTokens(assembled)` vs `contextWindow * 0.8`
    6. 超限 → 按深度截断（先砍最深层最老节点）
    7. 存在被压缩节点时注入 recall 提示
  - `bfsFlatten(tree)`: BFS per level，同层 newest-to-oldest，返回 `TreeNode[]`
  - `estimateTreeContext(messages)`: 遍历所有 message，累加 chars/4
  - `shouldCompress(treeContextTokens, contextWindow)`: `treeContextTokens / contextWindow >= 0.7`
  - `budgetTruncate(flatNodes, budget)`: 从最深层最老节点开始裁剪直到 budget 内
  - **预算裁剪保护层级（从高到低）：**
    1. 保留窗口（当前段 + 最近 2 段）→ **永不可截断**，无论如何都完整原文
    2. 树节点摘要（BFS 展平结果）→ 按深度裁剪（先砍最深层最老节点）
    3. 未压缩的旧段 → 在树节点全部裁剪后仍超限时，从最旧段开始截断
    4. 极端情况：只保留 retention window + Level 1 全部 + recall 提示
- [ ] **Step 2:** Commit — `feat(infinite-context): add context handler with BFS flatten and budget control`

---

### Task 4: Commands + 扩展入口注册

**Type:** backend

**Depends on:** Task 1, Task 2, Task 3

**Files:**
- Create: `infinite-context/src/commands.ts`
- Modify: `infinite-context/src/index.ts`（完善工厂函数，注册所有 handler/tool/command）

**覆盖 AC:** AC-5 (全部 2 项), AC-6.2, AC-2.2, AC-2.3

- [ ] **Step 1:** 创建 `commands.ts` — 导出两个命令实现：
  - `registerTreeCompactCommand(pi, compactor)`: `/tree-compact` → 调用 `compactor.triggerCompression()`，传入 `onComplete` 回调在 TUI 显示压缩结果
  - `registerContextStatusCommand(pi, ctx, assembler, compactor, tracker)`: `/context-status` → 显示原始上下文（`ctx.getContextUsage()`）和树上下文（`assembler.estimateTreeContext()`）
- [ ] **Step 2:** 完善 `src/index.ts` — 工厂函数 `export default function infiniteContextExtension(pi: ExtensionAPI)`:
  - 声明闭包变量：`segmentTracker`, `treeCompactor`, `contextAssembler`, `needsCompression`（`isCompressing` 由 `TreeCompactor` 内部管理，通过 `treeCompactor.isCompressing()` 查询）
  - `pi.on("session_start", ...)`: 从 entries 恢复状态
  - `pi.on("turn_end", ...)`: 段追踪 + 压缩触发检查
  - `pi.on("context", ...)`: 调用 `contextAssembler.assembleMessages()`，修改 messages 副本
  - `pi.on("session_before_compact", ...)`: 调用 `treeCompactor.cancelPiCompaction()`
  - `pi.registerTool("recall", ...)`: 注册 recall 工具
  - `pi.registerCommand("/tree-compact", ...)`: 注册命令
  - `pi.registerCommand("/context-status", ...)`: 注册命令
- [ ] **Step 3:** Commit — `feat(infinite-context): add commands and register all handlers`

---

### Task 5: Recall 工具

**Type:** backend

**Depends on:** Task 2, Task 3

**Files:**
- Create: `infinite-context/src/recall-tool.ts`

**覆盖 AC:** AC-4 (全部 4 项)

- [ ] **Step 1:** 创建 `recall-tool.ts` — `RecallTool` 类：
  - `executeRecall(nodeId, mode, tree, sessionId)`:
    - `mode: "structure"`: 递归遍历树找到 nodeId，返回子树结构（nodeId + type + summary + children），**不含任何原始内容**
    - `mode: "content"`: 找到 nodeId，如果是 leaf → 读取 `seg_N.json` 返回 raw messages；如果是 group → 递归收集所有子孙 leaf 的 raw messages
    - nodeId 不存在 → 返回错误消息
  - 注册到 Pi：`pi.registerTool("recall", { name: "recall", description: "...", parameters: schema, execute: ... })`
  - Tool description 中写明两次调用模式
- [ ] **Step 2:** Commit — `feat(infinite-context): add recall tool with two-call pattern`

---

### Task 6: 集成验证 + TUI 渲染

**Type:** backend

**Depends on:** Task 1-5

**Files:**
- Modify: `infinite-context/src/index.ts`（TUI renderCall/renderResult）
- Modify: `infinite-context/src/commands.ts`（TUI 渲染优化）

**覆盖 AC:** 全部 AC 的集成验证

- [ ] **Step 1:** 为 recall 工具添加 `renderCall` 和 `renderResult`——显示 recall 请求和结果的 TUI 渲染
- [ ] **Step 2:** 为 `/tree-compact` 命令添加压缩进度和结果的 TUI 渲染（使用 `theme.fg()` 语义 token）
- [ ] **Step 3:** 为 `/context-status` 命令添加格式化 TUI 输出（原始上下文 vs 树上下文对比）
- [ ] **Step 4:** 类型检查 `npx tsc --noEmit` 通过
- [ ] **Step 5:** 实现 entry GC——达到 1000 条 `ic-turn` entries 时 splice 最旧的条目（保留 `ic-compact-tree` 不删除，因为历史树不可丢失）
- [ ] **Step 6:** Commit — `feat(infinite-context): add TUI rendering and integration verification`
