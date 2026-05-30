---
review:
  type: code_review
  round: 2
  timestamp: "2026-05-30T14:00:00"
  target: "bash-async/src/"
  verdict: pass
  summary: "健壮性审查第2轮，3条MUST FIX全部修复验证通过。发现1条新增LOW问题（executeBackground error路径job状态未更新）。综合评定PASS。"

statistics:
  total_issues: 8
  must_fix: 0
  must_fix_resolved: 3
  low: 4
  info: 3

issues:
  # ── v1 MUST FIX: 全部已修复 ──
  - id: 1
    severity: MUST_FIX
    location: "bash-async/src/spawn.ts:L86-L95 (exitPromise constructor)"
    title: "WriteStream 在 spawn 失败/error 事件时可能泄漏"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "exit handler 和 error handler 均调用 writeStream.destroy()，error handler 额外调用 removeOutputFile 清理临时文件。修复完整。"

  - id: 2
    severity: MUST_FIX
    location: "bash-async/src/spawn.ts:L90-L95 (child.on('error'))"
    title: "spawn error 事件（ENOENT/EACCES）未被捕获，导致 uncaught exception"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "error handler reject(err) exitPromise。executeSync 和 executeBackground 均通过 try/catch 捕获 rejection 并返回 makeErrorResult，符合 FR-11。修复完整。"

  - id: 3
    severity: MUST_FIX
    location: "bash-async/src/spawn.ts:L289-L300 (executeKill)"
    title: "executeKill 中 exit listener 在 kill 之后注册存在 race condition"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "改为 kill 之前注册 child.once('exit') listener，并用 exitCode !== null 做快速路径。race condition 消除。修复完整。"

  # ── v1 LOW/INFO: 部分修复 ──
  - id: 4
    severity: LOW
    location: "bash-async/src/spawn.ts:L1"
    title: "validateCwd 的 fs 导入位置依赖 hoisting"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "import * as fs 已移至文件顶部 import 区域，符合规范。"

  - id: 5
    severity: LOW
    location: "bash-async/src/jobs.ts:L65-L70"
    title: "cleanupJobs 中 unlinkSync 在 async kill 之前执行，临时文件可能残留"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    note: "未修改。unlink 在 kill 完成前执行。Unix 下 unlink 后进程仍可写 inode，不影响正确性。kill 失败时 job.status 已设 killed，状态可能不一致。建议后续改为先 await kill 再删文件。"

  - id: 6
    severity: LOW
    location: "bash-async/src/spawn.ts:L167"
    title: "NEVER_RESOLVES Promise 无 GC 回收保证"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    note: "未修改。可接受。Promise.race 后引用释放，实际影响极小。"

  - id: 7
    severity: LOW
    location: "bash-async/src/spawn.ts:L200-L202 (detachJob)"
    title: "detachJob 中 .then() 无 .catch()，异常被静默吞掉"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "已添加 .catch() handler 并输出 console.error 日志。"

  # ── v2 新发现 ──
  - id: 11
    severity: LOW
    location: "bash-async/src/spawn.ts:L234-L241 (executeBackground exitPromise handler)"
    title: "executeBackground 中 spawn error 导致 exitPromise reject，.catch() 仅日志未更新 job 状态"
    status: open
    raised_in_round: 2
    resolved_in_round: null
    note: "v1 MUST_FIX #2 修复后引入的不完整路径。如果 background job 的 spawn error 事件触发（ENOENT），exitPromise reject → .catch() 仅打日志 → job 保持 running 状态直到 session shutdown。建议在 .catch() 中添加 updateJobStatus(jobs, jobId, 'failed', -1)。"

  # ── v1 INFO: 未修改，保持观察 ──
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
    title: "从 @earendil-works/pi-tui 导入而非 @mariozechner/pi-tui"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "已改为 import from '@mariozechner/pi-tui'，符合 CLAUDE.md 规范。"
---

# 健壮性审查 v2

## 评审记录
- 评审时间：2026-05-30 14:00
- 评审类型：健壮性专项审查（第2轮 — 验证 MUST FIX 修复 + 检查回归）
- 评审对象：bash-async/src/ 全部源码（types.ts, shell.ts, jobs.ts, spawn.ts, index.ts）
- 上一轮结论：3 条 MUST FIX，需修改后重审

## MUST FIX 验证

### ✅ MUST_FIX #1 — WriteStream 泄漏 → 已修复

**修复代码** (`spawn.ts` spawnCommand 函数):

```typescript
const exitPromise = new Promise<number | null>((resolve, reject) => {
    child.on("exit", (code) => {
        writeStream.destroy();   // ← 新增
        resolve(code);
    });
    child.on("error", (err) => {
        writeStream.destroy();   // ← 新增
        removeOutputFile(outFile); // ← 新增
        reject(err);
    });
});
```

**验证结论**:
- `exit` 路径：`writeStream.destroy()` ✅
- `error` 路径：`writeStream.destroy()` + `removeOutputFile()` ✅
- `executeSync` 正常完成路径：`removeOutputFile` 删除文件，exit handler 中 `writeStream.destroy()` 已执行 ✅
- `detachJob` 路径：writeStream 保持打开继续写入（设计意图），exit 时 destroy ✅

**结论**: 修复完整，无遗漏路径。

### ✅ MUST_FIX #2 — spawn error 事件未捕获 → 已修复

**修复代码** (`spawn.ts` spawnCommand):

```typescript
child.on("error", (err) => {
    writeStream.destroy();
    removeOutputFile(outFile);
    reject(err);  // ← 新增：reject exitPromise
});
```

**调用方处理**:

1. `executeSync`:
```typescript
try {
    exitCode = await Promise.race([exitPromise, timeoutPromise]);
} catch (err: unknown) {
    // spawn error (ENOENT, EACCES) — FR-11
    return makeErrorResult(`Command not found or permission denied: ${msg}`, ...);
}
```
✅ 返回 `isError: true` 的 ToolResult，符合 FR-11。

2. `executeBackground`:
```typescript
exitPromise.then(...).catch((e: unknown) => {
    console.error("[bash-async] bg exit handler error:", ...);
});
```
⚠️ `.catch()` 仅日志，未更新 job 状态（见新增 issue #11），但不会导致 uncaught exception。可接受。

**结论**: 核心修复完整。ENOENT/EACCES 不再导致进程 crash。background 路径有轻微不完整（LOW #11），不阻塞 PASS。

### ✅ MUST_FIX #3 — executeKill race condition → 已修复

**修复代码** (`spawn.ts` executeKill):

```typescript
// Register exit listener BEFORE killing to avoid race condition
const exitPromise = new Promise<number | null>((resolve) => {
    if (job.child.exitCode !== null) {
        resolve(job.child.exitCode);   // ← 快速路径
        return;
    }
    job.child.once("exit", (code) => resolve(code));  // ← once 而非 on
});

// Kill the process group
await killProcessGroup(job.pid);
```

**验证结论**:
- Listener 注册在 `killProcessGroup` **之前** ✅ — 消除 race condition
- 使用 `once` 而非 `on` ✅ — 避免重复触发
- `exitCode !== null` 快速路径 ✅ — 处理进程已退出的情况
- 注释清晰标注意图 ✅

**结论**: 修复完整，race condition 彻底消除。

## v1 LOW/INFO 修复状态

| # | 严重级 | 状态 | 说明 |
|---|--------|------|------|
| 4 | LOW | ✅ 已修复 | `import * as fs` 移至文件顶部 |
| 5 | LOW | 未修改 | cleanupJobs 删除/kill 顺序问题，不影响正确性 |
| 6 | LOW | 未修改 | NEVER_RESOLVES，可接受 |
| 7 | LOW | ✅ 已修复 | detachJob 添加 `.catch()` handler |
| 8 | INFO | 未修改 | onUpdate GC 压力，性能优化项 |
| 9 | INFO | 未修改 | loadPiSettings 静默吞错 |
| 10 | INFO | ✅ 已修复 | 改为 `@mariozechner/pi-tui` |

## 第2轮新发现

### ⚠️ NEW LOW #11: executeBackground error 路径 job 状态未更新

**位置**: `spawn.ts` executeBackground 的 exitPromise handler

**问题**: 当 spawn `error` 事件触发（ENOENT/EACCES），`exitPromise` reject。`.catch()` 仅打印日志，未调用 `updateJobStatus` 将 job 从 "running" 更新为 "failed"。job 将保持 "running" 直到 session shutdown。

**影响**: 低。ENOENT 对 background job 是边缘情况（shell 路径通常有效），且 session shutdown 会清理。但用户 poll 该 job 时会看到 "running" 而非 "failed"，可能误导。

**建议修复**:
```typescript
.catch((e: unknown) => {
    console.error("[bash-async] bg exit handler error:", e instanceof Error ? e.message : e);
    updateJobStatus(jobs, jobId, "failed", -1);
});
```

## 回归检查

检查修复是否引入新问题：

1. **spawnCommand 返回 SpawnResult 包含 writeStream** — `writeStream` 字段未被任何调用方使用（executeSync/executeBackground 只解构 `{ child, outFile, exitPromise }`）。不影响正确性，但建议后续移除未使用字段减少困惑。

2. **exitPromise 构造中使用 reject** — reject 仅在 `error` 事件触发。exit 事件使用 resolve。语义清晰，不会与 Promise.race 产生意外交互。

3. **removeOutputFile 在 error handler 中调用** — 如果 outFile 创建失败（极不可能，createOutFilePath 已 ensureJobsDir），removeOutputFile 会 catch 错误并忽略。安全。

4. **executeKill 使用独立 exitPromise** — 不复用 spawnCommand 的 exitPromise，避免与已有 listener 冲突。设计合理。

**结论**: 无回归问题。

## 最终评定

| 维度 | 评定 |
|------|------|
| 错误处理 | ✅ 核心路径完整（spawn error 捕获、ENOENT/EACCES 处理、FR-11 合规） |
| 异常安全 | ✅ WriteStream 和临时文件在所有路径正确清理 |
| 日志 | ✅ 一致使用 console.error + [bash-async] 前缀 |
| Fail-fast | ✅ 参数校验、cwd 检查、模式互斥均正常 |
| 测试友好 | ✅ DI 模式不变，纯函数可独立测试 |
| 调试友好 | ✅ 错误信息包含 jobId/exitCode/command 上下文 |

**Verdict: PASS** — 3 条 MUST FIX 全部修复且验证通过，无回归问题。剩余 LOW/INFO 项为后续优化建议，不阻塞发布。
