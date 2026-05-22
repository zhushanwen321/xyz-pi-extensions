---
verdict: fail
must_fix: 3
---

# Subagent 扩展健壮性审查报告

**审查范围**: `subagent/src/` 下 5 个 TypeScript 源文件（共 2311 行）
**审查日期**: 2026-05-22
**审查维度**: 错误处理、边界条件、资源泄漏、并发安全、类型安全、超时/取消

---

## MUST_FIX 问题

### MF-1: `process.kill(0)` 可向整个进程组发送 SIGTERM（P0）

| 严重级别 | 文件 | 行号(约) | 问题描述 | 建议修复方向 |
|----------|------|----------|----------|-------------|
| P0 | `subagent/src/spawn.ts` | 414 | `pid: proc.pid ?? 0`：当 `spawn()` 失败（ENOENT、权限等）时 `proc.pid` 为 `undefined`，回退到 `0`。随后 `cleanupJobLocal()` 中 `process.kill(job.pid, "SIGTERM")` 会调用 `process.kill(0, "SIGTERM")`，向当前进程组的**所有进程**发送 SIGTERM，包括 Pi 主进程自身 | 将回退值改为 `undefined` 而非 `0`，`cleanupJobLocal` 中加 `if (job.pid) process.kill(job.pid, ...)` 守卫；或使用 `ChildProcess.kill()` 代替 `process.kill(pid)` |

**细节**：虽然 `cleanupJobLocal` 有 `if (job.status === "running")` 守卫，但 `startBackgroundJobImpl` 中 spawn 和 error 事件之间存在异步间隙——job 已入 `jobs` Map 且 status 为 `"running"`，但 pid 尚未设置（或 spawn 已失败但 error 回调还未执行）。若此时 `cleanupAllJobs()` 被调用（session_shutdown），就会触发 `process.kill(0)`。

### MF-2: `mapWithConcurrencyLimit` 使用 `Promise.all`，单任务失败丢失所有结果（P1）

| 严重级别 | 文件 | 行号(约) | 问题描述 | 建议修复方向 |
|----------|------|----------|----------|-------------|
| P1 | `subagent/src/spawn.ts` | 100 | `await Promise.all(workers)`：任一 worker 抛出异常即导致整体 reject。在 parallel 模式下，若一个 subagent 被 abort（`wasAborted` 抛出），所有已完成的 parallel 任务结果丢失，且正在运行的子进程不会被清理 | 改用 `Promise.allSettled`，在 worker 内部 catch 异常转为错误结果。与项目 CLAUDE.md 规则 "多个独立数据源的并行请求使用 Promise.allSettled" 一致 |

**细节**：`runSingleAgentImpl` 在 abort 时直接 `throw new Error("Subagent was aborted")`（约 341 行），parallel 模式的 `mapWithConcurrencyLimit` 不 catch 此异常。即使其他 N-1 个任务已成功完成，用户也看不到任何结果。此外，那些仍运行的子进程不会被 kill——它们的 AbortSignal listener 虽会触发，但 Promise.all 已 reject，后续结果无人接收。

### MF-3: `spawnManager` 和 `capturedSessionId` 跨 Session 共享（P1）

| 严重级别 | 文件 | 行号(约) | 问题描述 | 建议修复方向 |
|----------|------|----------|----------|-------------|
| P1 | `subagent/src/index.ts` | 78-80 | `spawnManager` 和 `capturedSessionId` 在扩展工厂函数内创建。根据项目 CLAUDE.md："同一进程可能有多个 session"。工厂函数只执行一次（进程级注册），因此这些状态跨 session 共享。Session A 的 `cleanupAllJobs()` 会 kill Session B 的 background jobs；`sessionShortId()` 可能返回错误 session 的 ID | 在 `session_start` 事件中重建 `spawnManager` 和 `capturedSessionId`，或将状态存入 `ctx.sessionManager` entries。`spawn.ts` 注释声称 "session-scoped" 但实际不是 |

**细节**：`spawn.ts` 头部注释 "Session isolation: all mutable state ... is created inside createSpawnManager() factory closure, so each Pi session gets its own independent job tracker" 与实际行为矛盾——`createSpawnManager(pi)` 只在工厂函数中调用一次。

---

## SHOULD_FIX 问题

### SF-1: `wasAborted` 时直接 throw，foreground 调用方无 try/catch（P1）

| 严重级别 | 文件 | 行号(约) | 问题描述 | 建议修复方向 |
|----------|------|----------|----------|-------------|
| P1 | `subagent/src/spawn.ts` | 341 | `if (wasAborted) throw new Error("Subagent was aborted")`：此 throw 在 `finally` 块之后、`runSingleAgentImpl` 返回前触发。Single mode 的调用方（index.ts Step 8）无 try/catch 包装，直接 await 返回值。Abort 时 execute 函数会抛出未捕获异常，而非返回 `isError: true` 的结构化结果 | 返回一个 `exitCode: -1, stopReason: "aborted"` 的 SingleResult 而非 throw。所有模式（single/parallel/chain）都已能处理此类结果对象 |

### SF-2: `formatToolCall` 大量 `as string` 类型断言（P2）

| 严重级别 | 文件 | 行号(约) | 问题描述 | 建议修复方向 |
|----------|------|----------|----------|-------------|
| P2 | `subagent/src/render.ts` | 136-180 | `args.command as string`、`args.file_path as string` 等多处类型断言。若 tool 参数 schema 变更或 args 结构不符预期，不会在编译期报错，运行时生成 `"undefined"` 字符串 | 使用类型守卫函数（如 `isString(v): v is string`）或带默认值的安全提取 `String(args.command ?? "")` |

### SF-3: `renderResult` 中 `context.state` 和 `context.invalidate` 通过双重类型断言访问（P2）

| 严重级别 | 文件 | 行号(约) | 问题描述 | 建议修复方向 |
|----------|------|----------|----------|-------------|
| P2 | `subagent/src/index.ts` | 497-499 | `(context as unknown as Record<string, unknown>).state` 和 `.invalidate`：访问了 renderContext 未公开的内部属性。若 Pi 运行时更新移除或重命名这些属性，代码会静默失败（timer 不启动或不清除） | 定义一个 render context 扩展接口（`interface RenderContextEx { state?: Record<string, unknown>; invalidate?: () => void }`），或通过 feature detection 先检查属性存在性 |

---

## NICE_TO_FIX 问题

### NF-1: `cleanupOldTempFiles` 每次执行同步文件 I/O（P2）

| 严重级别 | 文件 | 行号(约) | 问题描述 | 建议修复方向 |
|----------|------|----------|----------|-------------|
| P2 | `subagent/src/spawn.ts` | 66-76 | `cleanupOldTempFiles()` 在每次 `execute` 调用时执行（index.ts 约 106 行）。内部使用 `fs.readdirSync` + `fs.statSync` + `fs.unlinkSync` 遍历整个临时目录。若临时文件积攒较多，会阻塞事件循环 | 加时间节流（如每 5 分钟执行一次），或改用异步版本在后台执行 |

### NF-2: `writePromptToTempFile` 写入失败不清理临时文件（P2）

| 严重级别 | 文件 | 行号(约) | 问题描述 | 建议修复方向 |
|----------|------|----------|----------|-------------|
| P2 | `subagent/src/spawn.ts` | 90-96 | `withFileMutationQueue` 内的 `writeFile` 若失败（磁盘满、权限），异常传播但已创建的空文件不会被清理。长期运行可能积累空文件 | 在 catch 块中尝试 `fs.unlinkSync(filePath)` |

### NF-3: model 缓存永不过期（P2）

| 严重级别 | 文件 | 行号(约) | 问题描述 | 建议修复方向 |
|----------|------|----------|----------|-------------|
| P2 | `subagent/src/model.ts` | 56 | 模块级 `_cachedModels` 是进程级单例缓存，加载后永不过期。若用户在 Pi 运行期间修改 `subagent-models.json`（如切换 provider），需重启 Pi 才能生效 | 添加 TTL（如 60 秒），或提供 `clearModelCache()` 函数在配置变更时调用 |

### NF-4: SIGKILL setTimeout 未清理（P2）

| 严重级别 | 文件 | 行号(约) | 问题描述 | 建议修复方向 |
|----------|------|----------|----------|-------------|
| P2 | `subagent/src/spawn.ts` | 332-336 | abort 时设置 5 秒后 SIGKILL 的 setTimeout，即使进程已正常退出也会执行（虽然 `proc.killed` 检查使其无害）。timer 引用 `proc` 对象，延长其 GC 寿命 | 在 `proc.on("close")` 中 `clearTimeout(killTimer)` |

### NF-5: `modelParam!` 非空断言（P2）

| 严重级别 | 文件 | 行号(约) | 问题描述 | 建议修复方向 |
|----------|------|----------|----------|-------------|
| P2 | `subagent/src/index.ts` | 174 | `await resolveModel(modelParam!, ctx)`：逻辑上此时 `modelParam` 必有值（进入 else 分支说明 `effectiveComplexity` 为 undefined，即 `modelParam` 存在），但 `!` 非空断言将此逻辑编码在隐式推理中 | 提前赋值 `const explicitModel = modelParam!` 并加注释说明为什么此时 modelParam 必有值，或改写分支逻辑消除断言 |

### NF-6: `renderResult` timer 泄漏风险（P2）

| 严重级别 | 文件 | 行号(约) | 问题描述 | 建议修复方向 |
|----------|------|----------|----------|-------------|
| P2 | `subagent/src/index.ts` | 500-508 | `setInterval` 每秒触发 `ctxInvalidate()` 实现实时计时器。清理依赖 `hasAnyRunning` 变为 false 后的再次渲染。若 session 异常退出或 UI 丢弃该 result widget，timer 永不清除 | 注册 `session_shutdown` 事件清理所有活跃 timer，或在 `cleanupAllJobs` 中一并清理 |

---

## 总结

| 级别 | 数量 | 关键点 |
|------|------|--------|
| P0 | 1 | `process.kill(0)` 可导致进程组信号风暴 |
| P1 | 3 | Promise.all 单点故障、跨 session 状态共享、abort throw 未 catch |
| P2 | 6 | 类型安全、资源清理、缓存过期、非空断言 |

**核心建议**：
1. **MF-1 优先级最高**——`proc.pid ?? 0` 改为 `proc.pid ?? undefined`，kill 前检查 pid 有效性
2. **MF-2 与 SF-1 联动修复**——将 `wasAborted` throw 改为返回 aborted 结果 + `mapWithConcurrencyLimit` 改用 `Promise.allSettled`
3. **MF-3 需要架构调整**——将 `spawnManager` 和 `capturedSessionId` 移入 `session_start` 事件闭包或 `ctx.sessionManager` entries
