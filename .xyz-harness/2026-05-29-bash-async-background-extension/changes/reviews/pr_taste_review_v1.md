---
verdict: fail
must_fix: 6
reviewer: taste-review-v1
date: 2026-05-30
scope: bash-async/src/{index,jobs,shell,spawn,types}.ts
basis: essence.md (四条根本原则) + ts/taste.md (原则/偏好/反模式)
---

# Code Taste Review — bash-async Extension

**Files reviewed**: `index.ts` (197L), `jobs.ts` (184L), `shell.ts` (74L), `spawn.ts` (469L), `types.ts` (63L)

---

## Summary

代码整体质量不错——类型定义集中在 `types.ts`、渲染逻辑内聚在 `index.ts`、spawn 逻辑独立为 `spawn.ts`。错误处理使用 `throw new Error()` 而非错误成功模式，符合项目规范。但存在 **6 个 MUST_FIX** 问题，集中在「参数过多」和「死代码/死字段」两类品味违规。

---

## MUST_FIX (6)

### M1. `detachJob` 9 个参数 — 违反"参数 >5 应打包为结构体"

- **文件**: `spawn.ts:236-247`
- **原则**: 二、一个关注点一条路径 — "参数 >5 个应打包为结构体"（强度：不可违背）
- **现状**: `detachJob(cmd, cwd, timeout, child, outFile, exitPromise, chunks, removeCapture, jobs)` 共 9 个参数，调用时难以对应实参到形参。
- **修复方向**: 将 spawn 产物打包为 `SpawnContext` 接口：

  ```typescript
  interface SpawnContext {
    child: ChildProcess;
    outFile: string;
    exitPromise: Promise<number | null>;
    chunks: Buffer[];
    removeCapture: () => void;
  }

  function detachJob(
    cmd: string, cwd: string, timeout: number,
    spawn: SpawnContext, jobs: Map<string, Job>,
  ): ToolResult
  ```

### M2. `executeSync` 8 个参数 — 同上

- **文件**: `spawn.ts:148-156`
- **原则**: 同 M1
- **现状**: `executeSync(cmd, cwd, timeout, signal, onUpdate, jobs, shellCtx, config)` — 8 个参数。
- **修复方向**: 将 `jobs` + `shellCtx` + `config` 打包为 `SessionContext`（在 `executeBackground`、`executeSync` 间复用）：

  ```typescript
  interface SessionContext {
    jobs: Map<string, Job>;
    shellCtx: ShellContext;
    config: BashAsyncConfig;
  }
  ```

  签名降为 `executeSync(cmd, cwd, timeout, signal, onUpdate, ctx: SessionContext)` — 6 参数。配合 M1 的 `SpawnContext` 可进一步降至 5。

### M3. `BashAsyncToolDetails.mode` 从未赋值 — 类型定义与实际数据不一致

- **文件**: `types.ts:55`
- **原则**: 反模式 — 类型定义与实际数据不一致（强度：避免）
- **现状**: `mode?: string` 声明在接口中，但所有 `makeResult()` 调用点从未设置此字段。运行时永远是 `undefined`。
- **修复方向**: 删除 `mode` 字段。如果未来需要，`action` 的 `"sync-detach" | "background"` 已包含模式信息，无需冗余字段。此外 `mode: string` 应为 `mode: JobMode`（如果保留），用 `string` 是弱类型。

### M4. `resolveShell` 无调用方 — 死导出

- **文件**: `shell.ts:14`
- **原则**: 反模式 — 暴露内部实现（强度：避免）
- **现状**: `export { getShellConfig as resolveShell } from "@mariozechner/pi-coding-agent";` 无任何文件导入或使用 `resolveShell`。违反"只导出精心设计的公共接口"。
- **修复方向**: 删除此 re-export。如果认为未来外部可能需要，在注释中记录理由，但不导出未使用的符号。

### M5. `SpawnResult.writeStream` 从未被调用方使用 — 死接口字段

- **文件**: `spawn.ts:65`
- **原则**: 反模式 — 暴露内部实现（强度：避免）
- **现状**: `writeStream` 在 `SpawnResult` 接口中导出，但 `executeSync`（L171）和 `executeBackground`（L308）均解构时跳过此字段。unpipe/destroy 在 `spawnCommand` 内部的 exit/error handler 中完成，不需要外部访问。
- **修复方向**: 从 `SpawnResult` 接口中移除 `writeStream`，仅在 `spawnCommand` 内部作为局部变量使用。

### M6. `buildShellContext(prefix?)` 的 `prefix` 参数无调用方传入

- **文件**: `shell.ts:65`
- **原则**: YAGNI（essence.md 决策框架引用）
- **现状**: `prefix` 参数可选且唯一调用方 `index.ts:74` 传 `buildShellContext()` 不带参数。参数存在但无使用场景。
- **修复方向**: 删除 `prefix` 参数。如果未来需要，再添加。

---

## LOW (5)

### L1. spawn.ts 469 行超过 300 行阈值

- **文件**: `spawn.ts`（整体）
- **原则**: 结构先于一切 — "单文件超过 300 行应审视是否需要拆分"
- **现状**: 469 行，包含 4 个 mode 函数 + spawnCommand + helpers。未到 500 "几乎一定需要"线，但各 mode 函数已足够独立。
- **修复方向**: 按职责拆为 `spawn-core.ts`（spawnCommand + helpers）和 `spawn-modes.ts`（4 个 execute* 函数），共享 `SpawnResult`/`ToolResult` 通过内部 types 传递。非阻塞，但建议在模式稳定后拆分。

### L2. `jobs` Map 类型使用冗余 inline import

- **文件**: `index.ts:41`
- **原则**: 显式优于隐式
- **现状**: `Map<import("./types.js").Job["jobId"], import("./types.js").Job>` — `Job["jobId"]` 计算为 `string`，整个类型等价于 `Map<string, Job>`。读者需心智推演才能确认类型。
- **修复方向**: 将 `Job` 加入已有的 `import type { ... } from "./types.js"` 行，改写为 `Map<string, Job>`。

### L3. 魔法数字 5000 / 6000 — 进程终止宽限期

- **文件**: `jobs.ts:127`（5000ms）、`spawn.ts:461`（6000ms）
- **原则**: 显式优于隐式 — 语义化命名
- **现状**: `killProcessGroup` 等待 5 秒宽限期，`executeKill` 等待 6 秒超时。6 秒 = 5 秒 + 1 秒 buffer 的关系是隐式的。两者语义相关但命名和值分散在不同文件。
- **修复方向**: 定义常量 `const GRACEFUL_SHUTDOWN_MS = 5_000;`（在 jobs.ts 导出）和 `const KILL_WAIT_MS = GRACEFUL_SHUTDOWN_MS + 1_000;`（在 spawn.ts 导入），让关系显式化。

### L4. `theme: unknown` + `as` 断言重复两处

- **文件**: `index.ts:107`、`index.ts:129`
- **原则**: 消除重复
- **现状**: `theme as { fg: (token: string, text: string) => string }` 在 `renderCall` 和 `renderResult` 各出现一次，`renderResult` 的版本多了 `bold`。这是 Pi 扩展 API 的已知模式（theme 类型为 `unknown`），但断言逻辑可收敛。
- **修复方向**: 提取类型别名 `interface ThemeAccess { fg(token: string, text: string): string; bold(text: string): string; }`，在两处统一使用 `const t = theme as ThemeAccess`。`renderCall` 不用 `bold` 不影响多包含一个方法。

### L5. `loadPiSettings` "first-found-wins" 语义导致项目级设置被跳过

- **文件**: `shell.ts:36-56`
- **原则**: 显式优于隐式
- **现状**: 遍历全局和项目级 settings 文件，但只要第一个文件存在（即使不含 shellPath），就立即 `return`，项目级文件永远不会被检查。
- **修复方向**: 两种改法任选：(A) 改为 merge 语义——两个文件的设置合并，项目级覆盖全局；(B) 在 JSDoc 中明确标注 "global settings take precedence over project settings, first file found wins"。推荐 (A)。

---

## INFO (3)

### I1. `buildShellEnv` 的 `as Record<string, string>` 断言

- **文件**: `shell.ts:33`
- **现状**: `process.env` 的值可能为 `undefined`，`as Record<string, string>` 隐藏了这个事实。这是 Node.js 的常见模式（`child_process.spawn` 的 env 参数接受 `Record<string, string>`），可以接受。建议添加 `// process.env values cast to string for spawn compat` 注释。

### I2. `executeSync` 82 行略微超过 80 行建议值

- **文件**: `spawn.ts:148-229`
- **现状**: 82 行，刚过 80 行理想线。远未到 150 行必须拆分线。配合 M1/M2 的参数打包重构后可能自然回落。

### I3. `cleanupJobs` 先 sync unlink 再 await kill — 顺序可商榷

- **文件**: `jobs.ts:73-87`
- **现状**: 先同步删除所有 temp 文件（包括正在运行的 job 的输出文件），再异步等待 kill 完成。kill 完成后的 exit handler 可能尝试写入已被删除的文件。当前因为 `writeStream` 已创建， unlink 不影响正在写入的流（文件描述符仍有效），但删除后再读取会得到空结果。
- **建议**: 不阻塞，但值得记录设计决策——注释说明"先删除文件再等待 kill，因为流仍持有 fd"。

---

## Positive Observations

1. **类型集中管理**: 所有接口定义在 `types.ts`，无跨文件重复类型定义。
2. **边界验证**: `loadConfig` 使用 `typeof` 运行时校验外部 JSON 输入，符合"信任止于边界"。
3. **统一错误模式**: 所有错误通过 `throw new Error()` 或 `makeErrorResult()` 处理，无错误成功模式。
4. **资源生命周期**: `cleanupJobs` 使用 `Promise.allSettled` 等待所有 kill 操作，不因个别失败而跳过。
5. **session 隔离**: `jobs` Map 在 `session_start` 重建，`session_shutdown` 清理，符合 Pi 扩展规范。
6. **职责分离清晰**: `jobs.ts`（生命周期）、`shell.ts`（环境构建）、`spawn.ts`（执行逻辑）、`index.ts`（注册胶水）各司其职。
7. **AbortSignal 管理**: `spawnCommand` 中 `addEventListener` + `finally` 中 `removeEventListener`，避免泄漏。

---

## Verdict

**FAIL** — 6 个 MUST_FIX 问题需要在合并前修复。核心问题是参数过多（2 个函数超过 8 个参数）和死代码/死字段（3 处导出/接口成员未被使用）。修复工作量估计 1-2 小时，主要是参数打包重构。
