# Tracing Round 3

## 追踪范围
- spec 初稿版本：含 FR-1~FR-8（含 FR-8.6 事件链路精确行为、FR-8.7 agent_end 分支优先级与 history 写入条件）、D-01~D-17、AC-1~AC-7
- clarification.md 版本：含 D-16（ctx 改必填）、D-17（Round 2 事件链路补强）
- 追踪的视角：全部 5 视角（User Journey / Data Lifecycle / API Contract / State Machine / Failure Path）—— 重构类需求但涉及状态机 + API 契约 + 序列化数据 + 事件链路，五视角均适用，无降级

## 判定：**NOT CONVERGED**（有 5 个新 gap）

Round 1（24 个）和 Round 2（9 个）的 gap 已全部写入 spec（FR-8 全部子章节 + D-12~D-17），经验证与源码一致。但完整重跑 5 视角后发现以下 Round 1/2 遗漏或 spec 修订引入的新问题：

---

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G-R3-001 | D | State Machine / Failure Path | FR-8.6 turn_end vs 源码 index.ts turn_end handler | turn_end 的 `currentTurnIndex++` 是否应在 paused/blocked 时跳过？FR-8.6 只写"currentTurnIndex++"，未提 pause 条件。源码 `if (!session.state) return; currentTurnIndex++; updateWidget();` 无 isActiveStatus 检查——**paused goal 仍消耗 turn 预算**。而 message_end / agent_start 都有 isActiveStatus 守卫。三方不对称。实现者可能"修复"为加 isActiveStatus 检查，无意中改变 maxTurns 预算消耗语义。spec 须显式声明：保持当前行为（pause 期间仍递增）还是修复（pause 期间跳过） |
| G-R3-002 | F | State Machine | FR-8.7 finalizeGoal clearSession vs FR-8.1 G-007 AUTO_CLEAR_TURNS | FR-8.7 说 finalizeGoal 对终态执行"设 status + completedAtTurnIndex + persist + **clearSession**"。但源码中仅 cancelled（cancel_goal/clear/abort）立即 clearGoalSession；**complete/budget_limited/time_limited 不 clearSession**，依赖 AUTO_CLEAR_TURNS（FR-8.1 G-007）在 before_agent_start 2 turn 后清理。若 finalizeGoal 对所有终态统一 clearSession，则 AUTO_CLEAR_TURNS 变死代码，且用户看不到"Goal completed ✓"终态栏 2 turn。spec 须澄清：finalizeGoal 是条件 clear（仅 cancelled）还是参数化 clearImmediately |
| G-R3-003 | F | State Machine | FR-3.3 vs FR-8.7（spec 内部矛盾） | FR-3.3 说 finalizeGoal"收口当前散落的终态序列（cancel/clear/abort 三处重复 + complete/**blocked**/budget_limited 序列）""统一：设终态 status → **writeHistoryEntry** → persist → clearSession"。FR-8.7 说"**中间态 paused/blocked 不走此入口**""内部根据上述矩阵**决定是否** writeHistoryEntry"。两处直接矛盾：(1) blocked 是否走 finalizeGoal；(2) writeHistoryEntry 是无条件还是按矩阵条件。FR-8.7（Round 2 补强）更精确，应 supersede FR-3.3，但 spec 未标注 FR-3.3 被修订 |
| G-R3-004 | F | API Contract | action-handlers.ts handleCreateTasks vs FR-8 全部子章节 | handleCreateTasks 的守卫是 `state.tasks.length > 0 && existingIncomplete.length > 0` 才拒绝。当**所有 task 已完成**（existingIncomplete.length === 0）时，create_tasks **静默覆盖**整个 tasks 数组（`state.tasks = params.tasks.map(...)`）。此行为 spec 从未提及，FR-8 也没覆盖。prompt 只说"Do not re-call create_tasks to overwrite existing **incomplete** tasks"，对 all-complete 情况未规定。是保持（契约稳定）还是收紧（error: "all tasks complete, use complete_goal"）？需决策 |
| G-R3-005 | F | Data Lifecycle / 测试计划 | FR-7.3 测试迁移 vs FR-5 序列化清断兼容 | FR-7.3 说"迁移现有 3 个测试（deserialize-state / is-task-done / validate-update-tasks）到新结构"。但 `deserialize-state.test.ts`（109 行）当前测的是**旧格式向后兼容**（"旧数据无 verification 字段 → verification 为 undefined""缺少字段时给默认值"）。FR-5 明确移除向后兼容（字段缺失直接 throw → state=null）。迁移后这些测试用例**必然失败**，需改写为"缺字段 → throw / state=null"的新行为验证。"迁移"一词有歧义，spec 须明确：是 copy-and-adapt（改写期望）还是仅 move |

---

## 详细追踪依据

### G-R3-001：turn_end pause 条件（源码验证）

```
// index.ts turn_end handler（当前）：
pi.on("turn_end", async (_event, ctx) => {
    if (!session.state) return;          // ← 仅检查 state 存在
    session.state.currentTurnIndex++;    // ← paused/blocked 也递增
    updateWidget(session, ctx);
});

// 对比 message_end handler：
pi.on("message_end", async (event) => {
    if (!session.state || !isActiveStatus(session.state.status)) return;  // ← 有 isActiveStatus 守卫
    ...
});

// 对比 agent_start handler：
pi.on("agent_start", async () => {
    if (!session.state || !isActiveStatus(session.state.status)) return;  // ← 有 isActiveStatus 守卫
    ...
});
```

**影响**：goal pause 后用户做其他工作，每 turn 仍递增 currentTurnIndex。resume 后 maxTurnsReached 检查使用膨胀的索引，可能立即触发 cancelled。FR-8.6 的"currentTurnIndex++"描述未澄清此行为。

### G-R3-002：finalizeGoal clearSession 范围（源码验证）

```
// 立即 clearGoalSession 的路径（仅 cancelled）：
handleCancelGoal     → clearGoalSession(session, ctx)   ✓
handleClear          → clearGoalSession(session, ctx)   ✓
handleAbort          → clearGoalSession(session, ctx)   ✓

// 不 clearGoalSession 的终态路径（依赖 AUTO_CLEAR_TURNS）：
handleCompleteGoal          → persistGoalState only      ✗ no clear
handleBudgetChecks(terminal)→ persistAndUpdate only      ✗ no clear
handleAllTasksDone          → persistAndUpdate only      ✗ no clear
handleNoTasksOrMaxTurns     → persistAndUpdate only      ✗ no clear
handleMaxTurnsReached       → persistAndUpdate only      ✗ no clear
```

FR-8.1 G-007 说 AUTO_CLEAR_TURNS=2 适用于"终态 goal"。如果 finalizeGoal 对所有终态统一 clearSession，AUTO_CLEAR_TURNS 永远不触发（goal 已被清）。

### G-R3-003：FR-3.3 vs FR-8.7 直接矛盾

| 论点 | FR-3.3（Round 1） | FR-8.7（Round 2 补强） |
|------|-------------------|----------------------|
| blocked 走 finalizeGoal？ | ✅ "complete/**blocked**/budget_limited 序列" | ❌ "中间态 paused/**blocked** 不走此入口" |
| writeHistoryEntry | 无条件（"→ writeHistoryEntry →"） | 按矩阵条件（"决定是否 writeHistoryEntry"） |

FR-8.7 更精确且与源码一致（report_blocked/markGoalBlocked 都不调 writeGoalHistoryEntry）。但 spec 未在 FR-3.3 标注"被 FR-8.7 修订"，实现者读 FR-3.3 会误认为 blocked 走 finalizeGoal + 写 history。

### G-R3-004：create_tasks all-complete 静默覆盖（源码验证）

```
// action-handlers.ts handleCreateTasks：
const existingIncomplete = getIncompleteTasks(state.tasks);
if (state.tasks.length > 0 && existingIncomplete.length > 0) {
    return errorResult("Already has N tasks...");   // ← 只拒绝"有未完成"
}
// 所有 task 已完成时，existingIncomplete.length === 0 → 不拒绝
state.tasks = params.tasks.map(...);   // ← 静默覆盖已完成 tasks
```

### G-R3-005：deserialize-state 测试迁移歧义

```
// 当前 deserialize-state.test.ts 测的是向后兼容：
it("旧数据无 verification 字段 → verification 为 undefined", ...)   // ← FR-5 后此行为不存在
it("缺少字段时给默认值", ...)                                       // ← FR-5 后此行为不存在（throw）
```

FR-5 明确："移除 deserializeState 的旧格式迁移逻辑""字段缺失直接报错"。迁移后这些测试用例的期望（verification=undefined / 默认值）与新行为（throw）矛盾。

---

## 5 视角追踪摘要

### P1: User Journey
- 8 个 /goal 子命令 + 10 个 tool action + __goalInit，全部追踪
- 成功路径 / 重复操作 / 中途取消 / 权限边界 均在 spec 或源码中有答案
- **未发现新 gap**（已有 gap 集中在 P3/P4）

### P2: Data Lifecycle
- GoalRuntimeState（goal-state entry）+ GoalHistoryEntry（goal-history entry）+ GoalSession（进程内）
- Create / Read / Update / Delete / GC 全部追踪
- Entry GC 时机（reconstructGoalState 即 session_start）由 FR-8.1 G-006 隐含覆盖
- **G-R3-005**：测试迁移对 deserialize 旧格式测试的影响未澄清

### P3: API Contract
- goal_manager 10 actions + /goal 8 subcommands + __goalInit 签名
- 输入校验 / 错误码 / 幂等性 / 原子性（validateUpdateTasks 先全量校验再 mutate）追踪
- **G-R3-004**：create_tasks 在 all-complete 时的覆盖行为未规定

### P4: State Machine
- Goal 7 态 / Task 5 态 / Subtask 3 态，转换矩阵 + 终态守卫 + 僵尸状态检查
- **G-R3-001**：turn_end pause 条件未澄清
- **G-R3-002**：finalizeGoal clearSession 范围与 AUTO_CLEAR_TURNS 冲突
- **G-R3-003**：FR-3.3 vs FR-8.7 关于 blocked + writeHistoryEntry 直接矛盾

### P5: Failure Path
- deserialize throw / persist 失败 / stale context / 并发覆盖 / 防重入 / AbortSignal / 预算耗尽 / maxTurns / stall 全部追踪
- **G-R3-001** 也属失败视角（pause 期间 turn 预算被消耗是异常资源消耗）
- 其余失败路径已被 FR-8.2 全面覆盖

---

## 无降级视角

全部 5 视角均完整追踪，无降级。
