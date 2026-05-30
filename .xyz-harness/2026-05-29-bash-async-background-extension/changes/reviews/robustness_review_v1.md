---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-30T12:00:00"
  target: "bash-async/src/"
  verdict: fail
  summary: "健壮性审查完成，第1轮，3条MUST FIX（WriteStream泄漏、spawn error未捕获、kill race condition），需修改后重审"

statistics:
  total_issues: 10
  must_fix: 3
  must_fix_resolved: 0
  low: 4
  info: 3

issues:
  - id: 1
    severity: MUST_FIX
    location: "bash-async/src/spawn.ts:L86-L87"
    title: "WriteStream 在 spawn 失败/error 事件时可能泄漏"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "bash-async/src/spawn.ts:L68-L97"
    title: "spawn error 事件（ENOENT/EACCES）未被捕获，导致 uncaught exception"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "bash-async/src/spawn.ts:L254-L270"
    title: "executeKill 中 exit 事件监听存在 race condition，可能永远不 fire"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "bash-async/src/spawn.ts:L56"
    title: "validateCwd 导入 fs 在函数定义之后，依赖 hoisting"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "bash-async/src/jobs.ts:L65-L70"
    title: "cleanupJobs 中 unlinkSync 在 async kill 之前执行，临时文件可能残留"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "bash-async/src/spawn.ts:L150"
    title: "NEVER_RESOLVES Promise 无被 GC 回收的保证（理论上可被永久持有）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: LOW
    location: "bash-async/src/spawn.ts:L192"
    title: "detachJob 中 exitPromise.then 无 catch，异常被静默吞掉"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: INFO
    location: "bash-async/src/spawn.ts:L113-L114"
    title: "onUpdate 每次数据都创建新 string，高频输出时有 GC 压力"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 9
    severity: INFO
    location: "bash-async/src/shell.ts:L58-L62"
    title: "loadPiSettings 使用 void e 吞掉 JSON.parse 错误，无任何日志"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 10
    severity: INFO
    location: "bash-async/src/index.ts:L15"
    title: "从 @earendil-works/pi-tui 导入而非 @mariozechner/pi-tui，与 CLAUDE.md 导入规范不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 健壮性审查 v1

## 评审记录
- 评审时间：2026-05-30 12:00
- 评审类型：健壮性专项审查（错误处理、异常安全、日志、Fail-fast、测试友好、调试友好）
- 评审对象：bash-async/src/ 全部源码（types.ts, shell.ts, jobs.ts, spawn.ts, index.ts）

## 六维度审查结果

### 1. 错误处理 — spawn 失败、ENOENT、EACCES

#### ⛔ MUST_FIX #2: spawn error 事件未被捕获

**位置**: `spawn.ts:L68-L97`（`spawnCommand` 函数）

**问题**: `child_process.spawn()` 是异步的——如果 shell 二进制不存在（ENOENT）或没有执行权限（EACCES），`child` 对象会触发 `error` 事件而非 throw。当前代码没有监听 `child.on("error", ...)`，这意味着：

- spawn `ENOENT`（shell 路径无效）→ `error` 事件触发，但无人处理 → uncaught exception → 进程崩溃
- spawn `EACCES`（shell 不可执行）→ 同上
- 这直接违反了 spec FR-11（"spawn 失败时返回 isError: true + 错误信息"）

**修复方向**: 在 `spawnCommand` 中添加 `child.on("error", (err) => { ... })` handler，reject exitPromise 并确保上层能捕获为正常的 ToolResult 错误。或者将 `spawnCommand` 改为返回一个包含 error 的联合类型。

```typescript
// spawnCommand 内部应添加:
child.on("error", (err) => {
  // reject exitPromise 或设置 error 标记
});
```

#### ⚠️ LOW #4: validateCwd 的 fs 导入位置依赖 hoisting

**位置**: `spawn.ts:L56`（`import * as fs from "node:fs"` 出现在 `validateCwd` 函数之后）

**问题**: `fs` 的 import 在文件中部而非文件头部，依赖 ES module hoisting 工作。虽然功能上正确，但违反了 CLAUDE.md 的 import 顺序规范（"import 顺序：Node 内置 → npm 包 → 项目内部"），且降低可读性。这看起来是代码编写时的疏忽——在编写 `validateCwd` 时才发现需要 fs，在函数后补了 import。

**修复方向**: 将 `import * as fs from "node:fs"` 移到文件顶部 import 区域。

### 2. 异常安全 — 资源泄漏（WriteStream、child process）

#### ⛔ MUST_FIX #1: WriteStream 在异常路径下泄漏

**位置**: `spawn.ts:L86-L87`

```typescript
const writeStream = fs.createWriteStream(outFile, { flags: "w" });
child.stdout?.pipe(writeStream);
child.stderr?.pipe(writeStream);
```

**问题**: 
1. 如果 `child.stdout` 或 `child.stderr` 为 null（理论上 `stdio: ["pipe", "pipe", "pipe"]` 不应如此，但防御性编程要求处理），`pipe` 调用会抛 TypeError，此时 `writeStream` 已创建但未被关闭。
2. 更严重的是：当 `child` 触发 `error` 事件（ENOENT/EACCES，见 MUST_FIX #2），`writeStream` 不会自动关闭。`pipe` 只在 `child.stdout` 触发 `end` 或 `close` 时自动关闭目标，但如果 spawn 本身失败，source stream 可能永远不会触发这些事件。
3. 在 sync 模式的 `executeSync` 中，如果 `Promise.race` 因超时走到 `detachJob`，`writeStream` 被留在后台继续写入——这是设计意图，没问题。但如果 `Promise.race` 因正常退出返回，`removeOutputFile(outFile)` 被调用删除文件，但 `writeStream` 没有显式关闭。文件被删除后 writeStream 尝试写入会产生 `EPERM` 或 `ENOENT` 错误。

**修复方向**: 
- 在 `child` 的 `exit` 或 `close` 事件中 `writeStream.destroy()`
- 在 spawn `error` handler 中 `writeStream.destroy()`
- 在 `executeSync` 正常完成路径中，在删除 outFile 之前 `writeStream.destroy()`

#### ⚠️ LOW #5: cleanupJobs 中 unlinkSync 在 async kill 之前执行

**位置**: `jobs.ts:L65-L70`

```typescript
promises.push(killProcessGroup(job.pid).catch(...));
job.status = "killed";
try {
  fs.unlinkSync(job.outFile);
} catch (e: unknown) { void e; }
```

**问题**: `fs.unlinkSync(job.outFile)` 在 `killProcessGroup` 完成**之前**执行。虽然 kill 是异步的，但文件删除是同步的。如果进程仍在写入输出文件（它还在运行），文件系统行为取决于平台：
- Unix: unlink 后进程仍可写入（inode 引用），但文件名已消失
- 这不导致 crash，但如果进程在 unlink 和 kill 之间产生了新输出，这些输出会丢失（写入已 unlink 的 inode）

更重要的是：`cleanupJobs` 标记 `job.status = "killed"` 在 `killProcessGroup` 完成之前，如果 kill 失败（权限不足等），job 状态与实际不一致。

**修复方向**: 先 await 所有 kill，再删除文件。或改为 `await Promise.allSettled(promises)` 之后批量删除文件。

#### ⚠️ LOW #6: NEVER_RESOLVES Promise 可能阻止 GC

**位置**: `spawn.ts:L150`

```typescript
const NEVER_RESOLVES: Promise<null> = new Promise(() => {});
```

**问题**: 这是一个永远不会 resolve 的 Promise，用作 `Promise.race` 的"永不触发"分支。虽然 `handle.unref()` 确保 timer 不阻止进程退出，但 `NEVER_RESOLVES` 本身是一个模块级常量，永远处于 pending 状态。

当 `timeout = 0`（永不超时）时，`Promise.race([exitPromise, NEVER_RESOLVES])` 中 `NEVER_RESOLVES` 会一直被持有引用。这不影响正确性（`exitPromise` resolve 后 `race` 完成），但每个 sync 调用都会创建对 `NEVER_RESOLVES` 的新引用链。

**修复方向**: 当前实现可接受，但如果追求极致健壮性，可以用 `if (effectiveTimeout <= 0) { await exitPromise; } else { ... race ... }` 避免。

#### ⚠️ LOW #7: detachJob 中 exitPromise.then 无 catch

**位置**: `spawn.ts:L192`

```typescript
exitPromise.then((code) => {
  updateJobStatus(jobs, jobId, code === 0 ? "done" : "failed", code ?? undefined);
});
```

**问题**: `.then()` 不带 `.catch()`。虽然 `exitPromise` 是从 `child.on("exit")` 构造的、不太可能 reject，但如果不带 catch 且 Promise 确实 reject 了，会产生 unhandled rejection warning。对比 `executeBackground` 中的写法（`.then().catch()`）是正确的。

**修复方向**: 添加 `.catch()` handler：
```typescript
exitPromise.then((code) => {
  updateJobStatus(jobs, jobId, code === 0 ? "done" : "failed", code ?? undefined);
}).catch((e: unknown) => {
  console.error("[bash-async] detach exit handler error:", e instanceof Error ? e.message : e);
});
```

### 3. 日志 — console.error 是否足够诊断问题

#### ✅ 总体良好

日志使用 `console.error`（stderr）而非 `console.log`，符合 CLAUDE.md 的 `no-console-log-in-tui` 规则。所有日志都带有 `[bash-async]` 前缀，便于 grep。

#### ℹ️ INFO #9: loadPiSettings 吞掉 JSON 解析错误

**位置**: `shell.ts:L58-L62`

```typescript
} catch (e: unknown) {
  void e;
}
```

**问题**: 如果 settings.json 存在但格式非法（bad JSON），错误被完全静默吞掉。用户可能困惑于为什么 shell 设置不生效。

**修复方向**: 添加 `console.error("[bash-async] settings parse error:", ...)` 日志。

#### ℹ️ INFO #8: onUpdate 高频调用时的 GC 压力

**位置**: `spawn.ts:L113-L114`

```typescript
child.stdout?.on("data", () => forwardData());
```

**问题**: 每次 stdout data 事件都调用 `getBufferContent(chunks)` 做 `Buffer.concat()` + `toString()`，产生新字符串。对于高频输出（如编译日志），这会产生大量临时字符串。这是性能问题而非正确性问题。

**修复方向**: 节流 onUpdate 调用（如每 200ms 一次），或在 `onUpdate` 回调中做 debounce。

### 4. Fail-fast — 无效参数、不存在的 cwd、无效配置

#### ✅ 良好

- `validateCwd` 在执行前检查 cwd 存在性和目录类型（ENOENT 和非目录两种情况都处理了）
- 模式互斥校验（poll/kill/background/command 不能混用）在 execute 入口处做了 fail-fast
- `loadConfig` 对配置值做类型和范围校验（`>= 0`, `> 0`），非法值 fallback 到默认值
- `runningJobCount` 检查在 background 启动前做并发限制

#### ℹ️ INFO #10: import scope 不一致

**位置**: `index.ts:L15`

```typescript
import { Text } from "@earendil-works/pi-tui";
```

**问题**: CLAUDE.md 明确要求统一使用 `@mariozechner/*` scope 作为"两个 pi 都认识的公约数"。此处使用了 `@earendil-works/pi-tui`，虽然两个 scope 在 xyz-pi 上都注册了 alias（功能等价），但违反了项目编码规范的一致性要求。

**修复方向**: 改为 `import { Text } from "@mariozechner/pi-tui"`。

### 5. 测试友好 — 模块是否可独立测试

#### ✅ 整体良好，但有改进空间

- `jobs.ts` 中的纯函数（`generateJobId`, `findJob`, `updateJobStatus`, `runningJobCount`）可独立测试
- `shell.ts` 中的 `buildShellEnv` 和 `loadPiSettings` 依赖文件系统，但依赖路径明确，可 mock
- `spawn.ts` 的 `execute*` 函数接受所有依赖作为参数（jobs, shellCtx, config），DI 友好
- `validateCwd` 可独立调用测试

**不足**: `executeSync` 和 `executeBackground` 内部直接调用 `spawnCommand`（文件内私有函数），无法在测试中替换。如果要做真正的单元测试（不启动真实进程），需要将 `spawnCommand` 提取为可注入的依赖。但这是测试便利性问题而非健壮性问题，标为 LOW 级别观察。

### 6. 调试友好 — 错误信息是否包含足够上下文

#### ✅ 总体良好

- 错误信息包含具体的 jobId、command、exitCode、duration
- `validateCwd` 错误信息区分了"不存在"和"不是目录"
- kill 返回 kill 之前已收集的输出，方便诊断
- 超时 detach 返回的提示包含 jobId 和后续操作建议

#### ⚠️ 不足

- spawn `error` 事件未被处理（MUST_FIX #2），所以 ENOENT/EACCES 错误信息缺失——这是最大的调试友好性缺陷
- `loadPiSettings` 静默吞掉解析错误（INFO #9），用户不知道 settings 为什么不生效

### 7. 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | spawn.ts:L86-L87 | WriteStream 在 spawn error/异常退出路径下未 destroy，导致文件句柄泄漏和潜在 EPERM 错误 | 在 child exit/error 事件中调用 `writeStream.destroy()` |
| 2 | MUST FIX | spawn.ts:L68-L97 | spawn 的 `error` 事件（ENOENT/EACCES）未被监听，导致 uncaught exception，违反 FR-11 | 添加 `child.on("error", handler)`，reject exitPromise 或设置错误标记 |
| 3 | MUST FIX | spawn.ts:L254-L270 | executeKill 中 `job.child.on("exit")` 在 kill 之后注册，如果进程已经退出（"exit"已触发），listener 永远不 fire，依赖 6s timeout | 改为先检查 `job.child.exitCode !== null`（已做了但条件不够严格），或用 `child.once("exit")` 并在 kill 前注册 |
| 4 | LOW | spawn.ts:L56 | `import * as fs` 出现在函数定义之后，依赖 hoisting，违反 import 顺序规范 | 移到文件顶部 import 区域 |
| 5 | LOW | jobs.ts:L65-L70 | cleanupJobs 中 unlinkSync 在 kill 之前执行，kill 失败时状态不一致 | 先 await kill，再删文件 |
| 6 | LOW | spawn.ts:L150 | NEVER_RESOLVES 永不 resolve 的 Promise 可能被 GC 延迟回收 | 可接受，或改用条件分支避免 |
| 7 | LOW | spawn.ts:L192 | detachJob 中 `.then()` 无 `.catch()`，与 executeBackground 写法不一致 | 添加 `.catch()` handler |
| 8 | INFO | spawn.ts:L113-L114 | onUpdate 每次 data 事件都做 Buffer.concat + toString，高频输出时有 GC 压力 | 节流 onUpdate 调用 |
| 9 | INFO | shell.ts:L58-L62 | loadPiSettings 的 catch 块用 `void e` 吞掉 JSON 解析错误，无任何日志 | 添加 console.error 日志 |
| 10 | INFO | index.ts:L15 | 从 `@earendil-works/pi-tui` 导入，与 CLAUDE.md `@mariozechner/*` 规范不一致 | 改为 `@mariozechner/pi-tui` |

### MUST FIX #3 详细分析

**位置**: `spawn.ts` `executeKill` 函数

```typescript
// 先 kill
await killProcessGroup(job.pid);

// 然后监听 exit
const exitCode = await Promise.race([
  new Promise<number | null>((resolve) => {
    job.child.on("exit", (code) => resolve(code));
    if (job.child.exitCode !== null) resolve(job.child.exitCode);
  }),
  new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
]);
```

**问题**: 
1. `killProcessGroup` 是 async 的，先发 SIGTERM，等 5 秒，可能再发 SIGKILL。在 kill 执行期间或 `await` 返回后，进程可能已经退出了。
2. `job.child.on("exit", ...)` 注册了一个**持续的** listener（不是 `once`）。如果进程已经退出了，`exit` 事件不会再触发，此时 `job.child.exitCode` 检查是唯一的出路。
3. 但 `job.child.exitCode !== null` 的检查有一个微妙问题：`killProcessGroup` 内部的 `process.kill(-pid, "SIGTERM")` 如果成功发送了信号但进程在 `await killProcessGroup` 返回后、`on("exit")` 注册前退出了，`exit` 事件可能在两个 await 点之间触发并被**其他已有的 listener 消费掉**（exitPromise 在 spawnCommand 中注册的 listener），新的 listener 就收不到了。
4. 6 秒 timeout 是兜底，但这意味着正常 kill 路径可能需要等待完整 6 秒才返回结果。

**修复方向**: 
- 在 `killProcessGroup` **之前**注册 `child.once("exit", ...)` listener
- 或者直接用 `exitPromise`（已在 spawnCommand 中创建的）来等待退出，而不是新建一个 listener
- 减少等待 timeout（5s kill + 6s wait = 最坏 11s 太长）

### 结论

**需修改后重审**。3 条 MUST FIX 均为生产环境下的实际风险：
1. WriteStream 泄漏可能导致文件描述符耗尽
2. spawn error 未捕获会导致 Pi 进程 crash
3. kill race condition 导致用户等待 6+ 秒才能看到结果

### Summary

健壮性审查完成，第1轮，3条MUST FIX，需修改后重审。
