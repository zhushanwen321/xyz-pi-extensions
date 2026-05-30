---
review:
  type: code_review
  round: 2
  timestamp: "2026-05-30T19:30:00"
  target: "bash-async/src/"
  verdict: fail
  summary: "v1 MUST FIX 已修复，但修复引入新的 MUST FIX 级别回归（removeAllListeners 破坏 pipe 导致输出文件停止写入）。另有1条 LOW 未完全修复。"

statistics:
  total_issues: 4
  must_fix: 1
  low: 1
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "bash-async/src/spawn.ts:executeBackground() L157-158, detachJob() L139-140"
    title: "removeAllListeners('data') 破坏 pipe → 输出文件停止写入，poll 返回空/不完整结果"
    status: open
    raised_in_round: 2
    resolved_in_round: null
    note: "v1 Issue #2 的修复引入的回归"
  - id: 3
    severity: LOW
    location: "bash-async/src/spawn.ts:executeBackground() L168-174 + executeKill() L254"
    title: "kill background job 时 injectBackgroundResult 仍被触发——race condition 未真正修复"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    note: "v2 尝试修复但检查逻辑有误，详见下方分析"
  - id: 6
    severity: INFO
    location: "bash-async/src/spawn.ts:spawnCommand() L78"
    title: "outFile 使用独立随机 ID 命名，与 jobId 不一致（不影响功能，仅影响调试）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: INFO
    location: "bash-async/src/spawn.ts:spawnCommand()"
    title: "每次 sync 命令都创建临时文件，即使无超时（短暂的 I/O 浪费）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

resolved_issues:
  - id: v1-1
    severity: MUST_FIX
    location: "bash-async/src/spawn.ts:spawnCommand()"
    title: "ChildProcess 'error' 事件未监听"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    fix_verification: "exitPromise 改为同时监听 exit 和 error 事件，error 时 reject 并清理 writeStream + outFile。executeSync 和 executeBackground 均有 try-catch 处理 reject，返回 isError result。AC-12 (spawn 失败) 现已覆盖。"
  - id: v1-2
    severity: LOW
    location: "bash-async/src/spawn.ts:executeBackground() / detachJob()"
    title: "chunks 数组内存泄漏"
    status: regression
    raised_in_round: 1
    resolved_in_round: 2
    regression_note: "修复方式引入新的 MUST FIX 回归，见 Issue #1"
  - id: v1-4
    severity: LOW
    location: "bash-async/src/spawn.ts:executeSync()"
    title: "AbortSignal 终止时消息不匹配 spec"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    fix_verification: "Promise.race 后检查 signal?.aborted，为 true 时 throw new Error('Command aborted')。AC-5 现已覆盖。"
  - id: v1-5
    severity: LOW
    location: "bash-async/src/spawn.ts:spawnCommand()"
    title: "stdio[0] 使用 'pipe' 而非 spec 要求的 'ignore'"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    fix_verification: "stdio 已改为 ['ignore', 'pipe', 'pipe']，与 spec FR-1 一致。"
  - id: v1-8
    severity: INFO
    location: "bash-async/src/index.ts:session_shutdown"
    title: "cleanupJobs 使用动态 import 风格不一致"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    fix_verification: "已改为顶部静态 import { createJobMap, loadConfig, cleanupJobs } from './jobs.js'。"
---

# Business Logic Review v2

## 评审记录
- 评审时间：2026-05-30 19:30
- 评审类型：编码评审（业务逻辑正确性专项）——第2轮重审
- 评审对象：bash-async/src/ 全部源代码（修复后版本）
- 对照文档：business_logic_review_v1.md

---

## v1 MUST FIX 验证

### Issue v1-#1: ChildProcess 'error' 事件未监听 → ✅ 已修复

**修复代码** (`spawn.ts:spawnCommand()`):
```typescript
const exitPromise = new Promise<number | null>((resolve, reject) => {
    child.on("exit", (code) => {
        writeStream.destroy();
        resolve(code);
    });
    child.on("error", (err) => {
        writeStream.destroy();
        removeOutputFile(outFile);
        reject(err);
    });
});
```

**验证路径：**
1. `spawn("nonexistent_shell", ...)` → spawn 失败 → ChildProcess 触发 'error' 事件
2. exitPromise reject(err) ✅
3. writeStream.destroy() + removeOutputFile() 清理资源 ✅
4. executeSync 中 `try { await Promise.race(...) } catch` 捕获 reject → 返回 `makeErrorResult("Command not found or permission denied: ...")` ✅
5. executeBackground 中 `try { spawnCommand(...) } catch` 捕获同步异常 → 返回 `makeErrorResult("Failed to spawn command: ...")` ✅
6. background 模式异步 reject 也有 `.catch()` 处理 ✅

**AC-12 覆盖状态：** ✅ 已覆盖（ENOENT/EACCES 均返回 isError result）

**结论：v1 Issue #1 已正确修复。**

---

## v1 LOW/INFO 修复验证

### Issue v1-#2 (chunks 内存泄漏) → ❌ 修复引入回归（详见 Issue #1 下方）

### Issue v1-#3 (kill + FAILED followUp) → ❌ 未正确修复（详见 Issue #3 下方）

### Issue v1-#4 (AbortSignal 消息) → ✅ 已修复
- `executeSync` 中 `Promise.race` 之后添加 `if (signal?.aborted) { throw new Error("Command aborted"); }` 
- AC-5 现已正确覆盖

### Issue v1-#5 (stdio[0]) → ✅ 已修复
- `stdio: ["ignore", "pipe", "pipe"]` — 与 spec FR-1 一致

### Issue v1-#8 (dynamic import) → ✅ 已修复
- `cleanupJobs` 已在顶部静态 import

---

## 新发现问题

### Issue #1 (MUST FIX): `removeAllListeners("data")` 破坏 pipe，导致输出文件停止写入

**位置：** `spawn.ts:executeBackground()` L157-158, `spawn.ts:detachJob()` L139-140

**代码：**
```typescript
// executeBackground — 注册 Job 后
child.stdout?.removeAllListeners("data");
child.stderr?.removeAllListeners("data");

// detachJob — 注册 Job 后
child.stdout?.removeAllListeners("data");
child.stderr?.removeAllListeners("data");
```

**问题分析：**

在 `spawnCommand` 中，stdout/stderr 注册了两类 data 监听器：
1. `child.stdout?.pipe(writeStream)` — pipe 内部通过 `on("data", ...)` 将数据写入文件
2. `child.stdout?.on("data", capture)` — 将数据捕获到内存 chunks 数组

`removeAllListeners("data")` 移除**所有** data 事件监听器，包括 pipe 内部注册的那个。后果：

- WriteStream 不再收到数据 → 输出文件停止增长
- background job 长时间运行后，poll 读取的 outFile 只有前几毫秒的输出
- sync-detach 后，poll 同样只能读到极少量输出
- 核心功能（文件输出捕获）被破坏

**执行路径模拟：**

```
UC-2 (Background → poll):
  1. spawnCommand → pipe(writeStream) + on("data", capture) 注册
  2. executeBackground → registerJob
  3. removeAllListeners("data") → pipe 断开 + capture 移除
  4. 进程继续运行，stdout/stderr 数据丢失
  5. poll → readOutputFile → 仅含步骤 2-3 间的少量数据
  6. ❌ 用户看到的输出严重不完整

UC-1 (Sync → timeout detach → poll):
  1-4. 正常 sync 执行 120s
  5. timeout → detachJob → removeAllListeners("data")
  6. ❌ 之后进程继续运行但输出不再写入文件
  7. poll 返回不完整输出
```

**等级判定：** MUST FIX
- 等级判定规则第 2 条（功能失效）：background 和 sync-detach 的核心功能——输出文件捕获——完全失效
- 等级判定规则第 3 条（数据丢失）：进程输出被丢弃
- 影响范围：所有 background job + 所有 sync-detach 场景

**修复方向：**
只移除 `capture` 监听器，保留 pipe 监听器。方案：
1. 从 `spawnCommand` 返回 capture 函数引用，调用方用 `child.stdout?.removeListener("data", capture)` 精确移除
2. 或将 `SpawnResult` 扩展为包含 `capture` 引用：
```typescript
interface SpawnResult {
    child: child_process.ChildProcess;
    outFile: string;
    writeStream: fs.WriteStream;
    exitPromise: Promise<number | null>;
    stopCapture: () => void;  // 新增
}
```
在 `spawnCommand` 中：
```typescript
const stopCapture = (): void => {
    child.stdout?.removeListener("data", capture);
    child.stderr?.removeListener("data", capture);
};
return { child, outFile, writeStream, exitPromise, stopCapture };
```
在 `executeBackground` / `detachJob` 中调用 `spawnResult.stopCapture()` 代替 `removeAllListeners("data")`。

---

### Issue #3 (LOW): kill background job 时 race condition 仍存在

**位置：** `spawn.ts:executeBackground()` L168-174 + `spawn.ts:executeKill()` L247-254

**v2 修复尝试：**
```typescript
// executeBackground 的 exit handler
exitPromise.then((code) => {
    updateJobStatus(jobs, jobId, code === 0 ? "done" : "failed", code ?? undefined);
    const currentJob = findJob(jobs, jobId);
    if (currentJob && currentJob.status !== "killed") {
        injectBackgroundResult(pi, job, code, outFile);
    }
})
```

**问题：** `updateJobStatus` 在第 2 行已经将 status 设为 "done" 或 "failed"，然后第 4 行检查 `status !== "killed"` — 此时 status 已经不是 "killed" 了（刚被设为 "done"/"failed"），所以检查**永远为 true**。

**Race condition 时序：**
```
T0: executeKill 调用 killProcessGroup(job.pid)
T1: 进程退出 → child "exit" 事件触发
T2: background 的 exitPromise.then() 作为 microtask 执行:
    → updateJobStatus(jobs, jobId, "done")     ← 设为 "done"
    → findJob → status = "done" ≠ "killed"     ← 检查通过
    → injectBackgroundResult()                  ← ❌ 发送多余的 FAILED followUp
T3: executeKill 的 Promise.race 返回
T4: updateJobStatus(jobs, jobId, "killed")      ← 太晚了
```

**等级维持 LOW：** 功能不受影响（进程被正确杀死），仅产生多余的通知消息。但语义矛盾可能困惑用户。

**修复方向：** 在 `executeKill` 中，将 status 设为 "killed" **提前到 killProcessGroup 之前**：
```typescript
// executeKill 中：
updateJobStatus(jobs, jobId, "killed");  // 先标记
await killProcessGroup(job.pid);         // 再杀
// background handler 检查时 status 已经是 "killed" → 跳过 injectBackgroundResult
```

---

## AC 覆盖矩阵（更新）

| AC | 场景 | v1 状态 | v2 状态 | 说明 |
|----|------|---------|---------|------|
| AC-1 | Sync 正常命令 | ✅ | ✅ | 不变 |
| AC-2 | Sync 超时 detach | ✅ | ⚠️ | detach 后 outFile 停止写入（Issue #1） |
| AC-3 | Sync 显式 timeout | ✅ | ✅ | 不变 |
| AC-4 | Sync 无超时 | ✅ | ✅ | 不变 |
| AC-5 | Sync AbortSignal | ⚠️ | ✅ | 已修复（"Command aborted"） |
| AC-6 | Background 模式 | ✅ | ⚠️ | outFile 停止写入（Issue #1） |
| AC-7 | Poll 查询 | ✅ | ⚠️ | 读到的 outFile 不完整（Issue #1） |
| AC-8 | Kill 终止 | ✅ | ✅ | 功能正确，有多余通知（Issue #3） |
| AC-9 | Job 不存在 | ✅ | ✅ | 不变 |
| AC-10 | Session 隔离 | ✅ | ✅ | 不变 |
| AC-11 | 配置文件 | ✅ | ✅ | 不变 |
| AC-12 | Spawn 失败 | ❌ | ✅ | 已修复（error 事件监听 + reject） |
| AC-13 | 非零退出码 | ✅ | ✅ | 不变 |
| AC-14 | 输出截断 | ✅ | ✅ | 不变 |
| AC-15 | 并发限制 | ✅ | ✅ | 不变 |
| AC-16 | Cwd 不存在 | ✅ | ✅ | 不变 |
| AC-17 | Shell 兼容性 | ✅ | ✅ | 不变 |

---

## 逐 UC 执行路径复验

### UC-2: Background → auto-inject result（受影响）

```
1. command: "npm test", background: true → executeBackground() ✅
2. validateCwd() ✅
3. runningJobCount < max ✅
4. spawnCommand() → pipe(writeStream) + on("data", capture) ✅
5. registerJob(jobs, job) ✅
6. child.stdout?.removeAllListeners("data")  ← ❌ pipe 断开
7. exitPromise.then() → 进程退出 → readOutputFile(outFile) → 文件仅含步骤 4-6 间的数据
8. injectBackgroundResult() → 发送几乎为空的输出给 agent
```

**结论：UC-2 因 Issue #1 回归而功能异常。**

### UC-1: Sync → 超时 detach → poll（受影响）

```
1-4. 正常 sync 执行 ✅
5. 120s 后 timeout → detachJob()
6. child.stdout?.removeAllListeners("data")  ← ❌ pipe 断开
7. 进程继续运行，但 outFile 不再增长
8. poll → readOutputFile → 不完整输出
```

**结论：UC-1 detach 后 poll 功能异常。**

### UC-3: Background → poll（受影响）

同 UC-2，poll 读到不完整输出。

### UC-4: Background → kill（功能正确，通知异常）

```
1-2. Background 启动 → removeAllListeners("data") ← pipe 断开
3. kill → 进程退出
4. background exit handler: updateJobStatus("done") → status ≠ "killed" → injectBackgroundResult() ← 多余通知
5. executeKill: updateJobStatus("killed") ← 覆写
```

**结论：UC-4 kill 功能正确，但收到多余 FAILED followUp。**

### UC-5: Sync → detach → kill

```
1. Sync → 120s → detach → removeAllListeners("data") ← pipe 断开
2. kill → 进程终止 → 读 outFile（不完整）
3. 返回 kill 前的不完整输出
```

**结论：UC-5 输出不完整。**

---

## 问题汇总

| # | 优先级 | 来源 | 文件/位置 | 描述 |
|---|--------|------|----------|------|
| 1 | MUST FIX | v2 新发现 | spawn.ts:executeBackground() + detachJob() | `removeAllListeners("data")` 移除了 pipe 的 data 监听器，导致 WriteStream 不再接收数据，outFile 停止增长。background 和 sync-detach 模式的核心输出捕获功能失效。 |
| 3 | LOW | v1 未完全修复 | spawn.ts:executeBackground() + executeKill() | kill background job 时 injectBackgroundResult 仍被触发。v2 的 status 检查逻辑有误：updateJobStatus 先设 "done"/"failed" 后检查 ≠ "killed"，检查永远通过。 |
| 6 | INFO | v1 沿用 | spawn.ts:spawnCommand() | outFile ID 与 jobId 不一致（可接受） |
| 7 | INFO | v1 沿用 | spawn.ts:spawnCommand() | 每次 sync 都创建临时文件（可接受） |

---

## 结论

**verdict: fail**

v1 的 MUST FIX（ChildProcess error 事件未监听）已正确修复，同时修复了 v1 的 Issue #4 (AbortSignal 消息)、#5 (stdio)、#8 (import 风格)。

但 Issue #2（chunks 内存泄漏）的修复方式引入了 MUST FIX 级别的回归：`removeAllListeners("data")` 同时移除了 pipe 监听器，破坏了输出文件写入——这是 background 和 sync-detach 模式的核心功能。Issue #3（kill 时的多余通知）的修复尝试存在逻辑错误，race condition 仍未解决。

**需要修复 Issue #1（removeAllListeners 破坏 pipe）后方可通过。**
