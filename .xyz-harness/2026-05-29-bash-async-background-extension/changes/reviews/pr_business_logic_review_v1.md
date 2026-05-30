---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-30T12:00:00"
  target: "bash-async/"
  verdict: fail
  summary: "编码评审第1轮，1条MUST FIX（exit事件导致输出数据丢失），3条LOW，3条INFO"

statistics:
  total_issues: 7
  must_fix: 1
  must_fix_resolved: 0
  low: 3
  info: 3

issues:
  - id: 1
    severity: MUST_FIX
    location: "bash-async/src/spawn.ts:L91-L97"
    title: "exit 事件早于 stdio drain，writeStream.destroy() 丢弃未刷写数据"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "bash-async/src/index.ts:L155-L185 (renderResult)"
    title: "Sync 模式缺少 setInterval 耗时刷新（FR-8 规定行为）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "bash-async/src/spawn.ts:L177-L182"
    title: "onUpdate 每次 data 事件调用 getBufferContent 导致 O(n²) 性能问题"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "bash-async/src/shell.ts:L53-L68"
    title: "loadPiSettings 首个文件命中即返回，项目级 settings 被跳过"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: INFO
    location: "bash-async/src/spawn.ts:L77,L238"
    title: "outFile 名与 jobId 不匹配，调试时增加认知负担"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: INFO
    location: "bash-async/tests/integration.test.ts:L1-L528"
    title: "测试内联重实现核心函数而非导入生产代码"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: INFO
    location: "bash-async/src/index.ts:L75-L77"
    title: "session 变量未初始化，依赖 Pi 事件顺序保证安全性"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 编码评审 v1 — bash-async 业务逻辑审查

## 评审记录
- 评审时间：2026-05-30 12:00
- 评审类型：编码评审（业务逻辑维度）
- 评审对象：bash-async/ 全部变更文件
- 对照标准：spec.md FR-1 ~ FR-12, AC-1 ~ AC-17, UC-1 ~ UC-5

## 审查方法

对每个 UC 构造模拟数据，沿代码执行路径逐行推演，验证：
1. UC 主流程覆盖
2. UC 异常路径覆盖
3. 数据在管道中不丢失、不损坏

---

## UC 推演验证

### UC-1: 长时间编译 (`cargo build --release`)

**模拟数据**: `command: "cargo build --release"`, defaultTimeout=120, 无显式 timeout

**执行路径推演**:

1. `execute` (index.ts:103) → 无 pollJobId/killJobId/background → sync 路径
2. `executeSync` (spawn.ts:155): effectiveTimeout = 120
3. `spawnCommand` (spawn.ts:65):
   - outFile = `$TMPDIR/pi-bash-jobs/ba-{tsA}-{randA}.out` (L77)
   - child process spawned, detached=true, stdio=pipe (L81-86)
   - stdout+stderr → pipe → writeStream (to outFile) + capture → chunks[] (L88-95)
4. onUpdate callback attached for streaming (spawn.ts:177-182)
5. Promise.race([exitPromise, timeoutPromise]) (spawn.ts:194)
6. **120s 后 timeoutPromise resolves null, timedOut=true** (spawn.ts:185-189)
7. `detachJob` (spawn.ts:228):
   - 新 jobId 生成 (L238) → `ba-{tsB}-{randB}`（与 outFile 名不同，见 issue #5）
   - Job 注册到 map (L249)
   - `removeCapture()` 停止内存增长 (L252) — pipe→writeStream 保持
   - exitPromise.then 注册退出回调 (L255-258)
   - 返回部分输出 + jobId + hint

**推演结论**: 主流程正确 ✅。AI 收到 jobId 后可 poll 查询编译结果。

**⚠️ 数据丢失风险** (Issue #1): 当编译进程最终退出时，spawnCommand 的 exit handler 在 'exit' 事件触发时立即 unpipe + destroy writeStream。Node.js 文档明确指出 `'exit'` 事件在 stdio 流关闭之前触发。此时如果 writeStream 内部仍有未刷写的数据缓冲，或 stdout 还有未从内核 pipe buffer 读取的数据，这些数据将丢失。对于长时间编译命令，通常输出是渐进写入的，但退出前最后一批输出（如 "Build finished" 摘要）可能丢失。

---

### UC-2: 测试套件 (`npm test`, background 模式)

**模拟数据**: `command: "npm test", background: true`

**执行路径推演**:

1. `execute` → background=true → `executeBackground` (index.ts:119)
2. `executeBackground` (spawn.ts:270):
   - validateCwd ✅
   - runningJobCount < maxBackgroundJobs ✅ (FR-12)
   - spawnCommand → child, outFile, exitPromise, removeCapture
3. jobId 生成，job 注册 (spawn.ts:290-304)
4. removeCapture() — 内存中 chunks 停止增长 (L307)
5. exitPromise.then (spawn.ts:310-318):
   - updateJobStatus → "done" or "failed"
   - findJob 检查 status !== "killed" → injectBackgroundResult
6. 立即返回 jobId 确认信息 (spawn.ts:320-322)
7. 进程完成后 injectBackgroundResult (spawn.ts:275-300):
   - readOutputFile 读取 outFile
   - truncateTail 截断
   - pi.sendMessage 注入结果（try-catch 包裹）

**推演结论**: 主流程覆盖 ✅。

**🔴 MUST FIX (Issue #1)**: 注入结果是 **不完整的**。模拟场景：

```
进程输出 100KB 测试日志 → 渐进写入 outFile ✅
进程最后写入 2KB 测试摘要到 stdout → 数据进入内核 pipe buffer
进程调用 exit(0)
Node.js 触发 'exit' 事件
  → spawnCommand exit handler:
    → child.stdout?.unpipe(writeStream)  // 阻止后续数据流入
    → child.stderr?.unpipe(writeStream)
    → writeStream.destroy()              // 丢弃 writeStream 内部缓冲
    → resolve(0)
exitPromise resolves
  → injectBackgroundResult 读 outFile → 只有 98KB
  → pi.sendMessage 注入不完整结果
```

Node.js 文档原文：
> Note that the child process stdio streams might still be open when the 'exit' event is emitted.

这意味着 exitPromise resolve 时，stdout 可能还有数据未被处理。数据丢失三层：
1. 内核 pipe buffer 中未读数据（stdout 还没读到）
2. stdout Readable buffer 中已读但未 push 到 writeStream 的数据（unpipe 阻止了）
3. writeStream 内部 write buffer 中未刷到磁盘的数据（destroy 丢弃了）

**实际影响**: `npm test` 的测试摘要（pass/fail 计数）通常是最后输出，会被截断。对 AI 判断测试结果造成严重影响。

**修复方向**: 将 `child.on("exit", ...)` 改为 `child.on("close", ...)`，并使用 `writeStream.end()` 替代 `writeStream.destroy()`。`close` 事件在 stdio 流完全关闭后触发，确保所有数据已通过 pipe 写入。

---

### UC-3: 部署脚本 (`./deploy.sh`, background + poll)

**模拟数据**: `command: "./deploy.sh", background: true` → 定期 poll

**执行路径推演**:

1. Background 启动（同 UC-2）
2. AI 调用 `pollJobId: "ba-xxx"` → `executePoll` (spawn.ts:333)
3. findJob → 找到 job ✅
4. readOutputFile(job.outFile) → 读取当前已写入部分
5. truncateTail 截断 ✅
6. 返回 status + output + elapsed time

**推演结论**: Poll 路径正确 ✅。但受 Issue #1 影响——如果进程刚好退出，poll 可能读到不完整数据。

---

### UC-4: 开发服务器 (`npm run dev`, background + kill)

**模拟数据**: `command: "npm run dev", background: true` → 需要时 kill

**执行路径推演**:

1. Background 启动 ✅
2. AI 调用 `killJobId: "ba-xxx"` → `executeKill` (spawn.ts:363)
3. findJob → job 存在 ✅
4. job.status === "running" → 进入 kill 路径
5. 注册 exit listener BEFORE killing（避免竞态）✅ (spawn.ts:386-391)
6. `job.status = "killed"` 标记（阻止 bg exit handler 注入结果）✅ (spawn.ts:394)
7. `await killProcessGroup(job.pid)` — SIGTERM, 5s 后 SIGKILL ✅
8. Promise.race 等待 exit 或 6s 超时 ✅
9. updateJobStatus → "killed" ✅
10. readOutputFile + truncateTail → 返回 kill 前的输出 ✅

**推演结论**: Kill 路径设计合理 ✅。先标记 killed 再 kill 的顺序正确避免了 bg exit handler 的重复注入。

**竞态验证**: 测试了 "进程在 kill 前自然退出" 的场景：
- 如果 job.child.exitCode !== null → exitPromise 直接 resolve ✅
- 如果进程在 killProcessGroup 和 exit listener 之间退出 → exit listener 仍会触发 ✅

---

### UC-5: 卡住的命令（120s 超时 detach）

**模拟数据**: `command: "cat"` (等待 stdin，无输出), defaultTimeout=120

**执行路径推演**:

1. executeSync: effectiveTimeout=120
2. spawnCommand: 进程启动，无 stdout/stderr 数据
3. onUpdate 注册但无 data 事件触发 → 无 streaming 更新
4. 120s 后 timeoutPromise resolves null, timedOut=true
5. detachJob: 返回 jobId + 提示信息
6. 进程仍在运行 ✅

**推演结论**: 超时 detach 正确 ✅。

**⚠️ 缺失行为** (Issue #2): FR-8 规定 "Sync 模式执行中使用 setInterval + context.invalidate() 每秒刷新耗时显示"。当前实现仅在 data 事件时触发 onUpdate。对于无输出的命令（如 `cat`），120s 内 TUI 无任何更新，用户看到冻结界面。

---

## AC 合规矩阵

| AC | 场景 | 覆盖状态 | 代码位置 | 备注 |
|----|------|---------|----------|------|
| AC-1 | Sync echo hello | ✅ | spawn.ts:155-215 | 正常路径，truncate + return |
| AC-2 | Sync 超时 detach | ✅ | spawn.ts:228-267 | detachJob 注册 job + removeCapture |
| AC-3 | Sync 显式 timeout | ✅ | spawn.ts:162 | effectiveTimeout = params.timeout |
| AC-4 | Sync 无超时 | ✅ | spawn.ts:185-189 | timeout=0 → NEVER_RESOLVES |
| AC-5 | Sync AbortSignal | ✅ | spawn.ts:101-109 | signal abort → killProcessGroup |
| AC-6 | Background 模式 | ⚠️ | spawn.ts:270-322 | **Issue #1**: 注入结果可能丢失尾部数据 |
| AC-7 | Poll 查询 | ✅ | spawn.ts:333-360 | 读取 outFile + truncateTail |
| AC-8 | Kill 终止 | ✅ | spawn.ts:363-420 | 先标记 killed 再 kill |
| AC-9 | Job 不存在 | ✅ | spawn.ts:337, 369 | findJob 返回 undefined → makeErrorResult |
| AC-10 | Session 隔离 | ✅ | index.ts:75-80 | 闭包 Map |
| AC-11 | 配置文件 | ✅ | jobs.ts:120-148 | catch → 默认值 |
| AC-12 | Spawn 失败 | ✅ | spawn.ts:192-199 | exitPromise reject → makeErrorResult |
| AC-13 | 非零退出码 | ✅ | spawn.ts:208-210 (throw), injectBackgroundResult (FAILED) |
| AC-14 | 输出截断 | ✅ | spawn.ts 引用 truncateTail | 未验证截断格式字符串（依赖 Pi API） |
| AC-15 | 并发限制 | ✅ | spawn.ts:275-280 | runningJobCount >= max → error |
| AC-16 | Cwd 不存在 | ✅ | spawn.ts:30-40 | validateCwd throw ENOENT |
| AC-17 | Shell 兼容性 | ✅ | shell.ts:68-74 | 使用 Pi 的 getShellConfig |

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | spawn.ts:L91-L97 | **exit 事件导致输出数据丢失**。`spawnCommand` 的 exit handler 在 `'exit'` 事件时立即 unpipe + destroy writeStream。Node.js 文档明确 `'exit'` 在 stdio 流关闭前触发。三层数据丢失：(a) 内核 pipe buffer 未读数据；(b) stdout Readable buffer 中被 unpipe 阻止的数据；(c) writeStream 内部 buffer 被 destroy 丢弃的数据。Background 模式注入结果会丢失尾部输出（如测试摘要）。 | 将 `child.on("exit", ...)` 改为 `child.on("close", ...)`。`close` 事件在 stdio 完全关闭后触发。同时 `writeStream.destroy()` 改为 `writeStream.end()` 以刷写内部缓冲。`error` handler 保持不变。 |
| 2 | LOW | index.ts:L155-L185 (renderResult) | **Sync 模式缺少耗时刷新**。FR-8 规定 "使用 setInterval + context.invalidate() 每秒刷新耗时显示"。当前实现仅在 data 事件触发 onUpdate。对于无输出命令（`sleep`/`cat`），TUI 冻结直到超时。 | 在 executeSync 中添加 setInterval 每 1s 调用 onUpdate 传递 elapsed time。在 Promise.race 结束后 clearInterval。 |
| 3 | LOW | spawn.ts:L177-L182 | **onUpdate 性能 O(n²)**。每次 data 事件调用 `getBufferContent(chunks)` 对所有已收集 chunks 执行 `Buffer.concat().toString()`。10MB 输出分 1000 个 chunk 会创建约 5GB 临时字符串。 | 改为增量更新：维护一个 `let lastUpdateLen` 变量，仅传递 `chunks.slice(lastUpdateLen)` 的新内容，或在 onUpdate 中直接传递 chunks 引用而非完整字符串。 |
| 4 | LOW | shell.ts:L53-L68 | **loadPiSettings 首个文件命中即返回**。全局 `~/.pi/agent/settings.json` 存在但缺少 shellPath 时，返回 `{}` 不检查项目级 `.pi/settings.json`。项目级配置被静默忽略。 | 改为合并策略：先读全局，再读项目级，项目级字段覆盖全局。或改为从项目级开始查找（项目级优先）。 |
| 5 | INFO | spawn.ts:L77,L238 | outFile 使用 `generateJobId()` 生成文件名，但 job 的 jobId 在后续 `detachJob`/`executeBackground` 中独立生成。文件名 `ba-{A}` 与 jobId `ba-{B}` 不匹配，调试时需交叉查找。 | 将 jobId 生成提前到 spawnCommand 调用之前，传入 spawnCommand 作为参数。 |
| 6 | INFO | tests/integration.test.ts | 测试内联重实现了 spawnCommand、killProcessGroup 等核心函数，而非导入 `src/spawn.ts`。测试验证的是副本行为而非生产代码。TC-11-01 硬编码配置值而非调用 `loadConfig`。 | 已知约束：避免 Pi 运行时依赖。记录为技术债务，后续可通过 mock Pi API 改进。 |
| 7 | INFO | index.ts:L75-L77 | `config`、`shellCtx`、`jobs` 声明为 `let` 但未初始化。若 execute 在 session_start 前被调用将抛 TypeError。 | 实际安全：Pi 保证 session_start 先于 execute。可加默认值或 `!` 断言增强健壮性。 |

### 等级判定校准说明

- **Issue #1 标 MUST_FIX 的理由**: 数据丢失属于 "数据无法到达预期目的地"（等级判定规则第 1 条）。生产环境下 `npm test` 的测试摘要会被截断，导致 AI 误判测试结果。
- **Issue #2 标 LOW 的理由**: 功能正确（命令正常执行），但缺少 UX 增强。不满足 "功能不可用或数据错误" 的 MUST_FIX 阈值。
- **Issue #3 标 LOW 的理由**: 性能问题仅在超大输出时显现，不影响正确性。实际场景中大多数命令输出 < 1MB。

---

## 数据流完整性验证

### Background 模式数据流

```
child stdout → [pipe] → writeStream → [fs write] → outFile → readOutputFile → truncateTail → sendMessage
                 ↓
              capture → chunks[] (background 模式立即 removeCapture，不使用)
```

**验证点**:
- pipe → writeStream: 持续直到进程退出 ✅
- writeStream → outFile: **Issue #1** — exit 时 destroy 可能丢数据 ❌
- readOutputFile: 同步读取，时序正确 ✅
- truncateTail: 使用 Pi 导出函数 ✅
- sendMessage: try-catch 包裹，session shutdown 安全 ✅

### Sync-Detach 数据流

```
timeout 触发 → removeCapture (停止内存增长) → pipe → writeStream → outFile (持续)
                                                ↓
                                            detachJob 返回部分输出
```

**验证点**:
- removeCapture 只移除 capture listener，不影响 pipe ✅
- pipe 持续到进程退出 → outFile 持续增长 ✅
- 进程退出后 exitPromise.then → updateJobStatus ✅
- poll 读取 outFile 时数据完整（受 Issue #1 影响）⚠️

---

## 结论

**需修改后重审**

Issue #1 (MUST_FIX) 是进程生命周期管理中的核心数据完整性问题。修复方案明确（exit → close, destroy → end），改动集中（spawn.ts L91-97 一处），不影响其他模块。修复后建议重跑 background 模式的集成测试验证数据完整性。

### Summary

编码评审完成，第1轮，1条MUST FIX（exit 事件数据丢失），需修复后重审。
