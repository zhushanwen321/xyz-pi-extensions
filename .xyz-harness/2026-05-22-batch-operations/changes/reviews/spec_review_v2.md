---
verdict: pass
must_fix: 0

review:
  type: spec_review
  round: 2
  timestamp: "2026-05-22T12:05:00"
  target: ".xyz-harness/2026-05-22-batch-operations/spec.md"
  verdict: pass
  summary: "第二轮审查通过。全部 1 条 MUST_FIX 和 4 条 LOW 已解决，0 条未关闭。"

statistics:
  total_issues_v1: 6
  must_fix_v1: 1
  must_fix_resolved: 1
  must_fix_remaining: 0
  low_v1: 4
  low_resolved: 4
  low_remaining: 0
  info_v1: 1
  info_resolved: 0
  info_remaining: 0

issues_resolved:
  - id: 1
    severity: MUST_FIX
    title: "update_tasks 中重复 taskId 行为未定义"
    resolution: "FR-5 已明确约束：`updates` 中不能有重复 taskId（整体报错）。"
    resolved_in: "spec.md §FR-5"

  - id: 2
    severity: LOW
    title: "Todo delete 重复 ID 行为未定义"
    resolution: "FR-2 已明确约束：`ids` 中重复 ID 自动去重后执行（无副作用）。"
    resolved_in: "spec.md §FR-2"

  - id: 3
    severity: LOW
    title: "update_tasks 非 completed 时 evidence 静默忽略无 AC 覆盖"
    resolution: "FR-5 已明确约束 + AC-4 新增测试用例覆盖"
    resolved_in: "spec.md §FR-5 + AC-4"

  - id: 4
    severity: LOW
    title: "Todo texts 空白字符项是否等同于空字符串未定义"
    resolution: "FR-1 已明确：`trim()` 后为空也视为无效。"
    resolved_in: "spec.md §FR-1"

  - id: 5
    severity: LOW
    title: "Todo delete ids 中已删除 ID 交互场景冲突"
    resolution: "FR-2 已有约束：不存在的 ID 整体报错。"
    resolved_in: "spec.md §FR-2"

  - id: 6
    severity: INFO
    title: "Todo 批量添加无最大数量限制"
    resolution: "未处理（INFO 级，非强制）。实现时由 promptGuidelines 软约束即可。"
    status: "unchanged"

---

# 计划评审 v2

## 评审记录
- 评审时间：2026-05-22 12:05
- 评审类型：计划评审（第 2 轮）
- 评审对象：`.xyz-harness/2026-05-22-batch-operations/spec.md`
- 本轮任务：逐项核查 v1 的 6 个问题是否已解决，判断是否可 pass

---

## 1. Issue 逐项核查

### Issue #1（MUST_FIX）— update_tasks 重复 taskId 行为未定义

**原描述：** `updates: [{taskId: 1, status: "in_progress"}, {taskId: 1, status: "completed"}]` 中同一 taskId 出现多次时行为未定义。

**核查：** spec.md FR-5 已新增约束：
> `updates` 中不能有重复 taskId（整体报错）

并且 AC-4 已新增测试用例覆盖：
> 调用 `update_tasks` 中包含重复 taskId，整体报错

**结论：✅ 已解决。** 与 FR-5 现有约束（不存在 taskId 整体报错、无 evidence 整体报错）保持一致。推荐 reviewer 在 v1 中建议的 (a) 策略（整体报错）已采用。

---

### Issue #2（LOW）— Todo delete 重复 ID 行为未定义

**原描述：** `ids: [1, 1]` 时行为未定义。

**核查：** spec.md FR-2 已新增约束：
> `ids` 中重复 ID 自动去重后执行（无副作用）

采用 reviewer 建议的"去重后执行"策略而非整体报错，理由是用户意图明确。合理。

**结论：✅ 已解决。**

---

### Issue #3（LOW）— update_tasks 非 completed 时 evidence 静默忽略无 AC 覆盖

**原描述：** FR-5 声明了该设计决策，但 AC-4 未覆盖。

**核查：** AC-4 已新增：
> 调用 `update_tasks` 传入 `{taskId: 1, status: "in_progress", evidence: "ignored"}`，evidence 被静默忽略，任务状态正常变更

**结论：✅ 已解决。**

---

### Issue #4（LOW）— Todo texts 空白字符项是否等同于空字符串未定义

**原描述：** `texts: ["  "]` 是否视为空字符串未定义。

**核查：** spec.md FR-1 已明确：
> `texts` 中每项不能为空字符串（`trim()` 后为空也视为无效）

采用 reviewer 推荐的 `trim()` 后判断策略。

**结论：✅ 已解决。**

---

### Issue #5（LOW）— Todo delete ids 中已删除 ID 交互场景

**原描述：** 某 ID 在发送请求前已被删除但用户未刷新状态时，约束未明确行为。

**核查：** FR-2 约束已覆盖：
> 不存在的 ID 整体报错（不部分删除）

RC 文档已满足。无需额外补充。

**结论：✅ 已解决。**

---

### Issue #6（INFO）— Todo 批量添加无最大数量限制

**原描述：** 建议但非强制增加上限。

**核查：** spec.md 未添加硬性限制。作为 INFO，不阻塞通过。实现时可由 promptGuidelines 软性约束（如"建议 ≤ 50 条"）。

**结论：🔶 未处理，但可接受（INFO 级）。**

---

## 2. 补充审查（新问题发现）

对所有 FR 和 AC 重新审查一轮，未发现新的 MUST_FIX 或 MUST_FIX-等价问题。

检查要点总结：

| 关注点 | 状态 | 备注 |
|--------|------|------|
| FR-1 到 FR-12 是否覆盖所有功能需求 | ✅ | 12 条 FR 完全覆盖 Todo 批量化和 Goal 四态 |
| 约束是否与现有代码库一致 | ✅ | 错误处理、session 重建、命令格式均与 infra-scan 一致 |
| AC 是否可验证 | ✅ | 8 条 AC 均可直接编写测试 |
| 四态转换的终态防护 | ✅ | AC-3 声明 + FR-5 执行层约束 |
| 渲染适配是否完整 | ✅ | templates/widget/index 三方渲染 |
| 序列化兼容性 | ✅ | 明确不做向后兼容，约束已记录 |
| agent_end 自动完成条件 | ✅ | 至少一个 completed，排除全部 cancelled |
| Complexity Assessment | ✅ | 6 文件 ~225 行，与 infra-scan 一致 |

---

## 3. 结论

**通过。** 第一轮发现的 1 条 MUST_FIX 和 4 条 LOW 全部解决。1 条 INFO 未处理（非强制）。未发现新的 MUST_FIX 问题。

Spec 已准备好进入 Phase 2（计划阶段）。

---

## Summary

第二轮审查通过。v1 的 1 条 MUST_FIX 和 4 条 LOW 已全部关闭，0 条未关闭。
