---
review:
  type: spec_review
  round: 2
  timestamp: "2026-05-31T17:30:00"
  target: ".xyz-harness/2026-05-31-skill-state-tracker/spec.md"
  verdict: pass
  summary: "spec 评审完成，第2轮，0条 open MUST FIX，v1 的 3 条 MUST FIX 全部修复，通过"

statistics:
  total_issues: 6
  must_fix: 0
  must_fix_resolved: 3
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-2 + FR-5"
    title: "状态机转换规则不完整，图与参数定义不一致"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 2
    severity: MUST_FIX
    location: "spec.md:FR-4 vs FR-5"
    title: "FR-4 与 FR-5 对 recorded 状态的触发顺序描述矛盾"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 3
    severity: MUST_FIX
    location: "spec.md:FR-4"
    title: "上下文摘要数据来源不明确，扩展无法访问 LLM 对话"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 4
    severity: LOW
    location: "spec.md:FR-5"
    title: "缺少 TUI 渲染说明（renderCall/renderResult）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "spec.md:AC-5"
    title: "AC-5 Then 条件不够精确，触发强制记录缺少可验证断言"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: INFO
    location: "spec.md:FR-5"
    title: "未提及 _render GUI 描述符，可考虑为 list 操作添加"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v2（增量审查）

## 评审记录
- 评审时间：2026-05-31 17:30
- 评审类型：计划评审（spec 部分，增量审查第 2 轮）
- 评审对象：`.xyz-harness/2026-05-31-skill-state-tracker/spec.md`
- 审查模式：验证 v1 的 3 条 MUST_FIX 修复 + 检查回归

---

## MUST_FIX 修复验证

### [FIXED] #1：状态机转换规则不完整

**v1 问题**：FR-2 只有一个隐式的状态机图，转换合法性无法从文档直接判断（`loaded→recorded` 是否合法？终态后的旧 item 怎么处理？）。

**修复验证**：FR-2 新增了显式转换矩阵表：

```
| 从 \ 到 | completed | error | recorded |
|---------|-----------|-------|----------|
| loaded  | ✅        | ✅     | ❌       |
| error   | ✅        | ✅     | ✅        |
```

- `loaded → recorded` 显式标记为 ❌，消除歧义 ✅
- 终态定义明确："终态：completed、recorded。终态不可变更。" ✅
- FR-5 工具验证引用 FR-2 矩阵："验证 id 存在且当前状态允许转换到目标状态（按 FR-2 转换矩阵）"，并给出具体非法示例（"不合法的转换（如 loaded → recorded）返回错误"） ✅
- AC-3 覆盖终态后的重新追踪：旧 item 保留终态，新 item 从 loaded 开始 ✅

**结论：完全修复。**

### [FIXED] #2：FR-4 与 FR-5 因果顺序矛盾

**v1 问题**：FR-4 暗示 "注入 steering → AI 调 subagent → 自动流转 recorded"，FR-5 暗示 "AI 调 recorded → 触发 subagent"，顺序相反。

**修复验证**：FR-4 新增显式因果顺序段落：

> 因果顺序：先注入 steering → AI 调用 subagent → AI 调用 skill_state(status=recorded)。扩展不自动流转到 recorded，需要 AI 确认 subagent 完成后主动流转。

FR-5 的 `→ recorded` 行为描述同步更新：

> `→ recorded`：仅 `error` 状态可转换。AI 确认 subagent 已完成记录后调用

> `→ recorded` 时仅标记终态，不触发额外操作（subagent 应已由 AI 调用完成）

两端描述一致：扩展只负责注入 steering，不自动流转；AI 自行调度 subagent → recorded。✅

**结论：完全修复。**

### [FIXED] #3：上下文摘要数据来源不明确

**v1 问题**：FR-4 要求 subagent prompt 包含 "当前 session 中该 skill 的上下文摘要"，但扩展 API 无法访问 LLM 对话原文来生成有意义的摘要。

**修复验证**：FR-4 重写了 subagent 任务描述，不再要求扩展传递上下文摘要。改为：

> 要求 subagent 根据**当前 session context**（subagent 独立拥有 session 访问能力）分析 skill 执行中遇到的问题

并新增明确说明：

> 注意：subagent 是独立进程，有自己的 session 上下文，可以直接读取当前 session 的 entries 获取执行上下文。本扩展不需要传递 "上下文摘要"，由 subagent 自行获取。

修复方向正确：利用 subagent 进程共享 session 文件的能力，让 subagent 自行读取 entries，而非要求扩展生成摘要。✅

**结论：完全修复。**

---

## 回归检查

逐项检查修复是否引入新问题：

| 检查项 | 结果 |
|--------|------|
| FR-2 转换矩阵与 FR-5 工具验证是否一致 | ✅ FR-5 显式引用 FR-2 矩阵 |
| FR-4 因果顺序与 FR-5 recorded 行为是否矛盾 | ✅ 两端一致，扩展不自动流转 |
| subagent session 访问能力假设是否合理 | ✅ Pi 的 subagent 架构（ADR-001）支持共享 session 文件 |
| 转换矩阵是否覆盖所有状态组合 | ✅ 2×3 矩阵覆盖所有非终态的合法转换 |
| AC 用例是否与新的转换矩阵一致 | ✅ AC-1~AC-8 均与新矩阵无冲突 |

**未发现回归。**

---

## 结论

通过。v1 的 3 条 MUST_FIX 全部修复充分，未引入回归。v1 的 2 条 LOW + 1 条 INFO 按增量审查规则不做重新评估，可在后续 plan/dev 阶段酌情处理。

### Summary

spec 评审完成，第2轮通过，0条 MUST FIX，v1 的 3 条 MUST FIX 全部修复。
