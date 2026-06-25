# Clarification Log — Goal V2 Refactor

> 记录 spec-clarify 阶段的决策与推理。每次决策后追加，不删除历史。

## 并发模型事实（调研确认，2026-06-24）

两个独立 subagent 交叉验证 pi-mono-fix-workspace/main 源码，结论一致：

| 场景 | 串行/并发 | 机制 |
|---|---|---|
| Node.js event loop | 单线程 | 原生 |
| **事件 handler**（message_end/agent_end/turn_end/before_agent_start/tool_call/tool_result）| **串行** await | `ExtensionRunner.emit*` 双层 for + await (runner.ts:693-725) |
| **tool `execute`**（模型并发调用多工具）| **并发**（默认 parallel）| `Promise.all` (agent-loop.ts:502) |
| abort signal | per-run AbortController | handler 须主动检查 ctx.signal.aborted |
| steer/followUp | 当前 run 内 drain（不启新 run）| steer=下轮 LLM 前注入；followUp=本要停止时续一轮 |

**对 goal extension 的影响：**
- message_end 累加 token：**安全**（串行 emit，不并发）
- agent_end：**不重入**（loop 退出时 emit 一次；followUp 续轮在同 loop 内，不发新 agent_end）
- **当前 `isProcessing` 防重入其实是多余的**（agent_end 本就不会重入），但无害
- **真正的并发风险在 tool execute**：模型可能并发调用 todo/goal 工具，两个 execute 并发读写共享 session.state

**决策：** todo + goal_control 工具标 `executionMode: "sequential"`（Pi 保证整个 batch 串行）。

---

## 决策记录

### D1: task+todo 整合方式 = 完全合并为单一 todo
- **决策：** 删除 goal_manager tool 的 task CRUD（create_tasks/update_tasks/add_tasks/add_subtasks/update_subtasks/delete_subtasks/list_tasks）。所有任务管理统一走 todo 工具。
- **推理：** 消除两套任务系统的冲突（当前 todo 和 goal task 打架，需 prompt 硬规则禁用）。单一数据源更清晰。
- **影响：** goal 不再内嵌 tasks。GoalRuntimeState 删除 tasks 字段。

### D2: todo 模型 = 4 态轻量，不加 evidence/verification
- **决策：** todo item 保持 `{id, text, status}`，status 四态：pending → in_progress → completed → cancelled。
- **不加** evidence/verification/subtasks 字段（用户明确拒绝）。
- **推理：** completion audit 不依赖字段约束，靠 agent 追加验证任务实现。
- **取消当前 goal task 的 subtask 两级层次**——合并后 todo 是单层平铺。

### D3: completion audit = 追加验证任务 + prompt 强制
- **决策：** goal 启动时，agent 必须先用 todo 建"执行任务"（如 1/2/3），然后**必须**追加"验证任务"（如 4：整体验证）。complete 前必须完成所有 todo（含验证任务）。
- **强制性：** prompt 强制（对标 codex continuation.md 的 Completion audit），不硬阻断。
- **示例：** 任务 1/2/3 是执行，任务 4 是"验证整体目标达成：检查 X/Y/Z"。agent 自己决定 audit 拆多少任务。
- **与 codex 对齐：** prompt 包含 Completion audit（逐项证据验证）+ Fidelity（不缩小目标）+ Blocked audit（3次失败才报）。

### D4: goal 感知 todo = 跨扩展 API
- **决策：** 保留 todo extension 独立，暴露 `pi.__todoGetList(): Todo[]` 等编程式 API。goal extension 通过此 API 读 todo 状态（allTasksDone 判定、continuation、budget）。
- **推理：** 避免两个 extension 合并的大改动；复用现有 duck-typed 调用模式（类似 plan→goal 的 __goalInit）。

### D5: Paused 状态 = 用户主动暂停
- **决策：** 新增 paused 状态。`/goal pause` 触发。goal 存活但停续跑。`/goal resume` 恢复。
- **ESC 行为：** 保持当前行为（ESC 时 goal 保持当前状态，不做副作用）。ESC 不自动 pause——pause 是显式用户意图。
- **状态机：** active ⇄ paused（用户），active → blocked（agent），active → budget/time_limited（系统），→ complete（agent）。

### D6: 状态权限分层 = 严格三分层
- **agent（goal_control 工具）：** 只能 complete / blocked
- **用户（/goal 命令）：** pause / resume / clear
- **系统（persistState 兜底）：** budget_limited / time_limited
- **Breaking change：** agent 失去 cancel_goal。用户想退出 → 自己执行 /goal clear。对标 codex。

### D7: goal_control 工具 = 新建轻量工具
- **决策：** 新建 `goal_control` 工具，只含 complete / report_blocked 两个 action。
- **删除** goal_manager tool（10 个 action 全部废弃或迁移）。
- **complete 前置检查：** 调 pi.__todoGetList() 确认所有 todo 完成（含验证任务），否则拒绝。

### D8: 预算自动触发 = persistState 兜底
- **决策：** 在 persistState（每次持久化的单一出口）加 budget 检查。不依赖 event handler 显式调用，不可能漏。
- **对标 codex SQL CASE 思路：** 持久化时自动判定 tokens_used >= tokenBudget → budget_limited。

### D9: plan↔goal 联动 = 自动检测复杂度
- **决策：** goal 启动时检测 plan 可用 + objective 复杂（关键词/字数阈值）→ 提示进 plan mode。plan 完成后自动 init goal + 步骤转 todo。
- **双向：** goal→plan（复杂任务先规划）+ plan→goal（规划完执行）。
- **复杂度判定 [AMBIGUOUS]：** 关键词列表和字数阈值待定。

### D10: 并发保护 = tool 标 sequential
- **决策：** todo + goal_control 工具标 `executionMode: "sequential"`。
- **代价：** batch 里有这些 tool 时，整个 batch 串行（包括其他无关 tool）。
- **可接受：** goal/todo 操作不频繁，串行化代价小。

---

## Round 1 Gap 处理（2026-06-24，追踪发现 30 个 gap）

### G-001/002/003 → D11: 删除 maxTurns/stall，完全对齐 Codex
- **决策：** 删除 BudgetConfig 的 maxTurns 和 maxStallTurns 字段。删除 agent_end 的所有自动终态路径（auto-complete/auto-cancelled/auto-blocked）。
- **终止只靠：** 系统 budget 兜底（FR-5）+ agent goal_control complete/blocked + 用户 /goal clear。
- **stall 退化为 prompt 提醒**（stalenessReminderPrompt 保留注入，但不自动终态）。
- **推理：** Codex 没有 maxTurns/stall 概念，完全信任 agent 自主 complete/blocked + budget 兜底。对齐 Codex。
- **影响：** event-adapter.ts 的 handleProgressAndTasks / handleAllTasksDone / handleNoTasksOrMaxTurns / handleMaxTurnsReached / handleStallAndContinuation 的终态分支全部删除。stallCount 字段可删或保留为提醒计数。

### G-006/007/008 → D12: 跨扩展 API = 瞬态快照 + duck-typed
- **决策：**
  - todo extension 暴露 `pi.__todoGetList(): Todo[]`（读闭包内 TodoSessionState.todos 瞬态快照）
  - plan extension 暴露 `pi.__planStart(requirement: string, ctx): boolean`（进入 plan mode）
  - `__goalInit` 的 tasks 参数废弃（合并后 goal 无 tasks），只传 objective + budget
  - plan complete 后步骤创建：prompt agent 调 todo 工具建 todo（plan extension 无法直接调 todo 工具）
- **类型导出：** Todo 类型从 todo extension 导出，goal import（单一 source of truth）

### G-010/011 → D13: engine 读 todo = adapter 组装后注入
- **决策：** engine 纯函数保持零 Pi 依赖。adapter/service 层先调 `pi.__todoGetList()` 拿到 todo，算好 progress（completedCount/incompleteCount/isAllDone）再传给 engine 纯函数。engine 只接收原始数据（如 ProgressInput {completedCount, totalCount, incompleteIds}），不知道数据来自 todo。
- **影响：** budget.ts checkProgress 签名改为接收 ProgressInput 而非 GoalRuntimeState.tasks。

### G-013/024/030 → D14: paused 边界场景
- **决策：**
  - G-013：进程崩溃时 paused 重启保持 paused（reconstructGoalState 不强制 paused→active）
  - G-024：paused 期间 todo 仍可操作（用户/agent 可改任务），resume 后进度基于新 todo
  - G-030：paused 下用户发指令触发 run 再 ESC，ESC 保持 paused（ESC 守卫扩展覆盖 paused，不转 active）

### G-004/025/026 → D15: cancelled 语义 + 验证任务标记
- **决策：**
  - cancelled = done（goal 和 todo 统一口径：cancelled/completed 都算完成）
  - todo item 加可选字段 `isVerification?: boolean`（修订 D2：todo 模型变为 {id, text, status, isVerification?}）
  - 验证任务（isVerification=true）不可 cancel，goal_control.complete 检查时这些必须是 completed
  - 验证任务未必是最后一条，可能是任意位置的 n 条（agent 决定）
  - todo 状态机保持宽松（不强制 pending→in_progress→completed 顺序，允许跳级），但验证任务的完成靠 complete 前置检查兜底

### G-016 → D16: /goal abort 删除
- **决策：** 删除 /goal abort 命令（语义与 clear 重叠，且 maxTurns 已删）。保留 /goal clear（强制清）。

### G-019 → D17: todo 未加载时降级
- **决策：** goal_control.complete 前置检查调 `pi.__todoGetList` 时，若返回 undefined（todo extension 未加载），拒绝 complete 并提示"需要 todo extension"。

### G-028 → 已确认安全
- before_agent_start 在 followUp 触发的轮次也会 emit（Pi 每个 inner loop 开始前 emit）。第一轮 agent 会收到 contextInjectionPrompt。无需特殊处理。

### G-029 → 接受 Phase 1 缺口
- plan audit 对照 plan.md 的机制标 [AMBIGUOUS]，留 Phase 2。Phase 1 的 complete 检查只验 todo。

### F 类批量确认（纳入 spec，不需问用户）
- G-005/G-017：所有 prompt 中 goal_manager/cancel_goal/complete_goal/add_subtasks 引用更新为 goal_control + todo。AC 补充。
- G-009：deserializeState 加迁移逻辑（旧 entry 含 tasks 字段时忽略 tasks，不 throw）。
- G-012/G-023：tick 时序——pause 命令和 persistState 兜底都遵循"先 tick 再转态"。
- G-015：widget status suffix 补 paused 分支。
- G-018：todo VALID_STATUSES 加 cancelled，migrateTodo 加 cancelled 处理。
- G-020：sequential 是 batch 级（调研确认），同 batch 内顺序执行，安全。
- G-027：GoalTask 引用面迁移——service/tool-adapter/projection/event-adapter/budget/persistence 全部改。

---

## Round 2 收敛复核（2026-06-24，3 个新 gap）

### G-R2-031 → F 类确认：migrateTodo 保留 isVerification
- **事实确认：** migrateTodo (model.ts:56-60) 当前重建 {id, text, status}，会丢弃 isVerification。reconstructState (handlers.ts:79) 用 migrateTodo 恢复。session 重启后验证任务标记丢失 → complete 前置检查失效。
- **决策：** migrateTodo 加 isVerification 保留（连同 cancelled 处理一起）。tool.ts:154-159 的单条 update 路径也需保留 isVerification。AC-1 补充"migrateTodo 保留 isVerification"。

### G-R2-032 → D18: report_blocked 加 active 守卫
- **决策：** goal_control.report_blocked 加 status=="active" 守卫。非 active（paused/blocked/终态）时拒绝并提示"goal 不在 active 状态"。
- **推理：** paused 是用户主动暂停，agent 在 paused 下报 blocked 语义奇怪。对齐 Codex 的 prompt 约束（只在 active 时报 blocked），但用代码守卫更严格。

### G-R2-033 → D19: 空 todo 拒绝 complete
- **决策：** goal_control.complete 前置检查：若 `__todoGetList()` 返回空数组 []（非 undefined），拒绝 complete 并提示"必须先用 todo 工具建任务（含验证任务）"。
- **推理：** FR-6 要求 complete 前必须有验证任务。空 todo = 没建任务 = 没验证。允许空 todo complete 会绕过 audit。

### 收敛状态
Round 2 仅 3 个新 gap（1 F + 2 D），均为实现层细节，已全部处理。预计 Round 3 收敛。

---

## Round 3 收敛复核（2026-06-24，1 个新 gap）

### G-R3-034 → D20: blocked 状态运行时行为对称定义
- **gap：** spec 对 paused 明确列了 5 维度行为（不续跑/不 budget/不注入/不递增 stall/ESC 保持），但 blocked 一个字没写。若 blocked 不停续跑，agent 调 report_blocked → blocked → continuation 继续触发 → agent 再次 report_blocked → 死循环烧预算。
- **决策：** blocked 与 paused 行为对称（都是非终态的"停止"状态）：
  - 不续跑（continuation 跳过）
  - 不做 budget 检查（FR-5 兜底只查 active——blocked 不消耗 budget 因为不续跑）
  - 不注入 context（before_agent_start 返回 undefined）
  - ESC 保持 blocked
  - resume 恢复 active（FR-3 已覆盖）
- **推理：** blocked 是 agent 主动报告的"卡住"状态，语义上就是停止工作等用户介入，与 paused（用户主动停）行为一致，区别只在触发主体。现有代码 blocked 已经是"停止"语义（event-adapter 对 blocked 走终态 notify 分支）。
- **AC 补充：** AC-4 补"blocked 不续跑、不 budget 检查、不注入 context"。

### G-R3-035（低优先级）→ AC-6 prompt 验收清单补全
- **gap：** AC-6 只点名 goal_manager/cancel_goal/complete_goal/add_subtasks，漏 create_tasks/update_tasks/list_tasks。
- **决策：** AC-6 改为"无 goal_manager 及其所有 action 引用"（goal_manager 删除即覆盖全部 action）。


---

## Round 4 边界场景 + AMBIGUOUS 收敛（2026-06-24，调研 Codex CLI，8 个决策）

### D21: 删 agent_end 自动 complete（对齐 Codex）
- **决策：** 删除 handleAllTasksDone 的自动 complete 路径（allTasksDone + maxTurnsReached → 系统自动 complete）。agent 忘调 goal_control.complete → budget 耗尽 → budget_limited 兜底，不自动 complete。
- **推理：** Codex 没有自动 complete。完全信任 agent 自主调 update_goal(complete) + budget 兜底。
- **影响：** event-adapter.ts handleAllTasksDone 的 `finalizeAndPersist(state, "complete", ...)` 分支删除。改为只发 followUp/steer 提示 agent 调 complete。

### D22: 完全删除 maxTurns
- **决策：** 删除 BudgetConfig.maxTurns 字段。终态只靠 token/time budget。删除所有 maxTurnsReached 分支。/goal set --max-turns 参数废弃。
- **推理：** maxTurns 是独立于 token/time 的第三维度。Codex 没有 maxTurns 概念（只有 token_budget）。对齐 Codex。
- **影响：** BudgetConfig 只剩 tokenBudget + timeBudgetMinutes。checkProgress 删除 maxTurnsReached 字段。handleNoTasksOrMaxTurns 的 auto-cancelled 分支删除。

### D23: budget 单一检查点（persistState 兜底）
- **决策：** 终态转换只在 persistState 内完成（单一检查点）。agent_end 的 checkBudgetOnTurnEnd 只做预警/steering，删除 terminal 分支。
- **推理：** Codex 在 SQL `account_thread_goal_usage` 原子完成 budget 检查（单一检查点）。两个并行检查点会导致 race condition。
- **Codex 源码：** `state/src/runtime/goals.rs` 的 `account_thread_goal_usage` — SQL CASE 表达式在 UPDATE 时原子判定 `tokens_used + delta >= token_budget → BudgetLimited`。所有调用方（turn end / tool complete / external mutation）都走这一个函数。
- **影响：** handleBudgetChecks 的 `if (budgetResult.terminal)` 分支删除。persistState 加 `if (active && tokensUsed >= tokenBudget) → budget_limited` 判断。

### D24: blocked 期间 token 不算 goal budget
- **决策：** blocked 状态下 message_end 不累加 token。blocked 期间的对话 token 不计入 goal budget。
- **推理：** goal 被 block 了，期间的对话是用户自己的交互，不是 goal 工作。与 paused 对称。
- **现状确认：** applyEvent("message_end") 已有 `if (!isActiveStatus(status)) break` 守卫，无需额外改动。

### D25: paused 下 /goal set 拒绝覆盖
- **决策：** /goal set 在已有非终态 goal 时拒绝（含 paused），提示"先 /goal resume 或 /goal clear"。
- **推理：** Codex 的 create_goal 在已有 goal 时拒绝（`cannot create a new goal because thread already has a goal`）。update_goal 只接受 complete|blocked。
- **Codex 源码：** `core/src/tools/handlers/goal/update_goal.rs` — `if !matches!(args.status, Complete | Blocked) → error`。
- **影响：** handleSet 的"覆盖非终态旧 goal"分支改为拒绝。只有终态旧 goal 时才允许快速路径覆盖。

### D26: LLM 判定 plan 复杂度
- **决策：** 复杂度判定改为 LLM 自主判断。goal 启动第一轮 prompt 引导 agent 自行判断是否需要 plan。不硬编码关键词/阈值。
- **推理：** 硬编码阈值不够灵活（"重构"可能是简单重命名也可能是架构级改动）。LLM 能理解语义。
- **影响：** FR-7 的 [AMBIGUOUS] 解决。contextInjectionPrompt 增加 plan 建议段落。

### D27: plan audit = agent 检查 plan.md 步骤全执行
- **决策：** goal_control.complete 前置检查增加 plan.md 对照。若 goal 关联了 plan，agent 必须验证 plan.md 每个步骤是否已执行，未执行的步骤必须补完或显式跳过（附理由）。
- **推理：** 完整 plan→goal 闭环需要 plan audit。Phase 1 用 prompt 驱动（对标 Codex Completion audit），不做硬编码 plan.md 解析。
- **影响：** FR-2 complete 前置检查增加 plan audit 项。FR-6 prompt 增加 plan 步骤对照。

### D28: 删除 stallCount + maxStallTurns（对齐 Codex）
- **决策：** 删除 GoalRuntimeState.stallCount 和 BudgetConfig.maxStallTurns。stalenessReminderPrompt 改为基于单 task 的 lastUpdatedTurn 检测（现有 checkStaleness 已有此逻辑）。
- **推理：** Codex 没有 stall 概念。continuation 是 goal active + 空闲 → 自动发 continuation_prompt，不检测"是否取得进展"。stallCount 仅剩 prompt 提醒用途，用单 task 级 lastUpdatedTurn 替代更精确。
- **Codex 源码：** `core/src/goals.rs` — `goal_continuation_candidate_if_active` 只检查 goal.status == Active + 无活跃 turn + 无 pending input，无 stall 检测。
- **影响：** GoalRuntimeState 删 stallCount。BudgetConfig 删 maxStallTurns。handleStallAndContinuation 删 stallCount++ 和 stallCount >= maxStallTurns 分支。

### D29: 勘误 — budget 检查点实际在 persistAndUpdate（事件路径）
- **背景：** NFR 阶段代码取证（F2）发现：事件路径走 `persistAndUpdate`（tickState + appendEntry + updateWidget），不走 `service.persistState`（command/tool 路径）。budget 终态检查必须落在 persistAndUpdate 内，否则 token 累加后检查永不触发。
- **勘误：** D6/D8/D23 原文写的「persistState 兜底」「在 persistState 加 budget 检查」应修正为 **persistAndUpdate（事件路径）**。
  - persistState（command/tool 路径）：不含 budget 检查，只做 tickState + 落盘
  - persistAndUpdate（事件路径）：含 budget 终态检查 + tickState + 落盘 + updateWidget
  - 两者都调 tickState（单一 tick 定义点）
- **决策依据变更：** 单一检查点原则不变（仍对齐 Codex SQL CASE），仅落点从 persistState 修正为 persistAndUpdate。消除 race condition 的结论不变。
- **已同步：** spec FR-5/AC-5/UC-3、issues #5、code-architecture §3/§6、non-functional-design F2、execution-plan Wave 5 #5 均已统一为 persistAndUpdate。
- **为何不回改 D6/D8/D23 原文：** 保留决策历史原貌，追加勘误可追溯"当初怎么想 → 后来为什么修正"的完整链路。
