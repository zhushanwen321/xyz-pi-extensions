---
verdict: pass
complexity: L1
---

# Workflow Fullscreen TUI View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing workflow widget (setWidget + overlay + 3 shortcuts) with a single fullscreen TUI view that provides real-time phases navigation, structured Activity (toolCalls), and in-view workflow control.

**Architecture:** agent-pool.ts 收集 JSONL 流中的 tool_execution_start 事件到 `toolCalls[]`，通过 state.ts 的 `AgentResult` 传递到 orchestrator trace 节点。新文件 `orchestrator-events.ts` 提供 subscribe/unsubscribe API，orchestrator 在状态转换和 trace 更新时 emit 事件。`WorkflowsView.ts` 订阅事件、构建双栏布局（sidebar phases 树 + main 节点详情），通过 `ctx.ui.custom()` 接管 TUI。widget.ts 及其 setWidget/shortcut 注册全部删除。

**Tech Stack:** TypeScript, Pi Extension API (`ctx.ui.custom()`), pi-tui (`Text`, `Container`, `SelectList`), vitest

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `extensions/workflow/src/agent-pool.ts` | modify | BG1 | 新增 `ToolCallEntry` 类型，`AgentResult` 加 `toolCalls`，`processJsonlEvent` 收集所有 tool call |
| `extensions/workflow/src/state.ts` | modify | BG1 | `AgentResult` 加 `toolCalls` 字段，序列化/反序列化自动覆盖 |
| `extensions/workflow/src/orchestrator.ts` | modify | BG2 | 加 `toolCalls` 映射 + emit 事件调用点 |
| `extensions/workflow/src/orchestrator-events.ts` | create | BG2 | 订阅 API：subscribe/unsubscribe/tick 管理 |
| `extensions/workflow/src/views/WorkflowsView.ts` | create | BG3 | 全屏视图组件：header/sidebar/main/footer + 键盘处理 |
| `extensions/workflow/src/index.ts` | modify | BG3 | 删除 setWidget/shortcut 引用，更新 /workflows 命令 |
| `extensions/workflow/src/widget.ts` | delete | BG3 | 全部删除 |
| `extensions/workflow/src/__tests__/orchestrator-events.test.ts` | create | BG4 | 订阅计数、tick 间隔、listener 异常隔离 |
| `extensions/workflow/src/__tests__/workflows-view.test.ts` | create | BG4 | phase 分组、sidebar truncate、prompt/activity 折叠 |

---

## Interface Contracts

### Module: agent-pool

#### Type: ToolCallEntry

| Field | Type | Description |
|-------|------|-------------|
| name | `string` | Tool name from JSONL event.toolName (e.g. "Bash", "Skill", "Read") |
| input | `string` | Serialized args preview. For Bash: event.args.command; for others: JSON.stringify(event.args).slice(0, 200) |

#### Type: AgentResult (existing, extended)

| Field | Type | Description |
|-------|------|-------------|
| toolCalls | `ToolCallEntry[]` | All tool calls collected from JSONL stream. Default: `[]` |

### Module: state

#### Type: AgentResult (existing, extended)

| Field | Type | Description |
|-------|------|-------------|
| toolCalls | `ToolCallEntry[]` | Mirrored from agent-pool AgentResult via orchestrator mapping. Default: `[]` |

#### Type: ToolCallEntry

| Field | Type | Description |
|-------|------|-------------|
| name | `string` | Tool name |
| input | `string` | Args preview string |

### Module: orchestrator-events

#### Class: WorkflowEventEmitter

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| subscribe | `(runId: string, listener: (event: WorkflowEvent) => void) => () => void` | unsubscribe function | listener throws → catch + console.error | AC-15 |
| getSubscriptionCount | `(runId: string) => number` | number | No subscriptions → 0 | AC-16 |
| emit | `(runId: string, event: WorkflowEvent) => void` | void | No subscribers → no-op | FR-5.5 |

#### Type: WorkflowEvent

| Field | Type | Description |
|-------|------|-------------|
| type | `"status" \| "trace" \| "node-update" \| "tick"` | Event discriminator |
| status? | `WorkflowStatus` | For type="status" |
| node? | `ExecutionTraceNode` | For type="trace"/"node-update" |
| stepIndex? | `number` | For type="node-update" |
| now? | `number` | For type="tick" (Date.now()) |

### Module: views/WorkflowsView (pure functions exported for testing)

| Function | Signature | Returns | Edge Cases | Spec Ref |
|----------|-----------|---------|------------|----------|
| groupByPhase | `(nodes: ExecutionTraceNode[]) => Map<string, ExecutionTraceNode[]>` | Map | Empty trace → empty Map; no phase → "(no phase)" group | AC-7 |
| formatSidebarNode | `(node: ExecutionTraceNode, selected: boolean, width: number) => string` | string | Width < 10 → truncate aggressively | AC-9 |
| formatActivityLine | `(entry: ToolCallEntry, maxWidth: number) => string` | string | maxWidh < 10 → name only | AC-13 |
| formatElapsed | `(startedAt?: string, now: number) => string` | string | startedAt undefined → "-" | AC-4 |
| formatTokenStat | `(usage?: AgentUsage, toolCalls?: ToolCallEntry[]) => string` | string | Both undefined → "0 tok · 0 tool calls" | AC-11 |

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 | commands.ts SelectList | /workflows → select → custom() | Task 3 |
| AC-2 | commands.ts direct entry | /workflows <id> → custom() | Task 3 |
| AC-3 | WorkflowsView esc handler | esc → ctx.ui.custom(null) | Task 3 |
| AC-4 | formatElapsed | startedAt → elapsed string | Task 3 |
| AC-5 | formatSidebarNode | node → 24-col string | Task 3 |
| AC-6 | WorkflowsView render | sidebar + │ + main | Task 3 |
| AC-7 | groupByPhase | nodes → Map<phase, nodes> | Task 3 |
| AC-8 | WorkflowsView ↑↓ handler | selected node change → main re-render | Task 3 |
| AC-9 | formatSidebarNode | node + ● color | Task 3 |
| AC-10 | WorkflowsView context title | phaseName · N agent | Task 3 |
| AC-11 | formatTokenStat | usage + toolCalls → stat string | Task 1, 3 |
| AC-12 | WorkflowsView prompt fold | task lines > 20 → fold with … | Task 3 |
| AC-13 | formatActivityLine | toolCall → Tool(args) | Task 1, 3 |
| AC-14 | WorkflowsView 👉 handler | toggle prompt expand | Task 3 |
| AC-15 | WorkflowEventEmitter.subscribe | open → subscribe, close → unsubscribe | Task 2 |
| AC-16 | WorkflowEventEmitter tick | subscription count → interval lifecycle | Task 2 |
| AC-17 | WorkflowsView x handler | confirm → orchestrator.abort | Task 3 |
| AC-18 | WorkflowsView x handler | terminal check → notify | Task 3 |
| AC-19 | WorkflowsView s handler | fs.writeFile trace markdown | Task 3 |
| AC-20 | WorkflowsView footer render | view state → conditional shortcuts | Task 3 |
| AC-21 | index.ts + widget.ts | grep verify no imports | Task 3 |
| AC-22 | index.ts | grep verify no shortcuts | Task 3 |
| AC-23 | state.ts + agent-pool.ts | tsc --noEmit | Task 1 |
| AC-24 | WorkflowsView render | line width ≤ terminal width | Task 3 |

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 /workflows SelectList | adopted | Task 3 |
| AC-2 /workflows <runId> direct | adopted | Task 3 |
| AC-3 esc 关闭 | adopted | Task 3 |
| AC-4 header 两行 + elapsed | adopted | Task 3 |
| AC-5 sidebar 24 列格式 | adopted | Task 3 |
| AC-6 双栏 │ 拼接 | adopted | Task 3 |
| AC-7 (no phase) 兜底组 | adopted | Task 3 |
| AC-8 ↓ 导航 | adopted | Task 3 |
| AC-9 sidebar ● 状态色 | adopted | Task 3 |
| AC-10 context title | adopted | Task 3 |
| AC-11 tok · tool calls 统计 | adopted | Task 1, 3 |
| AC-12 prompt … 折叠 | adopted | Task 3 |
| AC-13 Activity 结构化列表 | adopted | Task 1, 3 |
| AC-14 👉 展开 prompt | adopted | Task 3 |
| AC-15 subscribe/unsubscribe | adopted | Task 2 |
| AC-16 tick interval 清理 | adopted | Task 2 |
| AC-17 x abort + confirm | adopted | Task 3 |
| AC-18 terminal 状态 notify | adopted | Task 3 |
| AC-19 s save trace | adopted | Task 3 |
| AC-20 footer 条件快捷键 | adopted | Task 3 |
| AC-21 widget.ts 删除 | adopted | Task 3 |
| AC-22 shortcut 删除 | adopted | Task 3 |
| AC-23 toolCalls 类型 | adopted | Task 1 |
| AC-24 80×24 不溢出 | adopted | Task 3 |

---

## Task List

### Task 1: Agent-pool & State 数据增强 (FR-7)

**Type:** backend

**Files:**
- Modify: `extensions/workflow/src/agent-pool.ts`
- Modify: `extensions/workflow/src/state.ts`
- Modify: `extensions/workflow/src/orchestrator.ts` (仅 toolCalls 映射)

**Description:**
在 agent-pool.ts 的 JSONL 解析管线中收集所有 tool_execution_start 事件到 `toolCalls[]`。在 state.ts 的 AgentResult 中新增对应字段。在 orchestrator.ts 的 executeWithRetry 中完成 pool result → state result 的 toolCalls 映射。

**Interface Changes:**

1. `agent-pool.ts`: 新增 `ToolCallEntry = { name: string; input: string }` 导出类型。`AgentResult` 新增 `toolCalls: ToolCallEntry[]`。`ParsedPipelineEvent` 新增 `toolCalls: ToolCallEntry[]`。`processJsonlEvent` 在 `tool_execution_start` 分支（非仅 structured-output）追加 `{ name: event.toolName, input: serializeArgs(event.args) }`。`spawnAndParse` 返回时映射 `pipeline.toolCalls`。

2. `state.ts`: 新增 `ToolCallEntry = { name: string; input: string }` 导出类型（独立定义，不 import agent-pool 以避免循环依赖）。`AgentResult` 新增 `toolCalls?: ToolCallEntry[]`。

3. `orchestrator.ts` `executeWithRetry` (~line 747): 映射 `toolCalls: poolResult.toolCalls`。

**Serialization Notes:** `toolCalls` 是 `Array<{ name: string; input: string }>`，纯 JSON 可序列化，state.ts 的 serialize/deserialize 自动覆盖。

**Edge Cases:**
- `toolCalls` 为空数组（agent 未调用任何工具）→ 渲染时显示 "(no tool calls yet)"
- `event.args` 为 null/undefined → input 序列化为 "(no args)"
- Bash tool 的 args 是 `{ command: string }` → input 取 `event.args.command`

- [ ] Step 1: agent-pool.ts — 新增 ToolCallEntry 类型，AgentResult 加 toolCalls，ParsedPipelineEvent 加 toolCalls，processJsonlEvent 收集，spawnAndParse 映射
- [ ] Step 2: state.ts — 新增 ToolCallEntry 类型，AgentResult 加 toolCalls
- [ ] Step 3: orchestrator.ts — executeWithRetry 映射 toolCalls，stale context 分支也映射
- [ ] Step 4: `npx tsc --noEmit` 通过
- [ ] Step 5: Commit: `feat(workflow): add toolCalls to AgentResult for structured Activity`

---

### Task 2: Orchestrator Events 订阅 API (FR-5)

**Type:** backend

**Depends on:** Task 1

**Files:**
- Create: `extensions/workflow/src/orchestrator-events.ts`
- Modify: `extensions/workflow/src/orchestrator.ts` (emit 调用点)

**Description:**
新增 `orchestrator-events.ts`，提供 `WorkflowEventEmitter` 类，管理 per-runId 订阅者列表和 tick interval。在 orchestrator.ts 的状态转换点和 trace 更新点插入 emit 调用。

**Interface Changes:**

`orchestrator-events.ts` 导出 `WorkflowEventEmitter` 类：
- `subscribe(runId, listener) => unsubscribe`: 注册监听器，首次订阅启动 tick interval
- `getSubscriptionCount(runId)`: 返回订阅者数量
- `emit(runId, event)`: 同步调用所有 listener，异常 catch + console.error
- tick interval: `setInterval(1000ms)`, 仅当 `totalSubscriptionCount > 0` 时运行，降为 0 时 `clearInterval`

`orchestrator.ts` 改动：
- 新增 `public readonly events = new WorkflowEventEmitter()` 属性
- `transitionStatus()` 后调 `this.events.emit(runId, { type: "status", status })`
- `appendTraceNode()` 后调 `this.events.emit(runId, { type: "trace", node })`
- `executeWithRetry` trace node 更新后调 `this.events.emit(runId, { type: "node-update", stepIndex, node })`

**Edge Cases:**
- listener 抛异常 → catch 吞掉，不影响其他 listener 或 orchestrator
- 订阅 runId 不存在 → subscribe 仍成功，emit 时自然 no-op
- tick interval 泄漏 → getSubscriptionCount 归零时必须 clear

- [ ] Step 1: 创建 orchestrator-events.ts（WorkflowEventEmitter 类）
- [ ] Step 2: orchestrator.ts — 实例化 emitter，在 transitionStatus/appendTraceNode/executeWithRetry 处加 emit
- [ ] Step 3: `npx tsc --noEmit` 通过
- [ ] Step 4: Commit: `feat(workflow): add orchestrator event subscription API`

---

### Task 3: 全屏视图 + 命令集成 (FR-1,2,3,4,6,8)

**Type:** backend

**Depends on:** Task 1, Task 2

**Files:**
- Create: `extensions/workflow/src/views/WorkflowsView.ts`
- Modify: `extensions/workflow/src/index.ts`
- Delete: `extensions/workflow/src/widget.ts`

**Description:**
实现全屏 TUI 视图组件，替代现有 widget。视图通过 `ctx.ui.custom()` 接管整个 TUI 渲染区。更新 /workflows 命令入口。删除 widget.ts 及所有 setWidget/shortcut 注册。

**View Architecture:**

```
┌──────────────────────────────────────────────────────────────┐
│ <name> (bold)                                                 │
│ <description> (muted)                    N/M agents · <elapsed> │
│──────────────────────────────────────────────────────────────│
│ Phases         │ <context title: phaseName · N agent>          │
│ ❯ 1 Ph1 0/2   │ <node title: agentName> (bold)                │
│   2 Ph2 0/1   │ ● <Status> · <model>                          │
│                │ <N> tok · <M> tool calls                      │
│                │                                                │
│                │ Prompt · <N> lines · 👉 expand                │
│                │   <preview...>                                │
│                │                                                │
│                │ Activity                                      │
│                │   ToolName(argsPreview)                        │
│                │                                                │
│                │ Outcome                                       │
│                │   Still running...                            │
│                │                                                │
├──────────────────────────────────────────────────────────────┤
│ ↑↓ agent · 👉 prompt · x stop · r restart · p pause · ...    │
└──────────────────────────────────────────────────────────────┘
```

**Key Implementation Points:**

1. **WorkflowsView.ts** (~400 行上限):
   - 工厂函数 `createWorkflowsView(orchestrator, runId, theme, ctx)` → 返回 `Component`
   - 纯函数提取到顶层导出（供测试）：`groupByPhase`, `formatSidebarNode`, `formatActivityLine`, `formatElapsed`, `formatTokenStat`
   - `ctx.ui.custom()` 接受 Component，组件内部 `onKeyEvent` 处理键盘
   - 订阅 `orchestrator.events.subscribe(runId, listener)`，listener 调 `component.invalidate()` 触发重渲染
   - esc → `ctx.ui.custom(null)` 关闭视图 + `unsubscribe()`
   - `s` → `fs.promises.writeFile` 保存 trace markdown 到 `~/.pi/agent/workflow-traces/<runId>.md`

2. **index.ts 改动**:
   - 删除 `import { registerWorkflowShortcuts, renderWorkflowList } from "./widget.js"`
   - 删除 `orch.onTraceUpdate` 中的 `setWidget` 调用
   - 删除 `registerWorkflowShortcuts(pi, orchestrators, cmdState)` 调用
   - 更新 `/workflows` 命令 handler：有 runId 参数时 `ctx.ui.custom(createWorkflowsView(...))`，无参数时 SelectList 选择后 `ctx.ui.custom(...)`

3. **widget.ts 删除**:
   - 确认无其他文件 import widget.ts（grep 验证）
   - 删除文件

**Footer 快捷键逻辑 (FR-2.5):**
- 概览视图（selectedPhaseIndex >= 0 && selectedNodeIndex < 0）: `↑↓ select · x stop workflow · p pause · esc back · s save`
- 节点详情视图（selectedNodeIndex >= 0）: `↑↓ agent · 👉 prompt · x stop · r restart · p pause · esc back · s save`

**键盘处理:**
- `↑/↓`: sidebar 节点间切换（跨 phase）
- `👉` (shift+i 或专用键): toggle prompt expand
- `x`: confirm → abort
- `r`: confirm → run (仅节点详情视图)
- `p`: confirm → pause/resume
- `s`: save trace to file
- `esc`: close view

**Color Mapping (FR-4.1):**
- pending: `theme.fg("muted", "●")`
- running: `theme.fg("warning", "●")`
- completed: `theme.fg("success", "●")`
- failed: `theme.fg("error", "●")`

- [ ] Step 1: 创建 `views/WorkflowsView.ts`（纯函数 + 工厂函数 + 键盘处理 + 订阅）
- [ ] Step 2: 更新 `index.ts`（删除 widget 引用，更新 /workflows 命令）
- [ ] Step 3: 删除 `widget.ts`，grep 确认无残留 import
- [ ] Step 4: `npx tsc --noEmit` 通过
- [ ] Step 5: `pnpm --filter @zhushanwen/pi-workflow lint` 通过
- [ ] Step 6: Commit: `feat(workflow): replace widget with fullscreen TUI view`

---

### Task 4: 测试 (C-13, C-14)

**Type:** backend

**Depends on:** Task 2, Task 3

**Files:**
- Create: `extensions/workflow/src/__tests__/orchestrator-events.test.ts`
- Create: `extensions/workflow/src/__tests__/workflows-view.test.ts`

**Description:**
为 orchestrator-events 和 WorkflowsView 纯函数编写 vitest 测试。

**Test Cases:**

`orchestrator-events.test.ts`:
- subscribe 后 emit 触发 listener
- unsubscribe 后 emit 不触发
- 多个 listener 独立触发
- listener 抛异常不影响其他 listener 和 emit 返回
- tick interval 在首次 subscribe 时启动
- tick interval 在最后一次 unsubscribe 时清除（vi.useFakeTimers + vi.advanceTimersByTime）
- getSubscriptionCount 返回正确值

`workflows-view.test.ts`:
- groupByPhase: 按 phase 分组，无 phase 归入 "(no phase)"
- groupByPhase: 空数组返回空 Map
- formatSidebarNode: 选中节点有 ❯ 前缀，宽度截断
- formatSidebarNode: ● 颜色按状态映射
- formatActivityLine: `ToolName(args)` 格式
- formatActivityLine: args 超长截断
- formatElapsed: 有 startedAt 计算秒数
- formatElapsed: 无 startedAt 返回 "-"
- formatTokenStat: 有 usage 和 toolCalls 显示正确
- formatTokenStat: 无 usage 显示 "0 tok"

- [ ] Step 1: 创建 `__tests__/orchestrator-events.test.ts`
- [ ] Step 2: 创建 `__tests__/workflows-view.test.ts`
- [ ] Step 3: `npx vitest run` 通过
- [ ] Step 4: Commit: `test(workflow): add orchestrator-events and view tests`

---

## Execution Groups

#### BG1: 数据增强

**Description:** Agent-pool JSONL 解析管线收集 toolCalls，state 类型扩展，orchestrator 映射。

**Tasks:** Task 1

**Files (预估):** 3 个 modify

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| 注入上下文 | spec FR-7, agent-pool.ts processJsonlEvent 函数, state.ts AgentResult 类型, orchestrator.ts executeWithRetry 映射段 |
| 读取文件 | `extensions/workflow/src/agent-pool.ts`, `extensions/workflow/src/state.ts`, `extensions/workflow/src/orchestrator.ts` |
| 修改文件 | 同上 |

**Dependencies:** 无

#### BG2: 事件系统

**Description:** 新增 orchestrator-events.ts 订阅 API，orchestrator 加 emit 调用点。

**Tasks:** Task 2

**Files (预估):** 1 create + 1 modify

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| 注入上下文 | spec FR-5, orchestrator.ts transitionStatus/appendTraceNode/executeWithRetry 调用位置 |
| 读取文件 | `extensions/workflow/src/orchestrator.ts`, `extensions/workflow/src/state.ts` |
| 创建文件 | `extensions/workflow/src/orchestrator-events.ts` |
| 修改文件 | `extensions/workflow/src/orchestrator.ts` |

**Dependencies:** BG1

#### BG3: 视图 + 集成

**Description:** 全屏视图组件实现，命令入口更新，旧 widget 删除。

**Tasks:** Task 3

**Files (预估):** 1 create + 1 modify + 1 delete

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| 注入上下文 | spec FR-1/2/3/4/6/8, TUI 截图 ASCII 还原, pi-tui API, ctx.ui.custom() 用法 |
| 读取文件 | `extensions/workflow/src/index.ts`, `extensions/workflow/src/widget.ts`, `extensions/workflow/src/orchestrator.ts`, `extensions/workflow/src/state.ts` |
| 创建文件 | `extensions/workflow/src/views/WorkflowsView.ts` |
| 修改文件 | `extensions/workflow/src/index.ts` |
| 删除文件 | `extensions/workflow/src/widget.ts` |

**Dependencies:** BG1, BG2

#### BG4: 测试

**Description:** orchestrator-events 和 WorkflowsView 纯函数测试。

**Tasks:** Task 4

**Files (预估):** 2 create

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| 注入上下文 | 测试框架 vitest（从 vitest 导入 describe/it/expect/vi），运行命令 npx vitest run，禁止 node:test |
| 读取文件 | `extensions/workflow/src/orchestrator-events.ts`, `extensions/workflow/src/views/WorkflowsView.ts` |
| 创建文件 | `extensions/workflow/src/__tests__/orchestrator-events.test.ts`, `extensions/workflow/src/__tests__/workflows-view.test.ts` |

**Dependencies:** BG2, BG3

---

## Dependency Graph & Wave Schedule

```
BG1 (数据增强) ──→ BG2 (事件系统) ──→ BG3 (视图+集成) ──→ BG4 (测试)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | 数据基础，无依赖 |
| Wave 2 | BG2 | 依赖 BG1 类型定义 |
| Wave 3 | BG3 | 依赖 BG1 toolCalls + BG2 events |
| Wave 4 | BG4 | 依赖 BG2 + BG3 全部完成 |

---

## Open Questions Resolution

| Q | Resolution |
|---|-----------|
| Q1 emit 同步/异步 | 同步调用（FR-5.6 已定），测试中验证无 race |
| Q2 disposed flag | 是，unsubscribe 时清理 + emit 时检查 listener 有效性 |
| Q3 sidebar 24 列中文 | visibleWidth 计算，测试中覆盖 |
| Q4 toolCalls hook 点 | `processJsonlEvent` 已处理 `tool_execution_start`，在通用路径追加即可，无需外部 hook |
| Q5 save 格式 | markdown（人类可读） |
