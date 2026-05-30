---
review:
  type: robustness_review
  round: 1
  timestamp: "2026-05-30T12:00:00"
  target: "bash-async/src/"
  verdict: fail
  summary: "健壮性审查完成，第1轮，4条MUST FIX，需修复后重审"

statistics:
  total_issues: 12
  must_fix: 4
  low: 5
  info: 3

issues:
  - id: 1
    severity: MUST_FIX
    location: "bash-async/src/index.ts:L101"
    title: "execute() 可能在 session_start 之前被调用，jobs/config/shellCtx 未初始化"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "bash-async/src/spawn.ts:L73-L82"
    title: "spawnCommand 用 generateJobId() 创建 outFile 名，与后续 detachJob/background 注册的 jobId 不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "bash-async/src/spawn.ts:L170"
    title: "exitPromise reject 与 Promise.race 交互：spawn error reject 后 timedOut 仍为 false，但 child 进程已 error 退出"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: MUST_FIX
    location: "bash-async/src/spawn.ts:L288-L306"
    title: "executeKill 在 job.status !== running 时不清理 outFile，已完成 job 的临时文件永不删除"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "bash-async/src/spawn.ts:L147"
    title: "NEVER_RESOLVES 永不 resolve 的 Promise 在长 session 中持有闭包引用"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "bash-async/src/jobs.ts:L73-L76"
    title: "killProcessGroup 的 SIGTERM 后等待 5 秒用 setTimeout 无 unref，阻止进程退出"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "bash-async/src/spawn.ts:L80-L81"
    title: "stdout/stderr 的 pipe 与 on('data') 监听器在 exit 时只 unpipe 未 removeAllListeners，可能有内存泄漏"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: LOW
    location: "bash-async/src/spawn.ts:L390-L437"
    title: "executePoll 缺少输出大小限制，长时间运行 job 的 outFile 可能极大"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: LOW
    location: "bash-async/src/shell.ts:L42-L54"
    title: "loadPiSettings 读两个文件但只返回第一个成功解析的结果，第二个文件被忽略"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 10
    severity: INFO
    location: "bash-async/src/jobs.ts:L64"
    title: "cleanupJobs 在 kill running jobs 后立即 clear() map，但 killProcessGroup 是异步的，清理期间 job 状态不可查询"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 11
    severity: INFO
    location: "bash-async/src/spawn.ts:L109"
    title: "onUpdate 事件转发中每次 data 触发都 Buffer.concat 全量 chunks，高频输出时有 O(n²) 性能问题"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 12
    severity: INFO
    location: "bash-async/src/jobs.ts:L15-L18"
    title: "jobId 使用 Date.now() 的 36 进制，同一毫秒并发时冲突概率非零"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 健壮性审查 v1 — bash-async 扩展

## 审查记录
- 审查时间：2026-05-30
- 审查类型：健壮性审查（六维度）
- 审查对象：bash-async/src/（index.ts, jobs.ts, shell.ts, spawn.ts, types.ts）
- 审查范围：D1 错误处理、D2 异常处理、D3 日志、D4 Fail-fast、D5 测试友好、D6 调试友好

## 六维度审查结果

### D1 — 错误处理

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | index.ts:L101 | `execute()` 内直接访问 `jobs`/`config`/`shellCtx`，若 `session_start` 事件未先触发则变量未初始化。Pi 事件顺序无硬性保证，tool call 可能早于 `session_start`。 | 在 `execute()` 入口加防御性检查：若 `jobs` 为 undefined 则 throw 明确错误。或用 `!` 断言并在注释中说明前提。 |
| 4 | MUST FIX | spawn.ts:L288-L306 | `executeKill` 对 `job.status !== "running"` 分支直接返回结果但不调用 `removeOutputFile(outFile)`，outFile 泄漏到 `$TMPDIR` 永不清理。同理 `executePoll` 对已完成 job 也未清理。 | 在 kill/poll 返回后调用方清理 outFile，或在 job 完成（done/failed）后由 exit handler 清理。建议在 `updateJobStatus` 中检测终态并触发清理。 |
| 8 | LOW | spawn.ts:L390-L437 | `executePoll` 用 `readOutputFile` 读取完整文件内容，无大小限制。长时间运行的 build/test 输出可达 GB 级，直接 `readFileSync` 会导致内存溢出。 | 添加文件大小检查（`fs.statSync`），超过阈值时只读尾部或返回截断提示。 |

### D2 — 异常处理

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 2 | MUST FIX | spawn.ts:L73,L170 | `spawnCommand` 内部调用 `createOutFilePath(generateJobId())` 生成 outFile 名（内部 ID-A），随后 `detachJob`/`executeBackground` 又调用 `generateJobId()` 生成另一个 jobId（ID-B）注册到 jobs map。outFile 名用的是 ID-A，job.jobId 是 ID-B。Job.outFile 字段保存的是 ID-A 路径，poll/kill 时 `readOutputFile(job.outFile)` 能正确读取。但 `cleanupJobs` 中 `fs.unlinkSync(job.outFile)` 也正确。**经复核，Job.outFile 保存的是 spawn 时创建的路径，与 jobId 不一致但功能正确。** 然而 outFile 名和 jobId 不一致增加了调试和日志关联难度。 | 统一 outFile 名与 jobId，让 `spawnCommand` 接收外部生成的 jobId，或改为在 `detachJob`/`executeBackground` 中先生成 jobId 再传给 spawn。 |
| 3 | MUST FIX | spawn.ts:L170 | `exitPromise` 的 reject（spawn error）被 `Promise.race` 捕获后，代码进入 catch 分支返回 `makeErrorResult`。但此时 `timedOut` 仍为 false，`spawnResult` 中的 outFile 已在 `exitPromise` reject handler 中被 `removeOutputFile` 删除——这部分正确。问题在于：spawn error 发生时 child 可能未成功创建，`child.pid` 为 undefined，但 abort signal 的 `killProcessGroup(child.pid ?? 0)` 会尝试 kill pid=0（即当前进程组），**可能杀死整个 Pi 进程**。 | 在 abort handler 中检查 `child.pid` 是否存在且 > 0，仅在有效 pid 时调用 `killProcessGroup`。 |
| 7 | LOW | spawn.ts:L80-L81 | `exitPromise` 的 `exit` handler 调用 `unpipe` + `destroy`，但 `capture` listener 通过 `removeCapture` 单独移除。若 `removeCapture` 未被调用（异常路径），`child.stdout` 上的 `data` listener 和 chunks 数组会持续持有引用，child process 的 stdout 流不会 GC。 | 在 `exitPromise` resolve/reject 后也移除 capture listener，确保无论哪个路径都能清理。 |

### D3 — 日志

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 5 | LOW | spawn.ts:L147 | `NEVER_RESOLVES = new Promise(() => {})` 永不 resolve，其闭包中捕获了外层 `spawnResult`、`chunks` 等引用。在 timeout=0 的场景下，此 Promise 永不释放。虽然 `Promise.race` 完成后引擎可能 GC 参赛者，但规范不保证。 | 添加注释说明此 Promise 是 race 参赛者，且在 race 完成后不可达。或改用 `AbortController` + `setTimeout` 统一管理。 |
| 12 | INFO | jobs.ts:L15-L18 | `generateJobId` 使用 `Date.now().toString(36)` + 2 字节随机（16 bit），同一毫秒内碰撞概率为 1/65536。高并发场景（10 个 background job 同时启动）碰撞概率不可忽略。 | 增加随机字节到 4（32 bit），或使用 `crypto.randomUUID()` 的前段。 |

### D4 — Fail-fast

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 6 | LOW | jobs.ts:L73-L76 | `killProcessGroup` 发送 SIGTERM 后 `setTimeout(resolve, 5000)` 没有 `unref()`。在 `session_shutdown` 的 `cleanupJobs` 中，这会阻止 Node.js 进程自然退出，必须等 5 秒定时器到期。 | 对定时器调用 `.unref()`：`const timer = setTimeout(resolve, 5000); timer.unref();` |
| 9 | LOW | shell.ts:L42-L54 | `loadPiSettings` 遍历两个配置文件路径，但第一个文件读取成功后立即 `return`，第二个文件（项目级 `.pi/settings.json`）永远不会被读取。这与 Pi 的设置合并逻辑（项目级覆盖用户级）不一致。 | 改为合并策略：先读用户级，再用项目级覆盖。或如设计为只读一个文件则更新注释。 |

### D5 — 测试友好

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 10 | INFO | jobs.ts:L64 | `cleanupJobs` 先将 running jobs 标记为 killed 并 `jobs.clear()`，然后才 `await Promise.allSettled(promises)`。在清理过程中，外部代码（如并发的 poll/kill 调用）无法通过 jobs map 查找这些 job，但 killProcessGroup 仍在执行。虽然 `session_shutdown` 应该不会再有并发调用，但设计上 job 的「invariants」被打破了。 | 考虑在清理完成前保留 jobs map 中的条目，或添加注释说明 shutdown 期间不会有并发访问。 |

### D6 — 调试友好

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 11 | INFO | spawn.ts:L109 | `onUpdate` 的 `forwardData` 每次调用都执行 `Buffer.concat(chunks).toString("utf-8")`，随着 chunks 增长，每次调用是 O(n)。高频输出场景（如 `npm install` 的进度条）会产生大量不必要的全量拼接。 | 使用增量拼接：记录上次 offset，只拼接新增的 chunks。或降低 onUpdate 的调用频率（如 throttle 100ms）。 |

## 问题详细分析

### Issue #1 — 未初始化状态访问（MUST FIX）

**文件**: `index.ts:L96-L103`

```typescript
// L96-L100: session_start 重建状态
let config: BashAsyncConfig;
let shellCtx: ShellContext;
let jobs: Map<...>;

// L101: execute 直接使用 jobs, shellCtx, config
return executeBackground(params.command, process.cwd(), pi, jobs, shellCtx, config);
```

如果 Pi 在 `session_start` 之前调用了 tool（理论上不应该，但 Pi 事件系统无硬性顺序保证），`jobs` 是 `undefined`，运行时会抛出 `TypeError: Cannot read properties of undefined`。这不是一个有意义的错误信息。

**修复方向**: 在 `execute` 入口加 guard：
```typescript
if (!jobs || !config || !shellCtx) {
    throw new Error("bash-async not initialized — session not started");
}
```

---

### Issue #2 — outFile ID 与 jobId 不一致（MUST FIX）

**文件**: `spawn.ts:L73`, `spawn.ts:L215`

`spawnCommand` 内部调用 `createOutFilePath(generateJobId())` 生成临时文件，文件名含 ID-A。后续 `detachJob` 或 `executeBackground` 再调用 `generateJobId()` 生成 jobId（ID-B）。

```
outFile = /tmp/pi-bash-jobs/ba-{ID-A}.out    ← spawnCommand 创建
jobId  = ba-{ID-B}                           ← detachJob/background 创建
job.outFile = outFile (路径含 ID-A)
```

功能上因为 `job.outFile` 保存了正确路径所以不会出错，但：
- 日志中 outFile 名与 jobId 无法关联
- `cleanupJobs` 的 unlink 能正常工作但增加认知负担
- 调试时 `ls /tmp/pi-bash-jobs/` 看到的文件名与 `poll` 返回的 jobId 不匹配

**修复方向**: 让 `spawnCommand` 接收外部生成的 `jobId`，或让调用方先不调 `generateJobId` 而等 spawn 返回后再生成。

---

### Issue #3 — pid=0 的 killProcessGroup 可能杀死 Pi 进程组（MUST FIX）

**文件**: `spawn.ts:L97-L99`

```typescript
if (signal) {
    const onAbort = (): void => {
        killProcessGroup(child.pid ?? 0).catch(...)
    };
}
```

当 spawn 失败时（如 shell 不存在），`child.pid` 为 `undefined`，`child.pid ?? 0` = 0。`killProcessGroup(0)` 在 Unix 上：
- `process.kill(-0, "SIGTERM")` = `process.kill(0, "SIGTERM")` → **向当前进程组的所有进程发送 SIGTERM**，包括 Pi 自身。

虽然 spawn error 后 `exitPromise` 的 reject handler 会先执行，abort signal 的 `onAbort` 可能不会被触发（因为 race 已完成）。但在极端时序下（abort 发生在 spawn error 和 Promise.race 之间），这个路径是可达的。

**修复方向**:
```typescript
const onAbort = (): void => {
    if (child.pid && child.pid > 0) {
        killProcessGroup(child.pid).catch(...)
    }
};
```

---

### Issue #4 — 非 running job 的 outFile 永不清理（MUST FIX）

**文件**: `spawn.ts:L288-L306`

`executeKill` 对已结束的 job 直接返回结果，不调用 `removeOutputFile(job.outFile)`：

```typescript
if (job.status !== "running") {
    const output = readOutputFile(job.outFile);
    const truncated = truncateTail(output);
    return makeResult(...)  // ← outFile 没有被清理
}
```

同理 `executePoll` 对 done/failed job 也不清理。`cleanupJobs` 只在 `session_shutdown` 时清理，但：
- job 完成后 outFile 持续占用磁盘
- 如果 session 很长（多日），临时文件会积累
- 用户的 `poll` 调用是明确的「我已经看完了」信号，应触发清理

**修复方向**: 在 job 到达终态（done/failed/killed）后，首次 poll 或 kill 时清理 outFile 并标记 `job.outFileCleaned = true`。或在 `exitPromise.then` handler 中立即清理（对 background job，注入结果后再删除）。

---

### Issue #6 — session_shutdown 被 5 秒定时器阻塞（LOW）

**文件**: `jobs.ts:L73-L76`

```typescript
await new Promise((resolve) => setTimeout(resolve, 5000));
```

此定时器没有 `unref()`。`cleanupJobs` 在 `session_shutdown` 中调用，5 秒定时器会阻止 Node.js 进程退出。对 10 个并发 job，可能有多个 5 秒定时器并行等待。

**修复方向**: `const timer = setTimeout(resolve, 5000); timer.unref();`

---

### Issue #9 — 项目级 settings.json 被忽略（LOW）

**文件**: `shell.ts:L42-L54`

```typescript
for (const filePath of [userSettingsPath, projectSettingsPath]) {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const data = JSON.parse(raw);
        return { ... };  // ← 第一个成功就返回，项目级文件被跳过
    } catch { void e; }
}
```

Pi 的标准行为是项目级设置覆盖用户级。当前实现只读第一个成功的文件，如果用户级存在则项目级永远不会被读取。

**修复方向**: 分别读取两个文件，用项目级覆盖用户级：
```typescript
const userSettings = tryLoad(userPath);
const projectSettings = tryLoad(projectPath);
return { ...userSettings, ...projectSettings };
```

---

## 总结

| 维度 | MUST FIX | LOW | INFO | 评价 |
|------|----------|-----|------|------|
| D1 错误处理 | 2 | 1 | 0 | 核心路径有未初始化风险和资源泄漏 |
| D2 异常处理 | 1 | 1 | 0 | pid=0 kill 风险严重 |
| D3 日志 | 0 | 1 | 1 | 日志覆盖较好，使用 `console.error` 统一前缀 |
| D4 Fail-fast | 0 | 2 | 0 | 进程退出被阻塞，配置合并有问题 |
| D5 测试友好 | 0 | 0 | 1 | 纯函数较多便于测试，但 spawnCommand 不可 mock |
| D6 调试友好 | 0 | 0 | 1 | outFile ID 与 jobId 不一致增加调试成本 |
| **合计** | **4** | **5** | **3** | |

## 结论

需修改后重审。4 条 MUST FIX 需要在下一轮中确认修复：

1. **#1** — 未初始化状态防御
2. **#2** — outFile ID 与 jobId 不一致
3. **#3** — pid=0 的 killProcessGroup 危险
4. **#4** — 终态 job 的 outFile 永不清理

### Summary

健壮性审查完成，第1轮，4条MUST FIX，需修改后重审。
