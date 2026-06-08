---
name: xyz-harness-phase-dev
description: >-
  Phase 3 (dev) of the xyz-harness workflow. TDD-based implementation with automated review-gate.
---

## Dev-flow 上下文

| 项目 | 值 |
|------|---|
| 所在阶段 | Phase 3 (dev) |
| 执行者 | 主 Agent（编排）+ Subagent（按 Wave 编码） |
| 上游 | Phase 2 (plan) — plan.md + Execution Groups |
| 下游（完成后进入） | Phase 4 (test) — 加载 phase-test skill |

## 关键变更（V2）

- **Five-Step Specialized Review 已删除**（由 Review-Gate Workflow 替代）
- **Gate Handoff 已删除**
- **Goal 自动注入**：进入 Phase 3 时 coding-workflow 自动从 plan.md 读取 Execution Groups 构建任务列表
- **Review-Gate 为三阶段**：阶段一（spec-plan-conformance）→ 阶段一.五（模拟数据生成）→ 阶段二（并行 5 reviewer + Fix Worker 循环）

## 完整流程

1. **Goal 自动注入**（已由 coding-workflow 完成）
2. **防护预检**（Step 0）
3. **按 Goal 任务顺序执行**：
   - TDD 测试编写
   - Wave 1 编码（按 Execution Group dispatch subagent）
   - Wave 2 编码（如有）
   - 运行全量测试 + 修复
   - 复跑测试（二次验证）
   - 再跑测试（稳定性检查）
   - 写 test_results.md + git commit + push

## 完成后

**编码完成后，调用 `coding-workflow-gate(phase=3)` 提交。**

Gate tool 内部自动执行 Review-Gate Workflow：
- 阶段一：spec-plan-conformance-reviewer（规格符合性检查）
- 阶段一.五：simulated-data-generator（生成模拟数据）
- 阶段二：并行 5 reviewer → review-sync-fix-worker 汇总 → file-fix-subagent 修复（循环最多 3 轮）
- Phase-Gate（脚本检查 + 防伪造）
- Retrospect
