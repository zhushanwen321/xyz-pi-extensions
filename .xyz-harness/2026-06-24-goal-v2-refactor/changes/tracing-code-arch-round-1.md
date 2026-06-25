---
verdict: pass-with-gaps
mode: tracing
upstream: code-architecture.md
round: 1
perspectives: [contract-completeness, call-chain-closure, dependency-health]
gap_types: { F: 5, K: 4, D: 3 }
---

# 代码架构追踪报告 — Round 1

## 追踪范围与方法

**追踪对象**：`code-architecture.md`（初稿），交叉验证上游 `spec.md` / `issues.md` / `system-architecture.md` / `non-functional-design.md`，并用 `grep` / `wc -l` 对 **当前 goal extension 源码**（重构前）取证。

**视角**：
1. 契约完整性 — spec 用例与 FR 是否都有对应 API 契约；issue 已决策方案是否都有方法签名
2. 调用链闭合 — 5 张时序图入口→底层是否完整；异常路径是否覆盖
3. 依赖健康 — 包依赖图是否无环；是否有上帝对象（>400 LOC）

**Gap 类型**：`F` = 契约/功能缺失；`K` = 知识/一致性矛盾；`D` = 依赖/结构问题。

> **取证基线说明**：当前源码是重构**前**状态。`grep` 验证用于确认 design 声称的「现状事实」（如 NFR 多次引用「代码取证」）是否属实，以及 design 契约表是否覆盖了**将要保留**的现有导出。

---

## 视角 1：契约完整性

### UC 覆盖核对（spec.md 实际只有 UC-1~UC-4，非 UC-7）

> 任务描述写「UC-1~UC-7」，但 spec.md 仅定义 **UC-1~UC-4**（grep 确认：spec.md:198/203/208/213，无 UC-5+）。UC-5~UC-7 不存在。下表按实际 4 个用例核对。

| UC | spec 描述 | design 时序图 | API 契约覆盖 | 状态 |
|----|----------|--------------|-------------|------|
| UC-1 | plan→goal→todo→audit 全流程 | 功能 1（set）+ 功能 2（complete） | set ✓ / complete 部分 ✗ | **G3** |
| UC-2 | 用户叫停续跑 | 功能 5（pause/resume） | pause/resume ✓ | 闭合 |
| UC-3 | 预算耗尽自动终止 | 功能 3（budget 自动终态） | persistAndUpdate? ✗ | **G4** |
| UC-4 | agent 自主完成 | 功能 2（complete） | handleComplete ✓（缺 plan audit） | **G3** |

### FR 覆盖核对

| FR | design 契约落点 | 状态 |
|----|----------------|------|
| FR-1 task+todo 合并 | #1 删除清单 + deserializeState 迁移 | 闭合 |
| FR-2 goal_control | §3 handleComplete/handleReportBlocked | 闭合（前置检查分支不全 → G8） |
| FR-3 paused | §3 transitionStatus + VALID_TRANSITIONS | 闭合 |
| FR-4 权限三分层 | §3 各 handler/tool/command 守卫 | 闭合 |
| FR-5 budget 单一检查点 | §3 persistAndUpdate | **G4**（落点矛盾） |
| FR-6 completion audit | §3 handleComplete + §3 prompts | **G3**（plan audit 缺契约） |
| FR-7 plan↔goal 联动 | §3 pi.__goalInit / __planStart | **G3**（plan audit 缺契约） |

### 发现的契约 gap

#### G1 [F] engine/budget.ts 契约表遗漏现存导出
`getTokenUsagePercent`（budget.ts:87）和 `accumulateTokens`（budget.ts:60）是**已存在且被使用**的导出。前者被 `projection/widget.ts` 多处调用（widget.ts:21/94/154/188），后者被 message-end handler 调用。但 code-architecture §3 budget.ts 契约表只有 4 行（checkBudgetOnTurnEnd / checkBudgetOnResume / checkProgress / tick），`accumulateTokens` 仅在模块标题文字里出现、无契约行；`getTokenUsagePercent` 完全缺席。
**影响**：执行计划若按 §3 契约表「重建」budget.ts，会漏掉这两个函数，导致 widget 编译断裂。
**修复**：§3 budget.ts 表补 2 行（accumulateTokens / getTokenUsagePercent），标注返回值与边界。

#### G2 [F] service.ts 契约表遗漏现存导出 + makeResult 隐含迁移
service.ts 现存导出 `checkResumeBudget`（:679，是 engine.checkBudgetOnResume 的薄包装）、`finalizeGoal`（:202，被 finalizeAndPersist 内部调用但本身是 public export）、`makeResult`（:688，返回 `details.tasks = state.tasks.map(...)`）。三者均未进 §3 service.ts 契约表。
其中 **`makeResult` 依赖 `state.tasks`**（#1 删除字段）。grep 确认 service.ts 内有 8 处 `state.tasks` 引用（:140/277/278/280/284/293/322/397）。#1 验收清单只列了「GoalRuntimeState 不含 tasks 字段」「deserializeState 迁移」，**未提 makeResult 等依赖 tasks 的渲染/结果函数的迁移**。
**影响**：#1 删 tasks 后，makeResult 及 8 处 tasks 引用会编译失败，但 #1 验收清单无对应检查项。
**修复**：#1 验收清单增补「service.ts 内所有 `state.tasks` 引用已迁移或删除」+ grep 验证；§3 service.ts 表补 checkResumeBudget/finalizeGoal 行（或显式标注「重构后删除/降级」）。

#### G3 [F] complete 的 plan.md audit 无代码契约
spec FR-6 写「goal_control.complete 前置检查是硬兜底（**含 plan.md 步骤对照**）」，FR-7 写「goal_control.complete 前置检查增加 plan.md 对照」。但 code-architecture §3 `handleComplete` 契约只有「todo 检查 + evidence 必填 + finalizeAndPersist」，**无任何 plan.md 步骤校验**。AC-7 把 plan audit 描述为「prompt 驱动」（软提醒）。
spec 自身矛盾（FR 正文 = 硬检查 vs AC = prompt 驱动），code-architecture **静默采纳了 AC 的软解读**，丢掉了 complete 时的 plan 审计。
**影响**：UC-1 的「audit」环节无任何代码兜底，完全靠 prompt。若实现者读 FR 正文，会找一个不存在的 plan audit 契约；若读 AC/契约表，则 plan 步骤漏跑无硬拦截。
**修复**：在 spec 层面二选一并固化（建议：与 Codex 对齐保持 prompt 驱动，但同时修正 FR-6/FR-7 正文措辞，删除「前置检查」字样），或给 handleComplete 补一个 `verifyPlanSteps(planPath)` 子契约。

#### G4 [K, 阻塞] budget 单一检查点的「落点函数」三文档矛盾
这是本次追踪发现的最严重一致性 gap。budget 终态检查到底在哪个函数，三处说法冲突：

| 来源 | 说法 |
|------|------|
| **issues.md #5 验收** | 「**persistState** 内有 budget 终态检查」 |
| **NFR #5（取证段）** | 「budget 终态检查必须在事件路径的 persist 函数内（**现状为 persistAndUpdate**）……**不是 service.persistState**」 |
| **code-architecture §3/§5** | persistAndUpdate 做「budget 终态检查」；persistState 不做；§3 末尾「NFR 交接」注释再次强调 command/tool 路径用 persistState、事件路径用 persistAndUpdate |

取证：当前 `persistAndUpdate`（event-adapter.ts:198-213）确实**只**做 tick + appendEntry + updateWidget，**无 budget 检查**；当前 `persistState`（service.ts:91-95）也**无 budget 检查**。即两处目前都没有，#5 是要「新增」检查点。
**矛盾后果**：若实现者按 #5 验收字面把检查塞进 `persistState`（command/tool 路径），则 message_end/turn_end 这些**事件路径不调 persistState**（它们调 persistAndUpdate），token 累加后 budget 永不触发 → UC-3（预算耗尽自动终止）链路断裂。code-architecture §6 自己也把这个落点列为「给 Step 6 的开放决策」（persistState 与 persistAndUpdate 是否合并「执行计划不预设」），等于承认 #5 验收条件在合并决策做出前**不可判定**。
**影响**：#5 无法被无歧义验收；UC-3 调用链在实现期有 50% 概率断裂。
**修复**：在进入 execution-plan 前**先决策** persistState/persistAndUpdate 合并方案，并据此**修订 #5 验收文本**（把「persistState 内」改为实际落点函数名），消除三文档分歧。

---

## 视角 2：调用链闭合

逐张时序图追踪入口→底层，重点查异常路径与断裂。

### 功能 1 /goal set — 闭合
User → handleSet → createGoal → createGoalState → serializeState → appendState。非终态旧 goal 拒绝分支齐全。**唯一隐患**：createGoal 当前签名含 `tasks` 参数（service.ts:121-127），design §3 与时序图已去掉 tasks，但 #9 才负责改 `__goalInit`，createGoal 的签名收紧**没有独立 issue 跟踪**（隐含在 #1/#9）。见 G5 同类问题。

### 功能 2 goal_control.complete — 分支不全（G8）
入口到底层主链闭合，但 AC-2 规定 4 个前置检查分支，时序图只画了 2 个（todo 未安装、有未完成 todo），**漏画**「空数组拒绝」「验证任务不可 cancelled」两条。属示意性遗漏，非契约缺失（§3 handleComplete 文字提到 todo 检查）。但结合 G3，complete 的前置检查链是本次最不完整的一张图。

### 功能 3 budget 自动终态 — 函数命名误导（G6）+ 落点未定（G4）
时序图标 `SVC->>EB: checkBudgetOnTurnEnd` 后 `alt 超 budget → transitionStatus`。但 §3 budget.ts 契约明确 checkBudgetOnTurnEnd「**只返回 warning，不返回 terminal**」。真正做终态判定的应是 persistAndUpdate 内的 `tokensUsed >= tokenBudget` 直比较，**不是** checkBudgetOnTurnEnd。
**影响**：实现者照图施工会把终态逻辑挂到 checkBudgetOnTurnEnd，重新引入 #5 要消除的「双检查点 race」（agent_end 的 warning 检查与 persist 的 terminal 检查同源）。
叠加 G4（落点函数未定），这张图的可靠性最差。

### 功能 4 before_agent_start context 注入 — 闭合
status guard（paused/blocked/终态 → undefined）+ getTokenUsagePercent + todo 降级（undefined）+ contextInjectionPrompt 链完整。**注**： getTokenUsagePercent 未进契约表（G1），但调用链本身闭合。

### 功能 5 pause/resume — tickState 行为描述错误（G7）
Resume 段时序图注释写「**tickState** 重置 timeStartedAt（开启新运行段）」。取证：tickState（service.ts:75-80）的契约是「isRunning=false 不累加」，它**不会**在 resume 时重置 timeStartedAt；当前重置发生在 command-adapter.ts:114 `state.timeStartedAt = Date.now()`（直接赋值，不走 tickState）。
**影响**：tickState 在 paused→active 转换时，`isRunning` 由 false 变 true，但 tick 内部当 `timeStartedAt` 已有值时不重置 → resume 后时间累加仍挂在旧 timeStartedAt 上，运行时段计量错误。实现者若信时序图把重置职责交给 tickState，会产出计时 bug。
**修复**：时序图注明「timeStartedAt 重置由 command-adapter 直接赋值，tickState 不负责」；或在 §3 tickState 契约补一条 resume 语义说明。

### 汇总：调用链 gap
- **G6 [K]** 功能 3 时序图用 checkBudgetOnTurnEnd 名义做 terminal 判定，与该函数契约（只 warning）冲突，误导实现、复活双检查点 race。
- **G7 [K]** 功能 5 时序图把 timeStartedAt 重置归给 tickState，与 tickState 实际行为不符；resume 计时有出错风险。
- **G8 [F]** 功能 2 时序图只画 4 个 AC-2 前置分支中的 2 个（缺空数组、验证任务 cancelled 两条）。

---

## 视角 3：依赖健康

### 依赖图无环性 — 无环，但有 2 条漏画边

§2 dependency graph 声称无环。取证核对：
- engine / ports 为叶子 ✓（grep：engine/ 无 `@mariozechner`，AC-4 现在就满足）
- service → engine + ports ✓
- adapters → service + engine + ports ✓
- 所有边单向向下，**确认无环**

但漏画 2 条边：
- **G9 [D]** persistence.ts 现导出 `GoalHistoryEntry` 来自 `./ports`（persistence.ts:16），且 import `./engine/task`（:8-14，#1 将删）。§2 图只画 `persistence → engine`，**漏画 `persistence → ports`**。图不完整，影响重构者判断 persistence 的真实依赖面。

### 上帝对象检查（>400 LOC 阈值）

**重构后（design §7 估算）**：全部 < 400 LOC。最接近的是 `projection/prompts.ts ~370`、`command-adapter.ts ~350`、`service.ts ~300`、`index.ts ~300`。event-adapter 拆分后最大的 before-agent-start ~180。

- **G10 [D, watch]** prompts.ts 是最可能破 400 的文件。NFR #10 给 contextInjectionPrompt **新增 200-400 token** 的 completion audit 内容，#9 再加 plan 建议段落。370 + 两轮 prompt 膨胀后大概率触线。**非硬 gap（design 估算时点未破），列为 watch item**，建议 execution-plan 给 prompts.ts 设 400 LOC 预警。

**重构前（现状参考）**：event-adapter.ts **737 LOC**（当前最大上帝对象），#4 负责拆分；service.ts 700 LOC（#1/#2 删 action 后降至 ~300）；service.test.ts 999 LOC（测试，豁免）。

### 结构性耦合异味（非环、非上帝对象，但未 acknowledged）

- **G11 [D]** `ServicePorts` 聚合接口（PersistencePort/UiPort/MessagingPort/SessionPort 的组合）定义在 **service.ts:40**（消费方），而非 ports.ts（定义方）。§2 图把 ports 当纯叶子，但 ports.ts 只定义 4 个原子 port，聚合契约却散落在 service.ts。这不是环、不是超长文件，但是 design **未声明**的 cohesion 异味——port 聚合类型应归 ports.ts。属「应提但不阻塞」。

### 汇总：依赖健康 gap
- **G9 [D]** 依赖图漏画 `persistence → ports` 边。
- **G10 [D, watch]** prompts.ts 重构后 ~370 LOC，叠加 #10/#9 prompt 膨胀有破 400 风险。
- **G11 [D]** ServicePorts 聚合接口定义在消费方 service.ts 而非 ports.ts，design 未声明。

---

## 跨视角：隐含重构动作未被任何 issue 跟踪

追踪中发现 3 项**真实代码改动**，design 隐含要求但 issues.md 无对应条目：

| 隐含动作 | design 何处要求 | 谁应跟踪 | 现状 |
|---------|----------------|---------|------|
| **persistAndUpdate 从 event-adapter.ts:198 迁入 service.ts** | §1 目录树 + §3 service.ts 表 + §5 Deep Module | 无 issue（#4 拆 event-adapter 隐含，但 #4 验收只查「6 个 handler 文件 + event-adapter ≤60 LOC」） | **G5** |
| **createGoal 签名去掉 tasks 参数** | §3 service.ts createGoal「不含 tasks」+ 功能 1 时序图 | 无 issue（#1 删 task 模型隐含，#9 只改 __goalInit 外部签名） | 隐含于 #1，风险低 |
| **makeResult 等 8 处 state.tasks 引用迁移** | #1 删 GoalRuntimeState.tasks 的必然连带 | #1 验收清单未列 | **G2** |

**G5 [D]** 最需关注：#4 把 event-adapter 削成 ≤60 LOC 薄路由后，现在住在 event-adapter.ts:198 的 `persistAndUpdate`（含 tick + appendEntry + updateWidget + 将来的 budget 检查）必须迁出。若 #4 实现者只搬 handler、把 persistAndUpdate 留在 event-adapter.ts，则 §2 图的 `adapters → service` 方向被违反（persistAndUpdate 会在 adapter 层直接调 `pi.appendEntry`，绕过 service），且 G4 的落点决策无处安放。
**修复**：给 #4 验收清单加一条「persistAndUpdate 已迁入 service.ts（或其拆分产物），event-adapter.ts 不再持有 persist 逻辑」。

---

## Gap 清单（按优先级）

| ID | 类型 | 严重度 | 标题 | 所属视角 |
|----|------|--------|------|----------|
| **G4** | K | **阻塞** | budget 检查点落点（persistState vs persistAndUpdate）三文档矛盾，#5 验收不可判定 | 契约 + 调用链 |
| **G3** | F | 高 | complete 的 plan.md audit 无代码契约；spec FR 正文与 AC 自相矛盾 | 契约 |
| **G5** | D | 高 | persistAndUpdate 迁入 service.ts 无 issue 跟踪，#4 验收遗漏 | 依赖 + 调用链 |
| **G6** | K | 高 | 功能 3 时序图用 checkBudgetOnTurnEnd 做 terminal 判定，与契约冲突，易复活 race | 调用链 |
| **G7** | K | 中 | 功能 5 时序图把 timeStartedAt 重置归给 tickState，行为不符，resume 计时易错 | 调用链 |
| **G2** | F | 中 | service.ts makeResult 等 8 处 state.tasks 引用，#1 验收未覆盖迁移 | 契约 |
| **G1** | F | 中 | budget.ts 契约表漏 accumulateTokens / getTokenUsagePercent | 契约 |
| **G8** | F | 低 | 功能 2 时序图只画 4 个 AC-2 前置分支中的 2 个 | 调用链 |
| **G9** | D | 低 | 依赖图漏画 persistence → ports 边 | 依赖 |
| **G10** | D | 低(watch) | prompts.ts 重构后 ~370 LOC，#9/#10 膨胀有破 400 风险 | 依赖 |
| **G11** | D | 低 | ServicePorts 聚合接口定义在消费方 service.ts，design 未声明 | 依赖 |

**统计**：F=5, K=4, D=3（G10 计 D，watch）。阻塞级 1（G4），高严重度 3（G3/G5/G6）。

---

## 结论

code-architecture.md 整体结构清晰（分层、变化轴、Deep Module 论证到位），5 张时序图覆盖了 UC-1~UC-4 的主路径。但在 **budget 单一检查点**这条最关键的架构脊柱上存在三文档矛盾（G4），且该矛盾直接威胁 UC-3 调用链闭合。其次，complete 的 plan audit（G3）和 persistAndUpdate 迁移（G5）是两个「design 要求但无 issue 跟踪」的隐含动作，execution-plan 若照 issues.md 编排会漏掉。

**建议**：进入 execution-plan（Step 6）前，先闭环 G4（决策 persist 合并方案 + 修订 #5 验收），再补 G3（spec 二选一）、G5（#4 验收增条）。G1/G2/G6/G7/G8/G9 可在 execution-plan 编排时一并修补，不阻塞。
