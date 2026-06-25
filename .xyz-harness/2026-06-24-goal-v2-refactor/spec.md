---
verdict: pass
---

# Goal V2 Refactor：对标 Codex 的架构升级

## Background

当前 goal extension 在架构分层、预算控制上优于 Codex，但有三个关键差距：
1. 缺少 Paused 状态（用户无法干净地叫停续跑）
2. budget 耗尽依赖 event handler 显式检查，可能漏触发
3. task（goal 内嵌）和 todo（独立 extension）两套系统并存，需 prompt 硬规则避免冲突

同时存在架构债务：goal_manager 工具承载 10 个 action 职责过重；maxTurns/stall 自动终态路径与权限分层冲突。

本次重构对标 Codex（删除 maxTurns/stall/自动终态、系统只 budget 兜底、agent 自主 complete/blocked、budget 检查单一检查点在 persistAndUpdate（事件路径，NFR F2 取证确认）），同时保留本项目已有的优势（架构分层、预算维度、continuation 去抖）。

## Functional Requirements

### FR-1: task+todo 完全合并为单一 todo

**删除：**
- goal_manager tool（10 个 action 全部废弃）
- GoalRuntimeState.tasks 字段
- engine/task.ts 的 GoalTask/Subtask/TaskVerification 模型及所有 task CRUD 逻辑
- service.ts 中所有 task action
- budget.ts 中引用 state.tasks 的逻辑（checkProgress 等）

**todo extension 成为唯一的任务管理入口：**
- todo item 模型：`{id: number, text: string, status: "pending"|"in_progress"|"completed"|"cancelled", isVerification?: boolean}`
- 状态四态：pending → in_progress → completed；任一状态 → cancelled
- 状态机保持宽松（不强制顺序，允许跳级），但验证任务靠 complete 前置检查兜底
- `isVerification` 可选字段标记验证任务（FR-6 completion audit 用）
- todo 工具 action：list / add / update / delete / clear（保持现有）
- update 支持 cancelled；add 支持 isVerification（可选）
- todo 工具标 `executionMode: "sequential"`
- VALID_STATUSES 加 cancelled；migrateTodo 加 cancelled 处理
- 删除 todo tool 的 anti-goal prompt（"goal 激活时禁用 todo"等）

**跨扩展数据共享（duck-typed API）：**
- todo extension 暴露 `pi.__todoGetList(): Todo[] | undefined`（瞬态快照；未加载返回 undefined）
- Todo 类型从 todo extension 导出，goal import

**engine 纯函数获取 todo 数据（adapter 组装后注入）：**
- engine 保持零 Pi 依赖
- adapter/service 先调 __todoGetList()，算好 progress 再传 engine
- budget.ts checkProgress 改为接收 ProgressInput（{completedCount, totalCount, incompleteIds, hasVerificationPending}）

**旧数据迁移：**
- deserializeState 加迁移：旧 entry 含 tasks 字段时忽略（不 throw）
- makeHistoryEntry 不再读 state.tasks.length

### FR-2: 新建 goal_control 工具（轻量状态控制）

- 工具名：`goal_control`，2 个 action：`complete` / `report_blocked`
- 标 `executionMode: "sequential"`
- **complete 前置检查：**
  1. 调 `pi.__todoGetList()`，undefined（未加载）→ 拒绝，提示"需要 todo extension"
  2. 空数组 [] → 拒绝，提示"必须先用 todo 工具建任务（含验证任务）"
  3. 非验证任务必须 completed 或 cancelled；验证任务（isVerification=true）必须 completed（不可 cancelled）
  4. 有未完成 todo → 拒绝，列出未完成项
- **complete 参数：** evidence（string，必填）
- **report_blocked 参数：** reason（string，必填）
- **report_blocked 守卫：** status=="active" 才允许；非 active 拒绝并提示"goal 不在 active 状态"

### FR-3: 新增 Paused 状态 + blocked 行为对称定义

- GoalStatus 增加 `"paused"`（非终态）
- `/goal pause`：active → paused（先 tick 再转换）
- `/goal resume` 扩展：支持 paused→active 和 blocked→active（都做 budget 重检 + 触发 AI）
- **paused 与 blocked 行为对称**（都是非终态"停止"状态，区别只在触发主体）：
  - 不续跑（continuation 跳过）
  - 不做 budget 检查（FR-5 兜底只查 active）
  - 不注入 context（before_agent_start 返回 undefined）
  - 不递增 stall（stallCount 已删除）
  - ESC 保持当前状态（paused 下 ESC 保持 paused；blocked 下 ESC 保持 blocked）
- paused 期间 todo 不冻结（可操作，resume 后基于新 todo）
- 持久化恢复：reconstructGoalState 不强制 paused→active（崩溃后保持 paused；blocked 保持 blocked）
- widget 补 paused 和 blocked 显示

### FR-4: 状态权限严格三分层

| 主体 | 可触发的转换 | 入口 |
|---|---|---|
| **agent** | active → complete；active → blocked | goal_control 工具 |
| **用户** | active → paused；paused/blocked → active；任意 → cancelled | /goal pause/resume/clear |
| **系统** | active → budget_limited；active → time_limited | persistAndUpdate 兜底（FR-5） |

**删除所有自动终态路径（对齐 Codex）：**
- 删除 agent_end 的 handleAllTasksDone/handleNoTasksOrMaxTurns/handleMaxTurnsReached 的自动终态分支（agent 忘调 complete → budget 耗尽兜底，不自动 complete）
- 删除 stall 自动 blocked 路径（stalenessReminderPrompt 保留注入，不自动终态；删 stallCount 全局计数，改为单 task 级 lastUpdatedTurn 提醒）
- 删除 /goal abort 命令、cancel_goal
- 删除 BudgetConfig.maxTurns 和 maxStallTurns（终态只靠 token/time budget）

### FR-5: budget 自动触发（persistAndUpdate 兜底，事件路径）

- **单一检查点**（对齐 Codex SQL CASE）：persistAndUpdate 内加 budget 兜底（status==active 且 tokens_used >= tokenBudget → 自动转 budget_limited/time_limited）。终态转换只在此处，不重复。注：persistAndUpdate 是事件路径（message_end/turn_end）的 persist 函数，非 command/tool 路径的 persistState
- tick 在检查前执行；转终态走 finalizeAndPersist（避免重复 tick：此时 status 已非 active）
- agent_end 的 checkBudgetOnTurnEnd **只做预警/steering**（70/90 预警 + 90% steering prompt），不做终态转换（删除 terminal 分支）
- /goal resume 时做 budget 重检（checkBudgetOnResume）

### FR-6: completion audit 强化（prompt 驱动，对标 Codex）

- contextInjectionPrompt 强制要求 agent 先建 todo（执行任务 + 验证任务 isVerification=true）
- continuationPrompt 持续提醒 complete 前完成所有 todo
- prompt 对标 Codex continuation.md 三约束：Completion audit / Fidelity / Blocked audit
- goal_control.complete 前置检查：**已移除（全解耦）**——complete 不再检查 todo 完成状态（原 `pi.__todoGetList` 跨 extension 失效）。todo 是否全完成由 AI 自行判断，goal 仅通过 prompt 软建议。complete 唯一前置：evidence 必填 + status==active。plan.md 步骤对照为 prompt 驱动软提醒（D27 决策）
- 所有 prompt 更新：goal_manager/cancel_goal/add_subtasks → goal_control + todo

### FR-7: plan↔goal 自动联动

**goal → plan：** goal 启动检测 plan 可用（`typeof pi.__planStart === "function"`）+ 复杂度 → 提示进 plan mode。plan 暴露 `pi.__planStart(requirement, ctx): boolean`。
**plan → goal：** plan complete 选 goal 模式 → `__goalInit(objective, budget, ctx)`（tasks 参数废弃）。步骤通过 prompt 引导 agent 调 todo 创建。
**复杂度判定：** LLM 判定——goal 启动第一轮 prompt 引导 agent 自行判断是否需要 plan（"如任务复杂，先进 plan mode 规划"），不硬编码关键词/阈值。

**plan audit：** goal_control.complete 时若 goal 关联了 plan，agent 应验证 plan.md 的每个步骤是否已执行。此为 **prompt 驱动的软提醒**（D27 决策，对标 Codex Completion audit），无硬检查——全解耦后 complete 不检查 todo/plan 状态，全部由 AI 自行决策。

## Acceptance Criteria

### AC-1: task+todo 合并
- [ ] goal_manager tool 不存在
- [ ] todo item 是 {id, text, status, isVerification?}，status 四态含 cancelled
- [ ] todo 工具标 executionMode: "sequential"
- [ ] pi.__todoGetList() 返回快照（未加载返回 undefined）
- [ ] Todo 类型从 todo extension 导出
- [ ] goal extension 不含 GoalTask/Subtask/TaskVerification
- [ ] engine/task.ts 删除或清空
- [ ] deserializeState 旧 entry 不崩溃
- [ ] budget.ts checkProgress 接收 ProgressInput
- [ ] todo tool anti-goal prompt 已删除
- [ ] VALID_STATUSES 含 cancelled，migrateTodo 处理 cancelled 且保留 isVerification

### AC-2: goal_control 工具
- [ ] goal_control 存在，只含 complete/report_blocked
- [ ] complete 前置：todo 未全完成拒绝；验证任务不可 cancelled；空 todo 拒绝
- [ ] todo 未加载时 complete 拒绝
- [ ] report_blocked 守卫：非 active 拒绝
- [ ] goal_control 标 executionMode: "sequential"

### AC-3: Paused 状态
- [ ] /goal pause 将 active 转 paused（先 tick）
- [ ] /goal resume 支持 paused→active 和 blocked→active
- [ ] paused 不续跑、不 budget 检查、不注入 context
- [ ] paused 下 ESC 保持 paused
- [ ] paused 期间 todo 可操作
- [ ] 崩溃后 paused 持久化恢复
- [ ] widget 显示 paused

### AC-4: 状态权限三分层 + 删除自动终态
- [ ] agent 只能 complete/blocked（goal_control）
- [ ] 用户能 pause/resume/clear
- [ ] 系统自动 budget/time_limited（persistAndUpdate）
- [ ] agent 无法 cancel
- [ ] BudgetConfig 无 maxTurns/maxStallTurns
- [ ] agent_end 无自动终态路径（handleAllTasksDone/handleNoTasksOrMaxTurns/handleMaxTurnsReached 删终态分支）
- [ ] agent_end checkBudgetOnTurnEnd 只做预警/steering，不做终态
- [ ] /goal abort 删除
- [ ] stallCount 字段删除，stalenessReminderPrompt 改为单 task 级 lastUpdatedTurn 提醒
- [ ] blocked 不续跑、不 budget 检查、不注入 context（与 paused 对称）
- [ ] blocked 下 ESC 保持 blocked

### AC-5: budget 自动触发
- [ ] persistAndUpdate 内有 budget 兜底（单一检查点，终态转换只在此处）
- [ ] agent_end 无 terminal 检查（只做 warning/steering）
- [ ] /goal resume 时 checkBudgetOnResume 拒绝已超 budget 的 goal
- [ ] 不重复 tick

### AC-6: completion audit
- [ ] contextInjectionPrompt 要求建 todo（含 isVerification 验证任务）
- [ ] goal_control.complete 拒绝未完成/验证任务 cancelled
- [ ] 所有 prompt 无 goal_manager 及其全部 action（create_tasks/update_tasks/list_tasks/cancel_goal/complete_goal/add_subtasks 等）引用
- [ ] prompt 含 Codex 级 Completion audit / Fidelity / Blocked audit

### AC-7: plan↔goal 联动
- [ ] plan 暴露 pi.__planStart(requirement, ctx)
- [ ] goal 启动检测 plan + 复杂度 → 提示
- [ ] plan complete 选 goal → __goalInit(objective, budget, ctx)（无 tasks）
- [ ] plan 步骤 prompt 引导 agent 调 todo
- [ ] plan audit：complete 前检查 plan.md 步骤是否全执行（prompt 驱动）
- [ ] 复杂度判定：LLM 自主判断（prompt 引导），无硬编码阈值

## Constraints

- 技术栈：TypeScript + Pi extension API
- 并发模型：事件 handler 串行（安全），tool execute 并发（sequential 标记保护）
- 持久化：Pi session entries，无独立 DB
- engine 保持零 Pi 依赖
- 跨扩展 API 用 duck-typed（pi.__xxx）
- sequential 是 batch 级
- 对齐 Codex：无 maxTurns/stall 概念、budget 单一检查点、agent 自主 complete/blocked + budget 兜底

## 决策记录

见 clarification.md D1-D17。

## 业务用例

### UC-1: 复杂任务全流程（plan → goal → todo → audit）
- **Actor**: 开发者
- **场景**: 重构核心模块
- **预期结果**: /goal → 检测复杂 → plan mode → 规划完成 → __goalInit → prompt 建 todo（执行+验证）→ 执行 → goal_control complete

### UC-2: 用户叫停续跑
- **Actor**: 开发者
- **场景**: goal 续跑中插入指令
- **预期结果**: /goal pause → 用户发指令（todo 可改）→ /goal resume → 续跑

### UC-3: 预算耗尽自动终止
- **Actor**: 系统
- **场景**: token 预算耗尽
- **预期结果**: persistAndUpdate 检测 → budget_limited → 通知 → 不续跑

### UC-4: agent 自主完成
- **Actor**: agent
- **场景**: 完成所有 todo（含验证任务）
- **预期结果**: goal_control complete(evidence) → 前置检查通过 → complete

## [AMBIGUOUS] 标记

（全部已解决，见 clarification.md D21-D29）
