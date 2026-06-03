---
phase: plan
verdict: pass
absorbed: false
topic: "2026-06-03-workflow-vs-claude-code-analysis"
harness_issues:
  - "review subagent 的超时/无响应检测不够健壮，需要手动检查 status"
  - "gate check 在 review 文件不存在时的错误信息应指明需要先 dispatch review subagent"
---

# Phase 2 Retrospect — Workflow model-switch 集成

## Phase Execution Review

### Summary

Phase 2 产出 5 个交付物（plan.md、e2e-test-plan.md、test_cases_template.json、use-cases.md、non-functional-design.md），经过 2 轮 review 通过。

第一轮 review 发现 3 条 MUST FIX，全部集中在 `resolveModelForScene()` 的核心算法设计上：
1. `computePeakRecommend` 是系统级函数，plan 错误地将其当作 per-candidate 调用
2. 返回格式用 `pcfg.plan` 而非 `providerKey`（Pi `--model` flag 的正确格式）
3. 缺少候选排序逻辑（spec FR-3 要求 priority 排序）

修复方案：将算法改为"单次调用 computePeakRecommend + plan 名称匹配判断 + priority 排序"。同步更新了 spec.md 的 FR-3 描述以保持 spec-plan 一致。

### Problems Encountered

1. **算法设计错误在 plan 阶段被 review 捕获**：这是 harness 的正面价值——如果直接进入 dev 阶段，这个问题会在集成测试时才暴露，修复成本更高。
2. **review subagent 超时**：第一次 dispatch review subagent 后出现 "needs attention" 信号（60s 无活动），但实际 review 已经完成。需要手动检查 status 确认。

### What Would Do Differently

- 在写 plan 前就应该详细读 `computePeakRecommend` 的源码（而不只是看函数签名）。纯签名级别的验证不够，需要理解函数的内部逻辑（系统级 vs per-entity）。
- spec 和 plan 的 FR-3 描述应该一开始就对齐，而不是等 review 指出不一致后再改。

### Key Risks for Later Phases

- model-switch 的 `findPeakPlan` 只找第一个 peak plan（`entries.sort(...); return entries[0]`）。如果用户配置了多个 peak plan，当前设计只考虑第一个。dev 阶段需要确认这是否可接受。
- `providerKey` vs `plan` 的区分在测试中需要明确验证——测试 config 的 provider key 和 plan 应该故意设为不同值（如 `models["my-router"].plan = "shared-plan"`），以捕获格式错误。

## Harness Usability Review

### Flow Friction

- **gate 要求 review 文件但未自动 dispatch**：gate check 失败时只报告 `plan_review_v*.md not found`，但没有指引说需要先 dispatch review subagent。初次使用时需要从 skill 文档中找到 review 步骤。

### Gate Quality

- 第一轮 gate 正确识别了缺少 review 文件的问题。
- 第二轮 gate（修复后）正确通过。

### Prompt Cliction

- writing-plans skill 的 L1/L2 评估标准清晰，5 个维度的判定表很实用。
- "Bite-Sized Task Granularity" 和 "Harness 模式下的注意" 存在矛盾——前者说每步 2-5 分钟，后者说 Task 粒度应与 subagent 调度对齐。应该更早明确"plan 的 Task 粒度 = subagent 调度粒度，不是 TDD 微步骤"。
- Interface Contracts 的"禁止实现代码"豁免说明位置靠后，阅读时容易漏掉。

### Automation Gaps

- review subagent dispatch 需要手动构建 task prompt（复制模板 + 替换路径）。这个步骤可以自动化——gate 失败时自动 dispatch review subagent。
- plan 修复后需要重新 dispatch review subagent 并生成 v2 文件，这个"修复→重审"循环需要手动管理文件编号。

### Time Sinks

- review subagent 超时检测和状态确认：~2 分钟
- 修复 3 条 MUST FIX（主要是理解 computePeakRecommend 的实际行为）：~5 分钟
- 同步更新 spec.md FR-3 描述：~2 分钟
