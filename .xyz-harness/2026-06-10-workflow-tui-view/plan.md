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
| groupByPhase | `(nodes: ExecutionTraceNode[]) => Map<string, ExecutionTraceNode[]>` | Map | Empty trace → empty Map; no phase → unnamed group (hidden from sidebar) | AC-7 |
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
| AC-14 | WorkflowsView Enter handler | toggle prompt expand | Task 3 |
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
| AC-7 single phase skip | adopted | Task 3 |
| AC-8 ↓ 导航 | adopted | Task 3 |
| AC-9 sidebar ● 状态色 | adopted | Task 3 |
| AC-10 context title | adopted | Task 3 |
| AC-11 tok · tool calls 统计 | adopted | Task 1, 3 |
| AC-12 prompt … 折叠 | adopted | Task 3 |
| AC-13 Activity 结构化列表 | adopted | Task 1, 3 |
| AC-14 Enter 展开 prompt | adopted | Task 3 |
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

1. `agent-pool.ts`: 新增 `ToolCallEntry = { name: string; input: string }` 导出类型。`AgentResult` 新增 `toolCalls: ToolCallEntry[]`（默认 `[]`）。`ParsedPipelineEvent` 新增 `toolCalls: ToolCallEntry[]`（`makeEmptyPipeline` 初始化为 `[]`）。

   `processJsonlEvent` 在 `tool_execution_start` 分支中，**在 `pipeline.hasToolCall = true` 之前**，对**所有** tool call 追加（不仅 structured-output）：
   ```typescript
   // 在 if (event.toolName === "structured-output") { ... } 之后、pipeline.hasToolCall = true 之前
   const input = typeof event.args === 'object' && event.args !== null
     ? JSON.stringify(event.args)
     : String(event.args ?? '');
   pipeline.toolCalls.push({ name: String(event.toolName ?? 'unknown'), input });
   ```
   input **完整存储，不截断**（截断由渲染层 formatActivityLine 负责，见 FR-7.3）。

   `spawnAndParse` 返回时映射 `toolCalls: pipeline.toolCalls`。

2. `state.ts`: 新增 `ToolCallEntry = { name: string; input: string }` 导出类型（独立定义，不 import agent-pool 以避免循环依赖）。`AgentResult` 新增 `toolCalls?: ToolCallEntry[]`。字段结构与 agent-pool 完全相同，orchestrator 映射时直接赋值 `toolCalls: poolResult.toolCalls`。

3. `orchestrator.ts` `executeWithRetry` (~line 747): 映射 `toolCalls: poolResult.toolCalls`。stale context 分支 (~line 755) 同样映射。

**Serialization Notes:** `toolCalls` 是 `Array<{ name: string; input: string }>`，纯 JSON 可序列化，state.ts 的 serialize/deserialize 自动覆盖。

**Edge Cases:**
- `toolCalls` 为空数组（agent 未调用任何工具）→ 渲染时显示 "(no tool calls yet)"
- `event.args` 为 null/undefined → input 序列化为空字符串
- `event.toolName` 缺失 → name 记录为 "unknown"

- [ ] Step 1: agent-pool.ts — 新增 ToolCallEntry 类型，AgentResult 加 toolCalls，ParsedPipelineEvent 加 toolCalls，makeEmptyPipeline 初始化 toolCalls=[]。processJsonlEvent 在 tool_execution_start 分支、pipeline.hasToolCall=true 之前收集所有 tool call（input 完整不截断）。spawnAndParse 返回映射 toolCalls
- [ ] Step 2: state.ts — 新增 ToolCallEntry 类型（独立定义），AgentResult 加 toolCalls
- [ ] Step 3: orchestrator.ts — executeWithRetry (~L747) 和 stale context 分支 (~L755) 都映射 toolCalls: poolResult.toolCalls
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

`orchestrator.ts` 改动——新增 `public readonly events = new WorkflowEventEmitter()` 属性，在以下**具体调用点**插入 emit：

| 方法 | 行号范围 | emit 类型 | 位置说明 |
|------|---------|-----------|----------|
| `pause()` | ~L315 | `{ type: "status" }` | `transitionStatus(inst, "paused")` 之后 |
| `resume()` | ~L340 | `{ type: "status" }` | `transitionStatus(instance, "running")` 之后 |
| `abort()` | ~L390 | `{ type: "status" }` | `transitionStatus(instance, "aborted")` 之后 |
| `executeWithRetry` | ~L687 | `{ type: "trace" }` | `appendTraceNode(this.pi, runId, node)` 之后（初始 trace 节点创建） |
| `executeWithRetry` | ~L733 | `{ type: "node-update" }` | stale context 分支 trace node 更新后 |
| `executeWithRetry` | ~L791 | `{ type: "node-update" }` | 正常完成 trace node 更新后 |
| `handleWorkerError` | ~L838 | `{ type: "status" }` | `transitionStatus(instance, "failed")` 之后 |
| `handleWorkerExit` | ~L865, ~L899 | `{ type: "status" }` | `transitionStatus(instance, "failed")` 之后 |
| `onCompletion` 内部 | ~L621 | `{ type: "status" }` | `transitionStatus(instance, "completed")` 之后 |

**Edge Cases:**
- listener 抛异常 → catch 吞掉，不影响其他 listener 或 orchestrator
- 订阅 runId 不存在 → subscribe 仍成功，emit 时自然 no-op
- tick interval 泄漏 → getSubscriptionCount 归零时必须 clear

- [ ] Step 1: 创建 orchestrator-events.ts（WorkflowEventEmitter 类）
- [ ] Step 2: orchestrator.ts — 实例化 emitter (`public readonly events = new WorkflowEventEmitter()`)，在 pause(~L315)、resume(~L340)、abort(~L390)、executeWithRetry(~L687/~L733/~L791)、handleWorkerError(~L838)、handleWorkerExit(~L865/~L899)、onCompletion(~L621) 处加 emit 调用
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

**视图数据源：**
- `instance` = `orchestrator.getInstance(runId)` — 提供 name, status, startedAt, description, budget, trace
- `orchestrator.events.subscribe(runId, listener)` — 实时事件流（status 变化 / trace 更新 / tick）
- listener 调用 `component.invalidate()` 触发重渲染

**View Architecture:**

```
LEVEL 0 — Phase 概览 (↑↓ phase · ⏎ enter · esc back)
┌──────────────────────────────────────────────────────────────┐
│ <name> (bold)                                                 │
│ <description> (muted)            N/M agents · <elapsed> · done │
│──────────────────────────────────────────────────────────────│
│ Phases         │ Review · 3 agents                            │
│ ❯ Review 2/3  │  ● review-1    glm-5.1    148.6k tok · 47… │
│   Fix    2/2  │  ● review-2    glm-5.1    122.6k tok · 54… │
│               │  ● review-3    glm-5.1    0 tok · 4 tools… │
│               │                                                │
├──────────────────────────────────────────────────────────────┤
│ ↑↓ phase · ⏎ enter · esc back                                │
└──────────────────────────────────────────────────────────────┘

LEVEL 1 — Agent 选择 (↑↓ agent · ⏎ detail · esc back)
┌──────────────────────────────────────────────────────────────┐
│ <name> (bold)                                                 │
│ <description> (muted)            N/M agents · <elapsed> · done │
│──────────────────────────────────────────────────────────────│
│ Phases         │ Review · 3 agents                            │
│ ❯ Review 2/3  │❯ ● review-1    glm-5.1    148.6k tok · 47… │
│   Fix    2/2  │  ● review-2    glm-5.1    122.6k tok · 54… │
│               │  ● review-3    glm-5.1    0 tok · 4 tools… │
│               │                                                │
├──────────────────────────────────────────────────────────────┤
│ ↑↓ agent · ⏎ detail · esc back                               │
└──────────────────────────────────────────────────────────────┘

LEVEL 2 — 执行详情 (↑↓ agent · ⏎ prompt · p pause · s save · esc back)
┌──────────────────────────────────────────────────────────────┐
│ <name> (bold)                                                 │
│ <description> (muted)            N/M agents · <elapsed> · done │
│──────────────────────────────────────────────────────────────│
│ ❯ ● review-1  │  ● completed · glm-5.1                       │
│   ● review-2  │  148.6k tok · 47 tool calls · 6m 30s        │
│               │                                                │
│               │  Prompt · 20 lines · ⏎ expand                │
│               │    Iteration 1 of a review-fix loop.         │
│               │    … 18 more lines                           │
│               │                                                │
│               │  Activity · last 3 of 47 tool calls          │
│               │    Write(/tmp/report-1.md)                   │
│               │    Bash(cat > /tmp/report-1.md << 'REPORT…') │
│               │    Bash(cat /tmp/report-1.md | head -5)      │
│               │                                                │
│               │  Outcome                                      │
│               │    Now I have enough information to write... │
│               │                                                │
├──────────────────────────────────────────────────────────────┤
│ ↑↓ agent · ⏎ prompt · p pause · s save · esc back            │
└──────────────────────────────────────────────────────────────┘
```

**只有 1 个 phase 时**：跳过 Level 0，直接进入 Level 1（agent 列表）。左侧不显示 phase 选择，直接显示 agent 列表。

**Key Implementation Points:**

1. **WorkflowsView.ts** (~400 行上限):
   - 工厂函数 `createWorkflowsView(orchestrator, runId, theme, ctx)` → 返回 `Component`
   - 通过 `orchestrator.getInstance(runId)` 获取 instance（name/status/startedAt/trace/budget）
   - 纯函数提取到顶层导出（供测试）：`groupByPhase`, `formatSidebarNode`, `formatActivityLine`, `formatElapsed`, `formatTokenStat`
   - `ctx.ui.custom()` 接受 Component，组件内部 `onKeyEvent` 处理键盘
   - 订阅 `orchestrator.events.subscribe(runId, listener)`，listener 调 `component.invalidate()` 触发重渲染
   - 三层导航：Level 0（Phase 概览）→ Level 1（Agent 选择）→ Level 2（执行详情）
   - 只有 1 个 phase 时跳过 Level 0，直接进入 Level 1
   - Level 0 右侧显示所有 agent 平铺列表（跨 phase）
   - Level 1 右侧显示当前 phase 的 agent 列表（可选择）
   - Level 2 右侧显示执行详情（4 模块：状态、Prompt、Activity、Outcome）
   - Prompt 默认折叠前 3 行，按 Enter 展开
   - Activity 显示最近 3 次 tool call
   - Outcome 显示最后 5 行 output
   - Esc 逐层退回，Level 0 按 Esc 关闭视图 + `unsubscribe()`
   - `s` → `fs.promises.writeFile` 保存 trace markdown 到 `~/.pi/agent/workflow-traces/<runId>.md`
   - `p` → pause/resume
   - **FR-4.7**: prompt output 超过 100KB 时，截断内容 + 显示 `(truncated)`
   - **FR-6.5**: 所有 action 触发后**不自动关闭视图**，用户继续在视图中看状态变化
   - **FR-3.2**: sidebar 第二层 nodes 按 `stepIndex` 升序排列

2. **index.ts 改动**:
   - 删除 `import { registerWorkflowShortcuts, renderWorkflowList } from "./widget.js"`
   - 删除所有 `orch.onTraceUpdate` 中的 `setWidget` 调用（session_start 和 session_tree 中的两处）
   - 删除 `registerWorkflowShortcuts(pi, orchestrators, cmdState)` 调用
   - 删除 `ctx.hasUI` 条件下的 `setWidget` 初始调用
   - 更新 `/workflows` 命令 handler：
     - 有 runId 参数时直接 `ctx.ui.custom(createWorkflowsView(orch, runId, ctx.ui.theme, ctx))`
     - 无参数时：先 `orch.list()` 过滤 `status in ["running", "paused"]`，如果只有 1 个直接进入；多个则 SelectList 选择后进入
   - **FR-1.5**: 命令 handler 返回 void，不调用 `ctx.ui.setEditorText`

3. **widget.ts 删除**:
   - 确认无其他文件 import widget.ts（`grep -rn "from.*widget" extensions/workflow/src/` 验证）
   - 删除文件

4. **`s save` trace markdown 格式**:
   ```markdown
   # Workflow Trace: <name> (<runId>)
   
   Status: <status> | Started: <startedAt> | Duration: <elapsed>
   Budget: <usedTokens>/<maxTokens> tokens, $<usedCost>
   
   ## Phase: <phaseName>
   
   ### [#<stepIndex>] <agentName> — <status>
   - Model: <model>
   - Duration: <duration>
   
   **Prompt:**
   <task full text>
   
   **Activity:**
   - Bash(git diff main...HEAD)
   - Skill(code-review)
   
   **Outcome:**
   <result or error>
   ```

**Footer 快捷键逻辑 (FR-2.5):**
- Level 0（Phase 概览）：`↑↓ phase · ⏎ enter · esc back`
- Level 1（Agent 选择）：`↑↓ agent · ⏎ detail · esc back`
- Level 2（执行详情）：`↑↓ agent · ⏎ prompt · p pause · s save · esc back`

**键盘处理:**
- `↑/↓`: 当前层级内切换选中项
- `Enter`: Level 0 → 进入 Level 1；Level 1 → 进入 Level 2；Level 2 → toggle prompt expand
- `p`: pause/resume（仅 Level 2）
- `s`: save trace to file（仅 Level 2）
- `Esc`: 退回上一层级，Level 0 按 Esc 关闭视图

**Color Mapping (FR-4.1):**
- pending: `theme.fg("muted", "●")`
- running: `theme.fg("warning", "●")`
- completed: `theme.fg("success", "●")`
- failed: `theme.fg("error", "●")`

- [ ] Step 1: 创建 `views/WorkflowsView.ts`（纯函数 + 工厂函数 + 键盘处理 + 订阅 + FR-4.7 100KB 截断 + FR-6.5 action 不关闭 + FR-3.2 stepIndex 升序）
- [ ] Step 2: 更新 `index.ts`（删除 widget 引用 + setWidget 调用 + shortcut 注册，更新 /workflows 命令：过滤 running/paused、单实例直接进入、FR-1.5 返回 void）
- [ ] Step 3: 删除 `widget.ts`，`grep -rn "from.*widget" extensions/workflow/src/` 确认无残留 import
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
- groupByPhase: 按 phase 分组，无 phase 归入 unnamed group（跳过 Level 0）
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
| 注入上下文 | spec FR-7, agent-pool.ts processJsonlEvent 函数（tool_execution_start 分支，在 pipeline.hasToolCall=true 之前 push），state.ts AgentResult 类型，orchestrator.ts executeWithRetry(~L747) 和 stale context 分支(~L755) 的 result 映射段 |
| 读取文件 | `extensions/workflow/src/agent-pool.ts`, `extensions/workflow/src/state.ts`, `extensions/workflow/src/orchestrator.ts` |
| 修改文件 | 同上 |

**Dependencies:** 无

#### BG2: 事件系统

**Description:** 新增 orchestrator-events.ts 订阅 API，orchestrator 在 9 个具体调用点插入 emit（pause/resume/abort/executeWithRetry×3/handleWorkerError/handleWorkerExit×2/onCompletion）。

**Tasks:** Task 2

**Files (预估):** 1 create + 1 modify

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| 注入上下文 | spec FR-5, orchestrator.ts 具体行号：pause(~L315), resume(~L340), abort(~L390), executeWithRetry(~L687/~L733/~L791), handleWorkerError(~L838), handleWorkerExit(~L865/~L899), onCompletion(~L621) |
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
| 注入上下文 | spec FR-1/2/3/4/6/8, TUI 截图 ASCII 还原（handoff §1）, pi-tui API（Text/Container/Component），ctx.ui.custom() 用法（docs/tui.md § Using Components），FR-1.2 过滤 running/paused, FR-1.5 返回 void, FR-3.2 stepIndex 升序, FR-4.7 100KB 截断, FR-6.5 action 不关闭视图 |
| 读取文件 | `extensions/workflow/src/index.ts`, `extensions/workflow/src/widget.ts`, `extensions/workflow/src/orchestrator.ts`, `extensions/workflow/src/state.ts`, `extensions/workflow/src/agent-pool.ts`, `extensions/workflow/src/orchestrator-events.ts` |
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
