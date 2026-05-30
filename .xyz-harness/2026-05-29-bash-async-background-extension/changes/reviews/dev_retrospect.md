---
phase: dev
verdict: pass
---

# Dev Phase Retrospect — bash-async-background-extension

## 1. Phase Execution Review

### Summary

bash-async 扩展从零实现了一个异步 bash 工具，覆盖四种模式（sync / background / poll / kill），总计约 1000 行 TypeScript，分布在 7 个文件中（`index.ts`, `types.ts`, `shell.ts`, `jobs.ts`, `spawn.ts`, `package.json`）。代码通过了 `tsc --noEmit`（0 errors）和 ESLint（0 errors, 6 warnings），五步专项审查全部 PASS，17 条 AC 全部覆盖。

### Problems Encountered

**Round 1 共发现 6 条 MUST FIX：**

1. **BLR-1 / Robustness-2**：`ChildProcess 'error'` 事件未监听，ENOENT/EACCES 导致 uncaught exception。修复方式：在 `spawnCommand` 中注册 `child.on("error", reject)` 并在调用方 `try/catch` 中捕获。

2. **Standards-1**：`pi-tui` import 使用了 `@earendil-works` scope 而非 CLAUDE.md 规定的 `@mariozechner` 公约数。全局搜索修复。

3. **Standards-2**：`fs` import 出现在 `spawn.ts` 文件中间（L44）而非顶部。移至 import 区。

4. **Robustness-1**：`WriteStream` 在进程异常退出 / error 事件时未调用 `destroy()`，导致资源泄漏。在 `exit` 和 `error` handler 中均添加 `writeStream.destroy()`。

5. **Robustness-3**：`executeKill` 中 exit listener 在 `killProcessGroup` 之后注册，存在竞态条件——进程可能在 listener 注册前就退出。改为 kill 前注册，并用 `exitCode !== null` 快速路径处理已退出进程。

6. **BLR-v2**（Round 2 发现）：`removeAllListeners("data")` 破坏了 `pipe(writeStream)` 内部注册的匿名 listener，导致 detach 后 outFile 停止写入。这是最严重的 bug——直接破坏核心功能。修复方案：将 capture 函数存为命名引用，用 `removeCapture()` 精确移除，保留 pipe listener。

**Round 3 达成全 PASS**，仅剩 1 LOW（kill/bg race condition 导致多余 followUp 通知，功能性无影响）+ 2 INFO。

### What Would You Do Differently

1. **`removeAllListeners` 是一个本应在一开始就避免的错误**。Node.js `pipe()` 内部使用匿名 `on("data", fn)` 注册 listener，`removeAllListeners("data")` 会一并移除。这在编码阶段就应通过阅读 Node.js Stream 文档或参考 subagent 扩展中类似模式来避免，而非等到 review Round 2 才发现。

2. **spawn + pipe + capture 三路并行的架构应在编码前用伪代码推演**。`stdout` 上同时有 `pipe(writeStream)` 和 `on("data", capture)` 两个消费者，detach 时只移除 capture 的需求应在设计阶段明确记录，避免"先写 removeAllListeners 再修 removeCapture"的返工。

3. **error 事件处理是 child_process 编程的基本功**，6 条 MUST FIX 中有 3 条（error 事件、WriteStream 泄漏、race condition）属于"启动进程后的资源管理"范畴。编码阶段应有一个 checklist（注册 error handler、exit handler、cleanup path）。

### Key Risks for Later Phases

1. **kill/bg race condition（LOW）**：`executeKill` 先标记 `killed`，但 bg exit handler 的 `updateJobStatus` 覆盖后再检查 `status !== "killed"`，检查失效。可能导致多余 followUp 通知。功能性无影响，但如果用户对通知噪声敏感，后续可修复（将检查移到 updateJobStatus 之前）。

2. **cleanupJobs 中 unlink 在 kill 之前执行**（LOW）：`unlinkSync` 先于 `killProcessGroup` 运行。Unix 下 inode 机制保证正确性，但在 Windows 上可能有差异。

3. **background spawn error 路径 job 状态未更新**（LOW）：ENOENT 触发 exitPromise reject 后，`.catch()` 仅日志，job 保持 "running" 直到 session shutdown。

---

## 2. Harness Usability Review

### Flow Friction

五步审查流程（Business Logic → Standards → Taste → Robustness → Integration）运行顺畅。每步的 review prompt 对审查维度和输出格式有明确指引，subagent 能独立执行并产出结构化报告。BLR 从 v1 到 v3 共三轮（Round 2 发现 `removeAllListeners` bug 是关键转折），Standards 和 Robustness 各两轮，Taste 和 Integration 各一轮。多轮迭代是自然节奏，没有出现"审了又审但发现不了问题"的停滞。

### Gate Quality

Gate check（GL1 脚本）正确验证了文件存在性和 frontmatter 格式。五步审查的 verdict 判定准确——MUST FIX 全部修复后才给 pass，没有漏判。Integration review v1 即 pass（0 MUST FIX），说明前四步审查已经充分暴露了模块内问题，集成层面无断裂。

### Prompt Clarity

各审查维度的 prompt 对审查重点、输出格式、AC 对照有清晰指引。BLR 特别强调了 AC 覆盖矩阵和 UC 执行路径推演，这在验证 `removeCapture` 修复时发挥了关键作用——审查者通过模拟 UC-1/UC-2/UC-3 的完整执行路径确认修复正确性。Integration review 的五维检查清单（模块协作、数据流、生命周期、工具覆盖、配置传递）结构清晰，一轮即 pass。

### Automation Gaps

无明显自动化缺口。tsc + ESLint 自动检查已在 review 前执行，五步审查由 subagent 独立完成。唯一的 manual 步骤是阅读 review 结果后决定是否需要修改代码再重审——这是人类 judgment 的合理介入点。

### Time Sinks

`removeAllListeners("data")` bug 是最大的时间消耗——Round 2 BLR 发现后需要修复、重审（v3），影响链条包括 spawn.ts 的 `spawnCommand`、`executeBackground`、`detachJob` 三个调用点。如果编码阶段有"stream listener 管理"的 checklist 或参考模式，可以节省约一轮 review-修复-review 的迭代。
