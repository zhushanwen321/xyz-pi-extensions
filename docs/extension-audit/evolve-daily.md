# Extension 审查报告: evolve-daily

## 基本信息

- **包名**: `@zhushanwen/pi-evolve-daily`
- **版本**: 0.1.7
- **描述**: Daily evolution data collector — runs Python analyzer on first session of the day.
- **TypeScript 文件数**: 10
- **TypeScript 总行数**: 1,470
- **其他文件数** (JSON/MD/PY): 52

### 文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `index.ts` | 1 | 根 re-export |
| `src/index.ts` | 140 | 工厂函数 + 事件注册 |
| `src/problems.ts` | 249 | Problem 注册表定义 |
| `src/trackers/core.ts` | 496 | Tracker 框架 (createTracker 工厂) |
| `src/trackers/types.ts` | 176 | 类型定义 + 状态机 |
| `src/trackers/skill-execution.ts` | 126 | skill-execution Tracker 配置 |
| `src/detectors/param-error.ts` | 97 | 参数错误检测器 |
| `src/detectors/subagent-result.ts` | 71 | 子代理结果检测器 |
| `src/detectors/compact.ts` | 49 | Compact 频率检测器 |
| `src/detectors/goal-quality.ts` | 65 | Goal 质量检测器 |

---

## 审查结果概览

| # | 规范项 | 状态 | 严重程度 | 说明 |
|---|--------|------|----------|------|
| 1 | 包结构与命名 | ⚠️ 部分 | P1 | `license` 字段缺失 |
| 2 | 入口与工厂模式 | ⚠️ 部分 | P1 | `createTracker` 318 行，超过 100 行但已拆分子函数；`PiOnAny` 类型在两文件重复定义 |
| 3 | Tool 注册与设计 | ✅ 合规 | — | execute 返回正确结构，错误返回 `isError: true`，details 作为数据源 |
| 4 | 事件生命周期管理 | ⚠️ 部分 | P2 | 事件处理器部分超 20 行；`session_tree` 中未显式丢弃旧分支 pending |
| 5 | 状态与会话管理 | ✅ 合规 | — | 状态在工厂闭包内，`deserializeState` 含旧格式兼容 |
| 6 | 错误处理与弹性 | ⚠️ 部分 | P1 | 缺少 `isStaleContextError` 保护；`pi.exec` 未透传 signal |
| 7 | 类型安全 | ✅ 合规 | — | 无 `any` 使用，全部用 `unknown` + 类型断言 |
| 8 | 路径与配置 | ✅ 合规 | — | 使用 `homedir()` + `import.meta.url`，无硬编码路径 |
| 9 | 依赖管理 | ✅ 合规 | — | Pi SDK 用 peerDependencies，`@mariozechner/pi-coding-agent` 未标 optional |
| 10 | 健壮性 | ⚠️ 部分 | P1 | `pi.exec` 调用不支持 signal 取消；无 process.exit/无限循环 |
| 11 | 代码风格 | ⚠️ 部分 | P2 | `src/index.ts` 140 行 ✅，`src/trackers/core.ts` 496 行 ✅ (<500)，`createTracker` 318 行超 80 行 |
| 12 | Monorepo 约定 | ⚠️ 部分 | P2 | import 顺序: Node 内置应先于 Pi SDK |

---

## 详细问题清单

### P0 问题

无 P0 级别问题（崩溃风险）。代码无 `process.exit`、无无限循环、无未捕获异常（所有 handler 有 try/catch）。

---

### P1 问题

#### P1-1: package.json 缺少 `license` 字段

- **规范**: §1 包结构与命名 — "package.json 必须包含: name, version, description, type, license, files, pi.extensions, keywords"
- **文件**: `package.json`
- **现状**: `license` 字段完全缺失
- **建议**: 添加 `"license": "MIT"` 或其他合适许可证

```json
// 缺失
{
  "name": "@zhushanwen/pi-evolve-daily",
  "version": "0.1.7",
  // "license" 字段不存在
}
```

#### P1-2: `pi.exec()` 未透传 signal，异步操作不可取消

- **规范**: §3 "异步操作必须透传 signal 参数"；§10 "异步操作必须支持 signal 取消"
- **文件**: `src/index.ts` 第 53-67 行
- **现状**: `session_start` 处理器中调用 `pi.exec()` 启动 Python analyzer，未接收也不传递 `signal`

```typescript
// src/index.ts:53-67
pi.on("session_start", async () => {
  // ...
  await pi.exec(
    "python3",
    [/* ... */],
    { timeout: ANALYZER_TIMEOUT_MS }
    // ⚠️ 缺少 signal 传递
  );
});
```

- **建议**: `session_start` 事件签名应接收 `signal`，并传入 `pi.exec` 的 options

#### P1-3: 缺少 Stale Context 检测保护

- **规范**: §6 "Stale Context 检测: isStaleContextError 保护"
- **文件**: `src/trackers/core.ts` 中的 `persistState` 和 `reconstructState` 函数
- **现状**: 读写 session entries 时无 `isStaleContextError` 保护。若 context 在操作期间失效（如长时间 Python 执行后），可能导致写入过期数据

#### P1-4: `createTracker` 工厂函数 318 行，超过 100 行规范

- **规范**: §2 "超过100行的工厂函数应按功能委托到子模块"
- **文件**: `src/trackers/core.ts` 第 179-496 行
- **现状**: 虽然已提取了 `renderTrackerCall`、`renderTrackerResult`、`formatItemList` 等辅助函数，但主体仍达 318 行，包含了事件注册、工具注册、消息渲染等多个职责

- **建议**: 可进一步拆分为：
  - `registerTrackerEvents(pi, config, state)` — 事件注册
  - `registerTrackerTool(pi, config, state)` — 工具注册
  - `registerTrackerRenderers(pi, config)` — 渲染器注册

---

### P2 问题

#### P2-1: Import 顺序不符合 Monorepo 约定

- **规范**: §12 "Import 顺序: Node内置 → npm → Pi SDK → 内部包 → 当前包"
- **文件**: `src/index.ts` 第 3-15 行
- **现状**: Pi SDK (`@mariozechner/pi-coding-agent`) 排在 Node 内置 (`node:fs`, `node:os`) 之前

```typescript
// src/index.ts:3-15
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"; // ← Pi SDK 先于 Node
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
```

- **建议**: 调整为 Node 内置优先

```typescript
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
```

> **注**: `src/trackers/core.ts` 的 import 顺序同样存在问题：Pi SDK 和 Pi TUI 交叉混排。

#### P2-2: `PiOnAny` 类型在两个文件中重复定义

- **规范**: §7 "跨文件类型集中到 types.ts"
- **文件**:
  - `src/index.ts` 第 27-29 行
  - `src/trackers/core.ts` 第 34-36 行
- **现状**: 完全相同的类型定义出现两次

```typescript
// 两个文件中都有：
type PiOnAny = {
  on(event: string, handler: (...args: unknown[]) => Promise<void> | void): void;
};
```

- **建议**: 提取到 `src/types.ts` 或 `src/trackers/types.ts` 中统一导出

#### P2-3: 事件处理器超过 20 行

- **规范**: §4 "每个事件处理器不超过20行"
- **文件**: `src/index.ts`, `src/trackers/core.ts`
- **超标处理器**:

| 处理器 | 文件 | 行数 |
|--------|------|------|
| `session_start` (Python analyzer) | `src/index.ts:40-70` | 31 行 |
| `tool_result` (detector 循环) | `src/index.ts:116-139` | 24 行 |
| `triggerEvent` (tool_call) | `src/trackers/core.ts:270-305` | 36 行 |
| `turn_end` (remind 检查) | `src/trackers/core.ts:313-347` | 35 行 |
| `execute` (tool) | `src/trackers/core.ts:401-477` | 77 行 |

- **注**: `execute` 函数 77 行，接近但未超过 80 行限制，可接受但建议优化

#### P2-4: `session_tree` 处理器未显式丢弃旧分支 pending 状态

- **规范**: §4 "session_tree 中必须丢弃旧分支的 pending 状态"
- **文件**: `src/trackers/core.ts` 第 265-266 行
- **现状**: `session_tree` 与 `session_start` 共用 `handleSessionRestore`，其中调用 `reconstructState` 从 entries 重建状态，虽然终态过滤存在，但没有显式针对旧分支 pending 项的处理逻辑

```typescript
pi.on("session_tree", handleSessionRestore);
// handleSessionRestore → reconstructState → 仅过滤终态，无分支感知
```

#### P2-5: `execute` 中 `signal` 参数未使用

- **规范**: §3 "异步操作必须透传 signal 参数"
- **文件**: `src/trackers/core.ts` 第 404 行
- **现状**: `_signal` 参数声明但从未使用。execute 内有 `await pi.sendUserMessage()` 调用，未检查 signal 是否已取消

```typescript
async execute(
  _toolCallId: string,
  params: Static<typeof TrackerParams>,
  _signal: AbortSignal | undefined,  // ← 未使用
  _onUpdate: unknown,
  ctx: ExtensionContext,
): Promise<ToolResult> {
```

---

## 优点

1. **✅ 类型安全优秀**: 全局无 `any` 使用，所有动态类型场景使用 `unknown` + 类型守卫/断言，`Record<string, unknown>` 仅用于序列化/反序列化场景
2. **✅ 错误处理规范**: 所有 tool execute 错误返回 `{ isError: true }`，无 throw；事件处理器全部包裹 try/catch
3. **✅ 状态管理清晰**: 状态完全封装在工厂闭包内，无模块级 `let` 变量；反序列化 `deserializeState` 完整处理了旧格式兼容（`legacyEntryTypes`、`skillMdPath` 迁移、缺失 anchor 填充）
4. **✅ 路径处理规范**: 资源路径通过 `import.meta.url` + `dirname` 定位，运行时数据通过 `homedir()` + `path.join()` 构建，无硬编码绝对路径
5. **✅ 依赖声明正确**: Pi SDK 包均为 `peerDependencies`，`@mariozechner/pi-coding-agent` 未标记 optional
6. **✅ 架构分层合理**: 检测器 (detectors) → 问题注册表 (problems) → 追踪器框架 (trackers) 三层解耦，`TrackerConfig<TMeta>` 泛型设计支持多种追踪场景
7. **✅ 模块尺寸控制**: 所有文件均在 500 行以内，最大文件 `core.ts` 496 行
8. **✅ 常量提取**: 所有 magic number 提取为命名常量（阈值、radix、slice 范围等）
9. **✅ 状态机设计**: `TrackedItem` 状态转换使用显式 `ALLOWED_TRANSITIONS` 矩阵 + `canTransition` 守卫，终态不可变

---

## 改进建议

### 高优先级

1. **补充 `license` 字段**: 在 `package.json` 中添加 `"license": "MIT"`（或项目实际许可证）

2. **Signal 透传**: 在 `session_start` 事件中接收 signal 并传给 `pi.exec()`；在 `execute` 中检查 `signal.aborted`

```typescript
// src/index.ts — 建议改为:
pi.on("session_start", async (_event: unknown, _ctx: unknown, signal?: AbortSignal) => {
  // ...
  await pi.exec("python3", [...], { timeout: ANALYZER_TIMEOUT_MS, signal });
});
```

3. **拆分 `createTracker`**: 将 318 行的工厂函数拆分为独立子模块:
   - `src/trackers/events.ts` — 事件注册逻辑 (~150 行)
   - `src/trackers/tool.ts` — 工具注册逻辑 (~100 行)
   - `src/trackers/core.ts` — 仅保留编排逻辑 (~60 行)

### 中优先级

4. **统一 `PiOnAny` 类型**: 提取到 `src/types.ts` 或扩展 Pi SDK 类型定义，消除重复

5. **修正 import 顺序**: 所有文件统一为 Node 内置 → npm → Pi SDK → 内部包 → 当前包

6. **`session_tree` 分支感知**: 在 `handleSessionRestore` 中添加对旧分支 pending 项的显式清理

### 低优先级

7. **事件处理器瘦身**: 将 `session_start` 的 Python analyzer 调用提取为 `runAnalyzerIfNeeded()` 函数；将 `triggerEvent` 和 `turn_end` 的核心逻辑提取为独立函数

8. **添加 Stale Context 保护**: 在 `persistState` 和 `reconstructState` 中使用 `isStaleContextError` 包装 session 操作

9. **`ToolResultDetector` 类型集中**: `src/index.ts` 中的 `ToolResultDetector` 接口可考虑移入类型集中文件
