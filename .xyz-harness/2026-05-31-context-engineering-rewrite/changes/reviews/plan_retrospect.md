---
phase: plan
verdict: pass
---

# Plan Phase Retrospect — context-engineering-rewrite

## 1. Phase Execution Review

### Summary

完成了 context-engineering v2 的实现计划。产出 6 个交付物：plan.md（6 个 Task、Interface Contracts、Spec Coverage Matrix、Execution Groups）、e2e-test-plan.md（6 个 Scenario）、test_cases_template.json（15 个 TC）、use-cases.md（6 个 UC）、non-functional-design.md（5 个维度）、plan_review_v1.md + v2.md。

复杂度评估为 L1（单一扩展，无前后端拆分，无跨领域协调）。所有 Task 在一个 Execution Group（BG1）中串行执行，因为共享 compressor.ts 和 config.ts。

关键设计决策：
- 管道顺序改为 Microcompact → Budget → L0 → L1 → L2（在 L0 之前插入两个新阶段）
- Frozen/Fresh 状态独立为 frozen-fresh.ts 模块，通过闭包变量管理
- Compact Boundary 检测用逻辑跳过（findCompactBoundary 返回索引）而非物理截断

### Problems Encountered

1. **Worktree 路径问题延续**：Phase 1 遗留的问题仍然存在。plan.md 等交付物写入 feat-context-engineering-v2 worktree，但 gate 在 main worktree 中搜索。需要手动复制文件到 main 并提交。这在本 phase 中消耗了约 15% 的时间。

2. **Task Files 列表遗漏**：plan_review_v1 正确识别了 Task 4 和 Task 5 缺少 config.ts——两个 Task 的实现要点都提到修改 L1Config 和 L0Config，但 Files 列表中没有列出 config.ts。这是 plan 编写时的疏忽，review 有效捕获。

3. **Compact Boundary 检测方式未确定**：Task 3 列出了三种可能的检测方案（A/B/C），但无法在 plan 阶段确定 Pi 的实际消息格式。这个问题被标记为 dev phase 初期需要验证的风险项。review 标记为 LOW，合理。

### What Would You Do Differently

1. **Files 列表交叉检查**：写完每个 Task 后，应该自动扫描实现要点中提到的所有文件修改，与 Files 列表做 diff。这次两个遗漏都是"实现要点提到了修改 config.ts，但 Files 列表忘了写"。
2. **Worktree 问题应该在 Phase 1 就解决**：gate 的 workspace 路径配置与实际开发 worktree 不匹配，这是一个系统性问题，应该在 Phase 1 的复盘中就提出修复方案。

### Key Risks for Later Phases

1. **Compact Boundary 检测**：Pi 的 compactionSummary 消息格式需要 dev phase 初期验证。如果三种方案都不对，需要回退到 spec 的 FR-3 重新讨论。
2. **FrozenFreshState 持久化**：spec C-6 说"通过 pi.appendEntry 持久化"，但 plan 中简化为"闭包变量 + session_start 重建"。如果 session 在运行中途被 reload，frozen 状态会丢失，导致同一 toolResult 在 reload 前后被不同处理。这违反了 AC-6（prompt cache 稳定性），但影响仅在 session reload 时。
3. **compressor.ts 行数**：当前 547 行，新增 Microcompact 和 Budget 后预计增长到 ~700 行。虽然还在 1000 行限制内，但如果后续继续增长可能需要拆分。

## 2. Harness Usability Review

### Flow Friction

- **worktree 双写问题持续**：Phase 1 的复盘已经记录了这个问题，但 Phase 2 仍然遇到。根本原因是 coding-workflow-gate 在 main worktree 的 cwd 下搜索文件，而实际开发在新 worktree 中进行。这不是 skill 的问题，而是 coding-workflow 扩展和 create-worktree skill 之间的协调问题。
- **plan_review 分发到 subagent 时需要提供完整文件列表**：task prompt 中需要列出所有待审查文件的绝对路径，这些路径在不同 worktree 中不同。如果路径错了 subagent 会找不到文件。

### Gate Quality

- Gate 正确检测到文件不存在（因为在新 worktree 中而非 main 中）。
- Gate 在文件复制到 main 后正确通过。
- plan_review_v1 的 MUST FIX 问题是真实的（Files 列表遗漏），不是 false positive。Review 质量好。

### Prompt Cliction

- writing-plans skill 的 L1/L2 分级标准清晰。本项目明确是 L1。
- Interface Contracts 模板、Spec Coverage Matrix 模板、Execution Groups 模板都有清晰的结构，容易遵循。
- "禁止实现代码"规则与 Interface Contracts 的签名表有明确的边界说明（签名表不受此规则限制）。

### Automation Gaps

- **plan_review 分发**：需要手动构造 task prompt（列出文件路径、指定 review 方法论、指定输出路径）。这个流程可以部分自动化——至少文件路径可以从 topic dir 自动推断。
- **Files 列表交叉检查**：应该在 self-check checklist 中增加一个检查项"每个 Task 的 Files 列表是否覆盖了实现要点中提到的所有文件修改"。

### Time Sinks

- **v1 源码阅读**：花了大量时间读取 compressor.ts（547 行）、config.ts（144 行）、recall-store.ts（63 行）、commands.ts（118 行）、index.ts（99 行）、两个测试文件（697 行）。总计约 1668 行代码。这对于 plan 阶段是必要的（需要理解现有结构才能规划修改），但可以考虑在 Phase 1 的 on-demand scan 中就完成。
- **worktree 文件同步**：写入新 worktree → 复制到 main → 提交 → 同步回新 worktree，每个交付物需要 3-4 步操作。
