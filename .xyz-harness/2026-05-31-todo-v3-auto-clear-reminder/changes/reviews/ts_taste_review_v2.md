---
verdict: "pass"
must_fix: 0
reviewed_file: "todo/src/index.ts"
reviewer: taste-review-v2
date: "2026-05-31"
supersedes: "ts_taste_review_v1.md"
---

# TypeScript 品味审查 v2 — todo/src/index.ts (v3 变更)

## 审查范围

重新评估 v1 审查的 3 项 MUST FIX，结合代码实际和项目约束判断是否需要保持 fail 判定。

## v1 MUST FIX 重新评估

### M1. 模块级可变状态过多 → 降级为 LOW

**v1 论点**: 6 个模块级 `let` 变量缺乏封装，重置时容易遗漏。

**重新评估**:

1. **与既有模式一致**: `todos` 和 `nextId` 已经是模块级 `let`，CLAUDE.md 显式标记为已知违反。v3 新增 4 个变量沿用了同一模式，没有引入新的架构风格。
2. **重置路径完整**: `reconstructState`（L393-398）和 `clear` action（L363-368）都正确重置了各自职责范围内的所有变量。`add`/`update` action 也正确维护了 `allCompletedAtCount` 和 `lastTodoCallCount`。逐一检查所有重置路径，无遗漏。
3. **封装为 ReminderState 的收益有限**: 这不是公共 API 或跨团队模块，是 Pi 进程内的单文件扩展。`ReminderState` 封装在当前规模下增加的间接性（`reminder.userMessageCount` vs `userMessageCount`）换取的"防遗漏"收益，相比直接在 `reconstructState` 中罗列所有变量，没有本质区别。
4. **如果未来多 session 并发**: 那 `todos`/`nextId` 也要重构为闭包内状态，届时一次性全部重构，不如现在保持一致。

**结论**: 风格建议（SHOULD），非必须修复。

### M2. `before_agent_start` 事件处理器职责过重 → 降级为 LOW

**v1 论点**: 三个独立关注点平铺在一个函数里，互斥关系隐式，条件 2 触发时机疑似问题。

**重新评估**:

1. **函数体实际约 40 行**: 包含 try-catch 和 3 个注释分隔的分支。每个分支有明确的编号注释（`// 1. 自动清空`、`// 2. Verification Nudge`、`// 3. Todo Reminder`），可读性不差。
2. **优先级顺序有业务语义**: 自动清空 > 验证提示 > 遗忘提醒。这个顺序是 `return` 短路实现的，虽然隐式但符合直觉——先清空再提醒，不存在需要文档化的复杂互斥关系。
3. **条件 2 不是 bug**: `allCompletedAtCount !== null` 表示"全部完成但还没到自动清空的轮数"。在 `AUTO_CLEAR_DELAY_ROUNDS = 2` 期间（完成后的第 1-2 轮），条件 1 不触发（差值 < 2），条件 2 有机会触发——提醒用户在自动清空前补一个验证步骤。这是合理的业务设计。
4. **提取为命名函数的代价**: 三个 `check*` 函数需要共享模块级状态（`todos`、`allCompletedAtCount`、`lastTodoCallCount` 等），要么闭包要么传参。对于 3 个分支的优先级检查，提取后增加的代码量可能超过当前的平铺实现。
5. **`return undefined` 兜底**: 函数末尾的 `return undefined` 是冗余但无害的，可以去掉也可以保留。不构成 MUST FIX。

**结论**: 风格建议（SHOULD），非必须修复。

### M3. `lastReminderCount` 初始值约定不一致 → 降级为 INFO

**v1 论点**: `allCompletedAtCount` 用 `null` 表示"未触发"，`lastReminderCount` 用 `0` 表示"从未触发"，两种"未触发"用了不同表示法。

**重新评估**:

1. **语义不同，表示法不同是合理的**:
   - `allCompletedAtCount` 是"是否有过全部完成的时刻"，`null` = 没有。这是布尔语义的扩展。
   - `lastReminderCount` 是"上次提醒时的消息计数"，`0` = 从未提醒。差值 `userMessageCount - 0` 自然语义就是"从 session 开始算起的消息数"。
2. **注释已说明设计意图**: L226 注释 `// 均用 number（初始 0），与 userMessageCount 直接做差值比较` 明确解释了为什么用 `number` 而非 `null`。
3. **如果改为 `null`**: 差值比较需要 `(userMessageCount - (lastReminderCount ?? 0))`，多一层间接，且 `0` 作为初始值在数学上完全正确（差值 = 当前值 - 0 = 当前值）。

**结论**: 已有注释说明，设计意图明确。记录为 INFO。

## 维度评分（调整后）

| 维度 | v1 评分 | v2 评分 | 调整原因 |
|------|---------|---------|----------|
| 命名质量 | 7/10 | 7/10 | 无变化 |
| 代码结构 | 6/10 | 7/10 | before_agent_start 职责在 40 行内可控，非过度臃肿 |
| 类型使用 | 8/10 | 8/10 | 无变化 |
| 条件逻辑 | 5/10 | 7/10 | 三段优先级分支有注释、有业务语义，非混乱嵌套 |
| 一致性 | 7/10 | 8/10 | v3 遵循 v2 既有的模块级状态模式 |

## 保留的建议（不阻碍通过）

| 编号 | 级别 | 内容 | 说明 |
|------|------|------|------|
| L1 | LOW | 将 v3 追踪状态封装为 `ReminderState` 对象 | 风格改进，当前规模下非必要 |
| L2 | LOW | `before_agent_start` 三个检查提取为命名函数 | 40 行内可读性已足够 |
| S1 | SHOULD | `executeTodoAction` 的 `params` 类型与 `TodoParams` schema 同步 | v1 已提出，仍然有效 |
| S2 | SHOULD | 减少 `as` 类型断言 | S1 修复后可同步解决 |
| I1 | INFO | Unicode 转义降低源码可读性 | 构建工具副作用或源码编码问题 |
| I2 | INFO | `getDisplayStatus` 每次调用 `migrateTodo` | 概念冗余，无性能影响 |

## 总结

v1 的 3 项 MUST FIX 经重新评估，均属于风格偏好或已有合理设计意图的范畴：

1. **M1 状态散乱** → 与既有 `todos`/`nextId` 模式一致，重置路径完整，封装收益有限
2. **M2 职责混杂** → 40 行内三个带注释的优先级分支，条件 2 的触发时机是设计意图而非 bug
3. **M3 约定不一致** → 两种"未触发"有不同语义，注释已说明设计意图

代码通过品味审查。
