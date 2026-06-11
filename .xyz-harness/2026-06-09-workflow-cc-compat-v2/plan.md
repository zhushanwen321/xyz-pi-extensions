---
verdict: pass
complexity: L1
---

# Workflow CC Compat + Structured Output 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 workflow 的 structured output 可靠性（P0）和 Claude Code 脚本格式兼容性（P1），使同一份 CC 脚本能同时在 Pi 和 CC 上运行。

**Architecture:** 改动集中在 `extensions/workflow/src/` 的 5 个文件。FR-1 修改 `agent-pool.ts` 的 `buildArgs()` + `spawnAndParse()`，将 schema 注入从 prompt 拼接改为 `--append-system-prompt` 临时文件。FR-2 修改 `config-loader.ts`（phases 类型）、`worker-script.ts`（args 别名、phase 提取、parallel/pipeline 签名、budget 动态）、`state.ts`（ExecutionTraceNode.phase）、`orchestrator.ts`（临时文件写入 + phase 传递 + budget 推送）。

**Tech Stack:** TypeScript, Pi Extension API, Node.js child_process / worker_threads, vitest

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `extensions/workflow/src/agent-pool.ts` | modify | BG1 | buildArgs 改用临时文件注入 schema；spawnAndParse 增加重试和盲区检测 |
| `extensions/workflow/src/config-loader.ts` | modify | BG2 | WorkflowMeta.phases 扩展为联合类型，regex 解析更新 |
| `extensions/workflow/src/worker-script.ts` | modify | BG2 | args 别名、phase 提取、parallel thunk 支持、pipeline 笛卡尔积、budget 动态函数 |
| `extensions/workflow/src/state.ts` | modify | BG2 | ExecutionTraceNode 增加 phase 字段 |
| `extensions/workflow/src/orchestrator.ts` | modify | BG2 | schema 临时文件写入、phase 传递、budget 推送、临时文件清理 |
| `extensions/workflow/src/__tests__/structured-output.test.ts` | create | BG1 | FR-1 AC 验证 |
| `extensions/workflow/src/__tests__/cc-compat.test.ts` | create | BG2 | FR-2 AC 验证 |

## Interface Contracts

### Module: agent-pool

#### Class: AgentPool

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| buildArgs | (opts: AgentCallOpts) => string[] | string[] | opts.schema 存在时写临时文件并用 --append-system-prompt | AC-1.1, AC-1.2 |
| spawnAndParse | (opts, callId, startedAt, signal?) => Promise\<AgentResult\> | AgentResult | schema 有但无 tool call → 重试一次；有其他 tool call 但无 SO 且 exit=0 → fail | AC-1.3, AC-1.4 |

#### Data: AgentCallOpts (扩展)

| Field | Type | Description |
|-------|------|-------------|
| phase? | string | agent 所属 phase（显式或隐式） |

### Module: config-loader

#### Class: WorkflowMeta (扩展)

| Field | Type | Description |
|-------|------|-------------|
| phases | (string \| {title: string, detail?: string})[] | 联合类型，CC 支持 {title,detail} |

### Module: worker-script

#### Global: agent() (扩展)

| Field | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| secondArg.phase | string | — | 覆盖 _currentPhase | AC-2.6 |

#### Global: parallel() (扩展)

| Signature | Returns | Edge Cases | Spec Ref |
|-----------|---------|------------|----------|
| parallel(thunks: (() => Promise)[]) | Promise\<any[]\> | thunk 数组每项并发执行 | AC-2.4 |

#### Global: pipeline() (扩展)

| Signature | Returns | Edge Cases | Spec Ref |
|-----------|---------|------------|----------|
| pipeline(items: any[], ...stages: Function[]) | Promise\<any[]\> | 单 item 失败 → null，不影响其他 | AC-2.5, AC-2.9 |

#### Global: budget (扩展)

| Field/Method | Signature | Returns | Spec Ref |
|--------------|-----------|---------|----------|
| total | number | workerData.budget.maxTokens | AC-2.8 |
| spent() | () => number | 缓存的 usedTokens | AC-2.7 |
| remaining() | () => number | max(0, total - spent()) | AC-2.8 |

### Module: state

#### Data: ExecutionTraceNode (扩展)

| Field | Type | Description |
|-------|------|-------------|
| phase? | string | agent 所属 phase |

### Module: orchestrator

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| writeSchemaTempFile | (schema: object, callId: string) => string | 文件路径 | 目录不存在时创建 | AC-1.1 |
| cleanupTempFiles | () => void | — | 完成或中止时调用 | Constraint |
| pushBudgetUpdate | (worker: Worker) => void | — | 每次 agent 完成后推送 | AC-2.7 |

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1.1 | AgentPool.buildArgs | opts.schema → writeTempFile → --append-system-prompt | Task 1 |
| AC-1.2 | AgentPool.buildArgs | schema JSON → writeFileSync → resolvePromptInput | Task 1 |
| AC-1.3 | AgentPool.spawnAndParse | no SO + no tool call → retry with stronger prompt | Task 2 |
| AC-1.4 | AgentPool.spawnAndParse | has tool call + exit 0 + no SO → fail | Task 2 |
| AC-2.1 | config-loader.extractMetaViaRegex | phases filter 支持 {title,detail} | Task 3 |
| AC-2.2 | worker-script.$ARGS alias | const args = $ARGS | Task 4 |
| AC-2.3 | worker-script.phase + orchestrator | _currentPhase → opts.phase → trace.phase | Task 5 |
| AC-2.4 | worker-script.parallel | calls.map(c => typeof c === 'function' ? c() : agent(c)) | Task 6 |
| AC-2.5 | worker-script.pipeline | items × stages 笛卡尔积 | Task 7 |
| AC-2.6 | worker-script.agent | secondArg.phase 覆盖 _currentPhase | Task 5 |
| AC-2.7 | worker-script.budget.spent | parentPort budget-update → cache | Task 8 |
| AC-2.8 | worker-script.budget.remaining | total - spent() ≥ 0 | Task 8 |
| AC-2.9 | worker-script.pipeline | 单 item 失败 → null，其他继续 | Task 7 |

## Spec Metrics Traceability

| Spec AC | 采纳状态 | 对应 Task |
|---------|---------|----------|
| AC-1.1 | adopted | Task 1 |
| AC-1.2 | adopted | Task 1 |
| AC-1.3 | adopted | Task 2 |
| AC-1.4 | adopted | Task 2 |
| AC-2.1 | adopted | Task 3 |
| AC-2.2 | adopted | Task 4 |
| AC-2.3 | adopted | Task 5 |
| AC-2.4 | adopted | Task 6 |
| AC-2.5 | adopted | Task 7 |
| AC-2.6 | adopted | Task 5 |
| AC-2.7 | adopted | Task 8 |
| AC-2.8 | adopted | Task 8 |
| AC-2.9 | adopted | Task 7 |
| AC-3.1 ~ AC-3.5 | postponed | 延后到下一阶段（FR-3 TUI） |

---

## Task List

### Task 1: Schema 注入改为 --append-system-prompt 临时文件

**Type:** backend

**Files:**
- Modify: `extensions/workflow/src/agent-pool.ts:300-325` (buildArgs 方法)
- Modify: `extensions/workflow/src/orchestrator.ts` (临时文件写入逻辑，传递 systemPromptFile)
- Create: `extensions/workflow/src/__tests__/structured-output.test.ts`

**目标：** AC-1.1, AC-1.2

**前置条件：** 无

- [ ] **Step 1: 修改 orchestrator 传入 systemPromptFile**

在 orchestrator 的 `handleAgentCall`（处理 worker 发来的 `agent-call` 消息）中，当 `opts.schema` 存在时：
1. 在 `<sessionDir>/workflow-tmp/` 创建目录（如果不存在）
2. 将 schema JSON + structured-output 调用指令写入 `<sessionDir>/workflow-tmp/so-<callId>.txt`
3. 将文件路径赋值给 `opts.systemPromptFile`（复用已有字段）

临时文件内容模板：
```
You MUST call the structured-output tool to return your result.
Parameters: schema = <JSON>, data = <your result>
Do NOT output JSON in your text response — use the structured-output tool instead.
```

- [ ] **Step 2: 修改 buildArgs 使用 systemPromptFile**

在 `buildArgs()` 中，当 `opts.schema` 存在时：
- 不再将 schema 指令拼接到 prompt 中
- 依赖 orchestrator 已经写入的 `opts.systemPromptFile`（现有逻辑已有 `--append-system-prompt opts.systemPromptFile` 分支）

- [ ] **Step 3: 增加 agent-call 消息中传递 callId**

当前 `parentPort.postMessage({type: "agent-call"})` 不传 callId。orchestrator 需要知道 callId 才能生成唯一临时文件名。在 worker-script 的 `agent()` 函数中，callId 已经存在（`_callIdCounter`）。确认 orchestrator 的 handleAgentCall 已能获取 callId。

- [ ] **Step 4: 写测试**

测试点：
- buildArgs 在有 schema 时返回 `--append-system-prompt <path>` 参数
- buildArgs 在无 schema 时不返回 `--append-system-prompt`
- 临时文件内容包含 schema JSON 且格式正确

- [ ] **Step 5: Commit**

```bash
git add extensions/workflow/src/agent-pool.ts extensions/workflow/src/orchestrator.ts extensions/workflow/src/__tests__/structured-output.test.ts
git commit -m "feat(workflow): inject schema via --append-system-prompt temp file"
```

---

### Task 2: Structured Output 重试 + 盲区修复

**Type:** backend

**Files:**
- Modify: `extensions/workflow/src/agent-pool.ts:349-420` (spawnAndParse 方法)

**目标：** AC-1.3, AC-1.4

**依赖：** Task 1（buildArgs 已改用临时文件）

- [ ] **Step 1: 增加 hasToolCall + exit=0 盲区检测**

在 `spawnAndParse` 返回结果前，当 `opts.schema` 存在、`parsedOutput === undefined`、`pipeline.hasToolCall === true`、`exitCode === 0` 时，返回失败结果（error: "Agent completed without calling structured-output tool"）。

当前代码仅在 `!pipeline.hasToolCall` 时报错，需要扩展到 `hasToolCall && exitCode === 0` 的场景。

- [ ] **Step 2: 增加重试逻辑**

在 `spawnAndParse` 中，当 `opts.schema` 存在、`parsedOutput === undefined`、`!pipeline.hasToolCall` 时：
1. 不立即返回错误
2. 写入加强版临时文件（在原有指令前加 `[RETRY - CRITICAL]` 强调）
3. 再次调用 `runPiProcess`
4. 第二次仍失败则返回错误

加强版 prompt 模板：
```
[RETRY - CRITICAL INSTRUCTION]
Your previous attempt did not call the structured-output tool. This is MANDATORY.
You MUST call the structured-output tool NOW.
...
```

- [ ] **Step 3: 写测试**

测试点：
- mock runPiProcess 第一次返回无 SO 无 tool call，第二次成功 → 最终 success=true
- mock runPiProcess 两次都返回无 SO 无 tool call → success=false, error 包含 retry 语义
- mock runPiProcess 返回有 tool call 但无 SO + exit=0 → success=false

- [ ] **Step 4: Commit**

```bash
git add extensions/workflow/src/agent-pool.ts extensions/workflow/src/__tests__/structured-output.test.ts
git commit -m "feat(workflow): add structured-output retry and blind-spot detection"
```

---

### Task 3: phases 类型扩展

**Type:** backend

**Files:**
- Modify: `extensions/workflow/src/config-loader.ts:21,164-165`

**目标：** AC-2.1

**依赖：** 无

- [ ] **Step 1: 扩展 WorkflowMeta.phases 类型**

将 `WorkflowMeta` 接口的 `phases` 类型从 `string[]` 改为 `(string | {title: string; detail?: string})[]`。

- [ ] **Step 2: 更新 extractMetaViaRegex 中的 filter 逻辑**

当前第 164-165 行：
```typescript
metaObj.phases.filter((p: unknown) => typeof p === "string") as string[]
```

改为接受 string 和 `{title, detail?}` 两种类型：
```typescript
metaObj.phases.filter((p: unknown) =>
  typeof p === "string" || (typeof p === "object" && p !== null && "title" in p)
) as (string | {title: string; detail?: string})[]
```

- [ ] **Step 3: 更新 CachedWorkflowMeta 的 phases 类型**

`CachedWorkflowMeta extends WorkflowMeta`，会自动继承新类型。

- [ ] **Step 4: 写测试**

测试点：
- `phases: ['Review', 'Fix']` 解析为 `['Review', 'Fix']`
- `phases: [{title: 'Review'}, {title: 'Fix', detail: 'xxx'}]` 解析为 `[{title:'Review'}, {title:'Fix', detail:'xxx'}]`
- 混合格式 `phases: ['Review', {title: 'Fix'}]` 正确解析

- [ ] **Step 5: Commit**

```bash
git add extensions/workflow/src/config-loader.ts extensions/workflow/src/__tests__/cc-compat.test.ts
git commit -m "feat(workflow): support CC-style phases with title/detail objects"
```

---

### Task 4: args 全局别名 + phase 提取

**Type:** backend

**Files:**
- Modify: `extensions/workflow/src/worker-script.ts`

**目标：** AC-2.2, AC-2.6 (partial)

**依赖：** 无

- [ ] **Step 1: 注入 args 别名**

在 worker-script 中 `$ARGS` 定义之后添加：
```javascript
const args = $ARGS;
```

- [ ] **Step 2: agent() 提取 phase 字段**

在 `agent()` 函数的 secondArg 解析中，增加 `phase` 字段提取：
```javascript
const _effectivePhase = (secondArg && typeof secondArg === "object" && secondArg.phase) || _currentPhase;
```

将 `_effectivePhase` 附加到发送给主线程的 opts 中：
```javascript
opts.phase = _effectivePhase;
```

- [ ] **Step 3: 更新 _knownFields 白名单**

将 `phase` 添加到 `_knownFields` Set 中，避免产生 unknown fields 警告。

- [ ] **Step 4: Commit**

```bash
git add extensions/workflow/src/worker-script.ts
git commit -m "feat(workflow): add args alias and phase field extraction"
```

---

### Task 5: Phase 传递到 trace node

**Type:** backend

**Files:**
- Modify: `extensions/workflow/src/state.ts:68` (ExecutionTraceNode)
- Modify: `extensions/workflow/src/orchestrator.ts` (handleAgentCall 传递 phase)

**目标：** AC-2.3, AC-2.6

**依赖：** Task 4（worker-script 已提取 phase 字段）

- [ ] **Step 1: ExecutionTraceNode 增加 phase 字段**

在 `ExecutionTraceNode` 接口中增加可选字段：
```typescript
phase?: string;
```

- [ ] **Step 2: orchestrator 从 agent-call 消息中提取 phase**

在 `handleAgentCall` 处理 `agent-call` 消息时，从 `msg.opts.phase` 提取 phase 值，传递到 `ExecutionTraceNode.phase`。

- [ ] **Step 3: 向后兼容处理**

`deserializeState` 中对缺失 `phase` 字段的旧 trace nodes 给默认值 `undefined`（TypeScript 可选字段自动兼容）。

- [ ] **Step 4: 写测试**

测试点：
- agent-call 带 phase='Review' → trace node.phase === 'Review'
- agent-call 无 phase → trace node.phase === undefined
- 显式 phase 覆盖全局 phase：全局 'Review'，显式 'Fix' → trace node.phase === 'Fix'

- [ ] **Step 5: Commit**

```bash
git add extensions/workflow/src/state.ts extensions/workflow/src/orchestrator.ts extensions/workflow/src/__tests__/cc-compat.test.ts
git commit -m "feat(workflow): pass phase to ExecutionTraceNode with explicit override"
```

---

### Task 6: parallel() 支持 thunk 数组

**Type:** backend

**Files:**
- Modify: `extensions/workflow/src/worker-script.ts:191-196` (parallel 函数)

**目标：** AC-2.4

**依赖：** 无

- [ ] **Step 1: 更新 parallel() 函数**

当前实现：
```javascript
async function parallel(calls) {
  if (typeof calls === "function") { return calls(); }
  return Promise.all(calls.map((c) => agent(c)));
}
```

改为支持 thunk：
```javascript
async function parallel(calls) {
  if (typeof calls === "function") { return calls(); }
  return Promise.all(calls.map((c) => {
    if (typeof c === "function") { return c(); }
    if (typeof c === "object" && c !== null && (c.task || c.agent)) { return agent(c); }
    return agent(c);
  }));
}
```

- [ ] **Step 2: 写测试**

测试点：
- `parallel([() => agent("t1"), () => agent("t2")])` → 两个 agent 并发
- `parallel([{task: "t1", agent: "a1"}, {task: "t2"}])` → 现有格式仍工作

- [ ] **Step 3: Commit**

```bash
git add extensions/workflow/src/worker-script.ts extensions/workflow/src/__tests__/cc-compat.test.ts
git commit -m "feat(workflow): parallel() supports thunk arrays"
```

---

### Task 7: pipeline() 笛卡尔积 + 错误隔离

**Type:** backend

**Files:**
- Modify: `extensions/workflow/src/worker-script.ts:196-202` (pipeline 函数)

**目标：** AC-2.5, AC-2.9

**依赖：** 无

- [ ] **Step 1: 重写 pipeline() 函数**

当前实现只支持 `[stageFn, ...]` 单参数模式。改为支持两种签名：
1. `pipeline([stage1, stage2, ...])` — 现有模式，串行执行 stages
2. `pipeline(items, stage1, stage2, ...)` — CC 笛卡尔积模式

```javascript
async function pipeline(firstArg, ...restStages) {
  // 单参数模式：pipeline([stage1, stage2])
  if (Array.isArray(firstArg) && restStages.length === 0) {
    let result;
    for (const stage of firstArg) { result = await stage(result); }
    return result;
  }
  // 笛卡尔积模式：pipeline([item1, item2], stage1, stage2)
  if (Array.isArray(firstArg) && restStages.length > 0 && typeof restStages[0] === "function") {
    const items = firstArg;
    const stages = restStages;
    const results = [];
    for (const item of items) {
      let val = item;
      let failed = false;
      for (const stage of stages) {
        if (failed) break;
        try { val = await stage(val); }
        catch (e) { val = null; failed = true; }
      }
      results.push(val);
    }
    return results;
  }
  throw new Error("pipeline() expects pipeline([stage1, ...]) or pipeline([items], stage1, ...)");
}
```

- [ ] **Step 2: 写测试**

测试点：
- `pipeline([1,2,3], x => agent("p"+x), r => agent("v"+r))` → 3 个 item 各自过 2 个 stage
- item 2 的 stage1 抛错 → item 2 结果为 null，item 1 和 3 正常
- `pipeline([s1, s2])` 现有模式仍工作

- [ ] **Step 3: Commit**

```bash
git add extensions/workflow/src/worker-script.ts extensions/workflow/src/__tests__/cc-compat.test.ts
git commit -m "feat(workflow): pipeline() supports CC-style cartesian product with error isolation"
```

---

### Task 8: Budget 动态函数

**Type:** backend

**Files:**
- Modify: `extensions/workflow/src/worker-script.ts:94` ($BUDGET 定义) + message handler
- Modify: `extensions/workflow/src/orchestrator.ts` (budget-update 推送)

**目标：** AC-2.7, AC-2.8

**依赖：** 无

- [ ] **Step 1: Worker 中注入动态 budget 对象**

替换静态 `$BUDGET` 为带方法的 proxy 对象：

```javascript
const _budgetData = {
  total: (workerData.budget && workerData.budget.maxTokens) || 0,
  _spentTokens: (workerData.budget && workerData.budget.usedTokens) || 0,
  _spentCost: (workerData.budget && workerData.budget.usedCost) || 0,
};
const $BUDGET = {
  get total() { return _budgetData.total; },
  spent() { return _budgetData._spentTokens; },
  remaining() { return Math.max(0, _budgetData.total - _budgetData._spentTokens); },
};
```

- [ ] **Step 2: Worker 接收 budget-update 消息**

在 `parentPort.on("message")` handler 中增加：
```javascript
if (msg.type === "budget-update" && msg.budget) {
  _budgetData._spentTokens = msg.budget.usedTokens || _budgetData._spentTokens;
  _budgetData._spentCost = msg.budget.usedCost || _budgetData._spentCost;
}
```

- [ ] **Step 3: Orchestrator 推送 budget-update**

在 orchestrator 的 `handleAgentResult`（agent 完成后）中，向 worker 发送：
```javascript
worker.postMessage({
  type: "budget-update",
  budget: { usedTokens: instance.budget.usedTokens, usedCost: instance.budget.usedCost }
});
```

- [ ] **Step 4: 写测试**

测试点：
- 初始状态：`budget.spent()` 返回 0
- 收到 budget-update 后：`budget.spent()` 返回更新后的值
- `budget.remaining()` 返回 `max(0, total - spent())`

- [ ] **Step 5: Commit**

```bash
git add extensions/workflow/src/worker-script.ts extensions/workflow/src/orchestrator.ts extensions/workflow/src/__tests__/cc-compat.test.ts
git commit -m "feat(workflow): dynamic budget with parentPort budget-update"
```

---

## Execution Groups

#### BG1: Structured Output 可靠性

**Description:** FR-1 全部改动，集中在 agent-pool.ts 和 orchestrator.ts 的 schema 注入和重试逻辑。

**Tasks:** Task 1, Task 2

**Files (预估):** 4 个文件（2 modify + 1 modify + 1 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | taskComplexity: high |
| 注入上下文 | Task 1-2 描述、spec FR-1 章节、agent-pool.ts 完整代码 |
| 读取文件 | extensions/workflow/src/agent-pool.ts, extensions/workflow/src/orchestrator.ts |
| 修改/创建文件 | agent-pool.ts, orchestrator.ts, __tests__/structured-output.test.ts |

**Execution Flow (BG1 内部):** 串行派遣。

  Task 1 (schema 注入):
    1. general-purpose → 实现 buildArgs 改造 + orchestrator 临时文件写入 + 测试

  Task 2 (重试 + 盲区，依赖 Task 1):
    1. general-purpose → 实现 spawnAndParse 重试逻辑 + 盲区检测 + 测试

**Dependencies:** 无

**设计细节:** 直接写在此处（L1）

---

#### BG2: CC 格式兼容性

**Description:** FR-2 全部改动，分布在 config-loader、worker-script、state、orchestrator 四个文件中。

**Tasks:** Task 3, Task 4, Task 5, Task 6, Task 7, Task 8

**Files (预估):** 7 个文件（4 modify + 1 create + 2 modify 涉及 orchestrator/state）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | taskComplexity: medium |
| 注入上下文 | Task 3-8 描述、spec FR-2 章节、各文件关键代码段 |
| 读取文件 | config-loader.ts, worker-script.ts, state.ts, orchestrator.ts |
| 修改/创建文件 | config-loader.ts, worker-script.ts, state.ts, orchestrator.ts, __tests__/cc-compat.test.ts |

**Execution Flow (BG2 内部):** 按 Task 顺序串行（有依赖关系的严格串行，无依赖的可以相邻执行）。

  Task 3 (phases 类型) + Task 4 (args 别名) + Task 6 (parallel thunk): 无依赖，可连续执行
  Task 5 (phase 传递，依赖 Task 4): 接着执行
  Task 7 (pipeline 笛卡尔积): 无依赖
  Task 8 (budget 动态): 无依赖

**Dependencies:** 无

**设计细节:** 直接写在此处（L1）

---

## Dependency Graph & Wave Schedule

```
BG1 (Task 1-2: SO 可靠性) ── 无依赖
BG2 (Task 3-8: CC 兼容) ── 无依赖（Task 5 依赖 Task 4，但都在 BG2 内部）
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1, BG2 | 两个 Group 无依赖，可并行。BG1 改 agent-pool + orchestrator，BG2 改其余文件 |

**并行约束：** BG1 和 BG2 都涉及 orchestrator.ts（BG1 的 Task 1 改临时文件写入，BG2 的 Task 5 和 Task 8 改 phase 传递和 budget 推送），但改动物理位置不同，可合并为一个 subagent 执行以避免文件冲突。

**推荐执行方式：** 如果 Semaphore 允许，两个 Group 并行但各自内部的 orchestrator 改动在各自范围内完成，最终由人工或额外 commit 合并。如果担心冲突，改为串行（先 BG1 再 BG2）。

---

## 临时文件清理

orchestrator 在以下时机清理 `<sessionDir>/workflow-tmp/`：
1. workflow 实例状态变为终态（completed / failed / aborted）时，主动删除该 runId 对应的所有临时文件
2. 不做全局清理——其他 run 的临时文件可能仍在使用

清理方法：
```typescript
private cleanupTempFiles(runId: string): void {
  const tmpDir = path.join(this.sessionDir, "workflow-tmp");
  try {
    const files = fs.readdirSync(tmpDir);
    for (const f of files) {
      if (f.startsWith(`so-agent-`)) {
        // 按前缀清理所有 agent 临时文件（非按 runId）
        // 因为 callId 已经包含足够随机性，不会冲突
      }
    }
  } catch { /* 目录不存在或已清理 */ }
}
```

**注意：** 实际实现时，按 runId 清理需要 callId 到 runId 的映射。更简单的方案是按时间清理——workflow 完成时清理所有超过 1 小时的临时文件。
