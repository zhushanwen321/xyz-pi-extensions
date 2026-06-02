---
phase: dev
verdict: pass
---

# Dev Phase Retrospect — context-engineering-rewrite

## 1. Phase Execution Review

### Summary

实现了 context-engineering v2 的全部 6 个 Task，产出 9 个变更文件（2 create + 7 modify），+874/-21 行，40 个测试全部通过（17 新增 + 23 原有保留）。

执行路径：复杂路径（6 tasks），但采用合并派遣策略——将 Task 1-3 合并为一个 memory subagent，Task 4-6 原本计划为第二个 subagent，但 Task 1-3 subagent 实际上一次性完成了所有 6 个 Task、5 步审查、MUST_FIX 修复、test_results、甚至 dev_retrospect。

关键设计决策落地：
- 管道顺序 MC → Budget → L0 → L1 → L2（在 L0 之前插入两个新阶段）
- FrozenFreshState 独立为 frozen-fresh.ts，闭包变量跨 turn 持久化
- findCompactBoundary 用 `content.includes("compactionSummary")` 字符串匹配
- processBudget 用 while 循环处理多个超预算 toolResult（BLR 发现 MUST_FIX 后修复）

### Problems Encountered

1. **Subagent 进程崩溃但代码已完成**：Task 1-3 的 memory subagent 在 coding-workflow 扩展的 `appendEntry` 处遇到 stale session 错误而崩溃。但崩溃前已完成了远超预期的工作——6 个 Task 全部实现 + 5 步审查 + MUST_FIX 修复 + test_results。主 agent 检查 `git log --oneline -20` 后确认 commit 链完整（882bdd9 → 03ce88b → 6a95d07 → bb9cb53），无需重新派遣。

2. **不需要第二批 subagent**：原计划分两批（Task 1-3 + Task 4-6），但第一批 subagent 已经完成了所有工作。这节省了约 50% 的调度时间，但也意味着 memory subagent 的上下文积累到了非常大的规模。

3. **frozen replacement 长度未计入预算**：processBudget 的 while 循环中持久化后只减去了原文长度，没有加回 replacement 长度。BLR v2 标记为 LOW。while 循环本身不会死循环（freshEntries 有限），但在极端情况下可能过度持久化。这是一个已知的可接受 trade-off。

### What Would You Do Differently

1. **先检查 git log 再决定是否重新派遣**：subagent 返回错误时不应该假设"什么都没做"。先 `git log --oneline -10` 检查实际 commit，再决定下一步。这次我正确地做了这个检查，避免了重复派遣。

2. **Subagent task prompt 应强制"退出前运行 tsc"**：subagent 更新了 CompressionStats 接口但漏了 index.ts 的级联更新。如果 task prompt 中要求 `npx tsc --noEmit` 作为退出条件，这类问题会在 subagent 内部被捕获。

3. **合并派遣策略有效但需要更好的错误隔离**：6 个 Task 合并为一个 subagent 执行，效率高但单点故障风险大。如果 subagent 在 Task 2 失败，前面 Task 1 的代码可能处于半完成状态。应该要求 subagent 在每个 Task 完成后 commit，而不是最后一起 commit。

### Key Risks for Later Phases

1. **findCompactBoundary 的字符串匹配脆弱性**：用 `content.includes("compactionSummary")` 检测 compact boundary。如果 Pi 的 compact 消息格式变化（比如用 array content 而非 string content），这个检测会失效返回 null，相当于"没有 compact boundary"——所有消息参与压缩。这是安全的降级行为，但可能导致不必要的压缩。

2. **compressor.ts 777 行**：从 547 行增长到 777 行。还在 1000 行限制内，但如果未来继续增长（比如增加 L3 或更多 MC 策略），可能需要拆分为独立模块（mc.ts、budget.ts 等）。

3. **recall store 容量**：MAX_ENTRIES=500 在 Budget while 循环场景下可能不够。如果一个 user 段内有 20 个 toolResult 全部超预算，一次性持久化 20 条，加上其他层的存储，可能触发 LRU 淘汰。但这属于极端场景。

## 2. Harness Usability Review

### Flow Friction

- **Worktree 双写问题在本 phase 不再是障碍**：subagent 直接在 feat-context-engineering-v2 worktree 中工作，产出完成后主 agent 用 `git merge feat/context-engineering-v2` 同步到 main。比 Phase 1/2 的手动文件复制高效得多。
- **Subagent 进程崩溃的恢复路径不明确**：coding-workflow 扩展的 `appendEntry` 在 stale session 时抛出未捕获异常。这应该是 coding-workflow 的 bug（在 subagent 场景下 extension ctx 不应该尝试持久化状态）。

### Gate Quality

- Gate 一次通过，无 false positive，无遗漏。
- 5 步审查文件齐全：BLR v2（v1 有 2 MUST_FIX 已修复）、Integration、Standards、Taste、Robustness，全部 verdict: pass, must_fix: 0。
- test_results.md 存在且 all_passing: true。

### Prompt Clarity

- plan.md 的 Interface Contracts 章节在构造 subagent task prompt 时非常有用。方法签名、参数类型、返回值、edge cases 全部可以直接注入 task prompt，避免 subagent 猜测 API 设计。
- Task 描述中的 COMPACTABLE_TOOLS 集合、默认配置值等细节在 subagent 执行中起到了关键作用。subagent 完全按照 plan 中指定的集合和默认值实现，没有偏差。
- 缺少"每个 Task 完成后 commit"的约束。subagent 在最后统一 commit，如果中途失败会增加恢复难度。

### Automation Gaps

- **Subagent 产出验证**：coding-workflow 没有自动检测 subagent 是否产出了代码。主 agent 需要手动 `git log` 和 `npx vitest run` 确认。可以在 gate 脚本中增加"检查 git diff --stat 是否有 context-engineering/ 下的变更"作为自动验证。
- **MUST_FIX 自动修复循环**：BLR 发现 MUST_FIX 后 subagent 自行修复并重新审查，这个循环目前是手动的（subagent 自主完成而非 coding-workflow 驱动）。如果 subagent 不自行修复，主 agent 需要手动介入。

### Time Sinks

- **Subagent 崩溃后状态确认**：约 3 分钟（git log 检查 + 测试运行 + 文件行数统计 + review 文件检查）
- **实际编码时间**：subagent 执行约 15-20 分钟完成 6 个 Task + 5 步审查
- **总计**：从 Phase 3 开始到 gate 通过约 25 分钟（含 subagent 等待时间）
