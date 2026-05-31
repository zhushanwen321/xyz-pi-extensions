---
phase: plan
verdict: pass
---

# Phase 2 (Plan) Retrospect — goal-staleness-reminder-auto-clear

## 1. Phase Execution Review

### Summary

产出 L1 plan（5 个串行 Task + 1 个 Execution Group BG1）+ e2e-test-plan + test_cases_template.json + use-cases.md + non-functional-design.md。Plan 经过 2 轮审查通过。

关键决策：
- 评估为 L1 复杂度（无跨服务、无新存储引擎、无 API 契约），单文件 plan 无需拆分子文档
- Task 拆分按依赖链 `重命名→字段→提醒→清理→history`，每个 Task 对应一次 subagent 调度
- ADR 评估结果为空——无新决策满足三条件（难以逆转 + 无上下文会惊讶 + 真实权衡）

### Problems Encountered

1. **Plan v1 被打回 2 条 MUST FIX**：(a) `_render` 数据中 `subItems` key 的重命名遗漏——替换规则表只覆盖了源数据字段 `subTodos`，没覆盖输出给 GUI 的 key 名；(b) `/goal clear` 和 `/goal <new-objective>` 两个命令路径中的终态处理遗漏——只列了 tool action 和 handleAgentEnd 中的终态位置。两个问题都是对代码路径覆盖不完整的典型遗漏。
2. **Task 4 的 handleBeforeAgentStart 结构未描述**（LOW）：功能逻辑写清楚了，但函数的控制流重构（终态检查 → 停滞检查 → 原有 context injection）没有用伪代码展示。修复时补上了伪代码，大幅降低了实现歧义。

### What Would You Do Differently

- **终态路径枚举应该更系统**。写 Task 4 时应该用 `grep -n "transitionStatus\|status = \"cancelled\"\|status = \"complete\"" goal/src/index.ts` 先找出所有设置终态的代码位置，再逐个确认是否需要 completedAtTurnIndex + goal-history。而不是凭记忆列出 3 个位置就结束。
- **_render 数据流应该作为替换规则表的显式条目**。在 spec Constraints 中已经声明了 `_render` 协议的字段名变更，但写 plan 时把它当成"跟随源数据自动变化"，忽略了 `_render` 的 key 名和源数据字段名可能不同（`subItems` vs `subTodos`）。

### Key Risks for Later Phases

1. **`handleBeforeAgentStart` 的控制流重构**：终态检查 + 停滞检查 + 原有 context injection 三个逻辑的优先级和短路返回点必须在实现时严格按 plan 的伪代码执行，否则可能出现终态 goal 仍注入 context（应该短路）或停滞提醒覆盖了 context injection 但内容不足。
2. **61 处机械替换的一致性**：Task 1 的替换规则表虽然精确，但执行时如果有遗漏（特别是 `_render` 中的 `subItems`），编译器不会报错（只是 JSON key 名变了），只有 GUI 侧运行时才会发现。
3. **`goal-history` entry GC 的边界情况**：如果用户在 2 轮 auto-clear 窗口内多次 `/goal clear` 再 `/goal set`，可能产生多个 goal-history entry。MAX_HISTORY_ENTRIES=20 的上限是否够用取决于使用频率。

## 2. Harness Usability Review

### Flow Friction

L1 复杂度评估正确——单个 plan 文件覆盖所有 Task，无需拆分子文档。writing-plans skill 的 L1/L2 分级机制在这个场景下运行顺畅，没有产生不必要的子文档开销。

### Gate Quality

Plan review 的两条 MUST FIX 都是真问题，特别是 `_render` key 遗漏——这是一个运行时才能发现的 bug（编译器不检查 JSON key 名），review 在 plan 阶段就拦截了。第二轮一次通过，说明修复足够精准。

### Prompt Clarity

writing-plans skill 的要求明确。特别是 Interface Contracts 章节的方法签名表和 Spec Coverage Matrix 章节的 AC 追踪矩阵，在写 plan 的过程中帮助发现了两个遗漏（一个 AC 条目没有对应 interface method，一个 data flow 断裂）。

### Automation Gaps

`grep` 辅助枚举代码路径这个步骤可以自动化——写 plan 时如果有工具能自动列出"所有调用 transitionStatus 或设置终态 status 的代码位置"，就不会遗漏 `/goal clear` 路径。目前依赖人工 grep + 判断。

### Time Sinks

无显著时间消耗。Plan 编写 + 2 轮 review 总共约 10 轮对话，节奏合理。
