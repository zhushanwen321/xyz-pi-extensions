# Goal 插件优化 — 实施计划

> 基于 `.xyz-harness/2026-05-19-goal-optimization/spec.md`
> 复杂度：L1（单文件 plan，无前端/后端分离）

---

## 总览

11 个任务，修改 6 个文件，预估 ~200 行改动。

- **R1-R5**：健壮性修复（必须先做，后续功能依赖正确的状态管理）
- **P1-3 ~ P2-8**：功能增强 + 体验优化
- **附带**：死代码清理 + README 修正

## 执行顺序与依赖

```
R1 (goalId 校验)          ─┐
R2 (时间双写)              │  可并行，都是 index.ts 修改
R3 (update 重置计数器)     │
R4 (complete_goal 零任务)  ─┘
       ↓
R5 (deserialize 默认值)    ── state.ts 独立修改
       ↓
P1-3 (防重入)              ── index.ts
       ↓
P2-6 (预算预警)            ── state.ts + index.ts
       ↓
P2-7 (预算紧张收尾)        ── index.ts
       ↓
P2-8 (进度条)              ── widget.ts
       ↓
附带 (blockedPrompt + README)  ── templates.ts + README.md
```

## 任务清单

---

### Task 1: R1 — agent_end goalId 校验

**文件**：`src/index.ts`

**问题**：用户 `/goal <新目标>` 替换活跃 goal 后，旧 goal 的 `agent_end` 回调仍会触发，此时 `state` 指向新 goal，导致旧回调的预算检查、stall 检测等操作了错误的状态。

**修改**：在 `agent_end` handler 开头 snapshot 当前 goalId，在每个关键操作前校验 `state.goalId === snapshotGoalId`。如果不匹配，直接 return。

```typescript
pi.on("agent_end", async (_event, ctx) => {
    if (!state) return;

    // 捕获 goalId snapshot，防止旧回调操作新 goal
    const snapshotGoalId = state.goalId;

    // ... 后续所有操作前检查：
    // if (state?.goalId !== snapshotGoalId) return;
});
```

**验证**：在 `agent_end` 的每个 return 点前加 goalId 校验。

---

### Task 2: R2 — 消除时间双写

**文件**：`src/index.ts`

**问题**：终止分支（budget_limited、time_limited、complete 等）先 `state.timeUsedSeconds = getElapsedTimeSeconds(state)` 再调 `persistState(ctx)`。`persistState` 内部又做 `state.timeUsedSeconds += (now - state.timeStartedAt) / 1000`，导致时间被累加两次。

**修改**：终止分支不再手动赋值 `timeUsedSeconds`，统一由 `persistState` 管理。删除所有 `state.timeUsedSeconds = getElapsedTimeSeconds(state)` 行（在紧接 `persistState` 的位置）。

唯一例外：`pause` 命令中的 `state.timeUsedSeconds = getElapsedTimeSeconds(state)` 后跟 `persistState`——同样删除手动赋值。

`persistState` 已有正确逻辑：
```typescript
if (isActiveStatus(state.status)) {
    const now = Date.now();
    state.timeUsedSeconds += (now - state.timeStartedAt) / 1000;
    state.timeStartedAt = now;
}
```

但非 active 状态时 `persistState` 不更新时间。需要在终止分支手动调用一次时间同步后再 persist。

**方案**：在 `persistState` 中去掉 `isActiveStatus` 条件限制——无论什么状态都更新 timeUsedSeconds。这样终止分支只需直接调 `persistState`。

```typescript
function persistState(ctx: ExtensionContext): void {
    if (!state) return;
    const now = Date.now();
    // 始终同步时间（不论状态），调用方不需要手动赋值 timeUsedSeconds
    if (state.timeStartedAt > 0) {
        state.timeUsedSeconds += (now - state.timeStartedAt) / 1000;
        state.timeStartedAt = now;
    }
    pi.appendEntry(ENTRY_TYPE, serializeState(state));
}
```

然后删除 index.ts 中所有 `state.timeUsedSeconds = getElapsedTimeSeconds(state)` 和 `state.timeUsedSeconds = elapsed` 行。

---

### Task 3: R3 — `/goal update` 重置计数器

**文件**：`src/index.ts`

**修改**：在 `/goal update` 的 handler 中，清空 tasks 后重置计数器：

```typescript
case "update": {
    // ...existing validation...
    state.objective = parsed.objective;
    state.objectiveUpdatedAt = Date.now();
    state.tasks = [];
    state.stallCount = 0;          // 新增
    state.turnCount = 0;           // 新增
    state.lastProgressTurn = 0;    // 新增
    tasksCompletedAtAgentStart = 0; // 新增
    // ...
}
```

---

### Task 4: R4 — `complete_goal` 零任务拒绝

**文件**：`src/index.ts`

**修改**：在 `complete_goal` action 中，增加零任务检查：

```typescript
case "complete_goal": {
    if (!params.evidence || params.evidence.trim() === "") {
        throw new Error("complete_goal requires evidence");
    }
    if (state.tasks.length === 0) {
        throw new Error("请先使用 create_tasks 创建任务清单，再完成目标。");
    }
    // ...existing incomplete check...
}
```

---

### Task 5: R5 — `deserializeState` 补全字段默认值

**文件**：`src/state.ts`

**修改**：为 `deserializeState` 添加字段默认值补全，兼容旧格式：

```typescript
export function deserializeState(data: GoalRuntimeState): GoalRuntimeState {
    return {
        goalId: data.goalId ?? "",
        objective: data.objective ?? "",
        status: data.status ?? "active",
        tasks: (data.tasks ?? []).map((t: any) => ({ ...t })),
        turnCount: data.turnCount ?? 0,
        stallCount: data.stallCount ?? 0,
        tokensUsed: data.tokensUsed ?? 0,
        timeStartedAt: data.timeStartedAt ?? Date.now(),
        timeUsedSeconds: data.timeUsedSeconds ?? 0,
        budget: { ...DEFAULT_BUDGET, ...(data.budget ?? {}) },
        lastProgressTurn: data.lastProgressTurn ?? 0,
        budgetLimitSteeringSent: data.budgetLimitSteeringSent ?? false,
        objectiveUpdatedAt: data.objectiveUpdatedAt ?? Date.now(),
        lastBlockerReason: data.lastBlockerReason ?? null,
    };
}
```

---

### Task 6: P1-3 — Continuation 防重入保护

**文件**：`src/index.ts`

**修改**：新增 `hasPendingInjection` 闭包变量。

- `before_agent_start` 中设 `hasPendingInjection = true`
- `agent_end` 中，如果 `hasPendingInjection` 为 true，清零并 return（跳过 continuation）
- budget steering（`deliverAs: "steer"`）不走 `agent_end`，所以 steer 不需要这个守卫

```typescript
let hasPendingInjection = false;

// before_agent_start 中
hasPendingInjection = true;

// agent_end 中，在 goalId 校验后、业务逻辑前
if (hasPendingInjection) {
    hasPendingInjection = false;
    return;
}
```

---

### Task 7: P2-6 — Token + 时间预算预警

**文件**：`src/state.ts` + `src/index.ts`

**state.ts**：`GoalRuntimeState` 新增 2 个字段：

```typescript
budgetWarning70Sent: boolean;
budgetWarning90Sent: boolean;
```

同步更新 `createInitialState` 和 `deserializeState`。

**index.ts**：在 `agent_end` 中，预算检查前加入预警逻辑：

```typescript
// Token 预算预警
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

// 时间预算预警
if (state.budget.timeBudgetMinutes) {
    const elapsed = getElapsedTimeSeconds(state);
    const timePct = elapsed / (state.budget.timeBudgetMinutes * 60);
    if (timePct >= 0.9 && !state.budgetWarning90Sent) {
        state.budgetWarning90Sent = true;
        ctx.ui.notify("时间预算已用 90%，请开始收尾。", "warning");
    } else if (timePct >= 0.7 && !state.budgetWarning70Sent) {
        state.budgetWarning70Sent = true;
        ctx.ui.notify("时间预算已用 70%，注意控制范围。", "info");
    }
}
```

**注意**：token 和 time 的 warning flag 共用（70% 是或关系：任一达 70% 就通知一次，90% 同理）。也可以分开——但 4 个 flag 太多。用 2 个 flag 更简洁，语义是"预算警告已发送"，覆盖 token 和 time 两种预算。

---

### Task 8: P2-7 — 预算紧张时优先 complete_goal

**文件**：`src/index.ts`

**修改**：在 `agent_end` 的"所有任务完成但 goal 未标记 complete"分支，加入预算紧张判断：

```typescript
if (total > 0 && incomplete.length === 0) {
    if (state.turnCount >= state.budget.maxTurns) { /* auto-complete, 不变 */ }

    const budgetTight = state.budget.tokenBudget
        && state.tokensUsed >= state.budget.tokenBudget * 0.8;

    if (budgetTight) {
        pi.sendUserMessage(
            `所有任务已完成，且 token 预算已用 ${Math.round(state.tokensUsed / state.budget.tokenBudget! * 100)}%。` +
            `请立即调用 goal_manager 的 complete_goal 完成目标。` +
            `\n\n目标: ${state.objective}`,
            { deliverAs: "steer" },
        );
    } else {
        pi.sendUserMessage(/* 原有 followUp */);
    }
    // ...
}
```

---

### Task 9: P2-8 — Widget 进度条

**文件**：`src/widget.ts`

**修改**：新增 `renderProgressBar` 辅助函数，在 `renderWidgetLines` 的 budget 区域展示进度条：

```typescript
function renderProgressBar(pct: number, width: number = 10): string {
    const clamped = Math.min(Math.max(pct, 0), 1);
    const filled = Math.round(clamped * width);
    return "█".repeat(filled) + "░".repeat(width - filled);
}
```

在 widget lines 中追加：

```typescript
if (state.budget.tokenBudget && state.budget.tokenBudget > 0) {
    const pct = getTokenUsagePercent(state) / 100;
    lines.push(`  Token: ${renderProgressBar(pct)} ${Math.round(pct * 100)}%`);
}
if (state.budget.timeBudgetMinutes && state.budget.timeBudgetMinutes > 0) {
    const pct = getTimeUsagePercent(state) / 100;
    const elapsed = getElapsedTimeSeconds(state);
    lines.push(`  时间: ${renderProgressBar(pct)} ${Math.floor(elapsed / 60)}/${state.budget.timeBudgetMinutes}分钟`);
}
```

---

### Task 10: 清理 blockedPrompt 死代码

**文件**：`src/templates.ts`

**修改**：删除 `blockedPrompt` 函数及其导出。

---

### Task 11: README 修正

**文件**：`goal/README.md`

**修改**：
1. `--max-stall` 默认值从 3 改为 5
2. `--max-stall` 描述改为"Consecutive stall turns before blocked (default: 5)"
