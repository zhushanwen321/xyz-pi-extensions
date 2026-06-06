# Pi Extension 开发规范

> 基于对 Pi 生态社区 15+ 扩展（pi-mono SDK、pi-mcp-adapter、pi-subagents、pi-web-access、pi-context-prune、pi-ask-user、pi-powerline-footer、pi-model-switch、pi-hashline-edit、pi-rtk、pi-interactive-shell、pi-design-deck、pi-coordination、pi-askuserquestion 等）及 xyz-pi-extensions 项目自身实践的逆向分析总结。
>
> 最后更新：2026-06-02

---

## 术语约定

| 分类标签 | 含义 | 遵守强度 |
|---------|------|---------|
| **[规范]** | 必须遵守的规则。违反会导致代码审查不通过或有运行时风险 | 必须 |
| **[指南]** | 推荐做法。不遵守不视为违规但应有合理理由 | 推荐 |

---

## 目录

- [第一部分：Pi 扩展特有的规范](#第一部分pi-扩展特有的规范)
  - [1. 包结构与命名](#1-包结构与命名规范)
  - [2. 入口与工厂模式](#2-入口与工厂模式规范)
  - [3. 模块职责划分](#3-模块职责划分规范)
  - [4. Tool 注册与设计](#4-tool-注册与设计规范)
  - [5. Command 注册](#5-command-注册规范)
  - [6. 事件生命周期管理](#6-事件生命周期管理规范)
  - [7. 状态与会话管理](#7-状态与会话管理规范)
  - [8. 配置管理](#8-配置管理规范)
  - [9. 依赖管理](#9-依赖管理规范)
- [第二部分：通用的高质量工程规范](#第二部分通用的高质量工程规范)
  - [10. 错误处理与弹性模式](#10-错误处理与弹性模式规范)
  - [11. 类型安全](#11-类型安全规范)
  - [12. 路径与配置硬编码](#12-路径与配置硬编码规范)
  - [13. 健壮性基础要求](#13-健壮性基础要求规范)
- [第三部分：开发指南](#第三部分开发指南)
  - [14. TUI 渲染指南](#14-tui-渲染指南)
  - [15. 模块组织指南](#15-模块组织指南)
  - [16. 性能指南](#16-性能指南)
  - [17. 测试指南](#17-测试指南)
- [第四部分：附录](#第四部分附录)
  - [18. 反模式清单](#18-反模式清单)
  - [19. 新扩展检查清单](#19-新扩展检查清单)

---

# 第一部分：Pi 扩展特有的规范

## 1. 包结构与命名 **[规范]**

### 1.1 npm 包名

```
@scope/pi-<name>
```

示例：`@zhushanwen/pi-goal`、`@zhushanwen/pi-todo`

### 1.2 package.json 必需字段

**[规范]** package.json 必须包含以下字段：

```jsonc
{
  "name": "@scope/pi-extension-name",
  "version": "0.1.0",
  "description": "一句话说清功能",
  "type": "module",
  "license": "MIT",
  "files": [
    "index.ts",
    "src/**/*.ts",
    "skills/**/*",
    "README.md",
    "LICENSE"
  ],
  "pi": {
    "extensions": ["./index.ts"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  },

`pi.extensions` **必须**为 `["./index.ts"]`，禁止使用 `["./src/index.ts"]`。顶层 `index.ts` 作为 re-export 胶水层（`export { default } from "./src/index.ts"`），确保 Pi 扩展加载列表中统一显示纯包名而非包名+子路径。
  "keywords": ["pi-package", "pi", "pi-coding-agent", "extension"],
  "peerDependencies": { /* 见第 9 节 */ },
  "main": "index.ts"  // 非必须，但建议
}
```

**[规范]** `type: "module"` 必须设定——Pi 运行时使用 ESM 加载扩展。

**[规范]** `files` 必须包含入口 `.ts` 文件，否则 npm publish 后丢失入口。

**[规范]** `pi.extensions` 数组指向入口 TypeScript 文件（值为 `["./index.ts"]` 或 `["./dist/index.js"]`）。

### 1.3 Pi SDK 包引用

**[规范]** Pi SDK 包始终用 `peerDependencies`（非 `dependencies`），由 Pi 运行时提供。

当前 xyz-pi 的 SDK scope 分布（xyz-pi v0.75.5-xyz-0.4）：

| 包 | 作用域 | 说明 |
|---|---|---|
| `pi-coding-agent` | `@mariozechner` | **主 API 包**。来源：xyz-pi 的 dist/index.d.ts。TUI/AI 的入口 |
| `pi-tui` | `@earendil-works` | TUI 组件库（Container/Text/Box/Markdown 等） |
| `pi-ai` | `@earendil-works` | AI 工具（StringEnum / complete / getModel 等） |
| `pi-agent-core` | `@earendil-works` | Agent 核心类型（仅 subagent 场景） |

```jsonc
// 标准 package.json
{
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "@earendil-works/pi-ai": "*",
    "@sinclair/typebox": "*"
  },
  "peerDependenciesMeta": {
    "@earendil-works/pi-tui": { "optional": true },
    "@earendil-works/pi-ai": { "optional": true }
  }
}
```

**[规范]** `@mariozechner/pi-coding-agent` 是核心依赖，**不能设为 optional**。

**[指南]** TUI 和 AI 包按需声明，设为 optional 可降低纯工具扩展的依赖要求。

---

## 2. 入口与工厂模式 **[规范]**

### 2.1 工厂函数签名

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  // 注册 tools、commands、event handlers
}
```

**[规范]** 必须使用 `export default function(pi: ExtensionAPI)` 形式。这是 Pi 运行时识别扩展的入口点。

**[规范]** 函数名用匿名函数或 `extension`，不命名（无调用方）。

### 2.2 模块化入口

**[规范]** 超过 100 行的工厂函数应按功能委托到子模块：

```typescript
// index.ts — 包入口 re-export
export { default } from "./src/index.ts";

// src/index.ts — 工厂
import { registerTools } from "./tools";
import { registerCommands } from "./commands";
import { setupEventHandlers } from "./events";

export default function (pi: ExtensionAPI): void {
  registerTools(pi);
  registerCommands(pi);
  setupEventHandlers(pi);
}
```

### 2.3 闭包状态隔离 **[核心规范]**

**[规范]** 所有状态变量必须在工厂函数闭包内声明，禁止模块级 let 变量。

```typescript
// ✅ 正确：闭包内
export default function (pi: ExtensionAPI) {
  const state = { count: 0, items: [] as string[] };
  const pendingQueue: Item[] = [];
  let isFlushing = false;

  pi.registerTool({ ... });
}

// ❌ 错误：模块级，被所有 session 共享
let globalState = { count: 0 };
export default function (pi: ExtensionAPI) {
  pi.registerTool({ ... });
}
```

---

## 3. 模块职责划分 **[规范]**

### 3.1 各模块职责

| 文件 | 职责 | 必须 |
|------|------|------|
| `src/types.ts` | 类型定义、常量、TypeBox schema | 推荐 |
| `src/state.ts` | 状态机、createInitialState、deserializeState | 有状态时强制 |
| `src/config.ts` | 配置加载/保存/校验 | 有配置时强制 |
| `src/templates.ts` | Steering prompt 模板函数 | 有时用 |
| `src/commands.ts` | /command handler + TUI 渲染 | 有 command 时 |
| `src/widget.ts` | TUI widget 及 renderCall/renderResult | 需要 TUI 时 |

### 3.2 types.ts 规范

**[规范]** 工具参数类型、详情类型、状态类型集中到 `types.ts`，禁止散落各文件。

**[规范]** 跨文件共用类型必须提取到 `types.ts`，禁止多文件重复定义同名 interface。

```typescript
// types.ts
import type { Static } from "typebox";
import { Type } from "@mariozechner/pi-coding-agent"; // StringEnum 等

// ---- 常量 ----
export const WIDGET_KEY = "my-extension-widget";
export const CUSTOM_TYPE_EVENT = "my-extension-event";

// ---- TypeBox Schema ----
export const MyParams = Type.Object({
  action: Type.String({ description: "Action to perform" }),
});
export type MyParamsType = Static<typeof MyParams>;

// ---- 详情类型 (renderResult 数据来源) ----
export interface MyDetails {
  items: string[];
  count: number;
  cancelled: boolean;
}
```

---

## 4. Tool 注册与设计 **[规范]**

### 4.1 注册格式

```typescript
pi.registerTool({
  name: "my_tool",                              // 蛇形命名
  label: "My Tool",                             // 对人类展示
  description: "What this tool does in detail", // 模型理解用
  promptSnippet: "Brief usage hint for model",   // [指南] AI 摘要
  promptGuidelines: [                           // [指南] 使用禁忌
    "Use this tool when ...",
    "Do NOT use for ...",
  ],
  parameters: Type.Object({ ... }),
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    // 见下面
  },
  renderCall: (params, options, theme) => new Text("...", 0, 0),
  renderResult: (details, options, theme) => new Text("...", 0, 0),
});
```

### 4.2 execute 实现规范

**[规范]** 返回值格式必须为：

```typescript
{
  content: [{ type: "text", text: string }],
  isError?: boolean,       // 错误时设为 true
  details?: Record<string, unknown>  // renderResult 数据
}
```

**[规范]** 错误必须返回结构化 `{ isError: true }`，**禁止抛异常**。

```typescript
async execute(_toolCallId, params, signal, _onUpdate, ctx) {
  // ✅ 正确
  try {
    const result = await riskyOperation();
    return { content: [{ type: "text", text: `Success: ${result}` }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }

  // ❌ 错误
  try {
    const result = await riskyOperation();
    return { content: [{ type: "text", text: `Success: ${result}` }] };
  } catch (err) {
    throw new Error(`Failed: ${err}`); // 抛异常导致 Tool 中断，Pi 可能崩溃
  }
}
```

**[规范]** execute 内部的异步操作必须透传 `signal` 参数支持取消。

**[规范]** 参数使用 TypeBox `Type.Object()` 定义，每个字段加 `description`。

### 4.3 details 与 renderResult 契约

**[规范]** `details` 是 `renderResult` 的唯一数据来源，renderResult 不能解析 `content` 文本。

```typescript
// types.ts
export interface MyDetails {
  count: number;
  items: string[];
  cancelled: boolean;
}

// render.ts
function renderMyResult(details: MyDetails, options: { expanded: boolean }, theme: Theme): Text {
  if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
  const lines = [theme.fg("success", `${details.count} items found`)];
  if (options.expanded) lines.push(...details.items.map((i) => `  • ${i}`));
  return new Text(lines.join("\n"), 0, 0);
}
```

---

## 5. Command 注册 **[规范]**

```typescript
pi.registerCommand({
  name: "mycommand",
  description: "描述",
  parameters: Type.Optional(Type.Object({ ... })),
  execute: async (params, ctx) => {
    return { content: [{ type: "text", text: "Done" }] };
  },
  renderResult: (details, options, theme) => new Text("...", 0, 0),
});
```

**[规范]** Command 用于用户手动触发的操作。Tool 用于模型调用的操作。两者不互为替代——Tool 有 promptSnippet 提示模型何时调用，Command 没有此机制。

---

## 6. 事件生命周期管理 **[规范]**

### 6.1 可用事件

| 事件 | 典型用途 | 注意事项 |
|------|---------|---------|
| `session_start` | 恢复状态、加载配置、注册 widget | 最常用 |
| `session_tree` | 分支导航后重建状态 | 清理旧分支 pending 数据 |
| `before_agent_start` | 注入自定义 system prompt | 返回 `{ systemPrompt }` |
| `turn_end` | 捕获数据做批处理 | 慢操作使用缓存/批处理 |
| `message_end` | 序列化、清理 | — |
| `tool_execution_end` | 监听特定 Tool 的结果 | 检查 `event.toolName` |
| `context` | 修改/过滤消息 | 返回 `{ messages }` 或 `undefined` |
| `agent_end` | 最后清理 | **不做异步 LLM 调用** |
| `session_shutdown` | 释放资源 | 同步操作为主 |

### 6.2 事件处理器设计规范

**[规范]** 每个事件处理器不超过 20 行，复杂逻辑提取为命名函数。

**[规范]** `agent_end` 中**禁止**启动新的 LLM 调用，只做同步清理（Pi 可能已开始销毁上下文）。

**[规范]** `session_tree` 中必须丢弃旧分支的 pending 状态：

```typescript
pi.on("session_tree", async (_event, ctx) => {
  indexer.reconstructFromSession(ctx);
  pendingBatches.length = 0; // 丢弃旧分支数据
});
```

---

## 7. 状态与会话管理 **[规范]**

### 7.1 内存状态

**[规范]** 状态始终在工厂闭包内，通过事件处理器初始化和清理。

### 7.2 持久化模式

使用 Pi Entry 机制实现持久化：

```typescript
// 写入
pi.appendEntry("my-type", { key: "value" });

// 读取（在 session_start 中）
const entries = ctx.sessionManager.getEntries()
  .filter((e): e is CustomEntry<MyData> =>
    e.type === "custom" && e.customType === "my-type"
  );
```

### 7.3 反序列化向后兼容 **[规范]**

> 原因：扩展升级后，旧的 Entry 格式仍存在 Session 中，不兼容的反序列化会导致扩展启动崩溃。

```typescript
function deserializeState(raw: unknown): MyState {
  if (!raw || typeof raw !== "object") return createInitialState();

  const obj = raw as Record<string, unknown>;
  return {
    // 每个字段都提供默认值
    initialized: typeof obj.initialized === "boolean" ? obj.initialized : false,
    items: Array.isArray(obj.items)
      ? obj.items.filter((i): i is string => typeof i === "string")
      : [],
    // 新版本加的字段，旧格式不存在时给默认
    version: typeof obj.version === "number" ? obj.version : 1,
  };
}
```

### 7.4 Entry GC

**[指南]** 长会话中 Entry 不断积累，建议设上限并定期 GC：

```typescript
const MAX_ENTRIES = 1000;
if (entries.length >= MAX_ENTRIES) {
  entries.splice(0, Math.floor(MAX_ENTRIES * 0.2)); // 删除最旧 20%
}
```

---

## 8. 配置管理 **[规范]**

### 8.1 配置路径

```
~/.pi/agent/extensions/<extension-name>/config.json
```

**[规范]** 配置路径使用 `~/.pi/agent/extensions/` 子目录，不与 Pi 本身的配置文件混杂。

### 8.2 加载模式

```typescript
import { existsSync, readFileSync } from "node:fs";
import { join, homedir } from "node:path";

export function loadConfig<T extends Record<string, unknown>>(
  defaults: T,
  name: string,  // 扩展名
): T {
  const path = join(homedir(), ".pi", "agent", "extensions", name, "config.json");
  if (!existsSync(path)) return { ...defaults };

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load config for ${name}: ${message}`);
  }
}
```

**[规范]** 配置加载失败必须抛有意义的错误（包含路径和原因），不能静默使用默认值。

---

## 9. 依赖管理 **[规范]**

### 9.1 扩展能否 import 其他 npm 包

> 是的，可以。澄清一个常见误解。

Pi 的 extension loader 使用 [jiti](https://github.com/unjs/jiti) 加载 TypeScript 扩展。jiti 配置了一个 **alias 列表**（或 Bun binary 模式下的 **virtualModules**），但这个 alias 列表的用途是**将 Pi SDK 包重定向到捆绑版本**，而非限制你能 import 什么。

加载流程：

```
扩展源文件 import X
  ├── X 命中了 alias 列表？→ 重定向到 Pi 捆绑的版本（@mariozechner/*、@earendil-works/*、typebox）
  └── X 未命中 alias？→ jiti 走标准 Node.js 模块解析（node_modules 查找）
```

#### Bun binary 模式与 Node.js 模式的差异

| 模式 | 机制 | 对非 SDK 包 import 的支持 |
|------|------|--------------------------|
| **Node.js 模式**（当前 xyz-pi） | `alias` | ✅ 标准 node_modules 查找，能找到依赖就能 import |
| **Bun binary 模式**（上游 pi-mono 的编译产物） | `virtualModules` + `tryNative: false` | ⚠️ 仅 virtualModules 中的包可被解析，其他 import 会失败 |

当前 xyz-pi 以 Node.js 脚本运行（`cli.js` 首行为 `#!/usr/bin/env node`），因此扩展的 import 走标准 node_modules 解析。

**[规范]** 如果扩展依赖第三方 npm 包，必须在其 `package.json` 的 `dependencies` 中声明。安装扩展后这些包会被下载到 node_modules，jiti 就能找到。

**[规范]** 禁止依赖 xyz-pi 自身的 node_modules 中碰巧存在的包（如 `diff`）。这不是 API 契约——不同版本的 xyz-pi 可能增减内部依赖。

### 9.2 依赖类型决策

| 依赖类型 | 适用场景 | 示例 |
|---------|---------|------|
| `peerDependencies` | Pi SDK 包，运行时提供 | `@mariozechner/pi-coding-agent` |
| `peerDependenciesMeta.optional` | 条件依赖 | `@earendil-works/pi-tui`（纯 headless） |
| `dependencies` | 业务逻辑依赖 | `zod`、`diff`、`openai` |
| `devDependencies` | 测试/类型 | `vitest`、`@types/node`、`typescript` |

### 9.3 版本范围

| 场景 | 写法 |
|------|------|
| 兼容任何版本 | `"*"` |
| 兼容大版本内 | `"^0.74.0"` |
| 有最低版本 | `">=0.74.0"` |
| 不支持未来主版本 | `">=0.74.0 <1.0.0"` |

**[指南]** Pi SDK 包建议用 `"*"` 或 `">=0.74.0"`，避免因版本范围过窄导致安装失败。

---

# 第二部分：通用的高质量工程规范

## 10. 错误处理与弹性模式 **[规范]**

### 10.1 Stale Context 检测

> 这是 Pi 扩展开发中最常见的崩溃源。Session 关闭后 ctx 过期，访问它会抛异常。

**[规范]** 所有可能跨越 session 生命周期（特别是异步 await 前后）的 ctx 操作必须加 stale context 保护：

```typescript
function isStaleContextError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes("Extension context no longer active");
}

function safeNotify(ctx: any, message: string, type: "info" | "warning" | "error" = "info"): void {
  try {
    ctx.ui.notify(message, type);
  } catch (err) {
    if (!isStaleContextError(err)) throw err;
    // Session 已结束，静默忽略
  }
}
```

### 10.2 异步操作的完整安全模式

```typescript
async function flushPending(ctx: any): Promise<void> {
  if (isFlushing) return; // 防重入
  isFlushing = true;

  try {
    const results = await asyncOperation({ signal: abortController.signal });
    // 写入前检查 ctx 是否还活着
    persistResults(results, ctx);
  } catch (err) {
    if (isStaleContextError(err)) {
      pendingBatch = results; // 恢复数据待重试
      return;
    }
    if ((err as Error)?.name === "AbortError") return; // 取消不处理
    throw err; // 无法恢复的异常
  } finally {
    isFlushing = false;
  }
}
```

### 10.3 防重入

**[规范]** 可能被并发触发的异步操作必须有防重入保护：

```typescript
let isProcessing = false;

async function handleTurnEnd(ctx: any) {
  if (isProcessing) return;
  isProcessing = true;
  try {
    await processBatch(ctx);
  } finally {
    isProcessing = false;
  }
}
```

### 10.4 函数内所有可能的控制流路径必须有显式的 return

> 声明了返回类型的函数，遗漏 return 分支会导致 TS2366。

**[规范]**

```typescript
function process(items: string[]): string[] {
  if (items.length === 0) return []; // ✅ 必须有
  // ...
}
```

---

## 11. 类型安全 **[规范]**

### 11.1 禁止 any

所有 `any` 必须替换为具体类型或 `unknown`。这是品味检查的 P0 违规。

### 11.2 Record<string, unknown> 白名单管理

**[规范]** 除以下白名单场景外，禁止使用 `Record<string, unknown>`：

| 允许场景 | 说明 |
|---------|------|
| 外部接口签名约束 | 如 `FormatConverter.transformRequest(body: Record<string, unknown>)` |
| 输出对象构造 | `const result: Record<string, unknown> = {}`（在退出边界前断言为具体类型） |
| SSE payload 解析 | `JSON.parse(event.data)` 后 |
| Patch 层 | 处理上游响应结构多变的 patch 函数 |
| 错误格式转换 | 错误响应结构不确定 |

不在白名单的 `Record<string, unknown>` 必须改为结构化类型。入口处用 `as unknown as ConcreteType` 断言。

### 11.3 跨文件类型定义

**[规范]** 禁止多文件重复定义同名 interface。共享类型提取到 `types.ts`。

---

## 12. 路径与配置硬编码 **[规范]**

> 来源：多个 Pi 扩展使用硬编码路径导致在不同环境中不可移植。

### 12.1 禁止硬编码路径

**[规范]** 所有文件系统路径**禁止**硬编码字符串。必须使用 `path.join()` + 基准路径（`homedir()` / `import.meta.url`）构建。

```typescript
// ✅ 正确
import { join } from "node:path";
import { homedir } from "node:os";

const configPath = join(homedir(), ".pi", "agent", "config.json");

// ❌ 错误
const configPath = "/Users/zhushanwen/.pi/agent/config.json";
```

**[规范]** 扩展内引用的路径优先基于 `import.meta.url` 或 `homedir()` 构造：

```typescript
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 相对于扩展自身目录的路径
const extensionDir = dirname(fileURLToPath(import.meta.url));
const skillDir = join(extensionDir, "skills");

// 相对于用户 home 的路径
const userConfigDir = join(homedir(), ".pi", "agent", "extensions", "my-extension");
```

### 12.2 路径处理工具函数

```typescript
// utils.ts
import { homedir } from "node:os";
import { join } from "node:path";

export function expandTilde(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}
```

### 12.3 白名单：允许的硬编码场景

- `"node_modules"` / `".pi"` 等标准目录名（概念名，不是绝对路径）
- 配置文件中的默认路径（用户可覆盖）

---

## 13. 健壮性基础要求 **[规范]**

### 13.1 防崩溃

| 要求 | 说明 |
|------|------|
| 不允许未捕获异常 | 所有 Tool execute 返回 `{ isError: true }` |
| 不允许模块加载时报错 | 配置加载失败在 session_start 中处理，不在模块顶层 |
| 不允许 process.exit | 扩展无权结束进程 |
| 不允许无限循环 | while(true) 必须有迭代上限 |

### 13.2 资源清理

| 场景 | 要求 |
|------|------|
| 异步操作 | 必须支持 `signal` 取消，finally 块清理 |
| 文件句柄 | 用完关闭 |
| 定时器 | 在 session_shutdown 中清除 |
| AbortController | 组件卸载/操作完成时调用 `.abort()` |

---

# 第三部分：开发指南

## 14. TUI 渲染 **[指南]**

### 14.1 颜色使用

使用语义 token 着色，不硬编码 ANSI：

```typescript
// ✅ 正确
theme.fg("accent", "Title")
theme.fg("success", "Done")
theme.fg("error", "Failed")
theme.fg("warning", "Caution")
theme.fg("muted", "Description")
theme.fg("dim", "Hint text")

// ❌ 错误
"\x1b[32mTitle\x1b[0m"
```

### 14.2 渲染缓存

频繁重新渲染的组件可缓存结果，数据变化时 `invalidate()`：

```typescript
class MyComponent implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    this.cachedLines = computeLines(width);
    this.cachedWidth = width;
    return this.cachedLines;
  }
}
```

### 14.3 Markdown 渲染安全降级

`getMarkdownTheme()` 在不同 Pi 版本中行为不同，渲染异常应降级：

```typescript
export function safeMarkdownTheme(): MarkdownTheme | undefined {
  try {
    const md = getMarkdownTheme();
    if (!md) return undefined;
    md.bold(""); // 触发 Proxy 检查
    return md;
  } catch {
    return undefined;
  }
}
```

### 14.4 Widget 注册

持久化状态显示推荐使用 `registerWidget`：

```typescript
ctx.ui.registerWidget(WIDGET_KEY, (theme: Theme) => {
  return new Text(`my-ext: ${status}`, 0, 0);
});
```

---

## 15. 模块组织 **[指南]**

### 15.1 简单扩展（1-3 个 Tool）

```
pi-my-extension/
├── index.ts
├── package.json
├── README.md
└── test/
```

### 15.2 中等规模扩展

```
pi-my-extension/
├── index.ts          # re-export
├── package.json
├── src/
│   ├── index.ts      # 工厂
│   ├── state.ts      # 状态
│   ├── types.ts      # 类型
│   ├── config.ts     # 配置
│   └── commands.ts   # 命令
└── test/
```

### 15.3 复杂扩展

领域驱动结构，如：

```
src/
├── extension/   — 入口、tools、commands
├── shared/      — 公用类型、工具、常量
├── runs/        — 领域逻辑（foreground/background）
├── tui/         — TUI 渲染组件
└── slash/       — /command 实现
```

---

## 16. 性能 **[指南]**

| 场景 | 建议做法 |
|------|---------|
| 并行独立 IO | `Promise.allSettled` 而非 `Promise.all` |
| 批量处理 | 攒一批处理一次，不要逐条处理 |
| 组件初始化 | 延迟初始化（lazy init），用 `ensureXxx()` 模式 |
| TUI 渲染 | 缓存 render 结果，invalidate 触发重算 |
| Entry 增长 | 设上限定期 GC |

---

## 17. 测试 **[指南]**

### 17.1 测试框架选择

| 场景 | 推荐 |
|------|------|
| 单元测试 | `vitest` |
| 快速验证 | `node --test` |
| 集成测试 | `vitest` |

### 17.2 测试覆盖重点

- 配置加载成功/失败路径
- 状态反序列化旧格式兼容性
- Tool execute 的 success/error 路径
- 信号取消行为
- 防重入逻辑
- 空状态处理

```typescript
describe("state", () => {
  it("handles null input", () => {
    expect(deserializeState(null)).toEqual(createInitialState());
  });

  it("handles partial data (backward compat)", () => {
    const state = deserializeState({ initialized: true });
    expect(state.items).toEqual([]);
  });
});
```

---

# 第四部分：附录

## 18. 反模式清单

### 18.1 崩溃风险（P0）

| 反模式 | 问题 | 正确做法 |
|--------|------|---------|
| 模块级全局变量 | 多 session 共享状态，数据错乱 | 工厂闭包变量 |
| 未保护的 ctx 访问 | session 关闭后崩溃 | `isStaleContextError()` 检查 |
| Tool execute 抛异常 | 未处理异常带崩 Pi | 返回 `{ isError: true }` |
| 异步操作无信号 | 无法取消，残留资源 | 透传 `signal` |
| 不设防重入 | 并发操作破坏状态 | `isProcessing` 标志 |
| agent_end 中启动 LLM 调用 | 上下文已过期 | 只做同步清理 |

### 18.2 结构问题（P1）

| 反模式 | 问题 | 正确做法 |
|--------|------|---------|
| 单文件 > 500 行 | 认知负担高 | 按职责拆分 |
| 类型定义散落 | 维护困难 | 集中到 `types.ts` |
| details 与 content 不匹配 | renderResult 解析文本 | details 是唯一数据源 |
| 硬编码路径 | 不可移植 | `path.join(homedir(), ...)` |

### 18.3 类型问题（P1）

| 反模式 | 问题 | 正确做法 |
|--------|------|---------|
| 未约束的 `any` | 类型链断裂 | 精确类型或 `unknown` |
| `Record<string,unknown>` 无校验 | 字段名拼错不报错 | 白名单 + 入口断言 |
| 跨文件重复 interface | 改一处漏一处 | 统一 `types.ts` |
| 必填字段实际不存在 | 运行时 undefined | 如实标注 `?` |

### 18.4 依赖问题（P1）

| 反模式 | 问题 | 正确做法 |
|--------|------|---------|
| Pi SDK 放 dependencies | 多版本冲突 | peerDependencies |
| 不必要的强制依赖 | 安装体积大 | peerDependenciesMeta.optional |
| files 不含入口 .ts | publish 后丢失 | 包含 `index.ts` |

### 18.5 TUI 问题（P2）

| 反模式 | 问题 | 正确做法 |
|--------|------|---------|
| 硬编码 ANSI 颜色 | 不随主题变化 | `theme.fg("token", text)` |
| Markdown 主题无 fallback | 异常时崩溃 | `safeMarkdownTheme()` |
| 每帧重建组件 | 性能浪费 | 缓存 + invalidate |
| 无 renderResult | 模型看到 raw JSON | 写渲染函数 |

---

## 19. 新扩展检查清单

### 启动阶段（阻塞性问题）

- [ ] `package.json` 含 `type: "module"` 和 `pi.extensions`
- [ ] `package.json` 不含 `private: true`（除非确定不发布到 npm）
- [ ] `peerDependencies` 引用 `@mariozechner/pi-coding-agent`
- [ ] `files` 包含入口 `.ts`，含 `index.ts` + `src/**/*.ts`
- [ ] 入口 `export default function(pi: ExtensionAPI)`
- [ ] 状态在工厂闭包内，非模块级

### 健壮性阶段（必须通过）

- [ ] 所有 execute 返回 `{ isError: true }` 而非抛异常
- [ ] 异步操作支持 `signal` 取消
- [ ] Stale context 检测 + `safeNotify` 保护
- [ ] 防重入标志保护并发操作
- [ ] finally 块确保资源释放
- [ ] 配置加载失败抛有意义错误
- [ ] 反序列化向后兼容旧 Entry 格式
- [ ] 无模块级 global let 变量

### 类型阶段（必须通过）

- [ ] 无 `any`（精确类型或 `unknown`）
- [ ] `Record<string, unknown>` 在白名单中或已消除
- [ ] 跨文件类型集中 `types.ts`
- [ ] 先读后写模式（edit 前 read 确认）

### 代码风格阶段（推荐）

- [ ] 单文件 ≤ 500 行
- [ ] 函数 ≤ 80 行
- [ ] 事件处理器 ≤ 20 行
- [ ] 无硬编码路径（`homedir()` + `path.join()`）
- [ ] 语义 token 着色（无 ANSI 硬编码）

### 文档阶段（推荐）

- [ ] TUI 有 renderResult
- [ ] Tool/Command 有 description
- [ ] README.md 含安装和用法
