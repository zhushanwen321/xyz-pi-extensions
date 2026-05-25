---
verdict: pass
---

# Pi Workflow Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a generic multi-agent orchestration Pi extension — JS-script-defined workflows with pause/resume, background execution, and DAG trace logging.

**Architecture:** Worker thread executes user JS scripts with injected `agent()` proxy; orchestrator on main thread manages agent subprocess pool, callCache for recovery, and execution trace logging via Session JSONL.

**Tech Stack:** TypeScript, Pi Extension API, Node.js `worker_threads`, `child_process.spawn` (pi --mode json), pi-tui, typebox, Session JSONL persistence.

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `workflow/package.json` | create | BG1 | Extension metadata |
| `workflow/index.ts` | create | BG1 | Entry facade |
| `workflow/src/index.ts` | create | BG1 | Extension factory: register commands/tools/events |
| `workflow/src/state.ts` | create | BG1 | Workflow instance state model + state machine + serialization |
| `workflow/src/config-loader.ts` | create | BG1 | Scan workflow directories, extract meta, cache |
| `workflow/src/agent-pool.ts` | create | BG2 | Spawn pi --mode json, manage process pool, JSONL parsing |
| `workflow/src/worker-script.ts` | create | BG2 | Worker thread JS — agent proxy, postMessage protocol |
| `workflow/src/orchestrator.ts` | create | BG2 | Main orchestrator: Workers, callCache, agent pool, pause/resume, budget |
| `workflow/src/execution-trace.ts` | create | BG2 | ExecutionTraceNode logging + JSONL persistence |
| `workflow/src/commands.ts` | create | BG3 | Command handlers: run, list, workflows, abort |
| `workflow/src/widget.ts` | create | BG3 | TUI widget rendering: list view + detail overlay |
| `workflow/src/budget.ts` | create | BG2 | Token/time budget tracking |
| `workflow/src/retry.ts` | create | BG2 | Agent retry with exponential backoff |

---

## Sub-documents

N/A (L1 project, all design details inline)

---

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | Extension scaffold + state model | backend | — | BG1 |
| 2 | Config loader | backend | 1 | BG1 |
| 3 | Agent pool | backend | 1 | BG2 |
| 4 | Worker script + communication protocol | backend | 1 | BG2 |
| 5 | Orchestrator | backend | 2, 3, 4, 6 | BG2 |
| 6 | Execution trace logging | backend | 1 | BG2 |
| 7 | Budget + retry | backend | 5 | BG2 |
| 8 | Commands + completion notification | backend | 5, 6 | BG3 |
| 9 | Workflow-run tool | backend | 5, 6 | BG3 |
| 10 | TUI widget | backend | 5, 6, 2 | BG3 |
| 11 | E2E test workflow script | test | 8, 9 | BG4 |

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC1 最小可用验证 | adopted | Task 5, 8, 11 |
| AC2 暂停/恢复 | adopted | Task 5 |
| AC3 parallel 并发 | adopted | Task 4, 5 |
| AC4 错误重试 | adopted | Task 7 |
| AC5 多 workflow 并发 | adopted | Task 5 |
| AC6 Token 预算 | adopted | Task 7 |
| AC7 Schema 结构化输出 | adopted | Task 3 |
| AC8 CC 兼容性 | adopted | Task 2, 4 |
| AC9 _render 输出 | adopted | Task 9, 10 |
| FR5.3 完成通知 | adopted | Task 8 |
| FR1.5 meta 扫描 | adopted | Task 2 |
| FR5.1 Commands | adopted | Task 8 |
| FR5.2 workflow-run Tool | adopted | Task 9 |
| FR5.4 TUI 面板 | adopted | Task 10 |

---

## Dependency Graph & Wave Schedule

```
BG1 (scaffold+config) ──┬──→ BG2 (core: orchestrator+trace+pool+worker+budget)
                         │
                         └──→ BG3 (interface: commands+tool+widget) ──→ BG4 (e2e test)
                                    (depends on BG2 orchestrator API)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | 基础结构 + 配置加载，无依赖 |
| Wave 2 | BG2 | 核心引擎：Worker/AgentPool/Orchestrator/Trace/Budget/Retry |
| Wave 3 | BG3 | 对外接口：Commands + Tool + TUI Widget，依赖 BG2 的 Orchestrator API |
| Wave 4 | BG4 | E2E 测试脚本，验证整体功能 |

---

## Execution Groups

### BG1: Foundation — Scaffold + Config Loader + State Model

**Description:** 创建扩展目录结构、package.json、入口文件；定义 workflow 实例的状态模型和状态机；实现 workflow 脚本目录扫描和 meta 提取。

**Tasks:** Task 1, Task 2

**Files (预估):** 5 个文件（5 create + 0 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high, tdd-coder: medium） |
| 注入上下文 | Task 1 + Task 2 描述；spec.md FR1、FR11；CLAUDE.md Extension 模式 |
| 读取文件 | `subagent/package.json`、`todo/package.json`（参考模板）；`subagent/src/index.ts`（Extension 工厂模式参考）；`todo/src/index.ts`（tool 注册模式参考） |
| 修改/创建文件 | `workflow/package.json`、`workflow/index.ts`、`workflow/src/index.ts`、`workflow/src/state.ts`、`workflow/src/config-loader.ts` |

**Execution Flow (串行):**

  Task 1:
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写状态管理测试
    2. general-purpose (read xyz-harness-backend-dev) → 实现 scaffold + state model
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 2:
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写配置加载测试
    2. general-purpose (read xyz-harness-backend-dev) → 实现 config-loader
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** 无

**设计细节:**

#### 状态模型 (`state.ts`)

```typescript
// Workflow 实例状态
type WorkflowStatus = "created" | "running" | "paused" | "completed" | "failed" | "aborted" | "budget_limited" | "time_limited";

interface WorkflowInstance {
  runId: string;            // UUID
  name: string;             // Workflow 脚本名
  status: WorkflowStatus;
  callCache: Map<number, AgentResult>;  // callId → output
  trace: ExecutionTraceNode[];          // 执行轨迹日志
  worker?: Worker;           // 当前 Worker 引用（runtime only，不序列化）
  startedAt: number;
  pausedAt?: number;
  completedAt?: number;
  budget?: { total: number; used: number };
  error?: string;
}

// 运行状态管理（闭包内 Map<runId, WorkflowInstance>）
// session_start 时从 JSONL 恢复
```

状态机（终态不可逆转）：
```
created → running → paused → running → completed
              ↘ failed / budget_limited / time_limited
              ↘ aborted
```

#### Config Loader (`config-loader.ts`)

扫描目录：`.pi/workflows/`（项目级）、`~/.pi/agent/workflows/`（用户级）。

提取 meta：创建临时 Worker 线程执行 `import()` → 获取 `meta` 导出 → 缓存。失败时标记脚本不可用，记录错误原因。

CachedWorkflowMeta 接口：`{ name, description, phases, path, available }`。

### BG2: Core — Agent Pool + Worker + Orchestrator + Trace + Budget + Retry

**Description:** 实现 workflow 执行核心引擎：进程池管理、Worker 线程通信协议、DAG/ExecutionTrace 记录、暂停/恢复、预算控制、错误重试。这些模块组合成完整的 workflow 运行时。

**Tasks:** Task 3, Task 4, Task 5, Task 6, Task 7

**Files (预估):** 6 个文件（6 create + 0 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high, tdd-coder: medium） |
| 注入上下文 | Task 3-7 描述；spec.md FR2-FR4、FR6-FR8；CLAUDE.md _render 协议 + 持久化机制 |
| 读取文件 | `subagent/src/spawn.ts`（参考 spawn/JSONL 解析模式）；`workflow/src/state.ts`（数据模型） |
| 修改/创建文件 | `workflow/src/agent-pool.ts`、`workflow/src/worker-script.ts`、`workflow/src/orchestrator.ts`、`workflow/src/execution-trace.ts`、`workflow/src/budget.ts`、`workflow/src/retry.ts` |

**Execution Flow (串行):**

  Tasks 3-7 按依赖顺序串行执行（每 task 走 TDD coder → executor → reviewer 链）。

  执行顺序：
  1. Task 3 (agent-pool) — 无依赖
  2. Task 4 (worker-script) — 无依赖
  3. Task 6 (execution-trace) — 依赖 state model
  4. Task 5 (orchestrator) — 依赖所有上述模块
  5. Task 7 (budget+retry) — 依赖 orchestrator

  Task 3 (agent-pool):
    1→2→3 标准 TDD 链
  Task 4 (worker-script):
    1→2→3 标准 TDD 链
  Task 5 (orchestrator):
    1→2→3 标准 TDD 链
  Task 6 (execution-trace):
    1→2→3 标准 TDD 链
  Task 7 (budget+retry):
    1→2→3 标准 TDD 链

**Dependencies:** BG1（state model）

**设计细节:**

#### Agent Pool (`agent-pool.ts`)

独立实现（不引用 Subagent Extension 内部 API），使用相同底层协议：

```typescript
// 常量
const MAX_CONCURRENCY = 4;  // 可通过 settings.json 中 workflow.maxConcurrency 覆盖

// 函数签名
interface AgentCallOpts {
  prompt: string;
  schema?: object;
  model?: string;
  description?: string;
}

interface AgentResult {
  callId: number;
  output: string;
  parsedOutput?: unknown;   // schema 验证后的结构化结果
  usage?: { inputTokens: number; outputTokens: number };
  durationMs: number;
  success: boolean;
  error?: string;
}

// spawn pi --mode json 子进程
// 通过 JSONL stdout 逐行读取结构化响应
// 格式与 subagent extension 相同但代码独立
function spawnAgent(opts: AgentCallOpts): Promise<AgentResult>;

// 进程池: 队列 + 信号量(MaxConcurrency)，先到先得
class AgentPool {
  enqueue(opts: AgentCallOpts): Promise<AgentResult>;
  get activeCount(): number;
  get queueLength(): number;
}
```

#### Worker 脚本 (`worker-script.ts`)

Worker 线程中执行的代码（通过 `new Worker()` 创建时作为 sourceText 传入）。

通信协议（Worker ↔ 主线程）：

```typescript
// Worker → 主线程 消息格式
type WorkerMessage =
  | { type: "agent-call"; callId: number; opts: AgentCallOpts }
  | { type: "return"; runId: string; result: unknown }
  | { type: "error"; runId: string; error: string };

// 主线程 → Worker 消息格式
type MainMessage =
  | { type: "agent-result"; callId: number; result: AgentResult; cached: boolean }
  | { type: "budget-warning"; budget: { total: number; used: number; remaining: number } }
  | { type: "abort"; reason: string };
```

Worker 中注入的代理函数：

```typescript
// workerData 从主线程传入：{ scriptPath, args: $ARGS, callCache: Record<number, AgentResult>, budget, workspace, meta }
// postMessage 通过 require('worker_threads').parentPort.postMessage

async function agent(opts) {
  const callId = nextCallId++;
  parentPort.postMessage({ type: "agent-call", callId, opts });
  // 如果 callCache 已有结果，主线程直接返回 cached=true，Worker 不等待子进程
  return new Promise((resolve, reject) => {
    parentPort.once("message", (msg) => {
      if (msg.type === "agent-result" && msg.callId === callId) {
        if (msg.result.success) resolve(msg.result.parsedOutput ?? msg.result.output);
        else reject(new Error(msg.result.error));
      }
    });
  });
}

async function parallel(calls) {
  return Promise.all(calls.map(c => c()));  // 或直接 Promise.all(calls)
}

async function pipeline(stages) {
  let result;
  for (const stage of stages) {
    result = await Promise.resolve(stage(result));
  }
  return result;
}
```

#### Orchestrator (`orchestrator.ts`)

主线程的工作流编排器，通过闭包管理所有运行中的 WorkflowInstance：

```typescript
class WorkflowOrchestrator {
  // 启动 workflow
  run(name: string, args: object, budgetTokens?: number, budgetTime?: number): string; // 返回 runId

  // 暂停
  pause(runId: string): void;   // SIGTERM Worker + 保留 callCache

  // 恢复
  resume(runId: string): void;  // 重新创建 Worker + callCache 重放

  // 终止
  abort(runId: string): void;   // SIGTERM Worker + 标记 aborted

  // 重试失败节点
  retryNode(runId: string, callId: number): void;

  // 跳过
  skipNode(runId: string, callId: number): void;

  // 列出所有实例
  list(): WorkflowInstanceSummary[];

  // 内部：Worker 消息路由
  private handleWorkerMessage(runId: string, msg: WorkerMessage): Promise<void>;
}
```

暂停/恢复流程：
1. 暂停：`worker.terminate()` → 保留 `callCache` Map → 标记 `paused`
2. 恢复：创建新 Worker → 注入 `callCache` → Worker 重新执行脚本 → agent 代理在 cache 命中时直接 resolve

#### Execution Trace (`execution-trace.ts`)

```typescript
interface ExecutionTraceNode {
  callId: number;
  prompt: string;
  schema?: object;
  model?: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  output?: string;
  startTime?: number;
  endTime?: number;
  durationMs?: number;
  retryCount: number;
}

// 追加节点到 JSONL
function appendTraceNode(runId: string, node: ExecutionTraceNode): Promise<void>;
// 加载指定 runId 的所有节点
function loadTrace(runId: string): Promise<ExecutionTraceNode[]>;
```

持久化：每次 node status 变更调用 `pi.appendEntry("workflow-node-update", { runId, node })`。

#### Budget (`budget.ts`)

```typescript
interface BudgetTracker {
  total: number;
  used: number;
  startTime: number;
  timeLimitMinutes?: number;
  isExhausted(): boolean;
  isWarning(): boolean;      // >= 90%
  addUsage(inputTokens: number, outputTokens: number): void;
}

// 每 agent 完成后累加
function updateBudget(runId: string, usage: { inputTokens: number; outputTokens: number }): void;
// 定时器检查时间预算
function startTimeCheck(runId: string, orchestrator: WorkflowOrchestrator): void;
```

#### Retry (`retry.ts`)

```typescript
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 9000];  // 1s → 3s → 9s

async function executeWithRetry(
  runId: string,
  callId: number,
  fn: () => Promise<AgentResult>,
  onRetry: (attempt: number) => void
): Promise<AgentResult>;
```

### BG3: Interface — Commands + Tool + TUI Widget

**Description:** 实现用户交互层：4 个 Command（run/list/workflows/abort）、1 个 Tool（workflow-run）、TUI 交互式面板。

**Tasks:** Task 8, Task 9, Task 10

**Files (预估):** 3 个文件（2 create + 1 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high） |
| 注入上下文 | Task 8-10 描述；spec.md FR5、FR9；CLAUDE.md _render 协议 + Tool 设计 + TUI 渲染 |
| 读取文件 | `workflow/src/orchestrator.ts`、`workflow/src/orchestrator.ts`（API）；`subagent/src/index.ts`（命令注册参考）；`subagent/src/render.ts`（_render 参考） |
| 修改/创建文件 | `workflow/src/commands.ts`、`workflow/src/widget.ts`、`workflow/src/index.ts`（追加命令/tool 注册） |

**Execution Flow (串行):**

  Task 8 (commands):
    1→2→3 标准 TDD 链
  Task 9 (workflow-run tool):
    1→2→3 标准 TDD 链
  Task 10 (TUI widget):
    1→2→3 标准 TDD 链

**Dependencies:** BG2（Orchestrator API）

**设计细节:**

#### Commands (`commands.ts`)

```typescript
// 注册到 pi.registerCommand()

// /workflow run <name> [--args key=val ...] [--tokens N] [--time N]
interface RunCommandArgs {
  name: string;
  args?: Record<string, string>;
  tokens?: number;
  time?: number;
}

// /workflows — 交互式面板（见 widget.ts）

// /workflow list — 列出可用 workflow
// /workflow abort <run-id> — 终止

// 完成通知：workflow 完成后调用 pi.sendMessage({ customType: "workflow-result", ... })
// 将结果注入主对话，附带 _render 描述符（task-list 类型，包含 trace 节点状态）
function sendCompletionNotification(runId: string, instance: WorkflowInstance): Promise<void>;
```

#### Workflow-run Tool

```typescript
const WorkflowRunParams = Type.Object({
  name: Type.String({ description: "Workflow 名称" }),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "参数" })),
});

// execute 返回:
//   content: [{ type: "text", text: "Workflow {name} started. Run ID: {runId}" }]
//   details: { runId, name, status: "running", _render: { type: "task-list", data: { ... } } }
```

注意：workflow-run Tool 不等待 workflow 完成（后台运行），只返回启动确认。结果通过 `pi.sendMessage()` 注入对话。

#### TUI Widget (`widget.ts`)

组合三种 Pi TUI 机制：

1. **`setWidget`** — 列表视图（所有 workflow 状态概览），Component 实现
2. **`registerShortcut`** — 全局快捷键 `ctrl+p`/`ctrl+x`/`ctrl+r`，操作当前选中的 workflow
3. **`ctx.ui.custom()` overlay** — 详情视图（单个 workflow 的 ExecutionTrace 节点列表），带 `handleInput` 处理按键

```typescript
function renderWorkflowList(instances: WorkflowInstanceSummary[], theme: Theme): Component;
function renderWorkflowDetail(instance: WorkflowInstance, theme: Theme): Component;
```

### BG4: E2E Test — Demo Workflow Script

**Description:** 编写用于端到端测试的 demo workflow 脚本，验证最小可用路径。

**Tasks:** Task 11

**Files (预估):** 1 个文件（1 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择（low） |
| 注入上下文 | Task 11 描述；spec.md AC1 |
| 创建文件 | `.pi/workflows/demo.js` |

**Execution Flow:** 单 Task，无需 TDD 链。

**Dependencies:** BG3（commands + tool 就绪）

**设计细节:**

```javascript
const meta = {
  name: "demo",
  description: "Demo workflow — 验证最小可用路径",
  phases: ["analyze", "summarize"]
};

const file = $ARGS.file ?? "README.md";

// Phase 1: 分析文件
const analysis = await agent({
  prompt: `Read the file at ${$WORKSPACE}/${file} and list its key sections. Return as JSON array of section titles.`,
  schema: { type: "array", items: { type: "string" } },
  description: "Analyze file structure"
});

// Phase 2: 汇总
const summary = await agent({
  prompt: `Summarize the following file sections in one paragraph: ${JSON.stringify(analysis)}`,
  description: "Summarize file"
});

return { file, sections: analysis, summary };
```

---

## E2E Test Plan

见 `e2e-test-plan.md`。

## Test Cases Template

见 `test_cases_template.json`。

---

## Risk Notes

- **Worker 线程异常处理**：Worker 崩溃时主线程必须捕获 `worker.on("error")` 和 `worker.on("exit")`，否则 workflow 可能永远处于 running 状态。
- **callCache 序列化**：`Map<number, unknown>` 序列化时需转为普通对象。恢复时重建 Map。
- **跨会话 JSONL 扫描**：`session_start` 事件中需要异步扫描目录，需确认 Pi 不会阻塞等待该 handler 完成。
- **并发进程池**：共享 agent pool 需要处理"一个 workflow 的 agent 子进程失败不影响其他 workflow 的排队请求"。
