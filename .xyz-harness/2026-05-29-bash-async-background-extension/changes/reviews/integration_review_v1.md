---
review:
  type: integration_review
  round: 1
  timestamp: "2026-05-30T22:30:00"
  target: "bash-async/src/"
  verdict: pass
  summary: "集成审查完成，第1轮通过，0条MUST FIX。模块间调用链完整，数据流端到端无断裂，session 生命周期正确闭环，工具覆盖注册正确，配置传递完整。"

statistics:
  total_issues: 3
  must_fix: 0
  low: 1
  info: 2

issues:
  - id: 1
    severity: LOW
    location: "bash-async/src/shell.ts:buildShellEnv()"
    title: "buildShellEnv 每次调用重新计算 PATH，session_start 已缓存无需重复"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: INFO
    location: "bash-async/src/shell.ts:loadPiSettings()"
    title: "两个 settings 文件遍历顺序硬编码（全局优先于项目级），与 Pi 内部优先级一致但未文档化"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: INFO
    location: "bash-async/src/index.ts:execute()"
    title: "pollJobId + killJobId 互斥校验检查了 pollJobId 分支但未在 killJobId 分支检查 pollJobId"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Integration Review v1

## 评审记录
- 评审时间：2026-05-30 22:30
- 评审类型：集成审查（模块间协作 + 数据流 + 生命周期 + 工具覆盖 + 配置传递）
- 评审对象：bash-async/src/ 全部源代码
- 对照文档：spec.md, use-cases.md, business_logic_review_v3.md

---

## 1. 模块间协作：shell.ts → spawn.ts → jobs.ts → index.ts

### 调用链完整性验证

```
index.ts (入口工厂)
  ├── session_start → jobs.ts::createJobMap() + jobs.ts::loadConfig() + shell.ts::buildShellContext()
  ├── session_shutdown → jobs.ts::cleanupJobs(jobs)
  │
  ├── execute()
  │   ├── spawn.ts::executeSync()
  │   │   ├── spawn.ts::spawnCommand()        → child_process.spawn + pipe + capture
  │   │   ├── spawn.ts::detachJob()            → jobs.ts::registerJob() + jobs.ts::updateJobStatus()
  │   │   └── jobs.ts::removeOutputFile()
  │   │
  │   ├── spawn.ts::executeBackground()
  │   │   ├── spawn.ts::spawnCommand()         → child_process.spawn + pipe + capture
  │   │   ├── jobs.ts::registerJob()
  │   │   ├── jobs.ts::runningJobCount()       → 并发限制检查
  │   │   ├── spawn.ts::injectBackgroundResult() → jobs.ts::readOutputFile() + pi.sendMessage()
  │   │   └── jobs.ts::updateJobStatus()       → exit handler
  │   │
  │   ├── spawn.ts::executePoll()
  │   │   ├── jobs.ts::findJob()
  │   │   └── jobs.ts::readOutputFile()
  │   │
  │   └── spawn.ts::executeKill()
  │       ├── jobs.ts::findJob()
  │       ├── jobs.ts::killProcessGroup()
  │       └── jobs.ts::readOutputFile()
  │
  └── renderCall/renderResult → 纯展示，无跨模块协作
```

**结论：调用链完整，无悬空调用或断裂路径。**

### 模块职责边界

| 模块 | 职责 | 依赖 | 被依赖 |
|------|------|------|--------|
| types.ts | 纯类型定义 | 无 | shell.ts, jobs.ts, spawn.ts, index.ts |
| shell.ts | Shell 发现 + 环境构建 | types.ts (ShellContext), Pi API (getShellConfig) | index.ts |
| jobs.ts | Job CRUD + 进程清理 + 配置加载 + 临时文件管理 | types.ts (Job, BashAsyncConfig, JobStatus) | spawn.ts, index.ts |
| spawn.ts | 进程创建 + 执行逻辑（sync/bg/poll/kill） | types.ts, jobs.ts, Pi API (truncateTail, ExtensionAPI) | index.ts |
| index.ts | 扩展注册 + 参数路由 + TUI 渲染 | types.ts, jobs.ts, shell.ts, spawn.ts, Pi API | Pi runtime |

**结论：依赖方向单一（types ← shell/jobs ← spawn ← index），无循环依赖。职责划分清晰。**

---

## 2. 数据流完整性：command → spawn → outFile → poll

### Sync 模式数据流

```
用户输入 command
  → index.ts::execute() 参数路由
  → spawn.ts::executeSync()
    → spawnCommand()
      → child.stdout/stderr ─┬─ pipe(writeStream) → outFile (持续写入)
                             └─ on("data", capture) → chunks[] (内存收集)
    → 正常完成:
      → getBufferContent(chunks) → 截断 → 返回
      → removeOutputFile(outFile) (清理临时文件)
    → 超时:
      → detachJob()
        → registerJob(jobs, job) → job.outFile = outFile
        → removeCapture() → chunks 停止增长, pipe 保留 → outFile 持续写入
        → exitPromise.then → updateJobStatus("done"/"failed")
        → 返回 chunks 内容 + jobId
  → 用户 poll:
    → executePoll() → findJob → readOutputFile(job.outFile) → 完整输出 ✅
```

**验证点：**
- outFile 在 detach 后是否持续写入？→ ✅ removeCapture() 只移除 capture listener，pipe(writeStream) 保留
- poll 是否能读到 detach 后的新输出？→ ✅ readOutputFile 直接读磁盘文件
- 正常完成后 outFile 是否清理？→ ✅ removeOutputFile(outFile)

### Background 模式数据流

```
用户输入 command + background: true
  → spawn.ts::executeBackground()
    → spawnCommand()
      → stdout/stderr ─┬─ pipe(writeStream) → outFile (持续写入)
                        └─ on("data", capture) → chunks[] (短暂存在)
    → registerJob(jobs, job) → job.outFile = outFile
    → removeCapture() → chunks 停止增长, outFile 持续写入
    → 立即返回 jobId
    → 进程完成后:
      → exitPromise.then → updateJobStatus + injectBackgroundResult()
        → readOutputFile(outFile) → 截断 → pi.sendMessage({deliverAs: "followUp"})
```

**验证点：**
- outFile 从 spawn 开始就写入？→ ✅ spawnCommand 中 pipe(writeStream)
- background 的 chunks 是否泄漏？→ ✅ removeCapture() 移除 listener 后 chunks 不再增长，函数返回后 GC 回收
- auto-inject 是否能读到完整输出？→ ✅ exitPromise 在进程退出后 resolve，此时 writeStream 已关闭（exit handler 中 writeStream.destroy()），文件数据完整

### Kill 模式数据流

```
用户输入 killJobId
  → spawn.ts::executeKill()
    → findJob(jobs, jobId) → 获取 job.outFile
    → job.status = "killed" (防止 bg exit handler 注入)
    → killProcessGroup(job.pid) → SIGTERM → 等待退出
    → readOutputFile(job.outFile) → kill 前已收集的输出
    → updateJobStatus(jobs, jobId, "killed")
    → 返回输出
```

**验证点：**
- kill 后能否读到已有的输出？→ ✅ readOutputFile 读 outFile，kill 不删除文件
- outFile 何时清理？→ session_shutdown 时 cleanupJobs → unlinkSync(job.outFile)。kill 本身不清理（允许后续 poll 查看结果），符合 spec

### 数据流总结

| 路径 | 数据源 | 写入方式 | 消费者 | 完整性 |
|------|--------|---------|--------|--------|
| Sync → 正常完成 | chunks[] | on("data", capture) | getBufferContent → 返回 | ✅ |
| Sync → 超时 detach | outFile | pipe(writeStream) | poll → readOutputFile | ✅ |
| Background → auto-inject | outFile | pipe(writeStream) | injectBackgroundResult → sendMessage | ✅ |
| Background → poll | outFile | pipe(writeStream) | poll → readOutputFile | ✅ |
| Kill | outFile | pipe(writeStream) | readOutputFile → 返回 | ✅ |

**结论：端到端数据流无断裂。所有消费者都能正确读取生产者写入的数据。**

---

## 3. Session 生命周期

### 状态创建：session_start

```typescript
// index.ts
let config: BashAsyncConfig;
let shellCtx: ShellContext;
let jobs: Map<...>;

pi.on("session_start", () => {
    config = loadConfig();           // 从 ~/.pi/agent/bash-async.json 加载
    shellCtx = buildShellContext();   // shell 发现 + 环境变量构建
    jobs = createJobMap();            // 空 Map
});
```

**验证点：**
- 三个闭包变量在 session_start 中全部初始化？→ ✅
- 多 session 隔离？→ ✅ 闭包变量是函数级局部变量，每次 session_start 重新赋值
- loadConfig 失败时的行为？→ ✅ catch 块返回 DEFAULT_CONFIG，不崩溃

### 状态使用：execute()

```typescript
// index.ts::execute()
// config → 传给 executeSync (effectiveTimeout) 和 executeBackground (maxBackgroundJobs)
// shellCtx → 传给 executeSync 和 executeBackground
// jobs → 传给所有 execute* 函数
// pi → 传给 executeBackground (sendMessage)
```

**验证点：**
- 所有 execute 函数是否使用 session_start 创建的同一个 jobs Map？→ ✅ 通过闭包捕获
- config 和 shellCtx 是否一致传递？→ ✅ 无中途重建

### 状态清理：session_shutdown

```typescript
pi.on("session_shutdown", async () => {
    if (jobs) {
        await cleanupJobs(jobs);  // kill running + 删除 outFile + clear Map
    }
});
```

**验证点：**
- cleanupJobs 是否处理所有 running job？→ ✅ 遍历 Map，status === "running" 的全部 kill
- outFile 是否清理？→ ✅ unlinkSync(job.outFile) 对所有 job（不只是 running 的）
- cleanupJobs 中的 kill 错误是否阻塞？→ ✅ catch 后 console.error，继续处理
- jobs.clear() 是否执行？→ ✅ 在 Promise.allSettled(promises) 之后执行
- if (jobs) 防护是否必要？→ ✅ 防止 session_shutdown 在 session_start 之前触发的边界情况

### Session 生命周期闭环

```
session_start → [config, shellCtx, jobs] 初始化
  ↓
execute() → 使用闭包状态
  ↓
session_shutdown → cleanupJobs(jobs) → kill running + 删除文件 + clear Map
```

**结论：Session 生命周期完整闭环，无泄漏。**

---

## 4. 工具覆盖：registerTool("bash")

### 注册方式

```typescript
// index.ts
pi.registerTool({
    name: "bash",              // 与内置工具同名 → 覆盖
    label: "Bash (async)",
    description: TOOL_DESCRIPTION,  // 详细的四模式说明
    parameters: bashAsyncSchema,     // typebox schema
    renderShell: "self",             // 自渲染 shell 命令
    execute(...),                    // 参数路由
    renderCall(...),                 // TUI call 渲染
    renderResult(...),               // TUI result 渲染
});
```

### 覆盖正确性

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 工具名与内置一致 | ✅ | `name: "bash"` |
| 参数 schema 向后兼容 | ✅ | 原有 `command` + `timeout` 参数保留，新增 `background`/`pollJobId`/`killJobId` 均为 Optional |
| Sync 模式行为一致 | ✅ | spawn + await + 非零退出码 throw Error + cwd 检查 + AbortSignal |
| 输出格式兼容 | ✅ | `{ content: [{ type: "text", text }], details }` 结构 |
| TUI 渲染注册 | ✅ | renderCall + renderResult 均实现 |
| renderShell: "self" | ✅ | 覆盖内置 shell 渲染 |

### 参数路由完整性

```
execute(params):
  if params.pollJobId → executePoll()     // poll 优先（无副作用）
  elif params.killJobId → executeKill()   // kill 次优先（有副作用）
  elif !params.command → throw Error      // 无命令报错
  elif params.background → executeBackground()  // bg 模式
  else → executeSync()                    // 默认 sync
```

**验证点：**
- 四种模式互斥校验？→ ✅ poll 分支检查 killJobId/background/command，kill 分支检查 background/command
- 默认行为正确？→ ✅ 只有 command 时走 sync
- 缺少 command 时报错？→ ✅ throw Error

**注意事项（Issue #3，INFO）：** killJobId 分支未检查 pollJobId，但 pollJobId 分支已先于 killJobId 检查，实际路由不会到达 killJobId + pollJobId 的情况。逻辑正确，但校验不完全对称。

---

## 5. 配置传递：loadConfig → executeSync/executeBackground

### 配置加载链

```
session_start:
  config = loadConfig()
    → 读取 ~/.pi/agent/bash-async.json
    → 解析 defaultTimeout (number ≥ 0, 默认 120)
    → 解析 maxBackgroundJobs (number > 0, 默认 10)
    → JSON 解析失败 → DEFAULT_CONFIG

  shellCtx = buildShellContext()
    → loadPiSettings() → shellPath, commandPrefix
    → getShellConfig(shellPath) → shell, args
    → buildShellEnv() → env (PATH prepend Pi bin dir)
    → 合并为 ShellContext
```

### 配置使用点

| 配置字段 | 使用位置 | 用途 |
|----------|---------|------|
| config.defaultTimeout | executeSync | `effectiveTimeout = timeout ?? config.defaultTimeout` |
| config.maxBackgroundJobs | executeBackground | `runningJobCount(jobs) >= config.maxBackgroundJobs` |
| shellCtx.shell | spawnCommand | `child_process.spawn(shellCtx.shell, ...)` |
| shellCtx.args | spawnCommand | `[...shellCtx.args, fullCommand]` |
| shellCtx.env | spawnCommand | `env: shellCtx.env` |
| shellCtx.commandPrefix | spawnCommand | `commandPrefix && command` 拼接 |

**验证点：**
- config 是否在 session_start 中加载一次，后续 execute 使用同一实例？→ ✅ 闭包变量
- config 加载失败时 execute 是否有默认值可用？→ ✅ loadConfig 的 catch 返回 DEFAULT_CONFIG
- shellCtx 是否包含所有 spawn 所需信息？→ ✅ shell + args + env + commandPrefix
- commandPrefix 为空字符串时不拼接？→ ✅ `shellCtx.commandPrefix ? prefix + " && " + command : command`

**结论：配置传递完整，从加载到使用无断裂。**

---

## 6. 跨模块数据一致性

### Job ID 一致性

```
generateJobId() → "ba-{ts}-{rand}"
  → registerJob: job.jobId 作为 Map key
  → executePoll/executeKill: findJob(jobs, jobId) → Map.get(jobId)
```

**结论：ID 生成 → 注册 → 查找使用同一 Map 实例和 key，无一致性问题。**

### outFile 路径一致性

```
spawnCommand → createOutFilePath(generateJobId()) → $TMPDIR/pi-bash-jobs/{id}.out
  → pipe(writeStream) 写入
  → job.outFile = outFile 注册
  → readOutputFile(job.outFile) 读取
  → removeOutputFile(outFile) / unlinkSync(job.outFile) 清理
```

**注意（Issue #6 from v3，INFO）：** outFile 使用独立 generateJobId()，与 job.jobId 不同（spawnCommand 在 registerJob 之前调用）。不影响功能——outFile 路径存储在 job.outFile 字段中，后续操作通过 job.outFile 访问，不依赖文件名与 jobId 匹配。

### 进程 PID 一致性

```
spawnCommand → child.pid
  → job.pid = child.pid ?? 0
  → killProcessGroup(job.pid) → process.kill(-pid, SIGTERM)
```

**结论：PID 从 child process 获取到 job 注册到 kill 使用一致。**

---

## 7. 集成风险点排查

### 7.1 writeStream.destroy() 时序

```
spawnCommand → exit handler: child.on("exit", () => writeStream.destroy())
```

- destroy() 在 exit 事件中调用，此时 pipe 已将所有数据刷新到文件
- readOutputFile 在 exitPromise.then 中调用（exit 之后），文件数据完整
- **结论：无数据丢失风险** ✅

### 7.2 detachJob 后 outFile 可读性

```
detachJob → removeCapture() → pipe 保留 → 进程继续运行
  → outFile 持续增长
  → readOutputFile → fs.readFileSync → 读到当前已写入的内容
```

- Node.js WriteStream 的 pipe 有内部缓冲，但 readFileSync 读的是底层文件
- 进程仍在运行时，poll 读到的可能不是最新数据（有 OS 缓冲区延迟）
- **结论：可接受的近似实时读取，符合 spec"已收集输出"语义** ✅

### 7.3 cleanupJobs 与 running exit handler 的竞态

```
session_shutdown:
  cleanupJobs → kill running → jobs.clear()
  vs
  exitPromise.then → updateJobStatus(jobs, jobId, ...) → findJob 可能返回 undefined
```

- cleanupJobs 中先 kill 再 clear，exit handler 可能在 clear 之后触发
- updateJobStatus 中 `jobs.get(jobId)` 返回 undefined → if (!job) return → 安全退出
- injectBackgroundResult 中 findJob 返回 undefined → 跳过注入
- **结论：竞态安全，无崩溃风险** ✅

### 7.4 registerTool("bash") 覆盖时序

- Pi 的 registerTool 在扩展加载时注册，覆盖同名内置工具
- session_start 在注册之后触发，状态初始化正确
- **结论：覆盖时序正确** ✅

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | LOW | shell.ts:buildShellEnv() | buildShellEnv 每次被 buildShellContext 调用时都重新计算 PATH 拼接。实际只在 session_start 调用一次（缓存到 shellCtx），性能无影响。但函数签名暗示可重复调用，语义上应为纯函数或明确标注"仅调用一次"。 | 无需修改，仅记录 |
| 2 | INFO | shell.ts:loadPiSettings() | 遍历全局→项目级两个 settings 文件的优先级顺序（全局优先于项目级）是硬编码的。与 Pi 内部行为一致但未在代码中注释说明。 | 可选：添加注释说明优先级 |
| 3 | INFO | index.ts:execute() 参数路由 | killJobId 分支检查了 `params.background \|\| params.command` 但未检查 `params.pollJobId`。因 pollJobId 分支在 killJobId 之前执行，实际不会出现 killJobId + pollJobId 同时传入的情况。校验不完全对称但不影响正确性。 | 可选：在 killJobId 分支也检查 pollJobId 保持对称性 |

---

## AC 覆盖矩阵（集成视角）

| AC | 场景 | 集成验证 | 说明 |
|----|------|---------|------|
| AC-1 | Sync 正常命令 | ✅ | index→executeSync→spawnCommand→chunks→返回 |
| AC-2 | Sync 超时 detach | ✅ | index→executeSync→timeout→detachJob→registerJob→poll→readOutputFile |
| AC-3 | Sync 显式 timeout | ✅ | timeout 参数通过 index 传到 executeSync |
| AC-4 | Sync 无超时 | ✅ | effectiveTimeout=0 → NEVER_RESOLVES → 永不触发 detach |
| AC-5 | Sync AbortSignal | ✅ | signal 传入 spawnCommand → onAbort → killProcessGroup |
| AC-6 | Background 模式 | ✅ | index→executeBackground→spawnCommand→registerJob→removeCapture→sendMessage |
| AC-7 | Poll 查询 | ✅ | index→executePoll→findJob→readOutputFile |
| AC-8 | Kill 终止 | ✅ | index→executeKill→findJob→killProcessGroup→readOutputFile |
| AC-9 | Job 不存在 | ✅ | executePoll/executeKill → findJob 返回 undefined → makeErrorResult |
| AC-10 | Session 隔离 | ✅ | 闭包变量 + session_start 重建 + session_shutdown 清理 |
| AC-11 | 配置文件 | ✅ | loadConfig → JSON 解析 → 默认值 fallback |
| AC-12 | Spawn 失败 | ✅ | spawnCommand catch → makeErrorResult |
| AC-13 | 非零退出码 | ✅ | sync: throw Error; bg: exitCode != 0 → "FAILED" |
| AC-14 | 输出截断 | ✅ | truncateTail 在所有返回路径使用 |
| AC-15 | 并发限制 | ✅ | executeBackground → runningJobCount >= maxBackgroundJobs |
| AC-16 | Cwd 不存在 | ✅ | validateCwd 在 executeSync/executeBackground 入口检查 |
| AC-17 | Shell 兼容性 | ✅ | buildShellContext → getShellConfig + commandPrefix |

---

## UC 集成路径验证

### UC-1: 长时间编译（Sync → timeout detach → poll）

```
完整集成路径:
  index.ts::execute({command: "cargo build --release"})
  → executeSync(command, cwd, undefined, signal, onUpdate, jobs, shellCtx, config)
    → config.defaultTimeout = 120
    → spawnCommand("cargo build --release", shellCtx, cwd, chunks, signal)
      → child = spawn(shell, args, fullCommand, {env, cwd, detached, stdio})
      → child.stdout.pipe(writeStream) → outFile
      → child.stdout.on("data", capture) → chunks
      → onUpdate → 流式输出到 TUI ✅
    → 120s timeout → detachJob()
      → registerJob(jobs, {jobId, outFile, ...})
      → removeCapture() → outFile 持续写入
      → exitPromise.then → updateJobStatus ✅
      → 返回 partialOutput + jobId + hint
  → 用户 poll:
    → executePoll(jobId, jobs) → findJob → readOutputFile(outFile) → 完整输出 ✅
```

### UC-2: 测试套件（Background → auto-inject）

```
完整集成路径:
  index.ts::execute({command: "npm test", background: true})
  → executeBackground("npm test", cwd, pi, jobs, shellCtx, config)
    → runningJobCount(jobs) < maxBackgroundJobs ✅
    → spawnCommand("npm test", shellCtx, cwd, chunks)
    → registerJob(jobs, {jobId, outFile, mode: "background"})
    → removeCapture() → outFile 持续写入
    → 立即返回 jobId ✅
    → 进程完成后:
      → exitPromise.then → updateJobStatus("done")
      → findJob → status !== "killed" → injectBackgroundResult(pi, job, code, outFile)
        → readOutputFile(outFile) → 截断 → pi.sendMessage({deliverAs: "followUp"}) ✅
```

### UC-4: 开发服务器（Background → kill → session_shutdown）

```
完整集成路径:
  1. executeBackground("npm run dev") → jobId
  2. executeKill(jobId) → killProcessGroup → readOutputFile → 返回
  3. session_shutdown → cleanupJobs(jobs) → jobs 为空 (kill 已完成) → 无操作 ✅
  
  或:
  1. executeBackground("npm run dev") → jobId
  2. 用户关闭 session → session_shutdown → cleanupJobs → kill running + unlink outFile + clear ✅
```

---

## 结论

**verdict: pass**

集成审查完成。五个审查维度均通过：

1. **模块间协作**：调用链 shell.ts → spawn.ts → jobs.ts → index.ts 完整无断裂，依赖方向单一，无循环依赖。
2. **数据流完整性**：command → spawn → outFile → poll/kill/auto-inject 端到端无数据丢失。removeCapture() 精确移除内存捕获，保留 pipe 输出到文件。
3. **Session 生命周期**：session_start 初始化 → execute 使用闭包状态 → session_shutdown kill + 清理 + clear，完整闭环。
4. **工具覆盖**：registerTool("bash") 正确覆盖内置工具，参数向后兼容，路由逻辑完整。
5. **配置传递**：loadConfig → config → executeSync/executeBackground，buildShellContext → shellCtx → spawnCommand，全链路无断裂。

0 条 MUST FIX，1 条 LOW（buildShellEnv 重复调用无害），2 条 INFO（settings 优先级文档化、参数校验对称性）。
