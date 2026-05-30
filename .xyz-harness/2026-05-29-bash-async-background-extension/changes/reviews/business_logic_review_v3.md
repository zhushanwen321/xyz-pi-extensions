---
review:
  type: code_review
  round: 3
  timestamp: "2026-05-30T21:00:00"
  target: "bash-async/src/"
  verdict: pass
  summary: "v2 MUST FIX (removeAllListeners 破坏 pipe) 已正确修复。removeCapture() 精确移除 capture listener，保留 pipe listener，WriteStream 在 detach 后继续写入。v2 LOW (kill/bg race condition) 部分修复，kill 时先标记 killed，但 bg exit handler 中 updateJobStatus 覆盖 killed 后再检查，仍有极低概率触发多余通知（维持 LOW，不影响功能正确性）。"

statistics:
  total_issues: 3
  must_fix: 0
  low: 1
  info: 2

issues:
  - id: 3
    severity: LOW
    location: "bash-async/src/spawn.ts:executeBackground() exit handler L189-195 + executeKill() L244-247"
    title: "kill background job 时 bg exit handler 的 updateJobStatus 覆盖 killed 状态后再检查，仍可能触发多余 injectBackgroundResult"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    note: "v3 部分 fix：executeKill 现在先标记 killed 再 kill，但 bg exit handler 先 updateJobStatus('done'/'failed') 覆盖，后检查 status !== 'killed'，检查逻辑仍失效。功能性无影响（进程被正确杀死，结果正确返回），仅产生多余 followUp 通知。"
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
  - id: v2-1
    severity: MUST_FIX
    location: "bash-async/src/spawn.ts:executeBackground() + detachJob()"
    title: "removeAllListeners('data') 破坏 pipe → 输出文件停止写入"
    status: resolved
    raised_in_round: 2
    resolved_in_round: 3
    fix_verification: "改为 removeCapture()，使用 removeListener('data', capture) 精确移除 capture 函数引用，保留 pipe 内部 data listener。WriteStream 在 detach/bg 后持续写入。详见下方验证。"
  - id: v1-1
    severity: MUST_FIX
    location: "bash-async/src/spawn.ts:spawnCommand()"
    title: "ChildProcess 'error' 事件未监听"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: v1-2
    severity: LOW
    location: "bash-async/src/spawn.ts:executeBackground() / detachJob()"
    title: "chunks 数组内存泄漏"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: v1-4
    severity: LOW
    location: "bash-async/src/spawn.ts:executeSync()"
    title: "AbortSignal 终止时消息不匹配 spec"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: v1-5
    severity: LOW
    location: "bash-async/src/spawn.ts:spawnCommand()"
    title: "stdio[0] 使用 'pipe' 而非 spec 要求的 'ignore'"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: v1-8
    severity: INFO
    location: "bash-async/src/index.ts:session_shutdown"
    title: "cleanupJobs 使用动态 import 风格不一致"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
---

# Business Logic Review v3

## 评审记录
- 评审时间：2026-05-30 21:00
- 评审类型：编码评审（业务逻辑正确性专项）——第3轮重审
- 评审对象：bash-async/src/ 全部源代码（v2 修复后版本）
- 对照文档：business_logic_review_v2.md

---

## v2 MUST FIX 验证

### Issue v2-#1: removeAllListeners("data") 破坏 pipe → ✅ 已修复

**修复方案分析：**

1. **SpawnResult 接口扩展**（`spawn.ts` L46-53）：
```typescript
interface SpawnResult {
    child: child_process.ChildProcess;
    outFile: string;
    writeStream: fs.WriteStream;
    exitPromise: Promise<number | null>;
    /** Remove only the in-memory capture listener, keep pipe intact */
    removeCapture: () => void;
}
```

2. **spawnCommand 中 capture 与 removeCapture 定义**（L80-83, L103-106）：
```typescript
const capture = (data: Buffer): void => { chunks.push(data); };
child.stdout?.on("data", capture);
child.stderr?.on("data", capture);
// ...
const removeCapture = (): void => {
    child.stdout?.removeListener("data", capture);
    child.stderr?.removeListener("data", capture);
};
```

3. **调用方使用 removeCapture() 代替 removeAllListeners**：
   - `executeBackground()` L184: `removeCapture()` — 注释 "Stop in-memory capture for background jobs — output goes to file only"
   - `detachJob()` L155: `removeCapture()` — 注释 "Stop in-memory capture — output continues to WriteStream/file only"

**技术正确性验证：**

Node.js Stream 的 `.pipe(dest)` 内部调用 `source.on("data", fn)` 注册监听器。`removeListener("data", capture)` 只移除 `capture` 函数引用的监听器，不影响 pipe 注册的匿名函数。这是 Node.js EventEmitter 的精确匹配语义：`removeListener` 需要传入与 `on` 相同的函数引用才能移除。

**执行路径模拟验证：**

```
UC-2 (Background → auto-inject result):
  1. spawnCommand → child.stdout.pipe(writeStream) + child.stdout.on("data", capture)
     → stdout 上有 2 个 data listener: [pipe内部的, capture]
  2. registerJob(jobs, job) ✅
  3. removeCapture() → removeListener("data", capture) → 只移除 capture
     → stdout 上剩 1 个 data listener: [pipe内部的] ✅
  4. 进程持续运行 → stdout 数据通过 pipe → writeStream → outFile 持续增长 ✅
  5. 进程退出 → exitPromise → readOutputFile(outFile) → 完整输出 ✅
  6. injectBackgroundResult() → agent 收到完整输出 ✅

UC-1 (Sync → timeout detach → poll):
  1-4. 正常 sync 执行 120s，chunks 持续收集 ✅
  5. timeout → detachJob()
  6. removeCapture() → 只移除 capture，pipe 保留 ✅
  7. 进程继续运行 → outFile 持续增长 ✅
  8. poll → readOutputFile → 完整输出（包括 detach 后产生的新输出）✅

UC-3 (Background → poll):
  同 UC-2 验证路径，poll 能读到完整输出 ✅
```

**内存泄漏同时修复：**
- `removeCapture()` 移除 capture listener → chunks 数组不再增长 → 内存泄漏消除 ✅
- 与 pipe 共存，不破坏文件输出 ✅

**结论：Issue v2-#1 已正确修复。核心功能（文件输出捕获）完全恢复。**

---

## v2 LOW 验证

### Issue v2-#3 (原 v1-#3): kill + bg race condition → ⚠️ 部分修复

**v3 修复尝试：**

`executeKill` L244-247：
```typescript
// Mark as killed BEFORE killing to prevent bg exit handler from injecting result
job.status = "killed";

// Kill the process group
await killProcessGroup(job.pid);
```

`executeBackground` exit handler L187-195：
```typescript
exitPromise.then((code) => {
    updateJobStatus(jobs, jobId, code === 0 ? "done" : "failed", code ?? undefined);
    // Only inject result if job wasn't killed
    const currentJob = findJob(jobs, jobId);
    if (currentJob && currentJob.status !== "killed") {
        injectBackgroundResult(pi, job, code, outFile);
    }
})
```

**问题分析：**

executeKill 先标记 `job.status = "killed"` 是正确的方向。但 bg exit handler 中的执行顺序有误：

1. `updateJobStatus(jobs, jobId, "done"/"failed")` — **覆盖**了 "killed" 状态
2. `findJob(jobs, jobId)` — 获取 job，此时 `status` 已是 "done"/"failed"
3. `status !== "killed"` — **检查通过**（因为已被覆盖）
4. `injectBackgroundResult()` — 发送多余通知

**时序：**
```
T0: executeKill: job.status = "killed" (直接赋值) ✅
T1: await killProcessGroup(job.pid)
    → SIGTERM 发出
    → await setTimeout(5000)
T2: 进程收到 SIGTERM 退出 → exit 事件 → exitPromise resolve
T3: bg exit handler (microtask):
    → updateJobStatus("done")     ← 覆盖 "killed" 为 "done"
    → findJob → status = "done"
    → status !== "killed" → true  ← 检查失效
    → injectBackgroundResult()    ← 多余通知 ❌
T4: killProcessGroup 返回
T5: executeKill: updateJobStatus("killed") ← 恢复但通知已发出
```

**修复方向（建议，非阻塞）：**
将 bg exit handler 的检查移到 updateJobStatus 之前：
```typescript
exitPromise.then((code) => {
    const currentJob = findJob(jobs, jobId);
    if (currentJob && currentJob.status === "killed") return;
    updateJobStatus(jobs, jobId, code === 0 ? "done" : "failed", code ?? undefined);
    injectBackgroundResult(pi, job, code, outFile);
})
```

**等级维持 LOW：**
- 进程被正确杀死 ✅
- executeKill 返回正确的 kill 结果 ✅
- 最终 job 状态被修正为 "killed" ✅
- 唯一影响：一个多余的 followUp 通知被发送给 agent（噪声，非功能错误）

---

## AC 覆盖矩阵（最终）

| AC | 场景 | v1 状态 | v2 状态 | v3 状态 | 说明 |
|----|------|---------|---------|---------|------|
| AC-1 | Sync 正常命令 | ✅ | ✅ | ✅ | 不变 |
| AC-2 | Sync 超时 detach | ✅ | ⚠️ | ✅ | outFile 在 detach 后持续写入 |
| AC-3 | Sync 显式 timeout | ✅ | ✅ | ✅ | 不变 |
| AC-4 | Sync 无超时 | ✅ | ✅ | ✅ | 不变 |
| AC-5 | Sync AbortSignal | ⚠️ | ✅ | ✅ | 已修复 |
| AC-6 | Background 模式 | ✅ | ⚠️ | ✅ | outFile 持续写入，auto-inject 完整输出 |
| AC-7 | Poll 查询 | ✅ | ⚠️ | ✅ | 读到完整输出 |
| AC-8 | Kill 终止 | ✅ | ✅ | ✅ | 功能正确，可能有多余通知（LOW） |
| AC-9 | Job 不存在 | ✅ | ✅ | ✅ | 不变 |
| AC-10 | Session 隔离 | ✅ | ✅ | ✅ | 不变 |
| AC-11 | 配置文件 | ✅ | ✅ | ✅ | 不变 |
| AC-12 | Spawn 失败 | ❌ | ✅ | ✅ | 已修复 |
| AC-13 | 非零退出码 | ✅ | ✅ | ✅ | 不变 |
| AC-14 | 输出截断 | ✅ | ✅ | ✅ | 不变 |
| AC-15 | 并发限制 | ✅ | ✅ | ✅ | 不变 |
| AC-16 | Cwd 不存在 | ✅ | ✅ | ✅ | 不变 |
| AC-17 | Shell 兼容性 | ✅ | ✅ | ✅ | 不变 |

---

## 逐 UC 执行路径终验

### UC-1: Sync → 超时 detach → poll ✅

```
1. executeSync → spawnCommand → pipe(writeStream) + on("data", capture)
2. chunks 收集 sync 阶段的输出
3. 120s timeout → detachJob()
4. removeCapture() → 只移除 capture，pipe 保留
5. outFile 持续接收进程输出
6. poll → readOutputFile(outFile) → 完整输出 ✅
```

### UC-2: Background → auto-inject result ✅

```
1. executeBackground → spawnCommand → pipe(writeStream) + on("data", capture)
2. registerJob → removeCapture() → pipe 保留
3. 进程运行 → outFile 持续增长
4. 进程退出 → readOutputFile(outFile) → 完整输出
5. injectBackgroundResult → agent 收到完整结果 ✅
```

### UC-3: Background → poll ✅

```
同 UC-2，poll 读到完整输出 ✅
```

### UC-4: Background → kill ✅（功能正确，有多余通知）

```
1. Background 启动（同 UC-2）
2. kill → job.status = "killed" → killProcessGroup
3. 进程被杀死 ✅
4. bg exit handler 可能发送多余通知（LOW，非阻塞）
5. executeKill 返回正确的 kill 结果 ✅
```

### UC-5: Sync → detach → kill ✅

```
1. Sync → timeout → detach → removeCapture() → pipe 保留
2. outFile 持续增长
3. kill → job.status = "killed" → killProcessGroup → 进程被杀死
4. readOutputFile(outFile) → 含 detach 到 kill 期间的全部输出 ✅
```

---

## 问题汇总

| # | 优先级 | 来源 | 文件/位置 | 描述 |
|---|--------|------|----------|------|
| 3 | LOW | v1→v3 未完全修复 | spawn.ts:executeBackground() + executeKill() | kill bg job 时 bg exit handler 的 updateJobStatus 先覆盖 "killed" 状态，后检查 status !== "killed" 失效，可能触发多余 injectBackgroundResult 通知。功能性无影响。建议将检查移到 updateJobStatus 之前。 |
| 6 | INFO | v1 沿用 | spawn.ts:spawnCommand() | outFile ID 与 jobId 不一致（可接受） |
| 7 | INFO | v1 沿用 | spawn.ts:spawnCommand() | 每次 sync 都创建临时文件（可接受） |

---

## 结论

**verdict: pass**

v2 MUST FIX（`removeAllListeners("data")` 破坏 pipe 导致输出文件停止写入）已正确修复。修复方案使用 `removeCapture()` 精确移除 capture 函数引用，保留 pipe 内部 listener。经执行路径验证，background 模式和 sync-detach 模式的 outFile 在 detach 后持续写入，poll 和 auto-inject 均能读到完整输出。

v2 LOW（kill/bg race condition）部分改善（executeKill 先标记 killed），但 bg exit handler 内 updateJobStatus 覆盖后再检查的逻辑仍有缺陷，可能导致多余通知。等级维持 LOW，不影响功能正确性。

所有 MUST FIX 问题已解决，剩余 1 条 LOW + 2 条 INFO 均不阻塞发布。
