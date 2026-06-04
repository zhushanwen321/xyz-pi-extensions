# 修正与补充：Pi goal_manager 的真实能力

> 写于 07-设计哲学与总结.md 之后。纠正上一篇中关于 "Pi goal_manager 仅
> 是检查清单，Codex Thread Goal 有自治循环" 的过度简化判断。

## 错误结论的自我纠正

我在 07 文档中说：

> Pi 的 `goal_manager` 是"任务检查清单"——本质上它是一个强制的验证门禁流程。
> Codex 的 Thread Goal 是"自治循环"——本质上它是一个持久化的意图执行引擎。

**这个判断是错的。** 重新审读 Pi goal extension 源码后发现，Pi 的 goal 系统与 Codex 的 Thread Goal **在核心能力上是同构的**。

## Pi goal extension 实际具备的能力

以下能力全部在 `extensions/goal/src/index.ts` 中实现，这些等同于 Codex Thread Goal：

| 能力 | Pi 实现位置 | Codex 实现位置 |
|---|---|---|
| **跨 turn 自动 continuation** | `agent_end` → `sendUserMessage(continuationPrompt(...))` | `goals.rs` → `maybe_start_goal_continuation_turn` |
| **Token 会计追踪** | `message_end` → `state.tokensUsed += delta` | `goals.rs` → `account_thread_goal_progress` |
| **Token 预算硬限制** | `checkBudgetOnTurnEnd` → `status = "budget_limited"` | `account_thread_goal_usage` → `BudgetLimited` |
| **时间预算硬限制** | `checkBudgetOnTurnEnd` → `status = "time_limited"` | 仅 wall-clock 会计，无时间限制 |
| **预算预警** | 70%/90% 两层 warning + steering | `budget_limit_prompt`（>100%） |
| **Stall 检测** | `checkProgress` → `stallCount++` | Token-delta 去抖 |
| **自动阻塞** | `stallCount >= maxStallTurns` → Blocked | 模型 `update_goal(blocked)` + 3-turn audit |
| **状态机** | 7 种状态（含 cancelled/time_limited） | 6 种状态 |
| **持久化** | Session entry（append 模式） | SQLite |
| **重连恢复** | `reconstructGoalState` 逆向扫描 entries | SQL query |
| **目标编辑** | `/goal update <new-objective>` + `objectiveUpdatedPrompt` | `ExternalSet` → `objective_updated_prompt` |
| **状态栏/Widget** | `setStatus` + `setWidget` | SSE EventMsg → CLI 渲染 |

## 两者实际相同的能力集

```
                    Pi goal_manager            Codex Thread Goal
跨 turn AutoContinuation   ✔                         ✔
Token 会计                  ✔                         ✔
Token Budget                ✔ (硬限制)                ✔ (硬限制)
时间 Budget                 ✔ (硬限制)                ✗ (仅会计)
预算预警                     ✔ (70%/90%)              ✔ (>100%)
Stall 检测                  ✔ (task progress)        ✔ (token delta)
自动 Blocked                ✔ (stall 阈值)           ✔ (3-turn audit)
持久化跨 session            ✔ (session entry)        ✔ (SQLite)
状态机                      ✔ (7态)                   ✔ (6态)
用户控制 Pause/Resume       ✔                        ✔
上下文空间保护              ✔ (85% 自动暂停)          ✗

### 结论：核心能力完全重叠
```

## 真正的差异——不是"有没有"，而是"怎么做"

既然核心能力集重合，那差异到底是什么？重新分析后发现，真正的差异在三个维度：

### 维度一：任务分解 vs 无分解（结构差异）

这是最大的差异，也是之前误导我的根源。

| | Pi goal_manager | Codex Thread Goal |
|---|---|---|
| **模型必须做的事** | 调用 `create_tasks` 把目标拆成可验证的任务 | 不需要显式分解 |
| **模型追踪的单位** | Task（id + description + status + evidence + subtask） | 只有 objective 字符串 |
| **进度评估标准** | 已完成的 task 数 / 总 task 数 | Token 消耗 / 模型自述 |
| **完成条件** | 所有 task 必须 explicit completed + evidence | 模型通过 update_goal(complete) 自述 |
| **子任务追踪** | Subtask（add_subtasks / update_subtasks） | 无 |

**Pi 要求模型**：把一个大目标拆成若干可验证的 task，逐个完成，逐个提供证据。这是**结构化的工作分解**。

**Codex 允许模型**：直接朝着 objective 工作，不需要显式分解。系统只通过 token budget 和 prompt 指令约束。

### 维度二：验证在工具层 vs 验证在 prompt 层（执行差异）

Pi 把"必须提供证据"写在**代码层**——`update_tasks(status=completed)` 没有 evidence 参数会抛异常：

```typescript
// Pi: 工具层强制验证
if (u.status === "completed" && (!u.evidence || u.evidence.trim() === "")) {
  throw new Error(`Task #${task.id}: completed 必须提供 evidence`);
}
```

Codex 把"必须验证完成"写在**prompt 层**——违反规则不会报错，模型只是没按指令做：

```
// Codex: Prompt 层指引
Completion audit:
For every explicit requirement, identify the authoritative evidence...
...

// 但如果模型没做，系统不会阻止
```

### 维度三：模型 vs 系统的状态控制权限（控制差异）

| 状态转换 | Pi 谁控制 | Codex 谁控制 |
|---|---|---|
| Active | 模型 create_tasks / update_tasks | 模型 create_goal |
| Complete | 模型 complete_goal | 模型 update_goal(complete) |
| Blocked | 模型 report_blocked，或系统 stall 检测自动 | 模型 update_goal(blocked) |
| Paused | 用户 /goal pause | 用户或系统 |
| Cancelled | 用户 /goal clear，或模型 cancel_goal | **不存在** |
| BudgetLimited | 系统自动 | 系统自动 |
| TimeLimited | 系统自动 | **不存在** |
| UsageLimited | **不存在**（85% context → Paused） | 系统自动 |

**关键差异**：Pi 允许模型通过 `cancel_goal` 取消目标，Codex 不允许——模型只能 `complete` 或 `blocked`，没有"我不想做了"的选项。

## 修正后的核心结论

Pi goal_manager 和 Codex Thread Goal **不是不同层次的东西，而是同一层次、同一种东西的两种实现，区别在于设计决策的偏好**：

| 决策点 | Pi 的选择 | Codex 的选择 |
|---|---|---|
| 任务分解 | **强制结构化**（显式 task） | **自由意志**（只有 objective） |
| 验证机制 | **工具层强制**（代码验证） | **prompt 层引导**（指令约束） |
| 取消能力 | **允许模型 cancel** | **不允许**（模型不能放弃） |
| 持久化 | **Session entry**（轻量） | **SQLite**（可靠） |
| Continuation | **用户可见的消息** | **系统级新 turn** |
| 状态集 | 7 态（含 cancelled/time_limited） | 6 态（含 usage_limited） |
| 时间预算 | **有** | 无 |
| 上下文保护 | **有**（85% 暂停） | 无 |

**Pi 的结构化程度更高（强制分解 + 强制证据 + 时间预算），Codex 的自主任性更高（无分解 + prompt 引导 + 无限续跑）。两者都是完整的自治循环系统，只是 Pi 选择了"被约束的自治"，Codex 选择了"自由的自治"。**
