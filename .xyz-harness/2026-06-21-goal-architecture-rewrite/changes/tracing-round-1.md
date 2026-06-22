# Tracing Round 1

## 追踪范围
- spec 初稿版本：goal-architecture-rewrite/spec.md（含 FR-1~FR-7、AC-1~AC-7、Decisions D-01~D-11、UC-1~UC-5）
- 追踪的视角：全部 5 视角（User Journey / Data Lifecycle / API Contract / State Machine / Failure Path）。本需求是"重构 + 行为演进"，涉及状态机（FR-1.1/1.2）、API 契约（AC-4 契约稳定）、序列化数据（FR-5 清断兼容），五个视角均适用，无降级。
- 源码验证范围：extensions/goal/src/ 全部 12 个 .ts 文件 + coding-workflow/plan 的 `__goalInit` 调用点 + shared/types stub

## 前置观察（影响多个 gap 的判断）

spec UC-1 声明"行为与重构前一致"。但"行为保持"是**结果**不是**规约**——重构 agent 需要一份显式行为清单来对照，否则会无声丢弃。因此本报告把"代码中存在、spec 未枚举的行为"标为 F 类 gap（at-risk），不默认认为已被 UC-1 覆盖。

---

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G-001 | D | User Journey / API Contract | FR-4.2 vs clarification 降级1 | `__goalInit` 收窄后的 tasks 参数语义**自相矛盾**：FR-4.2 说"tasks 改为可选，委托 createGoal 处理"（暗示仍接收 tasks），clarification 降级1 说"tasks[] 参数可能不再被接收（改为只触发创建）"。两者决定不同结局——若仍接收 tasks，则 coding-workflow Phase2/3 + plan compact 的 3 个调用点**完全不降级**（它们都传了 tasks）；若不再接收，则 3 个调用点全部降级。必须二选一。 |
| G-002 | D | User Journey | FR-3 / command-handler.ts:217-247 handleUpdate | `/goal update` 是第 4 类操作但 spec 未归口：它重置 objective/tasks/budget flags/stallCount/currentTurnIndex 但**保留 goalId**（不是新建）。FR-3.1 只列了 3 个 createGoal 来源（set/create_tasks/__goalInit），没说 `/goal update` 走 createGoal、applyCommand 还是独立入口。它算"重塑"还是"新建"？ |
| G-003 | D | User Journey | command-handler.ts:255-266 handleSet | `/goal set` 覆盖已存在**终态** goal 时走快速路径：不写 history、不 clearGoalSession、直接 createInitialState 覆盖（仅非终态旧 goal 才 cancel+写 history）。新架构下这条快速路径保留，还是统一改走 finalizeGoal？finalizeGoal 会写 history——会改变终态 goal 被覆盖时是否产生重复 history entry。 |
| G-004 | F | User Journey / Data Lifecycle | index.ts:339,377,421; command-handler.ts:238,283; tool-handler.ts:168 | `tasksCompletedAtAgentStart`（stall 检测基线）归属未明确。它在 GoalSession 瞬态上，被 5 处重置：agent_start 事件、session_start 重建、handleSet、handleUpdate、initializeGoalFromExternal。spec FR-2.1 把 session.ts 列为"运行时句柄"但未列字段。**关键**：create_tasks action 不重置它（只有 set/update/external init 重置）。新唯一 createGoal 要不要重置？不重置则 stall 检测基线错乱。 |
| G-005 | D | User Journey | FR-6.1 vs action-handlers.ts:222 handleListTasks | FR-6.1 "action handler 执行后 widget 立即刷新" 的范围未界定。当前 `list_tasks` 不调 persist/updateWidget（只读）。FR-6.1 是否覆盖：(a) 只读 action（list_tasks）；(b) command handler（pause/resume/clear/update——当前通过 persistAndUpdate 已刷）？需明确"刷新"触发条件是"state 变更后"还是"任何 action 后"。 |
| G-006 | F | Data Lifecycle | index.ts:147-173 reconstructGoalState | Entry GC 策略未在 spec 明确。当前行为：goal-state entry 只保留最新 1 条（reconstruct 时 splice 其余），goal-history entry 保留最近 20 条（MAX_HISTORY_ENTRIES=20）。spec FR-2.1 仅泛指 "entry GC"。这是**持久化数据契约**，若新架构改策略会丢历史。需写明保留数量与触发时机。 |
| G-007 | F | Data Lifecycle / State Machine | before-agent-start-handler.ts:77-83; constants.ts:43 | `completedAtTurnIndex` + AUTO_CLEAR_TURNS=2 自动清理机制 spec 完全未提。终态 goal 在 before_agent_start 经过 `currentTurnIndex - completedAtTurnIndex >= 2` turn 后自动 clearGoalSession。这是终态后的生命周期收尾，spec 没有提及——重构后是否保留？ |
| G-008 | D | Data Lifecycle | tool-handler.ts:148-157 persistGoalState | 时间累计耦合在 persistGoalState 内：每次 persist 都 `timeUsedSeconds += (now - timeStartedAt)` 并重置 timeStartedAt。新架构 FR-2.3 说 service 决定 persist 时机，但时间累计是 domain/budget 关注点（且 FR-1.3 把 timeUsedSeconds 归 Budget）。要不要把累计从 persist 剥离到 domain，让 persist 只做序列化？（保留则 persist 有副作用，违背"service 统一 persist 时机"的纯净性） |
| G-009 | F | Data Lifecycle / API Contract | tool-handler.ts:161-172 writeGoalHistoryEntry | goal-history entry 不记录 reason（cancelReason/blockerReason）——当前与 spec 的 GoalHistoryEntry 类型一致（都无 reason）。但 cancel/abort 有 reason、blocked 有 lastBlockerReason，这些信息在归档时全部丢失。重构是否补 reason 字段？（AC-4 允许格式变，customType 不变） |
| G-010 | F | API Contract / Failure Path | index.ts:296-313 execute catch | Stale context 检测 + 错误信封未在 spec。tool execute 外层捕获：isStaleContextError → 返回 "Goal context stale..."；其他错误 → 返回 `msg + JSON.stringify(params, null, 2)`。STALE_CONTEXT_PATTERNS 列表（"aborted"/"context canceled"/"stale context"/"stalecontext"/"extension context no longer active"）是行为契约。spec 未提。 |
| G-011 | F | API Contract / Failure Path | tool-handler.ts:223-229; agent-end-handler.ts:56-66,258-266 | signal.aborted → pendingPause → paused 流程 spec 完全未提。tool execute 接 AbortSignal，若 aborted 设 `session.pendingPause=true`；agent_end 检测 `ctx.signal.aborted` 也设 pendingPause；handleStallAndContinuation 据此转 paused（而非 continue）。这是 ESC 中断的完整语义链，spec 没提。 |
| G-012 | F | API Contract | commands.ts:30-79 parseGoalArgs; constants.ts MAX_TURNS_CAP/MAX_STALL_CAP | `/goal` flag 解析与上限未在 spec：`--tokens`/`--timeout`/`--max-turns`/`--max-stall` 四个 flag，maxTurns 钳制到 [1,100]、maxStallTurns 钳制到 [1,20]，tokenBudget/timeBudgetMinutes 要求 >0 否则忽略。spec AC-4 只说"子命令不变"，没说 flag 解析行为。 |
| G-013 | F | API Contract | action-handlers.ts:283-293 handleCancelGoal; index.ts renderResult | cancel_goal 的 details.tasks 返回**空数组**（其他 action 返回完整 tasks）。renderResult 据此显示 "✓ 0/0 completed"。这是投影契约细节——新 projection/result.ts 是否保留这个空数组行为？改了会让 cancel 后的 renderResult 显示错乱。 |
| G-014 | F | State Machine | command-handler.ts:147-160 handleResume; budget.ts:53-66 checkBudgetOnResume | resume 可从 paused/blocked 直转 budget_limited/time_limited（终态）。spec FR-1.1 只说"paused/blocked 是仅有的可逆中间态"+"可逆回 active"，没列 resume→terminal 这条转换路径。重构后 resume 的预算重检是否保留？ |
| G-015 | F | State Machine | index.ts:136-140 reconstructGoalState | session_start 重建时的**非对称强制激活**：`if (!isTerminal && status !== "paused") → status = "active"`。即 crashed 的 blocked goal 重启后变 active，但 paused 保持 paused。spec UC-2 说"正确恢复"但没说这个强制激活语义与 paused/blocked 的非对称处理。 |
| G-016 | D | State Machine | state.ts:196-199 transitionStatus | transitionStatus 过度宽松：只守卫终态不可覆盖，允许任意非终态→非终态转换（active→active、paused→blocked 等理论可行）。当前依赖**调用方自觉**只触发合法转换。domain 层要不要收紧为显式转换表（拒绝未列举的转换）？spec FR-1.1 的措辞"守卫终态不可覆盖"暗示保持宽松，但重构是收紧的好时机。 |
| G-017 | F | State Machine | action-handlers.ts:131-137 validateUpdateTasks | completed 无 verification 的 task **完全锁定**（连 cancel 都不行）：`completed && !verification → "already completed, cannot be changed"`。spec FR-1.2 只说"任务状态机转换合法性校验归位至此"，没明确这条"completed-no-verify 全锁"规则。prompt 里却说"Cancelled does not block goal completion"暗示可 cancel——实际不可。文档与实现已有微妙不一致，重构需明确取舍。 |
| G-018 | F | State Machine | action-handlers.ts:325-340 handleUpdateSubtasks | subtask **无状态机校验**：只检查 `completed → 不能改`，允许 pending→completed 跳过 in_progress（与 task 的严格 5 态机不一致）。spec FR-1.2 说 SubtaskStatus 3 态（刻意无 verification）但没说转换规则。domain 要不要给 subtask 也加 pending→in_progress→completed 的校验？还是刻意放松（subtask 是"轻量执行单元"）？ |
| G-019 | F | Failure Path | 全文 grep hasPendingInjection | `hasPendingInjection` 是**僵尸字段**：5 处写入（set/update/external init/clearGoalSession/before_agent_start 设 true），**零处读取**（无任何 `if (hasPendingInjection)` 分支）。重构应删除还是保留？spec 未提。删除是正确方向（dead code），但需确认不是"未完成的功能"。 |
| G-020 | F | Failure Path | agent-end-handler.ts:52,76 makeStaleChecker | goalId snapshot stale-checker 机制 spec 未提。agent_end 入口快照 goalId，每个子 handler 通过 checkStale() 判断中途是否被新 goal 覆盖（如 agent_end 期间用户 `/goal set new`），若 stale 则中止后续副作用。这是并发保护核心，spec 没提——重构必须保留，否则会出现"旧回调操作新 goal"。 |
| G-021 | F | Failure Path | agent-end-handler.ts:50-51,75 isProcessing | isProcessing 防重入守卫 spec 未提。agent_end 重入时直接返回（Pi runtime 理论上不应重入，但实际防御）。新 service.ts 是否保留这个守卫？ |
| G-022 | F | Failure Path | tool-handler.ts:174-194 updateWidget; 全文 ctx.ui.setWidget/setStatus | headless/RPC 模式（无 UI）未处理。updateWidget 直接调 `ctx.ui.setWidget/setStatus`，未检查 `ctx.hasUI`。Pi RPC mode（pi run / 脚本模式）下 ctx.ui 行为未定义。spec 没提无 UI 降级——重构是否加 hasUI 守卫？ |
| G-023 | F | Failure Path | tool-handler.ts:148 persistGoalState; 各事件处理器 | persist appendEntry 失败无 try/catch（事件处理器内）。tool execute 有外层 catch，但 agent_end/before_agent_start/turn_end/session_start 事件处理器内若 persistGoalState 抛错会冒泡到 Pi runtime，行为未定义。spec 没提持久化失败处理策略。 |
| G-024 | D | Failure Path | state.ts:213-232 deserializeState | 部分损坏 entry 的处理粒度未定。deserializeState 对每个 task 检查 `if (!("status" in t)) throw`——**任何一个 task 缺 status 字段就整 throw**，reconstructGoalState catch 后整个 state=null（单坏 task 致整个 goal 丢失）。spec FR-5 说"旧 entry 丢弃"，但"部分损坏"是否等同"旧格式"？跳过坏 task 保留好 task，还是全丢？ |

---

## 补充说明（非 gap，但值得主 agent 知晓）

- **FR-3.4 的"4 处重复"已验证**：makeGoalResult(tool-handler.ts:203) / buildBudgetReport(action-handlers.ts:247) / formatBudgetInfo(templates.ts:233) / formatBudgetLine(templates.ts:248) 确实四份预算格式化逻辑散落，收敛目标成立。
- **A-06 调用方已验证**：coding-workflow 2 处（tool-handlers.ts:503,526）+ plan 1 处（compact.ts:79），均 `try/catch non-blocking`，均各重新声明 GoalInitFn 类型。G-001 的决策直接决定这 3 处是否需要改造。
- **ACTION_HANDLERS 当前类型**：`Record<string, ActionHandler>`（action-handlers.ts:346）。AC-3 要求改为 `Record<Action, ActionHandler>`，需要从 GoalManagerParams 的 StringEnum 推导 action 联合类型——技术上可行（`Static<typeof GoalManagerParams>["action"]`），非 gap。

## 优先级建议（供主 agent 参考，非 gap）

1. **P0 阻塞决策**：G-001（`__goalInit` tasks 语义矛盾，直接决定降级范围与调用方是否需改）、G-002（`/goal update` 入口归口）、G-004（createGoal 是否重置 stall 基线）
2. **P1 行为契约显式化**：G-006（GC 策略）、G-007（auto-clear）、G-010/011/012（错误/stale/ESC/flag 契约）、G-020/021（并发守卫）
3. **P2 清理机会**：G-019（删僵尸字段 hasPendingInjection）、G-008（时间累计剥离）、G-016/017/018（状态机收紧与否）
4. **P3 记录即可**：G-009/013/015/022/023/024
