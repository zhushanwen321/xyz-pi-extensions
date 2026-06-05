# Extension 审查报告: context-engineering

> 审查日期: 2026-06-05
> 审查依据: `docs/pi-extension-standards.md`
> 包版本: 0.1.2

## 基本信息

- **包名**: `@zhushanwen/pi-context-engineering`
- **入口**: `./index.ts` → `./src/index.ts`
- **源文件数**: 6 (src/ 目录下, 排除 `__tests__`)
- **总行数**: 1336 行 (含 `index.ts` 入口)
  - `index.ts` (根): 1 行
  - `src/index.ts`: 106 行
  - `src/compressor.ts`: **798 行** (单文件超大)
  - `src/config.ts`: 175 行
  - `src/commands.ts`: 157 行
  - `src/recall-store.ts`: 63 行
  - `src/frozen-fresh.ts`: 36 行
- **测试文件**: 3 个 (`compressor.test.ts`, `frozen-fresh.test.ts`, `integration.test.ts`)

## 审查结果概览

| 规范项 | 状态 | 严重程度 | 说明 |
|--------|------|---------|------|
| 1. 包结构与命名 | ⚠️ 部分合规 | P1 | 包名/type/files/pi.extensions/keywords 合规; `peerDependencies` 声明了 `@sinclair/typebox` 但代码 import 的是 `typebox` (不同包) |
| 2. 入口与工厂模式 | ✅ 合规 | — | 根 `index.ts` re-export, `src/index.ts` 使用 `export default function(pi)` 工厂; 闭包内状态; 无模块级 `let` |
| 3. Tool 注册与设计 | ⚠️ 部分合规 | P2 | `recall_context` 返回 `{ content, details }` 结构合规; 缺 `renderCall`/`renderResult`; `execute` 类型签名使用 5 元参数形式 (旧风格) |
| 4. 事件生命周期管理 | ⚠️ 部分合规 | P2 | `context` 事件处理器合规; `session_start` 重置状态合规; 缺 `session_tree` 处理器 (虽然当前无 pending 状态) |
| 5. 状态与会话管理 | ✅ 合规 | — | 状态完全在工厂闭包内; `session_start` 重置; 无 Entry 持久化 (无需反序列化) |
| 6. 错误处理与弹性 | ⚠️ 部分合规 | P1 | `processContext` 错误降级到原 messages; `processBudget` 有 replacement-size 防护; **缺 `isStaleContextError` 保护**; 缺 `isProcessing` 防重入 |
| 7. 类型安全 | ⚠️ 部分合规 | P1 | 无 `any` (✅); 存在大量跨文件类型本应集中在 `types.ts` 但目前没有此文件; `ToolCall.arguments` 用 `Record<string,unknown>` 属白名单场景 |
| 8. 路径与配置 | ⚠️ 部分合规 | P1 | 使用 `path.join` + `homedir()` (✅); 但**配置路径用 `~/.pi/agent/settings.json` 而非规范的 `~/.pi/agent/extensions/<name>/config.json`** |
| 9. 依赖管理 | ⚠️ 部分合规 | P1 | `peerDependencies` 中 `@sinclair/typebox` 与代码 import 的 `typebox` 不一致; Pi SDK 都用 peerDep (✅); `@mariozechner/pi-coding-agent` 未标 optional (✅) |
| 10. 健壮性 | ✅ 合规 | — | 无 `process.exit`; 无未捕获异常; `processBudget` 循环有上限; 同步操作无 signal 需求 (合规) |
| 11. 代码风格 | ⚠️ 部分合规 | P2 | **`compressor.ts` 798 行严重超标** (规范 ≤ 500); `processL0` 88 行超 80 行函数上限; 事件处理器 ≤ 20 行 (✅) |
| 12. Monorepo 约定 | ⚠️ 部分合规 | P1 | `index.ts` re-export (✅); import 顺序基本合规; **单文件 ≤ 1000 行 (P0)**: `compressor.ts` 798 行, 接近 P0 上限; **无 `types.ts` 文件** |

### 严重程度汇总
- **P0**: 0 项
- **P1**: 6 项
- **P2**: 5 项

---

## 详细问题清单

### P0 问题

**无 P0 崩溃风险问题。**

扩展整体防御性编程到位:
- `pi.on("context", ...)` 包裹 try/catch 降级到原 messages
- 同步执行链 (`processL0/L1/L2/MC/Budget`) 内部不抛异常
- `processBudget` 循环有 replacement size guard
- `recall_context` 工具无 I/O, 不存在异步异常

### P1 问题

#### P1-1. `compressor.ts` 文件严重超标 (798 行)
- **文件**: `src/compressor.ts` (798 行)
- **规范**: 11. 代码风格 → 单文件 ≤ 500 行
- **问题**: 该文件 798 行, 超出 500 行上限 60%, 接近 Monorepo 约定的 1000 行 P0 红线
- **建议拆分**:
  - `compressor/l0.ts` — `processL0`, `expireToolResult`, `truncateBashOutput`, `expireThinking`
  - `compressor/l1.ts` — `processL1`, `condenseToolResult`, `fallbackTruncate`, `IMPORT_EXPORT_RE`, `DEFINITION_RE`
  - `compressor/l2.ts` — `processL2`
  - `compressor/mc.ts` — `processMicrocompact`, `COMPACTABLE_TOOLS`
  - `compressor/budget.ts` — `processBudget`
  - `compressor/validation.ts` — `validateToolPairing`, `findCompactBoundary`, `findTurnBoundaries`, `isInProtectedTurn`
  - `compressor/index.ts` — 重新导出 + `compressContext` 主入口

#### P1-2. 缺少 `types.ts`, 跨文件类型散落
- **文件**: `src/compressor.ts` (第 16-103 行), 还在 `src/index.ts` 用 `as unknown as CompressorMessage` 二次引用
- **规范**: 3.2 types.ts 规范 + 11.3 跨文件类型定义
- **问题**: `TextContent`, `ThinkingContent`, `ImageContent`, `ToolCall`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`, `BashExecutionMessage`, `CompactionSummaryMessage`, `AgentMessage`, `ContextUsage`, `TurnBoundary`, `L0Stats`, `CompressionStats`, `McStats`, `BudgetStats` 等 15+ 个类型全部内联在 `compressor.ts`
- **危害**: `src/index.ts` 行 14-18 通过 `import type { AgentMessage as CompressorMessage, ContextUsage as CompressorContextUsage } from "./compressor"` 借类型, 这意味着类型的所有权和实现耦合, 类型改动会污染消费者
- **建议**: 抽离到 `src/types.ts`, `compressor.ts` 仅引用

#### P1-3. `peerDependencies` 声明与代码 import 不一致
- **文件**: `package.json` 行 23-26, `src/index.ts` 行 5
- **代码片段**:
  ```jsonc
  // package.json
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@sinclair/typebox": "*"
  }
  ```
  ```typescript
  // src/index.ts
  import { Type } from "typebox";
  ```
- **问题**: 声明的是 `@sinclair/typebox`, 但代码 import 的是 `typebox`. 这是两个不同 npm 包 (`typebox` v1.x vs `@sinclair/typebox` v0.x), 来自同一作者不同仓库. 当前能运行是因为 `@mariozechner/pi-coding-agent` 在其依赖里带了 `typebox@^1.1.24`, jiti 走 node_modules 解析能命中, 但作为扩展的 peer dep 契约应与 import 字符串一致
- **建议**: 二选一
  1. 改 import 为 `from "@sinclair/typebox"`, 保持 peerDeps
  2. 改 peerDeps 为 `"typebox": "*"`, 保持 import (与本仓库其他 pi-coding-agent 依赖的 `typebox` 对齐)

#### P1-4. `loadConfig` 读取/解析失败时静默回退默认
- **文件**: `src/config.ts` 行 109-127
- **代码片段**:
  ```typescript
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return { ...DEFAULT_CONFIG };  // 不抛错
  }
  
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ...DEFAULT_CONFIG };  // 不抛错
  }
  ```
- **规范**: 8.2 加载模式 — "配置加载失败必须抛有意义的错误（包含路径和原因），不能静默使用默认值"
- **问题**: 文件不存在可视为正常 (走默认), 但 JSON 解析失败是用户配置错误, 应抛出含路径的错误以便用户发现
- **建议**:
  ```typescript
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw new Error(`Failed to read config ${filePath}: ${(err as Error).message}`);
  }
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}: ${(err as Error).message}`);
  }
  ```

#### P1-5. 配置路径未走扩展专属目录
- **文件**: `src/config.ts` 行 103-105
- **代码片段**:
  ```typescript
  const filePath =
    settingsPath ?? join(homedir(), ".pi", "agent", "settings.json");
  ```
- **规范**: 8.1 配置路径 — "配置路径使用 `~/.pi/agent/extensions/<extension-name>/config.json` 子目录"
- **问题**: 直接读取 Pi 全局 `settings.json`, 与 Pi 核心配置混在一起, 不利于隔离与卸载
- **建议**: `join(homedir(), ".pi", "agent", "extensions", "context-engineering", "config.json")`

#### P1-6. `handleContextEngineeringCommand` switch 后缺 return
- **文件**: `src/commands.ts` 行 132-152
- **代码片段**:
  ```typescript
  switch (target) {
    case "global": ... return ...;
    case "mc": ... return ...;
    case "budget": ... return ...;
    case "l0": ... return ...;
    case "l1": ... return ...;
    case "l2": ... return ...;
  }
  // <-- 无 return 语句结尾
  ```
- **规范**: 10.4 函数内所有可能的控制流路径必须有显式的 return
- **问题**: 函数声明返回 `string`, 但 switch 之后无 return. TypeScript 推断 target 收窄为 `never` 后能通过编译, 但一旦未来有人修改 `parseLevelArgs` 的返回类型或在 switch 中漏掉一个 case, 此函数会隐式返回 `undefined`, 运行时 `.ui.notify(undefined, "info")` 会异常
- **建议**: 在 switch 后追加 `return USAGE_HELP;` 或 `throw new Error("unreachable")`

### P2 问题

#### P2-1. `processL0` 函数 88 行, 超 80 行函数上限
- **文件**: `src/compressor.ts` 行 357-444 (88 行)
- **规范**: 11. 代码风格 → 函数 ≤ 80 行
- **建议**: 抽离 `keepRecentProtected` 预计算为 `buildKeepRecentIndex(messages, keepRecent): Set<number>`

#### P2-2. `recall_context` Tool 缺 `renderCall`/`renderResult`
- **文件**: `src/index.ts` 行 86-93
- **代码片段**:
  ```typescript
  pi.registerTool({
    name: "recall_context",
    label: "Recall Compressed Context",
    description: "...",
    promptSnippet: "...",
    parameters: RecallParams,
    execute: async (...) => recallResult(params.id, store),
  });
  ```
- **规范**: 4.1 注册格式, 4.3 details 与 renderResult 契约
- **问题**: 没有 `renderCall`/`renderResult`, recall 的 `details: { found, id, level }` 没有渲染消费者
- **建议**: 增加 `renderResult: (details, options, theme) => new Text(theme.fg(details.found ? "success" : "warning", ...), 0, 0)`. 若当前 Pi 版本 API 不支持, 应在 README 说明

#### P2-3. 两条 Command 缺 `renderResult`
- **文件**: `src/index.ts` 行 95-108
- **问题**: `context-engineering` 和 `context-stats` 命令都走 `ctx.ui.notify(text, "info")`, 是 notification 模式而不是 TUI 渲染模式. 长内容在 TUI 通知区显示效果差
- **建议**: 若 Pi 版本支持 `renderResult` 参数, 应改用 `pi.registerCommand({ name, description, parameters, execute, renderResult })`; 若不支持, 至少把内容做截断, 避免超过 10 行的 TUI 通知

#### P2-4. Command 注册风格不匹配新 API
- **文件**: `src/index.ts` 行 95-108
- **代码片段**:
  ```typescript
  pi.registerCommand("context-engineering", {
    description: "...",
    handler: async (_args: string, ctx: ExtensionCommandContext) => { ... },
  });
  ```
- **规范**: 5. Command 注册 — 用 `execute: async (params, ctx) => { ... }` 与 `parameters: Type.Optional(Type.Object({...}))`
- **问题**: 使用 `handler: async (args, ctx)` 老式签名, 没有声明 `parameters`. Pi 0.74+ 的 API 已切换到 `execute` 风格
- **建议**: 改为
  ```typescript
  pi.registerCommand({
    name: "context-engineering",
    description: "...",
    parameters: Type.Optional(Type.Object({})),
    execute: async (_params, ctx) => { ... },
  });
  ```

#### P2-5. 缺 `session_tree` 事件处理器
- **文件**: `src/index.ts` (整个文件)
- **规范**: 6.2 事件生命周期管理 — `session_tree` 中必须丢弃旧分支的 pending 状态
- **问题**: 当前扩展无 pending 队列, 但 `pi.on("session_tree", ...)` 仍是建议的标配, 以便未来添加异步操作时有清理点
- **建议**: 至少注册空 handler
  ```typescript
  pi.on("session_tree", () => {
    // 当前无 pending 状态, 但保留 hook 供未来扩展
  });
  ```

---

## 优点

1. **状态封装正确**: `config` / `store` / `cumulativeStats` / `frozenFreshState` 全部在工厂闭包内 (`src/index.ts` 行 41-46), `session_start` 中重置, 完全无模块级 `let`, 完美符合 §2.3 闭包状态隔离
2. **错误降级而非抛错**: `pi.on("context", ...)` 在 catch 中 `return {}` 静默回退到原 messages, 不破坏 Pi 流转
3. **类型安全**: 无 `any`, `Record<string, unknown>` 仅在 `ToolCall.arguments` 等白名单场景出现
4. **LRU 淘汰**: `recall-store.ts` `MAX_ENTRIES = 500` + LRU 实现, 防止单 session 内存膨胀
5. **测试覆盖**: 3 个测试文件覆盖 `compressor` (33KB), `frozen-fresh` 和 `integration`
6. **Idempotent 处理**: `isAlreadyProcessed` 检测 `["[Tool result expired", "[Old tool result", "[Condensed", "[Persisted output"]` 前缀, 防止重复处理
7. **Budget 防过度持久化**: `processBudget` 中的 `if (replacement.length >= maxEntry.chars) break` 保护小文本不被无限循环
8. **Tool Pairing 校验**: 压缩后 `validateToolPairing` 失败则丢弃整个修改, 保证不破坏 LLM 工具调用链
9. **配置深合并**: `deepMerge` 工具支持嵌套对象覆盖, 用户可只覆盖 `l0.expireMinutes` 等单字段
10. **域内模块化**: 将 `frozen-fresh` / `recall-store` / `config` 拆为独立工厂, 单元测试友好

## 改进建议

### 高优先级 (P1) — 本周内修

1. **拆分 `compressor.ts`**: 798 行 → 6 个子文件, 每个 < 200 行
2. **建立 `src/types.ts`**: 集中所有 `AgentMessage` / `CompressionStats` / 等共享类型
3. **统一 `typebox` 包名**: `package.json` peerDeps 与 import 字符串保持一致
4. **`loadConfig` JSON 解析失败抛错**: 区分 ENOENT (走默认) 和 SyntaxError (抛错)
5. **配置路径改用扩展目录**: `~/.pi/agent/extensions/context-engineering/config.json`
6. **`handleContextEngineeringCommand` 加尾部 return**: 防御性兜底

### 中优先级 (P2) — 下一迭代

1. `processL0` 抽 `buildKeepRecentIndex` 子函数
2. 给 `recall_context` 添加 `renderResult` (或 README 注明不支持原因)
3. 改 Command 注册为 `execute` + `parameters` 新风格
4. 注册 `session_tree` 空 handler 作为预留 hook

### 建议 (Bonus)

- 考虑用 `ctx.appendEntry` + Entry 持久化 `cumulativeStats`, 跨 session 保留统计
- `recall-store` 增加 disk spillover 选项, 避免超大 L1 压缩后内存爆
- `compressContext` 的零 stats 字面量 (行 478-488) 抽为 `createZeroStats()` 工厂, 与 `src/index.ts` 的 `zeroStats()` 合并, 消除重复

---

## 整体评级

**B+ (生产可用, 建议改进)**

- ✅ 核心逻辑 (L0/L1/L2/MC/Budget) 设计严谨, 错误降级到位, 测试覆盖完整
- ✅ 状态封装 / 工厂模式 / 类型安全 / 依赖隔离均合规
- ⚠️ 结构性偏差: 单文件超大、类型散落、配置路径不符合规范
- ⚠️ `typebox` 依赖声明需澄清

无 P0 崩溃风险, 可安全发布 0.1.2 正式版, 但建议在下个 minor 版本 (0.2.0) 完成 P1 修复后再次审计.
