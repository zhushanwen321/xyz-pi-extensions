---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-30T18:00:00"
  target: "bash-async/src/"
  verdict: fail
  summary: "业务逻辑审查完成，第1轮，1条MUST FIX（spawn error事件未处理可导致Pi进程崩溃），需修复后重审"

statistics:
  total_issues: 8
  must_fix: 1
  low: 4
  info: 3

issues:
  - id: 1
    severity: MUST_FIX
    location: "bash-async/src/spawn.ts:spawnCommand"
    title: "ChildProcess 'error' 事件未监听，spawn 失败可导致 Pi 进程崩溃或工具永久挂起"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "bash-async/src/spawn.ts:executeBackground"
    title: "background/sync-detach 模式 chunks 数组内存泄漏——进程输出持续在内存中累积"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "bash-async/src/spawn.ts:executeKill + executeBackground"
    title: "kill background job 时 injectBackgroundResult 仍会发送 'FAILED' followUp 消息"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "bash-async/src/spawn.ts:executeSync"
    title: "AbortSignal 终止时抛出 'Command exited with code null' 而非 spec 要求的 'Command aborted'"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "bash-async/src/spawn.ts:spawnCommand"
    title: "stdio[0] 使用 'pipe' 而非 spec 要求的 'ignore'，可能导致读 stdin 的命令挂起"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: INFO
    location: "bash-async/src/spawn.ts:spawnCommand"
    title: "outFile 使用独立的随机 ID 命名，与 jobId 不一致（不影响功能，仅影响调试）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: INFO
    location: "bash-async/src/spawn.ts:executeSync"
    title: "每次 sync 命令都创建临时文件，即使无超时（短暂的 I/O 浪费）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: INFO
    location: "bash-async/src/index.ts:session_shutdown"
    title: "cleanupJobs 使用动态 import 而非静态 import（风格不一致）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Business Logic Review v1

## 评审记录
- 评审时间：2026-05-30 18:00
- 评审类型：编码评审（业务逻辑正确性专项）
- 评审对象：bash-async/src/ 全部源代码

---

## 逐 UC 执行路径模拟

### UC-1: Long Compilation（Sync → 超时 detach → poll）

**执行路径：**
1. `command: "cargo build --release"` → 无 `background/pollJobId/killJobId` → 路由至 `executeSync()` ✅
2. `validateCwd(process.cwd())` → cwd 存在 ✅
3. `effectiveTimeout = undefined ?? 120 = 120` → 120s 超时 ✅
4. `spawnCommand()` → 创建 child、WriteStream 和 exitPromise ✅
5. `Promise.race([exitPromise, timeoutPromise])` → 120s 后 timeout 胜出 ✅
6. `detachJob()` → 生成 jobId，创建 Job 注册到 jobs Map ✅
7. `exitPromise.then()` 设置进程退出时更新状态 ✅
8. 返回部分输出 + jobId + 提示信息 ✅
9. Agent 调用 `pollJobId: jobId` → `executePoll()` → `findJob()` → 读 outFile → 返回状态 ✅
10. 进程结束后 poll 返回 `status: "done"` + exitCode ✅

**结论：UC-1 正确。**

---

### UC-2: Test Suite Execution（Background → auto-inject result）

**执行路径：**
1. `command: "npm test", background: true` → 路由至 `executeBackground()` ✅
2. `validateCwd()` ✅
3. `runningJobCount(jobs) < maxBackgroundJobs` 检查 ✅
4. `spawnCommand()` → 创建 child + WriteStream + exitPromise ✅
5. 创建 Job 注册到 Map ✅
6. `exitPromise.then()` → 退出时 `updateJobStatus()` + `injectBackgroundResult()` ✅
7. 立即返回 jobId ✅
8. 进程完成后 `injectBackgroundResult()` → `readOutputFile()` → `truncateTail()` → `pi.sendMessage()` ✅
9. sendMessage 包裹 try-catch，session shutdown 时静默忽略错误 ✅

**发现的问题：**
- `chunks` 数组在 `executeBackground` 中创建，由 `spawnCommand` 的 `capture` 回调持续填充，但 `executeBackground` 返回后 `chunks` 从未被读取（输出通过 outFile 读取）。内存中持续累积进程全部输出直到进程退出。— **Issue #2 (LOW)**
- `injectBackgroundResult` 的 customType 是 `"bash-async-background-result"` 而非 spec 示例中的 `"bash-async-result"`，但 spec 仅作示例用途，实际命名不影响功能。

**结论：UC-2 基本正确，有内存浪费问题。**

---

### UC-3: Deployment Script Monitoring（Background → poll）

**执行路径：**
1. `command: "./deploy.sh", background: true` → `executeBackground()` ✅
2. 返回 jobId ✅
3. `pollJobId: jobId` → `executePoll()` → `findJob()` → `readOutputFile()` ✅
4. `truncateTail()` 截断输出 ✅
5. 返回 status + output + duration + exitCode ✅

**结论：UC-3 正确。**

---

### UC-4: Development Server Management（Background → kill → session cleanup）

**执行路径：**
1. `command: "npm run dev", background: true` → `executeBackground()` ✅
2. 返回 jobId，server 持续运行 ✅
3. `killJobId: jobId` → `executeKill()` ✅
4. `findJob()` → `job.status === "running"` → 调用 `killProcessGroup(job.pid)` ✅
5. SIGTERM → 5s 等待 → SIGKILL（如仍存活） ✅
6. 等待 child exit 事件（6s 超时兜底） ✅
7. `updateJobStatus(jobs, jobId, "killed")` ✅
8. 读取 outFile → 返回 kill 前输出 ✅
9. `session_shutdown` → `cleanupJobs()` → kill 所有 running job + 删除 outFile ✅

**发现的问题：**
- `killProcessGroup` 返回时（进程已退出），background 的 `exitPromise.then()` 会先于 `executeKill` 的后续代码执行（microtask 调度）。此时 `injectBackgroundResult` 被调用，发送 "❌ FAILED" followUp 消息。随后 `executeKill` 将状态覆写为 "killed"。用户会同时看到 kill 结果和一条多余的 "FAILED" followUp。— **Issue #3 (LOW)**

**结论：UC-4 功能正确，有多余通知问题。**

---

### UC-5: Stuck Command Recovery（Sync → 超时 detach → kill）

**执行路径：**
1. Sync 模式执行 → 120s 无输出 → `detachJob()` 返回 jobId ✅
2. `killJobId: jobId` → `executeKill()` ✅
3. `killProcessGroup()` 终止进程 ✅
4. 返回 kill 前的输出 ✅

**发现的问题：**
- sync-detach 模式下，`chunks` 数组在 detach 后仍由 child 的 data 事件持续填充（与 background 模式相同的内存泄漏）。— **Issue #2 (LOW)**

**结论：UC-5 正确。**

---

### UC-6: Spawn Failure Diagnosis（command not found）

**执行路径（command-not-found via shell）：**
1. `command: "nonexistent_tool --flag"` → sync 模式 → `executeSync()` ✅
2. `spawnCommand()` → `child_process.spawn("/bin/bash", ["-c", "nonexistent_tool --flag"])` 
3. bash 成功启动，尝试执行 `nonexistent_tool` → bash 输出 "command not found" → exit code 127
4. exitPromise resolve(127) ✅
5. `executeSync`：exitCode !== 0 → throw Error("Command exited with code 127\n...") ✅

**执行路径（shell 本身不存在）：**
1. 如 `getShellConfig` 返回不存在的 shell 路径（如用户配置了错误的 `shellPath`）
2. `spawnCommand()` → `child_process.spawn("nonexistent_shell", ...)` 
3. spawn **无法启动** → ChildProcess 触发 `'error'` 事件（ENOENT）
4. **代码中未注册 `'error'` 事件监听器** → Node.js EventEmitter 抛出 unhandled error
5. **后果 1**：如果 Pi 没有 uncaughtException 处理器 → **Pi 进程崩溃**
6. **后果 2**：即使 Pi 捕获了异常，`exitPromise` 只监听 `'exit'` 事件，而 Node.js 文档明确说 `'exit'` 在 spawn 失败时**不一定触发** → **工具永久挂起**（尤其在 `defaultTimeout: 0` 时 timeoutPromise 永不 resolve）

**这是 MUST_FIX 级别问题：**
- Spec FR-11 明确要求处理 spawn 失败（ENOENT/EACCES），但代码完全未实现
- 可导致 Pi 进程崩溃或工具永久挂起
- 违反等级判定规则第 2 条（功能失效：某段代码因注册/调用问题从未被执行）

**修复方向：** 在 `spawnCommand` 中添加 `child.on("error", reject)` 并将 exitPromise 改为同时监听 exit 和 error 事件，或用单独的 error handling path 返回 isError result。— **Issue #1 (MUST_FIX)**

---

## 逐维度审查

### 1. Sync 模式：超时 detach

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 超时 detach 不 kill 进程 | ✅ | `detachJob()` 仅注册 Job，不发送信号 |
| 进程保持运行 | ✅ | child 进程继续执行，WriteStream 继续写入 outFile |
| 返回 jobId + 提示 | ✅ | 包含 pollJobId/killJobId 提示文本 |
| 进程退出后状态更新 | ✅ | `exitPromise.then()` 更新 status 和 exitCode |
| 无超时时永不 detach | ✅ | `NEVER_RESOLVES` + `effectiveTimeout > 0` 条件 |
| AbortSignal 终止进程 | ⚠️ | killProcessGroup 正确终止，但消息不匹配 spec（Issue #4） |
| 非零退出码 throw Error | ✅ | `exitCode !== 0` 时 throw |
| 正常完成删除临时文件 | ✅ | `removeOutputFile(outFile)` |

### 2. Background 模式：job 注册与结果注入

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 立即返回 jobId | ✅ | spawn 后直接返回 |
| 输出写入临时文件 | ✅ | WriteStream 从 spawn 时开始写入 |
| 进程完成后 sendMessage | ✅ | exitPromise.then() → injectBackgroundResult() |
| sendMessage try-catch | ✅ | 错误静默忽略（参考 subagent 扩展模式） |
| 并发限制检查 | ✅ | `runningJobCount >= maxBackgroundJobs` → error |
| chunks 内存泄漏 | ⚠️ | Issue #2 — chunks 持续累积但从不读取 |
| kill 时多余通知 | ⚠️ | Issue #3 — injectBackgroundResult 仍被触发 |

### 3. Poll 模式：读取输出文件

| 检查项 | 状态 | 说明 |
|--------|------|------|
| jobId 不存在返回错误 | ✅ | `findJob() → undefined → isError` |
| 读取 outFile | ✅ | `readOutputFile()` 包含 try-catch |
| truncateTail 截断 | ✅ | 使用 Pi 导出函数 |
| 返回 status/exitCode/duration | ✅ | header 构建正确 |
| 运行中读取不完整输出 | ✅ | readFileSync 读取当前已写入部分 |

### 4. Kill 模式：进程组杀死

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 进程组 kill（-pid） | ✅ | Unix: `process.kill(-pid)`, Windows: `taskkill /F /T /PID` |
| SIGTERM → 5s → SIGKILL | ✅ | `killProcessGroup` 实现正确 |
| ESRCH 静默处理 | ✅ | 进程已死不报错 |
| 等待 child exit | ✅ | 6s 超时兜底 |
| 更新 status 为 killed | ✅ | `updateJobStatus()` |
| 已完成 job 返回已有输出 | ✅ | `job.status !== "running"` 分支 |
| jobId 不存在返回错误 | ✅ | `findJob() → undefined → isError` |

### 5. Session 隔离

| 检查项 | 状态 | 说明 |
|--------|------|------|
| session_start 创建 job Map | ✅ | `jobs = createJobMap()` 在闭包内 |
| pi 引用闭包捕获 | ✅ | `pi` 在工厂函数闭包中 |
| session_shutdown 清理 | ✅ | `cleanupJobs()` kill 所有 + 删文件 |
| 多 session 共享 jobs 变量 | ⚠️ | 与 todo 扩展相同的已知限制——let 变量在工厂函数闭包内，多 session 时会互相覆盖。当前单 session 使用无问题，但多 session 场景下 session A 的 jobs 会被 session B 覆盖 |

### 6. 并发限制

| 检查项 | 状态 | 说明 |
|--------|------|------|
| maxBackgroundJobs 检查 | ✅ | `runningJobCount(jobs) >= config.maxBackgroundJobs` |
| 仅限 background 模式 | ✅ | 只在 `executeBackground` 中检查 |
| sync-detach 不受限制 | ✅ | `detachJob` 不检查限制（合理——sync 意外超时不应被拒绝） |

### 7. 错误处理

| 检查项 | 状态 | 说明 |
|--------|------|------|
| cwd 不存在 | ✅ | `validateCwd()` → throw Error |
| spawn 失败（ENOENT/EACCES） | ❌ | **Issue #1** — ChildProcess 'error' 事件未监听 |
| 配置文件缺失 | ✅ | `loadConfig()` catch → 返回默认值 |
| 配置 JSON 非法 | ✅ | catch → 返回默认值 |
| sendMessage 失败 | ✅ | try-catch → console.error |

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | spawn.ts:`spawnCommand()` L84-95 | ChildProcess `'error'` 事件未监听。当 spawn 失败（shell 不存在 ENOENT、权限不足 EACCES）时：(1) 未处理的 'error' 事件导致 Node.js 抛出 uncaught exception，可能使 Pi 进程崩溃；(2) `exitPromise` 只监听 'exit'，而 Node.js 文档明确 spawn 失败时 exit 不一定触发，导致 `Promise.race` 在无超时配置时永久挂起。FR-11（spawn 失败处理）完全未实现。 | 将 exitPromise 改为同时监听 'exit' 和 'error'：`child.on("exit", resolve); child.on("error", (err) => resolve(err));` 或使用 reject/resolve 分离处理。在 executeSync/executeBackground 中识别 spawn 错误并返回 `isError: true` + 诊断信息。 |
| 2 | LOW | spawn.ts:`executeBackground()` L183 / `detachJob()` L145 | background 和 sync-detach 模式中，`chunks` 数组由 spawnCommand 的 `capture` 回调持续填充，但 detach/return 后 chunks 从未被读取（输出通过 outFile 读取）。进程持续运行期间，全部 stdout/stderr 输出同时驻留在内存（WriteStream buffer + chunks 数组）。对于长时间运行的 dev server 或大型 test suite，可能浪费数 MB 内存。 | 在 `detachJob()` 返回前和 `executeBackground()` 注册 Job 后，移除 child stdout/stderr 上的 `capture` 监听器：`child.stdout?.removeListener("data", capture)`。或者将 chunks 改为仅在 sync 正常完成时使用。 |
| 3 | LOW | spawn.ts:`executeKill()` L248 + `executeBackground()` L196-199 | kill background job 时，`killProcessGroup` 使进程退出 → background 的 `exitPromise.then()` 回调作为 microtask 先执行 → `injectBackgroundResult` 发送 "❌ FAILED" followUp 消息 → 随后 `executeKill` 将状态覆写为 "killed"。用户同时收到 kill 结果和一条多余的 "FAILED" followUp，语义矛盾。 | 在 background exit handler 中检查 job 是否已被 kill：`if (job.status !== "killed") { injectBackgroundResult(...) }`。或在 `executeKill` 中先设置一个 flag/mark 再调用 killProcessGroup。 |
| 4 | LOW | spawn.ts:`executeSync()` L122 | AbortSignal 触发时，`killProcessGroup` 正确终止进程，但随后 `exitPromise` resolve(null)（signal kill 时 Node.js exit code 为 null），代码走入 `exitCode !== 0` 分支抛出 `Error("Command exited with code null")`。AC-5 要求返回 "Command aborted"。虽然功能上进程被正确终止，但错误信息与 spec 不一致。 | 在 `executeSync` 的 Promise.race 之后，检查 `signal?.aborted`，若为 true 则 throw `new Error("Command aborted")` 而非 "Command exited with code null"。 |
| 5 | LOW | spawn.ts:`spawnCommand()` L82 | Spec FR-1 明确要求 `stdio: ["ignore", "pipe", "pipe"]`，但代码使用 `["pipe", "pipe", "pipe"]`。`"pipe"` 模式下 child.stdin 是一个可写流但从未被写入或关闭，如果命令读取 stdin 则会挂起等待输入。虽然 UC 中不涉及 stdin-reading 命令，但与 spec 不一致。 | 改为 `stdio: ["ignore", "pipe", "pipe"]`，与 spec 一致，也避免无意义的 stdin pipe 开销。 |
| 6 | INFO | spawn.ts:`spawnCommand()` L78 | `outFile` 使用 `generateJobId()` 生成独立 ID 命名，与后续 `detachJob()`/`executeBackground()` 中的 `jobId` 不同。功能正确（路径存储在 Job.outFile 中），但调试时文件名与 jobId 不对应，增加排查难度。 | 可将 outFile 命名统一使用 job 的 jobId，但需调整 spawnCommand 的调用时机。当前方案可接受。 |
| 7 | INFO | spawn.ts:`executeSync()` L99-100 | 每次 sync 命令都通过 `spawnCommand` 创建临时文件和目录，即使最终无超时、进程快速完成。短暂的文件创建和删除开销对于 `echo hello` 级别的命令是不必要的。 | 可考虑延迟创建 outFile（仅在超时触发时），但会增加实现复杂度。当前方案在可接受范围内。 |
| 8 | INFO | index.ts:`session_shutdown` L113 | `cleanupJobs` 使用动态 `import()` 而非与文件顶部一致的静态 import。功能无影响（动态 import 返回缓存模块），但与文件其他 import 风格不一致。`cleanupJobs` 可加入顶部静态 import。 | 将 `cleanupJobs` 加入顶部 `import { loadConfig, ... } from "./jobs.js"` 即可。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

#### 等级判定校准

Issue #1 标为 MUST FIX 的依据：
- **等级判定规则第 2 条**：功能失效——FR-11（spawn 失败处理）要求的代码路径从未被执行
- **等级判定规则第 5 条**：时序错误——exitPromise 在 spawn 失败时可能永不 resolve，导致工具永久挂起
- 生产环境影响：自定义 shellPath 配置错误时可直接导致 Pi 进程崩溃

---

## AC 覆盖矩阵

| AC | 场景 | 覆盖状态 | 验证结果 |
|----|------|---------|---------|
| AC-1 | Sync 正常命令 | ✅ | executeSync → exit code 0 → 返回输出 |
| AC-2 | Sync 超时 detach | ✅ | defaultTimeout 触发 → detachJob → 进程继续运行 |
| AC-3 | Sync 显式 timeout | ✅ | params.timeout 覆盖 defaultTimeout |
| AC-4 | Sync 无超时 | ✅ | effectiveTimeout=0 → NEVER_RESOLVES → 等待进程退出 |
| AC-5 | Sync AbortSignal | ⚠️ | 进程正确终止，但错误消息与 spec 不一致（Issue #4） |
| AC-6 | Background 模式 | ✅ | 立即返回 jobId + sendMessage 注入结果 |
| AC-7 | Poll 查询 | ✅ | findJob → readOutputFile → truncateTail |
| AC-8 | Kill 终止 | ✅ | killProcessGroup → SIGTERM+SIGKILL → 更新状态 |
| AC-9 | Job 不存在 | ✅ | poll/kill 均 findJob → undefined → isError |
| AC-10 | Session 隔离 | ✅ | session_start 创建闭包 Map，session_shutdown 清理 |
| AC-11 | 配置文件 | ✅ | loadConfig → 文件缺失/非法 JSON → 默认值 |
| AC-12 | Spawn 失败 | ❌ | ChildProcess 'error' 事件未监听（Issue #1） |
| AC-13 | 非零退出码 | ✅ | sync: throw Error, background: "FAILED" 标注 |
| AC-14 | 输出截断 | ✅ | truncateTail 用于所有输出路径 |
| AC-15 | 并发限制 | ✅ | runningJobCount >= max → error |
| AC-16 | Cwd 不存在 | ✅ | validateCwd → throw Error |
| AC-17 | Shell 兼容性 | ✅ | 复用 Pi 的 getShellConfig + buildShellEnv |

---

## 结论

需修改后重审。

### Summary

业务逻辑审查完成，第1轮，1条MUST FIX（spawn 'error' 事件未处理可导致 Pi 进程崩溃或工具永久挂起），需修复后重审。
