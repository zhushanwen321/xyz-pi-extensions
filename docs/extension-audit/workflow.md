# Extension 审查报告: workflow

## 基本信息

| 项目 | 值 |
|------|------|
| 包名 | `@zhushanwen/pi-workflow` |
| 版本 | 0.1.5 |
| 入口文件 | `index.ts` → `src/index.ts` |
| 源文件数 | 12 (`src/`) + 1 (`index.ts`) = 13 |
| 测试文件数 | 8 (`tests/`) |
| Mock 文件数 | 3 (`mocks/`) |
| Skill 文件数 | 1 (`skills/`) |
| 总源码行数 | 4,099 (src/) + 2 (index.ts) |
| 依赖 | `@zhushanwen/pi-model-switch` (workspace) |
| peerDependencies | `@mariozechner/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, `@sinclair/typebox` |

## 审查结果概览

| 规范项 | 状态 | 严重程度 | 说明 |
|--------|------|----------|------|
| 1. 包结构与命名 | ⚠️ 部分合规 | P1 | npm scope 非 `@scope` 格式；`pi.extensions` 键名使用 `pi` 而非文档描述的 `pi.extensions` 顶级键；`@mariozechner/pi-tui` 未在 peerDependencies 声明但代码中 import |
| 2. 入口与工厂模式 | ✅ 合规 | — | `export default function(pi: ExtensionAPI)` 正确；工厂函数超过 100 行但已委托到子模块 |
| 3. Tool 注册与设计 | ⚠️ 部分合规 | P1 | execute 返回格式正确；错误返回 `isError: true`；但 `_signal` 参数在所有 tool execute 中被忽略，未透传到异步操作 |
| 4. 事件生命周期管理 | ⚠️ 部分合规 | P2 | `session_start` 处理器约 30 行，略超 20 行限制；`session_tree` 未丢弃旧分支的 pending 状态 |
| 5. 状态与会话管理 | ⚠️ 部分合规 | P1 | `commands.ts` 中 `notifiedRunIds` 为模块级可变 Set，不在工厂闭包内；`config-loader.ts` 中 `cache` 为模块级可变 Map |
| 6. 错误处理与弹性 | ⚠️ 部分合规 | P1 | 缺少 `isStaleContextError` 检测；缺少 `isProcessing` 防重入标志；agent-pool.ts 中 `resolveInvocation` 未检测进程存在性 |
| 7. 类型安全 | ✅ 合规 | — | 源码中未使用 `any` 类型；类型集中在各文件内联 |
| 8. 路径与配置 | ✅ 合规 | — | 使用 `path.join()` + `homedir()`，无硬编码路径 |
| 9. 依赖管理 | ⚠️ 不合规 | P1 | `@mariozechner/pi-tui` 在代码中被 import 但未在 `peerDependencies` 中声明；代码 import `@mariozechner/pi-tui` 但 peerDep 写的是 `@earendil-works/pi-tui` |
| 10. 健壮性 | ✅ 基本合规 | P2 | 无 `process.exit`；无无限循环；agent-pool 有超时机制；但异步操作缺少 signal 取消支持 |
| 11. 代码风格 | ⚠️ 部分合规 | P2 | `orchestrator.ts` 787 行超过 500 行单文件限制；`src/index.ts` 648 行超过 500 行限制 |
| 12. Monorepo 约定 | ⚠️ 部分合规 | P0 | `orchestrator.ts` 787 行超过 1000 行上限但未超限；import 顺序在 `src/index.ts` 中 Node 内置在 Pi SDK 之后 |

## 详细问题清单

### P0 问题

> 无致命崩溃风险问题。

### P1 问题

#### P1-1: peerDependencies 与实际 import 包名不一致

- **文件**: `package.json` + `src/index.ts:15`, `src/tool-generate.ts:7`, `src/widget.ts:8`
- **规范**: §1 包结构 — peerDependencies 必须声明所有使用的包；§9 依赖管理
- **问题**: 代码中 `import { Text } from "@mariozechner/pi-tui"`，但 `peerDependencies` 声明的是 `@earendil-works/pi-tui`。同理 `@mariozechner/pi-ai` 在 index.ts 中被 import（`StringEnum`），但 peerDep 只有 `@earendil-works/pi-ai`。运行时若 `@mariozechner/pi-tui` 与 `@earendil-works/pi-tui` 不是同一个包或未互相 alias，将导致模块解析失败。
- **代码片段**:
  ```json
  // package.json
  "peerDependencies": {
    "@earendil-works/pi-tui": "*",
    "@earendil-works/pi-ai": "*"
  }
  ```
  ```typescript
  // src/index.ts:15
  import { Text } from "@mariozechner/pi-tui";  // 未在 peerDependencies 声明
  import { StringEnum } from "@mariozechner/pi-ai";  // 未在 peerDependencies 声明
  ```

#### P1-2: signal 参数在所有 tool execute 中被忽略

- **文件**: `src/index.ts:272`, `src/index.ts:549`, `src/tool-generate.ts:50`
- **规范**: §3 Tool 注册 — 异步操作必须透传 signal 参数；§10 健壮性 — 异步操作必须支持 signal 取消
- **问题**: 三个 tool 的 `execute` 方法都接收了 `_signal: AbortSignal | undefined` 参数但完全忽略。`orchestrator.run()` 会启动 Worker 线程和 AgentPool 子进程，这些长时间运行的异步操作在 signal 触发时无法被取消。
- **代码片段**:
  ```typescript
  // src/index.ts:272
  async execute(_toolCallId: string, params: Static<typeof WorkflowParams>,
    _signal: AbortSignal | undefined,  // ← 被忽略
    _onUpdate: unknown, ctx: ExtensionContext) {
  ```

#### P1-3: 模块级可变状态（`notifiedRunIds`）违反闭包规范

- **文件**: `src/commands.ts:56`
- **规范**: §5 状态与会话管理 — 所有状态变量必须在工厂函数闭包内
- **问题**: `notifiedRunIds` 是一个模块级的 `new Set<string>()`，不在任何工厂函数闭包内。这意味着跨 session 共享，可能导致：① 某个 session 中通知过的 runId 在另一个 session 中被跳过；② 在 Pi 多实例场景下无法隔离。
- **代码片段**:
  ```typescript
  // src/commands.ts:56 — 模块顶层
  const notifiedRunIds = new Set<string>();
  ```

#### P1-4: 模块级可变状态（`cache`）跨 session 共享

- **文件**: `src/config-loader.ts:94`
- **规范**: §5 状态与会话管理
- **问题**: `cache` 是模块级 `Map`，缓存 workflow 元数据。虽然 config-loader 是无状态的（纯数据加载），但在多 session 并发场景下，不同项目目录的 workflow 列表可能互相污染缓存。`invalidateCache()` 会清空所有缓存，影响其他 session。
- **代码片段**:
  ```typescript
  // src/config-loader.ts:94 — 模块顶层
  const cache = new Map<string, CacheEntry>();
  ```

#### P1-5: 缺少 `isStaleContextError` 检测

- **文件**: `src/orchestrator.ts` (全文), `src/index.ts` (全文)
- **规范**: §6 错误处理与弹性 — Stale Context 检测
- **问题**: 无任何 `isStaleContextError` 保护。在 `handleAgentCall` 和 `executeWithRetry` 中，当 LLM 调用因上下文过期失败时，没有专门的检测和恢复逻辑，直接走通用重试路径。

#### P1-6: 缺少 `isProcessing` 防重入标志

- **文件**: `src/index.ts` (workflow tool execute)
- **规范**: §6 错误处理与弹性 — 防重入
- **问题**: workflow tool 的 execute 方法没有 `isProcessing` 标志保护。理论上同一 session 的两个并发 tool 调用可以同时操作同一个 orchestrator，导致状态竞争（如两个 `pause` 同时执行）。`orchestrator.ts` 内部的状态机校验提供了部分保护，但不是完整的防重入方案。

#### P1-7: `session_tree` 未丢弃旧分支 pending 状态

- **文件**: `src/index.ts:216-231`
- **规范**: §4 事件生命周期管理 — `session_tree` 中必须丢弃旧分支的 pending 状态
- **问题**: `session_tree` 事件处理器创建新的 Orchestrator 并重建所有实例，但没有对实例的 pending/running 状态做任何处理。切分支后旧分支的 running 实例会被原样恢复为 running 状态，但没有 Worker 线程在运行。
- **代码片段**:
  ```typescript
  // src/index.ts:216-231
  pi.on("session_tree", async (_event: Record<string, unknown>, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    lastSessionId = sessionId;
    const orch = new WorkflowOrchestrator(pi, ctx);
    orchestrators.set(sessionId, orch);
    const instances = await reconstructState(ctx);
    orch.restoreInstances(instances);
    // ← 没有丢弃 pending/running 状态的实例
  ```

### P2 问题

#### P2-1: `src/index.ts` 648 行超过 500 行单文件指南

- **文件**: `src/index.ts` (648 行)
- **规范**: §11 代码风格 — 单文件 ≤ 500 行
- **说明**: 虽然已将 `workflow-run` tool 提取到 `registerWorkflowRunTool` 函数，但主文件仍超 500 行。工厂函数体约 300 行 + `registerWorkflowRunTool` 约 120 行 + 辅助类型/常量约 200 行。

#### P2-2: `orchestrator.ts` 787 行超过 500 行单文件指南

- **文件**: `src/orchestrator.ts` (787 行)
- **规范**: §11 代码风格 — 单文件 ≤ 500 行
- **说明**: 文件职责较多：生命周期管理、Worker 线程管理、消息路由、预算执行、持久化。可将 Worker 生命周期和消息路由提取到 `worker-manager.ts`。

#### P2-3: `session_start` 事件处理器约 30 行，超过 20 行限制

- **文件**: `src/index.ts:185-214`
- **规范**: §4 事件生命周期管理 — 每个事件处理器不超过 20 行
- **代码片段**:
  ```typescript
  pi.on("session_start", async (_event: Record<string, unknown>, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();  // L186
    lastSessionId = sessionId;
    // ... 重建 approvals、创建 orchestrator、恢复 instances
    // ... 设置 onTraceUpdate、onCompletion 回调
    // ... 设置 widget
  });  // L214 — 约 30 行
  ```

#### P2-4: Import 顺序不符合规范

- **文件**: `src/index.ts:14-21`
- **规范**: §12 Monorepo 约定 — Import 顺序: Node内置 → npm → Pi SDK → 内部包 → 当前包
- **问题**: 当前 import 顺序为 Pi SDK → npm(typebox) → Node内置(fs, path)，不符合规范要求的 Node内置优先。
- **代码片段**:
  ```typescript
  // 当前顺序:
  import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";  // Pi SDK
  import { StringEnum } from "@mariozechner/pi-ai";  // Pi SDK
  import { Text } from "@mariozechner/pi-tui";  // Pi SDK
  import { Type, type Static } from "typebox";  // npm
  import { readFileSync } from "node:fs";  // Node 内置
  import * as fs from "node:fs";  // Node 内置
  import { resolve } from "node:path";  // Node 内置
  ```

#### P2-5: `commands.ts:517-518` 硬编码相对路径

- **文件**: `src/commands.ts:517-518`
- **规范**: §8 路径与配置
- **问题**: `TMP_DIR` 和 `SAVED_DIR` 使用 `resolve(".pi/workflows/.tmp")` 相对路径。虽然是相对于 `cwd()`，但缺少 workspace root 检测（config-loader 有 `findWorkspaceRoot`，commands 没有）。
- **代码片段**:
  ```typescript
  const TMP_DIR = resolve(".pi/workflows/.tmp");
  const SAVED_DIR = resolve(".pi/workflows");
  ```

#### P2-6: `agent-pool.ts` 中 `resolveInvocation` 可能引用不存在的进程

- **文件**: `src/agent-pool.ts:276-283`
- **规范**: §10 健壮性
- **问题**: `resolveInvocation` 检查 `process.argv[1]` 是否存在，但在 Worker 线程或测试环境中可能指向错误路径。虽然有 fallback 到 `"pi"`，但缺少更精确的检测。
- **代码片段**:
  ```typescript
  private resolveInvocation(extraArgs: string[]): { command: string; args: string[] } {
    const currentScript = process.argv[1];
    if (currentScript && fs.existsSync(currentScript)) {
      return { command: process.execPath, args: [currentScript, ...extraArgs] };
    }
    return { command: "pi", args: extraArgs };
  }
  ```

#### P2-7: `commands.ts` 中 `deleteWorkflow` 使用同步 fs 操作

- **文件**: `src/commands.ts` (`deleteWorkflow`, `saveWorkflow`)
- **规范**: §10 健壮性 — 异步操作最佳实践
- **问题**: `renameSync`, `mkdirSync`, `existsSync`, `unlinkSync` 等同步 fs 操作会阻塞 Node 事件循环。在 Extension 上下文中应使用异步版本。
- **代码片段**:
  ```typescript
  // src/commands.ts
  const TMP_DIR = resolve(".pi/workflows/.tmp");
  const SAVED_DIR = resolve(".pi/workflows");
  // ...
  renameSync(target.path, destPath);  // 同步
  mkdirSync(SAVED_DIR, { recursive: true });  // 同步
  unlinkSync(filePath);  // 同步
  ```

## 优点

1. **优秀的架构拆分**: 将复杂功能拆分为 12 个独立模块（state, orchestrator, agent-pool, commands, config-loader, worker-script, model-resolver, budget, execution-trace, widget, tool-generate, index），职责清晰。

2. **状态机设计严谨**: `state.ts` 中的 `VALID_TRANSITIONS` 表驱动状态机，`transitionStatus()` 函数拒绝非法转换，`TERMINAL_STATUSES` 不可逆。

3. **序列化向后兼容**: `deserializeInstance()` 处理了 legacy `"created"` status、缺失的 budget 字段、null callCache/trace 等场景。

4. **错误处理策略一致**: 所有 tool execute 方法都返回 `{ content, isError?, details? }` 格式，不抛异常。`AgentPool.enqueue()` 的 Promise 永不 reject。

5. **测试覆盖全面**: 8 个测试文件覆盖状态机、编排器、Agent 池、配置加载、Worker 脚本构建、命令/生成工具、审批门控、模型解析等核心功能。

6. **Worker 线程隔离**: workflow 脚本在独立 Worker 中执行，通过 `postMessage` 通信，主线程不受用户脚本异常影响。

7. **Agent Pool 并发控制**: 有界并发池 + FIFO 队列 + 软限制警告回调，设计成熟。

8. **预算执行完备**: token/cost/time 三维预算控制，90% 阈值预警，超限自动终止。

9. **持久化策略健壮**: 外部 JSONL + session 指针条目的双层持久化，支持跨 session 恢复。

10. **Tool prompt 设计精良**: 每个 tool 都有详细的 `description`、`promptSnippet`、`promptGuidelines`，指导 AI 正确使用。

## 改进建议

### 紧急 (P1)

1. **统一 peerDependencies 包名**: 确认 `@mariozechner/pi-tui` 与 `@earendil-works/pi-tui` 是否为同一包的不同命名。如果不是，需在 `peerDependencies` 中添加 `@mariozechner/pi-tui` 和 `@mariozechner/pi-ai`。或者统一代码中的 import 路径。

2. **透传 signal**: 在 `orchestrator.run()` 中接受 `AbortSignal`，传递给 Worker 线程和 AgentPool。在 `executeWithRetry` 的 `setTimeout` 中检查 `signal.aborted`。在 `runPiProcess` 中通过 `proc.kill()` 响应 signal。

3. **修复模块级可变状态**: 将 `notifiedRunIds` 从 `commands.ts` 模块级移入工厂闭包或 Orchestrator 实例。`config-loader.ts` 的 `cache` 可考虑使用实例化模式或添加 session 隔离键。

4. **session_tree 处理 pending 状态**: 在 `session_tree` 事件中，对恢复的 instances 做 pending 状态处理：将 `running` 状态的实例标记为 `paused`（因为切分支后 Worker 已丢失）。

5. **添加 isProcessing 防重入**: 在 workflow tool execute 入口添加基于 `sessionId + runId` 的 `isProcessing` 检查。

### 建议 (P2)

6. **拆分大文件**: 将 `src/index.ts` 的 `registerWorkflowRunTool` 提取到独立的 `src/tool-run.ts`。将 `orchestrator.ts` 的 Worker 管理逻辑提取到 `src/worker-manager.ts`。

7. **修正 import 顺序**: 将 Node 内置模块 import 移到文件顶部（`node:fs`, `node:path` 在 `@mariozechner/pi-coding-agent` 之前）。

8. **修复 commands.ts 路径检测**: 使用 `config-loader.ts` 的 `findWorkspaceRoot()` 替代直接 `resolve(".pi/...")`，保证在 worktree 场景下路径正确。

9. **替换同步 fs 操作**: `commands.ts` 中 `saveWorkflow` / `deleteWorkflow` 使用 `fs.promises.rename` / `fs.promises.unlink` 等异步版本。

10. **缩短事件处理器**: 将 `session_start` 中的 approval 重建和 orchestrator 初始化逻辑提取到辅助函数中，使主处理器 ≤ 20 行。
