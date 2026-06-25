# 跨文档一致性审查

## 总体结论

**存在 7 处不一致（1 Critical + 4 Major + 2 Minor）** — 下游执行链（spec/issues/code-arch/NFR/execution-plan 的 budget 落点、跨扩展 API、状态机 7 态）已基本对齐，但 **issues.md #2/#6 的范围与验收标准未与 execution-plan D1/D2 决策同步**（Critical），且 upstream 的 clarification/system-architecture 仍把 budget 检查点错误归给 persistState（Major）。

---

## 不一致清单（按严重度）

### Critical（阻塞编码，决策冲突或范围矛盾）

#### C1: issues.md #2/#6 范围与验收标准未与 execution-plan D1/D2 同步（执行依据直接冲突）

- **涉及文档**：`issues.md` L130-131/L156-157/L360-363/L384-385 vs `execution-plan.md` D1(L 决策记录)/D2/Wave 1 #2(L78-83)/Wave 4 #6(L193-201)
- **矛盾描述**：execution-plan 的 D1 重新切分了 #2/#6 范围（#2 收窄只加状态不删字段、#6 扩大接管「字段定义 + 12 文件 54 处使用点 + 控制流」），D2 修正了 #6 文件归属（handleStallAndContinuation 等 4 函数归 `agent-end.ts`）。D1 原文明确声称「issues.md 同步：#2 验收移除两条字段删除项 → 移至 #6 验收」。**但 issues.md 原文实际未同步**，三处脱节：

  **脱节点 1（#2 验收未移除字段删除项）**：
  - issues.md L156-157 仍含：「`BudgetConfig 不含 maxTurns/maxStallTurns`」「`GoalRuntimeState 不含 stallCount`」
  - execution-plan Wave 1 #2 验收（L 末尾）明确：「**不含**『BudgetConfig 无 maxTurns』『GoalRuntimeState 无 stallCount』两条（移至 #6，见 D1）」
  - → 同一事项两文档给出矛盾结论：issues.md 说 #2 删字段，execution-plan 说 #2 不删字段（范围矛盾）

  **脱节点 2（#6 方案改动范围不足）**：
  - issues.md #6 方案 A 改动（L360-363）只列 4 处分支删除（handleAllTasksDone / handleNoTasksOrMaxTurns / handleMaxTurnsReached / handleStallAndContinuation），**未含** D1 扩大的「BudgetConfig.maxTurns/maxStallTurns + GoalRuntimeState.stallCount 字段定义删除 + 12 文件 54 处使用点全清」
  - execution-plan Wave 4 #6（L193）明确：「字段+使用点+控制流一次性删除（D1+D2）：engine/types.ts（删 BudgetConfig.maxTurns/maxStallTurns + GoalRuntimeState.stallCount）...12 文件使用点全清」
  - → subagent 若以 issues.md #6 方案改动为执行依据，会遗漏字段定义 + 使用点删除 → typecheck 红区（删了字段定义但使用点未清，或反之）

  **脱节点 3（#6 文件归属误判未修正）**：
  - issues.md #6 方案改动（L363）：「`event-handlers/turn-end.ts` 或 `before-agent-start.ts`: handleStallAndContinuation 删除 stallCount++→blocked」
  - execution-plan D2 明确修正：handleStallAndContinuation / handleAllTasksDone / handleNoTasksOrMaxTurns / handleMaxTurnsReached 4 函数归 `event-handlers/agent-end.ts`（调用链全在 agent_end 主流程）
  - → issues.md 把 4 函数错误归给 turn-end.ts/before-agent-start.ts，subagent 会去错文件找函数

- **证据**：
  - issues.md L156「`- [ ] BudgetConfig 不含 maxTurns/maxStallTurns`」/ L157「`- [ ] GoalRuntimeState 不含 stallCount`」
  - issues.md L363「`event-handlers/turn-end.ts` 或 `before-agent-start.ts`: handleStallAndContinuation...」
  - execution-plan D1「#2（Wave 1）收窄：只加 paused...**不删** stallCount/maxTurns/maxStallTurns 字段。验收移除『BudgetConfig 无 maxTurns』『GoalRuntimeState 无 stallCount』两条」
  - execution-plan D1「issues.md 同步：#2 验收移除两条字段删除项 → 移至 #6 验收」（**声称同步但实际未执行**）
  - execution-plan D2「#4 拆分后这 4 函数归 `event-handlers/agent-end.ts`」
- **建议修复方向**：回改 issues.md（execution-plan D1 已声称同步但未落实，应在 issues.md 真正落地）：
  1. #2 验收删除 L156-157 两条字段删除项
  2. #6 方案 A 改动补全「字段定义删除（types.ts）+ 12 文件 54 处使用点全清」
  3. #6 方案改动 L363「turn-end.ts 或 before-agent-start.ts」改为「`event-handlers/agent-end.ts`」
  - **关键**：execution-plan 的 subagent 注入上下文同时引用 issues.md #2/#6 全文与 execution-plan Wave 验收，两源矛盾会让 subagent 困惑。必须让 issues.md 与 execution-plan 对齐。

---

### Major（可能导致执行偏差）

#### M1: budget 检查点 upstream 表述矛盾（clarification + system-architecture 仍写 persistState）

- **涉及文档**：`clarification.md` D6(L58)/D8(L66-67)/D23(L191-195) + `system-architecture.md` L20/L47/L105-106/L137/L343/L411/L433-434 vs `spec.md` FR-5/AC-5/UC-3 + `issues.md` #5 + `code-architecture.md` §3/§6 + `non-functional-design.md` F2 + `execution-plan.md` Wave 5
- **矛盾描述**：handoff 强调的核心架构事实是「budget 终态检查在 `persistAndUpdate`（事件路径），不在 `persistState`（command/tool 路径）」。下游 5 个文档（spec/issues/code-arch/NFR/execution-plan）已全部统一为 persistAndUpdate；但 2 个 upstream 文档（clarification、system-architecture）多处仍写 persistState，且这些表述不属于「合法三类语境」（非 command/tool 路径、非 disambiguation 取证说明、非被否决方案）。

  **system-architecture 错误归点（budget 检查点语境）**：
  - L20「FR-5: budget 单一检查点 | persistState 内兜底...终态转换只在 persistState」
  - L47 统一语言「persistState | 持久化函数，内含 budget 兜底检查 | 单一检查点」
  - L105-106 转换表注释「active → budget_limited (system: persistState 兜底)」
  - L137 行为表「budget 检查（persistState）| active: 是」
  - L343 Budget 兜底泳道图「PiCore->>GoalExt: persistState (turn N) → tick() + checkBudget() → terminal: budget_limited」
  - L411 特化决策「persistState 同时做 persist + budget 检查 | 单一检查点」
  - L433-434 AC-7 反模式检查「persistState 内 budget 检查 — 验证：`grep ... service.ts` 在 persistState 函数内有输出」

  **clarification 错误归点**：
  - L58 D6「系统（persistState 兜底）：budget_limited / time_limited」
  - L66-67 D8「预算自动触发 = persistState 兜底...在 persistState（每次持久化的单一出口）加 budget 检查」
  - L191-195 D23「budget 单一检查点（persistState 兜底）...终态转换只在 persistState 内完成...persistState 加 `if (active && tokensUsed >= tokenBudget) → budget_limited` 判断」

  **下游已对齐**（参考，证明 upstream 是遗漏）：
  - spec.md FR-5「persistAndUpdate 内加 budget 兜底...注：persistAndUpdate 是事件路径...非 command/tool 路径的 persistState」
  - issues.md #5 标题「budget 单一检查点（persistAndUpdate 兜底，事件路径）」+ 架构事实说明「事件路径走 persistAndUpdate...不走 service.persistState」
  - code-architecture §3 注意「上游 system-architecture/issues 写的 persistState 检查点，实际在 persistAndUpdate（事件路径）」（**注：此处说"issues"系误指，issues #5 实际已写对**）
  - non-functional-design F2「budget 终态检查必须在事件路径的 persist 函数内（persistAndUpdate）。不是 service.persistState」
  - execution-plan Wave 5「架构事实（NFR F2）：budget 终态检查在 persistAndUpdate（事件路径），不在 persistState」

- **影响**：
  - 执行依据（issues #5 验收 / execution-plan Wave 5）已对齐 persistAndUpdate，不直接阻塞编码
  - 但 system-architecture §11 AC-7 的 grep 验收命令指向 `persistState` 函数，若有人按此验收，会在 persistState 函数找 budget 检查（实际在 persistAndUpdate），验收误导
  - clarification D23 作为决策日志未追加修正（如 D29「修正 D8/D23，检查点实际在 persistAndUpdate」），回溯理解决策者会得到错误结论
- **建议修复方向**：
  1. system-architecture L20/L47/L105-106/L137/L343/L411/L433-434 的 budget 语境 persistState 改为 persistAndUpdate（或追加「注：事件路径走 persistAndUpdate，见 NFR F2」）
  2. clarification 追加一条决策记录修正 D8/D23（不回改历史，追加修正说明）

#### M2: code-architecture §6 Wave 推导依赖违反（#5 与 #7 同 Wave 4）

- **涉及文档**：`code-architecture.md` §6(L Wave 推导) vs `issues.md` #5「Blocked by: #4, #7」+ `execution-plan.md` D3
- **矛盾描述**：code-architecture §6 Wave 推导把 #5（budget 检查点）与 #7（todo API）同放 Wave 4：「Wave 4: #5（budget 检查点）+ #6（删自动终态）+ #7（todo API）+ #8（agent_end）— 依赖 #4」。但 issues.md #5 标注 `Blocked by: #4, #7`——#5 依赖 #7，不能与 #7 同 Wave 并行（§6 未声明 Wave 4 内部串行关系）。execution-plan 已修正：#7 在 Wave 4 / #5 在 Wave 5（串行 #8→#5），并通过 D3 如实说明了差异。
- **证据**：
  - code-architecture §6「Wave 4: #5（budget 检查点）+ #6（删自动终态）+ #7（todo API）+ #8（agent_end）」
  - issues.md #5「**Blocked by**: #4, #7」
  - execution-plan D3「code-architecture §6「Wave 推导」把 #5（blocked_by #7）与 #7 同放 Wave 4，违反依赖...本计划已修正：#7 Wave 4 / #5 Wave 5」
- **影响**：execution-plan 是执行依据且 D3 已显式说明并修正，不阻塞编码。但 code-architecture §6 作为「喂给 Step 6 的建议」留存错误依赖编排，若有人直接参考 §6 会违反 DAG。
- **建议修复方向**：code-architecture §6 Wave 推导表更新为 execution-plan 的 6 Wave 划分（或在 §6 追加「注：Wave 划分以 execution-plan 为准，见 D3」）。

#### M3: goal_control adapter 文件命名冲突（goal-control-adapter.ts vs tool-adapter.ts）

- **涉及文档**：`issues.md` #3(L171/L184/L209) + `system-architecture.md` L17/L206/L229/L443 + `execution-plan.md` L129 vs `code-architecture.md` L21/L131/L207/L241
- **矛盾描述**：goal_control 工具的新建文件名在文档间分裂为两派：
  - **goal-control-adapter.ts 派**（3 文档一致）：issues.md #3「新建 `adapters/goal-control-adapter.ts`」+ 验收「`adapters/goal-control-adapter.ts` 存在」；system-architecture §6 模块表/§7 删除清单/§1 目标转换表「新建 goal-control-adapter.ts（2 action），替代 tool-adapter.ts」；execution-plan Wave 2 文件影响表「新建 `adapters/goal-control-adapter.ts`（~120 LOC）」
  - **tool-adapter.ts 派**（code-architecture 单独）：code-architecture §1 目录「`tool-adapter.ts # goal_control tool（complete / report_blocked）`」+ §3「模块: adapters/tool-adapter.ts（goal_control）」+ 功能 2 时序图 participant「TA as tool-adapter」+ 数据流链「tool-adapter.handleComplete」

  system-architecture §7 删除清单明确要「删除 `adapters/tool-adapter.ts`（goal_manager 10 action 废弃）」，code-architecture 却复用同名文件承载 goal_control。
- **影响**：issues.md #3 验收「`adapters/goal-control-adapter.ts` 存在」是硬验收点。若 subagent 按 code-architecture §1/§3 建 `tool-adapter.ts`，issues.md #3 验收会 fail。execution-plan Wave 2 注入上下文还同时引用「code-architecture §3 tool-adapter 契约」与「issues.md #3」（两源文件名矛盾）。
- **建议修复方向**：统一为 `goal-control-adapter.ts`（多数派 + 验收点），回改 code-architecture §1/§3/功能 2 时序图/数据流链的 `tool-adapter` → `goal-control-adapter`。

#### M4: UC 编号标注错误（功能 2/4/5 误标 + 引用不存在的 UC-5）

- **涉及文档**：`code-architecture.md` §4 L159/L202/L280/L316 + `execution-plan.md` L138 vs `spec.md` UC 定义
- **矛盾描述**：spec.md 只定义 UC-1~UC-4（UC-1 复杂任务全流程 / UC-2 用户叫停续跑 / UC-3 预算耗尽自动终止 / UC-4 agent 自主完成）。code-architecture §4 时序图与 execution-plan Wave 2 注入上下文的 UC 标注错乱：
  - 功能 1「/goal set」标 **UC-1**：UC-1 是「复杂任务全流程（plan→goal→todo→audit）」，/goal set 只是其中一步（勉强关联，但 UC-1 整体不等于 /goal set）
  - 功能 2「goal_control.complete」标 **UC-2**：UC-2 是「用户叫停续跑」，goal_control.complete 对应的是 **UC-4（agent 自主完成）**，**标注错误**
  - 功能 4「before_agent_start context 注入」标 **UC-4**：context 注入是横切关注点，不对应任何单一 UC，且 UC-4 已被功能 2 错占
  - 功能 5「/goal pause → resume」标 **UC-5**：**spec 无 UC-5**，pause/resume 对应 **UC-2（用户叫停续跑）**
  - execution-plan Wave 2 注入上下文「spec.md UC-2/UC-5」：**UC-5 不存在**，pause/resume 应为 UC-2
- **证据**：
  - spec.md 业务用例仅 UC-1~UC-4
  - code-architecture L202「### 功能 2: goal_control.complete（**UC-2**，tool 路径...）」
  - code-architecture L316「### 功能 5: /goal pause → resume（**UC-5**，状态机...）」
  - execution-plan L138「共同: spec.md **UC-2/UC-5** + code-architecture §4 时序图 2/5」
- **影响**：时序图的功能描述本身正确，仅 UC 标签错。不阻塞编码（执行依据是功能描述 + issues 验收），但误导需求追溯（按 UC 找时序图会错位）。
- **建议修复方向**：功能 2 改标 UC-4；功能 5 改标 UC-2；execution-plan Wave 2「UC-2/UC-5」改为「UC-2/UC-4」（或直接引用功能编号而非 UC）。功能 1/4 的 UC 标签可弱化或移除（横切/子步骤不必强绑 UC）。

---

### Minor（措辞/编号/遗留笔误）

#### m1: P3「多 session 重构」项在 issues.md 缺失

- **涉及文档**：`issues.md` 后续迭代章节 vs `execution-plan.md` 后续迭代 + `non-functional-design.md` 多 session 假设
- **描述**：execution-plan 后续迭代列「[P3] 多 session 重构 — 延后理由：当前假设单 session」，non-functional-design 也明确「本扩展假设单 session 使用」。但 issues.md 后续迭代只列 3 项（预警 flag 合并 / budget.ts 拆分 / prompts.ts 拆分），**未列多 session 重构**。
- **影响**：不影响执行（无文档把多 session 当本次范围）。仅 P3 清单不完整。
- **建议**：issues.md 后续迭代补「[P3] 多 session 重构」。

#### m2: code-architecture §3 index.ts API 表未列 pi.__planStart / pi.__todoGetList 签名

- **涉及文档**：`code-architecture.md` §3 index.ts API 表 vs `spec.md` FR-7 + `system-architecture.md` §8 + `execution-plan.md` Wave 4/6
- **描述**：code-architecture §3「模块: index.ts（跨扩展 API）」只列 `pi.__goalInit`，未列 `pi.__planStart` 和 `pi.__todoGetList` 的签名契约（后两者在功能时序图/§8 中出现但无正式签名表）。spec FR-7 / system-architecture §8 / execution-plan Wave 6 对 __planStart 签名「(requirement, ctx): boolean」有一致定义，code-arch 只是漏列。
- **影响**：无矛盾，仅 code-arch §3 契约表不完整。
- **建议**：code-architecture §3 index.ts API 表补 __planStart / __todoGetList 两行（todo extension 侧暴露，但 goal 侧调用契约可注明）。

---

## 已验证一致的维度

### ✓ 维度 1：状态机 7 态一致
- spec FR-3「GoalStatus 增加 paused（非终态）」、system-architecture §5 完整列出 7 值（active/paused/blocked/complete/budget_limited/time_limited/cancelled）+ VALID_TRANSITIONS 显式表、issues.md #2「GoalStatus 包含 paused（共 7 值）」、code-arch §3 types.ts 描述、execution-plan Wave 1 #2「GoalStatus 加 paused 共 7 值 + VALID_TRANSITIONS + TERMINAL_STATUSES」——**5 文档完全一致，无文档残留 6 态**。
- VALID_TRANSITIONS 转换规则（transitionStatus 查表 throw）：system-architecture §5 定义 ↔ issues.md #2 验收 ↔ code-arch §3 契约 ↔ execution-plan Wave 1 ——一致。

### ✓ 维度 2（部分）：budget 检查点下游执行链一致
- spec FR-5/AC-5/UC-3、issues #5（标题+方案 A+架构事实说明）、code-architecture §3/§6/功能 3 时序图、non-functional-design F2（数据一致性+并发控制+Prototype 取证）、execution-plan Wave 5 #5 ——**5 个下游文档全部统一为 persistAndUpdate（事件路径）**。upstream 矛盾见 M1。

### ✓ 维度 3（部分）：task 删除范围一致
- spec FR-1、system-architecture §7 删除清单、issues.md #1、code-architecture §1、execution-plan Wave 1 #1 ——task CRUD 删除范围（goal_manager 10 action / GoalRuntimeState.tasks / engine/task.ts / tool-adapter.ts(actions.ts) / service.ts action / deserializeState 迁移）一致。goal_control 文件命名冲突见 M3。

### ✓ 维度 6：决策链贯彻（D21/D23/D25/D26/D27/D28 → issues → Wave）
- D21 删自动 complete → issues #6/#8 ✓；D25 /goal set 拒绝 → issues #11 ✓；D26/D27 plan 联动 → issues #9 ✓；D28 删 stallCount → issues #6 ✓。D23 budget 单一检查点 → issues #5 引用 ✓（但 D23 原文 persistState 与 issues #5 落点 persistAndUpdate 的文字矛盾见 M1）。

### ✓ 维度 8：核心函数签名一致
- persistAndUpdate / persistState / finalizeAndPersist / tickState / createGoal 的签名与职责：code-architecture §3 契约 ↔ execution-plan Wave 详情一致。
- persistState（command/tool 路径，无 budget 检查）vs persistAndUpdate（事件路径，含 budget 检查）的职责区分在 code-arch §3/§5 + execution-plan Wave 5 一致。
- checkProgress 三阶段演进（D0：#1 去 task / #6 删 maxTurnsReached / #7 改 ProgressInput）与 code-arch §3 budget.ts 最终契约 + execution-plan Wave 1 #1 文件影响说明一致。

### ✓ 维度 10：跨扩展 API 一致
- pi.__todoGetList(): spec FR-1 / system-arch §8 / execution-plan Wave 4 #7 一致「Todo[] | undefined（瞬态快照，未加载返回 undefined）」。
- pi.__goalInit(objective, budget, ctx)（tasks 废弃）：spec FR-7 / system-arch §8 / code-arch §3 / execution-plan Wave 6 #9 一致。
- pi.__planStart(requirement, ctx): boolean：spec FR-7 / system-arch §8 / execution-plan Wave 6 #9 一致（code-arch §3 漏列签名见 m2）。

---

## 修复优先级建议

1. **C1（必修，阻塞 Wave 1 启动）**：回改 issues.md #2/#6 与 execution-plan D1/D2 对齐。subagent 注入上下文同时引用两源，必须消除矛盾。
2. **M1（建议修）**：system-architecture budget 语境 persistState → persistAndUpdate；clarification 追加 D23 修正记录。否则回溯理解决策会被误导，§11 AC-7 grep 验收命令误导。
3. **M3（建议修）**：code-architecture goal_control 文件名统一为 goal-control-adapter.ts（对齐 issues #3 验收点）。
4. **M2/M4（可后修）**：code-arch §6 Wave 推导、UC 编号——execution-plan 已修正/不影响验收，低优先。
5. **m1/m2（可选）**：补全 P3 清单与 API 契约表。
