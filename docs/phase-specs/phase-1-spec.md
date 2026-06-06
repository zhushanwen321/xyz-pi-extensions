# Phase 1 Spec — 实现规格

> 从 `review-gate-phase-analysis-playbook.md` 提取的最终结论，作为实现参考。

## 概览

| 项目 | 说明 |
|------|------|
| 阶段 | Phase 1 Spec（需求分析） |
| Skill | `xyz-harness-brainstorming` |
| 执行者 | 主 Agent（phase 内部步骤）、Workflow（review-gate）、Subagent（retrospect） |
| 产出物 | spec.md + use-cases.md + non-functional-design.md |

## 完整流程

```
1. [Skill] xyz-harness-brainstorming
   → 告知主 agent 整体 5-phase 执行流程
   → focus on 当前目标：完成 spec 阶段的 review-gate
2. [固定] Brainstorming + 用户讨论（多轮）
3. [Goal] 用户手动触发 /goal（SKILL.md 引导 + steering prompt 提示）
   → steering prompt 明确：Brainstorming 完成、准备编写交付物时，提示用户 /goal
4. [固定] 主 agent 按顺序编写 spec 交付物（每完成一个 md 更新 goal）
5. [Workflow] Review-Gate（循环，最多 3 轮）
6. [脚本] Phase-Gate（最多重试 5 次）
7. [Subagent] Retrospect（fork session）
→ 过渡：主 agent 调用 coding-workflow-phase-start(phase=2)
```

## Phase 过渡

**Phase 1 → Phase 2**：Retrospect 完成后，主 agent 调用 `coding-workflow-phase-start(phase=2)`。该 tool handler 执行 compact，注入 Phase 2 steering prompt。

## Goal 配置

**触发方式**：用户手动 `/goal`

**任务列表**：
1. spec.md
2. use-cases.md
3. non-functional-design.md

**注入方式**：SKILL.md 中增加指导"Brainstorming 完成、准备编写 spec 交付物时，建议用户使用 /goal 工具初始化任务追踪"。Steering prompt 在 `before_agent_start` 时注入，主 agent 收到后在合适时机提示用户。

## Review-Gate

| 项目 | 说明 |
|------|------|
| 模式 | Workflow 循环 |
| Agent | `spec-requirements-reviewer.md` |
| 循环 | agent 审查 + 直接修复 → must_fix=0 退出 |
| 最大轮数 | 3 |
| 连续不降 | 2 轮 → 人工介入 |

**内部结构**：
```
循环 {
  [Agent] spec-requirements-reviewer.md 审查 + 直接修复
  判断: must_fix = 0 → 通过 / > 0 → 继续循环
}
```

## Phase-Gate

| 项目 | 说明 |
|------|------|
| 模式 | 一次性脚本检查 |
| 检查项 | 文档完整性 + YAML frontmatter + placeholder 扫描 |
| 最大重试 | 5 次 |

**失败处理**：
- 返回主 agent，告知修复后**直接重新提交 phase-gate**
- **跳过 review-gate**（内容质量已在 review-gate 中通过）

## 产出物

| 文件 | Review-Gate 检查 | Phase-Gate 检查 |
|------|-----------------|----------------|
| spec.md | ✅ 内容审查 | ✅ 格式 + YAML |
| use-cases.md | ✅ 内容审查 | ✅ 格式 + YAML |
| non-functional-design.md | ✅ 内容审查 | ✅ 格式 + YAML |

## SKILL.md 变更

| 操作 | 目标 |
|------|------|
| **删除** | Spec Review 章节（主 agent 自审） |
| **删除** | Gate Handoff 章节（单独 session 提交 gate） |
| **保留** | Quick Overview → Brainstorm → Terminology → Scan → Write |
| **新增** | 整体 5-phase 执行流程指导（focus on review-gate） |
| **新增** | Goal 追踪建议（steering prompt 中提示用户 /goal，限定在 brainstorming 完成后） |
| **新增** | "完成后调用 coding-workflow-gate(phase=1)" |

## 可视化

`review-gate-flow/p1-spec.html`
