---
phase: dev
verdict: pass
absorbed: false
topic: "2026-06-02-evolve-expand-tracking-dimensions"
harness_issues:
  - "subagent-driven-development 的 3 subagents/group 策略高效，但 BLR 发现的 MUST_FIX 需要主 agent 手动修复，缺乏自动化修复流程"
  - "Integration Review 发现新模块无执行路径是架构层面问题，应在 plan 阶段就明确 analyzer 入口点"
  - "review 文件的 verdict 需要在修复后手动更新为 pass，容易遗漏"
---

# Phase 3 Retrospect: Dev

## 1. Phase Execution Review

### Summary

本 phase 的目标是按照 plan.md 实现 16 个 task。实际工作：

1. **防护预检**：ESLint + tsconfig strict + .githooks 已就位，安装 pre-commit hook
2. **BG1（6 tasks）**：TypeScript 侧 ProblemRegistry + 4 个 detector + 注册到事件系统
3. **BG2（8 tasks）**：Python 侧 7 个 extractor + 15 个 miner rules + 自动发现机制
4. **BG3（2 tasks）**：更新 evolve 和 evolve-report skill 文件
5. **五步专项审查**：BLR + Standards + Taste + Robustness + Integration
6. **修复 MUST_FIX**：2 个 BLR 问题 + 1 个 Integration 问题

### Problems Encountered

**问题 1：goal_quality.py 双重嵌套结构**

BLR 发现 `goal_quality.py` extractor 返回 `{"goal_quality_stats": {...}}` 嵌套结构，但 `run_extractors()` 会添加 `_stats` 后缀，导致最终 key 变成 `goal_quality_stats_stats`。3 条 goal 相关 miner rules 永远无法触发。

**根因**：plan 中的代码示例已经包含了嵌套结构，但没有考虑 `run_extractors()` 的后缀机制。

**解决**：扁平化 extractor 返回结构，移除外层 `goal_quality_stats` 包装。

**问题 2：PROBLEM_REGISTRY 声明不存在的 minerRule**

`problems.ts` 中 `goal-task-quality` 的 `minerRules` 包含 `goal-high-cancel` 和 `goal-low-evidence-quality`，但这两个规则文件不存在。

**根因**：plan 中的 ProblemRegistry 定义与实际创建的规则文件不一致。

**解决**：从 `minerRules` 数组中移除不存在的规则名。

**问题 3：新 Python 模块无执行路径**

Integration Review 发现 `src/index.ts` 调用的是旧 analyzer（`~/.pi/agent/scripts/pi-session-analyzer/analyze.py`），该脚本不知道 `packages/evolve-daily/analyzer/` 下的新代码。

**根因**：plan 只定义了"创建新 extractor 和 rules"，没有明确"如何将新代码接入执行路径"。

**解决**：
1. 创建新的 analyzer 入口点 `packages/evolve-daily/analyzer/analyze.py`
2. 更新 TypeScript 的 `ANALYZER_PATH` 指向新入口点

### What Would You Do Differently

1. **Plan 阶段明确执行路径**：plan 应该明确"新代码如何被调用"，不只是"创建什么文件"
2. **BLR 之前先跑集成测试**：如果先验证数据流，可以更早发现嵌套结构问题
3. **Review 文件自动更新**：修复 MUST_FIX 后，review 文件的 verdict 应该自动更新为 pass

### Key Risks for Later Phases

1. **旧 analyzer 未废弃**：`~/.pi/agent/scripts/pi-session-analyzer/analyze.py` 仍然存在，可能造成混淆
2. **sessionId/goalId 永远为空**：detector 创建的 tracked item 没有填充 sessionId 和 goalId，影响可追溯性
3. **无单元测试**：当前只有语法检查和类型检查，没有真正的单元测试

## 2. Harness Usability Review

### Flow Friction

Phase 3 的流程比 Phase 1/2 更复杂，因为涉及实际代码编写。使用 subagent-driven-development 的 3 subagents/group 策略（implementer + spec reviewer + code quality reviewer）效率很高，但有一个问题：BLR 发现的 MUST_FIX 需要主 agent 手动修复，而不是让 implementer subagent 修复。

### Gate Quality

Gate check 正确识别了所有 review 文件的 verdict 和 must_fix。但有一个细节：修复 MUST_FIX 后，review 文件的 verdict 仍然是 `fail`，需要手动更新为 `pass`。这增加了额外的工作量。

### Prompt clarity

Phase 3 的 skill 指令（xyz-harness-phase-dev）非常详细，涵盖了 TDD、五步专项审查、复盘等。但有一个遗漏：没有明确说明"修复 MUST_FIX 后需要更新 review 文件的 verdict"。

### Automation gaps

1. **Review 文件更新**：修复 MUST_FIX 后，review 文件的 verdict 应该自动更新为 pass
2. **Analyzer 入口点**：plan 应该自动生成 analyzer 入口点，而不是在 Integration Review 发现问题后才创建
3. **单元测试**：当前没有自动化测试流程，只有语法检查和类型检查

### Time Sinks

1. **修复 MUST_FIX**：3 个 MUST_FIX 修复花了约 20 分钟，主要是理解问题和修改代码
2. **Review 文件更新**：手动更新 review 文件的 verdict 花了额外时间
3. **Analyzer 入口点**：创建新的 analyzer 入口点是计划外的工作
