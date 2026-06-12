---
verdict: pass
complexity: L1
---

# Workflow Extension 分层重构

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 workflow extension 的 17 个扁平源文件重构为 4 层目录结构，同时拆分 3 个超限文件、修复持久化 GC、删除死代码。

**Architecture:** 四层 + 共享域模型。依赖方向严格向下：Factory → Interface → Engine → Infrastructure。Domain Model 零依赖被所有层共享。每一层在自己的目录中。

**Tech Stack:** TypeScript, vitest, Pi Extension API

---

## 目标目录结构

```
src/
  index.ts                          (Factory — 纯胶水 ~150 行)
  domain/
    state.ts                        (状态机 + 数据模型，不变)
  infra/
    agent-pool.ts                   (缩小：~200 行，纯调度)
    pi-runner.ts                    (新：从 agent-pool.ts 提取)
    jsonl-parser.ts                 (新：从 agent-pool.ts 提取)
    state-store.ts                  (新：从 orchestrator + index 提取)
    config-loader.ts                (不变)
    agent-discovery.ts              (不变)
    agent-opts-resolver.ts          (不变)
    execution-trace.ts              (改 rewrite 模式)
    script-lint.ts                  (不变)
  engine/
    orchestrator.ts                 (缩小：~400 行，纯协调)
    worker-manager.ts              (新：从 orchestrator.ts 提取)
    agent-executor.ts              (新：从 orchestrator.ts 提取)
    worker-script.ts                (不变)
    orchestrator-events.ts          (不变)
    orchestrator-budget.ts          (不变)
    model-resolver.ts               (不变)
  interface/
    tool-workflow.ts                (新：从 index.ts 提取)
    tool-workflow-run.ts            (新：从 index.ts 提取)
    tool-lint.ts                    (新：从 index.ts 提取)
    tool-generate.ts                (不变)
    commands.ts                     (不变)
    views/
      WorkflowsView.ts              (不变)
      format.ts                     (不变)
```

**删除：** `src/budget.ts`（95 行死代码，全项目零引用）

## 依赖规则

| 从 → 到 | 允许 | 说明 |
|---------|------|------|
| Factory → Interface | ✅ | 入口调用注册函数 |
| Interface → Engine | ✅ | tool/command 调用 orchestrator |
| Engine → Infrastructure | ✅ | orchestrator 调用 pool / store |
| 任何层 → Domain | ✅ | 共享数据模型 |
| 反方向 | ❌ | 禁止反向依赖 |
| Domain → 任何层 | ❌ | 数据模型零依赖 |

## 文件归属映射

### 不变的文件（11 个，只需移动 + 更新 import）

| 当前位置 | 目标位置 | 层 |
|---------|---------|-----|
| `src/state.ts` | `src/domain/state.ts` | Domain |
| `src/config-loader.ts` | `src/infra/config-loader.ts` | Infra |
| `src/agent-discovery.ts` | `src/infra/agent-discovery.ts` | Infra |
| `src/agent-opts-resolver.ts` | `src/infra/agent-opts-resolver.ts` | Infra |
| `src/script-lint.ts` | `src/infra/script-lint.ts` | Infra |
| `src/worker-script.ts` | `src/engine/worker-script.ts` | Engine |
| `src/orchestrator-events.ts` | `src/engine/orchestrator-events.ts` | Engine |
| `src/orchestrator-budget.ts` | `src/engine/orchestrator-budget.ts` | Engine |
| `src/model-resolver.ts` | `src/engine/model-resolver.ts` | Engine |
| `src/tool-generate.ts` | `src/interface/tool-generate.ts` | Interface |
| `src/commands.ts` | `src/interface/commands.ts` | Interface |

### 缩小的文件（3 个）

| 当前位置 | 目标位置 | 行数变化 | 提取目标 |
|---------|---------|---------|---------|
| `src/index.ts` (826 行) | `src/index.ts` (~150 行) | 826 → ~150 | → tool-workflow.ts, tool-workflow-run.ts, tool-lint.ts, state-store.ts |
| `src/orchestrator.ts` (986 行) | `src/engine/orchestrator.ts` (~400 行) | 986 → ~400 | → worker-manager.ts, agent-executor.ts, state-store.ts |
| `src/agent-pool.ts` (662 行) | `src/infra/agent-pool.ts` (~200 行) | 662 → ~200 | → pi-runner.ts, jsonl-parser.ts |

### 新建的文件（7 个）

| 文件 | 从哪里提取 | 职责 |
|------|----------|------|
| `src/infra/pi-runner.ts` | agent-pool.ts | spawn pi 子进程 + buildArgs + runPiProcess |
| `src/infra/jsonl-parser.ts` | agent-pool.ts | processJsonlEvent + ParsedPipelineEvent |
| `src/infra/state-store.ts` | orchestrator.ts + index.ts | persistState + reconstructState（rewrite 模式） |
| `src/engine/worker-manager.ts` | orchestrator.ts | Worker 线程生命周期管理 |
| `src/engine/agent-executor.ts` | orchestrator.ts | agent 调用执行 + 重试 + cache |
| `src/interface/tool-workflow.ts` | index.ts | workflow tool 注册 + execute + render |
| `src/interface/tool-workflow-run.ts` | index.ts | workflow-run tool 注册 + execute + render |
| `src/interface/tool-lint.ts` | index.ts | workflow-lint tool 注册 + execute |

### 删除的文件（1 个）

| 文件 | 原因 |
|------|------|
| `src/budget.ts` | BudgetTracker class 零引用，实际预算逻辑在 orchestrator-budget.ts |

## Execution Groups

按 Wave 编排。同一 Wave 内的 Group 可并行，Wave 间串行。每个 Group 对应一个 subagent。

```
Wave 0: BG0 (准备 + 死代码)
Wave 1: BG1 (移动 Domain + Infra 不变文件) ← 无逻辑变更，纯移动
Wave 2: BG2 (移动 Engine + Interface 不变文件) ← 无逻辑变更，纯移动
Wave 3: BG3 (拆分 agent-pool) ← 逻辑提取
Wave 4: BG4 (拆分 orchestrator + 提取 state-store) ← 逻辑提取
Wave 5: BG5 (拆分 index.ts + 重写 index.ts 为工厂) ← 逻辑提取
Wave 6: BG6 (修复持久化 GC + 统一错误处理) ← 行为变更
Wave 7: BG7 (测试修复 + 全量验证) ← 验证
```

### BG0: 准备工作

**Description:** 创建目录结构 + 删除死代码

**Tasks:** Task 0

**Files (预估):** 1 个文件（删除）

**Execution Flow:** 单步

**Dependencies:** 无

#### Task 0: 创建目录 + 删除 budget.ts

**Files:**
- Delete: `src/budget.ts`
- Delete: `tests/state-budget.test.ts`（测试死代码）
- Create directory: `src/domain/`, `src/infra/`, `src/engine/`, `src/interface/`, `src/interface/views/`

- [ ] **Step 1:** 创建四层目录
```bash
mkdir -p src/domain src/infra src/engine src/interface src/interface/views
```

- [ ] **Step 2:** 删除 budget.ts 和它的测试
```bash
rm src/budget.ts tests/state-budget.test.ts
```

- [ ] **Step 3:** 运行 typecheck 确认删除安全
```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: 零错误（budget.ts 零引用）

- [ ] **Step 4:** Commit
```bash
git add -A && git commit -m "refactor: delete dead budget.ts module"
```

---

### BG1: 移动 Domain + Infra 层不变文件

**Description:** 将 domain 和 infra 层的不变文件移入对应目录。这些文件只需移动和更新 import 路径，不改逻辑。

**Tasks:** Task 1, Task 2

**Files (预估):** 8 个文件（move）+ ~15 个文件（import 修复）

**Execution Flow:** Task 1 (domain) → Task 2 (infra)

**Dependencies:** BG0

#### Task 1: 移动 state.ts → domain/state.ts

**Files:**
- Move: `src/state.ts` → `src/domain/state.ts`

- [ ] **Step 1:** 移动文件
```bash
mv src/state.ts src/domain/state.ts
```

- [ ] **Step 2:** 更新所有 import state.ts 的文件

以下文件 import 了 `"./state.js"` 或 `"../src/state"`，需要改为新路径：

| 文件 | 当前 import | 新 import |
|------|-----------|----------|
| `src/orchestrator.ts` | `"./state.js"` | `"../domain/state.js"` |
| `src/orchestrator-budget.ts` | `"./state.js"` | `"../domain/state.js"` |
| `src/orchestrator-events.ts` | `"./state.js"` | `"../domain/state.js"` |
| `src/agent-pool.ts` | `"./state.js"` | `"../domain/state.js"` |
| `src/execution-trace.ts` | `"./state.js"` | `"../domain/state.js"` |
| `src/worker-script.ts` | `"./state.js"` | `"../domain/state.js"` |
| `src/commands.ts` | `"./state.js"` | `"../interface/state.js"` → 先不动，等 commands 移到 interface 后再统一 |
| `src/index.ts` | (间接通过 orchestrator) | — |
| `src/views/WorkflowsView.ts` | `"../state.js"` | `"../../domain/state.js"` → 等 views 移到 interface 后再统一 |
| `src/__tests__/workflows-view.test.ts` | `"../state.js"` | `"../../domain/state.js"` |
| `tests/state.test.ts` | `"../src/state"` | `"../src/domain/state"` |
| `tests/orchestrator.test.ts` | (间接) | — |
| `tests/commands-generate.test.ts` | `"../src/state"` | `"../src/domain/state"` |

对于尚未移动的文件（orchestrator.ts、commands.ts 等），先更新为指向 `domain/state.js` 的路径（这些文件后续会移到 engine/ 或 interface/，届时 import 会再次变更，但每次变更都有 typecheck 验证）。

- [ ] **Step 3:** 运行 typecheck
```bash
npx tsc --noEmit
```
Expected: 零错误

- [ ] **Step 4:** 运行测试
```bash
npx vitest run
```
Expected: 全部通过

- [ ] **Step 5:** Commit
```bash
git add -A && git commit -m "refactor: move state.ts to domain layer"
```

#### Task 2: 移动 4 个 Infra 不变文件

**Files:**
- Move: `src/config-loader.ts` → `src/infra/config-loader.ts`
- Move: `src/agent-discovery.ts` → `src/infra/agent-discovery.ts`
- Move: `src/agent-opts-resolver.ts` → `src/infra/agent-opts-resolver.ts`
- Move: `src/script-lint.ts` → `src/infra/script-lint.ts`

- [ ] **Step 1:** 移动文件
```bash
mv src/config-loader.ts src/infra/config-loader.ts
mv src/agent-discovery.ts src/infra/agent-discovery.ts
mv src/agent-opts-resolver.ts src/infra/agent-opts-resolver.ts
mv src/script-lint.ts src/infra/script-lint.ts
```

- [ ] **Step 2:** 更新所有 import 路径

依赖关系图（需要更新 import 的文件）：

```
config-loader.ts ← orchestrator.ts, index.ts, tool-generate.ts, commands.ts
agent-discovery.ts ← agent-opts-resolver.ts, orchestrator.ts
agent-opts-resolver.ts ← orchestrator.ts
script-lint.ts ← orchestrator.ts, index.ts (workflow-lint tool 内联)
```

Import 路径规则：
- 同层引用：`"./xxx.js"`
- 跨层向下（engine → infra）：`"../infra/xxx.js"`
- 跨层向下（interface → infra）：`"../infra/xxx.js"`
- 测试文件：`"../src/infra/xxx"`

- [ ] **Step 3:** 更新测试 import
```bash
# agent-discovery.test.ts
# config-loader 的测试（如果有直接 import 的）
```

- [ ] **Step 4:** 运行 typecheck + 测试
```bash
npx tsc --noEmit && npx vitest run
```

- [ ] **Step 5:** Commit
```bash
git add -A && git commit -m "refactor: move infra layer files to src/infra/"
```

---

### BG2: 移动 Engine + Interface 层不变文件

**Description:** 将 engine 和 interface 层的不变文件移入对应目录。

**Tasks:** Task 3, Task 4

**Dependencies:** BG1

#### Task 3: 移动 4 个 Engine 不变文件

**Files:**
- Move: `src/worker-script.ts` → `src/engine/worker-script.ts`
- Move: `src/orchestrator-events.ts` → `src/engine/orchestrator-events.ts`
- Move: `src/orchestrator-budget.ts` → `src/engine/orchestrator-budget.ts`
- Move: `src/model-resolver.ts` → `src/engine/model-resolver.ts`

- [ ] **Step 1:** 移动文件
```bash
mv src/worker-script.ts src/engine/worker-script.ts
mv src/orchestrator-events.ts src/engine/orchestrator-events.ts
mv src/orchestrator-budget.ts src/engine/orchestrator-budget.ts
mv src/model-resolver.ts src/engine/model-resolver.ts
```

- [ ] **Step 2:** 更新 import 路径 + 测试
```bash
npx tsc --noEmit && npx vitest run
```

- [ ] **Step 3:** Commit
```bash
git add -A && git commit -m "refactor: move engine layer files to src/engine/"
```

#### Task 4: 移动 3 个 Interface 不变文件 + views/

**Files:**
- Move: `src/tool-generate.ts` → `src/interface/tool-generate.ts`
- Move: `src/commands.ts` → `src/interface/commands.ts`
- Move: `src/views/WorkflowsView.ts` → `src/interface/views/WorkflowsView.ts`
- Move: `src/views/format.ts` → `src/interface/views/format.ts`
- Delete empty: `src/views/` directory

- [ ] **Step 1:** 移动文件
```bash
mv src/tool-generate.ts src/interface/tool-generate.ts
mv src/commands.ts src/interface/commands.ts
mv src/views/WorkflowsView.ts src/interface/views/WorkflowsView.ts
mv src/views/format.ts src/interface/views/format.ts
rmdir src/views
```

- [ ] **Step 2:** 更新 import 路径 + 测试
```bash
npx tsc --noEmit && npx vitest run
```

- [ ] **Step 3:** Commit
```bash
git add -A && git commit -m "refactor: move interface layer files to src/interface/"
```

**里程碑验证：** 此时所有文件已进入对应层目录，但还没有拆分大文件。运行全量验证：
```bash
npx tsc --noEmit && npx vitest run && echo "✅ Phase 1 complete: all files in layer directories"
```

---

### BG3: 拆分 agent-pool.ts

**Description:** 从 agent-pool.ts 提取 pi-runner.ts（子进程管理）和 jsonl-parser.ts（JSONL 解析），agent-pool.ts 只保留并发调度。

**Tasks:** Task 5

**Files (预估):** 3 个文件（1 modify + 2 create）+ 测试更新

**Dependencies:** BG2

#### Task 5: 提取 pi-runner + jsonl-parser

**Files:**
- Modify: `src/infra/agent-pool.ts` (662 → ~200 行)
- Create: `src/infra/pi-runner.ts` (~200 行)
- Create: `src/infra/jsonl-parser.ts` (~150 行)

**提取边界：**

| 留在 agent-pool.ts | 提取到 pi-runner.ts | 提取到 jsonl-parser.ts |
|-------------------|--------------------|-----------------------|
| AgentPool class | `runPiProcess()` | `ParsedPipelineEvent` 接口 |
| `enqueue()` | `spawnAndParse()` | `processJsonlEvent()` |
| `drain()` | `buildArgs()` | `makeEmptyPipeline()` |
| `run()` (调用 pi-runner) | `resolveInvocation()` | — |
| SOFT_MAX_AGENTS_WARNING | — | — |
| `AgentPoolOptions` | — | — |
| `AgentResult` interface | — | — |
| `AgentUsage` interface | — | — |

**Interface contract:**

pi-runner.ts export:
```typescript
export function runAgentProcess(
  command: string, args: string[], pipeline: ParsedPipelineEvent,
  signal?: AbortSignal, env?: Record<string, string>,
): Promise<{ exitCode: number; stderr: string }>
```

jsonl-parser.ts export:
```typescript
export interface ParsedPipelineEvent { ... }
export function makeEmptyPipeline(): ParsedPipelineEvent
export function processJsonlEvent(event: Record<string, unknown>, pipeline: ParsedPipelineEvent): void
```

- [ ] **Step 1:** 创建 `src/infra/jsonl-parser.ts`
  - 从 agent-pool.ts 提取 `ParsedPipelineEvent`、`makeEmptyPipeline`、`processJsonlEvent`
  - 这些是纯函数，不依赖任何 agent-pool 状态

- [ ] **Step 2:** 创建 `src/infra/pi-runner.ts`
  - 从 agent-pool.ts 提取 `runPiProcess`、`buildArgs`、`resolveInvocation`
  - pi-runner 调用 jsonl-parser 的 `processJsonlEvent`
  - import: `node:child_process`, `node:fs`, `"./jsonl-parser.js"`, `"../domain/state.js"`

- [ ] **Step 3:** 缩小 `src/infra/agent-pool.ts`
  - 删除已提取的函数
  - `run()` 方法调用 `runAgentProcess()` 替代内联的 spawn 逻辑
  - import: `"./pi-runner.js"`, `"../domain/state.js"`

- [ ] **Step 4:** 更新测试
  - `tests/agent-pool.test.ts` → 不变（通过 AgentPool 接口测试，不感知内部拆分）
  - 可选：为 jsonl-parser.ts 和 pi-runner.ts 添加独立的单元测试

- [ ] **Step 5:** 验证
```bash
npx tsc --noEmit && npx vitest run
```

- [ ] **Step 6:** Commit
```bash
git add -A && git commit -m "refactor: extract pi-runner and jsonl-parser from agent-pool"
```

---

### BG4: 拆分 orchestrator.ts + 提取 state-store

**Description:** 从 orchestrator.ts 提取 worker-manager.ts、agent-executor.ts、state-store.ts。

**Tasks:** Task 6, Task 7

**Dependencies:** BG3

#### Task 6: 提取 state-store.ts

**Files:**
- Create: `src/infra/state-store.ts` (~100 行)
- Modify: `src/engine/orchestrator.ts`（删除 persistState + reconstructState）
- Modify: `src/index.ts`（删除 reconstructState）

**提取内容：**

state-store.ts 从两个来源合并：
1. `orchestrator.ts` 的 `persistState()` 方法
2. `index.ts` 的 `reconstructState()` 函数

```typescript
// state-store.ts interface
export async function saveInstance(
  pi: ExtensionAPI, sessionDir: string, instance: WorkflowInstance
): Promise<void>

export async function loadInstances(
  ctx: ExtensionContext
): Promise<Map<string, WorkflowInstance>>
```

**关键变更：** `saveInstance` 使用 **rewrite** 模式（`writeFile` 而非 `appendFile`），修复 GC 问题。

- [ ] **Step 1:** 创建 `src/infra/state-store.ts`
- [ ] **Step 2:** 更新 orchestrator.ts 的 persistState 改为调用 state-store
- [ ] **Step 3:** 更新 index.ts 的 reconstructState 改为调用 state-store
- [ ] **Step 4:** 验证
```bash
npx tsc --noEmit && npx vitest run
```
- [ ] **Step 5:** Commit
```bash
git add -A && git commit -m "refactor: extract state-store with rewrite persistence"
```

#### Task 7: 提取 worker-manager.ts + agent-executor.ts

**Files:**
- Create: `src/engine/worker-manager.ts` (~200 行)
- Create: `src/engine/agent-executor.ts` (~250 行)
- Modify: `src/engine/orchestrator.ts` (986 → ~400 行)

**提取边界：**

worker-manager.ts:
| 提取的方法 | 说明 |
|-----------|------|
| `startWorker()` | 创建 Worker + 绑定事件 |
| `terminateWorker()` | 终止 Worker + abort agent subprocess |
| `postMessage()` | 向 Worker 发消息 |
| `handleWorkerExit()` | Worker 退出处理 |
| `handleWorkerError()` | Worker 错误处理 |
| `recreateRunAbortController()` | 重建 AbortController |

agent-executor.ts:
| 提取的方法 | 说明 |
|-----------|------|
| `handleAgentCall()` | 处理 Worker 的 agent-call 消息 |
| `executeWithRetry()` | 带重试的 agent 执行 |
| `resolveAgentOpts()` 委托 | 解析 agent 选项 |

orchestrator.ts 保留：
| 保留的方法 | 说明 |
|-----------|------|
| `run()` | 创建 instance + 委托 worker-manager + agent-executor |
| `pause()` | 状态转换 + 委托 worker-manager |
| `resume()` | 状态转换 + 委托 worker-manager |
| `abort()` | 状态转换 + 委托 worker-manager |
| `retryNode()` | 委托 agent-executor |
| `skipNode()` | 委托 agent-executor |
| `list()` | 只读查询 |
| `runAndWait()` | 轮询等待 |
| `persistState()` | 委托 state-store |

- [ ] **Step 1:** 创建 `src/engine/worker-manager.ts`
- [ ] **Step 2:** 创建 `src/engine/agent-executor.ts`
- [ ] **Step 3:** 重写 `src/engine/orchestrator.ts` 为协调者
- [ ] **Step 4:** 更新 `tests/orchestrator.test.ts`
- [ ] **Step 5:** 验证
```bash
npx tsc --noEmit && npx vitest run
```
- [ ] **Step 6:** Commit
```bash
git add -A && git commit -m "refactor: extract worker-manager and agent-executor from orchestrator"
```

---

### BG5: 拆分 index.ts + 重写为工厂

**Description:** 从 index.ts 提取三个 tool 模块，index.ts 缩小为纯工厂胶水。

**Tasks:** Task 8

**Files (预估):** 4 个文件（1 modify + 3 create）

**Dependencies:** BG4

#### Task 8: 提取 tool-workflow + tool-workflow-run + tool-lint

**Files:**
- Create: `src/interface/tool-workflow.ts` (~200 行)
- Create: `src/interface/tool-workflow-run.ts` (~200 行)
- Create: `src/interface/tool-lint.ts` (~40 行)
- Modify: `src/index.ts` (826 → ~150 行)

**提取边界：**

tool-workflow.ts 从 index.ts 提取：
- `WorkflowParams` schema
- `buildRender()` helper
- `toInstanceSummary()` helper
- `InstanceSummary` / `WorkflowDetails` interface
- workflow tool 的 `execute` + `renderCall` + `renderResult`
- 所有 pause/resume/abort/status 分支逻辑

tool-workflow-run.ts 从 index.ts 提取：
- `_WorkflowRunParams` schema
- `_WorkflowRunDetails` interface
- `registerWorkflowRunTool()` 函数整体
- 模糊搜索 + confirm + 启动逻辑

tool-lint.ts 从 index.ts 提取：
- `registerWorkflowLintTool()` 函数

index.ts 只保留：
- 3 个事件处理器（session_start / session_tree / session_shutdown）
- 调用 `registerWorkflowTool()`, `registerWorkflowRunTool()`, `registerLintTool()`, `registerWorkflowCommands()`, `registerGenerateTool()`
- `pi.__workflowRun` 暴露
- tool_call 事件监听（workflow-generate skill 注入）

- [ ] **Step 1:** 创建 `src/interface/tool-workflow.ts`
- [ ] **Step 2:** 创建 `src/interface/tool-workflow-run.ts`
- [ ] **Step 3:** 创建 `src/interface/tool-lint.ts`
- [ ] **Step 4:** 重写 `src/index.ts` 为薄工厂
- [ ] **Step 5:** 更新 `tests/index.test.ts`
- [ ] **Step 6:** 验证
```bash
npx tsc --noEmit && npx vitest run
```
- [ ] **Step 7:** Commit
```bash
git add -A && git commit -m "refactor: extract tool modules, index.ts becomes thin factory"
```

**里程碑验证：** 此时所有文件已到位，所有拆分完成。运行全量验证：
```bash
npx tsc --noEmit && npx vitest run && echo "✅ Phase 2 complete: all splits done"
```

---

### BG6: 修复持久化 GC + 统一错误处理

**Description:** 两个行为变更：(1) state-store 改为 rewrite 模式 (2) tool execute 去除三层降级。

**Tasks:** Task 9, Task 10

**Dependencies:** BG5

#### Task 9: 确认 state-store rewrite 模式

**Files:**
- Modify: `src/infra/state-store.ts`

此任务在 BG4 Task 6 中已创建 state-store.ts 时直接使用 rewrite 模式。此步骤是验证确认。

- [ ] **Step 1:** 确认 `saveInstance` 使用 `writeFile`（覆盖），而非 `appendFile`
- [ ] **Step 2:** 确认 `loadInstances` 只读最后一行（而非遍历所有行）
- [ ] **Step 3:** 同步修复 `src/infra/execution-trace.ts` — `appendTraceNode` 改为 rewrite 模式
- [ ] **Step 4:** 验证
```bash
npx tsc --noEmit && npx vitest run
```
- [ ] **Step 5:** Commit
```bash
git add -A && git commit -m "fix: rewrite-mode persistence for state and trace (GC fix)"
```

#### Task 10: 简化 tool-workflow 错误处理

**Files:**
- Modify: `src/interface/tool-workflow.ts`
- Modify: `src/engine/orchestrator.ts`（pause/resume/abort 内化幂等）

**变更内容：**

orchestrator.ts 的 pause/resume/abort 方法内化幂等检查：
```typescript
async pause(runId: string): Promise<void> {
  const instance = this.instances.get(runId);
  if (!instance) throw new Error(`not found`);
  // 幂等：已经是 paused → 直接返回成功
  if (instance.status === "paused") return;
  if (instance.status !== "running") throw new Error(`invalid transition`);
  // ... 实际 pause 逻辑
}
```

tool-workflow.ts 的 execute 去除三层降级，改为单路径：
```typescript
case "pause": {
  try {
    await orch.pause(runId);
    return success response;
  } catch (e) {
    return error response;
  }
}
```

- [ ] **Step 1:** 更新 orchestrator pause/resume/abort 内化幂等
- [ ] **Step 2:** 简化 tool-workflow execute 去除 fallback
- [ ] **Step 3:** 验证
```bash
npx tsc --noEmit && npx vitest run
```
- [ ] **Step 4:** Commit
```bash
git add -A && git commit -m "refactor: simplify error handling, internalize idempotency"
```

---

### BG7: 测试修复 + 全量验证

**Description:** 修复所有因重构产生的测试问题，运行全量验证套件。

**Tasks:** Task 11

**Dependencies:** BG6

#### Task 11: 全量验证

**Files:**
- 可能需要更新: 所有 test 文件的 import 路径

- [ ] **Step 1:** 全量 typecheck
```bash
npx tsc --noEmit
```

- [ ] **Step 2:** 全量测试
```bash
npx vitest run
```

- [ ] **Step 3:** 全量 lint
```bash
pnpm --filter @zhushanwen/pi-workflow lint
```

- [ ] **Step 4:** 行数验证 — 确认三个大文件已缩小
```bash
wc -l src/index.ts src/engine/orchestrator.ts src/infra/agent-pool.ts
```
Expected: index.ts < 200, orchestrator.ts < 500, agent-pool.ts < 250

- [ ] **Step 5:** 结构验证 — 确认目录结构符合四层模型
```bash
find src -name '*.ts' ! -path '*__tests__*' | sort
```
Expected: 与 "目标目录结构" 一致

- [ ] **Step 6:** 运行 pre-commit hook（完整质量检查）
```bash
bash .githooks/pre-commit
```

- [ ] **Step 7:** 最终 commit + push
```bash
git add -A
git commit -m "refactor: complete workflow extension 4-layer architecture"
git push
```

---

## 依赖图 & Wave 编排

```
BG0 (准备) ──→ BG1 (domain+infra 移动) ──→ BG2 (engine+interface 移动) ──→ BG3 (拆 agent-pool)
                    │                              │
                    └──────────────────────────────┘
                                                          │
                                                          ↓
                                                BG4 (拆 orchestrator + state-store)
                                                          │
                                                          ↓
                                                BG5 (拆 index.ts)
                                                          │
                                                          ↓
                                                BG6 (GC + 错误处理)
                                                          │
                                                          ↓
                                                BG7 (全量验证)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 0 | BG0 | 准备：创建目录 + 删除死代码 |
| Wave 1 | BG1 | Domain + Infra 文件移动（纯 move，无逻辑变更） |
| Wave 2 | BG2 | Engine + Interface 文件移动（纯 move，无逻辑变更） |
| Wave 3 | BG3 | 拆分 agent-pool.ts（逻辑提取，行为不变） |
| Wave 4 | BG4 | 拆分 orchestrator.ts + 提取 state-store |
| Wave 5 | BG5 | 拆分 index.ts 为工厂 + 三个 tool 模块 |
| Wave 6 | BG6 | 行为变更：GC 修复 + 错误处理简化 |
| Wave 7 | BG7 | 全量验证 + commit |

## Spec Metrics Traceability

| 指标 | 采纳状态 | 对应 Task |
|------|---------|----------|
| index.ts ≤ 200 行 | adopted | Task 8 |
| orchestrator.ts ≤ 500 行 | adopted | Task 7 |
| agent-pool.ts ≤ 250 行 | adopted | Task 5 |
| 持久化 rewrite 模式 | adopted | Task 9 |
| 删除 budget.ts 死代码 | adopted | Task 0 |
| 错误处理无三层降级 | adopted | Task 10 |

## Interface Contracts

### Module: src/domain/state.ts

#### Functions

| Method | Signature | Returns | Edge Cases | Ref |
|--------|-----------|---------|------------|-----|
| transitionStatus | (instance, to: WorkflowStatus) → WorkflowStatus | WorkflowStatus | invalid transition → throws | — |
| isTerminal | (status) → boolean | boolean | — | — |
| serializeInstance | (instance) → SerializedWorkflowInstance | Serialized | — | — |
| deserializeInstance | (data) → WorkflowInstance | WorkflowInstance | missing fields → defaults, "created" → "running" | — |

### Module: src/infra/state-store.ts

#### Functions

| Method | Signature | Returns | Edge Cases | Ref |
|--------|-----------|---------|------------|-----|
| saveInstance | (pi, sessionDir, instance) → Promise\<void\> | void | file not writable → throws | Task 6 |
| loadInstances | (ctx) → Promise\<Map\<string, WorkflowInstance\>\> | Map | corrupt JSONL → state_lost placeholder | Task 6 |

### Module: src/engine/worker-manager.ts

#### Functions

| Method | Signature | Returns | Edge Cases | Ref |
|--------|-----------|---------|------------|-----|
| start | (runId, instance, script, args) → void | void | — | Task 7 |
| terminate | (runId) → void | void | already terminated → no-op | Task 7 |
| postMessage | (runId, msg) → void | void | worker not found → no-op | Task 7 |

### Module: src/engine/agent-executor.ts

#### Functions

| Method | Signature | Returns | Edge Cases | Ref |
|--------|-----------|---------|------------|-----|
| execute | (runId, callId, opts, instance) → Promise\<void\> | void | pool missing → skip | Task 7 |
| retryNode | (runId, callId) → Promise\<void\> | void | — | Task 7 |
| skipNode | (runId, callId) → Promise\<void\> | void | — | Task 7 |

### Module: src/interface/tool-workflow.ts

#### Functions

| Method | Signature | Returns | Edge Cases | Ref |
|--------|-----------|---------|------------|-----|
| registerWorkflowTool | (pi, orchestrators, guard) → void | void | — | Task 8 |

### Module: src/interface/tool-workflow-run.ts

#### Functions

| Method | Signature | Returns | Edge Cases | Ref |
|--------|-----------|---------|------------|-----|
| registerWorkflowRunTool | (pi, orchestrators, state, approvals, ref, guard) → void | void | — | Task 8 |

### Module: src/interface/tool-lint.ts

#### Functions

| Method | Signature | Returns | Edge Cases | Ref |
|--------|-----------|---------|------------|-----|
| registerLintTool | (pi) → void | void | — | Task 8 |

## Non-functional Design

### 稳定性

重构为纯结构变更 + 两处行为变更（GC + 错误处理）。每个 Wave 都有独立 typecheck + test 验证。行为不变的部分（文件移动、逻辑提取）通过测试覆盖保证不引入 regression。行为变更的部分（GC rewrite、错误处理简化）有独立 commit，可 bisect。

### 数据一致性

state-store 改为 rewrite 模式后，每次持久化只写入最新快照。并发写入风险：当前 orchestrator 是 per-session 单例，不存在并发写同一 JSONL 文件的场景。pause/resume 期间的 Worker 退出和 state 写入有时序依赖，已在 orchestrator 的 "set status before terminate" 模式中处理。

### 性能

reconstructState 从 O(N×M)（N 个 entries × M 个 JSONL 行）降为 O(N)（N 个 pointer entries，每个只读 1 行最新状态）。JSONL 解析从 agent-pool 内联变为独立模块，无性能影响（函数调用开销可忽略）。

### 业务安全

无新功能引入，纯重构。workflow 脚本执行链路（Worker → agent-call → pi 子进程 → JSONL → result）不变。

### 数据安全

无敏感数据处理变更。临时文件（agent system prompt）的创建/清理逻辑不变。
