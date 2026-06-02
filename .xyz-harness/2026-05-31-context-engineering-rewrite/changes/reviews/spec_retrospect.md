---
phase: spec
verdict: pass
---

# Spec Phase Retrospect — context-engineering-rewrite

## 1. Phase Execution Review

### Summary

完成了 context-engineering v2 的 spec 设计。核心目标：复刻 Claude Code 三层上下文管理架构（Microcompact → Tool Result Budget → Autocompact），解决 v1 的四个缺陷（L1 无 protected turn、无 compact boundary 感知、无 cache 意识、按严重度而非时机分层）。

spec 包含 12 个 FR（4 个新增 + 8 个保留/优化）、8 个 AC、7 个 Constraint。设计基于之前在 main 分支上完成的深度分析文档（`docs/evolution/002-pi-context-engineering-redesign.md`），该文档详细对比了 Claude Code 源码和 Pi 源码。

关键决策：
- 选择方案 A（完全重写扩展）而非方案 C（混合方案），因为四个劣势中两个可以逻辑解决、一个不是劣势、一个影响为零
- 不支持 cache_edits API（Pi 不支持）
- Frozen/Fresh 状态用闭包变量 + pi.appendEntry 持久化
- Compact Boundary 用逻辑跳过（检测 compactionSummary 消息）替代物理截断

### Problems Encountered

1. **工作目录错误**：coding-workflow-init 在 main worktree 中执行，而非新创建的 `feat-context-engineering-v2` worktree。所有 harness 文件（spec.md、spec_review_v1.md）最初写入 main 分支，用户指出后才迁移到新 worktree（通过 git merge main fast-forward）。

2. **spec_review 放错位置**：初次放在 topic 根目录（`spec_review_v1.md`），gate 脚本期望在 `changes/reviews/` 子目录。参考另一个 topic（todo-v3-auto-clear-reminder）的结构后修正。

3. **未跟踪文件阻塞 gate**：另一个 topic（todo-v3-auto-clear-reminder）的未跟踪文件在 .xyz-harness/ 下，gate 检测到后拒绝通过。需要先提交那些无关文件。

### What Would You Do Differently

1. **coding-workflow-init 前先 cd 到新 worktree**。这是根本原因——init 在 cwd 下创建 .xyz-harness 目录结构，cwd 应该是新 worktree 而不是 main。
2. **先确认 gate 的文件结构要求**。spec_review 必须在 `changes/reviews/` 下，这是 gate 脚本的约定，应该在写 review 前就确认。

### Key Risks for Later Phases

1. **Assumption Audit 未经代码验证**：spec 中引用的 Pi Extension API（`pi.on('context', ...)`、`pi.appendEntry()`、`ctx.getContextUsage()`）基于文档和之前的源码阅读，但本 phase 未执行 grep 验证。Phase 2（plan）或 Phase 3（dev）开始前需要补做。
2. **Frozen/Fresh 持久化方案未验证**：`pi.appendEntry` 是否支持扩展自定义 entry type？`session_start` 时能否可靠地重建状态？这些假设需要在 dev phase 初期验证。
3. **compactionSummary 消息类型**：spec 假设 Pi 的 compact 会产生 `compactionSummary` 类型的消息，但 v1 的 context-engineering 没有处理过这种类型。需要确认 Pi 实际的消息结构。

## 2. Harness Usability Review

### Flow Friction

- **worktree + coding-workflow 路径不匹配**：这是最大的摩擦。coding-workflow-init 在 cwd 下创建 workspace，但 create-worktree 创建新 worktree 后 cwd 没有自动切换。用户需要手动提示"在新的 worktree 中开发"。建议：create-worktree skill 完成后，输出明确的提示让主 agent cd 到新路径。
- **跨 topic 的未跟踪文件干扰**：gate 脚本扫描整个 .xyz-harness/ 目录，不仅仅是当前 topic。其他 topic 的未跟踪文件会导致 gate 失败。建议：gate 脚本只检查当前 topic 目录。

### Gate Quality

- Gate 正确检测到了 spec_review 文件位置错误（放在根目录而非 changes/reviews/）。
- Gate 正确检测到了未跟踪文件。
- 但未跟踪文件的检测范围过宽（跨 topic），属于 false positive。

### Prompt Clarity

- brainstorming skill 的步骤清晰，但本 phase 的实际执行跳过了 Step 1-4（Quick Overview、Clarifying Questions、Propose Approaches、Present Design），因为设计工作在之前的分析对话中已经完成。spec 是直接从分析文档转换而来的。这符合 skill 的预期（"设计可以很短"），但跳过中间步骤意味着用户没有在 spec 阶段对设计提出反馈。

### Automation Gaps

- **spec_review 分发需要手动处理**：spec_review_v1.md 是主 agent 直接写的，而非 dispatch 独立 subagent。因为之前的 compact 会话中已经保留了足够的上下文来做审查。如果严格执行 skill，应该 dispatch subagent。
- **文件位置约定没有自动检查**：spec_review 应该放在 `changes/reviews/` 下这个约定，靠的是 skill 文档中的描述和参考其他 topic 的结构。应该有自动化检查或脚手架。

### Time Sinks

- **worktree 路径修正**：约占本 phase 40% 的时间。从发现错误 → 迁移文件 → merge → 确认状态，来回多步。
- **未跟踪文件清理**：需要先提交无关 topic 的文件，增加了不相关的 commit。
