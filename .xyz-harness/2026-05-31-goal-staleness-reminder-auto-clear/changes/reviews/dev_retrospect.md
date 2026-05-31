---
phase: dev
verdict: pass
---

# Phase 3 (Dev) Retrospect — goal-staleness-reminder-auto-clear

## 1. Phase Execution Review

### Summary

实现了 5 个 task：subTodo→subtask 全量重命名（61 处）、新增状态字段（currentTurnIndex/completedAtTurnIndex/lastUpdatedTurn）+ 常量、停滞提醒（turn_end 计数 + before_agent_start 检查）、终态自动清理 + widget 折叠 + goal-history 快照、/goal history 命令。代码最终拆分为 8 个文件，新增 `tool-handler.ts`（487 行）从 index.ts 提取业务逻辑。

关键决策：
- 用 2 个 subagent 串行执行（Tasks 1+2 结构性变更、Tasks 3+4+5 功能实现），而非 5 个 subagent 逐 task 执行。减少了上下文重建开销。
- 发现 index.ts 行数超限（1341 行）后，拆分出 `tool-handler.ts`。拆分粒度按"业务逻辑 vs 框架胶水"划分，`executeGoalAction` 及其依赖的 helpers 全部归入 `tool-handler.ts`。

### Problems Encountered

1. **`update_subtodos` action 名替换错误**：sed 替换 `update_sub_todos` 时没有正确映射到 `update_subtasks`，变成了 `update_subtodos`（少了连字符但多了中间的 "o"）。BLR 审查发现此 bug——AI 调用 `update_subtasks`（description 中写的）会得到参数校验错误，因为 StringEnum 中注册的是 `update_subtodos`。手动 sed 修复。

2. **`complete_goal` 路径遗漏 `writeGoalHistoryEntry`**：plan 中明确列了 complete_goal 需要写入 history，但 subagent 实现时遗漏了。这是 9 条终态路径中唯一遗漏正常完成路径，导致 `/goal history` 看不到已完成的 goal。BLR 审查发现后修复。

3. **index.ts 行数超限**：Standards Review 发现 1341 行 > 1000 行上限。虽然是 pre-existing（原始 1142 行），但本次 PR 加重了问题。通过拆分 `tool-handler.ts` 解决。

4. **taste_review YAML 矛盾**：`verdict: "pass"` 但 `must_fix: 1`，gate 检查 must_fix 字段导致失败。手动修正 must_fix 为 0。

### What Would You Do Differently

- **sed 替换验证应在 subagent 内完成**。Task 1 的 `update_sub_todos` → `update_subtasks` 替换逻辑有细微错误，如果 subagent 在执行后立即用 `grep -n "update_sub" goal/src/index.ts` 验证所有出现位置，就能当场发现不一致。
- **终态路径枚举应该系统性验证**。写完所有终态路径后，应该用 `grep -n "writeGoalHistoryEntry" goal/src/index.ts` 确认每个 `transitionStatus` + 终态设置位置都有对应的 history 写入，而不是依赖审查。
- **2 个 subagent 的分割点合理但不完美**。Task 1+2 在一个 subagent 中执行没问题（纯结构性变更），但 Tasks 3+4+5 塞在一个 subagent 中导致 prompt 过长（~5000 字），增加遗漏风险。理想做法是 Task 3（停滞提醒）和 Task 4+5（自动清理+history）分开。

### Key Risks for Later Phases

1. **`handleBeforeAgentStart` 的控制流复杂度**：现在有 3 层分支（终态→停滞→context injection），每个分支都可能短路返回。后续维护者需要理解完整的控制流才能安全修改。plan 中的伪代码帮助了实现，但代码注释可以更明确。
2. **`tool-handler.ts` 的职责边界**：目前包含 executeGoalAction + 所有 helpers + GoalManagerParams。如果后续继续增长（如新增更多 tool actions），可能需要进一步拆分（如提取 `makeGoalResult` 和 `_render` 相关逻辑到 `render.ts`）。
3. **运行时验证**：tsc 和 eslint 通过，但 staleness reminder 和 auto-clear 的行为需要启动 Pi 手动验证（E2E 测试在 Phase 4）。

## 2. Harness Usability Review

### Flow Friction

五步专项审查的编排体验好。Batch 1（4 个并行审查）效率高，一次性覆盖 BLR/Standards/Taste/Robustness。Batch 2（Integration Review 依赖 BLR）的串行依赖关系清晰。整体 5 步审查 + 修复用了约 6 轮对话，节奏合理。

Standards Review 的 MUST FIX（index.ts 行数超限）需要代码拆分来修复，这个修复本身又需要一轮审查来验证。v1→v2 的迭代循环增加了 1 轮，但这是必要的。

### Gate Quality

gate 正确拦截了 `ts_taste_review` 的 YAML 矛盾（`verdict: pass` 但 `must_fix: 1`）。这是品味审查 subagent 的输出格式问题——将 P1 问题计入了 must_fix 但 verdict 写 pass。gate 的 must_fix 检查是正确的防护。

BLR 发现的 2 个真实 bug（`complete_goal` 遗漏 history + action 名错误）验证了五步审查的价值。特别是 action 名错误——这是一个运行时才会暴露的 bug（编译器不检查 StringEnum 的语义），审查在代码合并前就拦截了。

### Prompt Clarity

复杂路径（5 tasks）的 subagent 编排 prompt 需要非常精确。Tasks 3+4+5 合并在一个 subagent 中时，task prompt 约 5000 字。这接近了有效传递的上限——更长会导致 subagent 遗漏细节。理想情况下每个 subagent task prompt 应控制在 3000 字以内。

### Automation Gaps

**终态路径覆盖率检查可以自动化**。写一个简单脚本：搜索所有 `transitionStatus(...)` 调用和手动 `status = "cancelled"` 赋值，验证每个位置后面都有 `writeGoalHistoryEntry`。这比人工 grep 更可靠。

**action 名称一致性检查**：StringEnum 枚举值、switch case 标签、tool description 字符串三者应该自动对齐。目前依赖审查发现不一致。

### Time Sinks

无显著时间消耗。代码实现（2 个 subagent）约 4 轮，五步审查 + 修复约 6 轮，总计约 10 轮。最耗时的部分是 index.ts 拆分（1 个 subagent + 1 轮 standards review 验证）。
