# 执行计划追踪 — Round 1

追踪对象：`execution-plan.md`（Wave 编排初稿）
真相源：`execution-plan.md` > `code-architecture.md §6` > `issues.md` > 现状源码

## 追踪视角
- [x] 切片独立性
- [x] 依赖闭合
- [x] 并行安全

---

## 发现的 gap

### gap 1 [F] — Wave 1 #2 删字段后 typecheck 不可达，#2 文件影响清单严重不完整（最严重）

**问题描述**
execution-plan Wave 1 声明「每 Wave 完成后 typecheck 零错误」，并将 #1→#2 串行 confined 在 Wave 1。但 #2 删除 `GoalRuntimeState.stallCount` + `BudgetConfig.maxTurns/maxStallTurns` 字段后，这 3 个字段的**使用点**散布在 9 个文件中，全部编译失败。而这些使用点的删除被分到了 Wave 4 的 #6（删 handler 终态分支）。Wave 1（#1+#2）完成时、以及 Wave 2/3 期间，typecheck 不可能通过。

**证据（grep 现状使用点）**
#2 删字段后立即编译失败的文件：
- `adapters/event-adapter.ts:707` `state.stallCount >= state.budget.maxStallTurns`、`:702/:704` `state.stallCount++/重置`、`:646/:676` `state.budget.maxTurns`、`:575/:596/:640` `progress.maxTurnsReached`
- `adapters/command-adapter.ts:85` `${state.budget.maxTurns}`、`:335/:336` `budget.maxTurns/maxStallTurns 赋值`、`:87/:113/:277` `state.stallCount`
- `engine/budget.ts:51` `maxTurnsReached: boolean`（BudgetCheckResult 字段）、`:170` `state.currentTurnIndex >= state.budget.maxTurns`（计算）
- `persistence.ts:77` `stallCount: req("stallCount")`（反序列化）
- `projection/prompts.ts:148/:157/:261/:311` stallCount/maxTurns 显示
- `projection/widget.ts:74/:102/:103` maxTurns/stallCount 显示
- `commands.ts:62-71` `--max-turns`/`--max-stall-turns` 命令解析
- `constants.ts:26/:27` `MAX_TURNS_CAP`/`MAX_STALL_CAP`
- `index.ts:327-333` `BudgetInput` 类型含 maxTurns/maxStallTurns

而 execution-plan Wave 1 #2「文件影响」只列：`engine/types.ts` + `engine/goal.ts`。

**根因**
`stallCount`/`maxTurns`/`maxStallTurns` 是「字段定义（#2 范围，Wave 1）」+「使用点（#6 范围，Wave 4）」的横切关注点，被拆到两个相隔 3 个 Wave 的 issue。TS 是强类型，删字段必须同步删全部使用点，否则编译失败。这违反了「垂直切片独立可 typecheck」原则。

**建议修复（需决策）**
- 方案 A（推荐，长期）：把「stallCount/maxTurns/maxStallTurns 字段定义 + 全部使用点」作为一个原子改动整体下沉到 Wave 1 #2，#2 文件影响清单补齐上述 9 文件。#6 的「删 stallCount→blocked / maxTurns 分支」范围相应收窄为「删 handler 控制流分支」（字段已在 Wave 1 清掉，#6 只删 if 分支骨架）。代价：#2 改动面扩大，但符合 TS 类型约束现实。
- 方案 B（短期）：放弃 Wave 1 的「typecheck 零错误」约束，明确 Wave 1~3 处于「字段已删、使用点未清」的中间红区，#6（Wave 4）才收敛 typecheck。代价：违背 execution-plan 自己的硬约束，且 Wave 2/3 的 subagent 会在编译失败的红区工作，极易引入误改。

---

### gap 2 [F] — handleStallAndContinuation 等函数归属判断错误，制造 Wave 4 #6/#7 虚假并行冲突

**问题描述**
execution-plan Wave 4 将 #6∥#7 标为并行，冲突检测列写「无交集」。但 #6 文件影响写「event-handlers/before-agent-start.ts 或 turn-end.ts（handleStallAndContinuation）」，#7 文件影响写「event-handlers/before-agent-start.ts（组装 ProgressInput）」——两者都点名 before-agent-start.ts，自相矛盾。根因是 handleStallAndContinuation 的拆分归属判断错误。

**证据（调用链现状）**
`event-adapter.ts` 中：
- line 454 `await handleStallAndContinuation(...)` 位于 agent_end 主流程
- line 557 dispatcher「按 allTasksDone → noTasksCreated → maxTurnsReached 顺序」
- line 568/572/576 分别调用 handleAllTasksDone / handleNoTasksOrMaxTurns / handleMaxTurnsReached
- line 587/631/663/690 四个函数定义全部位于 agent_end 调用栈内

这 4 个函数从调用链看**全部属于 agent_end handler**。#4 拆分后应整体归入 `event-handlers/agent-end.ts`，而非 issues.md #6 / execution-plan Wave 4 #6 所写的「before-agent-start.ts 或 turn-end.ts」。

**影响**
- 若按调用链正确归属（agent-end.ts）：#6 只改 agent-end.ts，#7 改 before-agent-start.ts，**并行安全**。execution-plan 的「无交集」结论恰巧成立，但成立依据错误（应写 agent-end.ts 而非 before-agent-start.ts）。
- 若按 issues.md 字面（before-agent-start.ts）：#6 与 #7 同改 before-agent-start.ts，**并行冲突**，两个 subagent 互相覆盖。

**建议修复（D）**
明确 handleStallAndContinuation / handleAllTasksDone / handleNoTasksOrMaxTurns / handleMaxTurnsReached 在 #4 拆分后归 `agent-end.ts`。修正 execution-plan Wave 4 #6 文件影响为「仅 `agent-end.ts`」，#7 文件影响为「`before-agent-start.ts`（ProgressInput 组装）」，并行判定不变但依据修正。同步回填 issues.md #6 的文件归属。

---

### gap 3 [K] — Wave 1 验收 grep 范围与 issues.md #1 验收不一致，且 grep 不可达

**问题描述**
execution-plan Wave 1 验收标准写：
> `grep -rn "GoalTask\|goal_manager\|stallCount\|maxTurns" extensions/goal/src/` 无非注释输出

但 issues.md #1 验收只 grep `GoalTask|create_tasks|goal_manager`，**不含 stallCount|maxTurns**。stallCount/maxTurns 是 #2 的删除范围。

进一步：即便理解为「整个 Wave 1（#1+#2）完成后才 grep」，因 gap 1 所述——字段定义虽删但使用点还在（#6 Wave 4 才删）——grep 仍会命中 event-adapter.ts / command-adapter.ts / budget.ts / prompts.ts / widget.ts 等使用点，**验收不可达**。

**证据**
- execution-plan Wave 1 验收 grep 含 `stallCount|maxTurns`
- issues.md #1 验收 grep 不含
- grep 现状：maxTurns 在 event-adapter.ts/command-adapter.ts/budget.ts/prompts.ts/widget.ts 有 12+ 处使用点

**建议修复**
与 gap 1 联动。采用 gap 1 方案 A 后，Wave 1 末尾 stallCount/maxTurns 字段及使用点全部清除，grep 可达；此时 execution-plan Wave 1 验收 grep 成立。若采用 gap 1 方案 B，则必须同步放宽 Wave 1 验收 grep（移除 stallCount|maxTurns，留到 Wave 4 验收）。

---

### gap 4 [K] — #1 文件影响对 event-adapter.ts / projection/ 的改动描述不完整

**问题描述**
#1 验收要求 `grep "GoalTask\|goal_manager"` 无非注释输出，但 execution-plan Wave 1 #1「文件影响」对相关文件的改动描述明显不足以达成该验收。

**证据（遗漏的清理点）**
- `event-adapter.ts`：execution-plan 只写「删 3 处 goal_manager prompt 字符串」。实际还需清理：line 33 `import type { GoalTask }`、line 301 `task: GoalTask` 类型注解、line 182/447/667 等 `state.tasks` / `tasksCompletedAtAgentStart` 引用、line 613/618/653 等 goal_manager prompt（不止 3 处）。
- `projection/`：execution-plan 只写「删 tasks 渲染」。实际 prompts.ts 还有 goal_manager 引用（line 210/212/236/264/296）+ stallCount 显示（line 148）；widget.ts 有 GoalTask import（line 23）+ renderTaskRow/renderSubtaskLines（line 204/234）+ stallCount 显示（line 102-103）；result.ts 有 GoalTask（line 10/21）。
- `service.ts`：execution-plan 写「删 10 个 action 函数 + makeResult 等 ~8 处 tasks 引用」。实际 grep 显示 service.ts 有 93 处 tasks/GoalTask 引用，远超 ~8 处。
- `engine/budget.ts`：execution-plan #1 未列。实际 line 11 `import GoalTask`、line 162 `isTaskDoneFn: (task: GoalTask)` 需清理。

**影响**
subagent A 按 execution-plan「文件影响」清单执行 #1 时，会遗漏大量清理点，导致 typecheck 失败 + grep 验收失败。issues.md #1 方案 A 描述更完整（「更新 projection/ 中引用 tasks 的渲染逻辑」「service.ts 内所有 state.tasks 引用」），execution-plan 在转写时丢失了精度。

**建议修复**
以 issues.md #1 方案 A 为准，补全 execution-plan Wave 1 #1 文件影响清单：event-adapter.ts（GoalTask import + 所有 task/goal_manager 引用）、projection/ 全部 3 文件、engine/budget.ts、service.ts（标注实际引用量级 90+，非 ~8）。

---

### gap 5 [K] — code-architecture §6 与 execution-plan Wave 划分不一致，且 §6 含依赖错误

**问题描述**
两份文档的 Wave 划分不同，回溯时产生困惑；code-architecture §6 本身存在依赖编排错误。

**证据**
- code-architecture §6「喂给 Step 6 的 Wave 推导」：Wave 4 = #5+#6+#7+#8，Wave 5 = #9+#10
- execution-plan：Wave 4 = #6+#7，Wave 5 = #8+#5，Wave 6 = #10+#9
- code-architecture §6 把 #5（blocked_by #7）与 #7 同放 Wave 4，违反 issues.md #5 的 `blocked_by: #4, #7`——#5 依赖 #7，不能同 Wave 并行
- execution-plan 已修正（#7 Wave 4 / #5 Wave 5），但未注明与 code-architecture §6 的差异

**影响**
若有人回溯 code-architecture §6 验证 Wave 推导依据，会发现与 execution-plan 不符，且 §6 本身有依赖错误，造成信任混乱。

**建议修复**
- 回填 code-architecture §6，修正为 execution-plan 的 Wave 划分（#5 移至 Wave 5）
- 或在 execution-plan「依赖推导依据」表注明「本计划已修正 code-architecture §6 的 Wave 边界（#5 因 blocked_by #7 移至 Wave 5）」

---

### gap 6 [K] — #9 的 before-agent-start.ts 改动未列入 Wave 6 文件影响

**问题描述**
issues.md #9 方案 A 明确要改 `event-handlers/before-agent-start.ts`（contextInjectionPrompt 增加 plan 建议段落），但 execution-plan Wave 6 #9「文件影响」只列 `projection/prompts.ts` + `index.ts` + `extensions/plan/`。

**证据**
- issues.md #9 方案 A 改动第一条：「event-handlers/before-agent-start.ts: contextInjectionPrompt 增加 plan 建议段落」
- execution-plan Wave 6 #9 文件影响：未列 before-agent-start.ts

**影响**
不影响 Wave 编排正确性（Wave 6 在 Wave 4/5 之后，before-agent-start.ts 已被 #7/#6 改过且串行收敛）。但 subagent 执行 #9 时文件清单不完整，可能遗漏 plan 建议注入点的实现。

**建议修复**
execution-plan Wave 6 #9 文件影响补充 `event-handlers/before-agent-start.ts`（plan 建议段落注入点）。注意：若 plan 建议纯文字内嵌于 prompts.ts 的 contextInjectionPrompt，则 #9 只改 prompts.ts；若需在 handler 层判 plan 可用性，则改 before-agent-start.ts。需 #9 执行前澄清注入层级。

---

### gap 7 [K] — engine/budget.ts 的 maxTurnsReached 字段/计算删除无 issue 明确认领

**问题描述**
`engine/budget.ts:51` `maxTurnsReached: boolean`（BudgetCheckResult 字段）和 `:170` `maxTurnsReached: state.currentTurnIndex >= state.budget.maxTurns`（计算）在 #2 删 BudgetConfig.maxTurns 后编译失败，但没有 issue 明确把 budget.ts 的这部分清理纳入范围。

**证据**
- issues.md #2 范围：engine/types.ts + engine/goal.ts（不含 budget.ts）
- issues.md #6 范围：event-handlers（不含 engine/budget.ts）
- issues.md #8 范围：agent-end.ts（不含 budget.ts 的 maxTurnsReached 计算）
- 现状 budget.ts:170 直接读 `state.budget.maxTurns`

**影响**
与 gap 1 同源。#2 删 maxTurns 字段后 budget.ts 编译失败，但 budget.ts 不在任何 issue 的显式文件影响内。subagent 为过 typecheck 会顺手清理，但范围归属不清，易导致 #6/#8 验收时混淆「谁该删 budget.ts 的 maxTurnsReached」。

**建议修复**
明确 budget.ts 的 maxTurnsReached 字段/计算删除归 #6（作为「删 maxTurns 终态路径」的一部分，BudgetCheckResult 同步删 terminal/maxTurnsReached），或归 #2（作为删字段定义的配套）。在 issues.md #6 或 #2 补充 budget.ts 文件影响。采用 gap 1 方案 A 时，此清理自然落入 Wave 1。

---

## 无 gap 的视角（确认项）

### 切片独立性（已验证正确的点）
- Wave 2（#3∥#11∥#12）三条窄路径文件不交集成立：#3 新建 goal-control-adapter.ts + index.ts、#11 command-adapter.ts、#12 widget.ts。垂直切片，各自独立可验收。✓
- Wave 3（#4 单 issue）为有意 prefactor 决策，code-architecture §6 与 execution-plan 均明确其结构重构性质，非水平切片疏漏。✓
- Wave 5∥Wave 6 文件不交集成立：Wave 5 改 agent-end.ts/service.ts/command-adapter.ts，Wave 6 改 prompts.ts/index.ts/extensions/plan/。✓

### 依赖闭合（已验证正确的点）
- issues.md 全部 12 个 issue 的显式 blocked_by 均被 Wave 编排覆盖，逐条核验通过（#3←#1、#4←#2/#3、#5←#4/#7、#6←#4、#7←#1、#8←#4、#9←#7、#10←#7、#11←#2、#12←#2）。✓
- Wave 间 DAG 图（W1→W2→W3→W4，W4→W5，W4→W6）与调度表 Blocked by 列一致。✓
- execution-plan 对 #7 的隐性文件依赖（#3 创建 goal-control-adapter.ts、#4 拆出 before-agent-start.ts）已显式标注「依赖精度说明」，且 #3 Wave 2 / #4 Wave 3 均先于 #7 Wave 4。✓ 这是本计划依赖推导的亮点。

### 并行安全（已验证正确的点）
- Wave 2 三并行 issue 文件不交集成立。✓
- Wave 内部串行标注正确：Wave 1 #1→#2（同改 types.ts 的 GoalRuntimeState）、Wave 5 #8→#5（同改 agent-end.ts）、Wave 6 #10→#9（同改 prompts.ts，现状 365 LOC 接近阈值）均因同文件确实需串行。✓
- #5 blocked_by #7 被正确拆到不同 Wave（#7 Wave 4 / #5 Wave 5），未被错误并行。✓
- prompts.ts LOC 风险（Wave 6 #9/#10 串行后破 400）execution-plan 已设 Watch 并给出拆分预案。✓

---

## 优先级建议

| gap | 级别 | 阻塞 Wave 执行 | 建议 |
|-----|------|---------------|------|
| gap 1 | F | Wave 1 不可启动 | 必须先决策（方案 A 扩 #2 范围） |
| gap 2 | F | Wave 4 并行安全存疑 | 修正文件归属为 agent-end.ts |
| gap 3 | K | 随 gap 1 联动 | 同 gap 1 |
| gap 4 | K | Wave 1 subagent 易遗漏 | 补全 #1 文件影响清单 |
| gap 5 | K | 不阻塞，文档一致性 | 回填 code-architecture §6 |
| gap 6 | K | 不阻塞编排，影响 #9 执行 | 补 #9 文件影响 |
| gap 7 | K | 随 gap 1 联动 | 明确 budget.ts 归属 |

gap 1 是阻断性问题——不解决则 Wave 1 的「typecheck 零错误」验收不可达，整个 DAG 无法启动。建议优先就 gap 1 的方案 A/B 做决策。
