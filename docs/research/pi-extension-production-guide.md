# Pi Extension 生产级开发指南

> 基于 `nicobailon/pi-subagents`、`pi-mcp-adapter`、`pi-crew` 等生产级扩展的深度调研，总结如何构建一个真正生产级的 Pi extension。

## 适用范围说明

本指南覆盖了两种层级的模式：**通用模式**（所有 Pi extension 适用）和 **子代理专项模式**（仅 spawn/manage 子进程的扩展适用）。

| 章节 | 适用层级 | 说明 |
|------|---------|------|
| 1. Pi Extension 系统概述 | 🔵 通用 | 所有扩展的基础知识 |
| 2.1 项目结构（pi-subagents 版） | 🟠 子代理专项 | 仅子代理类扩展需要 `runs/foreground/`、`agents/`、`intercom/` 等分层 |
| 2.2 package.json 核心声明 | 🔵 通用 | 所有扩展必须遵守 |
| 3.1 标准入口 | 🔵 通用 | `export default function(pi: ExtensionAPI)` |
| 3.2 子进程保护模式 | 🟠 子代理专项 | 仅 spawn 子 Pi 进程的扩展需要环境变量角色区分 |
| 4. 工具注册的完整模式 | 🔵 通用 | TypeBox schema + execute + renderCall/renderResult |
| 5. 事件生命周期管理 | 🔵 通用 | session_start/tool_result/session_shutdown 等 |
| 5.2 全局状态清理（热重载） | 🔵 通用 | 任何含定时器/FSWatcher 的扩展都需要 |
| 6. Agent 定义系统 | 🟠 子代理专项 | Markdown + YAML frontmatter，仅多 agent 配置场景需要 |
| 7. 子进程执行模式 | 🟠 子代理专项 | child_process.spawn + JSONL 流解析 |
| 8. 后台异步执行系统 | 🟠 子代理专项 | 文件系统状态机 + FSWatcher + 事件投递 |
| 9. Chain / Pipeline 执行 | 🟠 子代理专项 | 多步骤工作流编排 |
| 10. 跨会话通信（Intercom） | 🟠 子代理专项 | 父↔子跨进程通信 |
| 11. TUI 渲染系统 | 🔵 通用 | Component 接口 + Container 动态更新 + 消息渲染器 |
| 12. Acceptance Gates | 🟠 子代理专项 | 多 agent 质量门控 |
| 13. Git Worktree 隔离 | 🟠 子代理专项 | 并行任务文件系统隔离 |
| 14. 配置系统 | 🔵 通用 | `~/.pi/agent/extensions/<name>/config.json` |
| 15. 测试策略 | 🔵 通用 | 单元测试 + 集成测试 + Mock Pi API |
| 16. CI/CD | 🔵 通用 | GitHub Actions + npm publish |
| 17. 关键设计模式总结 | 🔵/🟠 混合 | 1-5 项通用，6-10 项子代理专项 |
| 18. 从零开始的 Checklist | 🔵/🟠 混合 | 前 8 项通用，后 4 项子代理专项 |

> **图例**：🔵 = 通用，所有 Pi extension 适用；🟠 = 子代理专项，仅 spawn/manage 子 Pi 进程的复杂扩展适用。
>
> 对于简单的 Tool/Command 型扩展（如 `pi-todo`、`pi-statusline`），只需关注 🔵 标记的章节即可。

## 1. Pi Extension 系统概述

Pi 的扩展系统（Extension System）是一个基于 TypeScript 的插件架构，通过 `jiti` 运行时加载 TS 模块，无需编译。扩展可以：

- **注册自定义工具**（LLM 可调用）
- **拦截/修改工具调用与结果**
- **注册命令、快捷键、CLI 标志**
- **自定义 UI 渲染**（TUI 组件、消息渲染器）
- **管理会话状态**
- **替换内置工具**
- **注册自定义模型提供者**
- **跨扩展通信**（事件总线）

### 扩展加载位置

| 位置 | 作用域 |
|------|--------|
| `~/.pi/agent/extensions/*.ts` | 全局 |
| `~/.pi/agent/extensions/*/index.ts` | 全局（子目录） |
| `.pi/extensions/*.ts` | 项目级 |
| `.pi/extensions/*/index.ts` | 项目级（子目录） |
| `package.json` → `pi.extensions` | npm 包分发 |

---

## 2. 生产级扩展的架构蓝图

### 2.1 项目结构

参考 `pi-subagents` 的实际结构（~25k 行源码，70+ 测试文件）：

```
my-extension/
├── package.json              # 包声明 + pi 配置
├── install.mjs               # `pi install` 安装脚本
├── src/
│   ├── extension/
│   │   ├── index.ts          # ★ 扩展入口（default export function）
│   │   ├── config.ts         # 配置加载
│   │   └── schemas.ts        # 工具参数 schema（TypeBox）
│   ├── runs/
│   │   ├── foreground/       # 前台执行逻辑
│   │   │   ├── execution.ts
│   │   │   ├── chain-execution.ts
│   │   │   └── subagent-executor.ts
│   │   ├── background/       # 后台执行逻辑
│   │   │   ├── async-execution.ts
│   │   │   ├── async-job-tracker.ts
│   │   │   └── result-watcher.ts
│   │   └── shared/           # 前后台共享
│   │       ├── pi-spawn.ts
│   │       ├── pi-args.ts
│   │       ├── model-fallback.ts
│   │       └── worktree.ts
│   ├── agents/               # Agent 发现、序列化、管理
│   │   ├── agents.ts
│   │   ├── agent-scope.ts
│   │   ├── agent-management.ts
│   │   ├── frontmatter.ts
│   │   └── skills.ts
│   ├── intercom/             # 跨会话通信
│   │   ├── intercom-bridge.ts
│   │   └── result-intercom.ts
│   ├── slash/                # 斜杠命令桥接
│   │   ├── slash-commands.ts
│   │   ├── slash-bridge.ts
│   │   └── prompt-template-bridge.ts
│   ├── tui/                  # TUI 渲染组件
│   │   ├── render.ts
│   │   └── render-helpers.ts
│   └── shared/               # 公共工具
│       ├── types.ts
│       ├── utils.ts
│       ├── artifacts.ts
│       ├── session-identity.ts
│       └── settings.ts
├── agents/                   # 内置 Agent 定义（Markdown + YAML）
│   ├── scout.md
│   ├── reviewer.md
│   └── worker.md
├── skills/                   # 内置 Skills
│   └── my-extension/SKILL.md
├── prompts/                  # 可复用 Prompt 模板
│   └── parallel-review.md
├── test/
│   ├── unit/                 # 单元测试
│   ├── integration/          # 集成测试
│   └── support/              # 测试辅助
├── README.md
└── CHANGELOG.md
```

### 2.2 package.json 核心声明

```jsonc
{
  "name": "my-extension",
  "version": "1.0.0",
  "type": "module",
  "keywords": ["pi-package", "pi", "pi-coding-agent"],  // ★ 必须含 pi-package
  "bin": {
    "my-extension": "install.mjs"  // ★ 安装脚本入口
  },
  "files": [
    "src/**/*.ts",
    "*.mjs",
    "agents/",
    "skills/**/*",
    "prompts/**/*",
    "README.md"
  ],
  "pi": {                              // ★ Pi 特有配置
    "extensions": [
      "./src/extension/index.ts"       // 扩展入口
    ],
    "skills": ["./skills"],            // 内置 skills
    "prompts": ["./prompts"]           // 内置 prompt 模板
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",  // 核心 API
    "@earendil-works/pi-agent-core": "*",    // 工具结果类型
    "@earendil-works/pi-ai": "*"             // AI 工具（StringEnum 等）
  },
  "peerDependenciesMeta": {
    "@earendil-works/pi-coding-agent": { "optional": true },
    "@earendil-works/pi-agent-core": { "optional": true },
    "@earendil-works/pi-ai": { "optional": true }
  },
  "dependencies": {
    "@earendil-works/pi-tui": "^0.74.0",   // TUI 组件
    "typebox": "^1.1.24",                   // Schema 定义
    "jiti": "^2.7.0"                        // TS 运行时加载
  }
}
```

**关键点**：
- `keywords` 必须包含 `"pi-package"` 以便 Pi 包管理器识别
- `peerDependencies` 必须 `optional: true`，因为扩展运行在 Pi 进程内
- `bin` 指向 `install.mjs` 供 `pi install npm:xxx` 使用

---

## 3. 扩展入口模式

### 3.1 标准入口

```typescript
// src/extension/index.ts
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export default function registerMyExtension(pi: ExtensionAPI): void {
  // 1. 初始化状态
  // 2. 注册工具
  // 3. 注册命令/快捷键
  // 4. 订阅事件
  // 5. 注册渲染器
  // 6. 清理注册
}
```

### 3.2 子进程保护模式（pi-subagents 的关键设计）

```typescript
// pi-subagents 的实际做法：在子进程中跳过父级扩展
export default function registerSubagentExtension(pi: ExtensionAPI): void {
  // 如果当前进程是子代理进程，则跳过完整注册
  if (process.env[SUBAGENT_CHILD_ENV] === "1") {
    if (process.env[SUBAGENT_FANOUT_CHILD_ENV] === "1") {
      registerFanoutChildSubagentExtension(pi);  // 仅注册子级受限工具
    }
    return;
  }

  // ... 正常父级注册
}
```

**设计含义**：扩展必须考虑它在子进程中被加载的场景，通过环境变量区分角色。

---

## 4. 工具注册的完整模式

### 4.1 Schema 定义（TypeBox）

```typescript
import { Type } from "typebox";

// ★ Google API 兼容：用 StringEnum 而非 Type.Union
const ActionEnum = Type.String({
  enum: ["list", "get", "create", "execute", "status"],
  description: "Action type"
});

export const MyToolParams = Type.Object({
  action: Type.Optional(ActionEnum),
  target: Type.Optional(Type.String({ description: "Target identifier" })),
  config: Type.Optional(Type.Unsafe({
    anyOf: [
      { type: "object", additionalProperties: true },
      { type: "string" }
    ],
    description: "Configuration object or JSON string"
  })),
  async: Type.Optional(Type.Boolean({ description: "Background execution" })),
  context: Type.Optional(Type.String({
    enum: ["fresh", "fork"],
    description: "Session context mode"
  })),
});
```

### 4.2 工具注册

```typescript
const tool: ToolDefinition<typeof MyToolParams, MyDetails> = {
  name: "my_tool",
  label: "My Tool",
  description: `Delegate to sub-processes or manage definitions.

EXECUTION (use exactly ONE mode):
• SINGLE: { target, task? } - one task
• PARALLEL: { tasks: [...] } - concurrent execution
• ...

MANAGEMENT:
• { action: "list" } - discover resources
• { action: "get", target: "name" } - inspect detail`,
  parameters: MyToolParams,

  async execute(id, params, signal, onUpdate, ctx) {
    // onUpdate 用于流式进度更新
    onUpdate?.({
      content: [{ type: "text", text: "Working..." }]
    });

    // signal 用于中断支持
    if (signal.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }], isError: true, details: {} };
    }

    // 根据 action 分发
    if (params.action) return handleManagementAction(params, ctx);
    return handleExecution(params, signal, onUpdate, ctx);
  },

  renderCall(args, theme) {
    // 自定义工具调用渲染
    return new Text(
      `${theme.fg("toolTitle", theme.bold("my_tool "))}${args.action || "execute"}`,
      0, 0
    );
  },

  renderResult(result, options, theme, context) {
    // 自定义结果渲染
    return renderMyResult(result, options, theme);
  },
};

pi.registerTool(tool);
```

### 4.3 关键设计原则

| 原则 | 实践 |
|------|------|
| **大 Description** | 工具描述就是 LLM 的使用手册，包含所有模式、参数、示例 |
| **Schema 即文档** | 每个 TypeBox 字段都有详细 description |
| **流式更新** | 使用 `onUpdate` 回调实时推送进度 |
| **中断支持** | 检查 `signal.aborted` 并优雅退出 |
| **上下文感知** | 区分 `ctx.hasUI`（CLI 模式 vs TUI 模式） |
| **结构化 details** | 返回 `details` 对象供渲染器和会话持久化使用 |

---

## 5. 事件生命周期管理

### 5.1 完整事件链

```typescript
export default function register(pi: ExtensionAPI): void {
  // 会话开始 —— 初始化状态
  pi.on("session_start", (event, ctx) => {
    resetSessionState(ctx);
  });

  // 工具结果后 —— 更新 UI
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "my_tool") return;
    if (!ctx.hasUI) return;
    updateWidget(ctx, currentState);
    ctx.ui.requestRender?.();
  });

  // 会话结束 —— 清理资源
  pi.on("session_shutdown", () => {
    cleanupTimers();
    cleanupWatchers();
    clearState();
  });
}
```

### 5.2 全局状态清理（热重载支持）

```typescript
// ★ 关键模式：通过 globalThis 支持扩展热重载
const globalStore = globalThis as Record<string, unknown>;
const CLEANUP_KEY = "__myExtensionCleanup";

const previousCleanup = globalStore[CLEANUP_KEY];
if (typeof previousCleanup === "function") {
  try { previousCleanup(); } catch { /* best effort */ }
}

const runtimeCleanup = () => {
  stopWatchers();
  clearTimers();
  unsubscribeEvents();
};
globalStore[CLEANUP_KEY] = runtimeCleanup;
```

**设计含义**：Pi 支持扩展热重载，新实例加载时必须先清理旧实例的定时器、监听器和文件监视器。

---

## 6. Agent 定义系统（Markdown + YAML Frontmatter）

### 6.1 Agent 文件格式

```markdown
---
name: reviewer
description: Code review specialist for diffs, plans, and codebase health
tools: read, grep, find, ls, bash, edit, write, intercom
thinking: high
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
defaultReads: plan.md, progress.md
output: context.md
defaultProgress: true
maxSubagentDepth: 1
completionGuard: false
---

You are a disciplined review subagent. Your job is to inspect,
evaluate, and report findings with evidence.

## Working rules
- Read plan and relevant files first
- Use `bash` only for read-only inspection
- Do not invent issues, only report from evidence
- Prefer small corrective edits over broad rewrites
```

### 6.2 Frontmatter 字段参考

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | Agent 运行时名称（唯一标识） |
| `package` | string? | 可选包名，运行时为 `package.name` |
| `description` | string | 简短描述（list 时展示） |
| `tools` | string | 逗号分隔的工具白名单；`mcp:xxx` 选择 MCP 直接工具 |
| `extensions` | string? | 省略=全部，空=无，逗号=白名单 |
| `model` | string? | 默认模型 |
| `fallbackModels` | string? | 备选模型（逗号分隔） |
| `thinking` | string? | 思考级别：off/minimal/low/medium/high/xhigh |
| `systemPromptMode` | replace/append | `replace` 完全替换系统提示；`append` 追加到 Pi 基础提示 |
| `inheritProjectContext` | bool | 是否继承项目指令（AGENTS.md 等） |
| `inheritSkills` | bool | 是否继承 Skills 目录 |
| `defaultContext` | fresh/fork | 启动时默认的上下文模式 |
| `skills` | string? | 注入的 Skills（逗号分隔） |
| `output` | string? | 默认输出文件 |
| `defaultReads` | string? | 执行前默认读取的文件 |
| `defaultProgress` | bool | 是否维护 progress.md |
| `completionGuard` | bool | 实现完成守卫（bash 类工具设 false） |
| `maxSubagentDepth` | number | 子级嵌套深度限制 |
| `interactive` | bool | 交互模式标记（v1 不强制） |

### 6.3 Agent 发现机制

```
优先级（低→高）：Builtin → User → Project

Builtin: ~/.pi/agent/extensions/subagent/agents/
User:    ~/.pi/agent/agents/**/*.md
Project: .pi/agents/**/*.md

项目名冲突时 Project 胜出
可通过 agentScope: "user" | "project" | "both" 控制
```

### 6.4 Agent 覆盖（不复制整个文件）

```jsonc
// ~/.pi/agent/settings.json 或 .pi/settings.json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "model": "anthropic/claude-sonnet-4",
        "thinking": "high",
        "fallbackModels": ["openai/gpt-5-mini"],
        "inheritProjectContext": false
      }
    }
  }
}
```

---

## 7. 子进程执行模式

### 7.1 Pi 子进程架构

```
父进程 (Pi 主会话)
  └── 注册 subagent 工具
  └── LLM 调用 subagent({ agent: "worker", task: "..." })
  └── 扩展通过 child_process.spawn 启动子 Pi 进程
       └── 子进程 (Pi child session)
            └── 加载相同的扩展
            └── 环境变量标记：SUBAGENT_CHILD_ENV=1
            └── 扩展检测到子进程模式 → 仅注册受限工具
            └── 接收任务，独立执行
            └── 结果通过文件系统（JSONL）传递回父进程
```

### 7.2 子进程启动参数构建

```typescript
// 参考 pi-subagents 的 buildPiArgs
function buildChildArgs(config: {
  agent: AgentConfig;
  task: string;
  sessionFile?: string;
  modelOverride?: string;
  tools?: string[];
  cwd: string;
}): string[] {
  const args: string[] = [];

  if (config.sessionFile) {
    args.push("--session", config.sessionFile);
  }

  if (config.modelOverride) {
    args.push("--model", config.modelOverride);
  }

  if (config.tools?.length) {
    args.push("--tools", config.tools.join(","));
  }

  args.push("--cwd", config.cwd);

  // 子代理环境标记
  args.push("--env", `${SUBAGENT_CHILD_ENV}=1`);

  return args;
}
```

### 7.3 执行与结果收集

```typescript
function runSync(options: RunSyncOptions): SingleResult {
  const child = spawn(piCommand, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      [SUBAGENT_CHILD_ENV]: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // JSONL 事件流解析
  const writer = createJsonlWriter(child.stdout);

  // 实时进度提取
  child.stdout.on("data", (data) => {
    for (const event of parseJsonlEvents(data)) {
      updateProgress(progress, event);
      options.onProgress?.(progress);
    }
  });

  // 等待完成
  return new Promise((resolve) => {
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        output: collectOutput(),
        usage: collectUsage(),
        messages: collectMessages(),
      });
    });
  });
}
```

---

## 8. 后台异步执行系统

### 8.1 异步任务追踪

```typescript
interface AsyncJobTracker {
  ensurePoller: () => void;
  handleStarted: (event: AsyncStartedEvent) => void;
  handleComplete: (event: AsyncCompleteEvent) => void;
  resetJobs: (ctx: ExtensionContext) => void;
}

function createAsyncJobTracker(
  pi: ExtensionAPI,
  state: ExtensionState,
  asyncDir: string
): AsyncJobTracker {
  return {
    ensurePoller() {
      if (state.poller) return;
      state.poller = setInterval(() => {
        for (const job of state.asyncJobs.values()) {
          refreshJobStatus(job, asyncDir);
        }
      }, 2000);
    },

    handleStarted(event) {
      state.asyncJobs.set(event.runId, {
        asyncId: event.runId,
        asyncDir: event.asyncDir,
        status: "running",
        updatedAt: Date.now(),
      });
    },

    handleComplete(event) {
      const job = state.asyncJobs.get(event.runId);
      if (job) {
        job.status = "completed";
        job.updatedAt = Date.now();
      }
    },

    resetJobs(ctx) {
      state.asyncJobs.clear();
    }
  };
}
```

### 8.2 文件系统结果观察器

```typescript
function createResultWatcher(pi, state, resultsDir, intervalMs) {
  let watcher: FSWatcher | null = null;

  function startResultWatcher() {
    if (!existsSync(resultsDir)) return;
    watcher = fs.watch(resultsDir, { recursive: true }, (eventType, filename) => {
      if (filename?.endsWith(".json")) {
        const result = readResultFile(path.join(resultsDir, filename));
        if (result && !state.completionSeen.has(result.runId)) {
          state.completionSeen.set(result.runId, true);
          pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, result);
        }
      }
    });
  }

  function primeExistingResults() {
    // 启动时扫描已有结果文件，避免错过热重载期间完成的结果
  }

  function stopResultWatcher() {
    watcher?.close();
    watcher = null;
  }

  return { startResultWatcher, primeExistingResults, stopResultWatcher };
}
```

### 8.3 异步状态文件格式

```
<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<id>/
  status.json          # 运行状态（running/completed/failed）
  events.jsonl         # 包装事件 + 子 Pi JSON 事件
  output-<n>.log       # 实时人类可读日志
  subagent-log-<id>.md # Markdown 格式日志
```

---

## 9. Chain / Pipeline 执行系统

### 9.1 Chain 定义

```typescript
// 三种链式步骤类型
type ChainStep =
  | SequentialStep          // { agent, task }
  | ParallelStep            // { parallel: [...] }
  | DynamicParallelStep;    // { expand, parallel, collect }

interface SequentialStep {
  agent: string;
  task?: string;            // 支持 {task}, {previous}, {chain_dir}, {outputs.name} 模板变量
  output?: string;
  reads?: string[];
  as?: string;              // 命名输出，后续步骤通过 {outputs.name} 引用
  model?: string;
  phase?: string;           // 分组标签
  label?: string;           // 人类可读标签
}
```

### 9.2 Chain 执行流程

```
Step 1: scout "Analyze auth"
  → 输出写入 chain_dir/context.md
  → 文本传递给 Step 2 的 {previous}

Step 2: planner "Plan based on {previous}"
  → 读取 chain_dir/context.md
  → 输出传递给 Step 3

Step 3: { parallel: [worker "实现 A", worker "实现 B"] }
  → 两个 worker 并发执行
  → 结果聚合后传递给 Step 4

Step 4: reviewer "Review {previous}"
  → 最终输出
```

### 9.3 动态扇出（Dynamic Fanout）

```typescript
// 从结构化输出发散
{
  chain: [
    {
      agent: "scout",
      task: "返回结构化目标列表",
      as: "targets",
      outputSchema: { type: "object", properties: { items: { type: "array" } } }
    },
    {
      expand: { from: { output: "targets", path: "/items" }, maxItems: 12 },
      parallel: { agent: "reviewer", task: "Review {target.path}" },
      collect: { as: "reviews" },
      concurrency: 4
    },
    {
      agent: "worker",
      task: "综合修复 {outputs.reviews}"
    }
  ]
}
```

### 9.4 Chain 文件格式

`.chain.md` —— 简单顺序链：
```markdown
---
name: scout-planner
description: Gather context then plan
---

## scout
phase: Context
output: context.md

Analyze the codebase for {task}

## planner
phase: Planning
reads: context.md

Create a plan based on {outputs.context}
```

`.chain.json` —— 支持动态扇出：

---

## 10. 跨会话通信（Intercom）

### 10.1 Intercom Bridge 模式

```typescript
interface IntercomBridgeState {
  active: boolean;
  orchestratorTarget?: string;    // 父会话目标
  instructionFile?: string;       // 自定义桥接指令
}

function resolveIntercomBridge(input: {
  config?: IntercomBridgeConfig;
  context?: "fresh" | "fork";
  orchestratorTarget?: string;
  cwd: string;
}): IntercomBridgeState {
  return {
    active: isIntercomAvailable(input.cwd) && !!input.orchestratorTarget,
    orchestratorTarget: input.orchestratorTarget,
  };
}
```

### 10.2 子→父通信

```typescript
// 子代理使用 contact_supervisor 工具
// reason: "need_decision" —— 阻塞型决策请求
// reason: "progress_update" —— 非阻塞进度更新

// 父端监听
pi.events.on(SUBAGENT_CONTROL_INTERCOM_EVENT, (payload) => {
  deliverIntercomMessage(payload);
});
```

### 10.3 结果投递

```typescript
async function deliverSubagentResultIntercomEvent(
  eventBus: IntercomEventBus,
  payload: SubagentResultIntercomPayload
): Promise<boolean> {
  // 通过 intercom 事件总线投递分组结果
  eventBus.emit("intercom:send", {
    to: payload.to,
    message: payload.message,
    source: "subagent-result",
  });
  return true;
}
```

---

## 11. TUI 渲染系统

### 11.1 自定义消息渲染器

```typescript
// 注册消息类型渲染器
pi.registerMessageRenderer<MyDetails>("my-message-type",
  (message, options, theme) => {
    const details = message.details as MyDetails;
    if (!details) return undefined;

    // 返回 TUI 组件（实现 Component 接口）
    return new MyResultComponent(details, theme);
  }
);
```

### 11.2 Component 接口

```typescript
interface Component {
  invalidate(): void;
  render(width: number): string[];
}

class MyResultComponent implements Component {
  constructor(
    private details: MyDetails,
    private theme: ExtensionContext["ui"]["theme"],
  ) {}

  invalidate(): void { /* 标记需要重新渲染 */ }

  render(width: number): string[] {
    const lines: string[] = [];
    // 使用 theme.fg/bg 进行颜色化
    lines.push(`${theme.fg("toolTitle", theme.bold("Result"))}`);
    lines.push(`${theme.fg("dim", details.summary)}`);
    return lines;
  }
}
```

### 11.3 Widget 系统

```typescript
// 在编辑器上方显示持久组件
ctx.ui.setWidget("my-widget-key", widgetComponent);

// 更新 widget
ctx.ui.setWidget("my-widget-key", updatedComponent);
ctx.ui.requestRender?.();

// 清除 widget
ctx.ui.setWidget("my-widget-key", undefined);
```

### 11.4 实时进度渲染

```typescript
// pi-subagents 的做法：流式更新
function createLiveResultComponent(
  initialResult: AgentToolResult,
  theme: Theme
): Container {
  const container = new Container();
  let lastVersion = -1;

  container.render = (width: number): string[] => {
    const snapshot = getLatestSnapshot();
    if (snapshot.version !== lastVersion || isRunning(snapshot)) {
      lastVersion = snapshot.version;
      rebuildContainer(container, snapshot, theme);
    }
    return Container.prototype.render.call(container, width);
  };

  return container;
}
```

---

## 12. Acceptance Gates（验收门控）

### 12.1 验收级别

| 级别 | 说明 |
|------|------|
| `auto` | 自动推断（默认） |
| `none` | 无验收 |
| `attested` | 子代理返回结构化验收报告 |
| `checked` | 运行时结构性检查通过 |
| `verified` | 配置的运行时验证命令通过 |
| `reviewed` | 独立 reviewer 结果存在 |

### 12.2 使用模式

```typescript
{
  agent: "worker",
  task: "Implement the fix",
  acceptance: {
    level: "verified",
    criteria: ["修复不扩大范围"],
    evidence: ["changed-files", "tests-added", "commands-run", "no-staged-files"],
    verify: [
      { id: "tests", command: "npm test", timeoutMs: 120000 }
    ]
  }
}
```

---

## 13. Git Worktree 隔离

```typescript
// 为并行任务创建隔离的 git worktree
{ tasks: [...], worktree: true }

// 要求：
// - 必须在 git 仓库内
// - 工作树必须干净
// - 自动 symlink node_modules
// - 完成后自动清理 worktree 和临时分支

// 自定义 worktree 设置钩子
// config.json:
{
  "worktreeSetupHook": "./scripts/setup-worktree.mjs",
  "worktreeSetupHookTimeoutMs": 45000
}
```

---

## 14. 配置系统

### 14.1 配置加载

```typescript
// ~/.pi/agent/extensions/my-extension/config.json
function loadConfig(): ExtensionConfig {
  const configPath = path.join(
    getAgentDir(), "extensions", "my-extension", "config.json"
  );
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }
  } catch (error) {
    console.error(`Failed to load config:`, error);
  }
  return {};
}
```

### 14.2 配置项示例

```jsonc
{
  "asyncByDefault": false,
  "forceTopLevelAsync": false,
  "maxSubagentDepth": 1,
  "parallel": {
    "maxTasks": 12,
    "concurrency": 6
  },
  "defaultSessionDir": "~/.pi/agent/sessions/subagent/",
  "intercomBridge": {
    "mode": "always",          // always | fork-only | off
    "instructionFile": "./intercom-bridge.md"
  },
  "worktreeSetupHook": "./scripts/setup-worktree.mjs",
  "worktreeSetupHookTimeoutMs": 30000
}
```

---

## 15. 测试策略

### 15.1 测试分层

```
test/
├── unit/          # 纯逻辑测试（不依赖 Pi 运行时）
│   ├── schemas.test.ts
│   ├── agent-selection.test.ts
│   ├── model-fallback.test.ts
│   └── chain-serializer.test.ts
├── integration/   # 需要 Pi 运行时的测试
│   ├── single-execution.test.ts
│   ├── chain-execution.test.ts
│   └── async-execution.test.ts
└── support/       # 测试辅助
    ├── mock-pi.ts         # Pi API mock
    ├── mock-pi-script.mjs # 子进程 mock
    └── helpers.ts
```

### 15.2 运行方式

```jsonc
{
  "scripts": {
    "test:unit": "node --experimental-strip-types --test test/unit/*.test.ts",
    "test:integration": "node --experimental-transform-types --import ./test/support/register-loader.mjs --test test/integration/*.test.ts",
    "test:all": "npm run test:unit && npm run test:integration"
  }
}
```

### 15.3 Mock Pi API

```typescript
// test/support/mock-pi.ts
export function createMockPi(): ExtensionAPI {
  return {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: vi.fn(),
    events: {
      on: vi.fn(() => vi.fn()),
      emit: vi.fn(),
    },
    getSessionName: vi.fn(() => "test-session"),
    sendMessage: vi.fn(),
    getFlag: vi.fn(),
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
}
```

---

## 16. CI/CD（GitHub Actions）

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm test

# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ['v*']
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npm test
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

---

## 17. 关键设计模式总结

### 17.1 生产级扩展的 10 个必备能力

| # | 能力 | pi-subagents 的实现方式 |
|---|------|------------------------|
| 1 | **进程隔离** | 通过环境变量区分父/子角色，子进程跳过完整注册 |
| 2 | **热重载安全** | globalThis 存储清理函数，新实例先清理旧资源 |
| 3 | **后台执行** | 文件系统状态文件 + FSWatcher + 事件投递 |
| 4 | **流式进度** | JSONL 事件流解析 + TUI Container 动态渲染 |
| 5 | **错误恢复** | Model Fallback（多模型降级）+ Stale Run Reconciler |
| 6 | **并发控制** | 并行任务数限制 + 并发度控制 + Worktree 隔离 |
| 7 | **验收门控** | 五级验收（attested → checked → verified → reviewed） |
| 8 | **跨会话通信** | Intercom Bridge + 结构化消息投递 |
| 9 | **嵌套安全** | maxSubagentDepth + 子级工具剥离 + 上下文过滤 |
| 10 | **可观测性** | Doctor 诊断 + Artifact 写入 + 结构化元数据 |

### 17.2 架构模式速查

```
┌─────────────────────────────────────────────────────────┐
│                    Extension Entry                       │
│  src/extension/index.ts                                  │
│  - 环境检测（父/子进程）                                  │
│  - 状态初始化                                            │
│  - 工具/命令/事件注册                                     │
│  - 生命周期钩子                                          │
├─────────────────────────────────────────────────────────┤
│                   Tool Registration                      │
│  - TypeBox Schema (参数校验 + LLM 文档)                  │
│  - execute() (前台/后台分发)                              │
│  - renderCall() / renderResult() (TUI 渲染)             │
├─────────────────────────────────────────────────────────┤
│                  Execution Layer                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Foreground   │  │  Background   │  │    Chain      │  │
│  │  - spawn      │  │  - detached   │  │ - sequential  │  │
│  │  - streaming  │  │  - file watch │  │ - parallel    │  │
│  │  - progress   │  │  - events     │  │ - fanout      │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
├─────────────────────────────────────────────────────────┤
│                  Agent System                            │
│  - Markdown + YAML 定义                                  │
│  - 分层发现 (Builtin → User → Project)                   │
│  - 设置覆盖 (不复制文件)                                  │
│  - Skill 注入                                            │
├─────────────────────────────────────────────────────────┤
│                  Infrastructure                          │
│  - Config Loading  - Artifact Management                 │
│  - Session State  - Intercom Bridge                      │
│  - Model Fallback - Control Notices                      │
│  - Worktree Mgmt  - Acceptance Gates                     │
└─────────────────────────────────────────────────────────┘
```

### 17.3 安装与分发

```bash
# 从 npm 安装
pi install npm:my-extension

# 从本地路径安装
pi install ./path/to/my-extension

# 卸载
pi uninstall my-extension
```

安装脚本 (`install.mjs`) 负责将扩展注册到 `~/.pi/agent/extensions/` 目录。

---

## 18. 从零开始的 Checklist

- [ ] **项目初始化**：创建 `package.json`（含 `pi` 字段、`pi-package` keyword、optional peerDeps）
- [ ] **入口文件**：`src/extension/index.ts`（default export function(pi: ExtensionAPI)）
- [ ] **安装脚本**：`install.mjs`
- [ ] **Schema 定义**：`src/extension/schemas.ts`（TypeBox 参数定义）
- [ ] **配置系统**：`src/extension/config.ts`
- [ ] **工具注册**：`pi.registerTool({...})`
- [ ] **事件订阅**：`pi.on("session_start/session_shutdown/tool_result", ...)`
- [ ] **热重载安全**：globalThis 清理模式
- [ ] **TUI 渲染**：`renderCall`、`renderResult`、`registerMessageRenderer`
- [ ] **子进程隔离**（如需要）：环境变量检测
- [ ] **后台执行**（如需要）：文件系统状态 + watcher
- [ ] **Agent 定义**（如需要）：Markdown + YAML frontmatter
- [ ] **Skills**（如需要）：SKILL.md 文件
- [ ] **单元测试**：`test/unit/*.test.ts`
- [ ] **集成测试**：`test/integration/*.test.ts`
- [ ] **CI/CD**：GitHub Actions
- [ ] **文档**：README.md、CHANGELOG.md

---

## 附录 A：核心依赖说明

| 包名 | 用途 |
|------|------|
| `@earendil-works/pi-coding-agent` | ExtensionAPI 类型、ExtensionContext、ToolDefinition |
| `@earendil-works/pi-agent-core` | AgentToolResult 类型 |
| `@earendil-works/pi-ai` | StringEnum（Google API 兼容）、Message 类型 |
| `@earendil-works/pi-tui` | Box、Container、Text、Spacer 等 TUI 组件 |
| `typebox` / `@sinclair/typebox` | JSON Schema 构建（参数校验） |
| `jiti` | TypeScript 运行时加载 |

> **注意**：不同维护者的包使用不同的 scope。`nicobailon/pi-subagents` 使用 `@earendil-works`，`baphuongna/pi-crew` 使用 `@mariozechner`。这是 Pi 生态中不同 fork 的区别。开发时请确认你目标平台的实际包名。

## 附录 B：参考仓库列表

| 仓库 | 复杂度 | 核心能力 |
|------|--------|----------|
| `nicobailon/pi-subagents` | ★★★★★ | 子代理系统、Chain/Pipeline、异步执行、Intercom、Worktree |
| `nicobailon/pi-mcp-adapter` | ★★★★ | MCP 协议适配、OAuth、UI Server |
| `baphuongna/pi-crew` | ★★★★ | 团队编排、工作流、并发调度 |
| `pi-interactive-shell` | ★★★ | PTY 会话管理 |
| `pi-skills` | ★★ | Skill 定义示例 |
| `oh-pi/packages/subagents` | ★★★★★ | pi-subagents 的企业 fork（@ifi scope） |
