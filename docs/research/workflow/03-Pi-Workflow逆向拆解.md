# 03. Pi Workflow 逆向拆解

> 目标:对 `~/Code/xyz-pi-extensions-workspace/main/extensions/workflow/`(`@zhushanwen/pi-workflow`)做同样维度的拆解,便于与 Claude Code dynamic workflows 对比。
>
> 这次是**读源码**,数据是确定的。可以指出每条结论对应的文件 + 行号 + 关键代码。

---

## 一、典型用例

### 1.1 README 明确列出的场景

来自 `extensions/workflow/README.md`:

- **代码审查**(批量):`scan src/ → parallel review → summarize`
- **多角度交叉验证**(对应 Claude Code 的 Adversarial / Judge Panel)
- **批量文件处理**(对应 Fan-out)
- **死代码清理**(对应 Accumulate,带循环)

### 1.2 内部代码暗示的用例

- **多 Agent 协同探索**:`tool-generate.ts` 描述 "When the user describes a task in natural language via /workflow and no existing workflow matches. AI generates a JS script, then uses this tool to write it." — 即 **AI 即时生成 + 用户确认 + 运行** 的循环,这是项目最大的差异化场景。
- **跨会话的长时间任务**:`state.ts` 设计 `paused` ↔ `running` 双向转换 + `callCache` 持久化,显示**长时间任务跨会话恢复**是设计目标(而 Claude Code 明确不支持跨会话)。
- **并发子 agent 不互相阻塞**:`agent-pool.ts` 默认并发 4,可调,适合**可拆分的批量任务**。

### 1.3 标杆用法(README 完整示例)

```javascript
const meta = { name: "my-review", description: "批量代码审查" };

(async () => {
  const files = await agent({ prompt: "扫描 src/ 下所有 .ts 文件" });
  const reviews = await parallel(
    JSON.parse(files).map(f => ({ prompt: `审查 ${f}` }))
  );
  await agent({ prompt: `汇总报告：\n${reviews.join("\n")}` });
})();
```

- 单一扫描 → parallel 审查 → 汇总(三段式)
- 文件名 + IIFE 入口
- `meta.name` 是 workflow 唯一标识,出现在 /workflows 列表

### 1.4 与 Claude Code 用例的差异

| 维度 | Claude Code | pi-workflow |
|------|------------|-------------|
| 标杆案例 | Bun 75万行 Rust 移植 | 简单三段式,无公开案例 |
| 规模 | 数百 agent(从 Bun 案例) | 默认 4 并发(可调),无 1000 上限(只受 budget 限制) |
| 跨会话 | 不支持 | **支持**(callCache 持久化) |
| AI 即时生成 | 是(关键词触发) | 是(`/workflow-generate` 工具,显式) |

---

## 二、核心领域设计

### 2.1 设计哲学

来自代码注释 + ADR-002(goal 7 态状态机)+ ADR-001(subagent 架构):

1. **可恢复优先**:`callCache` + paused ↔ running 双向 + 跨 session rehydrate
2. **状态机驱动**:7 态精确状态机,所有转移通过 `transitionStatus()` 走,任何非法转移抛错
3. **Worker 隔离**:每个 workflow 跑在独立 Node `Worker` 线程,主线程不卡
4. **Pi 进程池**:每个 agent call 实际是 `spawn("pi", --mode json, -p, --no-session)`(orchestrator.ts:288 `resolveInvocation`),**进程级隔离**
5. **预算硬约束**:token / cost / time 三重 budget,90% 警告,100% 终止

### 2.2 核心领域概念

| 概念 | 定义 | 文件 | 关键代码 |
|------|------|------|---------|
| **Workflow script** | 用户在 `.pi/workflows/<name>.js` 写的 JS | `config-loader.ts` | `loadWorkflows()` 扫描 |
| **Meta block** | 脚本中的 `const meta = { name, description, phases }` | `config-loader.ts:46-63` | extractMetaViaWorker 提取 |
| **Agent call** | `await agent(opts)` 注入的全局函数 | `worker-script.ts:99-128` | 通过 `parentPort.postMessage` 转发 |
| **Orchestrator** | 主线程上的中央协调器 | `orchestrator.ts:63-` | 管理 Worker 生命周期、callCache、budget |
| **Worker thread** | Node Worker thread,执行 workflow 脚本 | `worker-script.ts` | `new Worker(code, { eval: true })` |
| **AgentPool** | Pi 子进程池,FIFO 调度 | `agent-pool.ts:81-` | 默认并发 4,FIFO 队列 |
| **CallCache** | 已完成 agent 调用的内存缓存,key=callId | `state.ts:122-127` | `Map<number, AgentResult>` |
| **Trace** | 执行追踪,每个 agent 一个 node | `state.ts:117` | `ExecutionTraceNode[]` |
| **Run** | 一次 workflow 执行实例 | `state.ts:121-131` | `WorkflowInstance`,7 态状态机 |
| **Budget** | token/cost/time 三重预算 | `state.ts:33-38` | `WorkflowBudget` |
| **Persistence** | 通过 `pi.appendEntry("workflow-state", ...)` 写 session JSONL | `orchestrator.ts:613-615` | `persistState()` |
| **Rehydrate** | `session_start` 从 JSONL 重建 instances map | `index.ts:85-114` | `reconstructState(ctx)` |

### 2.3 领域边界(谁负责什么)

```
┌──────────────────────────────────────────────┐
│ Pi 主进程 (Extension 宿主)                   │
│  - UI 渲染 (TUI widget + select 面板)        │
│  - Session 管理 (JSONL 读写)                 │
│  - 工具注册 (workflow, workflow-run, etc.)   │
│  - 命令解析 (/workflow, /workflows)         │
└──────────────────────────────────────────────┘
                ↓ 注册回调
┌──────────────────────────────────────────────┐
│ WorkflowOrchestrator (主线程单例 per session)│
│  - instances: Map<runId, WorkflowInstance>   │
│  - workers: Map<runId, Worker>              │
│  - runMetaMap: 持久化 run 元数据              │
│  - agentPool: Pi 子进程池                    │
│  - 状态机驱动 (transitionStatus)            │
│  - persistState() 同步写 JSONL              │
└──────────────────────────────────────────────┘
          ↓ Worker 线程                 ↓ Pi 子进程
┌─────────────────────────┐    ┌──────────────────────┐
│ Worker (Node worker_thread)│    │ Pi (child_process)    │
│  - 执行 workflow 脚本   │    │  - agent 真正执行     │
│  - 注入全局 agent/parallel │    │  - --mode json       │
│  - 注入 $ARGS/$WORKSPACE │    │  - 输出 JSONL         │
│  - parentPort ↔ orchestrator│    │  - 独立上下文        │
└─────────────────────────┘    └──────────────────────┘
```

**与 Claude Code 对比的关键差异**:

| 边界 | Claude Code | pi-workflow |
|------|------------|-------------|
| Subagent 执行方式 | Claude Code 内部 subagent 系统(进程或线程,未公开) | **显式 spawn `pi` 子进程**(`child_process.spawn`) |
| Runtime 隔离 | Workflow runtime 是独立环境(推断) | **显式 Node Worker thread**(Node `worker_threads`) |
| 主会话与 runtime 通信 | 未公开,推断 RPC | **parentPort.postMessage / Worker postMessage** |
| Subagent 与 runtime 通信 | 未公开,推断 RPC | **同样的 parentPort + 主线程 AgentPool** |

### 2.4 核心领域服务

| 服务 | 职责 | 文件 | 关键方法 |
|------|------|------|----------|
| **ScriptLoader** | 扫描 `.pi/workflows/` 和 `~/.pi/agent/workflows/` | `config-loader.ts:155-178` | `loadWorkflows()` |
| **MetaExtractor** | 在临时 Worker 中 import 脚本,提取 meta | `config-loader.ts:78-122` | `extractMetaViaWorker()` |
| **WorkerFactory** | 把用户脚本 + 注入代码打包成 Worker 源码 | `worker-script.ts:55-` | `buildWorkerScript()` |
| **AgentPool** | Pi 子进程 FIFO 池,有界并发 | `agent-pool.ts:81-180` | `enqueue() / drain() / run() / spawnAndParse()` |
| **Orchestrator** | 生命周期、Worker 路由、callCache、budget | `orchestrator.ts` | `run() / pause() / resume() / abort() / retryNode() / skipNode()` |
| **StateMachine** | 7 态状态机,所有转移校验 | `state.ts:140-` | `transitionStatus()` |
| **BudgetEnforcer** | 90% 警告,100% 终止 | `orchestrator.ts:520-590` | `checkBudget() / scheduleTimeBudgetCheck()` |
| **TraceRecorder** | 写 append-only trace entries | `execution-trace.ts:31-` | `appendTraceNode() / loadTrace() / getTraceSummary()` |
| **Persistence** | 通过 `pi.appendEntry` 写 Session JSONL | `orchestrator.ts:613-615` | `persistState()` |
| **Reconstructor** | 从 JSONL 重建 instances | `index.ts:85-114` | `reconstructState(ctx)` |
| **Renderer (TUI)** | 进度面板(setWidget + custom overlay) | `widget.ts` | `renderWorkflowList() / renderWorkflowDetail()` |
| **Renderer (GUI)** | `_render` 描述符(task-list / summary-table) | `index.ts:118-150` | `buildRender()` |
| **Notifier** | 终态时通过 `pi.sendMessage` 通知 | `commands.ts:25-52` | `sendCompletionNotification()` |

### 2.5 设计决策的边界

| 决策 | 选择 | 文件/行 | 原因 |
|------|------|---------|------|
| 编排语言 | JavaScript (CJS) | `worker-script.ts:75` | Pi 运行在 Node 进程,直接用 Worker eval |
| ESM vs CJS | CJS(显式拒绝 import/export) | `tool-generate.ts:81-100` | Worker 跑在 CJS 模式,用户脚本也要 CJS |
| Meta 提取 | **Worker 隔离** import | `config-loader.ts:78-122` | 防止失败脚本污染主进程模块缓存,提供沙箱 |
| Worker 复用 | **每次 resume 都新建 Worker** | `orchestrator.ts:run()/resume()` | Worker 不可重启,只能 new;callCache 跨 Worker 传递 |
| Agent 执行 | `spawn("pi", ...)` | `agent-pool.ts:288-301` | 复用 Pi 二进制,隔离 session |
| Default concurrency | 4 | `agent-pool.ts:50` | 与 Claude Code 的 16 不同(更保守,因为是真实 spawn) |
| Budget 终态 | `budget_limited` / `time_limited` 单独终态 | `state.ts:51-58` | 区分"被预算杀死"和"主动终止" |
| 持久化粒度 | **每次状态变更都写 JSONL** | `orchestrator.ts:613-615` | 强一致,代价是 JSONL 体积大;rehydrate 时按 runId 去重 |
| 跨 session 恢复 | 支持 | `index.ts:85-114` | callCache 持久化,resume 时按 callId 回放 |
| 临时 workflow | `.pi/workflows/.tmp/` | `commands.ts:478-490` | AI 生成的临时脚本,用户确认后用 `save` 移到 saved |
| 用户输入路径 | 中间 user input **不支持** | 推断:无 `prompt` 类型的 input 节点 | 与 Claude Code 文档一致,workflow 不能中途提问 |
| TUI 面板 | setWidget + custom overlay 双层 | `widget.ts` | 列表用 setWidget,详情用 ui.custom() 弹层 |
| GUI 描述符 | `_render: { type, data }` 嵌入 details | `index.ts:118-150` | 与 xyz-agent Vue 组件约定的渲染协议 |

---

## 三、整体架构

### 3.1 文件结构(README + 实际)

```
extensions/workflow/
├── index.ts             # 入口: 工具/命令/事件注册 (648 行)
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts         # 实际入口 (648 行,目录里的)
    ├── orchestrator.ts  # 核心运行时 (724 行)
    ├── agent-pool.ts    # Pi 子进程池 (373 行)
    ├── worker-script.ts # Worker 注入生成器 (214 行)
    ├── state.ts         # 状态机 + 序列化 (262 行)
    ├── config-loader.ts # workflow 发现 (271 行)
    ├── budget.ts        # 纯计算 (88 行,目前未在主流程使用)
    ├── execution-trace.ts# append-only 追踪 (228 行)
    ├── commands.ts      # /workflow 命令 (527 行)
    ├── tool-generate.ts # AI 生成工具 (190 行)
    └── widget.ts        # TUI 面板 (291 行)
```

**总规模**:3930 行 TypeScript(主流程 + 注释)。

### 3.2 三层架构

```
┌─────────────────────────────────────────────────────┐
│ Layer 1: Pi 进程 (Extension 宿主)                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ UI 层 (TUI)                                  │  │
│  │  - setWidget("workflow", renderWorkflowList) │  │
│  │  - /workflows 交互面板                       │  │
│  │  - detail overlay (Ctrl+O)                   │  │
│  └──────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────┐  │
│  │ 工具/命令层 (注册到 Pi)                       │  │
│  │  - workflow 工具 (create/start/pause/etc)   │  │
│  │  - workflow-run 工具 (启动新 run)           │  │
│  │  - workflow-generate 工具 (AI 生成)         │  │
│  │  - /workflow 命令 (run/list/abort/save)     │  │
│  │  - /workflows 交互面板命令                  │  │
│  └──────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────┐  │
│  │ Orchestrator (per session 单例)              │  │
│  │  - instances: Map<runId, WorkflowInstance>  │  │
│  │  - workers: Map<runId, Worker>              │  │
│  │  - agentPool: AgentPool                     │  │
│  │  - persistState() → pi.appendEntry          │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
          ↓ Worker 线程                       ↓ child_process
┌─────────────────────────────┐   ┌────────────────────────────┐
│ Layer 2: Worker 线程        │   │ Layer 3: Pi 子进程          │
│  - eval user script         │   │  - pi --mode json -p       │
│  - inject agent/parallel/   │   │  - --no-session             │
│    pipeline/$ARGS globals   │   │  - 一次 agent call 一进程   │
│  - postMessage to main      │   │  - 解析 JSONL 输出         │
│  - CJS, 无 import/export    │   │  - 收集 usage              │
└─────────────────────────────┘   └────────────────────────────┘
```

### 3.3 消息协议(Worker ↔ Main)

来源:`worker-script.ts:30-50` 注释 + orchestrator.ts 的处理函数。

**Worker → Main**:
```typescript
{ type: "agent-call", callId: number, opts: AgentCallOpts }
{ type: "return", runId: string, result: unknown }
{ type: "error", runId: string, error: string }
{ type: "log", phase: string, message: string }  // worker-script.ts: log()
```

**Main → Worker**:
```typescript
{ type: "agent-result", callId: number, result: AgentResult, cached: boolean }
{ type: "budget-warning", budget: unknown, reason: string }
{ type: "abort", reason: string }
```

**关键点**:
- `cached: boolean` 区分 cache hit / miss
- `_runId` 通过 `workerData.args._runId` 注入,Worker 错误时也能回传 runId
- 消息处理有 stale state 守卫(`orchestrator.ts:344-351`),避免 pause/abort 后还处理

### 3.4 持久化与恢复

```
用户写脚本
    ↓
.pi/workflows/<name>.js       (saved)        或
.pi/workflows/.tmp/<name>.js  (tmp, AI 生成)
    ↓ loadWorkflows()
[Meta 提取] → CachedWorkflowMeta
    ↓ orchestrator.run()
[Worker 启动] → 执行 user script
    ↓
[每次状态变更] → persistState() → pi.appendEntry("workflow-state", serialized)
    ↓
[Session JSONL]
    ↓ session_start
[reconstructState] → deserializeState → restoreInstances
```

**关键设计**:
- 持久化按 runId 单独条目(append-only)
- reconstructState 时按 runId 去重,只保留最后一份(从代码注释:"Deduplication and pruning happen naturally in reconstructState")
- GC 策略:代码里说"old entries accumulate in the JSONL but are ignored on rehydrate" — 永不删除,JSONL 会膨胀(已知 trade-off)

### 3.5 隔离与安全

| 边界 | 隔离方式 | 文件/行 |
|------|---------|---------|
| Workflow 脚本 ↔ 主进程 | Worker 线程,eval 模式 | `worker-script.ts:75` `new Worker(code, { eval: true })` |
| Meta 提取 ↔ 主进程 | 临时 Worker,10s 超时 | `config-loader.ts:75-122` |
| Agent call ↔ 主线程 | Pi 子进程,`--no-session` | `agent-pool.ts:295-302` |
| Agent call ↔ Agent call | FIFO 队列,默认 4 并发 | `agent-pool.ts:50` |
| Workflow 中途用户输入 | **不支持**(无对应 API) | 推断:与 CC 行为一致 |
| 子 agent 模式 | Pi 子进程,可设 model,无法强制 acceptEdits | 与 CC 差异点 |

### 3.6 可观测性

| 维度 | 实现 |
|------|------|
| 进度 | setWidget 实时刷新(每次 trace 节点变化) |
| Token 消耗 | orchestrator 内 budget 累加,renderWorkflowDetail 显示 |
| 单个 agent | widget 的 `renderWorkflowDetail` 列出所有 trace node,显示 prompt 预览 + status + duration |
| 跨 run | `renderWorkflowList` 列表 |
| 失败 | `error` 字段写回 instance,widget 红色显示 |
| 调用链 | execution-trace.ts 提供 loadTrace / getTraceSummary,但需要 sessionManager.getEntries() 读 JSONL |

### 3.7 失败处理

| 失败类型 | 行为 | 位置 |
|---------|------|------|
| Agent 错误 | 重试 3 次,指数退避 1s/2s/4s | `orchestrator.ts:MAX_AGENT_RETRIES=3` |
| Worker 错误(uncaught) | 重试 3 次,指数退避,失败后 mark `failed` | `orchestrator.ts:MAX_WORKER_RETRIES=3` |
| 脚本级错误(`type: "error"`) | 同上,3 次重试 | `orchestrator.ts:handleScriptError` |
| Token budget 超 | 终止 Worker,mark `budget_limited` | `orchestrator.ts:checkBudget` |
| Cost budget 超 | 同上 | 同上 |
| Time budget 超 | setTimeout,mark `time_limited` | `orchestrator.ts:scheduleTimeBudgetCheck` |
| 90% budget 警告 | 发送 `budget-warning` 消息,标记 `_budgetWarningSent` 防止重复 | `orchestrator.ts:checkBudget` |
| 状态机非法转移 | throw,工具返回 isError | `state.ts:transitionStatus` |
| Workflow 不存在 | 工具返回 "not found",由 `sendUserMessage` 让 AI 处理 | `commands.ts:run` 子命令 |

### 3.8 性能与扩展

- **Worker 池**:**无**,每个 run 一个 Worker,run 结束销毁。`orchestrator.workers` 是 `Map<runId, Worker>`,没看到池化。
- **Pi 进程池**:**有**,`AgentPool` 复用进程(理论上,但每次都 `spawn` 新进程,所以"池"实际是 FIFO 调度,不是进程复用)。代码里说"FIFO 队列",不是真正的连接池。
- **JSONL 写入**:每次状态变更都 `appendEntry`,高频率写可能有 IO 压力(已知 trade-off)。

---

## 四、重要领域模型

### 4.1 Workflow 脚本模型

```typescript
// 实际约束来自 tool-generate.ts:81-160 的校验
interface WorkflowScript {
  /** 必填 */
  meta: {
    name: string;          // 不能与现有 workflow 重名
    description: string;   // 可选但建议
    phases: string[];      // 可选
  };

  /** 入口:顶层 await (IIFE 不需要显式) */
  body: string;  // CJS,不允许 import/export(除了 'export const meta')

  /** 至少一次 agent() 调用 */
  // (tool-generate.ts:103-109 强制校验)
}
```

**支持的高级模式**:
- `module.exports.execute` 模式:`worker-script.ts:170-174` 自动调用,但需在底部直接 await(代码注释)
- IIFE 顶层 await:由 `buildWorkerScript` 包装成 async IIFE,所以用户脚本可以顶层 await

### 4.2 Meta block 模型

```typescript
interface Meta {
  name: string;          // 唯一标识,出现在命令和面板
  description: string;   // 列表副标题,AI prompt snippet 来源
  phases: string[];      // 进度面板分组(纯 UI 概念,不影响控制流)
}
```

提取:`config-loader.ts:78-122` 在临时 Worker 中 import,提取 `mod.meta`,校验字段类型。

### 4.3 Agent 调用模型

```typescript
// 来自 worker-script.ts:99-128,支持 3 种签名(CC 兼容)
interface AgentCallOpts {
  prompt: string;          // 必填
  schema?: object;         // 可选,JSON Schema
  model?: string;          // 可选,"router-openai/glm-5.1" 等
  description?: string;    // 可选,日志和 widget 显示用
}
```

**支持的调用形式**(`worker-script.ts:99-128`):
```javascript
agent("prompt")                                  // 字符串
agent("prompt", { label, schema, model })        // 字符串 + 选项
agent({ prompt, schema, model, description })    // 选项对象
agent({ task, agent })                           // 兼容 task/agent 字段
```

**关键差异 vs Claude Code**:
- CC:模型支持 `model: "opus"`(简单别名)
- pi-workflow:模型支持 `model: "router-openai/glm-5.1"`(完整 provider/model 路径)
- pi-workflow:AgentPool 内对 prompt 注入 schema 指令(代码注释:Build the prompt: if schema is provided, instruct the model to output valid JSON matching the schema, then append the prompt)

### 4.4 Schema 模型(结构化输出)

```javascript
// 用法与 CC 一致(JSON Schema 子集)
const verdictSchema = {
  type: "object",
  properties: {
    fixed: { type: "boolean" },
    notes: { type: "string" }
  }
};
```

**实现**:
- `agent-pool.ts:209-218`:prompt 前置 schema 指令
- `agent-pool.ts:262-269`:JSON.parse 输出
- 失败时 `parsedOutput` 为 undefined,只暴露 `output` 字符串

### 4.5 编排原语

```typescript
// 注入到 Worker 全局
declare function agent(opts: AgentCallOpts | string, opts2?: Partial<AgentCallOpts>): Promise<any>;
declare function parallel(calls: AgentCallOpts[] | (() => Promise<any>)): Promise<any[]>;
declare function pipeline(stages: Array<(prevResult?: any) => Promise<any>>): Promise<any>;
declare function phase(name: string): void;          // 仅更新 _currentPhase
declare function log(msg: string): void;             // 发送到主线程 { type: "log" }
declare const $ARGS: Record<string, any>;            // 来自 /workflow run --args
declare const $WORKSPACE: string;                    // process.cwd()
declare const $BUDGET: Budget;
```

**关键差异**:
- pi-workflow 的 `parallel` **不接 function**,只接数组(CC 文档里 `parallel(results => ...)` 模式在 pi-workflow 不可用)
- pi-workflow 的 `pipeline` 接 **函数数组**,每阶段接收前阶段结果
- pi-workflow 多了 `log()` 和 `$WORKSPACE`、`$BUDGET`,CC 没有

### 4.6 Run 状态机模型(7 态)

```typescript
// state.ts:51-58
type WorkflowStatus =
  | "created"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "aborted"
  | "budget_limited"
  | "time_limited";

// 合法转移 (state.ts:62-72)
VALID_TRANSITIONS = {
  created: ["running"],
  running: ["paused", "completed", "failed", "aborted", "budget_limited", "time_limited"],
  paused: ["running", "aborted"],
  completed: [], failed: [], aborted: [], budget_limited: [], time_limited: []
};
```

**关键**:
- 只有 `running ↔ paused` 是双向
- 5 个终态(completed / failed / aborted / budget_limited / time_limited)都不可逆
- `created` 只能 `→ running`,无 `→ paused`(直接进入 running)
- 状态机由 `transitionStatus()` 强制,所有变更都走它

### 4.7 CallCache 模型

```typescript
// state.ts:122-127
interface WorkflowInstance {
  callCache: Map<number, AgentResult>;
  // ...
}

// AgentResult (state.ts:46-58)
interface AgentResult {
  content: string;          // 原始文本输出
  parsedOutput?: unknown;   // schema 解析结果
  usage?: AgentUsage;       // { input, output, cacheRead, cacheWrite, cost, contextTokens, turns }
  durationMs?: number;
  error?: string;
}
```

**作用**:
- pause/resume 时,Worker 重建,callCache 通过 `workerData.callCache` 传入
- worker-script.ts:72-75 重建 `_callCache` 为 Map
- worker-script.ts:117-121:agent() 先查 cache,命中直接返回
- 重试时 `orchestrator.retryNode(runId, callId)` 移除 cache,强制重新 dispatch

**关键**:
- **key 是 callId**(单调递增整数,Worker 内 `_callIdCounter`)
- callId 与 trace 节点 `stepIndex` 1:1 对应
- **同一个 run 跨 resume 后,callId 计数会重置**(因为 Worker 是新的),但 cache 内容保留 → resume 不会重跑已完成的 call

### 4.8 Trace 模型

```typescript
// state.ts:117
interface ExecutionTraceNode {
  stepIndex: number;       // 对应 callId
  agent: string;           // 描述
  task: string;            // prompt 前 200 字符
  model: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
  result?: AgentResult;
  error?: string;
}
```

**两层存储**:
- `instance.trace: ExecutionTraceNode[]` — 内存中,跟 instance 一起持久化
- 单独的 `workflow-trace` JSONL entry — append-only,`loadTrace` 按 stepIndex 取最新

**两层冗余**(从代码注释看是有意为之):
- 内存层:实时访问
- JSONL 层:独立 append,失败恢复

### 4.9 Budget 模型

```typescript
// state.ts:33-38
interface WorkflowBudget {
  maxTokens?: number;       // 软限制,90% 警告,100% 终止
  maxCost?: number;
  maxTimeMs?: number;       // 通过 setTimeout 强约束
  usedTokens: number;       // 累加 usage.input + usage.output
  usedCost: number;
  _budgetWarningSent?: boolean;  // 90% 警告只发一次
}
```

**触发**:
- `checkBudget()` 在每次 agent 完成时调用
- `scheduleTimeBudgetCheck()` 启动时 setTimeout
- 超限:`terminateWorker` + mark 终态

**预算恢复**:
- `resume()` 时重新调度 time budget(orchestrator.ts:resume())
- token / cost 累加值在 `callCache` 持久化时一并持久化

### 4.10 持久化模型

```
Session JSONL
├── standard entries (Pi 内置)
├── { type: "custom", customType: "workflow-state", data: SerializedStateEntry }
│   └── 每次状态变更追加一条(append-only)
└── { type: "custom", customType: "workflow-trace", data: { runId, node } }
    └── 每个 trace 节点变更追加一条
```

**序列化**:
- `state.ts:serializeState` → `serializeInstance` → 把 Map 拍成 array
- `deserializeState` 反向,missing 字段给默认值(向后兼容)

**反序列化(关键)**: `index.ts:85-114`
```typescript
function reconstructState(ctx: ExtensionContext): Map<string, WorkflowInstance> {
  const instances = new Map<string, WorkflowInstance>();
  const entries = ctx.sessionManager.getBranch();  // 当前分支
  for (const entry of entries) {
    if (entry.type !== "custom" || custom.customType !== ENTRY_TYPE) continue;
    const restored = deserializeState(custom.data);
    for (const [runId, instance] of restored) {
      instances.set(runId, instance);  // 后写覆盖前写,自动 dedup
    }
  }
  return instances;
}
```

**JSONL 膨胀问题**(代码注释自承认):
> Old entries accumulate in the JSONL but are ignored on rehydrate.

→ 已知 trade-off,无 GC 机制。

### 4.11 集成点

| 集成点 | 行为 | 文件 |
|--------|------|------|
| **Pi Session** | 持久化通过 `pi.appendEntry` | `orchestrator.ts:613-615` |
| **Pi TUI** | `setWidget` + `ui.custom` overlay | `widget.ts` |
| **Pi Tools** | `registerTool({ name: "workflow", ... })` | `index.ts:184-` |
| **Pi Commands** | `registerCommand({ name: "workflow", ... })` | `commands.ts` |
| **Pi Shortcuts** | `registerShortcut` (Ctrl+Shift+P/X/R) | `widget.ts:243-330` (目前被注释) |
| **xyz-agent GUI** | `details._render` 描述符 | `index.ts:118-150` |
| **MCP** | Pi 子进程 `--no-session`,但可加载 MCP 配置(取决于 pi 二进制) | 推断 |
| **Subagent 模式** | `tool-generate.ts:170-187` 提示用户: agent 默认不能交互,需要交互用 subagent | 文档式集成 |

---

## 五、能力边界

### 5.1 强项

- **跨会话恢复**:`callCache` + `paused ↔ running` + JSONL rehydrate,长时间任务不丢
- **完整状态机**:7 态精确控制,所有转移强制校验,失败有明确分类
- **三层隔离**:Worker 线程 / Pi 子进程 / Pi 进程本身,边界清晰
- **强持久化**:所有状态变更同步落 JSONL,session 崩溃也能恢复
- **AI 集成闭环**:`/workflow-generate` 工具 + 校验 + 临时目录 + `/workflow save` 持久化,完整 loop
- **双重渲染**:TUI widget + GUI `_render` 描述符,适配 xyz-agent
- **细粒度 budget**:3 重预算(token/cost/time)+ 90% 警告,比 CC 公开的多
- **可重试单节点**:`retryNode(runId, callId)` 只重试一个 callId,其他用 cache
- **可跳过单节点**:`skipNode(runId, callId)` 注入 placeholder

### 5.2 弱项/限制

- **默认并发低**:`AgentPool` 默认 4 并发,CC 是 16
- **每 run 一 Worker**:`workers` map 无池化,不能跨 run 复用
- **Pi 子进程每次都 spawn**:`AgentPool` 名义上是 pool,实际每次都 `spawn` 新进程,无真复用
- **JSONL 膨胀**:append-only + 无 GC,长 session 会很大
- **Meta 提取性能**:每次 `loadWorkflows` 都要起临时 Worker 跑 `import()`,60s cache(冷启动慢)
- **临时 workflow 限制**:`.tmp` 路径有,需要手动 `/workflow save` 移到 saved
- **`parallel` 不支持函数**:`parallel(results => ...)` 模式不可用,必须用 `Promise.all` 链式
- **Schema 解析简单**:直接 `JSON.parse`,无 zod 校验,错误输出无法恢复
- **跨 Pi 进程不共享**:每次 agent call 启动新 Pi 进程,模型加载、工具发现等有开销
- **CJS 限制**:用户脚本不能用 import/export(只允许 `export const meta`)

### 5.3 不擅长

- **中途交互**:workflow 中间不能问用户问题(API 层不支持)
- **真正的可视化**:TUI 文本 widget,不能像 CC 那样有 sub-agent 工具调用可视化(从代码看不深入)
- **深度 nested**:workflow 脚本可以嵌套调用,但没有专门的"子 workflow" API
- **模型热切换**:不能在 mid-run 切模型,只能在 `agent({ model })` 单点指定

---

## 六、与其他 Pi 扩展的对比

来自项目内 ADR/CLAUDE.md:

| Pi 扩展 | 与 workflow 关系 |
|--------|-----------------|
| **goal** | goal 是目标驱动的循环,workflow 是任务驱动的脚本;goal 可调用 workflow 作为子任务(在 tool list 里有 `workflow-run`) |
| **todo** | todo 是轻量任务清单,workflow 是有编排的复杂任务;workflow 内 agent 调用是 todo 不可表达的 |
| **subagent (npm)** | 来自 pi-subagents;workflow 的 agent call 内部**不**用 pi-subagents,而是直接 `spawn("pi", --mode json)`,但 prompt snippet 提到"需要交互用 subagent" |
| **coding-workflow** | xyz-harness 5 阶段工作流,内嵌 20+ skills;workflow 是更通用的脚本容器 |
| **coding-workflow-gate** | 验证每个 phase 产出;与 workflow 无关 |

**互补关系**:
- workflow 适合"我有 JS,我想要并行 + 状态机"
- goal 适合"我有目标,我要 AI 帮我拆任务 + 自我驱动"
- coding-workflow 适合"我有 spec/plan/test cases,我要走 5 阶段"

---

## 七、与 Claude Code dynamic workflows 的关键相似点

> 这一节是铺垫,为下一节"功能差异对比"提供基线。

| 维度 | 相似点 |
|------|--------|
| 形态 | 都是 JavaScript 脚本 |
| API 表面 | `agent/parallel/pipeline/phase/$ARGS` 五件套一致 |
| Schema 约束 | 都是 JSON Schema |
| 中间结果隔离 | 都在脚本变量,不在主会话上下文 |
| 子 agent 模式 | 都"隔离上下文窗口"(实现方式不同) |
| 内置 workflow | 都有内置命令(pi-workflow 用 `/workflow-generate`,CC 用 `/deep-research`) |
| 状态机 | 都有 running / paused / completed / failed / aborted(CC 公开材料未明确,推断) |
| 持久化路径 | 都是 `.claude/workflows/` vs `.pi/workflows/` 项目级 + 全局级 |

---

## 八、与 Claude Code dynamic workflows 的关键差异

> 下一节详述。这里只点出最显著的 5 条:

1. **跨会话恢复**:pi-workflow 支持,CC 不支持
2. **AI 即时生成 UX**:pi-workflow 有显式 `workflow-generate` 工具 + `.tmp` 目录 + `/workflow save` 三步,CC 用关键词触发
3. **预算维度**:pi-workflow 有 token/cost/time 3 重 + 90% 警告,CC 公开只有 16 并发 / 1000 agent 硬限制
4. **节点级控制**:pi-workflow 有 `retryNode / skipNode`,CC 只有 run-level pause/abort
5. **持久化粒度**:pi-workflow 把 run 状态写 JSONL,CC 是纯内存
