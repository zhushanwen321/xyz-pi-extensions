---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-31T13:55:00"
  target: ".xyz-harness/2026-05-31-todo-v3-auto-clear-reminder/spec.md"
  verdict: pass
  summary: "Spec 评审完成，第1轮，0条MUST FIX，3条LOW建议，可进入实现阶段"

statistics:
  total_issues: 3
  must_fix: 0
  low: 3
  info: 0

issues:
  - id: 1
    severity: LOW
    location: "spec.md:事件监听"
    title: "agent_start 事件的 userMessageCount 语义需明确"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: LOW
    location: "spec.md:自动清空"
    title: "自动清空后是否需要通知用户"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "spec.md:Verification Nudge"
    title: "中文关键词 '验证' 的匹配范围可能过宽"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v1

## 评审记录
- 评审时间：2026-05-31 13:55
- 评审类型：计划评审（spec 完整性专项）
- 评审对象：`.xyz-harness/2026-05-31-todo-v3-auto-clear-reminder/spec.md`

## 逐项检查

### 1. Spec 完整性

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 目标明确 | ✅ | 一段话可概括：为 Pi Todo 添加自动清空、Todo Reminder、Verification Nudge 三个能力 |
| 范围合理 | ✅ | 边界清晰：不改数据结构、不加磁盘持久化、不做依赖关系 |
| AC 可量化 | ✅ | 三个功能的触发条件明确，可直接转化为测试用例 |
| [待决议] 项 | ✅ | 无 |
| 数据模型 | ✅ | 新增状态定义清晰，默认值合理 |

### 2. 架构合规（对照项目 CLAUDE.md）

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 事件使用 | ✅ | agent_start + before_agent_start 组合合理，符合 Pi 扩展 API |
| 状态管理 | ✅ | 模块级变量 + reconstructState 重置，与现有模式一致 |
| 向后兼容 | ✅ | 现有 Todo 接口不变，旧 session 无需迁移 |

### 3. 需求覆盖完整性

| FR | 有对应实现 | 实现清晰 | 说明 |
|----|-----------|---------|------|
| FR-1 自动清空 | ✅ | ✅ | 触发条件、实现逻辑、边界情况均已定义 |
| FR-2 Todo Reminder | ✅ | ✅ | 触发条件、实现逻辑清晰 |
| FR-3 Verification Nudge | ✅ | ✅ | 触发条件、实现逻辑清晰 |
| FR-4 Prompt 更新 | ✅ | ✅ | 具体内容已列出 |

### 发现的问题

| # | 优先级 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|---------|
| 1 | LOW | 事件监听 | agent_start 递增 userMessageCount，但 spec 未说明是否排除 tool_result 等非用户消息 | 当前实现已正确（agent_start 仅在用户消息时触发），无需修改，仅需确认 |
| 2 | LOW | 自动清空 | 自动清空后是否需要通知用户？spec 中 message.display: false 表示用户不可见 | 建议保持 display: false，清空是静默行为，不打扰用户 |
| 3 | LOW | Verification Nudge | 中文关键词 '验证' 可能匹配非验证任务（如"验证邮箱"） | 可接受，实际使用中误匹配概率低，无需修改 |

### 结论

**通过**。

Spec 结构完整，三个功能的触发条件和实现逻辑清晰，边界情况已考虑。3 条 LOW 建议均为非阻塞性优化，可在实现阶段酌情采纳。

### Summary

Spec 评审完成，第1轮，0条MUST FIX，3条LOW建议（均为非阻塞性），可进入实现阶段。
