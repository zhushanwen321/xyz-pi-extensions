# Phase 2 Plan — 实现规格

> 从 `review-gate-phase-analysis-playbook.md` 提取的最终结论，作为实现参考。

## 概览

| 项目 | 说明 |
|------|------|
| 阶段 | Phase 2 Plan（方案设计） |
| Skill | `xyz-harness-writing-plans` |
| 执行者 | 主 Agent（phase 内部步骤）、Workflow（review-gate）、Subagent（retrospect） |
| 产出物 | L1: 5 个文件 / L2: 9 个文件 |

## 完整流程

```
1. [Skill] xyz-harness-writing-plans 加载
2. [主 Agent] 复杂度评估（L1/L2）— 不用 subagent
3. [Goal] phase-start 自动注入（先注入 L1 默认任务，评估为 L2 后追加额外任务）
4. [主 Agent] 按 Step 顺序编写 plan 交付物（不并行，不 dispatch subagent）
5. [主 Agent] ADR 评估 — 不用 subagent
6. [Workflow] Review-Gate（循环，最多 3 轮）
7. [脚本] Phase-Gate（最多重试 5 次）
8. [Subagent] Retrospect（fork session）
→ 过渡：主 agent 调用 coding-workflow-phase-start(phase=3)
```

## Phase 过渡

**Phase 1 → Phase 2**：Phase 1 Retrospect 完成后，主 agent 调用 `coding-workflow-phase-start(phase=2)`。该 tool handler 执行 compact，注入 Phase 2 steering prompt，并自动初始化 goal。

**Phase 2 → Phase 3**：Phase 2 Retrospect 完成后，主 agent 调用 `coding-workflow-phase-start(phase=3)`。

## Goal 配置

**触发方式**：`phase-start` 自动注入（`initializeGoalFromExternal()` API）

**时序处理**：`executePhaseStartTool` 在入口时无法知道复杂度（L1/L2），采用"先默认后追加"策略：

1. 入口时注入 L1 任务列表（5 个任务）
2. Steering prompt 中指导主 agent 先做复杂度评估
3. 评估为 L2 时，主 agent 调用 `goal_manager.add_tasks()` 追加 4 个额外任务

**L1 任务列表**（默认注入）：
1. Write plan.md (with Execution Groups)
2. Write e2e-test-plan.md + test_cases_template.json
3. Write use-cases.md + non-functional-design.md

**L2 追加任务**（评估为 L2 时追加）：
4. Write plan-api-contract.md
5. Write plan-backend.md
6. Write plan-frontend.md
7. Write interface_chain.json

> 注：追加后任务 4-7 的编写顺序需按 Step 2-4 执行（见"交付物编写顺序"），不按 goal 任务编号顺序。Steering prompt 中需明确"按 Step 顺序编写，不按 goal 任务编号顺序"。

**API 调用**：
```typescript
import { initializeGoalFromExternal } from "@zhushanwen/pi-goal";

// executePhaseStartTool 中，Phase 2 入口
initializeGoalFromExternal(pi, ctx, "Phase 2: 完成 plan 阶段交付物", L1_TASKS);
// steering prompt 中指导：
// "评估为 L2 后，调用 goal_manager.add_tasks() 追加 L2 额外任务"
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
Step 6: use-cases.md + non-functional-design.md — 依赖 spec.md，可在 Step 1-5 期间任意时刻执行
```

### test_cases_template.json 的 phase 字段

测试用例必须标注 `phase` 字段，区分测试归属：

```json
{
  "test_cases": [
    {
      "id": "TC-U01",
      "type": "unit",
      "phase": 3,
      "description": "用户创建函数返回正确结构",
      "depends_on": []
    },
    {
      "id": "TC-I01",
      "type": "integration",
      "phase": 4,
      "description": "用户 API CRUD 完整链路",
      "depends_on": ["TC-U01"]
    },
    {
      "id": "TC-E01",
      "type": "e2e",
      "phase": 4,
      "description": "用户注册→登录→创建订单→支付→查看订单",
      "data_testids": ["register-form", "login-btn", "create-order", "pay-btn"],
      "depends_on": ["TC-I01"]
    },
    {
      "id": "TC-M01",
      "type": "manual",
      "phase": 4,
      "description": "支付失败时的错误提示文案检查",
      "verification_method": "manual"
    }
  ]
}
```

**字段说明**：
- `phase`: 3 = Phase 3 TDD 执行，4 = Phase 4 集成/E2E 执行
- `type`: unit / integration / e2e / manual
- `data_testids`: E2E 测试需要的关键 UI 元素 ID（Phase 3 编码时必须添加到代码中）
- `verification_method`: manual = 不可自动化，Phase 4 输出给用户手动验证

### L1（3 步，简化）

```
Step 1: plan.md（含 Execution Groups）
Step 2: e2e-test-plan.md + test_cases_template.json
Step 3: use-cases.md + non-functional-design.md（可在 Step 1-2 期间任意时刻执行）
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
| L1 Agent | `plan-requirements-reviewer.md`（单 agent） |
| L2 Agent | `plan-requirements-reviewer.md` + `plan-bl-requirements-reviewer.md`（**串行**审查） |
| 循环 | agent 审查 + 直接修复 → must_fix=0 退出 |
| 最大轮数 | 3 |

**内部结构**：
```
循环 {
  // L2: 两个 reviewer 串行执行（避免同时修改文件冲突）
  [Agent 1] plan-requirements-reviewer.md 审查 + 直接修复
  [Agent 2] plan-bl-requirements-reviewer.md 审查 + 直接修复（L2 only）
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
| **新增** | 复杂度评估后调用 `goal_manager.add_tasks()` 追加 L2 任务 |

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
