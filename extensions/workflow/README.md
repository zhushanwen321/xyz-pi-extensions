# workflow

多 Agent 编排引擎 — 用 JS 脚本描述任务流程，Worker 线程隔离执行，支持 `agent()` / `parallel()` / `pipeline()` API。

## 功能

- **脚本驱动**：在 `.pi/workflows/` 下写 JS 脚本定义流水线
- **三种编排 API**：`agent()`（单个）、`parallel()`（并发）、`pipeline()`（串行 / 笛卡尔积）
- **两层进程隔离**：用户脚本跑在 Worker 线程，每次 `agent()` 调用再 spawn 一个独立 `pi --mode json` 子进程
- **暂停/恢复**：支持暂停/恢复，已完成的 agent 调用靠 callCache 不重复执行
- **跨会话恢复**：Pi 重启后自动检测中断的 workflow（有局限，见下文）
- **预算控制**：Token / 时间双预算（软限制，见下文）
- **结构化输出**：agent 调用支持 `schema` 参数，模型通过 `structured-output` tool 返回校验过的 JSON

## 安装

```bash
# 正式方式（唯一推荐）
pi install npm:@zhushanwen/pi-workflow
```

> 仅 dev 调试时可 symlink 本地源码，**禁止用于日常使用**：
> `ln -s /path/to/xyz-pi-extensions-workspace/<分支>/extensions/workflow ~/.pi/agent/extensions/workflow`

## 快速开始

在 `.pi/workflows/` 下创建 `.js` 文件。脚本跑在 async IIFE 中，**顶层 `return` 的值会作为 workflow 结果回传**，无需自己包 IIFE：

```javascript
const meta = { name: 'batch-review', description: '批量审查 src 下的文件', phases: ['scan', 'review'] };

// 阶段 1：拿到文件清单（用 schema，不要让模型输出 JSON 再 parse）
const list = await agent({
  prompt: '列出 src/ 下所有 .ts 文件的相对路径',
  schema: {
    type: 'object',
    properties: { files: { type: 'array', items: { type: 'string' } } },
    required: ['files'],
  },
  description: 'list-files',
});

// 阶段 2：并发审查（parallel 自动限流到并发 4）
const reviews = await parallel(
  list.files.map((f) => ({
    prompt: `审查 ${f} 的潜在问题`,
    schema: { type: 'object', properties: { issues: { type: 'number' } }, required: ['issues'] },
    description: `review-${f}`,
  })),
);

return { reviewed: list.files.length, totalIssues: reviews.reduce((n, r) => n + r.issues, 0) };
```

完整脚本规范见 [`skills/workflow-script-format/SKILL.md`](./skills/workflow-script-format/SKILL.md)。

## 运行

```
/workflow run my-review
/workflow run my-review --tokens 50000 --time 600000
/workflows              # 全屏 TUI 面板（三级导航：列表 → run → trace）
```

或让 AI 通过 `workflow-run` tool 调用。Workflow 在后台 Worker 线程执行，完成时自动以 steering 消息唤醒主 agent，**无需轮询状态**。

## Tools

扩展注册 4 个 tool：

| Tool | 作用 | 关键参数 |
|------|------|---------|
| **workflow-run** | 启动 / 发现 workflow | `name`（精确名或自然语言）、`mode`（auto/force）、`args`、`tokens`、`time` |
| **workflow** | 控制已运行的实例 | `action`（pause/resume/abort/status）、`runId` |
| **workflow-generate** | 生成 tmp 脚本 | `name`、`script`、`description` |
| **workflow-lint** | 静态检查脚本 | `name` |

**给 AI 的行为约束（promptGuidelines 摘要）：**
- 用户说 "workflow" / "run X" 时，**优先 workflow-run**，不要先读 skill 文档（tool 自带发现）
- 启动后**不要轮询 status**，结果会自动回来；只有用户明确问进度才查
- `workflow` 只做生命周期控制，**启动新 workflow 用 workflow-run**

**workflow-run 发现逻辑（三级漏斗）：**
1. 精确名匹配 → 2. 按 name+description 分词模糊匹配 → 3. 返回全列表 + 建议
- `auto` 模式（默认）：首次运行已保存脚本需用户确认，同 session 内复用确认（tmp 脚本每次都确认）；无 UI（RPC）时发 steer 让 AI 自决
- `force` 模式：跳过确认（仅用户明确要求时用）

## Commands

### `/workflow`

| 子命令 | 行为 |
|--------|------|
| `run <name> [--args k=v ...] [--tokens N] [--time N]` | 启动；未找到时转交 AI 路由 |
| `list` | 列运行实例 + 可用脚本（带 `[source]` 标签） |
| `abort <run-id>` | 终止运行中的实例 |
| `save <tmp-name> [--as <new-name>]` | tmp 脚本固化到 `.pi/workflows/`（重名拒绝，不自动改名） |
| `delete <name>` | 删除 tmp 或已保存脚本（运行中拒绝） |

### `/workflows [runId]`

全屏 TUI 面板。无参时按 running > paused > completed 排序；多实例用 SelectList，单实例直进详情。实时更新走事件订阅 + 1s tick 双通道。

## Architecture

四层 + 共享域模型，依赖方向严格向下：

```
┌─────────────────────────────────────────┐
│  Factory (src/index.ts, ~155 行)        │  纯胶水：状态持有 + 事件注册 + 调用 register*
├─────────────────────────────────────────┤
│  Interface (src/interface/)             │  Pi API 表面：tool/命令参数解析 → 调用 Engine → 格式化输出 + TUI
├─────────────────────────────────────────┤
│  Engine (src/engine/) + src/orchestrator│  状态机 + Worker 协调 + agent 调度 + 预算
├─────────────────────────────────────────┤
│  Infrastructure (src/infra/)            │  子进程执行 / JSONL 解析 / 状态持久化 / 文件扫描
└─────────────────────────────────────────┘
          ↕ 所有层共享
┌─────────────────────────────────────────┐
│  Domain Model (src/domain/)             │  纯数据 + 状态机，零依赖
└─────────────────────────────────────────┘
```

依赖规则：Factory → Interface → Engine → Infrastructure。任何层 → Domain Model。反向禁止。

> 编排核心 `orchestrator.ts` 在 `src/` 根（不在 `engine/` 下），因为它是 engine/infra 的协调枢纽，被 interface 层直接依赖。

### 两层进程隔离

```
主 Pi 进程
  └─ Worker 线程（每个 workflow 一个，跑用户 JS 脚本）
       └─ pi 子进程（每次 agent() 调用 spawn 一个，跑 --mode json）
```

- **Worker 隔离**：用户脚本的同步异常/未捕获 rejection 不波及主进程；脚本可用 `await`
- **子进程隔离**：每次 LLM 调用上下文彻底干净；abort 时 `SIGKILL` 子进程

### 状态机（8 态）

```
                 ┌────────────────────────────────────┐
                 │                                    │
                 ▼                                    │
  running ◄───pause────► paused                       │
    │  ▲                    │                         │
    │  └────resume──────────┘                         │
    │                                                │
    ├──► completed         (终态)                     │
    ├──► failed            (终态)                     │
    ├──► aborted           (终态) ◄─── pause/abort ───┘
    ├──► budget_limited    (终态，token/cost 超限)
    ├──► time_limited      (终态，wall-clock 超时)
    └──► (state_lost)      (终态，仅外部赋值：状态文件损坏时由恢复逻辑创建)
```

- `running ↔ paused` 是唯一双向转换
- 6 个终态不可逆：`completed / failed / aborted / budget_limited / time_limited / state_lost`
- `state_lost` 不由内部状态机产生，仅在 `reconstructState` 读不到状态文件时创建占位实例

### 预算控制（软限制）

`--tokens` / `--time` 是**软限制**，明确接受被突破：budget 检查在每个 agent call 完成后进行，若 Worker 在检查生效前连续 enqueue N 个调用，这 N 个仍会执行并累加 token，实际消耗可达 `maxTokens × 并发度`（默认并发 4）。如需更紧的上限，需在脚本内用 `$BUDGET.remaining()` 自行守卫。

### 结构化输出（`schema` 参数）

`agent({ schema })` 的链路：
1. schema 被写成 MANDATORY 指令临时文件 → `pi --append-system-prompt`
2. schema JSON 通过 `PI_WORKFLOW_SCHEMA` 环境变量激活 `@zhushanwen/pi-structured-output` 扩展（peerDep）
3. 模型**必须**在最后主动调用 `structured-output` tool 返回 JSON
4. 从 `tool_execution_end.result.details` 提取 `parsedOutput`（已校验数据）

**失败模式**：若模型没调 structured-output tool，`agent()` 返回 `{ success: false, error: "Agent did not call structured-output tool" }`。所以 `schema` 不是"保证 JSON"，而是"要求模型主动调 tool"——prompt 质量决定成败。

### 跨会话恢复（及局限）

Pi 重启后，`session_start` 触发 `reconstructState`：从 session JSONL 读 `workflow-state-link` 指针 → 读独立状态文件 → 还原实例（含 callCache/trace/budget）。状态文件损坏则创建 `state_lost` 占位实例。

**已知局限：**
- `runMetaMap` 不持久化 → 恢复的实例**无法真正 resume**（只转状态不重启 worker）
- `session_start` 不降级 running 状态 → 重启后可能看到"假 running"，需手动 pause/resume
- 只有 `session_tree`（切分支）会把 running 强制降级为 paused

### callCache 与确定性

`agent()` 调用按**单调递增的 callId**（从 0 起，按调用顺序）缓存结果，不是按 prompt hash。pause 时杀 Worker 但保留 callCache；resume 时把 callCache 注入新 Worker，命中的 callId 直接 resolve、不重跑。

**因此脚本必须确定性有序**：`parallel()` 内的调用顺序不能随机，否则 pause/resume 重放会错位命中。无 script hash 校验——**改脚本后 resume 会用旧结果**，开发期改脚本应重新 run 而非 resume。

### 重试策略

- **agent call 失败**：指数退避重试 3 次（1s/2s/4s）。例外：stale context error 不重试（重试只会再失败）；budget 超限时不重试
- **worker script error**：指数退避重试 3 次，每次 terminate + 重启 worker
- 两层独立计数，`retry-node` 操作会清空 retry 计数

### 消息协议（Worker ↔ Main）

| 方向 | type | 触发 |
|------|------|------|
| Worker→Main | `agent-call` | 脚本调 `agent()` 且 cache miss |
| Worker→Main | `return` | 脚本正常结束（带 result） |
| Worker→Main | `error` | 脚本抛异常 |
| Worker→Main | `log` | 脚本调 `log()` |
| Main→Worker | `agent-result` | cache 命中 / agent 执行完 |
| Main→Worker | `budget-warning` | 90% 阈值警告 |
| Main→Worker | `budget-update` | 每个 agent 完成后推送消耗 |

### Agent 与 Skill 发现

**agent 发现（7 级路径，后者覆盖前者）：** `extensions/*/agents/`、`.pi/agents/`、npm 包（含 `@scope/name`）等。

**skill 发现（3 级路径）：** 路径集合与 agent 不同（无 `.pi/agents`、不处理 `@scope`）。

二者不重叠——`agent({agent:"x"})` 找得到不代表 `agent({skill:"x"})` 找得到，反之亦然。

### 脚本发现（三个来源）

`loadWorkflows()` 扫描三处，**同名优先级 tmp > project > user**：
1. `.pi/workflows/`（项目级，已保存）
2. `~/.pi/agent/workflows/`（用户级共享）
3. `.pi/workflows/.tmp/`（临时，workflow-generate 产出）

bare+worktree 项目靠 `.bare/`/`.pi/`/`.git/` 标记向上找 workspace root（最多 20 层）。

### JSONL 事件协议（子进程 stdout）

`pi --mode json` 子进程按行输出 JSONL，四类事件：

| 事件 | 提取 |
|------|------|
| `session` | 子会话 sessionId（首事件） |
| `tool_execution_start` | 记 pendingArgs/CallId；`structured-output` 标记 |
| `tool_execution_end` | `structured-output` 且非 error → `parsedOutput = result.details` |
| `message_end` | 累加 text 到 output；累加 usage |

> `parsedOutput` 取的是 `tool_execution_end.result.details`（扩展 execute() 返回的已校验数据），**不是** tool call 的 args。

### _render 协议（GUI 对接）

TUI 走 `renderResult`（theme 着色文本），GUI（xyz-agent）走 `details._render` 声明式描述符：
- `summary-table`：workflow tool 的实例列表（name/status/worker/duration）

workflow 到终态时发 `workflow-result` customType 消息并 `triggerTurn: true` 唤醒主 agent 处理结果。

## File Structure

```
workflow/
├── index.ts                              # 顶层入口（re-export src/index.ts）
├── README.md
├── skills/workflow-script-format/SKILL.md # 脚本编写规范（workflow-generate 自动注入）
└── src/
    ├── index.ts                          # Factory — 纯胶水：状态持有 + 事件注册 + 调用 register*（~155 行）
    ├── orchestrator.ts                   # 编排核心：状态机协调 + Worker 生命周期 + agent 调度（src/ 根）
    ├── domain/
    │   └── state.ts                      # WorkflowInstance / 状态机（8 态）/ 序列化
    ├── engine/
    │   ├── worker-script.ts              # Worker 运行时代码生成（注入 agent/parallel/pipeline 等全局）
    │   ├── agent-call-handler.ts         # agent 调用执行 + 指数退避重试
    │   ├── orchestrator-events.ts        # 实时事件订阅 API（status/trace/tick）
    │   ├── orchestrator-budget.ts        # Token/Cost/时间预算（软限制）
    │   ├── model-resolver.ts             # 模型解析：直传 opts.model（scene→model 解析已移除，见 CHANGELOG 1.1.2）
    │   └── error-handlers.ts             # worker script error 重试 + 终态处理
    ├── infra/
    │   ├── agent-pool.ts                 # 并发调度：FIFO 队列 + 有界池（默认并发 4）+ enqueue 返回永不 reject
    │   ├── state-store.ts                # 状态持久化（rewrite 模式 + workflow-state-link 指针）
    │   ├── config-loader.ts              # 脚本发现（三来源）+ meta 提取（正则，不执行用户代码）
    │   ├── agent-discovery.ts            # agent 发现（7 级路径）
    │   ├── agent-opts-resolver.ts        # agent/skill/schema → runAgent opts（临时文件注入）
    │   ├── pi-runner.ts                  # spawn pi --mode json 子进程（含 24h 硬超时兜底）
    │   ├── jsonl-parser.ts               # 子进程 stdout JSONL 流式解析
    │   ├── execution-trace.ts            # 执行追踪节点
    │   └── script-lint.ts                # 脚本静态 lint（outputSchema / result.output / 文件状态传递）
    └── interface/
        ├── tool-workflow.ts              # workflow tool（pause/resume/abort/status）
        ├── tool-workflow-run.ts          # workflow-run tool（start/discover）
        ├── tool-generate.ts              # workflow-generate tool（生成 tmp 脚本）
        ├── tool-lint.ts                  # workflow-lint tool（静态检查）
        ├── shared.ts                     # 共享类型/常量/渲染辅助（buildRender / toInstanceSummary）
        ├── commands.ts                   # /workflow + /workflows 命令 + 完成通知
        └── views/
            ├── WorkflowsView.ts          # 全屏三级导航 TUI
            └── format.ts                 # 纯格式化函数
```

> **依赖说明**：workflow 采用自包含的 `spawn pi --mode json` 子进程架构执行 agent，不依赖任何外部 agent 运行时。结构化输出依赖 peerDep `@zhushanwen/pi-structured-output`。
