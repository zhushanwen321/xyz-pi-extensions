---
verdict: fail
must_fix: 2

review:
  type: plan_review
  round: 1
  timestamp: "2026-05-20T16:30:00"
  target: ".superpowers/2026-05-20-subagent-tui/plan.md"
  verdict: fail
  summary: "计划评审完成，第1轮，2条MUST FIX，需修改后重审"

statistics:
  total_issues: 5
  must_fix: 2
  must_fix_resolved: 0
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 5 Step 1 (ThrottleState.forceEmit)"
    title: "ThrottleState.forceEmit() 实现错误，forceEmit 后 shouldEmit 仍返回 false"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 8 (missed rmdirSync at L765, L887)"
    title: "Task 8 遗漏 background job 的 rmdirSync 清理，会删除共享固定目录"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "plan.md:Task 2 Step 4"
    title: "Step 4 声称 '3 places' 但只列出 2 个，描述不准确"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "plan.md:Task 4 (renderParallelTable, renderAgentRow)"
    title: "并行汇总行在 token/cost 为 0 时仍显示（与现有 formatUsageStats 隐藏零值的习惯不一致）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: INFO
    location: "plan.md:all tasks"
    title: "行号引用为近似值，执行时需按函数名/结构定位"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-20 16:30
- 评审类型：计划评审
- 评审对象：`.superpowers/2026-05-20-subagent-tui/plan.md` + `spec.md` + `e2e-test-plan.md` + 源文件 `index.ts`（1754行）

## 逐维度评审

### 1. Spec 完整性

| 检查项 | 结果 |
|--------|------|
| 目标是否明确 | 通过 — 一段话说清：优化并行执行的 TUI 体验 |
| 范围是否合理 | 通过 — 单文件修改，8 个 AC，边界清晰 |
| 验收标准是否可量化 | 通过 — AC1 有格式示例（234ms/3.5s/2m15s），AC2 有明确阈值（500ms），AC3 有表格结构，AC5 有具体逻辑描述，AC6 有时间阈值（1小时） |
| 待决议项 | 无 |

### 2. Plan 可行性

| 检查项 | 结果 |
|--------|------|
| 任务拆分 | 通过 — 8 个 task，粒度适中，每个 task 可由一个 subagent 独立完成 |
| 依赖关系 | 通过 — Task 1→2→3→4 主链正确，Task 7/8 独立，Task 5 依赖 T2，Task 6 依赖 T4 |
| 工作量估算 | 通过 — L1 单文件，8 个 task 总工作量合理 |
| 遗漏 task | **有问题** — Task 8 遗漏 background job 清理代码（见 MUST FIX #2） |

### 3. Spec 与 Plan 一致性

逐条 AC 对照：

| AC | 覆盖 Task | 状态 |
|----|-----------|------|
| AC1: 执行时间显示 | T1, T2, T3, T4 | 覆盖 |
| AC2: 并行节流 ≤500ms | T5 | 覆盖（但有实现 bug，见 MUST FIX #1） |
| AC3: 并行 collapsed 表格 | T4 | 覆盖 |
| AC4: 错误聚合 isError | T6 | 覆盖 |
| AC5: getFinalOutput 修复 | T7 | 覆盖 |
| AC6: 临时文件清理 | T8 | 覆盖（但有遗漏，见 MUST FIX #2） |
| AC7: single/chain 行为不变 | T4 | 覆盖 — renderSingleCollapsedText/renderChainCollapsedText 保留 tool call 显示 |
| AC8: single/chain 不节流 | T5 | 覆盖 — plan 明确说仅并行模式节流 |

Plan 中无 spec 未提及的额外工作。

### 4. Execution Groups 合理性

单文件项目，G1 单组串行执行，合理。Wave 编排逻辑正确（T7/T8 独立 → T1→T2→T3→T4→T5/T6 主链）。

---

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST_FIX | plan.md:Task 5 Step 1 | **ThrottleState.forceEmit() 实现错误**。`forceEmit()` 设置 `lastEmitTime = Date.now()`，之后 `emitParallelUpdate()` 调用 `shouldEmit()` 时，`now - lastEmitTime ≈ 0 < 500`，返回 false，导致 agent 完成后的最终状态更新**永远不会发送**。这是一个数据不可达问题：agent 完成时的最终状态无法传递到 TUI。 | `forceEmit()` 应改为 `this.lastEmitTime = 0;`，使 `shouldEmit()` 的下一次调用必定返回 true。或者在 `emitParallelUpdate` 中增加 `force` 参数绕过 `shouldEmit()`。前者更简单。 |
| 2 | MUST_FIX | plan.md:Task 8 | **Background job 的 rmdirSync 清理遗漏**。源文件有 3 处 `rmdirSync` 调用：(1) L684 `runSingleAgent` finally 块 — plan 已处理；(2) L765 `startBackgroundJob` 的 `proc.on("close")` — **未处理**；(3) L887 `cleanupJob` 函数 — **未处理**。Task 8 将 `writePromptToTempFile` 改为使用固定共享目录 `os.tmpdir()/pi-subagent/`，但遗漏了 L765 和 L887。`startBackgroundJob`（L722）也调用 `writePromptToTempFile`，其 `proc.on("close")` 的 `fs.rmdirSync(promptDir)` 会尝试删除共享目录。如果目录内无其他文件，rmdir 成功，导致正在运行的并行 agent 找不到临时目录。 | Task 8 需增加 Step，同步修改：(1) `startBackgroundJob` 的 `proc.on("close")` handler（L764-765）—— 删除 `fs.rmdirSync(promptDir)` 块；(2) `cleanupJob` 函数（L886-887）—— 删除 `fs.rmdirSync(job.promptDir)` 块。两处只保留 promptFile 的 unlinkSync。 |
| 3 | LOW | plan.md:Task 2 Step 4 | 描述文字声称 "3 places that construct SingleResult objects (besides runSingleAgent)" 但只列出 Site 1（unknown agent fallback，实际在 runSingleAgent 内部）和 Site 2（parallel pre-init）。措辞有歧义，不影响功能。 | 改为 "2 other SingleResult initialization sites" 更准确。 |
| 4 | LOW | plan.md:Task 4 (renderParallelTable, renderAgentRow) | `renderAgentRow` 中 `if (view.tokens.input)` 和 `if (view.cost)` 只在非零时显示，但 `renderParallelTable` 的 Total 行无条件显示 `↑${formatTokens(view.aggregateTokens.input)}`，即使聚合 token 为 0。与现有代码中 `formatUsageStats` 跳过零值的习惯不一致。 | `renderParallelTable` 的 Total 行对 input/output/cost 加零值判断，与 `renderAgentRow` 保持一致。 |
| 5 | INFO | plan.md:all tasks | 所有行号引用为近似值（如 "~line 545"），这是预期的。执行时需按函数名定位。 | 无需操作。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

### MUST FIX 问题详细分析

#### Issue #1: ThrottleState.forceEmit() 逻辑错误

**问题链路：**
```
agent 完成 → throttle.forceEmit() → lastEmitTime = Date.now()
           → emitParallelUpdate() → throttle.shouldEmit()
           → now - lastEmitTime ≈ 0 < 500 → false → onUpdate 未调用
           → 最终状态丢失，TUI 停留在倒数第二次更新
```

**验证方式：** 阅读源码，按执行顺序模拟 `Date.now()` 返回值。同一 tick 内两次 `Date.now()` 差值 < 1ms，远小于 500ms 阈值。

**影响范围：** 所有并行执行场景。每个 agent 完成时的最终状态更新全部失效。用户看到的 TUI 状态永远是过时的，直到 500ms 节流窗口自然触发下一次更新（如果有其他 agent 仍在推送）。当最后一个 agent 完成时，如果之前 500ms 内没有其他 agent 更新，最终状态将永远不会显示。

#### Issue #2: Background job rmdirSync 遗漏

**问题链路：**
```
writePromptToTempFile 改为返回固定目录 os.tmpdir()/pi-subagent/
→ startBackgroundJob 写入 promptFile 到该目录
→ proc.on("close") 调用 fs.rmdirSync(promptDir)
→ 如果目录内无其他文件，rmdir 成功
→ 其他正在运行的 agent 的 temp file 路径失效
```

**遗漏位置：**
- L764-765: `startBackgroundJob` → `proc.on("close")` handler
- L886-887: `cleanupJob` 函数

**验证方式：** `grep -n "rmdirSync" index.ts` 确认 3 处调用，plan 仅处理了 1 处（L684）。

---

### 结论

需修改后重审。两条 MUST FIX 均为功能性问题：#1 导致并行模式 agent 完成状态丢失，#2 导致 background 模式可能破坏共享临时目录。

### Summary

计划评审完成，第1轮，2条MUST FIX，需修改后重审。
