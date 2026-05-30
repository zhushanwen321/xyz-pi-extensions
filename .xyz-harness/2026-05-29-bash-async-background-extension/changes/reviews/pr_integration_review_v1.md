---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-30T14:00:00"
  target: "bash-async/src/"
  verdict: fail
  summary: "集成审查第1轮，1条MUST FIX（spawnCommand exitPromise 边界契约缺陷导致跨模块数据丢失），4条LOW，2条INFO"

statistics:
  total_issues: 7
  must_fix: 1
  must_fix_resolved: 0
  low: 4
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "bash-async/src/spawn.ts:L91-L97"
    title: "spawnCommand exitPromise 边界契约缺陷——exit 事件不保证 outFile 完整性"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "bash-async/src/spawn.ts:L173-L177 vs L280-L282"
    title: "executeSync spawn 失败时 throw 而非返回 isError，与 FR-11 和 executeBackground 行为不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "bash-async/src/shell.ts:L53-L68"
    title: "loadPiSettings 首文件命中即返回，项目级 .pi/settings.json 被跳过"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "bash-async/src/jobs.ts:L130-L143"
    title: "cleanupJobs 在 kill 完成 前 unlink 输出文件，Windows 上可能异常"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "bash-async/src/types.ts:L53"
    title: "BashAsyncToolDetails.exitCode 类型为 number|null|undefined，renderResult 对 null 显示 'Exit: null'"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: INFO
    location: "bash-async/src/shell.ts:L19"
    title: "resolveShell re-export 无外部消费者，属于死导出"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: INFO
    location: "bash-async/src/jobs.ts:L115-L121"
    title: "getJobsDir/ensureJobsDir 导出但无外部消费者"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 集成审查 v1 — bash-async 模块边界正确性

## 评审记录
- 评审时间：2026-05-30 14:00
- 评审类型：集成审查（模块边界维度）
- 评审对象：bash-async/src/ 全部 5 个模块
- 对照标准：BLR v1 模拟数据与执行路径 + spec.md FR-1~FR-12
- 审查维度：D1 数据格式转换 / D2 错误传播 / D3 接口契约一致性 / D4 模块边界

## 模块依赖图

```
types.ts ← (type imports) ← index.ts, jobs.ts, shell.ts, spawn.ts
index.ts → spawn.ts (executeSync, executeBackground, executePoll, executeKill)
index.ts → jobs.ts (createJobMap, loadConfig, cleanupJobs)
index.ts → shell.ts (buildShellContext)
spawn.ts → jobs.ts (10 functions: generateJobId, createOutFilePath, registerJob, findJob,
                     updateJobStatus, runningJobCount, killProcessGroup, readOutputFile,
                     removeOutputFile)
spawn.ts → @mariozechner/pi-coding-agent (truncateTail)
shell.ts → @mariozechner/pi-coding-agent (getShellConfig)
```

## 审查方法

沿 BLR v1 的 UC-1~UC-5 模拟数据，在每条模块边界上验证：
1. 调用方传递的参数类型/语义是否匹配被调用方的契约
2. 被调用方返回的数据是否满足调用方的预期
3. 异步时序下数据在边界处是否一致
4. 错误是否被正确传播或处理，不被静默吞掉

---

## D1: 数据格式转换

### D1-1: spawnCommand → outFile → readOutputFile（跨 spawn.ts ↔ jobs.ts 边界）

**验证路径**: UC-2（npm test, background）执行路径

```
spawnCommand (spawn.ts:77)
  → createOutFilePath(generateJobId()) → outFile 路径 (jobs.ts:115)
  → child.stdout.pipe(writeStream) → 持续写入 outFile

process exit → child.on("exit") (spawn.ts:91)
  → unpipe + writeStream.destroy()
  → resolve(code) → exitPromise

executeBackground exit handler (spawn.ts:310-318)
  → injectBackgroundResult (spawn.ts:275)
    → readOutputFile(outFile) (jobs.ts:168)
      → fs.readFileSync(outFile) → 返回 string
    → truncateTail(output) → { text, truncated }
```

**🔴 发现问题 (Issue #1)**:

Node.js `'exit'` 事件在 stdio 流关闭**之前**触发（Node.js 文档原文："child process stdio streams might still be open when the 'exit' event is emitted"）。

`spawnCommand` 在 exit handler（L91-97）中执行 `unpipe` + `destroy`，导致三层未刷写数据丢失：
1. 内核 pipe buffer 中 stdout 尚未读取的数据
2. stdout Readable buffer 中已读但 unpipe 阻止其流向 writeStream 的数据
3. writeStream 内部 write buffer 被 destroy 丢弃的数据

**边界影响**:
- `exitPromise` 的契约是"进程退出时 resolve"，但消费者 `injectBackgroundResult` 隐含假设 "exitPromise resolve 时 outFile 已完整"——这个假设不成立
- `detachJob`（L262）同样通过 `exitPromise.then` 更新 job 状态，后续 `pollJobId` 读取的 outFile 也可能不完整
- **数据丢失跨 spawn.ts → jobs.ts 边界**: `readOutputFile` 正确读取了磁盘文件，但文件本身就是不完整的

**模拟数据验证**:

```
UC-2: npm test → 输出 100KB 测试日志 + 2KB 测试摘要
  进程 exit(0) → exitPromise resolve
  injectBackgroundResult → readOutputFile → 只有 98KB（摘要丢失）
  pi.sendMessage 注入不完整结果 → AI 看不到 pass/fail 计数
```

**修复方向**: L91 `child.on("exit", ...)` → `child.on("close", ...)`；L96 `writeStream.destroy()` → `writeStream.end()`。`close` 事件在 stdio 流完全关闭后触发。

### D1-2: readOutputFile 返回空字符串的错误降级

**验证路径**: jobs.ts:168-175

`readOutputFile` 在文件不存在或读取失败时返回 `""`（空字符串）。此返回值被 `executePoll`、`executeKill`、`injectBackgroundResult` 消费。

当 `readOutputFile` 返回 `""` 时，下游 `truncateTail("")` 返回 `{ text: "", truncated: false }`，消费者会显示空输出而**没有任何提示**表明读取失败。

**实际影响**: 极低。仅在 temp 目录被外部清理时触发。`cleanupJobs` 在 session shutdown 时正常清理。记录为观察，不升级。

### D1-3: onUpdate 数据格式转换（跨 index.ts → spawn.ts 边界）

**验证路径**: index.ts:104-109

```typescript
const onUpdateAdapter = onUpdate
    ? (details: BashAsyncToolDetails, text: string) => {
            onUpdate({ content: [{ type: "text", text }], details });
        }
    : undefined;
```

Pi 的 `onUpdate` 期望 `{ content: Array<{ type: "text"; text: string }>; details }`。
adapter 正确地将 spawn.ts 的 `(details, text)` 签名转换为 Pi 期望的格式。
`type: "text"` 硬编码正确（Pi tool content protocol）。

✅ 无问题。

### D1-4: truncateTail 返回值消费

`truncateTail` 从 `@mariozechner/pi-coding-agent` 导入，返回 `{ text: string, truncated: boolean }`。
所有消费点（executeSync:201, detachJob:258, injectBackgroundResult:286, executePoll:351, executeKill:413）均正确解构 `.text` 和 `.truncated`。

✅ 无问题。

---

## D2: 错误传播

### D2-1: executeSync spawn 失败处理不一致

**验证路径**: spawn.ts:173-177 vs spawn.ts:280-282

| 模式 | spawn 失败处理 | FR-11 要求 |
|------|---------------|-----------|
| executeSync (L173-177) | `throw new Error(...)` | "返回 isError: true" |
| executeBackground (L280-282) | `return makeErrorResult(...)` ✅ | "返回 isError: true" |

`executeSync` 在 spawn 失败时 throw，导致：
- Pi runtime 捕获并显示为工具异常 → 不经过 `renderResult`
- 错误信息不含命令名和建议（FR-11 要求 "错误信息包含：错误类型、命令、建议"）
- 与 `executeBackground` 的错误处理模式不一致

**跨边界影响**:
- index.ts `execute()` 无 try-catch → throw 直接传播到 Pi runtime
- `renderResult` 永远不会被调用 → 用户看到 Pi 默认错误格式而非自定义渲染

**实际影响**: 功能正确（错误仍被显示），但格式和内容与 spec 不符。AI 对错误的理解可能受影响（缺少命令名等上下文）。

**修复方向**: spawn.ts L173-177 改为 `return makeErrorResult(...)` 与 executeBackground 一致。

### D2-2: executeKill 中 killProcessGroup 错误传播

**验证路径**: spawn.ts:398-400

```typescript
await killProcessGroup(job.pid);
```

无 try-catch 包裹。`killProcessGroup`（jobs.ts:152-180）在 SIGTERM 发送阶段对非 ESRCH 错误会 re-throw（L165）。可能的错误类型：EPERM（权限不足，尝试 kill 其他用户的进程组）。

如果 re-throw：
1. executeKill 抛出异常 → index.ts 无 catch → Pi runtime 处理
2. `job.status` 已被设为 "killed"（L394），但 `updateJobStatus` 未被调用（L408 在 throw 之后）
3. Job 保持 "killed" 状态但进程可能仍在运行 → 状态不准确

**实际影响**: 极低。EPERM 在正常 Pi 使用场景中不会发生（进程是自身 spawn 的）。记录为观察。

### D2-3: injectBackgroundResult 错误安全

**验证路径**: spawn.ts:295-300

`pi.sendMessage` 被完整 try-catch 包裹。session shutdown 时 sendMessage 可能失败，错误被 console.error 记录但不传播。✅ 符合 spec（"sendMessage 的 try-catch 错误不传播到调用者"）。

✅ 无问题。

### D2-4: validateCwd 错误传播

**验证路径**: spawn.ts:30-40 → executeSync:158, executeBackground:272

`validateCwd` throws Error。在 `executeSync` 中，此 throw 发生在 try-catch（L192）之前，直接传播到 index.ts execute()。在 `executeBackground` 中，同样在所有 try-catch 之前。

两个路径都让错误传播到 Pi runtime，Pi 将其显示为工具错误。行为与内置 bash 一致（cwd 不存在时直接报错）。

✅ 无问题。

---

## D3: 接口契约一致性

### D3-1: 所有跨模块函数签名验证

| 调用方 | 被调用方 | 参数匹配 | 返回值处理 |
|--------|---------|---------|-----------|
| index.ts:119 | executeBackground(cmd, cwd, pi, jobs, shellCtx, config) | ✅ | ToolResult → Pi tool result ✅ |
| index.ts:125 | executeSync(cmd, cwd, timeout, signal, onUpdate, jobs, shellCtx, config) | ✅ | ToolResult → Pi tool result ✅ |
| index.ts:110 | executePoll(pollJobId, jobs) | ✅ | ToolResult ✅ |
| index.ts:115 | executeKill(killJobId, jobs) | ✅ | ToolResult ✅ |
| spawn.ts:77 | createOutFilePath(generateJobId()) | string→string ✅ | string ✅ |
| spawn.ts:290 | registerJob(jobs, job) | Map+Job→void ✅ | - |
| spawn.ts:312 | updateJobStatus(jobs, jobId, status, exitCode) | 类型匹配 ✅ | - |
| spawn.ts:314 | findJob(jobs, jobId) | Map+string→Job|undefined ✅ | null check ✅ |
| spawn.ts:286 | readOutputFile(outFile) | string→string ✅ | ✅ |
| spawn.ts:201 | removeOutputFile(outFile) | string→void ✅ | - |
| spawn.ts:275 | runningJobCount(jobs) | Map→number ✅ | >= 比较 ✅ |
| index.ts:82 | loadConfig() | → BashAsyncConfig ✅ | ✅ |
| index.ts:83 | buildShellContext() | → ShellContext ✅ | ✅ |

✅ 所有函数签名在调用方和被调用方之间一致。

### D3-2: BashAsyncToolDetails.exitCode 可空性

**验证路径**: types.ts:53 → renderResult (index.ts:179)

```typescript
// types.ts
exitCode?: number | null;

// index.ts renderResult
if (details.exitCode !== undefined) meta.push(`Exit: ${details.exitCode}`);
```

当 exitCode 为 `null`（poll/kill 一个被 SIGKILL 的进程）时，`null !== undefined` 为 true，显示 "Exit: null"。

**来源分析**:
- `executePoll`（L352）: `exitCode: job.exitCode`，Job.exitCode 类型为 `number | null`
- `executeKill`（L414）: `exitCode`，来自 Promise.race 可能 resolve 为 `null`（超时）

**修复方向**: renderResult 中 `if (details.exitCode != null)` 同时排除 null 和 undefined；或 types.ts 中 exitCode 改为 `number | undefined`。

### D3-3: BashAsyncParams 可选字段在路由中的处理

**验证路径**: index.ts:107-130

路由逻辑按 `pollJobId` → `killJobId` → `command` → default 顺序。互斥校验正确：
- pollJobId 存在时检查 killJobId/background/command 不存在 ✅
- killJobId 存在时检查 background/command 不存在 ✅
- command 缺失时 throw Error ✅
- background 参数只在有 command 时生效（因 command 检查在前）✅

但有一个边界情况：`pollJobId: ""` 或 `killJobId: ""`（空字符串）会被当作 truthy 进入对应分支，然后找不到 job 返回错误。这不是 bug（空字符串的 jobId 确实不存在），但可能导致混淆的报错信息。

✅ 功能正确，无需修改。

---

## D4: 模块边界

### D4-1: spawnCommand 的 exitPromise 契约缺陷（核心边界问题）

这是 Issue #1 的模块边界视角分析。

`spawnCommand` 函数（spawn.ts:68-137）返回 `SpawnResult`，其中 `exitPromise` 是核心契约字段：

```typescript
interface SpawnResult {
    child: ChildProcess;
    outFile: string;
    writeStream: WriteStream;
    exitPromise: Promise<number | null>;  // ← 契约：resolve 时进程已退出
    removeCapture: () => void;
}
```

**消费者 1: executeSync**（L194）
- `exitCode = await Promise.race([exitPromise, timeoutPromise])`
- 超时时：进入 `detachJob`，exitPromise 用于后台状态更新
- 正常完成：直接从 chunks[] 读取输出（不依赖 outFile），不受此问题影响 ✅

**消费者 2: detachJob**（L262-265）
- `exitPromise.then((code) => { updateJobStatus(...) })`
- 仅更新 job 状态，不读取 outFile → 不受数据丢失影响 ✅

**消费者 3: executeBackground**（L310-318）
- `exitPromise.then((code) => { updateJobStatus(...); injectBackgroundResult(pi, job, code, outFile) })`
- **injectBackgroundResult 读取 outFile** → 直接受数据丢失影响 ❌
- 这是 background 模式的关键消费者，丢失尾部输出（如测试摘要）会导致 AI 误判

**消费者 4: executeKill**（L386-391）
- 自己创建新的 `exitPromise`（基于 `child.once("exit")`），不使用 spawnCommand 的
- kill 后读取 outFile 获取 kill 前输出 → 同样受 exit 事件时序影响，但 kill 场景下尾部数据丢失是可接受的

**结论**: spawnCommand 的 exitPromise 契约对 `executeBackground` 的 `injectBackgroundResult` 造成数据丢失。这是一个 **D4 模块边界问题**：生产者（spawnCommand）的输出保证不满足消费者（injectBackgroundResult）的输入需求。

### D4-2: shell.ts loadPiSettings 跨文件配置查找缺陷

**验证路径**: shell.ts:53-68 → buildShellContext:70-74

```typescript
for (const filePath of [globalPath, projectPath]) {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        return { shellPath: ..., commandPrefix: ... };  // ← 首个文件命中即返回
    } catch { /* continue */ }
}
```

模块边界问题：`loadPiSettings` 的职责是"从 Pi settings 读取 shell 配置"，但实现为"从第一个存在的文件读取"。当全局 `~/.pi/agent/settings.json` 存在但缺少 `shellPath` 字段时：
1. 函数读取全局文件 → `shellPath: undefined, commandPrefix: undefined`
2. 返回 `{}`，不检查项目级 `.pi/settings.json`

结果：项目级 `.pi/settings.json` 中的 `shellPath` 被静默忽略。

**影响链**: `buildShellContext` → `ShellContext` → `spawnCommand` → `child_process.spawn(shellCtx.shell, ...)`
→ 如果项目需要特殊 shell（如 nix-shell），命令会在错误 shell 中执行

**修复方向**: 改为合并策略——先读全局，再读项目级，项目级字段覆盖全局。

### D4-3: jobs.ts cleanupJobs 文件清理时序

**验证路径**: jobs.ts:130-143

```typescript
for (const job of jobs.values()) {
    if (job.status === "running") {
        promises.push(killProcessGroup(...));
        job.status = "killed";
    }
    try { fs.unlinkSync(job.outFile); } catch {}  // ← kill 完成前删除文件
}
jobs.clear();                                        // ← kill 完成前清空 map
await Promise.allSettled(promises);                  // ← 等待 kill 完成
```

**时序问题**: outFile 在 killProcessGroup 完成前被 unlink。在 Unix 上，unlink 打开文件不影响已有 fd（writeStream 仍可写入已 unlink 的 inode）。但在 Windows 上，删除打开中的文件可能失败或导致 writeStream 写入错误。

**跨边界影响**: spawnCommand 的 writeStream 引用 outFile。如果 cleanupJobs 在 kill 之前 unlink 了文件，而进程在 kill 前写入数据：
- Unix: 数据写入已 unlink 的 inode，磁盘空间在 writeStream 关闭后释放 → 安全
- Windows: unlink 可能失败（try-catch 吞掉错误）→ 进程继续写入 → 文件残留

**修复方向**: 将 `fs.unlinkSync` 移到 `await Promise.allSettled(promises)` 之后。

### D4-4: spawnCommand outFile 命名与 Job.jobId 不匹配（跨模块认知负担）

**验证路径**:
- spawn.ts:77: `outFile = createOutFilePath(generateJobId())` → 文件名 `ba-{A}.out`
- spawn.ts:238/290: `jobId = generateJobId()` → jobId `ba-{B}`

文件名和 jobId 独立生成，无关联。Job.outFile 字段存储映射关系，功能正确。但调试时需要通过 Job.outFile 字段间接查找，增加了跨模块追踪的认知负担。

BLR #5 已标记为 INFO，此处不升级。

### D4-5: 模块职责划分评估

| 模块 | 职责 | 评价 |
|------|------|------|
| types.ts | 类型定义，无逻辑 | ✅ 纯净 |
| jobs.ts | Job 生命周期 + 配置 + 文件 I/O + 进程 kill | ⚠️ 职责稍多（killProcessGroup 可独立），但在 184 行内可接受 |
| shell.ts | Shell 发现 + 环境构建 | ✅ 职责清晰 |
| spawn.ts | 进程 spawn + 4 种执行模式 | ⚠️ 469 行，是最大模块。但 4 种模式共享 spawnCommand 基础设施，拆分反而增加边界 |
| index.ts | 扩展注册 + 路由 + 渲染 | ✅ 胶水层，无业务逻辑 |

**dead export 检查**:
- shell.ts `resolveShell`: re-export `getShellConfig`，但无外部消费者
- jobs.ts `getJobsDir`/`ensureJobsDir`: 仅被 `createOutFilePath` 内部使用

不影响功能，但增加公开 API 表面积。

---

## 跨模块数据流追踪汇总

### 流 1: Background 模式完整数据流

```
index.ts execute()
  → spawn.ts executeBackground(cmd, cwd, pi, jobs, shellCtx, config)
    → spawn.ts spawnCommand(cmd, shellCtx, cwd, chunks)
      → types.ts ShellContext { shell, args, env, commandPrefix }
      → jobs.ts createOutFilePath(generateJobId()) → outFile
      → child_process.spawn(shell, args, fullCommand, { cwd, env, detached, stdio })
      → child.stdout.pipe(writeStream) → outFile
      → return SpawnResult { child, outFile, writeStream, exitPromise, removeCapture }
    → jobs.ts registerJob(jobs, job)
    → removeCapture()
    → exitPromise.then:
      → jobs.ts updateJobStatus(jobs, jobId, status, code)
      → jobs.ts findJob(jobs, jobId) → 检查 killed 标记
      → spawn.ts injectBackgroundResult(pi, job, code, outFile)
        → jobs.ts readOutputFile(outFile) → output  ← ⚠️ Issue #1: 可能不完整
        → @mariozechner/pi-coding-agent truncateTail(output) → { text, truncated }
        → pi.sendMessage({ content: text }) ← ⚠️ 注入不完整结果
```

**边界验证**: 10 个跨模块调用点，1 个数据完整性问题（Issue #1），其余正确。

### 流 2: Sync-Detach 后 Poll 数据流

```
index.ts execute()
  → spawn.ts executeSync → detachJob → 返回 jobId
  → AI 调用 pollJobId
  → spawn.ts executePoll(jobId, jobs)
    → jobs.ts findJob(jobs, jobId) → job
    → jobs.ts readOutputFile(job.outFile) → output  ← ⚠️ Issue #1: 如果进程刚退出，可能不完整
    → truncateTail(output)
    → return ToolResult
```

**边界验证**: 进程退出后 outFile 的完整性取决于 exitPromise resolve 时 writeStream 是否已完全刷写。Issue #1 影响此路径。

### 流 3: Kill 数据流

```
index.ts execute()
  → spawn.ts executeKill(jobId, jobs)
    → jobs.ts findJob(jobs, jobId) → job
    → job.child.once("exit") → 自己的 exitPromise（不依赖 spawnCommand 的）
    → job.status = "killed"
    → jobs.ts killProcessGroup(job.pid)
    → jobs.ts updateJobStatus(jobs, jobId, "killed", exitCode)
    → jobs.ts readOutputFile(job.outFile) → output  ← kill 前的输出，可能缺少最后一点
    → truncateTail(output)
    → return ToolResult
```

**边界验证**: kill 场景下尾部数据丢失是可接受的（进程被强制终止）。无跨模块问题。

---

## 发现的问题

| # | 优先级 | 维度 | 文件/位置 | 描述 | 修改建议 |
|---|--------|------|----------|------|---------|
| 1 | MUST FIX | D1+D4 | spawn.ts:L91-L97 | **spawnCommand exitPromise 边界契约缺陷**。`child.on("exit")` 在 stdio 流关闭前触发，`unpipe + destroy` 丢弃未刷写数据。`injectBackgroundResult` 通过 `exitPromise.then` 读取 outFile 时数据不完整。跨 spawn.ts→jobs.ts (readOutputFile) 边界传播不完整数据。 | L91: `child.on("exit", ...)` → `child.on("close", ...)`。L96: `writeStream.destroy()` → `writeStream.end()`。修改后 `close` 事件保证 stdio 流完全关闭，`end()` 刷写 writeStream 内部缓冲。 |
| 2 | LOW | D2 | spawn.ts:L173-L177 | **executeSync spawn 失败 throw vs FR-11 要求 isError**。`executeSync` 在 spawnCommand 抛出时 re-throw，而 `executeBackground` 返回 `makeErrorResult`。FR-11 明确要求 "返回 isError: true"。throw 不经过 `renderResult`，用户看到 Pi 默认错误格式而非自定义渲染。 | 改为 `return makeErrorResult(...)` 与 executeBackground 保持一致。错误信息增加命令名和检查建议（FR-11 要求）。 |
| 3 | LOW | D4 | shell.ts:L53-L68 | **loadPiSettings 首文件命中即返回，项目级配置被跳过**。全局 `~/.pi/agent/settings.json` 存在但缺少 `shellPath` 时，返回 `{}` 不继续检查项目级 `.pi/settings.json`。项目级 shell 配置被静默忽略。 | 改为合并策略：先读全局获取已定义字段，再读项目级覆盖。或者改为项目级优先（先读项目级，再读全局 fallback）。 |
| 4 | LOW | D4 | jobs.ts:L130-L143 | **cleanupJobs 在 kill 完成前 unlink 输出文件**。`fs.unlinkSync(job.outFile)` 在 `killProcessGroup` 完成（5s 等待）前执行。Unix 安全（unlink 不影响已打开 fd），Windows 上删除打开中的文件可能失败或异常。 | 将 `fs.unlinkSync` 循环移到 `await Promise.allSettled(promises)` 之后，确保进程已退出再删文件。 |
| 5 | LOW | D3 | types.ts:L53 + index.ts:L179 | **BashAsyncToolDetails.exitCode 类型为 `number\|null\|undefined`**，但 renderResult 用 `!== undefined` 检查。当 exitCode 为 `null`（被 SIGKILL 的进程）时显示 "Exit: null"。 | renderResult 改为 `if (details.exitCode != null)` 同时排除 null 和 undefined；或在 types.ts 中去掉 `null` 只保留 `number | undefined`。 |
| 6 | INFO | D4 | shell.ts:L19 | `resolveShell` re-export 无外部消费者。shell.ts 自身通过 `getShellConfig` 直接导入使用。 | 移除 re-export 或标记为 `@internal`。 |
| 7 | INFO | D4 | jobs.ts:L115-L121 | `getJobsDir` 和 `ensureJobsDir` 导出但仅被 `createOutFilePath` 内部调用。 | 改为非导出函数或标记为 `@internal`。 |

### 等级判定校准说明

- **Issue #1 标 MUST_FIX 的理由**: 数据丢失属于"数据无法到达预期目的地"（等级判定规则第 1 条）。这是跨模块边界的数据完整性问题——spawnCommand 的 exitPromise 契约不满足消费者 injectBackgroundResult 对 outFile 完整性的隐含依赖。生产环境下 `npm test` 的测试摘要会被截断，AI 误判测试结果。
- **Issue #2 标 LOW 的理由**: 错误仍然被显示（Pi runtime 捕获 throw），不影响功能正确性。差异仅在于错误格式和渲染路径。FR-11 的要求是功能性的而非数据完整性的。
- **Issue #3 标 LOW 的理由**: 只影响同时配置了全局和项目级 settings 的场景。大多数用户只有全局配置或只有项目配置，不会触发。
- **Issue #4 标 LOW 的理由**: Unix（主要运行环境）上完全安全。Windows 兼容性问题不影响核心功能。

---

## 与 BLR v1 的交叉验证

| BLR Issue | 集成审查对应 | 验证结论 |
|-----------|-------------|---------|
| BLR #1 (MUST_FIX): exit 事件数据丢失 | 集成 #1 (MUST_FIX) | ✅ 确认。从模块边界视角验证了数据丢失跨 spawn.ts→jobs.ts 边界传播的完整路径。 |
| BLR #2 (LOW): 缺少耗时刷新 | — | 本审查聚焦模块边界。此问题限于 executeSync 内部，不跨模块。BLR 评级合理。 |
| BLR #3 (LOW): onUpdate O(n²) | — | 限于 executeSync 内部。不跨模块边界。 |
| BLR #4 (LOW): loadPiSettings 首文件返回 | 集成 #3 (LOW) | ✅ 确认。从模块边界视角验证了影响链：shell.ts→spawn.ts→child_process.spawn。 |
| BLR #5 (INFO): outFile 与 jobId 不匹配 | — | 功能正确，仅认知负担。不升级。 |
| BLR #6 (INFO): 测试内联重实现 | — | 非生产代码问题，不在集成审查范围。 |
| BLR #7 (INFO): session 变量未初始化 | — | Pi 保证 session_start 先于 execute。实际安全。 |

**新增发现（BLR 未覆盖）**:
- 集成 #2: executeSync spawn 失败 throw 不一致（D2 错误传播维度）
- 集成 #4: cleanupJobs unlink 时序（D4 模块边界维度）
- 集成 #5: exitCode null 显示（D3 接口契约维度）
- 集成 #6-7: dead exports（D4 模块边界维度）

---

## 结论

**需修改后重审**

Issue #1 是跨 `spawnCommand` → `injectBackgroundResult` 模块边界的核心数据完整性问题。修复集中在一处（spawn.ts L91-97），方案明确（exit → close, destroy → end），不影响其他模块接口。修复后建议验证：
1. Background 模式下 `npm test` 完成后注入结果包含完整测试摘要
2. Sync-detach 后 poll 读到完整输出
3. Kill 路径行为不变（kill 场景的尾部截断是可接受的）

### Summary

集成审查完成，第1轮，1条MUST FIX（spawnCommand exitPromise 边界契约导致跨模块数据丢失），4条LOW，2条INFO。
