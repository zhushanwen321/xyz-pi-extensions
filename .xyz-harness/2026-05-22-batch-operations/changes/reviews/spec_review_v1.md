---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-22T12:00:00"
  target: ".xyz-harness/2026-05-22-batch-operations/spec.md"
  verdict: fail
  summary: "计划评审完成，第1轮，1条MUST FIX，4条LOW，1条INFO"

statistics:
  total_issues: 6
  must_fix: 1
  must_fix_resolved: 0
  low: 4
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-5 §update_tasks 参数"
    title: "update_tasks 的 updates 数组中同一 taskId 出现多次时行为未定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: LOW
    location: "spec.md:FR-2 §Todo 批量删除"
    title: "Todo delete 传入重复 ID（如 ids: [1, 1]）时行为未定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "spec.md:FR-5 §evidence 约束"
    title: "update_tasks 中 status !== completed 时 evidence 静默忽略无 AC 覆盖"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "spec.md:FR-1 §texts 约束"
    title: "Todo texts 中仅含空白字符的项（如 [\"  \"]）是否视为空字符串未定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "spec.md:FR-2 §ids 约束"
    title: "Todo delete 的 ids 数组中 taskId 不存在于当前 todos 但已删除后逻辑冲突"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: INFO
    location: "spec.md:FR-1 §texts 数量"
    title: "Todo 批量添加无最大数量限制"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-22 12:00
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-22-batch-operations/spec.md`
- 参考文件：
  - `changes/infrastructure-scan.md`
  - `CLAUDE.md`

## 0. 总体评价

Spec 整体质量高，12 个 FR 完整覆盖了需求域，8 个 AC 基本可量化执行。
架构约束（不改错误处理模式、不做向后兼容、不改 `/todos` 命令）清晰，与现有代码库一致。
主要问题集中在**批量操作中冲突场景未定义**——特别是 `update_tasks` 的 `updates` 数组中同一 taskId 出现多次的行为，属于设计空白，标为 MUST FIX。

---

## 1. Spec 完整性

### 1.1 目标明确性 ✅
目标「Todo & GoalManager 工具接口批量化和状态升级」一段话说清，无歧义。

### 1.2 范围合理性 ✅
范围边界清晰：
- Todo：只改 add 和 delete 为批量，update 保持单条（FR-3）
- Goal：Task 四态（FR-4）、complete_task → update_tasks（FR-5）、complete_goal 适配（FR-6）
- 不改 `/goal` 命令解析、不改 `/todos` 命令、不改 session 重建模式（Constraints）

### 1.3 验收标准可量化 ✅
所有 8 个 AC 均可直接编写测试验证，无模糊描述。

### 1.4 `[待决议]` 项
无。✅

---

## 2. Spec 与现有代码库的一致性

### 2.1 Todo 架构约束 ✅
| FR | 代码现状 | 一致性 |
|----|---------|--------|
| FR-1 add: text → texts[] | `TodoParams` 当前 `text: Type.Optional(Type.String())` | 匹配 |
| FR-2 delete: id → ids[] | `TodoParams` 当前 `id: Type.Optional(Type.Number())` | 匹配 |
| FR-3 update 保持单条 | `id: number`, `status: string` 不变 | 匹配 |
| 错误处理 | Todo 当前用 error-success pattern（`details.error`） | Spec Constraints 明确保持，匹配 |
| state 重建 | Todo 从 toolResult details 重建 | Constraints 说"不改 session 重建模式"，匹配 |

### 2.2 Goal 架构约束 ✅
| FR | 代码现状 | 一致性 |
|----|---------|--------|
| FR-4 GoalTask 四态 | `state.ts` 中 `completed: boolean` | 需要改类型定义 + 辅助函数，匹配 |
| FR-5 complete_task → update_tasks | `index.ts` 7-action switch 包含 `complete_task` | 匹配 |
| FR-6 complete_goal 逻辑 | `index.ts` 中 `checkProgress` + `complete_goal` handler | 匹配 |
| FR-9 promptGuidelines | `index.ts` 中 10 条 guideline 包含 complete_task | 匹配 |
| FR-10 agent_end 自动完成 | `index.ts` `handleAgentEnd` 中 `allTasksDone` 检查 | 匹配 |
| FR-11 序列化 | `state.ts` `serializeState` / `deserializeState` | 明确不做向后兼容，匹配 |
| 错误处理 | Goal 用 `throw new Error()` | Spec Constraints 保持，匹配 |

### 2.3 文件变更覆盖度 ✅
Spec Complexity Assessment 列出 6 个文件，对照 infrastructure-scan 的 "Key Files to Modify" 完全匹配：

| Spec 所列文件 | Infrastructure 对应 | 变更量估计 |
|--------------|-------------------|-----------|
| todo/src/index.ts | ~50 行 | 合理 |
| goal/src/state.ts | ~30 行 | 合理 |
| goal/src/index.ts | ~80 行 | 合理 |
| goal/src/templates.ts | ~30 行 | 合理 |
| goal/src/widget.ts | ~20 行 | 合理 |
| goal/src/budget.ts | ~15 行 | 合理 |
| 总计 | ~225 行 | 合理 |

### 2.4 枚举值覆盖逐项检查

| 枚举 | 定义位置 | AC 覆盖 | 状态 |
|------|---------|---------|------|
| `GoalTask.status` 四态 | FR-4 | AC-3 覆盖四态转换 + 终态防护 | ✅ 部分覆盖（见 Issue #1） |
| `todo action` 五态 | 未改 | 不变 | ✅ |
| `goal_manager action` 新增 `update_tasks` | FR-5 | AC-4 | ✅ |
| `updates[].status` 四态 | FR-5 | AC-4 部分覆盖 | ❗ 见 Issue #1/#3 |

---

## 3. 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | **MUST FIX** | spec.md:FR-5 §update_tasks 参数 | **update_tasks 的 `updates` 数组中同一 taskId 出现多次时行为未定义。** 例如 `updates: [{taskId: 1, status: "in_progress"}, {taskId: 1, status: "completed"}]` 是整体报错（冲突）、只取最后一条、还是按顺序处理？如果实现依赖实现者直觉，可能出现不可预期状态 | 在 FR-5 中明确规则：选择一种策略——(a) 整体报错（提前检测重复 taskId），(b) 按位置最后一条胜出，(c) 按位置顺序执行（最后一条生效）。建议 (a) 整体报错，与 FR-5 现有约束（不存在的 taskId 整体报错、无 evidence 整体报错）一致 |
| 2 | LOW | spec.md:FR-2 §Todo 批量删除 | **`delete` 传入重复 ID（如 `ids: [1, 1]`）行为未定义。** 如果先删了 ID 1，再删 ID 1 时 ID 已不存在，可能触发"不存在的 ID 整体报错"规则回滚第一次删除。实际效果取决于实现细节 | 在 FR-2 中补充：重复 ID 是直接去重后执行（无副作用），还是整体报错。建议去重后执行（用户意图明确，删除 ID 1 一次即可） |
| 3 | LOW | spec.md:FR-5 §evidence 约束 | **`status !== "completed"` 时 evidence 静默忽略的场景无 AC 覆盖。** 这是一个显式设计决策，但无测试验证意味着该行为可能意外变更 | 在 AC-4 中增加一条："调用 `update_tasks` 传入 `{taskId: 1, status: "in_progress", evidence: "some reason"}`，evidence 被静默忽略，任务状态正常变为 in_progress" |
| 4 | LOW | spec.md:FR-1 §texts 约束 | **Todo `texts` 中仅含空白字符的项（如 `["  "]`）是否视为空字符串未定义。** FR-1 约束说"每项不能为空字符串"，但 `"  "` 在语义上是否等同于空？两者含义不同 | 在 FR-1 中补充：建议 `trim()` 后判断是否为空，或明确 `"  "` 视为有效文本。推荐前者 |
| 5 | LOW | spec.md:FR-2 §ids 约束 | **delete 的 ids 与当前 todos 集合的交互细节不完整。** 如果某个 ID 在发送请求前已被前一次操作删除，但用户未刷新状态，`ids` 中包含该 ID 会触发整体报错——这是合理的，但 RC 应意识到这一点 | 可选：在 FR-2 中添加一条备注说明此场景的行为（整体报错） |
| 6 | INFO | spec.md:FR-1 §texts 数量 | **Todo 批量添加无最大数量限制。** 理论上可发送 1000 项 todo，超出合理边界 | 建议但非强制：可加软性建议限制（如 ≤ 50 条），突出显示在 promptGuidelines 中 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程。
> - **LOW**：建议修复，但不阻塞。
> - **INFO**：观察记录，无需操作。

---

## 4. 综合评估

### 优势
- 需求描述精准，FR 与 AC 对应关系清晰
- 所有架构约束（错误模式、session 重建、命令不变）与现有代码库完全一致
- 变更范围控制良好，不走假设性扩展
- Complexity Assessment 的工作量估算与 infrastructure-scan 代码分析高度吻合

### 风险
- **核心风险**（MUST FIX）：`update_tasks` 的 `updates` 数组未定义冲突处理策略。批量操作中，冲突检测是基本保底设计。
- **次要风险**（LOW）：部分边界情况（空白字符串、重复 ID）未定义，虽不影响主线功能，但会导致实现时隐含假设，后续测试再发现时需要额外轮次修复。

### AC 覆盖矩阵（按 reviewer 方法论要求产出）

| AC | 场景 | 覆盖状态 | 备注 |
|----|------|---------|------|
| AC-1 | Todo 批量添加（正常/空数组/单条等价） | ✅ | 覆盖全面 |
| AC-1 | Todo texts 含空白字符项 | ❌ | Issue #4 |
| AC-2 | Todo 批量删除（多个ID/不存在/单条等价） | ✅ | 覆盖全面 |
| AC-2 | Todo delete 重复 ID | ❌ | Issue #2 |
| AC-3 | GoalTask 四态转换（pending→in_progress→completed/cancelled） | ✅ | 覆盖全面 |
| AC-3 | 终态防护（completed/cancelled 不可变更） | ✅ | AC-3 明确声明 |
| AC-4 | update_tasks 多条更新（正常/无evidence/不存在ID/空数组） | ✅ | 覆盖全面 |
| AC-4 | update_tasks 同一 taskId 重复 | ❌ | Issue #1 |
| AC-4 | update_tasks 非 completed 下 evidence 被忽略 | ❌ | Issue #3 |
| AC-5 | complete_goal 各组合（completed+cancelled/completed+pending/全cancelled） | ✅ | 覆盖全面 |
| AC-6 | 渲染验证（三组输出/renderCall/widget） | ✅ | 覆盖全面 |
| AC-7 | 类型检查 | ✅ | 全覆盖（构建验证） |
| AC-8 | ESLint | ✅ | 全覆盖（构建验证） |

---

## 5. 结论

**需修改后重审。** 1 条 MUST FIX（`update_tasks` 重复 taskId 行为未定义），4 条 LOW 建议项。

Issue #1 的修复直接影响实现安全性——没有冲突检测策略，LLM 可能发送冲突的 updates 数组（同一 task 先 in_progress 再 completed 再 cancelled），实现者的不同选择会导致不同的运行时行为。

---

## Summary

计划评审完成，第1轮，1条MUST FIX，需修改后重审。
