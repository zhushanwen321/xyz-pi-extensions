# 执行计划追踪 — Round 2（收敛复核）

追踪对象：`execution-plan.md`（含 D1/D2/D3 决策记录的修正稿）
真相源：`execution-plan.md` > `code-architecture.md §6` > `issues.md` > 现状源码
追踪方式：Round 1 的 7 个 gap 逐一核对 + 3 视角重新追踪 + 源码取证

## 收敛判定：未收敛（1 个新 K 级 gap）

- Round 1 的 **7 个 gap 全部已解决**（详见下节）
- 3 视角重新追踪发现 **1 个新 K 级 gap**（gap 8：#1 的 budget.ts 文件影响描述不完整）
- 无新 F 级（阻断）或 D 级（依赖）gap；Wave 编排结构、依赖闭合、并行安全均成立
- gap 8 不阻塞 Wave 启动（subagent 会为过 typecheck 自行扩展清理），属描述精度问题，与 Round 1 gap 4/6 同类

**结论**：计划已具备可执行性，修正 gap 8 后即可进入编码。

---

## Round 1 gap 解决验证

### gap 1（#2/#6 范围重新切分）— ✅ SOLVED
- 决策记录 **D1 存在**（execution-plan line 325「#2/#6 范围重新切分（gap 1 + gap 7）」）
- #2 收窄验证：Wave 1 #2 明确「**不删** BudgetConfig.maxTurns/maxStallTurns 和 GoalRuntimeState.stallCount」（line 88）；验收标准注明「**不含**『BudgetConfig 无 maxTurns』『GoalRuntimeState 无 stallCount』两条（移至 #6，见 D1）」（line 108）
- #6 接管验证：Wave 4 #6 文件影响含「`engine/types.ts`（删 BudgetConfig.maxTurns/maxStallTurns + GoalRuntimeState.stallCount）」（line 200）；验收含「BudgetConfig 无 maxTurns/maxStallTurns + GoalRuntimeState 无 stallCount + 12 文件使用点全清」（line 219）
- 切分使 Wave 1~3 typecheck 可达（字段保留 → 使用点不报错）

### gap 2（#6 文件归属 agent-end.ts）— ✅ SOLVED
- 决策记录 **D2 存在**（line 337「#6 文件归属修正（gap 2）」）
- Wave 4 #6 文件影响修正为「`event-handlers/agent-end.ts`（删 handleMaxTurnsReached/handleNoTasksOrMaxTurns/handleAllTasksDone 的 maxTurns 分支 + handleStallAndContinuation 的 stallCount→blocked，**4 函数归此文件**）」（line 200）
- #7 文件影响为 before-agent-start.ts，两者不交集（line 200 右列）

### gap 3（Wave 1 验收 grep 移除 stallCount|maxTurns）— ✅ SOLVED
- Wave 1 #2 验收 grep 现为：`grep -rn "GoalTask\|create_tasks\|update_tasks\|add_subtasks\|delete_subtasks\|goal_manager" extensions/goal/src/`（line 96）
- **已移除** stallCount|maxTurns（这两项的彻底 grep 验收移至 Wave 4 末尾，line 221）

### gap 4（#1 文件影响补全）— ✅ SOLVED（但 budget.ts 子项遗留 → 见 gap 8）
- service.ts：现写「删 10 个 action 函数 + **所有** state.tasks 引用（现状 ~90 处，全量清理非局部改动）」（line 82）— 量级已标注
- projection/ 3 文件：「`projection/prompts.ts` + `projection/widget.ts` + `projection/result.ts`」（line 86）— 已补全
- budget.ts：已列入（line 84），但描述范围过窄 → gap 8

### gap 5（code-architecture §6 差异）— ✅ SOLVED
- 决策记录 **D3 存在**（line 343「与 code-architecture §6 的 Wave 差异（gap 5）」）
- 明确「execution-plan 以本计划的 Wave 划分为准……code-architecture §6 作为『喂给 Step 6 的建议』被本计划优化，不回改上游」

### gap 6（#9 before-agent-start.ts）— ✅ SOLVED
- Wave 6 #9 文件影响现含「`event-handlers/before-agent-start.ts`: plan 可用性判定 + plan 建议注入点（若 handler 层判 plan 可用性；若纯 prompt 文字内嵌则只改 prompts.ts）」（line 285）
- 并附注入层级澄清（handler 层 vs 纯 prompt 内嵌）

### gap 7（budget.ts maxTurnsReached 归属）— ✅ SOLVED
- Wave 4 #6 文件影响含「`engine/budget.ts`（删 maxTurnsReached 字段+计算）」（line 200）
- 验收含「budget.ts maxTurnsReached 删除」（line 219）
- D1 决策明确「+ BudgetCheckResult.maxTurnsReached 字段 + engine/budget.ts 的 maxTurns 计算」（line 333）

---

## 新 gap

### gap 8 [K] — #1 的 budget.ts 文件影响描述不完整：checkProgress 函数体引用 state.tasks

**问题描述**
`engine/budget.ts` 的 `checkProgress` 函数（line 159-175）是 **#1（去 tasks）/ #6（去 maxTurns）/ #7（加 ProgressInput）三次演进的收敛点**。execution-plan Wave 1 #1 对 budget.ts 的清理描述仅写「删 `import GoalTask` + isTaskDoneFn 类型注解」，遗漏了 checkProgress 函数体内对 `state.tasks` 的 3 处引用 + `getCompletedCount` import。#1 删除 `GoalRuntimeState.tasks` 字段 + `GoalTask` 类型 + `engine/task.ts`（getCompletedCount 源）后，checkProgress 在 4 处编译失败，但计划未将函数体清理纳入 #1 范围。

**证据（budget.ts 现状，源码取证）**
```
11: import type { GoalTask } from "./task";
12: import { getCompletedCount } from "./task";
159: export function checkProgress(
160:   state: GoalRuntimeState,
161:   tasksCompletedAtStart: number,
162:   isTaskDoneFn: (task: GoalTask) => boolean,   ← GoalTask 类型（#1 已提及）
163: ): ProgressCheck {
164:   const incomplete = state.tasks.filter((t) => !isTaskDoneFn(t));   ← state.tasks（#1 未提及）
165:   const completedCount = getCompletedCount(state.tasks);             ← getCompletedCount + state.tasks（#1 未提及）
166:   const totalCount = state.tasks.length;                             ← state.tasks（#1 未提及）
170:   maxTurnsReached: state.currentTurnIndex >= state.budget.maxTurns,  ← #6 范围
171:   isStalled: completedCount - tasksCompletedAtStart === 0,
```

#1 删除 `state.tasks` 字段后，line 164/165/166 三处 `state.tasks.*` 引用立即编译失败；删除 `engine/task.ts` 后，line 12 `getCompletedCount` import + line 165 调用编译失败。execution-plan Wave 1 #1 budget.ts 条目（line 84）只覆盖 line 11 + line 162，**未覆盖 line 12 / 164 / 165 / 166**。

**影响**
- 不阻塞 Wave 启动：subagent 执行 #1 时会因 typecheck 失败自行扩展清理（移除 checkProgress 的 task 依赖，降级为只算非 task 字段）。验收「typecheck 零错误」倒逼正确执行。
- 但文件影响描述与实际清理量严重不符，且**未明确 checkProgress 在 #1 vs #7 间的职责边界**——#1 应把 checkProgress 降到什么形态（去 task 字段）、#7 再改成接收 ProgressInput，计划无指引，subagent 可能过度重构（撞 #7 范围）或不足（留 task 残骸）。
- 与 Round 1 gap 4 同类（文件影响不完整），是 gap 4 修复时对 budget.ts 探测不足的遗留——Round 1 只点了 line 11/162，未深入函数体。

**建议修复**
#1 budget.ts 文件影响改为：
> `engine/budget.ts`：删 `import GoalTask` + `import getCompletedCount`（task.ts 已删）+ `checkProgress` 函数体清理（移除 `state.tasks.filter`/`state.tasks.length`/`isTaskDoneFn` 参数/`tasksCompletedAtStart` 参数；checkProgress 降级为只返回非 task 字段 `maxTurnsReached`/`budgetTight`，task 相关字段 `allTasksDone`/`noTasksCreated`/`isStalled` 暂置默认值，待 #7 用 ProgressInput 重填）

并在 Wave 1 #1 注入上下文补一句：checkProgress 是 #1→#6→#7 三阶段演进函数，#1 只做「去 task 依赖」最小改动，#6 删 maxTurnsReached，#7 改签名接收 ProgressInput。

---

## 已验证视角

### 视角 1：切片独立性 — ✅ 成立（含 gap 8 注记）

| Wave | typecheck 可达性 | 依据 |
|------|----------------|------|
| 1（#1+#2）| 可达 | #1 清 tasks 全量引用（含 budget.ts checkProgress，需 gap 8 修正描述）；#2 只加 paused 不删字段（D1）→ stallCount/maxTurns 字段+使用点保留，编译通过 |
| 2（#3∥#11∥#12）| 可达 | 建立在 Wave 1 上，无字段删除 |
| 3（#4）| 可达 | 拆 event-adapter.ts，被搬移的函数仍引用 stallCount/maxTurns（字段保留）→ 编译通过 |
| 4（#6→#7）| 可达 | #6 同 Wave 内一次性删字段+12 文件使用点+控制流（D1 保证无中间红区）；#7 加 ProgressInput |
| 5/6 | 可达 | 建立在 Wave 4 上 |

**注**：gap 8 不影响 Wave 1 typecheck 可达性（subagent 会自行清理 checkProgress 函数体），只影响计划描述精度。

### 视角 2：依赖闭合 — ✅ 成立

- **Wave 4 #6→#7 串行依赖正确且为真实逻辑依赖**（非仅同文件避冲突）：源码取证确认 `checkProgress`（budget.ts:159）函数体内 line 170 `maxTurnsReached` 计算 —— #6 删此计算，#7 改 checkProgress 签名接收 ProgressInput，**两 issue 同改 checkProgress 一个函数**。串行 #6 先清（删 maxTurnsReached）→ #7 后扩（加 ProgressInput）是正确顺序。
- #7 隐性文件依赖（#3 创建 goal-control-adapter.ts、#4 拆出 before-agent-start.ts）已被 Wave 编排覆盖（#3 Wave 2 / #4 Wave 3 先于 #7 Wave 4），execution-plan line 202 有「依赖精度说明」显式标注。✓
- issues.md 全部 12 issue 的 blocked_by 均被 Wave 编排覆盖（Round 1 已逐条核验，本轮无变化）。✓
- 无遗漏的隐性文件依赖。

### 视角 3：并行安全 — ✅ 成立

- **Wave 2 #3∥#11∥#12 文件不交集成立**（源码取证）：
  - #3 新建 goal-control-adapter.ts + 改 index.ts（注册 goal_control）。**关键验证**：`finalizeAndPersist` 已存在于现状 service.ts（line 185），#3 的 complete/report_blocked 调用的是既有函数（finalizeAndPersist / persistState / transitionStatus），**不需修改 service.ts**。故 #3 只碰新文件 + index.ts。
  - #11 改 command-adapter.ts（handleSet 拒绝）
  - #12 改 projection/widget.ts（status suffix）
  - 三者文件集 {goal-control-adapter.ts, index.ts} ∩ {command-adapter.ts} ∩ {widget.ts} = ∅。✓
- **Wave 5 ∥ Wave 6 文件不交集成立**：
  - Wave 5：agent-end.ts / service.ts / command-adapter.ts
  - Wave 6：prompts.ts / before-agent-start.ts / index.ts / extensions/plan/
  - 交集 = ∅。✓（index.ts 虽在 Wave 2 被 #3 改、Wave 1 被 #1 改，但均为更早 Wave，串行不冲突）
- **Wave 4 串行后无遗漏的同文件并行**：
  - Wave 4 内 #6（agent-end.ts + budget.ts + 10 文件）与 #7（before-agent-start.ts + goal-control-adapter.ts + todo 扩展 + budget.ts）的唯一交集是 budget.ts（具体是 checkProgress 函数），已由 #6→#7 串行覆盖。✓
- Wave 内部串行标注均正确（Wave 1 #1→#2 同改 types.ts、Wave 5 #8→#5 同改 agent-end.ts、Wave 6 #10→#9 同改 prompts.ts）。✓

---

## 优先级建议

| gap | 级别 | 阻塞 Wave 执行 | 建议 |
|-----|------|---------------|------|
| gap 8 | K | 不阻塞（subagent 自行清理过 typecheck） | 修正 #1 budget.ts 文件影响描述，明确 checkProgress 三阶段演进职责 |

**总体**：7 个 Round 1 gap 全部解决，3 视角结构/依赖/并行均成立。仅剩 1 个 K 级描述精度 gap（gap 8）。计划已可执行；修正 gap 8 后描述与实际清理量对齐，subagent 不会再有 checkProgress 职责边界的歧义。建议主 agent 采纳 gap 8 修复后即进入编码，无需 Round 3。
