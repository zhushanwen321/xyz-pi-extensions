---
phase: spec
verdict: pass
---

# Spec Phase Retrospect

## Phase Execution Review

### Summary

Spec 阶段产出了完整的 12 条 FR + 8 条 AC，覆盖 Todo 批量操作（add texts[] / delete ids[]）和 GoalManager 四态模型（completed boolean → status 四态 + complete_task → update_tasks 批量更新）。

两轮评审完成。第一轮发现 1 条 MUST_FIX（`update_tasks` 重复 taskId 行为未定义）、4 条 LOW、1 条 INFO。所有 MUST_FIX 和 LOW 在第二轮前修复并通过复查。

### Problems Encountered

**批量操作的冲突场景设计遗漏。** FR-5 在首轮评审中被发现 `updates` 数组内同一 taskId 出现多次时行为完全未定义。这是批量操作的基本保底设计，遗漏意味着实现者会按直觉选择策略，导致不可预期行为。Review v1 正确识别了这一风险，修复采用了"整体报错"策略，与 FR-5 已有的"不存在 taskId 整体报错"、"无 evidence 整体报错"保持一致。

**4 条 LOW 集中在边界条件模糊：** FR-2 delete 重复 ID、FR-5 非 completed 时 evidence 忽略无 AC 覆盖、FR-1 空白字符串判断、FR-2 已删除 ID 的交互。这些问题不影响主线功能，但会导致实现时隐含假设。全部在第二轮前修复。

### What Would You Do Differently

**批量操作 spec 应首先列出"冲突矩阵"。** 如果在写 FR-5 时先画一张"输入组合 → 预期行为"的决策表（重复 taskId / 不存在 taskId / 无 evidence / 终态任务），而不是逐条列举约束，MUST FIX 可能根本不会出现。批量 API 的歧义空间远大于单条 API，冲突矩阵是比文字约束更可靠的规格化手段。

**FR-1 的 `trim()` 判断应在初稿就写。** "空白字符串算不算空"是经典边界，每次都要在 review 中补一笔，不如列为 checklist 常量。

### Key Risks for Later Phases

1. **四态传播的完整性。** FR-4 到 FR-12 涉及 state.ts、templates.ts、widget.ts、budget.ts、index.ts 五个文件的同步修改。plan 阶段需要确保每个文件的每个 `completed` 引用都被发现并替换，遗漏任何一处会导致行为不一致。
2. **不做向后兼容的决定。** FR-11 明确不处理旧 `completed: boolean` 格式。如果测试环境中存在旧 session 数据，deserializeState 会静默丢弃，表现为"goal 丢失"。dev 阶段需要确认这不会影响开发调试体验。
3. **Todo 的 error-success pattern 与 Goal 的 throw Error 模式并存。** Spec 约束明确不改错误处理模式，但批量操作的错误信息需要更精确（报告哪个 ID 有问题、哪个 taskId 冲突），两种模式的信息丰富度可能不一致。

---

## Harness Usability Review

### Flow Friction

无明显摩擦。Spec 阶段的流程是：写 spec → review v1 → 修复 → review v2 → pass。两轮评审的节奏自然，第一轮的 MUST FIX 确实需要一轮修复才能通过，不存在为走流程而走流程的情况。

### Gate Quality

Review v1 的 MUST FIX 判定准确。`update_tasks` 重复 taskId 是真实的设计空白，不是过度审查。4 条 LOW 的优先级也合理——它们是边界模糊而非功能缺失，不阻塞但值得在 spec 阶段就明确。

Review v2 的逐项核查结构清晰，每个 issue 都有"原描述 → 核查 → 结论"三段，避免了"扫一眼就 pass"的形式主义。INFO (#6) 未处理被正确标注为"可接受"。

### Prompt Clarity

无问题。spec 的评审 prompt 覆盖了完整性、一致性、枚举覆盖三个维度，reviewer 产出了 AC 覆盖矩阵，质量高于一般的 code review。

### Automation Gaps

Review 文件中 `timestamp` 字段是手动填写的占位值（`"2026-05-22T12:00:00"`），实际场景中需要自动注入。目前不影响内容质量，但如果回顾时间线会很模糊。

### Time Sinks

无明显时间沉没。两轮评审 + 修复的总工作量与 spec 复杂度（12 FR / 8 AC / 6 文件）匹配。唯一可以更快的地方是前面提到的"先写冲突矩阵"，可以省掉一轮 review。
