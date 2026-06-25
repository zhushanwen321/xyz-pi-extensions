# Architecture Tracing Round 1 — system-architecture.md

> 独立 subagent 追踪。基于 5+1 视角模板，对 system-architecture.md 初稿做强制枚举追踪。
> 追踪对象：架构设计文档（非 spec），验证其完整性、内部一致性、与上游 spec/clarification 的对齐。
> 源码验证：extensions/goal/src/ 当前实现（refactor 前状态）。

## 追踪范围

- 架构文档：system-architecture.md（verdict: pending）
- 上游 spec：spec.md（verdict: pass）
- 上游决策：clarification.md（D1-D29，含 Round 1-4 gap 处理）
- 源码验证：extensions/goal/src/ 全部 .ts 文件

---

## 视角 1: Model Integrity（模型完整性）

### 检查结果

- [x] 每个模型标注类型 — GoalRuntimeState(aggregate)、BudgetConfig(值对象)、GoalStatus(值对象/枚举)、VALID_TRANSITIONS(值对象)、ProgressInput(DTO)
- [ ] aggregate 不变式守卫 — **有问题**（见 gap）
- [x] 值对象纯净 — BudgetConfig、GoalStatus、VALID_TRANSITIONS 均无 IO/mutate
- [x] 无「装着行为的对象」反模式 — engine 纯函数操作 state，service 协调
- [ ] 无散落概念 — **有问题**（见 gap）
- [x] 无空壳模型 — 每个模型有实际领域行为
- [x] 粒度匹配 — DTO/值对象/aggregate 区分合理

### Gap 列表

| ID | Type | 问题 | 详情 |
|----|------|------|------|
| G-A1-001 | **F** | GoalRuntimeState 仍含 tasks/stallCount | 架构 §4 核心模型表列出 GoalRuntimeState 为 aggregate，但未显式标注 tasks 和 stallCount 字段要删除。§7 删除清单有列，但 §4 的模型定义（不变式行）缺失这些字段的状态说明。当前代码 `engine/types.ts:34` 仍有 `tasks: GoalTask[]` 和 `stallCount: number`。追踪者需交叉比对 §4 和 §7 才能确认——这是文档内聚性问题。 |
| G-A1-002 | **F** | GoalStatus 缺 "paused" | 架构 §5 明确定义 7 态（含 paused），但当前代码 `engine/types.ts:18-23` 只有 6 态（缺 paused）。架构文档本身一致（§4 统一语言表说"7 状态"），但需确认 paused 是新增还是已有——代码里没有。这不算架构文档缺陷，是实现 gap。 |
| G-A1-003 | **D** | ProgressInput 字段定义不完整 | §4 核心模型表说 ProgressInput 是 DTO（`completedCount/totalCount/incompleteIds/hasVerificationPending`），但不变式只写了 `totalCount >= completedCount >= 0`。**缺少**：incompleteIds 和 hasVerificationPending 的不变式/约束。hasVerificationPending 在 todo 无 isVerification 字段时如何计算？（spec FR-1 加了 `isVerification?: boolean`，但架构 §4 未反映。） |
| G-A1-004 | **K** | todo 实体模型未在架构中定义 | §4 列了 5 个核心模型，但没有 Todo 实体。§7 删除清单删了 GoalTask，替代它的 Todo 模型（`{id, text, status, isVerification?}`）只在 spec FR-1 和 clarification D2/D15 中定义，架构文档未建模。跨扩展的 Todo 类型应该在架构统一语言或核心模型中出现。 |
| G-A1-005 | **F** | BudgetConfig 定义与删除清单矛盾 | §4 说 BudgetConfig 是值对象（`tokenBudget/timeBudgetMinutes`），但 §7 删除清单列了 maxTurns 和 maxStallTurns。§4 的定义看起来是目标态，但未标注"当前含 maxTurns/maxStallTurns，待删除"。当前代码 `engine/types.ts:29-33` 有 4 个字段。 |

---

## 视角 2: State Orthogonality（状态正交性）

### 检查结果

- [x] Status 只描述阶段 — 7 态均为阶段描述，不含终止原因
- [x] 终态独立 — 终态集合明确（`TERMINAL_STATUSES`），cancelled 是独立终态而非"原因"
- [x] 终态不可逆 — VALID_TRANSITIONS 终态→空数组
- [x] 合法转换有显式表 — §5 完整转换表 + VALID_TRANSITIONS 代码定义
- [x] 所有终态可达 — complete/budget_limited/time_limited/cancelled 均有入边
- [ ] 运行时行为表完整 — **有问题**（见 gap）
- [x] 转换严格度匹配 — 显式转换表 + 权限三分层双重保障

### Gap 列表

| ID | Type | 问题 | 详情 |
|----|------|------|------|
| G-A2-001 | **F** | §5 运行时行为表缺 blocked 行为定义 | §5 有"各状态运行时行为"表（active/paused/blocked/终态），但 blocked 行的所有维度都是"—"（未定义）。spec FR-3 和 clarification D20/G-R3-034 明确定义了 blocked 的 5 维度行为（不续跑/不 budget/不注入/不递增 stall/ESC 保持），与 paused 对称。架构文档应显式写入，不应让读者去翻 spec。 |
| G-A2-002 | **D** | resume 转换的副作用未在架构中定义 | VALID_TRANSITIONS 定义了 `paused→active` 和 `blocked→active`，但未说明 resume 的副作用：(1) checkBudgetOnResume 拒绝超 budget 的 goal (2) timeStartedAt 重置 (3) sendUserMessage 触发 AI (4) stallCount 重置。这些在 clarification D5/D14/D32 和 spec FR-3 中有定义，但架构 §5 的行为表没有 resume 行为维度。 |
| G-A2-003 | **F** | continuation 行为未在架构中定义 | §5 行为表的"续跑（continuation）"维度只有"是/否"，但未定义 continuation 的具体行为：(1) tokenDelta=0 去抖 (2) followUp vs steer 选择 (3) budgetTight 时 steer。这是 event-adapter 的核心逻辑（`handleStallAndContinuation`），架构应至少概述。 |

---

## 视角 3: Layering Discipline（分层纪律）

### 检查结果

- [x] 核心计算明确 — §2："状态转换 + budget 计量 + context prompt 注入"
- [x] 分层深度匹配 — 3 层（engine/adapters/service+projection），适合纯领域规则系统
- [x] 依赖方向严格向下 — engine→零依赖，adapters→engine+Pi，service→engine+ports
- [x] 核心层零外部 SDK 依赖 — 当前代码验证：`grep -rn "@mariozechner" extensions/goal/src/engine/` 无输出
- [x] 无空壳层 — 每层有实际行为
- [ ] Port 价值定位 — **有问题**（见 gap）
- [x] 无伪 port 问题（从"可替换性"角度）— 架构明确定位为"边界载体"

### Gap 列表

| ID | Type | 问题 | 详情 |
|----|------|------|------|
| G-A3-001 | **D** | 4 个 Port 均为单实现，是否值得保留为 interface | §6 Port 清单：PersistencePort(1 实现)、UiPort(1 实现)、MessagingPort(1 实现)、SessionPort(1 实现)。架构说"价值定位 = 边界载体"，但未回答：(1) 哪些 port 真正提供 engine 零依赖价值（PersistencePort 有，因为 engine 不调它） (2) 哪些 port 只是代码组织（UiPort/MessagingPort 只有 adapter 调，engine 不直接用）。如果 port 只被 adapter 层调用，它不提供分层隔离价值——它只是 adapter 的内部抽象。**建议**：明确哪些 port 是给 engine 层用的（通过 service 传入），哪些是 adapter 内部的。 |
| G-A3-002 | **F** | engine/task.ts 删除后，engine 层的"任务"概念如何表达 | §7 删除清单列了 `engine/task.ts`，但 §6 层级图的 engine 层仍画了 3 个文件（types.ts/goal.ts/budget.ts）。task.ts 删除后，engine 层不再有任务模型——任务概念完全转移到 todo extension。但 budget.ts 的 `checkProgress` 当前接收 `GoalTask[]`。架构 §4 说改为接收 ProgressInput，但 §6 的层级图未更新（应去掉 task.ts 的位置，或标注"删除"）。 |

---

## 视角 4: Dependency Boundary（依赖边界）

### 检查结果

- [x] 无循环依赖 — engine 不 import adapters，adapters import engine，service import engine+ports
- [x] 无上帝对象 — 最大文件 event-adapter.ts(737 行) 有拆分计划（6 个 handler）
- [ ] GoalRuntimeState 字段生命周期 — **有问题**（见 gap）
- [x] 无 boolean flag 控制资源清理行为 — ESC 用 signal.aborted，不用 flag
- [x] interface 参数合理 — Port 方法参数 ≤ 3 个
- [x] deletion test — 删掉 engine/task.ts 后复杂度转移到 todo extension（预期）

### Gap 列表

| ID | Type | 问题 | 详情 |
|----|------|------|------|
| G-A4-001 | **D** | 4 个独立预警 flag 是否应合并 | GoalRuntimeState 有 `tokenWarning70Sent`/`tokenWarning90Sent`/`timeWarning70Sent`/`timeWarning90Sent` 4 个 boolean flag。它们生命周期相同（goal 创建时 false，触发时 true，reset 时不重置——永久 true）。架构未讨论是否合并为 `warningFlags: Set<"token70"|"token90"|"time70"|"time90">` 或位掩码。4 个 boolean 不算严重，但增加了 serialize/deserialize 的字段数。 |
| G-A4-002 | **F** | service.ts ~300 行混合了多个职责 | 架构 §7 预估 service.ts ~300 行。但当前 service.ts(700 行) 包含：(1) createGoal (2) finalizeAndPersist/finalizeGoal (3) applyToolAction（10 个 action） (4) applyEvent (5) tickState/persistState (6) checkResumeBudget。删除 10 个 action 后，剩余职责：createGoal + finalizeAndPersist + applyEvent + tickState/persistState + checkResumeBudget + 2 个 goal_control action。300 行是否合理？架构未讨论是否进一步拆分（如 persist 辅助函数独立）。 |

---

## 视角 5: Change Axis（变化轴）

### 检查结果

- [x] 每个文件承担一个变化轴 — §7 模块表明确标注了每个文件的变化轴
- [x] 拆分粒度合理 — event-adapter 按事件拆 6 个 handler（合理），engine 按领域概念拆 3 个文件
- [x] 无「7 个变化轴堆在一个文件」— 最复杂的 event-adapter 已计划拆分
- [x] 命名反映变化轴 — goal.ts(状态转换)、budget.ts(预算)、types.ts(类型定义)
- [ ] 变化轴内聚 — **有问题**（见 gap）

### Gap 列表

| ID | Type | 问题 | 详情 |
|----|------|------|------|
| G-A5-001 | **D** | engine/budget.ts 混合了两个变化轴 | 当前 budget.ts(176 行) 包含：(1) token 累加算法 `accumulateTokens` (2) 时间累计 `tick` (3) 百分比计算 (4) turn-end 预算检查 `checkBudgetOnTurnEnd` (5) resume 预算重检 `checkBudgetOnResume` (6) 进度检查 `checkProgress`。变化轴：token 累加算法变（新增 token 类型） vs 预算阈值/策略变（调整 70/90 比例） vs 进度检查逻辑变（todo 集成后改 ProgressInput）。架构 §7 预估 ~180 行，未讨论是否拆分。建议至少把 `tick`（纯时间计算，与预算策略无关）移到 types.ts 或独立 time.ts。 |
| G-A5-002 | **F** | projection/prompts.ts 承担多个变化轴 | 当前 prompts.ts(365 行) 包含：(1) contextInjectionPrompt（启动 prompt，变：FR-7 plan 联动） (2) continuationPrompt（续跑 prompt，变：FR-6 completion audit） (3) stalenessReminderPrompt（停滞提醒，变：D28 stall 退化） (4) budgetLimitPrompt（预算预警，稳定） (5) objectiveUpdatedPrompt（update 提示，稳定） (6) formatBudget/formatTaskList（格式化，稳定）。3 个高频变化轴 + 3 个稳定轴在同一文件。架构 §7 预估 ~370 行，未讨论拆分。 |

---

## 视角 6: Behavior Contract（行为契约，refactor 专用）

> 本视角追踪「代码有但架构文档没提」的行为，以及行为变更是否与架构变更分离。

### 检查结果

- [ ] 逐条列出「代码有但架构没提」的行为 — **有问题**（见 gap）
- [ ] 每条标注源码位置 — 见下方
- [ ] 每条标注保持/变更/删除 — 见下方
- [ ] 冲突行为已决策 — 见下方
- [ ] 行为变更与架构变更分离 — 见下方

### Gap 列表

| ID | Type | 问题 | 源码位置 | 架构覆盖 | 建议处置 |
|----|------|------|----------|----------|----------|
| G-A6-001 | **F** | agent_end allTasksDone+maxTurnsReached 自动 complete | event-adapter.ts:587 `handleAllTasksDone` | §7 删除清单未列。spec FR-4 D21 明确要删。 | **删除**。架构 §7 删除清单应补"handleAllTasksDone 的 maxTurnsReached→complete 分支"。 |
| G-A6-002 | **F** | agent_end maxTurnsReached 自动 cancelled | event-adapter.ts:631/663 `handleNoTasksOrMaxTurns`/`handleMaxTurnsReached` | §7 删除清单列了 maxTurns 字段，但未列这些 handler 的终态分支。 | **删除**。架构应显式列出要删除的 handler 分支。 |
| G-A6-003 | **F** | agent_end stallCount>=maxStallTurns 自动 blocked | event-adapter.ts:707 `handleStallAndContinuation` | §7 删除清单列了 stallCount，但未列自动 blocked 路径。 | **删除**。stall 退化为 prompt 提醒（D28）。 |
| G-A6-004 | **F** | context usage > 85% 注入 wrap-up 指令 | event-adapter.ts:297 `checkContextUsage` | 架构未提及。spec 未提及。 | **保持**（现有行为，不删除）。架构应标注为"保持"。 |
| G-A6-005 | **F** | 终态 goal 2 轮后自动清理（AUTO_CLEAR_TURNS） | event-adapter.ts:182 `handleTerminalStateBeforeAgent` | 架构未提及。spec 未提及。 | **保持**。架构应标注为"保持"。 |
| G-A6-006 | **F** | /goal set 覆盖非终态旧 goal（写 cancelled history） | command-adapter.ts:212 `handleSet` | 架构未提及。spec FR-3 D25 改为拒绝。 | **变更**（覆盖→拒绝）。架构应标注行为变更。 |
| G-A6-007 | **F** | blocked 状态下 agent_end 发 notify("Goal blocked...") | event-adapter.ts:157 `handleTerminalStateAgentEnd` | 架构 §5 运行时行为表 blocked 行为空。 | **保持**。架构应标注。 |
| G-A6-008 | **F** | /goal abort 命令存在 | command-adapter.ts:168 `handleAbort` | 架构未提及。spec D16 要删除。 | **删除**。架构 §7 删除清单应补"adapters/actions.ts"（它列了 tool-adapter.ts 但没列 abort 命令）。 |

---

## 汇总

### 按类型统计

| 类型 | 数量 | 编号 |
|------|------|------|
| **F（Fact）** | 13 | A1-001/002/005, A2-001/003, A3-002, A4-002, A5-002, A6-001~008 |
| **K（Knowledge）** | 1 | A1-004 |
| **D（Decision）** | 5 | A1-003, A2-002, A3-001, A4-001, A5-001 |

### 按优先级排序

**P0 — 阻塞实现（必须在 issues.md 前解决）：**

1. **G-A6-001/002/003** — agent_end 3 个自动终态路径未在架构删除清单中显式列出。spec D21/D22/D28 已决策删除，但架构 §7 只列了字段级删除（maxTurns/stallCount），未列 handler 分支级删除。实施者可能只删字段不删逻辑。
2. **G-A1-004** — todo 实体模型未在架构中定义。engine/task.ts 删除后，GoalTask 被 Todo 替代，但架构文档没有 Todo 的模型定义。实施者不知道 Todo 的字段/状态机/isVerification。
3. **G-A6-006** — /goal set 覆盖行为的变更未在架构中标注。D25 决策从"覆盖"改为"拒绝"，但架构未反映。

**P1 — 架构完整性（应在 issues.md 中体现）：**

4. **G-A2-001** — blocked 运行时行为未定义。D20/G-R3-034 已决策（与 paused 对称），但架构 §5 行为表 blocked 行为空。
5. **G-A2-002** — resume 转换副作用未定义。
6. **G-A6-004/005** — context usage check 和 auto-clear 行为未在架构中标注为"保持"。
7. **G-A6-008** — /goal abort 删除未在架构中标注。

**P2 — 文档质量（可在实施中逐步补充）：**

8. **G-A1-003** — ProgressInput 字段定义不完整。
9. **G-A3-001** — 单实现 Port 的保留理由需更明确。
10. **G-A4-001** — 4 个预警 flag 合并讨论。
11. **G-A5-001/002** — budget.ts/prompts.ts 变化轴分离。
12. **G-A1-005** — BudgetConfig 定义与删除清单的文档内聚性。

### 与上游文档的一致性检查

| 检查项 | 结果 |
|--------|------|
| spec FR-1~FR-7 全部有架构映射 | **是**（§1 目标转换表覆盖） |
| clarification D1-D29 全部有架构体现 | **否**（D20 blocked 行为、D25 set 拒绝、D28 stall 删除路径 未在架构中体现） |
| 架构内部一致性 | **基本一致**（§4 模型定义 vs §7 删除清单有 G-A1-001/005 的文档内聚性问题） |
| AC 反模式检查清单完整 | **是**（AC-1~AC-7 覆盖核心变更点） |

### 结论

架构文档在模型定义和状态机设计上质量较高（§4/§5），但在**行为契约**（视角 6）方面有系统性遗漏：8 个「代码有但架构没提」的行为中，3 个是必须删除的自动终态路径（P0），3 个是应保持但未标注的行为（P1）。这些遗漏会导致实施者在拆分 event-adapter.ts 时不确定哪些分支保留、哪些删除。

**建议**：在 system-architecture.md 中新增一节"行为变更清单"（或在 §7 删除清单中补充 handler 分支级条目），显式列出每个要删除/变更/保持的行为及其源码位置。
