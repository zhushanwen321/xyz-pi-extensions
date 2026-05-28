---
phase: dev
verdict: pass
---

# Phase 3 Retrospect: Evolve Summarizer Pipeline

## 1. Phase Execution Review

### Summary

Phase 3 实现了 7 个 plan task，涉及 3 个新模块（summarizer.ts 417 行、effect-tracker.ts 157 行、gc.ts 124 行）和 7 个现有文件的修改。新增约 700 行代码，修改约 180 行。经过两轮subagent 实现 + 最多 4 轮审查修复，最终所有 5 步审查通过。

### Problems Encountered

1. **Subagent 连接失败**：Phase 3 前期 subagent 之间经历了连接错误。Task 4+5 的 subagent 第一次 dispatch 时因连接错误失败，需要重试。改进：主 agent 应该在 subagent 失败后自动重试，但当前流程需要用户手动恢复上下文。

2. **审查轮次膨胀**：Taste review 从 v1 → v2 → v3 → v4 走了 4 轮，从 6 个 MUST FIX 逐步减少到 1 个。但 v4 实际上是确认一个已知已修复的问题。根因：v3 在修复 commit 之前 dispatch 的，导致必须再 dispatch 一轮 v4。如果主 agent 能在所有修复完成后统一 dispatch 下一轮审查，可以节省一轮。

3. **旧代码的 MUST FIX 污染**：多个 review 报告标记了不在本次变更范围内的旧代码问题（如 `handleEvolveApply` 太长、`extractAssistantText` 的 unsafe as 断言、`randomUUID` 未使用导入）。这些是既有技术债，不是本次实现引入的。Reviewer 应该区分 scope 内 vs scope 外的 MUST FIX。当前机制中 reviewer 不区分，主 agent 需要自己判断哪些修哪些不修——这增加了决策负担。

4. **`standards_review_v1` 的 verdict/must_fix 不一致**：v1 的 YAML 是 `verdict: pass, must_fix: 1`，这是矛盾的（must_fix > 0 时 verdict 应该是 fail）。这导致 gate 脚本第一次 fail——因为 gate 检查 v1 的 must_fix=1。需要 dispatch v2 来解决。根因：reviewer 输出时没有遵循"must_fix > 0 → verdict: fail"的约定。

### What Would You Do Differently

- 在主 agent 侧做 unified review round management：收到 v1 反馈后，集中修复所有 MUST FIX，然后再统一 dispatch 一轮 v2 给所有需要重新审查的步骤。这样可以避免 v3/v4 这种"确认已知修复"的额外轮次。
- 在 subagent task prompt 中明确要求："如果 MUST FIX 不在本次 git diff 范围内（旧代码），标记为 INFO 而非 MUST FIX"。

### Key Risks for Later Phases

1. **Test phase 缺少测试框架**：evolution-engine 没有单元测试框架（tsc + lint 是仅有的验证手段）。Phase 4 如果要求执行测试，需要确认什么是"pass"的标准。
2. **`buildJudgeInput` 残留**：该函数仍 export 但不再被 commands.ts 调用。Integration review 标记为 LOW。如果未来有人依赖它，需要清理或保留。

## 2. Harness Usability Review

### Flow Friction

- **复杂路径的 subagent 开销偏高**：对于 ~400 行新代码 + ~50 行修改的工作量，派发 2 个高复杂度 subagent + 1 个主 agent 修复轮次 + 5 个审查 subagent（多轮），总 token 消耗约 244KB。如果有更简单的编码路径（主 agent 直接编码 + 一个审查），整体效率会更高。当前规则（5+ tasks = 复杂路径）对所有场景一刀切，没有考虑代码量规模。
- **审查绕行效率低**：1 个 MUST FIX 修复（改 1 行代码）需要 dispatch 整个 review subagent 重跑一轮（~30KB context, ~3 分钟）。如果 MUST FIX 是明确的"删这一行"类型，主 agent 应该可以自己修复并直接在 gate 中报告"已修复"，而不是必须走 review loop。
- **Self-Check 铁律有价值**：实际运行 tsc + lint 验证通过后才提交，这个规则在 Phase 3 中明确阻止了提交有类型错误的代码（`EffectReview` 导入缺失）。

### Gate Quality

- **审查全面**：18 项检查覆盖了所有交付物。`business_logic_review` 和 `integration_review` 的独立检查是一个好设计——它们最容易遗漏。
- **`must_fix: 0` 的严格检查发现了我遗漏的 issues**：第一次 gate fail 暴露了 standards v1 的 must_fix=1 和 taste v3 的 must_fix=1，促使我 dispatch v2/v4。

### Prompt Clarity

- **subagent task prompt 的"已知信息"效果显著**：在 subagent 2 的 task prompt 中提供 subagent 1 已产出的代码摘要，让 subagent 2 能正确编写 commands.ts 的集成代码。没有这个上下文，subagent 2 不知道 summarizeReport 的签名。
- **五步审查的 skill 名称指引不够明确**：skill 说 "Skill: xyz-harness-business-logic-reviewer" 但实际没有独立的 skill 文件，reviewer 用 general-purpose agent 完成任务。这会产生不明确的预期。

### Automation Gaps

- **review round 管理**：当前手动跟踪哪些 review 需要 v2、哪些 v1 已经通过。如果有一个自动化工具或流程来管理 review round 状态轮转，可以避免遗漏和重复 dispatch。
- **scope 内 vs scope 外问题过滤**：reviewer 看到旧代码问题也标记为 MUST FIX，但主 agent 应该只修本次变更引入的问题。没有自动化区分。
- **stash/restore 的 WIP 管理**：Phase 3 开始时 stash 了 4 个非本 plan 的文件，最后需要手动 pop。如果 workflow 能自动管理 stash 栈会更好。

### Time Sinks

- **审查轮次占 Phase 3 总时间的 ~60%**：编码本身约 40%（2 个 subagent + 1 次主 agent 修复），审查约 60%（4 轮 taste + 2 轮 standards + 2 轮 robustness + 2 轮 BLR + 1 轮 integration = 11 次 subagent dispatch）。对于 L1 项目来说审查/编码比例偏高。
