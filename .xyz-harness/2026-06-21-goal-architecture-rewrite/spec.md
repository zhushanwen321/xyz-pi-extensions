---
verdict: pass
---

# Goal 扩展架构重写

## Background

`extensions/goal`（`@zhushanwen/pi-goal`，~3300 行）经一轮 P0/P1 重构（大函数拆分、ACTION_HANDLERS 路由表）后骨架可用，但仍存在三类架构问题：

1. **分层归位错误**：`tool-handler.ts`（261 行）堆了 7 个不同变化轴（Session 类型 / Schema / 持久化 / Widget 投影 / Result 构建 / 消息发送 / 分发入口）。`GoalSession`（进程内瞬态）定义在 tool-handler 而非 state 域
2. **模型遗漏**：`GoalHistoryEntry` 是独立领域概念（已终结 Goal 的归档投影），但从未建模，散落在 `writeGoalHistoryEntry`（写）和 `handleHistory`（读）两处。Evidence（完成声明）与 Verification（验证契约）的双维度语义未显式化
3. **双轨债**：`__goalInit`（扩展间编程入口）有独立的 task 构造实现，与正规 `handleSet + handleCreateTasks` 漂移

本次重写目标：**对内是白盒重组（建模 + 分层 + 消重复），对外尽量保持契约，解除已知架构债务**。

## Functional Requirements

### FR-1: 引擎层（engine/，零 Pi 依赖，纯状态机 + 决策）

> 命名说明（D-22）：用 `engine/` 而非 `domain/`。"domain" 是 DDD 术语，暗示每个概念都该建 aggregate / repository，容易诱导过度建模（如 GoalHistory 被提为一等 aggregate）。"engine" 换框后自然问"这个 engine 计算什么"，不带 aggregate 包袱。

#### FR-1.1 Goal Aggregate（`engine/goal.ts`）
- 显式聚合根 `Goal`，持有：identity / objective / status / tasks / lifecycle meta
- `GoalStatus` 保持 7 态枚举：`active | paused | blocked | complete | budget_limited | time_limited | cancelled`
- 状态机不变量：
  - 终态集合 `{complete, budget_limited, time_limited, cancelled}` 不可逆
  - `paused` / `blocked` 是仅有的可逆中间态
  - `transitionStatus(current, next)` 守卫终态不可覆盖
- 零 Pi import（只 import typebox）

#### FR-1.2 Task Aggregate（`engine/task.ts`）
- `Task` 实体 + `Subtask` 轻量执行单元
- `TaskStatus` 保持 5 态：`pending | in_progress | completed | verified | cancelled`
- `SubtaskStatus` 保持 3 态：`pending | in_progress | completed`（无 verification，刻意设计）
- **双维度投影函数**（纯函数）：
  - `getCompletionState(task): "not_done" | "done"`
  - `getVerificationState(task): "no_verification" | "pending_verification" | "verified"`
- 双维度规则集中：
  - `completed` + 无 verification → completion=done, verification=no_verification（终态）
  - `completed` + 有 verification → completion=done, verification=pending_verification（非终态）
  - `verified` → completion=done, verification=verified（终态）
- 任务状态机转换合法性校验（当前 `validateUpdateTasks` 的规则归位至此）
- 零 Pi import

#### FR-1.3 Budget 值对象（`engine/budget.ts`）
- 内部分两类：
  - `resource: { tokenBudget?, timeBudgetMinutes? }` — 可消耗资源（连续递减，百分比检测）
  - `boundary: { maxTurns, maxStallTurns }` — 硬边界（离散递增，计数检测）
- 消耗状态（tokensUsed / timeUsedSeconds / stallCount / currentTurnIndex / lastProgressTurn）归属 Budget
- `checkBudget(state, context)` 返回决策结果（warning70 / warning90 / steer_limit / exceeded）
- 预警标志按维度独立：`tokenWarning70Sent` / `tokenWarning90Sent` / `timeWarning70Sent` / `timeWarning90Sent`（修复当前 token/time 共用一个 flag 的 bug）
- 零 Pi import

#### FR-1.4 GoalHistory 数据模型（归入 `persistence.ts`，非 aggregate）
- `GoalHistoryEntry` 是终态 goal 的归档记录，**无领域行为、无状态机、无不变量**——是 DTO，不是 aggregate（D-09 修正）
- 字段：goalId / objective / finalStatus / completedTasks / totalTasks / elapsedSeconds / timestamp
- persistence 层提供 `appendHistory(entry)` / `queryHistory()` 两个简单函数
- 类型定义放 persistence 层即可，不需要在 engine 层建模
- 与 Goal 独立生命周期（Goal clear 后 session 清空，History 留存）

### FR-2: 分层架构（端口适配器 + 适度充血）

#### FR-2.1 目标分层结构
```
engine/      (零 Pi 依赖，纯状态机 + 决策，可单测)
  goal.ts    task.ts    budget.ts
ports.ts     (Pi 接口契约抽象类型)
session.ts   (运行时句柄 + 状态重建 + entry GC)
persistence.ts (serialize/deserialize + history R/W + GoalHistoryEntry 类型)
service.ts   (协调层：applyToolAction / applyEvent 两入口，调 engine 纯函数)
adapters/
  tool-adapter.ts    (路径 A：goal_manager tool 分发 + persist + 返回 ToolResult)
  command-adapter.ts (路径 A：/goal 命令解析 + handler)
  event-adapter.ts   (路径 B：Pi 事件 handler + 并发保护 + persistAndUpdate + sendMessage)
  actions.ts         (10 个 action handler，调 service.applyToolAction)
projection/
  widget.ts  prompts.ts   result.ts
index.ts     (工厂：注册 tool/command/events)
```

#### FR-2.2 ports.ts 契约（边界载体，非可替换性）
- 定义 engine 需要的能力抽象：`PersistencePort` / `UiPort` / `MessagingPort` / `SessionPort`
- **ports 的核心价值是机器可检查的边界**，不是"可替换的 adapter"：`engine/` 目录禁止 import `@mariozechner` 这条 lint 规则比任何口头约定都硬，AI agent 拿不准能否 import Pi 时直接编译失败。多 AI agent 维护下，ports 是这条边界的载体
- ExtensionContext / Theme / SessionEntry 等用此抽象替代，engine 不直接 import Pi 类型

#### FR-2.3 service.ts（双入口协调层，非唯一入口）
- **两条路径各自有入口**（D-21，修正原 FR-3.2 的 applyCommand 统一）：
  - `applyToolAction(state, action) → { state, result }`：路径 A（命令/工具）用，同步、返回值、无并发保护
  - `applyEvent(state, event) → { state, effects[] }`：路径 B（事件）用，副作用驱动、返回 effects 列表
- 两者都调 engine 层纯函数（`transitionStatus` / `finalizeGoal` / `checkBudget` / `applyTaskUpdate`），engine 层是真正的共享层
- 并发保护（isProcessing / goalId snapshot / stale-check / signal.aborted 守卫）在 `event-adapter.ts`，不进 service——因为这些只对事件路径有意义
- persist 时机由各 adapter 决定（路径 A 用 `persist`，路径 B 用 `persistAndUpdate` 含 widget）

### FR-3: 唯一收敛点（规约式 API）

> **命名修正（D-21）**：原 FR-3.2 的 `applyCommand(state, command)` 统一命令和事件两类输入——经链路分析，两类输入的触发方、返回值、并发模型、错误处理、persist 方式全不同（见 clarification.md 链路对比表）。强行合并成一个函数等于用 if 拼两个无关逻辑，AI agent 维护负担反而加重。
> 修正：engine 层纯函数是真正共享层；service 层分 `applyToolAction` / `applyEvent` 双入口；并发保护留在 event-adapter。
> **注意**：FR-3 是概述，详细行为以 FR-8 为准。当 FR-3 与 FR-8 描述冲突时，FR-8 为权威。

#### FR-3.1 唯一创建入口 `createGoal(objective, tasks?, budget?)`
- 三个创建来源都走它：
  - `/goal <objective>` 命令（set）
  - `goal_manager.create_tasks` tool action
  - `__goalInit` 外部编程调用
- task 构造逻辑唯一（normalizeDescription + id 分配），消除双轨

#### FR-3.2 双更新入口（D-21，取代原 applyCommand）
- **`applyToolAction(state, action) → { state, result }`**：路径 A（用户命令 / AI tool call）用
  - 同步，调用方等结果，返回 ToolResult
  - 无并发保护（工具调用天然串行）
  - 10 个 action handler + 8 个 /goal 子命令都调它
- **`applyEvent(state, event) → { state, effects[] }`**：路径 B（Pi runtime 事件）用
  - 异步，副作用驱动，返回 effects 列表（continuation/steer/notify 等）
  - 并发保护在 event-adapter（isProcessing / goalId snapshot / stale-check / signal.aborted）
  - 6 个事件 handler（before_agent_start / agent_start / turn_end / message_end / agent_end / session_start）都调它
- **两者共享 engine 层纯函数**（transitionStatus / finalizeGoal / checkBudget / applyTaskUpdate）

#### FR-3.3 唯一完成入口 `finalizeGoal(terminalStatus, reason)`
- 收口当前散落的终态序列（cancel/clear/abort 三处重复 + complete/budget_limited/time_limited 序列）
- **blocked 不走此入口**（blocked 是中间态，report_blocked 直接设状态 + persist，不写 history）
- 统一：设终态 status → writeHistoryEntry（按矩阵条件）→ persist
- **clearSession 仅对 cancelled 立即执行**（详见 FR-8.7）

#### FR-3.4 唯一投影入口（可选分离）
- widget / prompt / result 三种投影维度可分离（不同展示维度）
- 但 budget 格式化当前 4 处重复（makeGoalResult / buildBudgetReport / formatBudgetInfo / formatBudgetLine）需收敛

### FR-4: `__goalInit` 双轨消除（D1 + D-12 + D-16）

#### FR-4.1 双轨消除
- `__goalInit` 内部实现改为调唯一 `createGoal()`
- 移除 index.ts 中内联的 task 构造代码（normalizeDescription + id 分配统一到 createGoal）

#### FR-4.2 签名调整
- 签名：`(__goalInit)(objective: string, tasks: string[], budget?: GoalExternalBudget, ctx: ExtensionContext) → boolean`
- **tasks 仍接收**（D-12）：核心价值是"task 构造逻辑唯一"，不是"砍参数"。内部委托 createGoal 处理
- **ctx 改为必填**（D-16，修正 G-R2-007）：消除 lastCtx 模块级可变状态，service 层不捕获/持有 ctx。3 个调用方都已传 ctx，收紧契约无运行时影响
- 保留 `pi.__goalInit` 作为通信机制（A-07 确认是 Pi 官方私有协议，非 hack）

#### FR-4.3 调用方零影响（无降级）
- coding-workflow Phase 2/3、plan compact 的 3 个调用点都已传 ctx，零改造、零降级，照常预填 task
- 不需要后续 ticket（D-04 原计划的宿主扩展改造取消）

### FR-5: 序列化清断兼容（架构必要的行为变更）
> **标注**：这是架构重写**必须**的行为变更——engine 层要零 Pi 依赖、deserialize 要纯净，就必须移除向后兼容逻辑。旧格式迁移代码（`subTodos→subtasks` fallback、字段默认值兜底）正是 engine 层纯净性的障碍。用户已认可（历史对话不会再打开）。与 FR-8.8 等"可选产品决策"不同，此项不可拆分。
- 移除 `deserializeState` 的旧格式迁移逻辑（`subTodos→subtasks` fallback、字段默认值兜底）
- `deserializeState` 假设输入是新格式，字段缺失直接报错
- 旧 entry 丢弃（用户认可：历史对话不会再打开）
- **部分损坏 entry 全丢**（G-024）：单个 task 缺 status 字段时整个 state=null（保持当前行为，不采取"跳过坏 task 保留好 task"）

### FR-6: 行为修复

#### FR-6.1 widget 实时刷新（G-005）
- **只覆盖 state 变更 action**（create/add/update/complete/cancel/report_blocked/subtask 操作）
- list_tasks 是只读 action，不触发刷新（保持当前行为）
- command handler（pause/resume/clear/update）当前已通过 persistAndUpdate 刷新，保持
- 实现：state 变更 action 改用 persistAndUpdate，或在 executeGoalAction 出口统一刷

#### FR-6.2 预警维度独立
- token / time 各自独立的 warning70/90 sent flag（见 FR-1.3）
- 修复当前 token 先到 70% 发预警后 time 到 70% 被吞的 bug

#### FR-6.3 clear / abort 语义保留
- 不合并为带 force 参数的单一命令
- clear = 强制清（不检查未完成任务）
- abort = 检查未完成任务（有 nonCancelled tasks 则拒绝）
- 两者共用 `finalizeGoal` 内部实现，差异仅在入口前置检查

#### FR-6.4 删除僵尸字段 hasPendingInjection（G-019）
- grep 确认 5 处写入、0 处读取，删除

#### FR-6.5 时间累计从 persist 剥离（G-008）
- persist 只做序列化（纯），不再有副作用
- 时间累计作为 Budget 的 `tick()` 方法，由 service 在 persist 前调用
- Budget.tick() 可纯函数单测

#### FR-6.6 headless 守卫（G-022）
- updateWidget 前检查 `ctx.hasUI`，无 UI 时跳过 setWidget/setStatus（适配 RPC mode）

#### FR-6.7 ESC 纯打断设计（基于 Pi abort 实测时序）

**Pi abort 时序（已源码验证，`pi-mono-fix-workspace/main`）**：
ESC → `AbortController.abort()`（`agent.ts:301`）→ 底层流中断，LLM 返回 `stopReason="aborted"` → 依次 emit `message_end`(aborted) → `turn_end`(toolResults=[]) → `agent_end` → `runLoop` return，整个 run 结束，等用户下一条消息。
**abort 后、用户发新消息前，`before_agent_start` 不会触发**（它只在 `AgentSession.prompt()` 路径触发，`agent-session.ts:1099`）。
ESC 还会清空 steering/followUp 队列（`interactive-mode.ts:3751`）——即使 agent_end 试图发 continuation，Pi 也会丢弃。

**三个事件 handler 都要做 aborted 守卫**（不止 agent_end）：

| 事件 | abort 时会触发？ | 当前行为 | ESC 要求的行为 |
|------|---------------|---------|--------------|
| message_end | ✅（aborted assistant msg） | 若 active 尝试累加 token | 跳过 token 累加（aborted 消息 usage 通常为空，显式跳过防边界） |
| turn_end | ✅ | `currentTurnIndex++` | **跳过递增**（ESC 不算 goal turn，不消耗 turn 预算） |
| agent_end | ✅ | 走 budget/stall/continuation 全套 | **完整守卫**：不发 continuation、不递增 stallCount、不做 budget 检查、不转 paused/blocked，goal 保持 active |

- **恢复**：用户下次输入 → `before_agent_start` 正常触发 → goal 仍 active → 正常注入 context injection，goal 继续 autonomous loop。无需特殊处理。
- **与 pause 的区分**：
  - ESC = 纯打断，无状态变化，用户可能只是想追加信息
  - `/goal pause` = 显式暂停（用户去做别的事），转 paused 状态
  - context > 85% = 资源保护，转 paused 状态
- **实现**：
  - 三个事件 handler 入口检查 `ctx.signal?.aborted`，true 则各自跳过副作用
  - 移除 `pendingPause` 字段（不再需要 ESC→paused 的间接路径）
  - 不需要额外的"被打断状态"标记——abort 后 run 直接结束，before_agent_start 不会误触发，下次用户输入自然恢复

### FR-7: T3 测试覆盖

#### FR-7.1 engine 层全枚举
- `engine/goal.test.ts`：7 态全转换矩阵、终态守卫、stall→blocked、resume→terminal（预算重检）
- `engine/task.test.ts`：5 态全转换、双维度投影函数全组合（completion × verification）、verified 要求 verification 配置、completed 无 verification 全锁
- `engine/budget.test.ts`：70/90/100% 三阈值（token/time 各一套）、tight 检测、维度独立预警、tick() 时间累计、token 累加算法（max(input-cacheRead,0)+output 及 totalTokens fallback）

#### FR-7.2 service 层
- `service.test.ts` 用 fake adapter（实现 ports.ts 接口的内存实现）
- 覆盖：createGoal 三调用源都走唯一入口、finalizeGoal 唯一完成入口、persist 时机、project 时机、tick() 在 persist 前调用

#### FR-7.3 行为回归 + 端到端
- **改写**现有 3 个测试（非简单迁移）：
  - `deserialize-state.test.ts`：当前测的是旧格式向后兼容，需改写为验证新行为（字段缺失 → throw / state=null）
  - `is-task-done.test.ts`：迁移，行为不变
  - `validate-update-tasks.test.ts`：迁移，行为不变
- 端到端：mock Pi runtime 跑完整 goal 生命周期（create → update → verify → complete），验证事件链路（before_agent_start / message_end token 累计 / agent_end continuation）
- 验证并发保护：goalId snapshot stale-checker 在 agent_end 期间的并发覆盖场景
- 验证 ESC 纯打断：signal.aborted 后不发 continuation、不递增 turn、goal 保持 active

#### FR-7.4 测试基础设施
- vitest.config.ts 保持 stub alias 机制
- 测试不 import Pi SDK（通过 ports 抽象或 fake 实现）

### FR-8: 行为契约保持（重构不得遗漏）

> **权威性说明**：FR-8 是对源码行为的精确描述。当 FR-8 与其他章节（如 FR-3.3）描述冲突时，FR-8 为权威。其他章节仅作概述，详细行为以 FR-8 为准。

追踪发现的 "代码有 spec 没写" 的保持行为，全部必须在新架构中保留。

#### FR-8.1 持久化生命周期
- **Entry GC**（G-006）：goal-state entry 只保留最新 1 条（reconstructGoalState splice 其余）；goal-history entry 保留最近 20 条（MAX_HISTORY_ENTRIES）
- **AUTO_CLEAR_TURNS=2**（G-007）：终态 goal 在 before_agent_start 经过 `currentTurnIndex - completedAtTurnIndex >= 2` turn 后自动 clearGoalSession
- **部分损坏全丢**（G-024）：deserializeState 遇到缺字段的 task 直接 throw，reconstructGoalState catch 后整个 state=null
- **persist 失败保持现状**（G-023）：事件处理器内不额外加 try/catch（保持当前行为，不静默吞错）

#### FR-8.2 并发与防御机制
- **goalId snapshot stale-checker**（G-020）：agent_end 入口快照 goalId，每个子 handler 通过 checkStale() 判断中途是否被新 goal 覆盖，stale 则中止后续副作用
- **isProcessing 防重入守卫**（G-021）：agent_end 重入时直接返回
- **Stale context 检测**（G-010）：tool execute 外层捕获 isStaleContextError（匹配 aborted/context canceled/stale context/extension context no longer active）→ 返回 stale 提示；其他错误 → 返回 msg + JSON.stringify(params)
- **ESC 纯打断**（FR-6.7）：signal.aborted 时 agent_end 不发 continuation，不注入 goal prompt，goal 保持 active，不递增 currentTurnIndex

#### FR-8.3 状态机行为
- **transitionStatus 保持宽松**（G-016）：仅守卫终态不可覆盖，不收紧为显式转换表
- **completed 无 verification 全锁**（G-017）：`completed && !verification` 的 task 不能再改（连 cancel 都拒绝）。与 prompt 的 "Cancelled does not block goal completion" 不矛盾——后者指 cancelled task 不阻塞 goal 完成
- **subtask 保持宽松**（G-018）：无严格状态机校验（允许 pending→completed 跳过 in_progress），轻量执行单元刻意设计
- **resume 可转 terminal**（G-014）：resume 时 budget 重检，超额则转 budget_limited/time_limited
- **session_start 非对称强制激活**（G-015）：reconstruct 时 `非终态 && status !== paused → status = active`（crashed 的 blocked 重启变 active）；paused 保持 paused

#### FR-8.4 入口归口
- **`/goal update` 走 applyToolAction**（G-002）：重塑（重置 objective/tasks/budget flags/stallCount/currentTurnIndex，保留 goalId），属更新非新建
- **`/goal set` 覆盖终态 goal 保留快速路径**（G-003）：终态旧 goal 不写 history、不 clearGoalSession，直接 createInitialState 覆盖（避免重复 history entry）
- **createGoal 重置 stall 基线**（G-004）：createGoal 三个调用源都重置 tasksCompletedAtAgentStart=0，保证 stall 检测基线正确
- **list_tasks 不触发 widget 刷新**（G-005）：只读 action 不 persist/project

#### FR-8.5 投影契约
- **cancel_goal details.tasks 返回空数组**（G-013）：其他 action 返回完整 tasks，cancel 返 `tasks: []`，renderResult 据此显示。新 projection/result.ts 保留
- **GoalHistoryEntry 不记录 reason**（G-009）：保持当前类型（goalId/objective/status/completedTasks/totalTasks/elapsedSeconds/timestamp），不补 reason 字段（AC-4 允许格式变但不迫迫补）

#### FR-8.6 事件链路精确行为（Round 2 补强）
事件 handler 的精确副作用是新架构最容易丢失的部分，逐事件列出：

- **message_end**（G-R2-001）：
  - 仅当 `isActiveStatus(status) && event.message.role === "assistant"` 时累加
  - 算法：`input = usage.input ?? 0; output = usage.output ?? 0; cacheRead = usage.cacheRead ?? 0;` 若 `input>0 || output>0` 则 `tokensUsed += Math.max(input - cacheRead, 0) + output`，否则 fallback `tokensUsed += usage.totalTokens`
  - Budget 域接管此逻辑（Budget.tick() 不含此算法，token 累加是事件驱动的输入，tick() 只管时间累计）

- **turn_end**（G-R2-002）：
  - `currentTurnIndex++`（maxTurns / stall 检测的计数器递增点）
  - 随后 updateWidget（顺序：先递增后刷新，否则 widget 显示旧 turn）

- **agent_start**（G-R2-002）：
  - `tasksCompletedAtAgentStart = getCompletedCount(tasks)`（stall 检测基线，用于计算 `progressThisRound = completedCount - tasksCompletedAtStart`）
  - 仅当 isActiveStatus 时设置

- **before_agent_start 两套独立机制**（G-R2-004）：
  - **staleness reminder**（`TASK_STALL_TURN_THRESHOLD=10`）：检查单个 task/subtask 是否 10 turn 未更新 → 注入提醒，**并重置被提醒项的 `lastUpdatedTurn = currentTurnIndex`**（含其非 completed 子任务，FR-8.9）。重置的目的是避免下一轮对同一批 task 重复触发提醒。所有 task 终态但 goal 仍 active → 提醒 complete/cancel（此分支不重置 lastUpdatedTurn，因终态 task 不再更新）。**这是与 agent_end 的 stallCount 完全独立的两套检测**，不能混淆
  - **context usage pause**（`CONTEXT_USAGE_RATIO_LIMIT=0.85`）：context 使用率 >85% → status 转 paused + 注入收尾提示

#### FR-8.7 agent_end 分支优先级与 history 写入条件（Round 2 补强）

**handleProgressAndTasks 分支顺序**（G-R2-003，修正 FR-7.1 表面冲突）：
```
1. allTasksDone?
   ├─ maxTurnsReached? → complete（优先 complete，不因 maxTurns 变 cancelled）
   ├─ budgetTight? → steer（deliverAs="steer"，立即收尾）
   └─ 否则 → followUp（deliverAs="followUp"，提示 complete_goal）  ← G-R2-006
2. noTasksCreated?
   ├─ maxTurnsReached? → cancelled（LLM 未建任务且超轮）
   └─ 否则 → followUp（提示 create_tasks 或 cancel_goal）
3. maxTurnsReached（有未完成任务）? → cancelled
4. 否则 → 进入 stall 检测 + continuation
```
注意：FR-7.1 说的"maxTurns→cancelled"专指分支 2b/3（有未完成或无任务时）。分支 1a 是 complete。

**continuation 去抖**（G-R2-005）：
- `tokenDelta = tokensUsed - lastTurnTokensUsed`；若本 turn 无 token 消耗（空 turn）则不发 continuation prompt，只 persist
- 避免空 turn 反复注入 continuation 噪音

**GoalHistoryEntry 写入条件矩阵**（G-R2-009）：
| 状态转换 | 写 history? | 依据 |
|---------|-----------|------|
| → complete | ✓ | complete_goal action / allTasksDone+maxTurns |
| → cancelled（cancel_goal/clear/abort） | ✓ | 用户显式终止 |
| → cancelled（set 覆盖非终态旧 goal） | ✓ | G-R2-008：旧 goal 被新 goal 覆盖需归档 |
| → cancelled（noTask+maxTurns / incomplete+maxTurns） | ✓ | 超轮终止 |
| → budget_limited / time_limited | ✓ | 预算耗尽 |
| → paused | ✗ | 中间态 |
| → blocked | ✗ | 中间态（report_blocked 不写） |
| → active（resume） | ✗ | 恢复 |
| task update / objective update | ✗ | 非终态转换 |

**finalizeGoal 唯一完成入口职责**（G-R2-009 落地）：
- 接收 terminalStatus + reason
- 内部根据上述矩阵决定是否 writeHistoryEntry
- 设 status + completedAtTurnIndex + persist
- **clearSession 仅对 cancelled 立即执行**（G-R3-002 修正）：
  - `cancelled` → 立即 clearGoalSession
  - `complete/budget_limited/time_limited` → **不立即 clear**，依赖 AUTO_CLEAR_TURNS=2 在 before_agent_start 清理（用户看到终态栏 2 turn）
- 中间态 paused/blocked 不走此入口

**`/goal set` 覆盖已有 goal 的两分支**（G-R2-008 补全 G-003）：
- 旧 goal 为**终态**：不写 history（已写过）、不 clearGoalSession，直接 createInitialState 覆盖
- 旧 goal 为**非终态**：设 status=cancelled + completedAtTurnIndex + writeGoalHistoryEntry + persist，然后 createInitialState 覆盖（写一条 cancelled history）

#### FR-8.8 create_tasks all-complete 边界（**行为变更，拆为独立 ticket，不纳入本次架构 PR**）
- 原 D-19 决策：所有 task 完成时 `create_tasks` 报错而非静默覆盖
- **本 PR 不实现**：架构 PR 保持行为等价（即保持当前"静默覆盖"）。此行为变更拆为独立 ticket 评审——"完成后重新拆解、继续扩展目标"是合理流程，强制报错可能砍掉有价值路径，属产品决策需独立讨论
- 重构期间 `handleCreateTasks` 的守卫逻辑原样保留（`existingIncomplete.length > 0` 才拒绝，all-complete 时覆盖）

#### FR-8.9 update_tasks verification 即时 steering（G-R4-002）
- `update_tasks` 把 task 标 `completed` 且该 task 有 `verification` 配置时，**立即调 `injectVerificationSteering`**（deliverAs="steer"）注入提示，引导 AI 跑验证命令并回填 `actual`
- steering 消息内容：列出每个待验证 task 的 `method` / `expected`，提示 AI 调 update_tasks 标 verified
- 这是对双维度"completion=done, verification=pending_verification"的**即时驱动**——不只是 prompt 文本里有规则，而是 status 转换时主动注入 steering
- 新架构 service.ts 处理 update_tasks 时须保留此副作用（不能只依赖 prompt 引导）

#### FR-8.10 complete_goal 全 cancelled 守卫（G-R4-003）
- `complete_goal` 有独立守卫：**至少一个 task 必须是 completed 或 verified，全 cancelled 不算完成**
- 错误信息："At least one task must be completed or verified. All-cancelled does not count."
- 与"cancelled 不阻塞 goal 完成"（FR-8.3 G-017）不矛盾——后者指 cancelled task 不阻塞**有其他 completed task 时**的完成，但**全 cancelled**仍需拒绝
- 守卫顺序：先检查 notDone（有未完成任务拒绝）→ 再检查 completedOrVerified（全 cancelled 拒绝）→ 通过则 transitionStatus→complete

#### FR-8.11 add_subtasks 对 completed task 的限制（G-R4-004）
- `add_subtasks` 拒绝给 `completed` 状态的 task 加 subtask（错误："Task #N in terminal state (completed), cannot add subtask"）
- `completed` 在 `isTerminalTaskStatus` 中不算终态（verified/cancelled 才是），但 add_subtasks **额外**显式拒绝 `completed`——这是有意的业务决策（completed 任务已声明完成，不应再拆分）
- 守卫表达式：`isTerminalTaskStatus(parentTask.status) || parentTask.status === "completed"`

#### FR-8.12 `/goal set` 创建后触发 AI 启动（G-R4-005，关键尾部副作用）
- `/goal set`（handleSet）创建 goal 后，**最后一步调 `pi.sendUserMessage(objective, { deliverAs: "followUp" })`** 触发 AI 开始执行
- 这是 goal 创建流程的**关键尾部副作用**——用户输 `/goal <objective>` 后 AI 自动开始 autonomous loop
- 顺序：createInitialState → persistAndUpdate → ctx.ui.notify（启动提示）→ **sendUserMessage(deliverAs="followUp")**
- 新架构必须保留此触发：command handler 调 createGoal 后，由 service 或 handler 显式 sendUserMessage 触发 AI
- **这是整个 goal workflow 的启动机制**——漏掉会导致用户 set goal 后 AI 不自动开始工作
- **并行模式：`/goal resume` 同样触发**（E-R5-001）：resume 在有未完成任务时调 `pi.sendUserMessage("Goal resumed. Continuing with N remaining tasks.\n\nObjective: <obj>", { deliverAs: "followUp" })` 重启 autonomous loop。resume 还重置 `stallCount=0` + `timeStartedAt=Date.now()`（重启时间累计段）。新架构 resume handler 必须保留此触发——否则用户 resume 后 AI 不会继续工作。resume 前若 budget 重检超额则转 budget_limited/time_limited 且**不**触发 sendUserMessage（FR-8.3 G-014）

## Acceptance Criteria

### AC-1 架构分层
- [ ] `engine/` 目录下三个文件，均零 Pi import（`grep -rn "@mariozechner\|@earendil" extensions/goal/src/engine/` 无输出）
- [ ] `ports.ts` 定义 PersistencePort / UiPort / MessagingPort / SessionPort 抽象
- [ ] `tool-handler.ts` 不再存在（职责拆分到 api/tool.ts + service.ts + persistence.ts 等）

### AC-2 模型完整性
- [ ] GoalHistoryEntry 在 persistence 层定义（DTO，非 aggregate），有 appendHistory/queryHistory
- [ ] Task 双维度投影函数 `getCompletionState` / `getVerificationState` 存在且有单测
- [ ] Budget 内部分 resource / boundary 两部分

### AC-3 唯一入口
- [ ] `createGoal` 唯一创建入口，三个调用源（/goal set、create_tasks、__goalInit）都调用它（grep 验证无独立 task 构造代码）
- [ ] `finalizeGoal` 唯一完成入口，cancel/clear/abort/complete/budget_limited/time_limited 序列都经它（blocked 是中间态，**不走此入口**，见 FR-3.3/FR-8.7）
- [ ] ACTION_HANDLERS 改为 `Record<Action, ActionHandler>`（编译期保证完整性）

### AC-4 契约稳定
- [ ] `goal_manager` tool 的 schema（action 枚举、参数）不变
- [ ] `pi.__goalInit` 仍存在，tasks 参数不变；ctx 从可选收紧为必填（D-16，调用方均已满足）
- [ ] `/goal` 命令的子命令（status/pause/resume/clear/abort/update/history/set）不变
- [ ] `/goal` flag 解析行为不变（--tokens/--timeout/--max-turns/--max-stall，cap [1,100]/[1,20]，>0 校验）
- [ ] 序列化 entry 的 `goal-state` / `goal-history` customType 不变（格式可变，类型字符串不变）

### AC-5 行为修复
- [ ] state 变更 action 执行后 widget 立即刷新（list_tasks 只读不刷，单测验证）
- [ ] token/time 预警独立追踪（单测：token 到 70% 发后 time 到 70% 也发）
- [ ] hasPendingInjection 字段已删除（grep 零结果）
- [ ] pendingPause 字段已删除（grep 零结果，ESC 改用 aborted 守卫）
- [ ] Budget.tick() 存在且有单测，persist 无副作用（不再 mutate state）
- [ ] updateWidget 有 hasUI 守卫（headless 不崩）

### AC-6 测试
- [ ] `pnpm --filter @zhushanwen/pi-goal test` 全绿
- [ ] engine 层测试不 import Pi SDK（grep 验证）
- [ ] 端到端测试覆盖完整生命周期
- [ ] 现有 3 个测试迁移完成

### AC-7 质量门
- [ ] `pnpm --filter @zhushanwen/pi-goal typecheck` 零错误
- [ ] `pnpm --filter @zhushanwen/pi-goal lint` 零错误
- [ ] 单文件 ≤ 400 行（spec 文档 ≤ 1000 字硬上限不适用于代码文件，代码用项目规范）
- [ ] 零 `any`，零 `eslint-disable`

### AC-8 行为契约保持（Round 2-4 补强，FR-8）
- [ ] update_tasks 标 completed 且有 verification 时立即注入 verification steering（deliverAs="steer"）（FR-8.9）
- [ ] complete_goal 拒绝全 cancelled（至少一个 completed/verified）（FR-8.10）
- [ ] add_subtasks 拒绝给 completed task 加 subtask（FR-8.11）
- [ ] `/goal set` 创建后调 sendUserMessage(deliverAs="followUp") 触发 AI 启动（FR-8.12，单测验证创建流程含此调用）
- [ ] `/goal resume` 有未完成任务时同样调 sendUserMessage 重启 AI loop（FR-8.12 并行模式，单测验证）
- [ ] staleness reminder 注入后重置被提醒项 lastUpdatedTurn（FR-8.6，单测验证不重复触发）

### AC-9 ESC 纯打断（FR-6.7，基于 Pi abort 实测时序）
- [ ] message_end handler 在 `ctx.signal?.aborted` 时跳过 token 累加（单测）
- [ ] turn_end handler 在 `ctx.signal?.aborted` 时跳过 currentTurnIndex++（单测）
- [ ] agent_end handler 在 `ctx.signal?.aborted` 时不发 continuation、不递增 stallCount、不做 budget 检查、不转 paused/blocked，goal 保持 active（单测）
- [ ] ESC 后用户下次输入 → before_agent_start 正常注入 context，goal 继续 loop（端到端验证）

## Constraints

### 技术栈
- TypeScript（Pi 运行时执行，不独立编译）
- Pi Extension API（`@mariozechner/pi-coding-agent`），ExtensionHandler 签名 `(event, ctx) => ...`
- typebox（参数 schema）
- vitest（测试框架，禁止 node:test）

### Pi 平台约束
- 扩展在 Pi 进程内执行（非独立进程）
- 同一进程多 session：模块级 `let` 变量被共享，必须用闭包或 session_start 重建
- 扩展不能依赖 fs 之外的 Node 原生模块
- `pi.__xxx` 是官方支持的扩展间私有协议（`ExtensionAPI` 有 `[key: \`__${string}\`]` 索引签名）

### 硬约束
- engine 层零 Pi import（可 import typebox）
- 测试不 import Pi SDK（通过 ports 抽象）
- 禁止 `any`（用 unknown 或具体类型）
- 禁止 `eslint-disable` 绕过规则
- 禁止 `SKIP_LINT=1` / `--no-verify` 提交

### 兼容性
- 序列化清断兼容（旧 entry 丢弃，不做迁移）
- `__goalInit` 签名收窄但兼容旧调用（tasks 变可选）
- goal_manager tool schema 不变
- /goal 命令子命令不变

## Decisions Made

| ID | 决策 | 选择 | 理由 |
|----|------|------|------|
| D-01 | scope | C（架构重设计 + 行为演进） | 用户要整体重构 + 好架构 |
| D-02 | `__goalInit` | D1（保留用途，收窄委托 createGoal） | 用途合理实现不合理；D2 超范围，D3 耦合 |
| D-03 | 序列化 | 清断兼容 | 用户明确旧 entry 不用 |
| D-04 | 宿主扩展 | out-of-scope | 降级不崩，后续 ticket |
| D-05 | engine 隔离 | 零 Pi 依赖（边界由 ports.ts + lint 规则机器可检查） | 可测 + 可演进 + 多 AI agent 维护下防退化 |
| D-06 | 分层深度 | engine 完整拆（goal/task/budget） | 三聚合各有独立状态机 |
| D-07 | 测试 | T3 严格 | 重构质量硬保障 |
| D-08 | Task 双维度 | B（拍扁 + 投影函数） | 契约稳定 + 语义集中 + 可测 |
| D-09 | GoalHistory | 降级为 persistence 层 DTO（修正原"一等模型"） | 无领域行为/状态机/不变量，造 aggregate 是空壳；engine 命名（D-22）进一步确认不该提为模型 |
| D-10 | Budget | 拆 Resource/Boundary | 消除检查逻辑割裂 |
| D-11 | 行为修复 | widget 刷新 + 预警独立 + clear/abort 保留 | 修架构性 bug |
| D-12 | `__goalInit` tasks 参数 | 保持不变（内部走 createGoal） | 修正 G-001 矛盾，消除降级 |
| D-13 | 时间累计 | 从 persist 剥离到 Budget.tick() | persist 纯净 + 归位 |
| D-14 | hasPendingInjection | 删除（僵尸字段） | dead code |
| D-15 | 行为契约 | FR-8 显式化 | Round 1 追踪补强 |
| D-16 | `__goalInit` ctx | 改必填（消 lastCtx） | 修正 G-R2-007，service 无可变状态 |
| D-17 | 事件链路精确行为 | FR-8.6/8.7 补强 | Round 2 追踪补强 |
| D-18 | ESC 行为 | 纯打断（无状态变化、不计 turn、不注入 prompt） | 用户明确：ESC 是追加信息，不是暂停。基于 Pi abort 实测时序，三个事件 handler 都加 aborted 守卫 |
| D-19 | create_tasks all-complete | **拆为独立 ticket**（不纳入架构 PR） | 原决策"报错"是可选产品决策，架构 PR 保持行为等价（静默覆盖），行为变更独立评审 |
| D-20 | Round 4 行为保持补强 | FR-8.9/8.10/8.11/8.12 显式化（verification steering / 全 cancelled 守卫 / add_subtasks 限制 / set 后触发 AI） | Round 4 追踪发现 spec 遗漏的保持行为，全部属 D-15 模式 |
| D-21 | 更新入口设计 | 双入口（`applyToolAction` / `applyEvent`），非统一 `applyCommand` | 链路分析：命令/事件路径的触发方/返回值/并发模型/persist 方式全不同；engine 层纯函数才是真共享层；合并=用 if 拼两套语义 |
| D-22 | engine 命名 | `engine/` 而非 `domain/` | "domain"诱导 aggregate 过度建模（GoalHistory 被提为一等）；"engine"换框问"计算什么"，防膨胀 |

## 业务用例

> 初版简述（Phase 2 会在此基础上细化）。纯技术性重构，业务用例聚焦"用户可感知行为保持 + 架构债务清除"。

### UC-1: 用户启动并执行 goal（行为保持）
- **Actor**: 用户 + AI
- **场景**: 用户 `/goal <objective>`，AI 调 create_tasks/update_tasks/complete_goal 完成目标
- **预期结果**: 行为与重构前一致（命令子命令、tool action、状态流转、预算检查、steering 注入全部保持）

### UC-2: goal 跨 session 重建（行为保持）
- **Actor**: Pi runtime（session_start 事件）
- **场景**: session 重启后从 entry 恢复 goal 状态
- **预期结果**: 新格式 entry 能正确恢复；旧格式 entry 丢弃（不崩）

### UC-3: 宿主扩展触发 goal 初始化（行为保持，无降级）
- **Actor**: coding-workflow / plan 扩展（调 `pi.__goalInit`）
- **场景**: 进入特定 phase 时调 `__goalInit` 触发 goal 创建并预填 task
- **预期结果**: 行为与重构前一致——`__goalInit` 接收 tasks 并预填，内部走唯一 createGoal 构造（D-12）。零降级、零调用方改造

### UC-4: 预算预警按维度独立触发（行为修复）
- **Actor**: Pi runtime（agent_end 事件）
- **场景**: token 先到 70% 发预警，随后 time 也到 70%
- **预期结果**: 两个预警各自独立触发（修复当前 time 被吞的 bug）

### UC-5: tool action 后 widget 实时刷新（行为修复）
- **Actor**: AI（调 goal_manager tool）
- **场景**: 同一 turn 内多次 tool call（如 update_tasks 连续两次）
- **预期结果**: 每次 tool 执行后 widget 立即更新，无需等 turn_end
