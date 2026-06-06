# Phase 2 Plan — 实现规格

> 从 `review-gate-phase-analysis-playbook.md` 提取的最终结论，作为实现参考。

## 概览

| 项目 | 说明 |
|------|------|
| 阶段 | Phase 2 Plan（方案设计） |
| Skill | `xyz-harness-writing-plans` |
| 执行者 | 主 Agent（所有步骤，不用 subagent，不并行） |
| 产出物 | L1: 5 个文件 / L2: 9 个文件 |

## 完整流程

```
1. [Skill] xyz-harness-writing-plans 加载
2. [主 Agent] 复杂度评估（L1/L2）— 不用 subagent
3. [Goal] phase-start 自动注入 initializeGoalFromExternal()（根据 L1/L2 写入任务列表）
4. [主 Agent] 按 Step 顺序编写 plan 交付物（不并行，不 dispatch subagent）
5. [主 Agent] ADR 评估 — 不用 subagent
6. [Workflow] Review-Gate（循环，最多 3 轮）
7. [脚本] Phase-Gate
8. [Subagent] Retrospect（fork session）
```

## Goal 配置

**触发方式**：`phase-start` 自动注入（`initializeGoalFromExternal()` API）

**L1 任务列表**：
1. Write plan.md (with Execution Groups)
2. Write e2e-test-plan.md + test_cases_template.json
3. Write use-cases.md + non-functional-design.md

**L2 任务列表**：
1. Write plan.md (architecture overview)
2. Write plan-api-contract.md
3. Write plan-backend.md + plan-frontend.md
4. Write interface_chain.json
5. Write e2e-test-plan.md + test_cases_template.json
6. Write use-cases.md + non-functional-design.md

**API 调用**：
```typescript
import { initializeGoalFromExternal } from "@zhushanwen/pi-goal";

// executePhaseStartTool 中，Phase 2 compact 后
initializeGoalFromExternal(pi, ctx, "Phase 2: 完成 plan 阶段交付物", taskList);
```

## 复杂度分级

| 级别 | 交付物数量 | 判断依据 |
|------|-----------|---------|
| L1 | 5 个 | 单模块、无前后端分离、CRUD 为主 |
| L2 | 9 个 | 多模块、前后端分离、有接口契约、有模块间依赖 |

**L1 产出物**：plan.md, e2e-test-plan.md, test_cases_template.json, use-cases.md, non-functional-design.md

**L2 额外产出物**：plan-backend.md, plan-frontend.md, plan-api-contract.md, interface_chain.json

## 交付物编写顺序

### L2（6 步，有依赖）

```
Step 1: plan.md（总纲）— 必须先写，定义架构和 Execution Groups
Step 2: plan-api-contract.md — 定义接口契约
Step 3: plan-backend.md + plan-frontend.md — 依赖 plan.md + plan-api-contract.md
Step 4: interface_chain.json — 从 Step 2-3 提取接口链
Step 5: e2e-test-plan.md + test_cases_template.json — 依赖 plan.md 的 Execution Groups
Step 6: use-cases.md + non-functional-design.md — 依赖 spec.md，可与 Step 1-5 交叉
```

### L1（3 步，简化）

```
Step 1: plan.md（含 Execution Groups）
Step 2: e2e-test-plan.md + test_cases_template.json
Step 3: use-cases.md + non-functional-design.md
```

## 任务依赖关系（供 Phase 3 使用）

plan.md 中每个 Execution Group 必须标注：

```yaml
# plan.md 中 Execution Group 的标注格式
groups:
  - id: BG1
    depends_on: []
    provides: [基础数据接口]
    wave: 1
  - id: BG2
    depends_on: [BG1]
    provides: [业务接口]
    wave: 2
```

**interface_chain.json 角色**：定义模块间接口签名。Phase 3 的 Integration Reviewer 依赖此文件验证模块衔接。

**Wave 编排规则**：
- 同一 Wave 内的 Group 可并行执行（最多 3 个 subagent）
- 不同 Wave 之间串行
- Wave = DAG 拓扑排序分层

## Review-Gate

| 项目 | 说明 |
|------|------|
| 模式 | Workflow 循环 |
| L1 Agent | `plan-requirements-reviewer.md` |
| L2 Agent | `plan-requirements-reviewer.md` + `plan-bl-requirements-reviewer.md`（并行） |
| 循环 | agent 审查 + 直接修复 → must_fix=0 退出 |
| 最大轮数 | 3 |

**内部结构**：
```
循环 {
  [Agent] plan-requirements-reviewer.md 审查 + 直接修复
  [L2 额外] plan-bl-requirements-reviewer.md 并行审查
  判断: must_fix = 0 → 通过 / > 0 → 继续循环
}
```

## Phase-Gate

| 项目 | 说明 |
|------|------|
| 模式 | 一次性脚本检查 |
| 检查项 | 文档完整性 + YAML frontmatter + placeholder 扫描 |

**失败处理**：
- 返回主 agent，告知修复后**直接重新提交 phase-gate**
- **跳过 review-gate**

## SKILL.md 变更

| 操作 | 目标 |
|------|------|
| **删除** | Self-Review 章节（主 agent 自审） |
| **删除** | Plan Review 章节（主 agent 自审） |
| **删除** | Gate Handoff 章节（单独 session 提交 gate） |
| **保留** | 设计步骤（ADR Evaluation） |
| **保留** | 格式检查项（交付物验证中的格式部分） |
| **新增** | "完成后调用 coding-workflow-gate(phase=2)" |

## 产出物清单

| 文件 | L1 | L2 | Review-Gate | Phase-Gate |
|------|:--:|:--:|:-----------:|:----------:|
| plan.md | ✅ | ✅ | ✅ 内容 | ✅ 格式 |
| e2e-test-plan.md | ✅ | ✅ | ✅ 内容 | ✅ 格式 |
| test_cases_template.json | ✅ | ✅ | ✅ 内容 | ✅ 格式 |
| use-cases.md | ✅ | ✅ | ✅ 内容 | ✅ 格式 |
| non-functional-design.md | ✅ | ✅ | ✅ 内容 | ✅ 格式 |
| plan-backend.md | ❌ | ✅ | ✅ 内容 | ✅ 格式 |
| plan-frontend.md | ❌ | ✅ | ✅ 内容 | ✅ 格式 |
| plan-api-contract.md | ❌ | ✅ | ✅ 内容 | ✅ 格式 |
| interface_chain.json | ❌ | ✅ | ✅ 内容 | ✅ 格式 |

## 可视化

`review-gate-flow/p2-plan.html`
