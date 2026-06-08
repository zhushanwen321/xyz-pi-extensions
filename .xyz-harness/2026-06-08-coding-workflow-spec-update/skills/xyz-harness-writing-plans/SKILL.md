---
name: xyz-harness-writing-plans
description: >-
  Phase 2 (plan) of the xyz-harness workflow. Creates implementation plan, E2E test plan, and test case templates.
---

## Dev-flow 上下文

| 项目 | 值 |
|------|---|
| 所在阶段 | Phase 2 (plan) |
| 执行者 | 主 agent（规划 + 编排） |
| 上游 | Phase 1 (spec) — spec.md |
| 下游（完成后进入） | Phase 3 (dev) — 加载 phase-dev skill |

## 关键变更（V2）

- **Review-Gate / Plan Review / Self-Review 由 coding-workflow 扩展自动管理**
- **Gate Handoff 已删除**
- **Goal 自动注入**：进入 Phase 2 时 coding-workflow 自动初始化 Goal（L1 默认 5 个任务）
- **L2 追加任务**：评估为 L2 后，主 agent 调用 `goal_manager.add_tasks()` 追加 4 个额外任务

## 完整流程

1. **复杂度评估（L1/L2）**
2. **Goal 自动注入**（已由 coding-workflow 完成，L1 默认任务已存在）
3. **如评估为 L2**：调用 `goal_manager.add_tasks()` 追加：
   - Write plan-api-contract.md
   - Write plan-backend.md
   - Write plan-frontend.md
   - Write interface_chain.json
4. **按 Step 顺序编写 plan 交付物**
5. **ADR Evaluation Step**

## 交付物

| 文件 | L1 | L2 |
|------|:--:|:--:|
| plan.md | ✅ | ✅ |
| e2e-test-plan.md | ✅ | ✅ |
| test_cases_template.json | ✅ | ✅ |
| use-cases.md | ✅ | ✅ |
| non-functional-design.md | ✅ | ✅ |
| plan-api-contract.md | ❌ | ✅ |
| plan-backend.md | ❌ | ✅ |
| plan-frontend.md | ❌ | ✅ |
| interface_chain.json | ❌ | ✅ |

## 完成后

**编写完所有交付物后，调用 `coding-workflow-gate(phase=2)` 提交。**

不要自行审查 plan，不要 dispatch review subagent。Gate tool 内部会自动执行 Review-Gate + Phase-Gate。
