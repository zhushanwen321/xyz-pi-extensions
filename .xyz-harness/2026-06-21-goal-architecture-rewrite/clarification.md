# Clarification — Goal 扩展架构重写

## 决策记录（逐条，含推理过程）

### D-01: scope = C（架构重设计 + 行为演进）
- 用户明确"倾向于整体重构""需要比较好的架构，不用考虑成本"
- 选 C 而非 A/B：允许调整对外行为，解除兼容债务
- **推理**：A 太保守解决不了模型层问题；B 边界清晰但用户要更彻底

### D-02: `__goalInit` 处置 = D1（保留用途，收窄为委托唯一 createGoal）
- 用途合理（宿主扩展预填固定 task 列表的需求真实存在），实现不合理（双轨、类型漏洞、全局变量耦合）
- **评估结论**：不能原样保留，不能粗暴移除，重设计
- **双轨消除**：goal 内部唯一 `createGoal()`，external init 改为调它
- **签名收窄**：从 `(objective, tasks[], budget?, ctx?) → boolean` 简化
- **通信机制保持 `pi.__goalInit`**：因为 `ExtensionAPI` 有 `[key: \`__${string}\`]: unknown` 官方支持的扩展间私有协议（见 Assumption A-07）。不是全局变量 hack，是平台机制
- **推理**：D2（peerDep import）超出 goal 自身范围（需 Pi 平台级 DI 基础设施）；D3（移除改 prompt）是独立产品工程问题，与建模重构耦合不当

### D-03: 序列化 = 清断兼容
- 用户明确"旧格式迁移不用管，历史对话不会再打开"
- `deserializeState` 不再背历史包袱（移除 `subTodos→subtasks` 迁移、字段默认值兜底）
- **推理**：domain 层干净的必要条件

### D-04: 宿主扩展改造 = out-of-scope
- coding-workflow / plan 的调用方改造（改走 prompt 引导或新通信机制）留后续 ticket
- **降级影响**（必须知情、用户已认可）：
  - `__goalInit` 签名收窄后，coding-workflow Phase 2/3、plan compact 的调用**可能不再自动初始化 goal**（取决于收窄后的签名是否兼容）
  - 这些调用都在 `try/catch` non-blocking 分支，workflow 不会崩，只是静默跳过 goal 创建
  - 短期内这些场景下无 goal 任务列表，直到后续 ticket 补上 prompt 引导
- **spec 标注**：作为已知降级影响记录，不阻塞本期

### D-05: domain 零 Pi 依赖
- domain 层只 import typebox；ExtensionContext/Theme/SessionEntry 等全部用 ports.ts 抽象类型替代
- domain 方法是纯函数（不 mutate 入参，或 mutate 后返回）
- 副作用（persist/widget/sendMessage）由 application/service 层调 adapter
- **推理**：可测 + 可演进 + 架构正确归位；对应"按变化轴拆分"和"追根因"

### D-06: domain 完整拆分（goal/task/budget 三文件）
- `domain/goal.ts`：Goal aggregate + 7 态状态机 + 终态守卫
- `domain/task.ts`：Task/Subtask + 任务状态机 + 双维度投影函数
- `domain/budget.ts`：Budget 值对象（Resource/Boundary 拆）+ 预算检查
- **推理**：三聚合各有独立状态机和不变量，拆开后每文件聚焦单一领域概念

### D-07: 测试 = T3 严格
- domain 全枚举（状态机转换、不变量、双维度组合）
- service 用 fake adapter
- 端到端：mock Pi runtime 跑完整 goal 生命周期
- 迁移现有 3 个测试到新结构
- **推理**：用户明确要 T3；重构质量硬保障

### D-08: Task 双维度 = B（拍扁 + 投影函数）
- status 保持 5 态单字段（tool schema 已固化，prompt 已写大量转换规则）
- domain 提供 `getCompletionState(task)` / `getVerificationState(task)` 纯计算函数
- 双维度语义集中，不再散落 isTaskDone/validateUpdateTasks/widget 三处
- **推理**：对外契约稳定 + 双维度语义有归属 + 可测

### D-09: GoalHistory 降级为 persistence 层 DTO（修正原"提为一等模型"）
- **原决策**（Round 1）：提为一等模型 / aggregate。**修正**（spec 分析轮）：降级
- **修正理由**：GoalHistoryEntry 无领域行为、无状态机、无不变量——是终态 goal 的归档记录（DTO）。造 aggregate 是空壳，不会解锁任何能力，只把 `pi.appendEntry("goal-history", {...})` 换成 `persistence.appendHistory(...)`
- **"domain"命名诱导过度建模**（D-22）：原 D-09 把它提为一等模型，部分是"既然是 domain，每个东西都该有 aggregate 吧"的诱导。改用 "engine" 命名后，自然问"这个 engine 计算什么"——GoalHistory 不计算任何东西
- **最终方案**：类型定义放 persistence.ts，提供 `appendHistory(entry)` / `queryHistory()`。不进 engine/，不造 aggregate
- 消除 writeGoalHistoryEntry（写）与 handleHistory（读）两处手动对齐的需求，仍由 persistence 层统一函数解决

### D-10: Budget 拆 Resource / Boundary
- `Budget` 值对象内部分 `resource: { token, time }` 和 `boundary: { maxTurns, maxStallTurns }`
- checkBudget 按"可消耗资源"（百分比）和"硬边界"（计数）两类分开
- **推理**：当前混在一起导致 checkBudgetOnTurnEnd 逻辑割裂

### D-11: 行为修复项
- ① widget 实时刷新：action handler 改用 persistAndUpdate（或 executeGoalAction 出口统一刷）
- ② 70/90 预警维度独立：token/time 各自追踪 sent flag，不再共用一个
- ③ clear/abort 语义保留：不合并，保留两个命令的语义区分（clear 强制、abort 检查未完成）

### D-12: `__goalInit` tasks 参数保留（修正 D-02 的 G-001 矛盾）
- **决策**：`__goalInit` 签名保持原样（仍接收 tasks），内部委托唯一 createGoal 构造
- **修正 D-02**：D-02 原说"签名收窄"导致 clarification 降级1 的矛盾（FR-4.2 vs 降级1）。实际 D-02 的核心价值是"task 构造逻辑唯一（createGoal）"，不是"砍 tasks 参数"
- **无降级**：coding-workflow Phase 2/3、plan compact 的 3 个调用点零改造、零降级，照常预填 task
- **宿主扩展 ticket**：不需要开（原 D-04 的后续 ticket 取消）
- **推理**：`__goalInit` 是 Pi 官方私有协议（A-07），签名纯度不重要；砍掉有用参数是为纯而纯，无架构收益

### D-13: 时间累计从 persist 剥离到 Budget.tick()
- persist 只做序列化（纯），不再有副作用（不再改 state）
- 时间累计作为 Budget 的 `tick()` 方法，由 service 在 persist 前调用
- **推理**：符合 FR-1.3 归位（timeUsedSeconds 归 Budget）；persist 纯净符合"service 决定 persist 时机"规约；Budget.tick() 可纯函数单测

### D-14: 删除 hasPendingInjection 僵尸字段
- grep 确认：5 处写入、0 处读取（无任何 if 分支消费它）
- 重构删除
- **推理**：dead code，无功能损失

### D-15: behavior 契约显式化（Round 1 追踪补强）
追踪发现多处"代码有 spec 没写"的保持行为，全部补入 spec FR-8 行为契约章节：
- Entry GC 策略（goal-state 只留最新 1 条；goal-history 留最近 20 条）
- AUTO_CLEAR_TURNS=2 终态后自动清理
- goalId snapshot stale-checker（agent_end 并发保护）
- isProcessing 防重入守卫
- Stale context 检测 + STALE_CONTEXT_PATTERNS
- signal.aborted → pendingPause → paused 完整 ESC 链路
- `/goal` flag 解析与上限（--tokens/--timeout/--max-turns/--max-stall，cap）
- cancel_goal details.tasks 返回空数组（投影契约）
- resume 可转 terminal（budget 重检）
- session_start 非对称强制激活（非终态非 paused → active；paused 保持）
- transitionStatus 保持宽松（仅守卫终态，不收紧转换表）
- completed 无 verification 全锁（含不能 cancel）
- subtask 保持宽松（无严格状态机校验）
- `/goal update` 走 applyCommand（重塑，保留 goalId）
- `/goal set` 覆盖终态 goal 保留快速路径（不写重复 history）
- createGoal 重置 stall 基线（tasksCompletedAtAgentStart）
- FR-6.1 widget 刷新只覆盖 state 变更 action（list_tasks 只读不刷）
- headless 加 hasUI 守卫（updateWidget 前检查 ctx.hasUI）
- persist 失败保持现状（事件处理器内不额外加 try/catch）
- 部分损坏 entry 全丢（配合 FR-5 清断兼容）

### D-16: `__goalInit` ctx 改为必填（修正 G-R2-007）
- **决策**：`__goalInit` 签名 ctx 从可选改为必填，service 层不再持有 lastCtx 可变状态
- **原推荐 A（保留 lastCtx fallback）被推翻**：B 更纯，消除了模块级可变状态，service 不需要捕获/持有 ctx
- **风险评估修正**：3 个调用方（coding-workflow Phase2/3、plan compact）都已传 ctx，改必填是**收紧契约**不是破坏，运行时零影响
- **效果**：service.persist(objective, tasks, budget, ctx) 的 ctx 由调用方显式提供，service 无可变状态
- **AC-4 调整**：tasks 参数不变（D-12 保持）；ctx 从可选变必填（收紧，调用方已满足）。原"签名不变"措辞修正为"tasks 参数不变，ctx 收紧为必填"

### D-17: Round 2 事件链路精确行为补强
追踪发现 Round 1 遗漏了事件 handler 精确副作用和 agent_end 分支优先级，补入 spec FR-8.6/8.7：
- message_end token 累加精确算法
- turn_end currentTurnIndex++ + agent_start 基线设置
- continuation 去抖（空 turn 不发）
- allTasksDone steer/followUp 区分
- before_agent_start 两套独立机制（staleness reminder + context pause）
- agent_end 分支优先级（allTasksDone 优先 complete）
- history 写入条件矩阵（仅终态写，中间态不写）
- `/goal set` 覆盖非终态旧 goal 写 cancelled history

### D-18: ESC 行为 = 纯打断（用户决策，2026-06-22）
- **用户明确**：ESC 是纯打断，用户可能只是想追加信息，不是暂停
- **行为**：ESC 中断当前 AI 生成（signal.aborted），agent_end 检测到 ESC 不发 continuation、不注入 goal prompt、goal 保持 active、不递增 currentTurnIndex、不触发 stall 检测
- **恢复**：用户输入完成后 before_agent_start 恢复注入 goal prompt，goal 继续 autonomous loop
- **与 pause 区分**：ESC = 纯打断无状态变化；`/goal pause` = 显式暂停转 paused 状态；context > 85% = 资源保护转 paused 状态
- **实现**：移除 `pendingPause` 字段，agent_end 检测 `ctx.signal.aborted` 时直接 return
- **修正原行为**：当前代码 ESC → pendingPause → paused，重写后改为纯打断（行为演进，用户认可）

### D-19: create_tasks all-complete → 拆为独立 ticket（修正原"报错"决策）
- **原决策**（Round 3）：所有 task 完成时 create_tasks 报错而非静默覆盖。**修正**（spec 分析轮）：拆为独立 ticket，不纳入架构 PR
- **修正理由**：这是**可选产品决策**，不是架构必须。"完成后重新拆解、继续扩展目标"是合理流程，强制报错可能砍掉有价值路径。架构 PR 须保持行为等价（原样保留静默覆盖），此行为变更独立评审
- **架构 PR 期间**：handleCreateTasks 守卫逻辑不变（`existingIncomplete.length > 0` 才拒绝，all-complete 时覆盖）

### D-20: Round 4-5 行为保持补强（F 类，无需用户决策）
Round 4 独立追踪发现 5 处"代码有 spec 没写"的保持行为，Round 5 收敛复核又确认 1 处（E-R5-001）。全部属 D-15 模式（重构不得遗漏），经主 agent 二次确认源码后保留，补入 spec：
- **FR-8.6 修正**（G-R4-001）：staleness reminder 注入时**重置被提醒项 lastUpdatedTurn**（避免下轮重复触发）。spec 原"不改状态"描述不准，已修正
- **FR-8.9**（G-R4-002）：update_tasks 把 task 标 completed 且有 verification 时立即调 injectVerificationSteering（deliverAs="steer"）
- **FR-8.10**（G-R4-003）：complete_goal 全 cancelled 守卫（至少一个 completed/verified）
- **FR-8.11**（G-R4-004）：add_subtasks 拒绝给 completed task 加 subtask（有意业务决策）
- **FR-8.12**（G-R4-005 + E-R5-001，关键）：`/goal set` 创建后调 sendUserMessage(deliverAs="followUp") 触发 AI 启动；`/goal resume` 有未完成任务时同样触发（并行模式）。整个 goal workflow 的启动机制

**为何不需问用户**：这些是客观代码事实（F 类），经主 agent 二次确认源码成立且相关。spec D-15 已确立原则"代码有 spec 没写的保持行为全部保留"，无决策空间，直接补入 FR-8。其中 G-R4-005（set/resume 后触发 AI）尤其关键——漏掉会破坏整个 goal workflow。

### Round 5 收敛复核结果
- **判定：CONVERGED**——独立 subagent 从零审视未发现重大新 gap
- 5 处边缘观察（E-R5-002~005：resume/update 的 prompt 注入细节、lastProgressTurn 重置、message renderer 注册）属已建立模式的自然延伸，不构成 gap
- 唯一有行为影响的 E-R5-001（resume 触发 AI）已并入 FR-8.12

---

## Spec 分析轮修订（D-21/D-22 + ESC 实测 + 链路分析）

> 触发：用户要求重新审视 spec 是否过度设计。经架构讨论 + Pi 源码调研后修订。以下决策修正/补充 Round 1-5 的结论。

### D-21: 更新入口 = 双入口，非统一 applyCommand（推翻原 FR-3.2）

**原 FR-3.2**：`applyCommand(state, command)` 统一命令（用户/AI）和事件（Pi runtime）两类输入。

**链路分析结论**：两类输入在所有维度都不同，强行合并是用 if 拼两套无关语义。

| 维度 | 路径 A（命令/工具） | 路径 B（事件） |
|------|-------------------|---------------|
| 触发方 | 用户/AI 主动 | 框架异步 |
| 返回值 | 有（ToolResult/notify） | 无（纯副作用） |
| 并发模型 | 同步串行 | isProcessing 防重入 + goalId snapshot |
| 错误处理 | 返回 errorResult | 静默/notify，无返回 |
| signal.aborted | 不关心 | **核心分支**（ESC） |
| stale-check | 无 | 每个副作用前 checkStale |
| persist 方式 | `persist`（纯持久化） | `persistAndUpdate`（持久化+刷 widget+stale 短路） |

**真正相同的只有最底层的 state mutation**（transitionStatus / 改 tasks / 改 budget flags）——这些是纯函数/纯赋值，不需要"统一入口"去重。

**修正方案**：
- engine 层纯函数（`transitionStatus` / `finalizeGoal` / `checkBudget` / `applyTaskUpdate`）是两条路径的**真正共享层**
- service 层双入口：`applyToolAction(state, action) → { state, result }` / `applyEvent(state, event) → { state, effects[] }`
- 并发保护（isProcessing / goalId snapshot / stale-check / signal.aborted）留 event-adapter，不进 service
- **ESC 守卫只在 event-adapter**——这印证了分开的价值：合并成 applyCommand 会让 ESC 的 aborted 分支污染 tool 路径

### D-22: 命名 engine/ 而非 domain/

- "domain" 是 DDD 术语，暗示每个概念都该建 aggregate / repository / ubiquitous language
- **实际危害**：GoalHistory 被提为一等 aggregate（D-09 原决策），部分就是"domain"命名诱导——"既然是 domain，每个东西都该有 aggregate 吧？"
- "engine" 换框后，自然问"这个 engine 计算什么"——goal 计算 7 态转换，task 计算 5 态转换 + 双维度投影，budget 计算阈值决策。GoalHistory 不计算任何东西 → 不该在 engine 层
- **命名是结构决策**，不是美化：它自带防膨胀抗体

### ESC 实测时序（Pi 源码验证，`pi-mono-fix-workspace/main`）

调研确认用户期望："ESC 真的停了整个 agent loop，要等用户下一条消息才重新 before_agent_start"。

**完整时序**（关键源码位置）：
```
用户按 ESC
  → AbortController.abort() (agent.ts:301)
  → 底层流中断，LLM 返回 stopReason="aborted"
  → emit message_end (aborted assistant msg)   ← goal handler 会跑
  → emit turn_end (toolResults=[])              ← goal handler 会跑（currentTurnIndex++！）
  → emit agent_end                              ← goal handler 会跑
  → runLoop return (agent-loop.ts:196-200)
  → _handlePostAgentRun 返回 false（aborted 不可重试，队列已被清空）
  → 整个 run 结束，等用户下一条消息
  → 用户下次输入 → AgentSession.prompt() → before_agent_start 重新触发 (agent-session.ts:1099)
```

**关键发现**：
1. abort 后**不会自动进入下一轮**——runLoop 直接 return，等用户消息 → FR-6.7"用户输入后恢复"成立
2. **before_agent_start 在 abort 后、用户发新消息前不会触发**——它只在 `AgentSession.prompt()` 路径触发，不在 `agent.continue()` 路径
3. **turn_end 在 abort 时会触发**——当前代码无脑 `currentTurnIndex++`，ESC 会消耗一个 turn 预算（必须在 turn_end 加 aborted 守卫）
4. **message_end 会触发**且 message.role 是 assistant——当前 `isActiveStatus` 守卫在，但 aborted 消息 usage 通常为空，显式跳过更安全
5. **ESC 清空 steering/followUp 队列**（interactive-mode.ts:3751 `restoreQueuedMessagesToEditor`）——即使 agent_end 试图发 continuation，Pi 也会丢弃。但代码层应显式不发，避免依赖 Pi 的清空行为

**对 FR-6.7 的影响**：原 spec 只写"agent_end 检测 signal.aborted 时 return"是**必要但不充分**。完整设计须在 message_end / turn_end / agent_end **三个** handler 都加 aborted 守卫（详见 spec FR-6.7 表格）。

### 行为变更拆分原则（架构 PR 纯度）

架构重写 PR 必须保持行为等价（FR-8 作为契约保护）。行为变更分两类：

| 行为变更 | 类型 | 处理 |
|---------|------|------|
| FR-5 序列化清断 | **架构必须**（engine 层纯净性要求移除兼容逻辑） | 纳入架构 PR，但显式标注 |
| FR-6.7 ESC 纯打断 | **架构必须**（pendingPause 字段删除是重构的一部分，且用户明确要一起做） | 纳入架构 PR |
| FR-8.8 create_tasks 报错 | **可选产品决策** | 拆为独立 ticket |

**原则**：多 AI agent 维护下，行为变更藏在架构 PR 里极难发现（AI reviewer 易被结构变动占用注意力漏掉 behavior 变化）。可选产品决策必须独立评审。

---

---

## Step 6 定稿检查（术语 + ADR）

### CONTEXT.md 一致性检查
扫描 spec.md 术语 vs 项目 CONTEXT.md：
- spec 使用 GoalStatus 7 态 / TaskStatus 5 态 / GoalTask / TaskVerification / Budget / Steering / Goal 等术语，**与 CONTEXT.md 一致**
- **待 Phase 3 更新**（非 Phase 1 范围）：重构后 CONTEXT.md 的 Budget Warning 词条（当前写"token 和时间预算共享预警 flag"）需改为"按维度独立追踪"——这是 FR-6.2 修复的结果，属实现阶段产物
- spec 未引入需在 Phase 1 定义的新模糊术语（所有术语在 Assumption Audit 已验证或代码派生）

### ADR 评估（Nullable）
扫描 spec 决策 D-01~D-20：
- 无满足"难以逆转 + 无上下文会惊讶 + 真实权衡"三条件的架构级决策需新建 ADR
- D-03（序列化清断兼容）、D-08（Task 双维度）、D-12（__goalInit 签名）等真实权衡已在 spec Decisions Made 表 + clarification.md 充分记录
- 现有 docs/adr/001-025 覆盖既有架构决策，本 spec 不引入新 ADR 级别的架构变更
- **结论：不新建 ADR**

### Six-Element Completeness Check
| Element | 状态 |
|---------|------|
| Outcomes | ✓ AC-1~AC-8 有具体终态 |
| Scope boundaries | ✓ D-04 明确 out-of-scope |
| Constraints | ✓ Constraints 章节 |
| Decisions made | ✓ D-01~D-20 |
| Verification | ✓ AC-6/AC-7/AC-8 |
| Business use cases | ✓ UC-1~UC-5 |

### Ambiguity Scan
扫描模糊形容词/未量化阈值——无 `[AMBIGUOUS]` 级问题：
- "适度充血"/"轻量"/"宽松" 是架构风格描述词，有具体 FR 子句支撑（非阈值要求）
- "尽量保持契约" 已由 AC-4 具体契约列表量化
- "统一" 总与具体收敛点搭配（"统一到 createGoal"等）

---

## Assumption Audit 结果

### A-01: GoalStatus 枚举（已验证）
```
"active" | "paused" | "blocked" | "complete" | "budget_limited" | "time_limited" | "cancelled"
```
终态集合：complete / budget_limited / time_limited / cancelled（4 个）
非终态可执行：active；可逆中间态：paused / blocked
源：`state.ts:42-49`，`TERMINAL_STATUSES`

### A-02: TaskStatus 枚举（已验证）
```
"pending" | "in_progress" | "completed" | "verified" | "cancelled"
```
终态：verified / cancelled
源：`state.ts:61`，`isTerminalTaskStatus:87`

### A-03: SubtaskStatus 枚举（已验证）
```
"pending" | "in_progress" | "completed"
```
源：`state.ts:63`。3 态无 verification（刻意设计）

### A-04: BudgetConfig 字段（已验证）
```ts
tokenBudget?: number;        // 可消耗资源
timeBudgetMinutes?: number;  // 可消耗资源
maxStallTurns: number;       // 硬边界（必填，默认 5）
maxTurns: number;            // 硬边界（必填，默认 50）
```
源：`state.ts:116-121`，`DEFAULT_BUDGET:148-151`

### A-05: GoalRuntimeState 字段全集（已验证）
19 个字段。源：`state.ts:125-144`。重构后归属：
- Goal aggregate：goalId, objective, status, tasks
- Budget：stallCount, tokensUsed, timeStartedAt, timeUsedSeconds, budget, lastProgressTurn, budgetLimitSteeringSent, budgetWarning70Sent, budgetWarning90Sent, lastTurnTokensUsed, currentTurnIndex
- lifecycle meta：objectiveUpdatedAt, lastBlockerReason, completedAtTurnIndex

### A-06: `__goalInit` 调用方（已验证，3 处）
```
extensions/coding-workflow/lib/tool-handlers.ts:503,526 — 各自重新声明 GoalInitFn
extensions/plan/src/compact.ts:79 — 重新声明 GoalInitFn
extensions/goal/src/state.ts:33 — GoalExternalInit 定义（唯一权威）
extensions/goal/src/index.ts:444 — 赋值点
```
四份类型定义手动对齐（goal 定义一份，3 个调用方各重声明一份）。
所有调用都在 `try { } catch { /* non-blocking */ }` 内。

### A-07: `pi.__goalInit` 是官方支持的私有协议（新发现，重要）
`shared/types/mariozechner/index.d.ts` 中 `ExtensionAPI` 有：
```ts
// 扩展间私有协议（goal/workflow 用 __ 前缀注入字段）
[key: `__${string}`]: unknown;
```
**这不是全局变量 hack，是 Pi 平台官方机制**。
影响 D1 表述：保留 `__goalInit` 不算架构债，是平台约定。
类型漏洞问题仍在（调用方各自重新声明类型），但 D1 收窄签名 + goal 端用 `satisfies GoalExternalInit` 已是当前能做到的最强类型约束。

### A-08: Pi SDK 关键 API（已验证拼写）
```
pi.registerTool(tool) / pi.registerCommand(name, cmd) / pi.registerMessageRenderer(type, renderer)
pi.on(event, handler) — handler 是 (event, ctx) 两参数
pi.appendEntry(customType, data) — 当前代码用此（非 appendCustomEntry）
pi.sendMessage(message, options?) / pi.sendUserMessage(content, options?)
```
ctx 字段：cwd / sessionManager / modelRegistry / getContextUsage() / hasUI / ui / model / signal / isIdle() / abort() / ...

### A-09: 现有测试（已验证）
```
extensions/goal/src/__tests__/deserialize-state.test.ts (109 行)
extensions/goal/src/__tests__/is-task-done.test.ts (43 行)
extensions/goal/src/__tests__/validate-update-tasks.test.ts (172 行)
extensions/goal/src/__tests__/stubs/pi-sdk.ts (StringEnum mock)
extensions/goal/src/__tests__/stubs/typebox.ts (Type mock)
extensions/goal/vitest.config.ts (alias 到 stub)
```

### A-10: pi.on 事件（已验证）
当前注册 6 个：`before_agent_start` / `agent_start` / `turn_end` / `message_end` / `agent_end` / `session_start`
stub 中 `on(event: string, ...)` 是宽泛签名，事件类型用 Like*Event 本地接口约束（index.ts:30-58）

---

## 已知降级影响

**无降级**（D-12 修正后）。`__goalInit` 签名保持不变，coding-workflow/plan 的 3 个调用点零改造、零降级。

（原"降级 1"已作废——D-02 初版的"签名收窄"判断有误，D-12 修正为保持签名，只重设计内部实现走唯一 createGoal。）
