# Subagents 包实现计划（plan-1）

> **给 agentic worker：** 必备子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 来逐任务执行此计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 新建 `@zhushanwen/pi-subagents` 扩展包，封装 Pi SDK `createAgentSession()`，提供进程内 agent 执行能力（`runAgent()`）、agent 发现、模型解析、并发控制，作为独立可复用的 subagent 编排基础库。

**架构：** 分层设计——L1 核心执行（runAgent/ManagedSession/并发/事件桥接）、L2 解析与配置（agent 发现、5 级配置链、模型解析、tool 过滤、category、fork）。`SubagentRuntime` 单例组合所有能力，通过 `session_start` 注入 `modelRegistry`/`sessionManager`。所有可测逻辑与 Pi SDK 解耦（mock alias）。

**技术栈：** TypeScript（ESM，无独立 tsconfig，根 tsconfig 覆盖）、Pi SDK（`@mariozechner/pi-coding-agent` peerDep）、Vitest 4.x、无外部运行时依赖（frontmatter 手写解析、并发池手写）。

**关联文档：**
- 设计 spec：`./spec.md`（FR-1~8, FR-10~14）
- 执行顺序：本 plan 完成且全量测试通过后，执行 `./plan-2-workflow-integration.md`（FR-9 workflow 改造）

---

## spec 偏差说明（实现时以实际 SDK 为准）

本 plan 基于已校正的 `spec.md`（5 处 SDK 差异已在 spec 中修正）。关键校正点：
1. **tool 过滤**：`createAgentSession({ tools: string[] })` 传 allowlist，非 `ResourceLoader.excludeTools`（SDK 无此字段）
2. **事件名**：SDK 是 `tool_execution_start`/`tool_execution_end`（非 `tool_start`/`tool_end`）；无 `text_delta`/`error` 变体（text 在 `message_update`，error 在 `message_end.stopReason`）
3. **usage 位置**：`message_end.message.usage`（非事件顶层），`cost` 用 `Usage.cost.total`
4. **turn_end**：SDK 原生事件，payload 含 `{ message, toolResults }`

---

## 文件结构（FR-12.1）

```
extensions/subagents/
├── index.ts                          # re-export: export { default } from "./src/index.ts"
├── package.json                      # @zhushanwen/pi-subagents
├── vitest.config.ts                  # alias Pi SDK → mocks/
├── mocks/
│   ├── typebox.ts                    # Type 桩 + Static = unknown
│   ├── pi-ai.ts                      # StringEnum 桩
│   └── pi-tui.ts                     # UI 桩
├── src/
│   ├── index.ts                      # Pi extension 工厂函数 + session_start 注入
│   ├── types.ts                      # 所有类型 + EXCLUDED_TOOL_NAMES 常量
│   ├── runtime.ts                    # SubagentRuntime 单例
│   ├── api/
│   │   └── index.ts                  # package 的 public surface re-export
│   ├── core/                         # L1
│   │   ├── run-agent.ts              # runAgent(options) → AgentResult
│   │   ├── session.ts                # createManagedSession() → ManagedSession
│   │   ├── output-collector.ts       # 从 session.messages 提取最终文本
│   │   ├── turn-limiter.ts           # soft turn limit + hard abort
│   │   └── event-bridge.ts           # AgentSessionEvent → AgentEvent
│   ├── pool/
│   │   └── concurrency-pool.ts       # ConcurrencyPool
│   ├── registry/                     # L2
│   │   ├── index.ts                 # re-export（供 api/index.ts 引用）
│   │   ├── agent-registry.ts         # AgentRegistry.discover() / get()
│   │   ├── frontmatter.ts            # YAML frontmatter 解析（迁移自 workflow）
│   │   └── builtin-agents.ts         # 7 个内置 agent 定义
│   ├── resolution/                   # L2
│   │   ├── config-merger.ts          # 5 级配置优先级
│   │   ├── model-resolver.ts         # resolveModelForAgent() + fallback 链
│   │   ├── tool-filter.ts            # 三层过滤 + allowlist 计算
│   │   └── fork-context.ts           # forkContext() + 截断
│   ├── config/                       # L2
│   │   ├── global-config.ts          # loadGlobalConfig() / saveGlobalConfig()
│   │   └── config-path.ts            # 路径常量
│   ├── state/                        # L2
│   │   └── session-model-state.ts    # SessionModelState 持久化/恢复
│   ├── category.ts                   # Category 定义 + inferCategory()
│   ├── tui/
│   │   ├── format.ts                 # 纯格式化函数（可测试）
│   │   └── config-wizard.ts          # /subagents config 级联选择
│   ├── commands/
│   │   └── config.ts                 # /subagents 命令注册
│   └── __tests__/
│       ├── concurrency-pool.test.ts
│       ├── frontmatter.test.ts
│       ├── agent-registry.test.ts
│       ├── config-merger.test.ts
│       ├── model-resolver.test.ts
│       ├── tool-filter.test.ts
│       ├── category.test.ts
│       ├── event-bridge.test.ts
│       ├── output-collector.test.ts
│       ├── turn-limiter.test.ts
│       ├── fork-context.test.ts
│       ├── global-config.test.ts
│       ├── session-model-state.test.ts
│       └── format.test.ts
└── README.md
```

**文件职责边界**：每个文件单一职责，< 500 行（check-structure 在 ≥500 行 WARN，≥1000 行 FAIL）。types.ts 是唯一的类型定义中心，其他文件只 import 不重复定义。

---

## 任务索引

本 plan 按 4 个阶段组织，共 16 个任务。每个任务独立可测试、可提交。

| 任务 | 模块 | 阶段 | 依赖 |
|------|------|------|------|
| [任务 1](#任务-1包脚手架) | 脚手架 | 阶段 0：基础搭建 | 无 |
| [任务 2](#任务-2类型定义-types) | types.ts | 阶段 0 | 任务 1 |
| [任务 3](#任务-3并发池) | concurrency-pool | 阶段 1：L1 基础 | 任务 2 |
| [任务 4](#任务-4事件桥接) | event-bridge | 阶段 1 | 任务 2 |
| [任务 5](#任务-5输出收集器) | output-collector | 阶段 1 | 任务 2 |
| [任务 6](#任务-6-turn-限制器) | turn-limiter | 阶段 1 | 任务 2 |
| [任务 7](#任务-7-frontmatter-解析) | frontmatter | 阶段 1 | 任务 2 |
| [任务 8](#任务-8-category-推断) | category | 阶段 1 | 任务 2 |
| [任务 9](#任务-9全局配置) | global-config | 阶段 1 | 任务 2 |
| [任务 10](#任务-10-builtin-agents--agent-registry) | registry | 阶段 2：L2 | 任务 7 |
| [任务 11](#任务-11-config-merger--tool-filter) | resolution | 阶段 2 | 任务 2, 8 |
| [任务 12](#任务-12-model-resolver) | resolution | 阶段 2 | 任务 8, 9, 11 |
| [任务 13](#任务-13-fork-context--session-state) | resolution, state | 阶段 2 | 任务 2 |
| [任务 14](#任务-14-runagent--managedsession) | core | 阶段 3：L1 编排 | 任务 3,4,5,6,8,11,12 |
| [任务 15](#任务-15-runtime--api--扩展工厂) | runtime, api | 阶段 3 | 任务 14 |
| [任务 16](#任务-16-tui--subagents-命令) | tui, commands | 阶段 3 | 任务 9, 12, 15 |

---

## 任务 1：包脚手架

**文件：**
- 创建：`extensions/subagents/package.json`
- 创建：`extensions/subagents/index.ts`
- 创建：`extensions/subagents/vitest.config.ts`
- 创建：`extensions/subagents/mocks/typebox.ts`
- 创建：`extensions/subagents/mocks/pi-ai.ts`
- 创建：`extensions/subagents/mocks/pi-tui.ts`
- 创建：`extensions/subagents/src/index.ts`（最小占位）
- 修改：`extension-dependencies.json`
- 修改：`CLAUDE.md`（L736 扩展清单表格）

- [ ] **步骤 1：创建 `package.json`**

```json
{
  "name": "@zhushanwen/pi-subagents",
  "version": "0.1.0",
  "type": "module",
  "main": "index.ts",
  "description": "In-process agent execution runtime for Pi — createAgentSession wrapper, agent discovery, model resolution",
  "keywords": ["pi-package", "extension", "subagent", "agent-runtime"],
  "license": "MIT",
  "files": ["src/", "index.ts"],
  "pi.extensions": ["./index.ts"],
  "scripts": {
    "typecheck": "npx tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {},
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*"
  },
  "peerDependenciesMeta": {},
  "devDependencies": {
    "@types/node": "^24.0.0",
    "vitest": "^4.1.8"
  }
}
```

- [ ] **步骤 2：创建 `index.ts`（re-export 入口）**

```typescript
export { default } from "./src/index.ts";
```

- [ ] **步骤 3：创建 `src/index.ts`（最小占位工厂，任务 15 完善）**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function subagentsExtension(_pi: ExtensionAPI): void {
  // 占位实现，任务 15 完善：创建 SubagentRuntime + 注册 session_start 注入 + /subagents 命令
}
```

- [ ] **步骤 4：创建 `vitest.config.ts`**

```typescript
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@mariozechner/pi-coding-agent": path.resolve(__dirname, "../../shared/types/mariozechner/index.ts"),
      "@mariozechner/pi-ai": path.resolve(__dirname, "mocks/pi-ai.ts"),
      "@mariozechner/pi-tui": path.resolve(__dirname, "mocks/pi-tui.ts"),
      "@earendil-works/pi-tui": path.resolve(__dirname, "mocks/pi-tui.ts"),
      "@earendil-works/pi-ai": path.resolve(__dirname, "mocks/pi-ai.ts"),
      "@earendil-works/pi-coding-agent": path.resolve(__dirname, "../../shared/types/mariozechner/index.ts"),
      "typebox": path.resolve(__dirname, "mocks/typebox.ts"),
    },
  },
});
```

- [ ] **步骤 5：创建 `mocks/typebox.ts`**（从 `extensions/workflow/mocks/typebox.ts` 复制）

```typescript
export const Type = {
  Object: (properties: Record<string, unknown>, _options?: Record<string, unknown>) => ({ type: "object", properties }),
  String: (_options?: Record<string, unknown>) => ({ type: "string" }),
  Optional: (schema: unknown) => ({ ...schema, optional: true }),
  Number: (_options?: Record<string, unknown>) => ({ type: "number" }),
  Record: (_key: unknown, _value: unknown) => ({ type: "object" }),
  Unknown: () => ({ type: "unknown" }),
  Boolean: (_options?: Record<string, unknown>) => ({ type: "boolean" }),
};
export type Static<_T> = unknown;
```

- [ ] **步骤 6：创建 `mocks/pi-ai.ts`**（从 workflow 复制）

```typescript
export const StringEnum = (values: string[], _options?: Record<string, unknown>) =>
  ({ type: "string", enum: values });
```

- [ ] **步骤 7：创建 `mocks/pi-tui.ts`**（从 workflow 复制，最小桩）

```typescript
// 最小 UI 桩。如 config-wizard 测试需要 ctx.ui.select 等，在此扩展。
export {};
```

- [ ] **步骤 8：更新 `extension-dependencies.json`**（新增 subagents 条目）

在 `extensions` 数组中添加（无 dependsOn，subagents 仅依赖 Pi SDK peerDep）：
```json
{
  "name": "@zhushanwen/pi-subagents",
  "directory": "extensions/subagents",
  "dependsOn": []
}
```

- [ ] **步骤 9：更新 `CLAUDE.md` L736 扩展清单表格**

在表格中按字母顺序插入一行（在 structured-output 行之后、workflow 行之前，或在表格末尾）。格式对齐现有行：
```
| `extensions/subagents/` | `@zhushanwen/pi-subagents` | 进程内 subagent 执行运行时（agent 发现、模型解析、并发控制） | — |
```

- [ ] **步骤 10：运行 check-structure 验证脚手架**

运行：`bash .githooks/check-structure --quick`
预期：PASS（无错误）。如失败，检查 `pi.extensions` 入口文件存在、CLAUDE.md 表格已同步。

- [ ] **步骤 11：安装依赖并验证 typecheck**

运行：`pnpm install` 然后 `pnpm --filter @zhushanwen/pi-subagents typecheck`
预期：PASS（零错误）。

- [ ] **步骤 12：提交**

```bash
git add extensions/subagents/ extension-dependencies.json CLAUDE.md
git commit -m "feat(subagents): scaffold @zhushanwen/pi-subagents package

- package.json, index.ts re-export, vitest.config.ts, mocks/
- register in extension-dependencies.json and CLAUDE.md
- minimal placeholder factory in src/index.ts"
```

---

## 任务 2：类型定义 types

**文件：**
- 创建：`extensions/subagents/src/types.ts`

**职责：** 所有 subagents 包的类型定义中心。被其他所有文件 import。无运行时逻辑（仅 `const EXCLUDED_TOOL_NAMES`）。

- [ ] **步骤 1：编写 `types.ts`**

```typescript
// src/types.ts
//
// 注意：不从 @mariozechner/pi-coding-agent re-export Model/Usage/ThinkingLevel。
// vitest mock stub（shared/types/mariozechner/index.d.ts）未导出这些类型，
// re-export 会导致 "Module has no exported member" 编译错误。
// 改为自定义最小结构（duck-typed），与 SDK 运行时对象兼容。

/**
 * 子 agent 不应继承的编排层 tool（防止无限嵌套）。
 * FR-6.2: 注入到 tool-filter 的排除逻辑中。
 */
export const EXCLUDED_TOOL_NAMES: readonly string[] = [
  "workflow_run",
  "workflow_pause",
  "workflow_abort",
  "workflow_lint",
  "subagent",
] as const;

// ============================================================
// ThinkingLevel 枚举（FR-4.3）— 自定义，与 SDK 类型一致
// ============================================================
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// ============================================================
// Model 最小接口（duck-typed，与 SDK Model<any> 运行时兼容）
// ============================================================
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  contextWindow?: number;
}

// ============================================================
// FR-1.1.1: RunAgentOptions
// ============================================================
export interface RunAgentOptions {
  /** Task prompt — 发送给 agent 的任务描述 */
  task: string;
  /** Agent 名称（从 AgentRegistry 解析 systemPrompt、model 等） */
  agent?: string;
  /** 模型 "provider/modelId" 格式（覆盖配置链解析结果） */
  model?: string;
  /** Thinking level */
  thinkingLevel?: string;
  /** 最大 agent turns（超出时 soft limit + hard abort） */
  maxTurns?: number;
  /** Soft limit 后的 grace turns（默认 2） */
  graceTurns?: number;
  /** 外部取消信号 */
  signal?: AbortSignal;
  /** Skill 路径（注入到 session 的 resourceLoader.additionalSkillPaths） */
  skillPath?: string;
  /** Structured-output schema（拼入 task prompt 末尾 + 追踪 structured-output tool 调用） */
  schema?: Record<string, unknown>;
  /** System prompt 追加内容（注入到 resourceLoader.appendSystemPrompt） */
  appendSystemPrompt?: string[];
  /** 事件回调 */
  onEvent?: (event: AgentEvent) => void;
  /** 并发池覆盖（不传则用全局 pool） */
  pool?: ConcurrencyPool;
  /** 优先级（0=最高，默认 Infinity=无优先级） */
  priority?: number;
}

// ============================================================
// FR-1.1.2: AgentResult
// ============================================================
export interface ToolCallEntry {
  toolName: string;
  result?: { content: Array<{ type: string; text?: string }>; details?: unknown };
  isError: boolean;
}

export interface AgentResult {
  text: string;
  parsedOutput?: unknown;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  turns: number;
  durationMs: number;
  success: boolean;
  error?: string;
  sessionId: string;
  toolCalls: ToolCallEntry[];
}

// ============================================================
// FR-8.2: AgentEvent（subagents 对外统一事件 union）
// ============================================================
export type AgentEventType =
  | "tool_start"
  | "tool_end"
  | "text_delta"
  | "turn_end"
  | "message_end"
  | "compaction"
  | "error";

export type AgentEvent =
  | { type: "tool_start"; toolName: string }
  | { type: "tool_end"; toolName: string; result?: ToolCallEntry["result"]; isError: boolean }
  | { type: "text_delta"; delta: string }
  | { type: "turn_end" }
  | { type: "message_end"; usage: AgentResult["usage"] }
  | { type: "compaction" }
  | { type: "error"; error: string };

// ============================================================
// FR-1.2: ManagedSession
// ============================================================
export interface ManagedSession {
  prompt(task: string, options?: { maxTurns?: number; signal?: AbortSignal }): Promise<AgentResult>;
  steer(message: string): void;
  abort(): void;
  dispose(): void;
  readonly sessionId: string;
  readonly alive: boolean;
}

export interface ManagedSessionOptions {
  agent?: string;
  model?: string;
  thinkingLevel?: string;
  skillPath?: string;
  appendSystemPrompt?: string[];
  onEvent?: (event: AgentEvent) => void;
}

// ============================================================
// FR-2: Agent 配置（frontmatter + builtin）
// ============================================================
export type AgentSource = "project" | "user" | "package" | "local" | "builtin";

export interface AgentConfig {
  name: string;
  systemPrompt: string;
  /** frontmatter 中的 model 字段（"provider/modelId" 格式），可选 */
  model?: string;
  /** 候选模型列表，fallback 链用 */
  modelCandidates?: string[];
  description?: string;
  /** builtin tool 策略：undefined=全部，[]=无，string[]=白名单 */
  builtinTools?: string[] | undefined;
  /** extension tool 策略：true=全部，false=无，string[]=白名单 */
  extensions?: boolean | string[];
  /** 明确排除的 tool 名 */
  excludeTools?: string[];
  /** skills 列表 */
  skills?: string[];
  /** category（推断用） */
  category?: string;
  source: AgentSource;
  filePath?: string;
}

// ============================================================
// FR-3 / FR-4.1: 配置合并 + 模型解析结果
// ============================================================
export interface ResolvedModel {
  /** Model 对象（已通过 modelRegistry.find 验证可用） */
  model: ModelInfo;
  /** thinkingLevel 字符串（已通过 model.thinkingLevelMap 验证） */
  thinkingLevel?: string;
  /** 解析来源（调试/日志用） */
  source: "param" | "per-agent" | "per-category" | "category-default" | "agent-default" | "global-fallback" | "env";
}

export type SystemPromptStrategy = "replace" | "append" | "none";

// ============================================================
// FR-4.5: Category
// ============================================================
export interface CategoryDefinition {
  label: string;
  model: string;
  thinkingLevel?: string;
}

// ============================================================
// FR-4.6: 全局配置
// ============================================================
export interface SubagentsGlobalConfig {
  version: number;
  yoloByDefault: boolean;
  maxConcurrent: number;
  categories: Record<string, CategoryDefinition>;
  agentCategoryOverrides: Record<string, string>;
  fallback: { model: string; thinkingLevel?: string };
}

// ============================================================
// FR-4.7: 会话模型状态
// ============================================================
export interface SessionModelState {
  yoloMode: boolean;
  perAgent: Record<string, { model: string; thinkingLevel?: string }>;
  perCategory: Record<string, { model: string; thinkingLevel?: string }>;
}

// ============================================================
// FR-5: Fork
// ============================================================
export interface ForkOptions {
  maxExchanges?: number;
  maxTokens?: number;
}

export interface ForkResult {
  /** 拼接好的父对话文本（已按截断策略处理） */
  context: string;
  /** 实际提取的轮数 */
  exchangeCount: number;
  /** 是否因 token 限制截断 */
  truncated: boolean;
}

// ============================================================
// FR-6: Tool 过滤
// ============================================================
export interface ToolInfo {
  name: string;
}

export interface ToolFilterConfig {
  builtinTools?: string[];
  extensions?: boolean | string[];
  excludeTools?: string[];
}

export interface ToolFilterResult {
  /** 允许的 tool allowlist（传给 createAgentSession.tools） */
  allowedTools: string[] | undefined;
  /** 被排除的 tool 名（日志用） */
  excludedTools: string[];
}

// ============================================================
// FR-7: 并发池（接口定义，实现在 pool/concurrency-pool.ts）
// ============================================================
export interface ConcurrencyPool {
  acquire(priority?: number): Promise<void>;
  release(): void;
  readonly activeCount: number;
  readonly queueLength: number;
  readonly maxConcurrent: number;
}

// ============================================================
// FR-14.7: Hooks（v1 预留接口）
// ============================================================
export interface SubagentHooks {
  beforeRun?: (opts: RunAgentOptions) => RunAgentOptions | Promise<RunAgentOptions>;
  afterRun?: (result: AgentResult, opts: RunAgentOptions) => void;
  onError?: (error: Error, opts: RunAgentOptions) => void;
}
```

- [ ] **步骤 2：验证类型能被 SDK 解析**

运行：`pnpm --filter @zhushanwen/pi-subagents typecheck`
预期：PASS。`Model`、`Usage`、`ThinkingLevel` 都从 `@mariozechner/pi-coding-agent` re-export（根 tsconfig paths 已映射）。

- [ ] **步骤 3：提交**

```bash
git add extensions/subagents/src/types.ts
git commit -m "feat(subagents): add types.ts — all type definitions + EXCLUDED_TOOL_NAMES"
```

---

## 任务 3：并发池

**文件：**
- 创建：`extensions/subagents/src/pool/concurrency-pool.ts`
- 创建：`extensions/subagents/src/__tests__/concurrency-pool.test.ts`

**职责：** FR-7。Promise 队列实现的最大并发控制，支持优先级插队。无外部依赖。

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/concurrency-pool.test.ts
import { describe, it, expect, vi } from "vitest";
import { DefaultConcurrencyPool } from "../pool/concurrency-pool.ts";

describe("DefaultConcurrencyPool", () => {
  it("allows up to maxConcurrent concurrent tasks", async () => {
    const pool = new DefaultConcurrencyPool(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    };

    await pool.acquire();
    await pool.acquire();
    // 第三个 acquire 应阻塞
    let thirdAcquired = false;
    const third = pool.acquire().then(() => { thirdAcquired = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(thirdAcquired).toBe(false);
    expect(pool.activeCount).toBe(2);
    expect(pool.queueLength).toBe(1);

    pool.release();
    await third;
    expect(thirdAcquired).toBe(true);
    expect(pool.activeCount).toBe(2);

    pool.release();
    pool.release();
    await new Promise((r) => setTimeout(r, 5));
    expect(pool.activeCount).toBe(0);
  });

  it("higher priority acquires the pool first", async () => {
    const pool = new DefaultConcurrencyPool(1);
    await pool.acquire(); // 占满

    let lowAcquired = false;
    let highAcquired = false;
    const low = pool.acquire(10).then(() => { lowAcquired = true; });
    const high = pool.acquire(0).then(() => { highAcquired = true; });

    await new Promise((r) => setTimeout(r, 5));
    pool.release();
    await Promise.race([low, high, new Promise((r) => setTimeout(r, 20))]);

    expect(highAcquired).toBe(true);
    expect(lowAcquired).toBe(false);
    pool.release();
  });

  it("reports maxConcurrent", () => {
    const pool = new DefaultConcurrencyPool(4);
    expect(pool.maxConcurrent).toBe(4);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：FAIL，提示 `Cannot find module '../pool/concurrency-pool.ts'`

- [ ] **步骤 3：编写实现**

```typescript
// src/pool/concurrency-pool.ts
import type { ConcurrencyPool } from "../types.ts";

interface QueueEntry {
  priority: number;
  resolve: () => void;
  seq: number; // 入队顺序（同优先级 FIFO）
}

/**
 * Promise 队列实现的并发池。控制同时进行的任务数，支持优先级插队。
 * FR-7: acquire() 阻塞直到有空位；release() 释放并唤醒下一个。
 */
export class DefaultConcurrencyPool implements ConcurrencyPool {
  private active = 0;
  private readonly queue: QueueEntry[] = [];
  private seqCounter = 0;

  constructor(public readonly maxConcurrent: number) {}

  acquire(priority: number = Infinity): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push({ priority, resolve, seq: this.seqCounter++ });
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      // 取优先级最高（priority 最小）的；同优先级 FIFO（seq 最小）
      let bestIdx = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const cur = this.queue[i];
        const best = this.queue[bestIdx];
        if (cur.priority < best.priority || (cur.priority === best.priority && cur.seq < best.seq)) {
          bestIdx = i;
        }
      }
      const next = this.queue.splice(bestIdx, 1)[0];
      next.resolve();
      // active 不变（一个离开队列，立即进入活跃）
    } else {
      this.active--;
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get queueLength(): number {
    return this.queue.length;
  }
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：PASS（3 个用例）。

- [ ] **步骤 5：提交**

```bash
git add extensions/subagents/src/pool/concurrency-pool.ts extensions/subagents/src/__tests__/concurrency-pool.test.ts
git commit -m "feat(subagents): add ConcurrencyPool with priority queue"
```

---

## 任务 4：事件桥接

**文件：**
- 创建：`extensions/subagents/src/core/event-bridge.ts`
- 创建：`extensions/subagents/src/__tests__/event-bridge.test.ts`

**职责：** FR-8。把 Pi SDK 的 `AgentSessionEvent` 转换为 subagents 的 `AgentEvent`。纯函数，输入 SDK 事件 + 累计器，输出 subagents 事件。无 SDK 运行时调用。

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/event-bridge.test.ts
import { describe, it, expect, vi } from "vitest";
import { createEventBridge } from "../core/event-bridge.ts";
import type { AgentEvent } from "../types.ts";

describe("createEventBridge", () => {
  it("maps tool_execution_start → tool_start", () => {
    const events: AgentEvent[] = [];
    const bridge = createEventBridge((e) => events.push(e));
    bridge.handle({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} });
    expect(events).toEqual([{ type: "tool_start", toolName: "read" }]);
  });

  it("maps tool_execution_end → tool_end with result and isError", () => {
    const events: AgentEvent[] = [];
    const bridge = createEventBridge((e) => events.push(e));
    bridge.handle({
      type: "tool_execution_end",
      toolCallId: "1", toolName: "structured-output",
      result: { content: [{ type: "text", text: "done" }], details: { output: 42 } },
      isError: false,
    });
    expect(events).toEqual([{
      type: "tool_end", toolName: "structured-output",
      result: { content: [{ type: "text", text: "done" }], details: { output: 42 } },
      isError: false,
    }]);
  });

  it("maps turn_end and increments turn counter", () => {
    const events: AgentEvent[] = [];
    const bridge = createEventBridge((e) => events.push(e));
    bridge.handle({ type: "turn_end", message: {} as never, toolResults: [] });
    bridge.handle({ type: "turn_end", message: {} as never, toolResults: [] });
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(2);
    expect(bridge.turnCount).toBe(2);
  });

  it("maps message_end and extracts usage from message.usage", () => {
    const events: AgentEvent[] = [];
    const bridge = createEventBridge((e) => events.push(e));
    bridge.handle({
      type: "message_end",
      message: {
        usage: {
          input: 100, output: 200, cacheRead: 10, cacheWrite: 5, totalTokens: 315,
          cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.05, total: 3.15 },
        },
      } as never,
    });
    const me = events.find((e) => e.type === "message_end");
    expect(me).toEqual({
      type: "message_end",
      usage: { input: 100, output: 200, cacheRead: 10, cacheWrite: 5, cost: 3.15 },
    });
  });

  it("maps message_end with stopReason error → error event", () => {
    const events: AgentEvent[] = [];
    const bridge = createEventBridge((e) => events.push(e));
    bridge.handle({
      type: "message_end",
      message: { stopReason: "error", errorMessage: "rate limited", usage: null } as never,
    });
    expect(events.find((e) => e.type === "error")).toEqual({ type: "error", error: "rate limited" });
  });

  it("maps compaction_start → compaction", () => {
    const events: AgentEvent[] = [];
    const bridge = createEventBridge((e) => events.push(e));
    bridge.handle({ type: "compaction_start", reason: "threshold" });
    expect(events.find((e) => e.type === "compaction")).toBeDefined();
  });

  it("accumulates tool call records", () => {
    const bridge = createEventBridge(() => {});
    bridge.handle({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} });
    bridge.handle({
      type: "tool_execution_end", toolCallId: "1", toolName: "read",
      result: { content: [{ type: "text", text: "file" }] }, isError: false,
    });
    expect(bridge.toolCalls).toEqual([{
      toolName: "read",
      result: { content: [{ type: "text", text: "file" }] },
      isError: false,
    }]);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：FAIL，模块不存在。

- [ ] **步骤 3：编写实现**

```typescript
// src/core/event-bridge.ts
import type { AgentEvent, ToolCallEntry } from "../types.ts";

/** SDK AgentSessionEvent 的最小可用子集（结构 duck-typed，避免强耦合 SDK 类型） */
type SdkEvent = {
  type: string;
  toolCallId?: string;
  toolName?: string;
  result?: { content: unknown[]; details?: unknown };
  isError?: boolean;
  message?: {
    usage?: {
      input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
      cost?: { total: number };
    };
    stopReason?: string;
    errorMessage?: string;
  };
  assistantMessageEvent?: { delta?: string; textDelta?: string };
  reason?: string;
};

/**
 * FR-8: 把 SDK AgentSessionEvent 转换为 subagents AgentEvent，并累计 turn/toolCall。
 * 返回的对象含 handle()（传给 session.subscribe）和只读累计器。
 */
export function createEventBridge(onEvent: (event: AgentEvent) => void) {
  let turnCount = 0;
  const toolCalls: ToolCallEntry[] = [];
  // FR-8.3: usage 累加器——累加所有 message_end 事件的 usage
  let usageAccum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  // 记录正在进行的 tool 名（toolCallId → toolName），用于 end 时补全
  const pendingTools = new Map<string, string>();

  function handle(raw: SdkEvent): void {
    switch (raw.type) {
      case "tool_execution_start": {
        const toolName = raw.toolName ?? "unknown";
        if (raw.toolCallId) pendingTools.set(raw.toolCallId, toolName);
        onEvent({ type: "tool_start", toolName });
        break;
      }
      case "tool_execution_end": {
        const toolName = raw.toolName ?? pendingTools.get(raw.toolCallId ?? "") ?? "unknown";
        const result = raw.result as ToolCallEntry["result"] | undefined;
        const isError = raw.isError ?? false;
        toolCalls.push({ toolName, result, isError });
        onEvent({ type: "tool_end", toolName, result, isError });
        break;
      }
      case "message_update": {
        // SDK 无 text_delta，从 assistantMessageEvent 提取增量
        const delta = raw.assistantMessageEvent?.delta ?? raw.assistantMessageEvent?.textDelta;
        if (delta) onEvent({ type: "text_delta", delta });
        break;
      }
      case "turn_end": {
        turnCount++;
        onEvent({ type: "turn_end" });
        break;
      }
      case "message_end": {
        const msg = raw.message;
        if (msg) {
          // 优先检查错误 stopReason
          if (msg.stopReason === "error" || msg.stopReason === "aborted") {
            onEvent({ type: "error", error: msg.errorMessage ?? msg.stopReason });
          }
          // usage 提取 + 累加（FR-8.3: 一次 run 可能有多个 message_end）
          if (msg.usage) {
            const u = msg.usage;
            usageAccum = {
              input: usageAccum.input + u.input,
              output: usageAccum.output + u.output,
              cacheRead: usageAccum.cacheRead + u.cacheRead,
              cacheWrite: usageAccum.cacheWrite + u.cacheWrite,
              cost: usageAccum.cost + (u.cost?.total ?? 0),
            };
            onEvent({
              type: "message_end",
              usage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost?.total ?? 0 },
            });
          }
        }
        break;
      }
      case "compaction_start": {
        onEvent({ type: "compaction" });
        break;
      }
      // agent_start / agent_end / message_start / tool_execution_update / queue_update 等：忽略
    }
  }

  return {
    handle,
    get turnCount() { return turnCount; },
    get toolCalls() { return toolCalls; },
    get usage() { return usageAccum; },
  };
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：PASS（7 个用例）。

- [ ] **步骤 5：提交**

```bash
git add extensions/subagents/src/core/event-bridge.ts extensions/subagents/src/__tests__/event-bridge.test.ts
git commit -m "feat(subagents): add event-bridge — SDK AgentSessionEvent → AgentEvent mapping"
```

---

## 任务 5：输出收集器

**文件：**
- 创建：`extensions/subagents/src/core/output-collector.ts`
- 创建：`extensions/subagents/src/__tests__/output-collector.test.ts`

**职责：** FR-1.3。`prompt()` resolve 后从 `session.messages` 最后一条 assistant message 提取文本。纯函数。

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/output-collector.test.ts
import { describe, it, expect } from "vitest";
import { collectResponseText } from "../core/output-collector.ts";

describe("collectResponseText", () => {
  it("extracts text from last assistant message content", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [
        { type: "text", text: "first " },
        { type: "text", text: "response" },
      ] },
    ];
    expect(collectResponseText(messages as never)).toBe("first response");
  });

  it("returns empty string if no assistant message", () => {
    expect(collectResponseText([{ role: "user", content: "hi" } as never])).toBe("");
  });

  it("skips thinking content and tool calls, only concatenates text", () => {
    const messages = [{
      role: "assistant",
      content: [
        { type: "thinking", text: "internal" },
        { type: "text", text: "visible" },
        { type: "tool_call", name: "read" },
      ],
    }];
    expect(collectResponseText(messages as never)).toBe("visible");
  });

  it("handles empty messages array", () => {
    expect(collectResponseText([])).toBe("");
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：FAIL。

- [ ] **步骤 3：编写实现**

```typescript
// src/core/output-collector.ts
/**
 * FR-1.3: 从 session.messages 最后一条 assistant message 提取文本。
 * prompt() resolve 后 session.messages 已含最终 assistant message（同步属性）。
 * 只拼接 type === "text" 的 content part，跳过 thinking/tool_call。
 */
export function collectResponseText(messages: ReadonlyArray<{ role: string; content?: ReadonlyArray<{ type: string; text?: string }> }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    if (!msg.content) return "";
    return msg.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text!)
      .join("");
  }
  return "";
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：PASS（4 个用例）。

- [ ] **步骤 5：提交**

```bash
git add extensions/subagents/src/core/output-collector.ts extensions/subagents/src/__tests__/output-collector.test.ts
git commit -m "feat(subagents): add output-collector — extract final assistant text"
```

---

## 任务 6：turn 限制器

**文件：**
- 创建：`extensions/subagents/src/core/turn-limiter.ts`
- 创建：`extensions/subagents/src/__tests__/turn-limiter.test.ts`

**职责：** FR-1.4。soft turn limit（steer "wrap up"）+ hard abort（grace turns 后 abort）的状态机。

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/turn-limiter.test.ts
import { describe, it, expect, vi } from "vitest";
import { createTurnLimiter } from "../core/turn-limiter.ts";

describe("createTurnLimiter", () => {
  it("does nothing before maxTurns", () => {
    const steer = vi.fn();
    const abort = vi.fn();
    const limiter = createTurnLimiter({ maxTurns: 3, graceTurns: 2, steer, abort });
    limiter.onTurnEnd(1);
    limiter.onTurnEnd(2);
    expect(steer).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });

  it("steers on maxTurns and aborts after graceTurns", () => {
    const steer = vi.fn();
    const abort = vi.fn();
    const limiter = createTurnLimiter({ maxTurns: 3, graceTurns: 2, steer, abort });
    limiter.onTurnEnd(3); // 达到 maxTurns → steer
    expect(steer).toHaveBeenCalledWith("Wrap up your work now. Provide a final summary.");
    expect(abort).not.toHaveBeenCalled();
    limiter.onTurnEnd(4); // grace turn 1
    expect(abort).not.toHaveBeenCalled();
    limiter.onTurnEnd(5); // grace turn 2 → abort
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("disables when maxTurns is 0 or undefined", () => {
    const steer = vi.fn();
    const abort = vi.fn();
    const limiter = createTurnLimiter({ maxTurns: 0, graceTurns: 2, steer, abort });
    limiter.onTurnEnd(100);
    expect(steer).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });

  it("steers only once", () => {
    const steer = vi.fn();
    const abort = vi.fn();
    const limiter = createTurnLimiter({ maxTurns: 2, graceTurns: 3, steer, abort });
    limiter.onTurnEnd(2);
    limiter.onTurnEnd(3);
    expect(steer).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：FAIL。

- [ ] **步骤 3：编写实现**

```typescript
// src/core/turn-limiter.ts
const WRAP_UP_MESSAGE = "Wrap up your work now. Provide a final summary.";

/**
 * FR-1.4: Soft turn limit + hard abort 状态机。
 * - turn 达到 maxTurns 时调用 steer(WRAP_UP_MESSAGE)
 * - 再经过 graceTurns 后调用 abort()
 * - maxTurns <= 0 时禁用
 */
export function createTurnLimiter(opts: {
  maxTurns: number;
  graceTurns: number;
  steer: (message: string) => void;
  abort: () => void;
}) {
  let steered = false;
  let aborted = false;
  const limit = opts.maxTurns > 0 ? opts.maxTurns : Infinity;
  const grace = opts.graceTurns > 0 ? opts.graceTurns : 0;

  function onTurnEnd(turn: number): void {
    if (aborted || !isFinite(limit)) return;
    if (!steered && turn >= limit) {
      steered = true;
      opts.steer(WRAP_UP_MESSAGE);
    }
    if (steered && turn >= limit + grace) {
      aborted = true;
      opts.abort();
    }
  }

  return { onTurnEnd, get didSteer() { return steered; }, get didAbort() { return aborted; } };
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：PASS（4 个用例）。

- [ ] **步骤 5：提交**

```bash
git add extensions/subagents/src/core/turn-limiter.ts extensions/subagents/src/__tests__/turn-limiter.test.ts
git commit -m "feat(subagents): add turn-limiter — soft limit + hard abort state machine"
```

---

## 任务 7：frontmatter 解析

**文件：**
- 创建：`extensions/subagents/src/registry/frontmatter.ts`
- 创建：`extensions/subagents/src/__tests__/frontmatter.test.ts`

**职责：** FR-2.1。解析 agent `.md` 文件的 YAML frontmatter。从 workflow 的 `agent-discovery.ts` 迁移解析函数并扩展字段（tools/extensions/skills/category）。纯函数。

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/frontmatter.test.ts
import { describe, it, expect } from "vitest";
import { parseAgentFrontmatter } from "../registry/frontmatter.ts";

describe("parseAgentFrontmatter", () => {
  it("parses name/model/description + body as systemPrompt", () => {
    const md = `---
name: code-reviewer
model: deepseek-router/ds-pro
description: Reviews code
---
You are a code reviewer.`;
    const result = parseAgentFrontmatter(md, "reviewer.md");
    expect(result).toEqual({
      name: "code-reviewer",
      model: "deepseek-router/ds-pro",
      description: "Reviews code",
      systemPrompt: "You are a code reviewer.",
    });
  });

  it("uses filename as name when no frontmatter", () => {
    const result = parseAgentFrontmatter("Just a prompt.", "worker.md");
    expect(result.name).toBe("worker");
    expect(result.systemPrompt).toBe("Just a prompt.");
  });

  it("parses tools as comma-separated list", () => {
    const md = `---
name: scout
tools: read, bash, grep
---
Explore.`;
    const result = parseAgentFrontmatter(md, "scout.md");
    expect(result.tools).toEqual(["read", "bash", "grep"]);
  });

  it("parses extensions as boolean true", () => {
    const md = `---
name: worker
extensions: true
---
Do work.`;
    expect(parseAgentFrontmatter(md, "worker.md").extensions).toBe(true);
  });

  it("parses extensions as comma-separated whitelist", () => {
    const md = `---
name: worker
extensions: my-tool, other-tool
---
Do work.`;
    expect(parseAgentFrontmatter(md, "worker.md").extensions).toEqual(["my-tool", "other-tool"]);
  });

  it("parses skills as comma-separated list", () => {
    const md = `---
name: worker
skills: code-review, testing
---
Do work.`;
    expect(parseAgentFrontmatter(md, "worker.md").skills).toEqual(["code-review", "testing"]);
  });

  it("parses category field", () => {
    const md = `---
name: worker
category: coding
---
Do work.`;
    expect(parseAgentFrontmatter(md, "worker.md").category).toBe("coding");
  });

  it("handles unclosed frontmatter gracefully", () => {
    const md = `---
name: broken
this has no closing delim`;
    const result = parseAgentFrontmatter(md, "broken.md");
    expect(result.name).toBe("broken");
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：FAIL。

- [ ] **步骤 3：编写实现**（迁移自 workflow `agent-discovery.ts`，扩展字段）

```typescript
// src/registry/frontmatter.ts

export interface ParsedFrontmatter {
  name: string;
  systemPrompt: string;
  model?: string;
  description?: string;
  /** builtin tool 白名单（逗号分隔），undefined=未指定（=全部） */
  tools?: string[];
  /** extension 策略：true=全部，逗号列表=白名单，未指定=undefined */
  extensions?: boolean | string[];
  skills?: string[];
  category?: string;
}

const FM_DELIM = "---";
const FM_DELIM_LEN = FM_DELIM.length;

/**
 * FR-2.1: 解析 .md agent 文件的 frontmatter。
 * 兼容 workflow 的简单 YAML 格式（key: value），扩展 tools/extensions/skills/category 字段。
 * 限制：YAML 值中单独成行的 --- 会被误截断（与 workflow 一致）。
 */
export function parseAgentFrontmatter(content: string, fileName: string): ParsedFrontmatter {
  const baseName = fileName.replace(/\.md$/, "");

  if (!content.startsWith(FM_DELIM)) {
    return { name: baseName, systemPrompt: content.trim() };
  }

  const closeIdx = content.indexOf(FM_DELIM, FM_DELIM_LEN);
  if (closeIdx === -1) {
    // 未闭合 frontmatter：尝试提取 name，其余作为 systemPrompt
    const yamlBlock = content.slice(FM_DELIM_LEN);
    const name = extractYamlField(yamlBlock, "name") || baseName;
    return { name, systemPrompt: content.trim() };
  }

  const yamlBlock = content.slice(FM_DELIM_LEN, closeIdx);
  const body = content.slice(closeIdx + FM_DELIM_LEN).trim();

  const name = extractYamlField(yamlBlock, "name") || baseName;
  const model = extractYamlField(yamlBlock, "model") || undefined;
  const description = extractYamlField(yamlBlock, "description") || undefined;
  const category = extractYamlField(yamlBlock, "category") || undefined;

  const toolsRaw = extractYamlField(yamlBlock, "tools");
  const tools = toolsRaw ? toolsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  const extRaw = extractYamlField(yamlBlock, "extensions");
  let extensions: boolean | string[] | undefined;
  if (extRaw === "true") extensions = true;
  else if (extRaw === "false") extensions = false;
  else if (extRaw) extensions = extRaw.split(",").map((s) => s.trim()).filter(Boolean);

  const skillsRaw = extractYamlField(yamlBlock, "skills");
  const skills = skillsRaw ? skillsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  return {
    name, systemPrompt: body,
    model, description, category, tools, extensions, skills,
  };
/** 提取简单 `key: value` 字段，剥离引号。 */
function extractYamlField(yaml: string, key: string): string | null {
  const regex = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const match = yaml.match(regex);
  if (!match) return null;
  let value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value || null;
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：PASS（8 个用例）。

- [ ] **步骤 5：提交**

```bash
git add extensions/subagents/src/registry/frontmatter.ts extensions/subagents/src/__tests__/frontmatter.test.ts
git commit -m "feat(subagents): add frontmatter parser (migrated+extended from workflow)"
```

---

## 任务 8：category 推断

**文件：**
- 创建：`extensions/subagents/src/category.ts`
- 创建：`extensions/subagents/src/__tests__/category.test.ts`

**职责：** FR-4.5。6 个默认 category 定义 + `inferCategory()` 推断逻辑。纯函数。

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/category.test.ts
import { describe, it, expect } from "vitest";
import { DEFAULT_CATEGORIES, inferCategory } from "../category.ts";

describe("DEFAULT_CATEGORIES", () => {
  it("has 6 default categories", () => {
    expect(Object.keys(DEFAULT_CATEGORIES).sort()).toEqual(
      ["coding", "general", "planning", "research", "testing", "vision"]
    );
  });
});

describe("inferCategory", () => {
  it("uses agentConfig.category when present", () => {
    expect(inferCategory("worker", { category: "vision" } as never, {})).toBe("vision");
  });

  it("uses agentCategoryOverrides when no explicit category", () => {
    expect(inferCategory("worker", {} as never, { worker: "coding" })).toBe("coding");
  });

  it("infers by name convention: review/reviewer → coding", () => {
    expect(inferCategory("code-reviewer", {} as never, {})).toBe("coding");
  });

  it("infers by name convention: search/research → research", () => {
    expect(inferCategory("web-researcher", {} as never, {})).toBe("research");
  });

  it("infers by name convention: test/tester → testing", () => {
    expect(inferCategory("unit-tester", {} as never, {})).toBe("testing");
  });

  it("infers by name convention: plan/planner → planning", () => {
    expect(inferCategory("task-planner", {} as never, {})).toBe("planning");
  });

  it("defaults to general", () => {
    expect(inferCategory("random-agent", {} as never, {})).toBe("general");
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：FAIL。

- [ ] **步骤 3：编写实现**

```typescript
// src/category.ts
import type { CategoryDefinition } from "./types.ts";

/** FR-4.5.1: 6 个默认 category */
export const DEFAULT_CATEGORIES: Record<string, CategoryDefinition> = {
  coding:   { label: "编码", model: "deepseek-router/ds-flash", thinkingLevel: "high" },
  research: { label: "调研", model: "mimo-router/mimo-v2.5", thinkingLevel: "medium" },
  testing:  { label: "测试", model: "mimo-router/mimo-v2.5", thinkingLevel: "low" },
  vision:   { label: "视觉", model: "zhipu-coding-plan-router/glm-5.1", thinkingLevel: "xhigh" },
  planning: { label: "规划", model: "deepseek-router/ds-pro", thinkingLevel: "xhigh" },
  general:  { label: "通用", model: "mimo-router/mimo-v2.5", thinkingLevel: "low" },
};

/** name → category 的推断正则（按优先级） */
const NAME_INFERENCE: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /cod|review|fix|refactor|implement|develop/i, category: "coding" },
  { pattern: /research|search|investigat|scout|explore/i, category: "research" },
  { pattern: /test|qa|lint|valid/i, category: "testing" },
  { pattern: /plan|architect|design|strateg/i, category: "planning" },
  { pattern: /vision|image|ocr|visual/i, category: "vision" },
];

/**
 * FR-4.5.3: 推断 agent 类别。
 * 优先级：agentConfig.category > agentCategoryOverrides > 名称正则 > "general"
 */
export function inferCategory(
  agentName: string,
  agentConfig: { category?: string } | undefined,
  overrides: Record<string, string>,
): string {
  if (agentConfig?.category) return agentConfig.category;
  if (overrides[agentName]) return overrides[agentName];
  for (const { pattern, category } of NAME_INFERENCE) {
    if (pattern.test(agentName)) return category;
  }
  return "general";
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：PASS（7 个用例）。

- [ ] **步骤 5：提交**

```bash
git add extensions/subagents/src/category.ts extensions/subagents/src/__tests__/category.test.ts
git commit -m "feat(subagents): add category system — 6 defaults + inferCategory()"
```

---

## 任务 9：全局配置

**文件：**
- 创建：`extensions/subagents/src/config/config-path.ts`
- 创建：`extensions/subagents/src/config/global-config.ts`
- 创建：`extensions/subagents/src/__tests__/global-config.test.ts`

**职责：** FR-4.6。load/save config.json，含原子写入 + 串行化队列。依赖 `DEFAULT_CATEGORIES`（任务 8）和 types（任务 2）。

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/global-config.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadGlobalConfig, saveGlobalConfig } from "../config/global-config.ts";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-test-"));
});
afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("loadGlobalConfig", () => {
  it("returns defaults when file missing", () => {
    const cfg = loadGlobalConfig(tempDir);
    expect(cfg.version).toBe(1);
    expect(cfg.yoloByDefault).toBe(false);
    expect(cfg.maxConcurrent).toBe(4);
    expect(cfg.categories.coding.model).toBe("deepseek-router/ds-flash");
    expect(cfg.fallback.model).toBe("mimo-router/mimo-v2.5");
  });

  it("merges user config over defaults (partial)", () => {
    const dir = path.join(tempDir, ".pi", "agent", "extensions", "subagents");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      version: 1, maxConcurrent: 8,
    }));
    const cfg = loadGlobalConfig(tempDir);
    expect(cfg.maxConcurrent).toBe(8);       // 用户覆盖
    expect(cfg.yoloByDefault).toBe(false);   // 默认保留
    expect(cfg.categories.research.model).toBe("mimo-router/mimo-v2.5"); // 默认 category 保留
  });
});

describe("saveGlobalConfig", () => {
  it("writes config and reloads same data", () => {
    const cfg = loadGlobalConfig(tempDir);
    cfg.yoloByDefault = true;
    saveGlobalConfig(tempDir, cfg);
    const reloaded = loadGlobalConfig(tempDir);
    expect(reloaded.yoloByDefault).toBe(true);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：FAIL。

- [ ] **步骤 3：创建 `config/config-path.ts`**

```typescript
// src/config/config-path.ts
import * as path from "node:path";

/** FR-4.6.1: config.json 路径 */
export function getConfigDir(homeDir: string): string {
  return path.join(homeDir, ".pi", "agent", "extensions", "subagents");
}

export function getConfigPath(homeDir: string): string {
  return path.join(getConfigDir(homeDir), "config.json");
}
```

- [ ] **步骤 4：创建 `config/global-config.ts`**

```typescript
// src/config/global-config.ts
import * as fs from "node:fs";
import type { SubagentsGlobalConfig } from "../types.ts";
import { DEFAULT_CATEGORIES } from "../category.ts";
import { getConfigDir, getConfigPath } from "./config-path.ts";

const DEFAULT_CONFIG: SubagentsGlobalConfig = {
  version: 1,
  yoloByDefault: false,
  maxConcurrent: 4,
  categories: { ...DEFAULT_CATEGORIES },
  agentCategoryOverrides: { worker: "coding", reviewer: "coding", scout: "research" },
  fallback: { model: "mimo-router/mimo-v2.5", thinkingLevel: "low" },
};

/** FR-4.6.3: 加载配置，缺失字段用默认值填充。文件不存在返回全默认。 */
export function loadGlobalConfig(homeDir: string): SubagentsGlobalConfig {
  const configPath = getConfigPath(homeDir);
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SubagentsGlobalConfig>;
    return {
      version: parsed.version ?? DEFAULT_CONFIG.version,
      yoloByDefault: parsed.yoloByDefault ?? DEFAULT_CONFIG.yoloByDefault,
      maxConcurrent: parsed.maxConcurrent ?? DEFAULT_CONFIG.maxConcurrent,
      categories: { ...DEFAULT_CONFIG.categories, ...parsed.categories },
      agentCategoryOverrides: { ...DEFAULT_CONFIG.agentCategoryOverrides, ...parsed.agentCategoryOverrides },
      fallback: { ...DEFAULT_CONFIG.fallback, ...parsed.fallback },
    };
  } catch {
    // 文件不存在或 JSON 解析失败 → 返回默认配置的深拷贝
    return {
      ...DEFAULT_CONFIG,
      categories: { ...DEFAULT_CONFIG.categories },
      agentCategoryOverrides: { ...DEFAULT_CONFIG.agentCategoryOverrides },
      fallback: { ...DEFAULT_CONFIG.fallback },
    };
  }
}

// FR-4.6.4: 串行化写队列，防止并发写入覆盖
let writeChain: Promise<void> = Promise.resolve();

/** FR-4.6.4: 原子写入（temp + rename）+ 进程内串行化 */
export function saveGlobalConfig(homeDir: string, config: SubagentsGlobalConfig): Promise<void> {
  const configPath = getConfigPath(homeDir);
  const configDir = getConfigDir(homeDir);

  const actualWrite = (): Promise<void> =>
    new Promise((resolve, reject) => {
      try {
        fs.mkdirSync(configDir, { recursive: true });
        const tempPath = configPath + ".tmp." + process.pid;
        fs.writeFileSync(tempPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
        fs.renameSync(tempPath, configPath);
        resolve();
      } catch (err) {
        reject(err);
      }
    });

  writeChain = writeChain.then(actualWrite, actualWrite);
  return writeChain;
}
```

- [ ] **步骤 5：运行测试确认通过**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：PASS（3 个用例）。

- [ ] **步骤 6：提交**

```bash
git add extensions/subagents/src/config/ extensions/subagents/src/__tests__/global-config.test.ts
git commit -m "feat(subagents): add global-config — load/save with atomic write + serial queue"
```

---

## 任务 10：builtin agents + agent-registry

**文件：**
- 创建：`extensions/subagents/src/registry/builtin-agents.ts`
- 创建：`extensions/subagents/src/registry/agent-registry.ts`
- 创建：`extensions/subagents/src/__tests__/agent-registry.test.ts`

**职责：** FR-2。`BuiltinAgentRegistry`（7 个内置 agent + 第三方注册）和 `AgentRegistry`（文件系统扫描 + 优先级合并）。依赖 frontmatter（任务 7）。

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/agent-registry.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BUILTIN_AGENTS, BuiltinAgentRegistry } from "../registry/builtin-agents.ts";
import { AgentRegistry } from "../registry/agent-registry.ts";

let tempDir: string;
let tempHome: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sub-cwd-"));
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "sub-home-"));
});

describe("BUILTIN_AGENTS", () => {
  it("has 7 builtin agents", () => {
    const names = BUILTIN_AGENTS.map((a) => a.name).sort();
    expect(names).toEqual(
      ["context-builder", "oracle", "planner", "researcher", "reviewer", "scout", "worker"]
    );
  });

  it("worker has extensions=true and builtin=all(undefined)", () => {
    const worker = BUILTIN_AGENTS.find((a) => a.name === "worker")!;
    expect(worker.extensions).toBe(true);
    expect(worker.builtinTools).toBeUndefined();
  });

  it("reviewer has extensions=false and builtin=[read]", () => {
    const reviewer = BUILTIN_AGENTS.find((a) => a.name === "reviewer")!;
    expect(reviewer.extensions).toBe(false);
    expect(reviewer.builtinTools).toEqual(["read"]);
  });
});

describe("BuiltinAgentRegistry", () => {
  it("allows registering custom builtin agents", () => {
    const reg = new BuiltinAgentRegistry();
    reg.register({
      name: "my-agent", systemPrompt: "custom",
      source: "builtin", builtinTools: ["read"], extensions: false,
    });
    expect(reg.get("my-agent")?.systemPrompt).toBe("custom");
  });

  it("get returns undefined for unknown", () => {
    const reg = new BuiltinAgentRegistry();
    expect(reg.get("nope")).toBeUndefined();
  });

  it("list returns all including defaults", () => {
    const reg = new BuiltinAgentRegistry();
    expect(reg.list().length).toBeGreaterThanOrEqual(7);
  });
});

describe("AgentRegistry", () => {
  it("discovers project-level .pi/agents/*.md", () => {
    const agentsDir = path.join(tempDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "custom.md"), `---
name: custom
model: deepseek-router/ds-flash
---
Custom prompt.`);
    const reg = new AgentRegistry(tempDir, tempHome);
    reg.discoverAll(new BuiltinAgentRegistry());
    expect(reg.get("custom")?.model).toBe("deepseek-router/ds-flash");
    expect(reg.get("custom")?.source).toBe("project");
  });

  it("builtin agents available when no file agents", () => {
    const reg = new AgentRegistry(tempDir, tempHome);
    reg.discoverAll(new BuiltinAgentRegistry());
    expect(reg.get("worker")?.source).toBe("builtin");
  });

  it("project-level overrides user-level (last writer wins)", () => {
    // user 级
    const userAgents = path.join(tempHome, ".pi", "agent", "agents");
    fs.mkdirSync(userAgents, { recursive: true });
    fs.writeFileSync(path.join(userAgents, "shared.md"), `---
name: shared
description: user version
---
user`);
    // project 级（优先级更高，后扫描覆盖）
    const projAgents = path.join(tempDir, ".pi", "agents");
    fs.mkdirSync(projAgents, { recursive: true });
    fs.writeFileSync(path.join(projAgents, "shared.md"), `---
name: shared
description: project version
---
project`);

    const reg = new AgentRegistry(tempDir, tempHome);
    reg.discoverAll(new BuiltinAgentRegistry());
    expect(reg.get("shared")?.description).toBe("project version");
    expect(reg.get("shared")?.source).toBe("project");
  });

  it("get throws for unknown agent when throwOnMissing=true", () => {
    const reg = new AgentRegistry(tempDir, tempHome);
    reg.discoverAll(new BuiltinAgentRegistry());
    expect(() => reg.get("nonexistent", true)).toThrow(/nonexistent/);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：FAIL。

- [ ] **步骤 3：创建 `registry/builtin-agents.ts`**

```typescript
// src/registry/builtin-agents.ts
import type { AgentConfig } from "../types.ts";

/** FR-2.2: 内置 agent 定义。默认 model 为空（由 category 解析时填充）。 */
export const BUILTIN_AGENTS: readonly AgentConfig[] = [
  {
    name: "worker", source: "builtin",
    systemPrompt: "You are a coding agent. Complete the task precisely.",
    description: "通用执行 agent（编码、修复、文件操作）",
    extensions: true, builtinTools: undefined, // all
  },
  {
    name: "reviewer", source: "builtin",
    systemPrompt: "You are a code reviewer. Find bugs, logic errors, and security issues.",
    description: "代码审查 agent",
    extensions: false, builtinTools: ["read"],
  },
  {
    name: "researcher", source: "builtin",
    systemPrompt: "You are a web researcher. Search, evaluate, and synthesize findings.",
    description: "网络调研 agent",
    extensions: false, builtinTools: ["read", "web_search"],
  },
  {
    name: "scout", source: "builtin",
    systemPrompt: "You are a codebase recon agent. Explore structure and return compressed context.",
    description: "快速代码库侦查",
    extensions: false, builtinTools: ["read", "bash", "grep"],
  },
  {
    name: "planner", source: "builtin",
    systemPrompt: "You are a planning agent. Break down tasks and create implementation plans.",
    description: "实施计划 agent",
    extensions: false, builtinTools: ["read"],
  },
  {
    name: "oracle", source: "builtin",
    systemPrompt: "You are a decision oracle. Protect inherited state and prevent drift.",
    description: "高上下文决策一致性守护",
    extensions: false, builtinTools: ["read"],
  },
  {
    name: "context-builder", source: "builtin",
    systemPrompt: "You are a context builder. Analyze requirements and generate meta-prompts.",
    description: "需求分析与元提示生成",
    extensions: false, builtinTools: ["read"],
  },
] as const;

/**
 * FR-2.2: BuiltinAgentRegistry 持有内置 + 第三方注册的 agent。
 * 允许第三方扩展在 session_start 时 register() 自定义 builtin。
 */
export class BuiltinAgentRegistry {
  private readonly agents = new Map<string, AgentConfig>();

  constructor() {
    for (const agent of BUILTIN_AGENTS) {
      this.agents.set(agent.name, { ...agent });
    }
  }

  /** 注册自定义 builtin agent。覆盖同名。 */
  register(config: AgentConfig): void {
    this.agents.set(config.name, { ...config, source: config.source ?? "builtin" });
  }

  get(name: string): AgentConfig | undefined {
    return this.agents.get(name);
  }

  list(): AgentConfig[] {
    return [...this.agents.values()];
  }
}
```

- [ ] **步骤 4：创建 `registry/agent-registry.ts`**（迁移自 workflow `agent-discovery.ts`，适配 AgentConfig）

```typescript
// src/registry/agent-registry.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig, AgentSource } from "../types.ts";
import { parseAgentFrontmatter } from "./frontmatter.ts";
import type { BuiltinAgentRegistry } from "./builtin-agents.ts";

/**
 * FR-2.1 / FR-2.3: 扫描文件系统发现 agent + builtin，按优先级合并。
 * 优先级：project > user > package > local > builtin（last writer wins）。
 */
export class AgentRegistry {
  private readonly cache = new Map<string, AgentConfig>();

  constructor(
    private readonly cwd: string,
    private readonly homeDir: string = os.homedir(),
  ) {}

  /** 扫描所有路径 + 合并 builtin。清空缓存后重新填充。 */
  discoverAll(builtins: BuiltinAgentRegistry): void {
    this.cache.clear();

    const home = this.homeDir;
    // 低→高优先级扫描（Map.set 覆盖）
    const targets: Array<{ dir: string; source: AgentSource; kind: "direct" | "extensions" | "npm" }> = [
      { dir: path.join(this.cwd, "extensions"), source: "local", kind: "extensions" },
      { dir: path.join(this.cwd, ".pi", "npm", "node_modules"), source: "package", kind: "npm" },
      { dir: path.join(home, ".pi", "agent", "npm", "node_modules"), source: "package", kind: "npm" },
      { dir: path.join(home, ".agents", "agents"), source: "user", kind: "direct" },
      { dir: path.join(home, ".pi", "agent", "agents"), source: "user", kind: "direct" },
      { dir: path.join(this.cwd, ".agents", "agents"), source: "project", kind: "direct" },
      { dir: path.join(this.cwd, ".pi", "agents"), source: "project", kind: "direct" },
    ];

    for (const t of targets) {
      if (t.kind === "extensions") this.scanExtensionsDir(t.dir, t.source);
      else if (t.kind === "npm") this.scanNpmDir(t.dir, t.source);
      else this.scanDir(t.dir, t.source);
    }

    // builtin 优先级最低（先写入，被文件 agent 覆盖）
    for (const agent of builtins.list()) {
      if (!this.cache.has(agent.name)) {
        this.cache.set(agent.name, agent);
      }
    }
  }

  /**
   * FR-2.3: 按名查找。优先级已在 discoverAll 中通过 last-writer-wins 体现。
   * throwOnMissing=true 时找不到抛错。
   */
  get(name: string, throwOnMissing: boolean = false): AgentConfig | undefined {
    const config = this.cache.get(name);
    if (!config && throwOnMissing) {
      throw new Error(`Agent "${name}" not found. Discovered: ${[...this.cache.keys()].join(", ") || "(none)"}`);
    }
    return config;
  }

  list(): AgentConfig[] {
    return [...this.cache.values()];
  }

  // ── 扫描 helpers（迁移自 workflow agent-discovery.ts）────────

  private scanExtensionsDir(extensionsDir: string, source: AgentSource): void {
    let entries: string[];
    try { entries = fs.readdirSync(extensionsDir); } catch { return; }
    for (const entry of entries) {
      this.scanDir(path.join(extensionsDir, entry, "agents"), source);
    }
  }

  private scanNpmDir(nodeModulesDir: string, source: AgentSource): void {
    let entries: string[];
    try { entries = fs.readdirSync(nodeModulesDir); } catch { return; }
    for (const entry of entries) {
      const entryPath = path.join(nodeModulesDir, entry);
      if (entry.startsWith("@")) {
        let scoped: string[];
        try { scoped = fs.readdirSync(entryPath); } catch { continue; }
        for (const pkg of scoped) {
          this.scanDir(path.join(entryPath, pkg, "agents"), source);
        }
      } else {
        this.scanDir(path.join(entryPath, "agents"), source);
      }
    }
  }

  private scanDir(dir: string, source: AgentSource): void {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (!entry.endsWith(".md") || entry.startsWith("_") || entry.endsWith(".chain.md")) continue;
      const filePath = path.join(dir, entry);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const parsed = parseAgentFrontmatter(content, entry);
        this.cache.set(parsed.name, {
          name: parsed.name,
          systemPrompt: parsed.systemPrompt,
          model: parsed.model,
          description: parsed.description,
          builtinTools: parsed.tools,
          extensions: parsed.extensions,
          skills: parsed.skills,
          category: parsed.category,
          source,
          filePath,
        });
      } catch { /* 文件不可读，跳过 */ }
    }
  }
}
```

- [ ] **步骤 5：运行测试确认通过**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：PASS（11 个用例）。

- [ ] **步骤 6：提交**

```bash
git add extensions/subagents/src/registry/ extensions/subagents/src/__tests__/agent-registry.test.ts
git commit -m "feat(subagents): add builtin-agents + agent-registry with priority scan"
```

---

> **任务 11-16 见 part 2 文档：** [`./plan-1-part2-core.md`](./plan-1-part2-core.md)
>
> 剩余任务涉及更多 SDK 集成（model-resolver 的 fallback 链、runAgent 的完整编排、ManagedSession、runtime 单例、config-wizard 级联交互），拆分到独立文档以保持可读性。

---
