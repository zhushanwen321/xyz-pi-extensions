---
review:
  type: plan_review
  round: 2
  timestamp: "2026-05-20T17:05:00"
  target: ".superpowers/2026-05-20-subagent-tui/plan.md"
  verdict: pass
  summary: "第2轮评审通过。v1 的 2 条 MUST FIX 和 2 条 LOW 全部修复。发现 2 条新 LOW（renderParallelTable 死代码 + renderParallelDetail 零值遗漏），不阻塞，建议实施前清理。"

statistics:
  total_issues_v1: 4
  must_fix_v1: 2
  must_fix_resolved: 2
  low_v1: 2
  low_resolved: 2
  new_issues_this_round: 2
  total_open: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 5 Step 1 (ThrottleState.forceEmit)"
    title: "ThrottleState.forceEmit() 实现错误"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "forceEmit() 已改为 `this.lastEmitTime = 0;`（line 777），使 shouldEmit() 下一次调用必定返回 true。验证通过。"
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 8 Step 4"
    title: "Task 8 遗漏 background job 的 rmdirSync 清理"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "Task 8 Step 4 现在明确覆盖了全部 3 处 rmdirSync：（1）runSingleAgent finally（line 1002），（2）startBackgroundJob proc.on('close')（line 1005-1010），（3）cleanupJob 函数（line 1014）。验证通过。"
  - id: 3
    severity: LOW
    location: "plan.md:Task 2 Step 4"
    title: "Step 4 描述声称 '3 places' 但只列出 2 个"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "描述已改为 '2 other places'（line 210），与列出的 2 个 site 一致。验证通过。"
  - id: 4
    severity: LOW
    location: "plan.md:Task 4 Step 3 (renderParallelTable)"
    title: "renderParallelTable Total 行缺少零值判断"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "Total 行已添加零值判断：`aggregateTokens > 0`（line 502）和 `aggregateCost > 0`（line 505），与 renderAgentRow 一致。验证通过。"
  - id: 5
    severity: LOW
    location: "plan.md:Task 4 Step 3 (renderParallelTable — totalParts)"
    title: "renderParallelTable 中的 totalParts 数组为死代码"
    status: open
    raised_in_round: 2
    resolved_in_round: null
    detail: "lines 498-500 声明并填充了 `totalParts` 数组，但后续从未引用。实际的输出使用 `totalLine` 数组（lines 501-509）。`totalParts` 应删除，避免实施者照搬死代码到源文件。"
  - id: 6
    severity: LOW
    location: "plan.md:Task 4 Step 4 (renderParallelDetail — Total 行)"
    title: "renderParallelDetail 的 Total 行缺少零值判断"
    status: open
    raised_in_round: 2
    resolved_in_round: null
    detail: "lines 544-548 的 renderParallelDetail Total 行无条件显示 `↑${formatTokens(aggregateTokens.input)}` 和 `$${aggregateCost.toFixed(4)}`。与 renderAgentRow（零值隐藏）和修复后的 renderParallelTable（零值判断）不一致。建议加入相同的零值检查。"
---

# 计划评审 v2

## 评审记录

- 评审时间：2026-05-20 17:05
- 评审类型：计划评审（第 2 轮）
- 评审对象：`.superpowers/2026-05-20-subagent-tui/plan.md`
- 评审目标：验证 v1 发现的 4 条问题（2 MUST FIX + 2 LOW）是否已修复

---

## 逐条验证

### MUST FIX #1: ThrottleState.forceEmit()

**问题回顾：** `forceEmit()` 设置 `lastEmitTime = Date.now()`，之后 `shouldEmit()` 的 `now - lastEmitTime ≈ 0 < 500` 返回 false，导致 agent 完成后的最终状态更新永远不发。

**计划检查结果：**

```
// line 777
forceEmit(): void {
    this.lastEmitTime = 0;    // ← 已修复
}
```

`forceEmit()` 现在设置 `lastEmitTime = 0`，下一次 `shouldEmit()` 调用时 `now - 0` 必然 ≥ 500（实际是当前时间戳），返回 true。同时 `shouldEmit()` 在返回 true 后会将 `lastEmitTime` 更新为 `now`，后续的 500ms 节流窗口正常工作。

**验证流程：**
```
agent 完成 → throttle.forceEmit() → lastEmitTime = 0
           → emitParallelUpdate() → throttle.shouldEmit()
           → now - 0 = large number > 500 → true → lastEmitTime = now → onUpdate 正确调用
           → 后续 500ms 内的调用被节流（lastEmitTime 已重置为 now）
```

**状态：✅ 已修复**

---

### MUST FIX #2: Task 8 遗漏 background job 的 rmdirSync 清理

**问题回顾：** v1 指出源码有 3 处 `rmdirSync`，plan 仅处理了第 1 处（runSingleAgent finally），遗漏了 startBackgroundJob 和 cleanupJob。

**计划检查结果：**

Task 8 Step 4 明确标题为 "Remove all rmdirSync calls for prompt dir"（line 987），并逐处覆盖：

| # | 位置 | 计划描述 | 覆盖情况 |
|---|------|---------|---------|
| 1 | runSingleAgent finally (line 1002) | 移除 `tmpPromptDir` 及其 `rmdirSync` | ✅ |
| 2 | startBackgroundJob proc.on("close") (lines 1005-1010) | 移除 `promptDir` 的 `rmdirSync` 块，保留 promptFile unlinkSync | ✅ 附替换代码 |
| 3 | cleanupJob (line 1014) | 移除 `job.promptDir` 的 `rmdirSync` 块（promptFile 已在循环中清理） | ✅ 描述清晰 |

**状态：✅ 已修复**

---

### LOW #3: "3 places" 描述不准确

**问题回顾：** Task 2 Step 4 声称 "3 places" 但只列出 2 个。

**计划检查结果：**

```
// line 210
There are 2 other places that construct `SingleResult` objects (besides the main
`currentResult` in `runSingleAgent`). Both need the new required fields...
```

已改为 "2 other places"，与列出的 Site 1（unknown agent fallback）和 Site 2（parallel pre-init）匹配。

**状态：✅ 已修复**

---

### LOW #4: renderParallelTable Total 行缺少零值判断

**问题回顾：** 现有 plan 中 Total 行无条件显示 token/cost 数据，即使用户没有使用 token。

**计划检查结果：**

```typescript
// lines 501-509
const totalLine = [];
if (view.aggregateTokens.input > 0 || view.aggregateTokens.output > 0) {
    totalLine.push(`Total: ↑${formatTokens(view.aggregateTokens.input)} ↓${formatTokens(view.aggregateTokens.output)}`);
}
if (view.aggregateCost > 0) {
    totalLine.push(`$${view.aggregateCost.toFixed(4)}`);
}
if (totalLine.length > 0) {
    text += `\n${theme.fg("dim", totalLine.join("  "))}`;
}
```

已添加 `aggregateTokens > 0` 和 `aggregateCost > 0` 的零值判断，与 renderAgentRow 保持一致。

**状态：✅ 已修复**

---

## 新发现的问题

### Issue #5: renderParallelTable 中的 totalParts 死代码

**位置：** Task 4 Step 3（renderParallelTable 函数），lines 498-500

**描述：**
```typescript
const totalParts: string[] = [];    // ← 声明但从未使用
totalParts.push(`Total: ↑${formatTokens(view.aggregateTokens.input)} ↓${formatTokens(view.aggregateTokens.output)}`);
totalParts.push(`$${view.aggregateCost.toFixed(4)}`);
```

这三行填充了 `totalParts` 数组，但后续代码只引用了 `totalLine`。`totalParts` 完全未被使用，是死代码。

**影响：** 实施者可能照搬 plan，将死代码带入源文件。虽然不会引起功能问题，但属于代码质量问题。

**建议：** 删除 lines 498-500 的 `totalParts` 相关 3 行。

**优先级：** LOW（不阻塞评审通过）

---

### Issue #6: renderParallelDetail Total 行缺少零值判断

**位置：** Task 4 Step 4（renderParallelDetail 函数），lines 544-548

**描述：**
```typescript
const totalParts: string[] = [];
totalParts.push(`↑${formatTokens(view.aggregateTokens.input)} ↓${formatTokens(view.aggregateTokens.output)}`);
totalParts.push(`$${view.aggregateCost.toFixed(4)}`);
container.addChild(new Text(theme.fg("dim", `Total: ${totalParts.join("  ")}`), 0, 0));
```

此处无条件显示 token 和 cost，与修复后的 renderParallelTable（有零值判断）不一致。v1 只要求了 renderParallelTable，所以这不属于 v1 的未修复问题，但应作为一致性问题清理。

**建议：** 加入与 renderParallelTable 相同的零值判断：
```typescript
const totalParts: string[] = [];
if (view.aggregateTokens.input > 0 || view.aggregateTokens.output > 0) {
    totalParts.push(`↑${formatTokens(view.aggregateTokens.input)} ↓${formatTokens(view.aggregateTokens.output)}`);
}
if (view.aggregateCost > 0) {
    totalParts.push(`$${view.aggregateCost.toFixed(4)}`);
}
if (totalParts.length > 0) {
    container.addChild(new Text(theme.fg("dim", `Total: ${totalParts.join("  ")}`), 0, 0));
}
```

**优先级：** LOW（不阻塞评审通过）

---

## 整体结论

| 维度 | 结果 |
|------|------|
| v1 MUST FIX 解决率 | 2/2 ✅ |
| v1 LOW 解决率 | 2/2 ✅ |
| 新增问题 | 2 条 LOW |
| 整体 verdict | **pass** |

v1 的 2 条 MUST FIX（forceEmit 逻辑错误、Task 8 rmdirSync 遗漏）和 2 条 LOW（Site 计数、Total 零值判断）均已正确修复。新发现的 2 条 LOW（totalParts 死代码、renderParallelDetail 零值遗漏）属于代码质量，不影响评审通过。建议在实施前清理。

> 注意：以上 `totalLine` 在函数内部使用，而 `totalParts` 是死代码。Issue #5 和 #6 中的变量名相同但含义不同，请不要混淆。
