# Goal 插件待优化项

> 来源：`goal-extension-optimization-plan.md` 分析中确认合理但未实施的条目
> 更新日期：2026-05-19

---

## P1：可靠性改进

### P1-3：Continuation 防重入保护

**问题**：`agent_end` 发 `followUp` 后，下一轮 `before_agent_start` 也会注入 context message。当 budget steering 用 `steer` 模式发送时，steering 消息在当前 turn 的 tool call 之后注入，和 `agent_end` 发的 `followUp` 时序不同，极端情况下可能导致消息堆积（多个 steering + followUp 排队）。

**当前状态**：Pi 的 agent loop 串行执行（`agent_end` → `followUp` → `before_agent_start`），大部分情况下不会并发。跳过原因是复杂度高于收益。

**如需实施**：

```typescript
// src/index.ts
let hasPendingInjection = false;

// before_agent_start 中
hasPendingInjection = true;

// agent_end 中
if (hasPendingInjection) {
    hasPendingInjection = false;
    return; // 跳过本轮 continuation
}
```

**风险评估**：低。只在 steering + followUp 混合使用时可能出现。当前只有 budget steering 用 `steer` 模式，其他全用 `followUp`，实际触发概率极低。

---

## P2：体验优化

### P2-6：预算预警阈值

**问题**：当前只在预算耗尽时通知。接近预算时（70%、90%）没有任何预警，用户无法提前调整策略。

**实施方案**：

`src/state.ts` 新增字段：

```typescript
interface GoalRuntimeState {
    // ... existing fields ...
    budgetWarning70Sent: boolean;
    budgetWarning90Sent: boolean;
}
```

`src/index.ts` 的 `agent_end` 中，在预算检查前加入预警：

```typescript
if (state.budget.tokenBudget) {
    const pct = state.tokensUsed / state.budget.tokenBudget;
    if (pct >= 0.9 && !state.budgetWarning90Sent) {
        state.budgetWarning90Sent = true;
        ctx.ui.notify("Token 预算已用 90%，请开始收尾。", "warning");
    } else if (pct >= 0.7 && !state.budgetWarning70Sent) {
        state.budgetWarning70Sent = true;
        ctx.ui.notify("Token 预算已用 70%，注意控制范围。", "info");
    }
}
```

同样可为时间预算加类似预警。

**预估改动**：~15 行，`state.ts` + `index.ts`。

---

### P2-7：预算紧张时优先 complete_goal

**问题**：所有任务已完成但 goal 未调 `complete_goal` 时，直接发 followUp 提醒。如果此时预算紧张（80%+），应优先让模型确认完成而不是继续工作。

**实施方案**：

`src/index.ts` 的 `agent_end` 中，"所有任务完成"分支：

```typescript
if (incomplete.length === 0 && total > 0) {
    const budgetTight = state.budget.tokenBudget
        && state.tokensUsed >= state.budget.tokenBudget * 0.8;

    if (budgetTight) {
        // 预算紧张时用 steer（优先级更高）要求立即完成
        pi.sendUserMessage(
            `所有任务已完成，且 token 预算已用 ${Math.round(state.tokensUsed / state.budget.tokenBudget! * 100)}%。` +
            `请立即调用 goal_manager 的 complete_goal 完成目标。` +
            `\n\n目标: ${state.objective}`,
            { deliverAs: "steer" },
        );
    } else {
        // 正常提醒
        pi.sendUserMessage(
            `所有 ${total} 个任务已完成。请调用 goal_manager 的 complete_goal 完成目标。`,
            { deliverAs: "followUp" },
        );
    }
}
```

**预估改动**：~15 行，`index.ts`。

---

### P2-8：Widget 进度条

**问题**：当前 widget 只显示百分比数字，没有视觉化的进度条。

**实施方案**：

`src/widget.ts` 新增辅助函数：

```typescript
function renderProgressBar(pct: number, width: number = 10): string {
    const filled = Math.round(Math.min(Math.max(pct, 0), 1) * width);
    return "█".repeat(filled) + "░".repeat(width - filled);
}
```

在 `renderWidgetLines` 的 budget 信息行中使用：

```typescript
if (state.budget.tokenBudget && state.budget.tokenBudget > 0) {
    const pct = getTokenUsagePercent(state) / 100;
    const bar = renderProgressBar(pct);
    lines.push(`  Token: ${bar} ${Math.round(pct * 100)}%`);
}
if (state.budget.timeBudgetMinutes && state.budget.timeBudgetMinutes > 0) {
    const pct = getTimeUsagePercent(state) / 100;
    const bar = renderProgressBar(pct);
    const elapsed = getElapsedTimeSeconds(state);
    const mins = Math.floor(elapsed / 60);
    lines.push(`  时间: ${bar} ${mins}/${state.budget.timeBudgetMinutes}分钟`);
}
```

**预估改动**：~10 行，`widget.ts`。

---

## 已完成项（参考）

| 项目 | 状态 | Commit |
|------|------|--------|
| P0-1: Token 会计排除 cached | 已修 | `b69b664` |
| P0-2: 消灭 setTimeout，改同步检查 | 已修 | `b69b664` |
| P1-4: stall 阈值 3→5 | 已修 | `b69b664` |
| P1-5: report_blocked 记录原因 | 已修 | `b69b664` |
| 审查发现的 14 项 P0/P1/P2 | 全部已修 | `eeb1e02` |
