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
3. [Goal] phase-start 自动注入 initializeGoalFromExternal()
   → 任务列表：spec.md / use-cases.md / non-functional-design.md
4. [固定] 主 agent 按顺序编写 spec 交付物（每完成一个 md 更新 goal）
5. [Workflow] Review-Gate（循环，最多 3 轮）
6. [脚本] Phase-Gate（脚本检查）
7. [Subagent] Retrospect（fork session）→ 产出 `phase1_retrospect.md`
→ 过渡：主 agent 调用 coding-workflow-phase-start(phase=2)
```

## Phase 过渡

**Phase 1 → Phase 2**：Retrospect 完成后，主 agent 调用 `coding-workflow-phase-start(phase=2)`。该 tool handler 执行 compact，注入 Phase 2 steering prompt。

## Goal 配置

**触发方式**：`phase-start` 自动注入（`initializeGoalFromExternal()` API）

**任务列表**：
1. Write spec.md
2. Write use-cases.md
3. Write non-functional-design.md

**API 调用**：
```typescript
import { initializeGoalFromExternal } from "@zhushanwen/pi-goal";

// executePhaseStartTool 中，Phase 1 入口
initializeGoalFromExternal(pi, ctx, "Phase 1: 完成 spec 阶段交付物", [
  "Write spec.md",
  "Write use-cases.md",
  "Write non-functional-design.md",
]);
```

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

**连续不降处理**：如果连续 2 轮 must_fix 数量没有下降（例如 5→5→5），Workflow 退出循环并将结果返回主 agent，由主 agent 决定是否继续（需用户确认）或接受当前质量。

> 各 phase 的连续不降阈值统一为 2 轮，最大轮数统一为 3。Phase 4 的 Test-Fix Loop 阈值不同（见 Phase 4 spec），因为测试修复的反馈周期更短（跑测试→看结果→修代码），需要更多轮数才能收敛。

## Phase-Gate

| 项目 | 说明 |
|------|------|
| 模式 | 脚本检查（无防伪造） |
| 检查项 | 文档完整性 + YAML frontmatter + placeholder 扫描 |
| 严格度 | 🟢 基础（仅脚本） |
| 失败处理 | 返回主 agent 修复，修复后直接重新提交 phase-gate（跳过 review-gate） |
| 最大重试 | 5 次 |

**失败处理**：
- 返回主 agent，告知修复后**直接重新提交 phase-gate**
- **跳过 review-gate**（内容质量已在 review-gate 中通过）

## 产出物

| 文件 | Review-Gate 检查 | Phase-Gate（脚本） |
|------|-----------------|----------------|
| spec.md | ✅ 内容审查 | ✅ 格式 + YAML |
| use-cases.md | ✅ 内容审查 | ✅ 格式 + YAML |
| non-functional-design.md | ✅ 内容审查 | ✅ 格式 + YAML |
| phase1_retrospect.md | — | — |

## SKILL.md 变更

| 操作 | 目标 |
|------|------|
| **删除** | Spec Review 章节（主 agent 自审） |
| **删除** | Gate Handoff 章节（单独 session 提交 gate） |
| **保留** | Quick Overview → Brainstorm → Terminology → Scan → Write |
| **新增** | 整体 5-phase 执行流程指导（focus on review-gate） |
| **新增** | Goal 自动追踪（initializeGoalFromExternal() API 在 phase-start 注入） |
| **新增** | "完成后调用 coding-workflow-gate(phase=1)" |

## 可视化

`review-gate-flow/p1-spec.html`
