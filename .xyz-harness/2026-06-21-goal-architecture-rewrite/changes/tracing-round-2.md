# Tracing Round 2

## 追踪范围
- spec 初稿版本：含 FR-1~FR-8（FR-8 行为契约章节为 Round 1 后新增）、D-01~D-15（D-12~D-15 新增）
- clarification.md：含 A-01~A-10 假设审计、D-12 修正、D-15 行为契约补强清单
- 追踪的视角：5 视角全部适用（重构涉及状态机 + API 契约 + 序列化数据 + 事件链路），无降级
  - P1 User Journey
  - P2 Data Lifecycle
  - P3 API Contract
  - P4 State Machine
  - P5 Failure Path

## 结论：有新 gap（未收敛）

Round 2 独立重跑 5 视角后发现 9 个新 gap，全部为「代码有 spec 没写」的保持行为（F 类）或架构决策点（D 类）。集中在**事件 handler 的精确行为**和**agent_end 的分支优先级**——这些是 Round 1 未追踪、FR-8 也未覆盖的路径。

主 agent 处理 Round 1 的 24 个 gap 时聚焦在「显式状态机行为 + 并发防御 + 投影契约」，遗漏了「事件链路的精确算法 + before_agent_start 的两个独立机制 + agent_end 内部分支的优先级」。这些若不在新架构中显式保留，会破坏 token 计量、stall 检测、context 保护、continuation 节流等核心行为。

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G-R2-001 | F | Data / P5 | `index.ts:341-355` (message_end handler) | message_end token 累加**精确算法**未记录：`tokensUsed += Math.max(input - cacheRead, 0) + output`；当 input/output 都为 0 时 fallback 到 `usage.totalTokens`；仅累加 `role === "assistant"` 的消息；仅 `isActiveStatus` 时累加。FR-7.3 只说「message_end token 累计」，未记算法。新架构 Budget.tick() 或 message handler 必须保留此算法，否则 budget 预警/耗尽检测全偏 |
| G-R2-002 | F | State / P5 | `index.ts:327-338` (agent_start / turn_end handler) | 事件链路不完整——两个关键副作用未记录：① `turn_end`：`currentTurnIndex++` + `updateWidget`（maxTurns / stall 检测的计数器递增点）② `agent_start`：`tasksCompletedAtAgentStart = getCompletedCount(tasks)`（stall 检测基线，`progressThisRound = completedCount - tasksCompletedAtStart`）。FR-7.3 事件链路列举（before_agent_start / message_end / agent_end）缺这两个。若新架构漏掉 turn_end 的 currentTurnIndex++，maxTurns 永不触发 |
| G-R2-003 | F | State / P4 | `agent-end-handler.ts:160-171` (handleAllTasksDone) | `allTasksDone + maxTurnsReached → complete`（优先 complete 分支）未记录。spec FR-7.1 写「maxTurns→cancelled」与代码实际行为表面冲突：实际优先级是「全任务完成 + maxTurns → complete」先于「有未完成 + maxTurns → cancelled」。需在 FR-8 显式记录此优先级，否则按 FR-7.1 写测试会破坏「全完成优先 complete」行为 |
| G-R2-004 | F | User / P1 / P5 | `before-agent-start-handler.ts:58-137` | before_agent_start 的**两个独立机制**完全未记录：① **staleness reminder**（`TASK_STALL_TURN_THRESHOLD=10`：task/subtask 超 10 turn 未更新 → 注入提醒；所有 task 终态但 goal 仍 active → 提醒 complete/cancel；与 agent_end 的 `stallCount` 是两套独立机制）② **context usage pause**（`CONTEXT_USAGE_RATIO_LIMIT=0.85`：context 使用率 >85% → status 转 paused + 注入收尾提示）。FR-8 完全没提这两个 before_agent_start 行为。新架构若漏掉，长 session 的 context 保护失效 |
| G-R2-005 | F | State / P4 | `agent-end-handler.ts:278-284` (consumeTokensForDebounce) | continuation **去抖**未记录：`tokenDelta = tokensUsed - lastTurnTokensUsed`，若本 turn 无 token 消耗（空 turn）则不发 continuation prompt，只 persist。FR-8 没记录。若新架构漏掉，空 turn 会反复注入 continuation prompt 造成噪音 |
| G-R2-006 | F | State / P4 | `agent-end-handler.ts:177-197` (handleAllTasksDone) | allTasksDone 的 **steer vs followUp 区分**未记录：`budgetTight`（token ≥80%）→ `deliverAs: "steer"`（立即收尾）；否则 → `deliverAs: "followUp"`（下一 turn 处理）。FR-8 没记录此区分。影响 AI 收尾时机 |
| G-R2-007 | D | API / P3 | `index.ts:396-429` (initializeGoalFromExternal) | `__goalInit` 两个行为细节未记录：① **lastCtx fallback**：persist 需要 ctx，优先用调用方传入的 ctx，否则用本扩展事件 handler 捕获的 `lastCtx`（模块级变量）。新架构走 service 层后，`__goalInit` 调用时可能无当前 ctx（外部扩展 tool execute 上下文），service 如何拿 ctx？ports.ts 的 SessionPort 是否封装此 fallback？② **返回 false 条件**：`session.state && isActiveStatus(status)` 时返回 false（拒绝覆盖活跃 goal）。AC-4 只说签名 `(objective, tasks[], budget?, ctx?) → boolean`，未明确 false 语义 |
| G-R2-008 | F | Data / P2 | `command-handler.ts:257-271` (handleSet) | G-003 描述不完整——只说「终态旧 goal 不写 history、不 clearGoalSession，直接覆盖」。**非终态旧 goal** 实际行为：设 status=cancelled + completedAtTurnIndex + `writeGoalHistoryEntry` + persist，然后 createInitialState 覆盖（写一条 cancelled history）。spec 需补全非终态分支，否则新架构可能对非终态也跳过 history（丢失归档） |
| G-R2-009 | F | State / Data / P4 | 8 处 `writeGoalHistoryEntry` 调用点 | GoalHistoryEntry **写入条件**未显式记录。代码实际：仅在**终态转换**时写（complete_goal / cancel_goal / clear / abort / set 覆盖非终态 / budget 耗尽 / allTasksDone+maxTurns / noTask+maxTurns / incomplete+maxTurns）；**不写**于 pause / resume / update / report_blocked（blocked 是中间态）/ ESC pause。FR-8.5 只说「不记 reason」，未说写入条件矩阵。新架构 finalizeGoal 入口需明确「哪些终态写、哪些不写」 |

## 追踪细节（按视角）

### P1: User Journey

走查了 `/goal` 全部 8 个子命令 + 10 个 tool action + ESC 中断路径。发现：
- ESC → pendingPause → paused 链路 FR-8.2 G-011 已覆盖 ✓
- `/goal set` 覆盖已有 goal 的两个分支（终态/非终态）→ **G-R2-008**（非终态分支未记录）
- before_agent_start 注入的 staleness reminder 和 context pause → **G-R2-004**（完全未记录）

### P2: Data Lifecycle

走查了 GoalRuntimeState（create/read/update/clear）+ GoalHistoryEntry（append/query/GC）：
- Entry GC（state 留 1 条、history 留 20 条）FR-8.1 G-006 ✓
- AUTO_CLEAR_TURNS=2 FR-8.1 G-007 ✓
- 部分损坏全丢 FR-8.1 G-024 / FR-5 ✓
- token 累加算法 → **G-R2-001**
- history 写入条件矩阵 → **G-R2-009**

### P3: API Contract

走查了 goal_manager schema（AC-4 ✓）、`__goalInit`（AC-4 签名 ✓）、`/goal` 命令（AC-4 ✓）、6 个 pi.on 事件（A-10 ✓）：
- `__goalInit` 的 lastCtx fallback + false 条件 → **G-R2-007**

### P4: State Machine

走查了 GoalStatus 7 态、TaskStatus 5 态、SubtaskStatus 3 态、transitionStatus 宽松（FR-8.3 G-016 ✓）、completed 无 verification 全锁（G-017 ✓）、subtask 宽松（G-018 ✓）、resume 可转 terminal（G-014 ✓）、session_start 非对称激活（G-015 ✓）：
- allTasksDone + maxTurns → complete 优先级 → **G-R2-003**
- continuation 去抖 → **G-R2-005**
- allTasksDone steer/followUp 区分 → **G-R2-006**
- turn_end / agent_start 计数器与基线 → **G-R2-002**

### P5: Failure Path

走查了 stale context（G-010 ✓）、signal aborted（G-011 ✓）、isProcessing 防重入（G-021 ✓）、goalId snapshot（G-020 ✓）、persist 失败保持现状（G-023 ✓）：
- token 算法的 fallback（totalTokens）→ 与 **G-R2-001** 合并
- continuation 去抖的空 turn 处理 → 与 **G-R2-005** 合并

## 降级视角记录

无降级。5 视角全部适用（本需求变更状态机内部实现、API 契约保持、序列化格式、事件链路精确行为）。

## 给主 agent 的处理建议

1. **G-R2-001 / G-R2-002 / G-R2-005**（事件 handler 精确行为）：建议补入 FR-8 新增「FR-8.6 事件链路精确行为」子章节，逐事件列出副作用。这是新架构最容易漏的部分——service 层封装后，事件 handler 的隐式顺序（如 turn_end 必须先 ++ 再刷 widget）容易丢失。
2. **G-R2-003 / G-R2-006**（agent_end 分支优先级）：建议补入 FR-8.3 或新增 FR-8.7，明确 handleProgressAndTasks 的分支顺序（allTasksDone → noTasks/maxTurns → maxTurns）及各分支的 deliverAs 选择。
3. **G-R2-004**（before_agent_start 两机制）：必须补入 FR-8，这两个机制（staleness reminder + context pause）是独立的用户可感知行为，且 staleness reminder 与 agent_end stallCount 是两套独立检测，不能混淆。
4. **G-R2-007**（lastCtx + false 条件）：这是架构决策点。service 层设计需回答「外部扩展调 `__goalInit` 时，service 如何获取 ctx 来 persist」。建议在 FR-2.2 ports.ts 契约中明确 SessionPort 是否封装 ctx 捕获。
5. **G-R2-008 / G-R2-009**（history 写入条件）：建议补入 FR-8.5 或 FR-3.3（finalizeGoal 唯一完成入口），列出「写 history 的终态集合」vs「不写的中间态集合」。
