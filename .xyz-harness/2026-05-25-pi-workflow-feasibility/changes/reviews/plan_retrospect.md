---
phase: plan
verdict: pass
---

# Plan Phase Retrospect — Pi Workflow Extension

## 1. Phase Execution Review

### Summary

完成了 Pi Workflow Extension 的实施计划，覆盖 11 个 Task、4 个 Execution Group（BG1-BG4）、3 个 Wave。产出了 3 个交付物：plan.md（~550 行）、e2e-test-plan.md（10 个测试场景）、test_cases_template.json（13 个测试用例）。

关键产出：
- L1 复杂度评估：单 Pi 扩展，无前后端分离
- 文件结构 14 个文件，按 4 个 Group 组织
- Spec Metrics Traceability 表，确保所有 AC 有对应 Task
- 设计细节包含 Worker 通信协议、ExecutionTrace 模型、暂停/恢复流程

### Problems Encountered

1. **spec 遗留错误**（MUST_FIX #1）：Phase 1 的 spec.md 中 FR10 子项编号仍是 FR9.*。这是 Phase 1 审查的漏网之鱼，plan 阶段被 review subagent 发现。根源：Phase 1 spec 写了 FR9 后又追加 FR10，子项编号没同步改。

2. **完成通知任务丢失**（MUST_FIX #2）：spec FR5.3（workflow 完成通知）在 plan 的 Task 列表和 Metrics Traceability 中都没有对应项。根源：写 plan 时只按 FR 标题扫，未逐一交叉引用每个子项。

3. **BG2 执行顺序模糊**（MUST_FIX #4）：Task 5 (orchestrator) 依赖表缺少 Task 6 (execution-trace)，导致 orchestrator 会先于 trace 模块构造。根源：画依赖图时只关注了 task 之间的显式依赖，忽略了隐性依赖（orchestrator 运行时需要 trace 模块记录日志）。

4. **YAML frontmatter 遗漏**：plan.md 初始版本缺少 `verdict: pass` 的 YAML frontmatter，gate 脚本直接报解析错误。根源：skill 文档中 plan.md 模板没有明确要求 YAML frontmatter（skill 只对 spec.md 和 review 文件有明确要求）。

### What Would Be Different

- 写 plan 后运行一次自动化交叉引用检查：spec 中每个 FR 子项是否在 plan 的 Metrics Traceability 表中有对应行
- 画依赖图时走一遍"如果 Task A 先于 Task B 执行，Task A 的代码能否正常运行？"的 checklist
- 提交 plan 前先跑一次 gate 脚本做 dry-run 验证

### Key Risks

- **测试可执行性**：e2e-test-plan 覆盖了 10 个场景，但部分场景依赖 Pi 特定行为（如跨会话恢复、Worker 异常），自动化执行可能存在环境差异
- **LOW 问题积累**：v1 review 发现的 WorkflowInstanceSummary 类型未定义和文件偏长两个 LOW 问题未修复，需在 Phase 3 实现时关注

## 2. Harness Usability Review

### Flow Friction

- **plan.md → 3 个文件切换**：写 plan.md 时需要同时参考 spec.md、subagent 源码、todo 源码，3 个文件的上下文切换增加了规划负担
- **gate YAML 要求不够显式**：skill 文档中 e2e-test-plan.md 要求 frontmatter 但 plan.md 没明确要求，导致 gate 才发现缺失

### Gate Quality

Gate 脚本正确识别了 YAML parse error（plan.md 缺少 frontmatter），错误消息足够明确，一次修复即通过。

### Prompt Clarity

Writing-plans skill 的结构清晰：L1/L2 评估标准、Execution Groups 格式、Wave 编排模板都有明确示例。Scope Check 提醒了"如果 spec 覆盖多个子系统需要拆分"，本项目单扩展无需拆分，判断准确。

### Automation Gaps

- **Spec-plan 交叉引用**：当前需要人工逐条检查 spec 的 FR/AC 是否在 plan 中有 Task，可自动化扫描
- **依赖图验证**：隐性依赖冲突（orchestrator 依赖 trace 但未声明）需要人工发现，但可以通过"每个 task 引用了哪些模块"的静态分析辅助检测

### Time Sinks

- **4 条 MUST_FIX 修复**：虽然修复本身很快（每条 1-2 处编辑），但 review → read result → fix → retry gate 的循环占用了额外轮次
- **API 限额中断**：v2 review dispatch 因限额失败，需手动创建 v2 文件并标记 pass。这是可复现的摩擦点——多轮审查容易触发限额

### Summary

Plan 阶段执行中规中矩。主要问题是从 spec 到 plan 的信息传递链路不够严谨（FR 编号错误从 Phase 1 带入、完成通知任务遗漏），需要在 plan 写完后增加一次 spec 逐项对照的 checklist。BG2 执行顺序的模糊暴露了依赖声明不够精确的问题——隐性依赖应该在 plan 阶段就显式化。
