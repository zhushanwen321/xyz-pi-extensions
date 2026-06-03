# Workflow 系统架构分析（修订版）

## 一、致命的 Bug：为什么 AI 不能执行自己创建的 Workflow

### 1.1 根因

问题出在 `config-loader.ts` 的 `extractMetaViaWorker()`。它会启动一个 Worker 线程，用 `import(scriptPath)` 加载脚本提取 `meta` 声明：

```typescript
// config-loader.ts extractMetaViaWorker() — 当前实现
const code = `
  const mod = await import(workerData.scriptPath);
  const raw = mod.meta;
  ...
`;
```

但是这个 Worker 只有 `parentPort` 和 `workerData`，**没有** `agent()`、`$ARGS`、`$WORKSPACE` 等运行时 injected globals。这些 globals 只存在于执行 Worker（由 `buildWorkerScript()` 注入）。

如果脚本在 top-level 引用了任何这些 globals，`import()` 直接抛 `ReferenceError`，`config-loader` 标记 `available: false`，最终 `orchestrator.run()` 抛出 "not found or unavailable"。

```
AI 写 .pi/workflows/merge-worktree.js
  → AI 调用 workflow-run(name="merge-worktree")
  → orchestrator.run → getWorkflow("merge-worktree")
  → config-loader: 发现文件存在, 启动 meta-extraction Worker
  → Worker: import("merge-worktree.js")
  → 脚本 top-level: const { files } = $ARGS;  ← ReferenceError: $ARGS is not defined
  → config-loader 标记 available: false
  → orchestrator.run: "Workflow 'merge-worktree' not found or unavailable"
```

**这是 `workflow-run` 永远不可用的根本原因**——任何引用 `$ARGS`、`agent()`、`pipeline()` 的脚本都会被 meta-extraction 杀死。

### 1.2 修复方案

**方案 A：在 meta-extraction Worker 中预先注入 stub globals**（推荐）

```typescript
// config-loader.ts — 修改 extractMetaViaWorker()
const code = `
  const { parentPort, workerData } = require("worker_threads");
  
  // 注入 stub globals，防止 import 时 ReferenceError
  globalThis.agent = () => {};
  globalThis.pipeline = () => {};
  globalThis.parallel = () => {};
  globalThis.phase = () => {};
  globalThis.log = () => {};
  globalThis.$ARGS = {};
  globalThis.$WORKSPACE = "/tmp/fake";
  globalThis.$BUDGET = { usedTokens: 0, usedCost: 0 };

  (async () => {
    try {
      const mod = await import(workerData.scriptPath);
      const raw = mod.meta;
      // ... 其余 meta 提取逻辑不变 ...
    } catch (err) { ... }
  })();
`;
```

优点：改动量极小（加 8 行），不改变现有 Worker 提取机制，`import()` 后的脚本逻辑仍然执行，但 `agent()` 是 no-op 所以不会产生副作用。

**方案 B：纯静态提取 meta**（备选）

在文件系统中读取脚本内容，正则提取 `const meta = { ... }` 或 `export const meta = { ... }`，用 `new Function()` 解析。完全跳过 Worker。

缺点：如果 meta 声明中包含运行时变量（不符合格式约定但可能存在），无法处理。优点：不需要 Worker 线程，同步且更快。

**推荐方案 A**，改动最小，不改变现有架构。

### 1.3 为什么 workflow-generate 知道文件存在但 workflow-run 不知道？

`workflow-generate` 也调用 `loadWorkflows()` 检查冲突。同一套逻辑：脚本存在 → import 失败 → `available: false`。但 `workflow-generate` 只看"名字存在就冲突"，不关心 `available`。而 `orchestrator.run()` 看了 `available` 字段再决定要不要报错。

## 二、架构全景

### 2.1 代码结构

```
extensions/workflow/src/
  index.ts           — 入口：注册 workflow + workflow-run tool，构造 orchestrator
  tool-generate.ts   — 注册 workflow-generate tool（临时脚本生成 + 验证）
  orchestrator.ts    — 核心引擎：run/pause/resume/abort，Worker 生命周期，budget 监控
  state.ts           — 状态机：8 种状态 + 状态转移规则 + 序列化/反序列化
  config-loader.ts   — 脚本发现：扫描 .pi/workflows/ + ~/.pi/agent/workflows/ + .tmp/
  worker-script.ts   — 构建执行 Worker 的包装代码（注入 agent/parallel/pipeline globals）
  agent-pool.ts      — 子 agent 调用池（管理并发 + 转发给 Pi 主 API）
  commands.ts        — 命令：/workflow + /workflows 斜杠命令
  widget.ts          — TUI 列表渲染
  model-resolver.ts  — 模型选择（scene → provider/model）
  execution-trace.ts — 执行追踪节点持久化
```

### 2.2 状态机：8 种状态，4 个是死的

```
created ──→ running ──→ completed
              ↑  ↓       failed
              │  ↓       aborted
              │  ↓       budget_limited  ← 预算耗尽
              │  ↓       time_limited    ← 时间耗尽
              │  ↓
            paused ──→ aborted
```

| 状态 | 来源 | 谁在用 |
|------|------|--------|
| `created` | `createStateInstance()` 默认状态 | `orchestrator.run()` 内部瞬时使用；`workflow tool create` 产生假实例 |
| `running` | `created→running` 或 `paused→running` | orchestrator 正常路径 |
| `paused` | `running→paused` | `workflow tool pause` 或 orchestrator.pause() |
| `completed` | Worker 正常返回 | orchestrator worker handler |
| `failed` | Worker 异常 | orchestrator worker error handler |
| `aborted` | 用户/系统中断 | `workflow tool abort` 或 orchestrator.abort() |
| `budget_limited` | 预算耗尽 | orchestrator budget checker (line 688) |
| `time_limited` | 时间耗尽 | orchestrator timer (line 714) |

**问题：`created` 状态只在两个地方出现**

1. `orchestrator.run()` — 创建后立即 `transitionStatus(instance, "running")`，存续时间约 1 微秒
2. `workflow tool create` — 创建后**永不**自动进入 running，因为没有脚本没有 Worker

路径 2 产生的实例就是一个空壳，状态为 `created`，没有 Worker，没有 trace，没有任何实际工作。用户从 `/workflows` 面板能看到它，但毫无意义。

**结论：`workflow` tool 的 `create`/`start`/`complete`/`fail` 四个 action 是僵尸代码。**

- `create`：产生无 Worker 的空壳实例
- `start`：把 `created` 变成 `running`，但没有 Worker，状态空转
- `complete`/`fail`：手动改状态，但正常执行路径由 orchestrator 自动完成
- 唯一的真实场景：用户在 TUI 面板里手动改状态玩

### 2.3 工具全景：3 Tool + 2 Command

| 入口 | 类型 | 真正有用的功能 | 僵尸功能 |
|------|------|--------------|---------|
| **`workflow`** | Tool | pause, resume, abort, status | create, start, complete, fail |
| **`workflow-run`** | Tool | run(name, args) | — |
| **`workflow-generate`** | Tool | 验证 + 写入 .tmp/ | — （自身需要 name conflict 检查，但检查到的是 broken scripts） |
| **`/workflow`** | Command | run, list, abort, save | 无 delete 子命令；未知子命令路由脆弱 |
| **`/workflows`** | Command | 交互面板 | Run 动作发消息给 AI（合理，需要确认） |

**三个 tool 不重叠**。`workflow` 管运行时控制（pause/resume/abort/status），`workflow-run` 管启动执行，`workflow-generate` 管脚本生成。但命名让 AI 困惑——叫 `workflow-run` 而不是 `workflow-execute` 或直接并入 `workflow` tool 的 `run` action。

## 三、Commands 分析

### 3.1 全部路径

```
用户输入                       处理路径
──────────                     ──────────
/workflow                      → help / usage 提示
/workflow run <name>            → orchestrator.run() → getWorkflow() → meta-extraction → 崩溃
/workflow list                  → orch.list() 显示运行实例（不显示可用脚本）
/workflow abort <runId>         → orch.abort()
/workflow save <tmpName>        → saveWorkflow() 从 .tmp/ → .pi/workflows/
/workflow <unknown>             → loadWorkflows() + api.sendUserMessage() 发给 AI 路由
/workflows                      → TUI 面板（运行实例 + 可用脚本）
```

### 3.2 问题清单

**P1: `/workflow list` 看不到可用脚本**

当前只显示运行中的实例。用户想看看有哪些 workflow 可以用，必须打开 `/workflows` 面板。

应该显示两段：运行实例 + 可用脚本。

**P2: 没有 `/workflow delete <name>`**

代码已在 `commands.ts` 中实现了 `deleteWorkflow()` 函数，但没注册为子命令。只在 `/workflows` 面板的非"Run"入口中可用。

添加只需在 switch 中加一个 `case "delete"`。

**P3: 未知子命令路由包含 `available: false` 的脚本**

```typescript
// commands.ts default 分支
const workflows = await loadWorkflows();
// 发送给 AI，包含所有脚本，包括 available: false 的
```

AI 收到的列表包含无法执行的脚本，却被告知"请确定是否匹配"。应该过滤：只发送 `available: true` 的脚本。

**P4: `pollForCompletion` 轮询完成后通知不精确**

当前 `sendCompletionNotification` 用 `notifiedRunIds` Set 去重，但 `pollForCompletion` 的 2 秒轮询可能漏掉快速完成的 workflow（如果 Worker 在第一次轮询前就结束了）。

应该用事件驱动而非轮询。orchestrator 的 Worker handler 在完成时直接通知。

**P5: `/workflow save` 的 `--as` 参数解析在 `commands.ts` 中，但 `index.ts` 的 `parseRunArgs` 也解析了 `--args`**

两个解析函数没有复用，args 解析逻辑散落两处。

### 3.3 对比 Claude Code

| 维度 | Claude Code | Pi workflow（当前）| 建议 |
|------|-------------|-------------------|------|
| 执行 | `/workflow run <name>` | 同左 + `workflow-run` tool | 保持，两条路径（用户手动 + AI tool）都合理 |
| 面板 | `/workflows` | 同左 | 保持 |
| 保存 | `/workflow save <name>` | 同左 | 保持 |
| 列表 | （面板中看） | `/workflow list`（只有运行实例） | **改**：+ 可用脚本 |
| 删除 | 无显式子命令 | 无 | **加**：`/workflow delete <name>` |
| 触发方式 | 关键词 "workflow" 自动 | 需要 AI 主动调 tool | 无法简单对齐（Pi 没有关键词触发机制） |

## 四、修复路线图

### P0：修复 meta-extraction（阻塞所有功能）

**文件**：`config-loader.ts`，仅 `extractMetaViaWorker()` 函数

**改动**：在 Worker 代码中注入 stub globals before `import()`。

```diff
  const code = `
    const { parentPort, workerData } = require("worker_threads");
+   // Stub globals referenced by workflow scripts during top-level evaluation
+   globalThis.agent = () => {};
+   globalThis.pipeline = () => {};
+   globalThis.parallel = () => {};
+   globalThis.phase = () => {};
+   globalThis.log = () => {};
+   globalThis.$ARGS = {};
+   globalThis.$WORKSPACE = "/tmp/fake";
+   globalThis.$BUDGET = { usedTokens: 0, usedCost: 0 };
    (async () => {
      try {
        const mod = await import(workerData.scriptPath);
```

**影响**：修复后，AI 可以正常使用 `workflow-run` tool 执行任何脚本。整个 workflow 系统变得可用。

### P1：删除僵尸 action + 状态

**文件**：`index.ts` + `state.ts`

1. 从 `WorkflowAction` enum 删除 `create`/`start`/`complete`/`fail`
2. 从 switch-case 删除对应分支
3. 从 `state.ts` 删除 `created` 状态及 `created → running` 转移
4. `orchestrator.run()` 内部不再先创建再转移，改为直接 `createStateInstance({ status: "running" })` — 需要给 `createInstance()` 加 `status` 参数或新增工厂

**影响**：减少约 80 行死代码，tool description 不矛盾，AI 不再困惑。

### P2：Commands 优化

**文件**：`commands.ts`

1. `/workflow list` 加可用脚本列表（与 `/workflows` 面板一致）
2. 添加 `/workflow delete <name>` 子命令
3. 未知子命令路由只发送 `available: true` 的脚本

**文件**：`orchestrator.ts`

4. 完成通知从轮询改为事件驱动（`startWorker` 回调通知而不是 2s poll）

### P3：Tool Description 打磨

**文件**：`index.ts`

`workflow-run` description 已经是三个 tool 中最清晰的。`workflow` tool 删除僵尸 action 后只剩 `pause/resume/abort/status`，description 自然正确。`workflow-generate` 保持不变。

不需要做"合并三个 tool 为一个"的重结构。

## 五、长期设计考量

### 5.1 为什么不需要把三个 tool 合并？

三个 tool 有不同的调用时机：

| Tool | 谁调用 | 什么时候调用 |
|------|--------|------------|
| `workflow-run` | AI 收到用户要求执行已存在的 workflow | "运行那个 review workflow" |
| `workflow-generate` | AI 判断无匹配脚本，需要生成临时 workflow | "帮我批量分析这些文件（很复杂）" |
| `workflow` | AI/用户需要查看状态或控制运行中的 workflow | "我的 workflow 怎么样了？"/"暂停" |

合并为一个 tool + action 参数会制造更大的 tool description（要解释 4 种 action 的场景），而分离后每个 tool description 可以专注自己场景。关键不是合并，而是 **description 说清楚"什么时候用哪一个"**。

### 5.2 `.tmp/` 目录是否该保留？

保留。`.tmp/` 和 `.pi/workflows/` 的区分有语义价值：

- `.tmp/` = AI 创建的临时脚本，生命周期短，可以被 save 提升
- `.pi/workflows/` = 人工编写或 save 后的持久脚本

删除 `.tmp/` 会让 `save` 命令失去意义（往哪存？），也让 list 时无法区分临时 vs 永久脚本。

### 5.3 `pollForCompletion` 的事件驱动替代

当前：
```typescript
// 2 秒轮询
const pollInterval = setInterval(() => {
  const inst = orch.getInstance(runId);
  if (!inst || isTerminal(inst.status)) { ... }
}, 2000);
```

建议：在 orchestrator 的 Worker completion handler 中直接调用 `sendCompletionNotification`，不经过轮询。需要在 orchestrator 创建时注入回调：

```typescript
orch.onComplete((runId, instance) => {
  sendCompletionNotification(api, runId, instance);
});
```
