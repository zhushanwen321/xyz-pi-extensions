---
phase: plan
verdict: pass
absorbed: false
topic: "2026-06-01-merge-harness-extensions-monorepo"
harness_issues:
  - "writing-plans skill 要求 Task 粒度为 subagent 调度粒度（每个 Task 对应一次完整 subagent 链），但 12 个 Task 实际执行时很多是纯 shell 操作（git mv、cp -r），不需要 TDD coder subagent。skill 对'纯结构重构'场景的 Task 粒度指导不够——是否可以将多个简单 shell 操作合并为一个 Task？还是每个 git mv 独立？这导致 plan 的 Task 数量偏多"
  - "plan review v1 发现的 MUST FIX（Task 5 for 循环包含独立 skills）是典型的 copy-paste 错误——写 for 循环时把所有 harness skills 都列进去了，忘记独立 skills 应该只出现在 Task 8。writing-plans skill 的 Self-Review checklist 有 placeholder scan 和 type consistency check，但缺少'cross-task 冲突检测'——检查多个 Task 是否操作同一组文件"
  - "Execution Groups 的 Wave 编排在实际中可能过于严格——BG2 必须先于 BG3 的约束是因为 BG3 Task 5 需要 coding-workflow 目录已存在，但 BG3 的 Task 7（evolve skills）和 Task 8（独立 skills）完全不依赖 BG2。更细粒度的 Wave 编排可以提升并行度"
---

# Plan Phase Retrospect

## 1. Phase Execution Review

### Summary

产出 5 个交付物：plan.md（12 Tasks, 5 BG Groups, 4 Waves）、e2e-test-plan.md（8 个 Test Scenarios）、test_cases_template.json（17 个 TC）、use-cases.md（4 个 UC）、non-functional-design.md（5 维度）。复杂度评估 L1。Plan review 2 轮通过（1 MUST FIX → 0）。

关键设计决策：
- L1 复杂度（纯结构重构，无新领域建模）
- 12 个 Task 按 5 个 Execution Group 分组，4 个 Wave 串行执行
- subagent 去重方案：对比 pi-subagent 包的 export，确认功能完全覆盖，删除 coding-workflow 内嵌三文件

### Problems Encountered

1. **Task 5 for 循环包含独立 skills**（review v1 MUST FIX）：写 for 循环时惯性把所有 harness 仓库的 skills 都列了进去，没有仔细区分"coding-workflow 所属"和"独立"。修复方式是从 for 循环中移除 10 个独立 skills，只保留 19 个 harness 所属 skills。

2. **coding-workflow index.ts 有 44k 行**：这个文件巨大，在 Task 6 中需要改 import 路径。plan 中只标注了"改 import"，没有在 Interface Contracts 中详细说明 44k 行文件中到底有几处 import 需要改。实际上只有 2 处（index.ts 和 review-dispatcher.ts），但 plan 应该更明确。

### What Would You Do Differently

1. **写 Task 5 的 for 循环前先列清单再写代码**。当时是凭记忆写的 skill 列表，导致了独立 skills 混入。正确做法是先用 bash 扫描 harness 仓库 skills 目录，得到准确清单，再分两组写入。

2. **Execution Groups 的粒度可以更粗**。12 个 Task 中很多是简单的文件复制操作（Task 3, 4, 8, 9），不需要独立的 subagent 链。可以合并为更少的 Task（如将 Task 3+4 合并为"harness extensions 迁移"，Task 5+7+8 合并为"skills 迁移"），减少 subagent 调度开销。

### Key Risks

1. **coding-workflow 的 `runSingleAgent` 与 pi-subagent 的 `SpawnManager` 签名差异**（最高风险）：plan 的 Interface Contracts 标注了"需要写适配层"，但没有在 Task 6 中给出适配层的具体设计。Phase 3 执行时可能需要额外时间解决签名对齐。

2. **git mv 后 tsconfig paths 可能失效**：根 tsconfig.json 的 `include` 改为 `packages/**` 后，各包内的相对 import 和 paths 映射是否还能正确解析，取决于每个包是否有独立的 tsconfig.json。Task 10 提到了这一点但不够具体。

## 2. Harness Usability Review

### Flow Friction

- **Self-Review checklist 的 "No Placeholders" 规则**对纯结构重构的 plan 过于严格。plan 中的 bash 命令（`cp -r`、`git mv`）被视为"代码步骤"，但它们不是真正的实现代码。区分"配置/脚本步骤"和"实现代码步骤"的规则缺失。

### Gate Quality

- Gate check 正确识别了所有交付物（plan.md、e2e-test-plan.md、test_cases_template.json、use-cases.md、non-functional-design.md）。没有误报。

### Prompt Clarity

- writing-plans skill 的"Interface Contracts"章节对 L1 plan 要求"方法签名表 + AC 覆盖矩阵"，但对纯结构重构，"接口契约"的概念有些牵强——实际产出的是一个"依赖替换映射表"而不是传统的方法签名。skill 可以增加对重构类 plan 的 Interface Contracts 指导。

### Automation Gaps

- plan review 的"修复 MUST FIX → 重新 dispatch"循环是手动编排的。MUST FIX 只有 1 条时还好，如果有多条，每次都要手动修复、提交、重新 dispatch review，效率低。
- test_cases_template.json 的编写是手动的。E2E test plan 中的场景可以半自动生成——从 spec AC 提取验证条件，再转为 TC 模板。

### Time Sinks

- 最大时间消耗在**代码扫描**阶段——为了写准 Interface Contracts，扫描了 subagent/src/ 的所有 export、coding-workflow/lib/ 的所有 export、review-dispatcher.ts 的 import。这些扫描在 Phase 1 spec 阶段已经做过一次，Phase 2 又重复了。skill 可以建议"延续 Phase 1 的代码扫描结果"。
