# 统一审查汇总 — goal 扩展架构重写

**审查范围**：`git diff main...HEAD`（refactor-goal-extension 分支），66 文件 / +15237 / -2546
**审查日期**：2026-06-22
**审查维度**：5 个并行 subagent（业务逻辑 / Monorepo 影响 / 类型安全 / 扩展接口 / 测试覆盖）

## 各维度 verdict

| 维度 | verdict | MUST_FIX | SUGGESTION | INFO |
|------|---------|----------|------------|------|
| 业务逻辑 (business-logic) | ✅ pass | 0 | 3 | 4 |
| Monorepo 影响 (monorepo-impact) | ✅ pass | 0 | 2 | 2 |
| 类型安全 (type-safety) | ✅ pass | 0 | 3 | 4 |
| 扩展接口 (extension-api) | ❌ **fail** | **2** | 3 | 4 |
| 测试覆盖 (test-coverage) | ❌ **fail** | **1** | 6 | 1 |
| **合计** | — | **3** | **17** | **15** |

---

## MUST_FIX（3 项，按优先级）

### MF-1 🔴 deserializeState 严格模式破坏旧格式向后兼容
- **文件**：`extensions/goal/src/persistence.ts:38-94`
- **维度**：扩展接口（extension-api）
- **问题**：`deserializeState` 为"严格模式"——任何缺字段（含 `tokenWarning70Sent` 等 4 个新拆分 flag、`lastTurnTokensUsed`、`completedAtTurnIndex`）一律 `throw`。`reconstructGoalState`(session.ts:78-82) catch 后把 `state=null`，**导致升级前的旧 goal-state entry 被静默全丢**（用户重启后任务进度消失）。changeset 标 `minor` 且说"behavior-equivalent for happy path"，但这是面向用户的破坏性变更。
- **修复方向**：
  - (a) changeset 改 `major` 并在 README 注明升级需 reset；或
  - (b) 对缺失的非核心字段用 `?? false` / `?? 0` / `?? undefined` 兜底，仅 `goalId/objective/status/tasks/budget` 等核心字段缺失才 throw。
- **交叉确认**：类型安全 SUGGESTION-1 也指出同一处的 `as T` 断言无值类型校验，两者同源。

### MF-2 🔴 `__goalInit` ctx 参数从可选收紧为必填
- **文件**：`extensions/goal/src/index.ts:309-318` vs `extensions/coding-workflow/lib/tool-handlers.ts:504/528`
- **维度**：扩展接口（extension-api）
- **问题**：`__goalInit` 签名从 `(objective, tasks, budget?, ctx?) => boolean`（ctx 可选，省略走 `lastCtx` fallback）变为 **ctx 必填**（省略返回 false）。coding-workflow 当前已传 ctx，运行时不会崩，但 changeset 标 `pi-coding-workflow: patch` 声明"no runtime change"——签名契约收紧未如实声明。若未来有其他扩展省略 ctx 调用会静默失败。
- **修复方向**：
  - (a) 保留 ctx 可选签名维持向后兼容；或
  - (b) 省略 ctx 时 `throw new Error("__goalInit requires ctx")` 而非静默 `return false`。
  - 同时修正 changeset 措辞。

### MF-3 🔴 `projection/result.ts` 三个导出函数无测试且疑似死代码
- **文件**：`extensions/goal/src/projection/result.ts:42, 66, 81`
- **维度**：测试覆盖（test-coverage）
- **问题**：`makeGoalResult` / `errorResult` / `buildBudgetReport` 三个导出函数完全无测试，且经核查在生产代码中也未被调用（仅 `GoalManagerDetails` 类型被 index.ts 引用），属于导出的死代码。新文件无测试违反维度文档要求。
- **修复方向**：
  - 添加 `projection/__tests__/result.test.ts` 覆盖三个函数；或
  - 确认死代码后直接删除该文件（仅保留 `GoalManagerDetails` 类型，可下沉到 `ports.ts` 或 `engine/types.ts`）。

---

## SUGGESTION（17 项，按文件聚类 / 去重后）

### 架构 / 分层（3）

| # | 文件 | 描述 | 修复方向 |
|---|------|------|----------|
| S-1 | `service.ts:27` ↔ `projection/result.ts:13` | service↔projection type-only 循环：service value-import `projection/prompts`，result.ts 反向 type-import `ToolActionResult`。运行时无害但违反分层。 | 把 `ToolActionResult` 类型下沉到 `engine/types.ts` 或 `ports.ts`。 |
| S-2 | `index.ts:351` + 3 处消费者 | `GoalInitFn` 签名在 4 处重复（goal canonical + plan/coding-workflow inline alias），有 drift 风险。 | 补契约测试断言 inline alias 与 canonical 兼容，或抽到独立轻量 types 包。 |
| S-3 | `service.ts:236-539`（13 处） | `applyToolAction` 内 `params.tasks as string[]` 等 13 处断言无运行时校验。安全性依赖上游 schema，但函数是导出的，外部可绕过 schema 直接调。 | 改为非导出，或加 `GoalToolParams & Partial<Static<...>>` 联合签名。 |

### 预算 / 状态机逻辑（3）

| # | 文件 | 描述 | 修复方向 |
|---|------|------|----------|
| S-4 | `service.ts:230-258` | `actionCreateTasks` 替换任务列表时不重置 `tasksCompletedAtAgentStart` 基线（createGoal 会设 0，但此 action 绕过 createGoal）。1-turn 窗口 stall 检测可能误判。 | 成功替换后加 `session.tasksCompletedAtAgentStart = 0;`。 |
| S-5 | `service.ts:166-178` | `finalizeGoal` 不内部调 tickState，依赖调用方前置 tick（隐式契约）。 | 移入 finalizeGoal 开头（内部自洽），或强化 JSDoc 前置条件。 |
| S-6 | `budget.ts:112-115` | Token 终止需 `budgetLimitSteeringSent===true`（1-turn 宽限），time 维度无此门槛。不对称是有意的，确认设计意图。 | 可选加 `tokenPct>=1 && !steeringSent → steering` 显式化。 |

### 类型断言（3）

| # | 文件 | 描述 | 修复方向 |
|---|------|------|----------|
| S-7 | `persistence.ts:39-93` | deserialize 的 `as T` 断言无值类型校验（status 可能是非枚举字符串，tokensUsed 可能是 string）。与 MF-1 同源。 | 对 status 加 `TASK_STATUSES.includes(...)` 守卫，数值字段加 `typeof` 校验。 |
| S-8 | `projection/widget.ts:267-269` | `asTheme` 用 `as unknown as ThemeLike` 双重断言（UiPort 未声明 fg/bold，D-22 故意）。 | 导出 `UiPortWithTheme = UiPort & ThemeLike`，buildPorts 返回此类型，改单步 `as`。 |
| S-9 | `adapters/command-adapter.ts:50-65` | `handleGoalCommand` switch 无 `default` 分支，枚举扩展时无声漏过。 | 加 `default: return;` 或 `assertNever`。 |

### 测试覆盖（6 — 含 MF-3 已列）

| # | 文件 | 描述 | 修复方向 |
|---|------|------|----------|
| S-10 | `engine/task.ts:133,138,143` | `getNextTaskId`/`getCompletedCount`/`getIncompleteTasks` 无直接单测，仅间接覆盖。 | 补 engine task 边界测试。 |
| S-11 | `engine/budget.ts:72-83` | `tick` 的 `isRunning=true && timeStartedAt<=0` 分支未覆盖。 | 补 `tick(0, 100, 2000, true)` 测试。 |
| S-12 | `engine/budget.ts:116-119,133` | warning90 维度分支（token+steeringSent、time 90%）未覆盖。 | 补两个 warning90 触发场景。 |
| S-13 | `command-adapter.ts:174-210` | `handleHistory` 渲染分支（icon 切换、objective 截断、时长计算）完全未覆盖。 | 补 fake entries 渲染断言。 |
| S-14 | `command-adapter.ts:134-144` | `handleResume` 的 time-budget-exhausted 分支未覆盖。 | 补 time 超额场景。 |
| S-15 | `event-adapter.ts:98-186` | 4 个简单事件 handler 无 handler 级直接测试（ESC 早返回、updateWidget effect 等）。 | 补 event-adapter handler 级测试。 |

### 扩展接口（1，剩余）

| # | 文件 | 描述 | 修复方向 |
|---|------|------|----------|
| S-16 | `adapters/event-adapter.ts:418-462` | `handleAgentEnd` 的 `isProcessing` 重入早退依赖隐式不变量（finally 释放）。 | 加注释或收敛锁的 acquire/release 到 helper。 |

### details 契约（1）

| # | 文件 | 描述 | 修复方向 |
|---|------|------|----------|
| S-17 | `projection/result.ts:23-28` | `GoalManagerDetails` 删除旧版 `_render` 字段，新逻辑等价但属契约变更，changeset 未声明。 | changeset 补一句 details 形状变更说明。 |

---

## INFO（15 项，摘要）

- **类型安全 4**：`tool-adapter.ts:148` `color as never`（theme bridge）；`index.ts:309` `pi as unknown as Record`（Pi 框架限制）；`session.ts:75,107` inline cast；`service.ts:150-154` toDescriptions 断言。
- **业务逻辑 4**：time budget 无 grace turn（设计意图）；双口径 completedCount（设计意图）；message_end 结构断言；entry GC 索引自洽。
- **扩展接口 4**：peerDependencies 名称不符（pre-existing）；files 自包含 OK；before_agent_start 契约正确；tool schema 与 main 一致。
- **Monorepo 2**：peerDependencies 名称不符（pre-existing）；changeset 覆盖完整。
- **测试 1**：vitest 框架合规（372 tests pass，0 node:test）。

---

## tsc / 测试验证结果

- **tsc --noEmit**：✅ 0 errors（生产 tsconfig，strict: true，排除 __tests__）
- **vitest run**：✅ 372 tests pass / 13 files（338ms）
- **eslint**：本次审查未跑（type-safety 维度聚焦 tsc）

## 关键正面发现

1. **零 `any`**：生产代码全量搜索无任何 `: any` / `as any` / `Record<string, any>`。
2. **engine 层隔离**：engine/ 零 Pi 依赖，仅 `import type` 自内部。
3. **tick 回归保护扎实**：所有 9 处终态转换都在 transitionStatus 前调 tickState。
4. **状态机完备**：task 状态机合法 5 转换 + 非法 11 转换全覆盖；goal 终态守卫 7 态全矩阵。
5. **FR-6.2 维度独立预警**：4 个 flag 正确分离，token/time 不互吞。
6. **EventEffect discriminated union**：类型安全的 effect 分发。
7. **monorepo 结构健康**：依赖方向单向，无运行时循环依赖。

## 建议处理顺序

1. **先修 3 个 MUST_FIX**（MF-1 向后兼容 / MF-2 ctx 签名 / MF-3 死代码处理）——这些影响用户体验和契约正确性。
2. **再修 S-1/S-7**（deserialize 类型守卫 + 循环依赖）——与 MF-1 同源，一并处理成本最低。
3. **补测试 S-10~S-15**——提升关键路径信心。
4. **其余 SUGGESTION 按需处理**。
