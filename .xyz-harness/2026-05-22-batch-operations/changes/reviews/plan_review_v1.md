---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-23T11:30:00"
  target: ".xyz-harness/2026-05-22-batch-operations/plan.md"
  verdict: fail
  summary: "计划评审完成，第1轮，1条MUST FIX（deserializeState 策略不明确与 spec 冲突），1条LOW，2条INFO"

statistics:
  total_issues: 4
  must_fix: 1
  must_fix_resolved: 0
  low: 1
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md → BG1 Task 1 state.ts 设计细节"
    title: "deserializeState 实现策略不明确，filter out 策略与 spec FR-11 冲突"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: LOW
    location: "plan.md → BG2 Task 2 templates.ts 设计细节"
    title: "formatTaskList 中 pending/in_progress 图标排列顺序与 spec 不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: INFO
    location: "plan.md → BG1/BG2 跨模块依赖"
    title: "GOAL_TASK_STATUSES 常量跨 Task 导出/导入的协调风险"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: INFO
    location: "plan.md → 全局"
    title: "整体质量高，依赖图清晰，Execution Groups 设计合理"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-23 11:30
- 评审类型：计划评审
- 评审对象：
  - `.xyz-harness/2026-05-22-batch-operations/spec.md` (v1, 98 lines)
  - `.xyz-harness/2026-05-22-batch-operations/plan.md` (v1, ~600 lines)

---

## 1. Spec 完整性

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 目标明确 | ✅ | 一句话说清：todo/goal_manager 批量接口 + GoalTask 四态升级 |
| 范围合理 | ✅ | 边界清晰，Constraints 章节明确列出 6 项「不改」范围 |
| 验收标准可量化 | ✅ | 8 个 AC 全部可测试验证（具体断言条件） |
| 无[待决议]项 | ✅ | 0 项待决议，定义明确 |

**结论：Spec 完整性高，无问题。**

---

## 2. Plan 可行性

### 2.1 Task 拆分粒度

| Task | 文件数 | 改动量(预估) | 粒度评估 |
|------|--------|------------|---------|
| Task 1 — Goal 类型层 | 2 (state.ts, budget.ts) | ~45 行 | ✅ 适中 |
| Task 2 — Goal 逻辑+渲染层 | 3 (index.ts, templates.ts, widget.ts) | ~130 行 | ✅ 适中，但已是上限 |
| Task 3 — Todo 批量化 | 1 (todo/src/index.ts) | ~50 行 | ✅ 适中 |

每个 Task 可由一个 subagent 独立完成，粒度合理。

### 2.2 依赖关系

```
Task 1 (类型层) ──依赖──→ Task 2 (渲染层)
Task 3 (Todo)              ← 无依赖
```

✅ 正确。Task 2 需要 Task 1 的新类型和辅助函数已就位。

### 2.3 工作量估算

计划估算约 225 行总改动，分布在 6 个文件。对照 spec 复杂度评估（中等），估算现实。

### 2.4 Spec 覆盖度（12 个 FR 逐条对照）

| FR | 描述 | 覆盖 Task | 状态 |
|----|------|-----------|------|
| FR-1 | Todo 批量添加 | Task 3 | ✅ |
| FR-2 | Todo 批量删除 | Task 3 | ✅ |
| FR-3 | Todo update 保持单条 | Task 3 | ✅ |
| FR-4 | GoalTask 四态模型 | Task 1 | ✅ |
| FR-5 | Goal update_tasks action | Task 2 | ✅ |
| FR-6 | Goal complete_goal 逻辑调整 | Task 1, Task 2 | ✅ |
| FR-7 | Goal 辅助函数适配 | Task 1 | ✅ |
| FR-8 | Goal 模板和渲染适配 | Task 2 | ✅ |
| FR-9 | Goal promptGuidelines 更新 | Task 2 | ✅ |
| FR-10 | Goal agent_end 自动完成逻辑 | Task 1 (budget.ts), Task 2 (handleAgentEnd) | ✅ |
| FR-11 | Goal state 序列化/反序列化 | Task 1 | ⚠️ 见 MUST FIX 1 |
| FR-12 | Todo renderCall/renderResult 适配 | Task 3 | ✅ |

---

## 3. Spec-Plan 一致性

### 3.1 FR 覆盖完整性

全部 12 个 FR 有对应 Task。FR-10 在两个 Task 中分别处理（budget.ts 的 `allTasksDone` 在 Task 1，index.ts 的 `handleAgentEnd` 在 Task 2），设计合理——两个不同入口各自独立验证相同约束。

### 3.2 AC 覆盖完整性（Spec Metrics Traceability）

| AC | 描述 | 覆盖 Task | 状态 |
|----|------|-----------|------|
| AC-1 | Todo 批量添加 | Task 3 | ✅ |
| AC-2 | Todo 批量删除 | Task 3 | ✅ |
| AC-3 | GoalTask 四态 | Task 1 (类型), Task 2 (行为) | ✅ |
| AC-4 | Goal update_tasks | Task 2 | ✅ |
| AC-5 | Goal complete_goal 适配 | Task 2 (traceability 表), 实际 Task 1 budget.ts 也有贡献 | ⚠️ traceability 表只写 "Task 2"，但 Task 1 的 budget.ts 中 allTasksDone 也对 "complete_goal 适配" 有贡献。更新 traceability 表为 "Task 1, Task 2" 更准确。 |
| AC-6 | 渲染验证 | Task 2, Task 3 | ✅ |
| AC-7 | 类型检查通过 | 所有 Task | ✅ |
| AC-8 | ESLint 通过 | 所有 Task | ✅ |

### 3.3 额外工作

无 spec 未提及的额外工作。

---

## 4. Execution Groups 合理性

### 4.1 分组检查

| 检查组 | 文件数 | Task 数 | 类型 | 功能关联度 | 依赖 | 状态 |
|--------|--------|---------|------|-----------|------|------|
| BG1 | 2 (state.ts, budget.ts) | 1 | 类型层 | ✅ 强关联 | 无 | ✅ |
| BG2 | 3 (index.ts, templates.ts, widget.ts) | 1 | 逻辑+渲染层 | ✅ 强关联 | BG1 | ✅ |
| BG3 | 1 (todo/src/index.ts) | 1 | 功能层 | ✅ 单一 | 无 | ✅ |

- **文件数**：BG2 的 3 个文件 ≤ 10 ✅，BG1 的 2 个 ≤ 10 ✅，BG3 的 1 个 ≤ 10 ✅
- **Task 数**：每 Group 1 个 Task ≤ 4 ✅
- **类型划分**：BG1/BG2 处理 Goal 扩展，BG3 处理 Todo 扩展，无混合类型 ✅
- **功能关联度**：同组内 Task 关联紧密 ✅

### 4.2 Wave 编排

| Wave | Groups | 说明 | 可行性 |
|------|--------|------|--------|
| Wave 1 | BG1, BG3 | 并行，无文件冲突，无数据竞争 | ✅ |
| Wave 2 | BG2 | 依赖 BG1 完成，单 Group 执行 | ✅ |

### 4.3 Subagent 配置完整性

| 检查组 | Agent | Model | 注入上下文 | 读取文件 | 修改文件 | 状态 |
|--------|-------|-------|-----------|---------|---------|------|
| BG1 | general-purpose | medium | FR-4,6,7,10,11 + CONSTRAINTS | state.ts, budget.ts | state.ts, budget.ts | ✅ |
| BG2 | general-purpose | high | FR-5,8,9,10,12 + 全部 AC | 4 个文件 | 3 个文件 | ✅ |
| BG3 | general-purpose | medium | FR-1,2,3,12 + AC-1,2 | todo/src/index.ts | todo/src/index.ts | ✅ |

BG2 的 model 标注为 "high"，合理——涉及 schema 变更 + execute handler + 三文件渲染适配，是三个 Group 中最复杂的。

---

## 5. 发现问题

### MUST FIX 1: deserializeState 实现策略不明确，与 spec 冲突

**位置**：`plan.md` → BG1 Task 1 state.ts 设计细节第 5 条

**问题描述**：
Plan 在 Task 1 的 state.ts 设计细节中列出了**两种** deserializeState 实现策略：
1. "tasks 映射时检查 `status` 字段是否存在，不存在则视为无活跃 goal（整个 state 返回 null 抛出或返回空）"
2. "如果某个 task 没有 `status` 字段，则该 task 被跳过（filtered out）"

策略 1 与 spec FR-11 一致（不做向后兼容，旧格式视为无活跃 goal）。但策略 2 与 spec FR-11 冲突——filter out 单个 task 意味着如果 entry 中部分 task 有 `status`、部分没有，entry 被部分接受。spec 要求的是整个 entry 不被识别。

**修改方向**：删除策略 2（filter out），统一使用策略 1——旧格式 entry 整体视为无活跃 goal。具体实现：如果任何一个 task 缺失 `status` 字段，整个 deserialize 返回 `null`，session 视为无活跃 goal。

---

### LOW 1: formatTaskList 中 pending/in_progress 图标排列顺序与 spec 不一致

**位置**：`plan.md` → BG2 Task 2 templates.ts 设计细节

**问题描述**：
Spec AC-6 定义 `formatTaskList` 的 in_progress+pending 组的图标顺序为 `●/☐`（in_progress(●) 在前，pending(☐) 在后）。但 plan 写的是 `☐/●`（pending 在前）。

两者最终实现时会使用同一组常量，不存在功能影响，但 spec 与 plan 在细节上不一致说明 plan 没有完全同步 spec 的内容。

**修改方向**：将 plan 中的 `「in_progress+pending（☐/●）」` 改为 `「in_progress+pending（●/☐）」` 以匹配 spec。

---

### INFO 1: GOAL_TASK_STATUSES 常量跨 Task 导出/导入的协调风险

**位置**：`plan.md` → BG1 Task 1 与 BG2 Task 2 的跨模块依赖

**描述**：
Plan 将 `GOAL_TASK_STATUSES` 常量定义在 `state.ts`（Task 1），而在 `index.ts`（Task 2）中 import 使用。Task 1 和 Task 2 属于不同 Group（BG1 和 BG2），Task 2 在 Wave 2 执行。这意味着 Task 2 的 schema 定义依赖于 Task 1 的导出接口。依赖关系按 Wave 编排是正确的，但此约束需要在 BG1/BG2 的 subagent 配置中明确传递：

- BG1 subagent 需知道 `state.ts` 必须 export `GOAL_TASK_STATUSES` 常量
- BG2 subagent 需知道应从 `state.ts` import `GOAL_TASK_STATUSES`

当前 BG2 的"注入上下文"中未显式说明从 state.ts import 常量的约定，仅说"读取 goal/src/state.ts"。考虑到 subagent 的上下文隔离性质，建议在 BG2 的注入上下文中明确提到：`GOAL_TASK_STATUSES` 常量由 BG1 在 state.ts 中定义导出，BG2 需从 state.ts import 该常量以用作 schema 定义。

风险较低（executor 自然会读 state.ts 看到导出），记录为 INFO。

---

### INFO 2: 整体质量高，依赖图清晰

**描述**：
- Wave 1 的 BG1 + BG3 无依赖可并行，BG2 依赖 BG1，整体 DAG 简洁
- 每个 Group 内部 Subagent 配置完整（Agent、Model、文件清单、注入上下文均有）
- 每个 Task 有具体的变更清单和 Step 列表，执行者有明确指引
- AC-5 的 traceability 表标注为 "Task 2" 稍显不完全（Task 1 budget.ts 也有贡献），但不影响执行

---

## 6. L1 后端检查

由于本项目的"后端"本质是 Pi 扩展的逻辑层，L1 检查清单适配如下：

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 实现原因说明 | ✅ | Plan 对四态迁移的"为什么"（二元标记不足）、批量化的"为什么"（减少 LLM 调用轮次）均清楚说明 |
| 存储变更选型 | ✅ | 沿用 sessionManager.appendEntry + getEntries 机制，仅字段格式变更 |
| 边界条件与异常处理 | ✅ | 空数组、重复 ID、不存在 ID、终端状态不可变、evidence 校验已覆盖 |
| 非功能性要求 | ✅ | TypeScript 类型检查 + ESLint 在 Final Verification 中验证 |

---

## 结论

**需修改后重审。** 1 条 MUST FIX（deserializeState 策略歧义）必须在进入执行阶段前解决。修复后重审将验证 MUST FIX 的修复情况。

---

## Summary

计划评审完成，第1轮，1条MUST FIX，需修改后重审。
