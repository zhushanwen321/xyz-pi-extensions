---
phase: test
verdict: pass
---

# Phase 4 (Test) Retrospect — goal-staleness-reminder-auto-clear

## 1. Phase Execution Review

### Summary

执行了 15 个集成测试用例（TC-1-01 到 TC-4-03），覆盖 4 个功能区域：终态自动清理（4 个）、停滞提醒（5 个）、subtask 重命名（3 个）、/goal history 命令（3 个）。所有测试通过静态代码分析验证（Pi 扩展无测试框架，代码在 Pi 进程内运行），15/15 PASS。

测试执行耗时约 2 轮对话：1 轮 subagent 静态分析 + 1 轮写 test_execution.json + self-check。

### Problems Encountered

1. **gate 拒绝：缺少 taste_review 文件**。Dev phase 的品味审查文件命名为 `ts_taste_review_v1.md`（subagent 自行命名），gate 脚本匹配 `taste_review_v*.md` 模式。解决方式：复制一份符合命名规范的文件。这本质上是命名约定不一致的问题——subagent 不知道 gate 的文件名匹配规则。

2. **无自动化测试框架**。Pi 扩展运行在宿主进程内，无法像独立模块一样单元测试。所有测试用例只能通过静态代码分析验证代码路径存在且逻辑正确。这种方式能发现"路径缺失"类 bug（如 Phase 3 BLR 发现的 `complete_goal` 缺少 `writeGoalHistoryEntry`），但无法验证运行时行为（如 staleness reminder 的消息内容、widget 折叠的视觉效果）。

### What Would You Do Differently

- **测试用例应在 plan 阶段标注验证方式**。15 个 TC 全部标注 `type: "integration"`，但实际验证方式是 `code_review`。如果 plan 阶段就明确"Pi 扩展无测试框架，全部用代码审查验证"，test phase 的预期会更清晰。
- **静态分析应更结构化**。当前 subagent 自由形式地报告代码路径。理想做法是输出结构化表格（TC ID → 文件:行号 → 通过/失败），直接映射到 test_execution.json 的 execute_steps 字段。

### Key Risks for Later Phases

1. **运行时验证缺失**：auto-clear 的 2 轮时机、staleness reminder 的消息格式、widget 折叠效果——这些都需要启动 Pi 手动验证。Phase 5 (PR) 之前建议做一次手动冒烟测试。
2. **边界条件的静态盲区**：`>=` vs `>` 阈值比较、`currentTurnIndex` 从 0 开始的 off-by-one——静态分析能确认逻辑存在，但无法确认语义是否完全符合预期。

## 2. Harness Usability Review

### Flow Friction

Phase 4 整体流程简洁。读 template → 执行验证 → 写 execution.json → self-check → gate，5 步完成，无多余工作。这是 5 个 phase 中最顺畅的一个。

唯一摩擦点：gate 的文件名匹配规则（`taste_review_v*.md`）与 Dev phase subagent 的命名习惯（`ts_taste_review_v1.md`）不一致。需要在 Dev phase 就约束审查文件的命名规范。

### Gate Quality

gate 正确检查了：test_execution.json 存在、所有 caseId 与 template 匹配、最终轮次全部 passed、execute_steps 非空。但 gate 对 Dev phase 审查文件完整性的检查（`taste_review_v*.md` must exist）暴露了命名约定问题，不是 gate 的 bug 而是流程规范缺口。

### Prompt Clarity

Skill 指令中 `test_execution.json` 的 schema 说明非常清晰，字段类型、允许值、常见错误都有示例。这大幅降低了 JSON 格式错误的风险。

### Automation Gaps

**代码路径覆盖率可以自动化**。写一个脚本：给定 TC ID 和预期的函数调用链（如 `complete_goal → completedAtTurnIndex → writeGoalHistoryEntry → persistGoalState`），验证每个调用点在代码中存在。这比自由形式的代码审查更可靠。

**文件名约定校验可以自动化**。gate 脚本已经有文件名匹配逻辑，可以在 Dev phase 的 gate 中提前校验审查文件的命名，避免 Test phase 才发现问题。

### Time Sinks

无显著时间消耗。整个 Phase 4 用了约 3 轮对话（含 gate 文件名修复），是效率最高的阶段。
