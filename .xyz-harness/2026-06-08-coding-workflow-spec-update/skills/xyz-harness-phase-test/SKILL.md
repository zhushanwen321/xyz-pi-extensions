---
name: xyz-harness-phase-test
description: >-
  Phase 4 (test) of the xyz-harness workflow. Integration/E2E testing with Test-Fix Loop Workflow.
---

## Dev-flow 上下文

| 项目 | 值 |
|------|---|
| 所在阶段 | Phase 4 (test) |
| 执行者 | 主 Agent（编排 + 服务启动）+ Workflow（Test-Fix Loop） |
| 上游 | Phase 3 (dev) — 代码 + 单元测试 |
| 下游（完成后进入） | Phase 5 (PR) — 加载 phase-pr skill |

## 关键变更（V2）

- **Review-Gate 已删除**（被 Test-Fix Loop Workflow 替代）
- **Gate Handoff 已删除**
- **核心机制：Test-Fix Loop Workflow**（core → noncore 串行，各最多 10 轮）
- **Phase-Gate 严格防伪造**：3 层次检查（脚本 → 一致性 → 深度质疑）

## 完整流程

1. **读取 test_cases_template.json + e2e-test-plan.md**
2. **分类测试用例**：核心 case / 非核心 case
3. **启动基础设施**（dev server / backend / DB）
4. **调用 `coding-workflow-gate(phase=4)`**

Gate tool 内部自动执行：
- **Workflow 1**：Test-Fix Loop（核心 case）
  - 每轮：coordinator 构造 test-execute JSON → Wave 并行测试 → 汇总
  - failed case → Fix Worker 修复 → git commit
  - 循环最多 10 轮，连续 3 轮 failed 不降 → 强制退出
- **Workflow 2**：Test-Fix Loop（非核心 case）
  - 核心全部 passed 后启动
  - 同样最多 10 轮
- **Phase-Gate**：严格防伪造（3 层次检查）
- **输出手动验证清单**（type: manual 的 case）

## 注意

Phase 4 **不使用 Goal 工具**追踪任务。Test-Fix Loop 内部用 `test-execute-v{N}-core.json` / `test-execute-v{N}-noncore.json` 做版本化状态管理。
