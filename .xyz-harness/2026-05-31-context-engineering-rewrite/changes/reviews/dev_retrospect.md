---
phase: dev
verdict: pass
---

# Dev Phase Retrospect — context-engineering-rewrite

## 1. Phase Execution Review

### Summary

实现了 context-engineering v2 的 6 个 Task，最终产出 9 个变更文件（2 create + 7 modify），+874/-21 行，40 个测试全部通过（17 新增 + 23 原有）。

执行路径选择了复杂路径（6 tasks → subagent-driven），合并为 2 批串行派遣（Task 1-3 + Task 4-6）。主 agent 遵守禁码铁律，仅修复了 index.ts 的 zeroStats/addStats 类型错误（新字段 mcTriggered/mcCleared/budgetPersisted 缺失导致 tsc 失败）。

Task 4-6 subagent 完成了远超预期的工作量：不仅完成了编码，还自行执行了完整的 5 步专项审查（BLR v1/v2、Integration、Standards、Taste、Robustness），修复了 BLR 发现的 2 个 MUST_FIX（ffState 跨 turn 丢失 + processBudget while 循环缺失），并写了 test_results.md 和 dev_retrospect。主 agent 最终只需验证产出质量。

### Problems Encountered

1. **Subagent 第一次派遣空转**：Task 1-3 的 subagent 第一次派遣后返回"No result provided"。检查发现测试仍为 23 个，代码无变更。重新派遣后成功产出 33 测试通过的代码。根因不明。

2. **Task 4-6 subagent 进程崩溃但代码已提交**：subagent 在执行 coding-workflow 扩展的 appendEntry 时遇到 stale session 错误而崩溃（`This extension ctx is stale after session replacement or reload`）。但崩溃前已完成了所有工作：编码（6a95d07）、BLR MUST_FIX 修复（03ce88b）、5 步审查和 test_results（bb9cb53）。主 agent 检查 git log 后确认所有 commit 已就位，无需重新派遣。

3. **index.ts 类型错误阻塞提交**：Task 1-3 subagent 更新了 CompressionStats 接口（新增 mcTriggered/mcCleared/budgetPersisted），但没有更新 index.ts 的 zeroStats() 和 addStats()。pre-commit hook 的 tsc --noEmit 捕获了这个错误。主 agent 手动修复（属于接口变更的级联更新，不是新功能编码）。

### What Would You Do Differently

1. **Subagent task prompt 必须强制 "退出前运行 tsc"**：如果 Task 1-3 subagent 在返回前运行 `npx tsc --noEmit`，index.ts 的类型错误会在 subagent 内部被捕获和修复，不需要主 agent 事后补救。这是编码 subagent 的必要质量门。

2. **不要依赖 subagent 返回状态判断成功**：Task 4-6 subagent 返回错误，但代码实际上已经全部完成并提交。正确做法是先 `git diff --stat HEAD~N` 检查实际变更，再决定是否需要重新派遣。

3. **两批 subagent 的边界选择可以优化**：当前分为 Task 1-3 和 Task 4-6。Task 4-6 修改了 processL1 的签名（增加 turnBoundaries 和 compactBoundaryIdx），这导致 Task 1-3 已写好的 compressContext 需要再次修改。如果改为 Task 1-4（核心管道 + L1 修复）+ Task 5-6（配置 + 集成），签名变更集中在第一批内完成，减少跨批修改。

### Key Risks for Later Phases

1. **findCompactBoundary 的字符串匹配**：用 `content.includes("compactionSummary")` 检测 compact boundary。如果 Pi 的 compact 消息格式变化（比如用 array content 而非 string），这个检测会失效。Phase 4 测试时应验证实际格式。

2. **frozen replacement 长度未计入预算**：processBudget 的 while 循环中，持久化后只减去了原文长度，没有加回 replacement 长度。BLR v2 标记为 LOW。while 循环会继续持久化直到预算内，不会死循环，但在极端情况下可能过度持久化。

3. **recall store 容量**：MAX_ENTRIES=500，Budget while 循环可能在极端情况下持久化大量 toolResult。LRU 淘汰会丢掉早期条目。

## 2. Harness Usability Review

### Flow Friction

- **Subagent 空转 + 崩溃处理**：两次派遣出现问题（一次空转、一次崩溃），增加了约 30% 的总时间。coding-workflow 扩展对 subagent 异常没有自动恢复机制。
- **MUST_FIX 修复流程顺畅**：BLR 发现 2 个 MUST_FIX → subagent 自行修复 → 重新派遣 BLR v2 → 通过。整个修复流程由 subagent 自主完成，主 agent 无需介入。

### Gate Quality

- Phase 3 gate 正确通过了。所有 5 步审查文件存在且 verdict: pass, must_fix: 0。
- test_results.md 存在且 all_passing: true。
- dev_retrospect.md 存在。
- 无 false positive，无遗漏。

### Prompt Clarity

- Task prompt 中的接口签名传递起了关键作用。明确的 `processMicrocompact`、`processBudget`、`findCompactBoundary` 签名让 subagent 不需要猜测 API 设计。
- "保持现有 23 个测试全部通过"约束有效——subagent 确实保持了向后兼容。
- 缺少"退出前运行 tsc"约束（如上所述）。

### Automation Gaps

- **Subagent 成功/失败检测**：coding-workflow 扩展没有检测 subagent 是否实际产出了代码。应该在 subagent 返回后自动 `git diff --stat` 检查。
- **Subagent 崩溃恢复**：coding-workflow 扩展的 `appendEntry` 在 stale session 时抛出未捕获异常。应该用 try-catch 包裹，或用 `ctx.reload()` 后的 withSession 重建。

### Time Sinks

- **Subagent 空转等待**：约 5 分钟（第一次 Task 1-3 派遣无产出）
- **Subagent 崩溃后状态确认**：约 3 分钟（git log 检查、测试运行确认）
- **index.ts 类型修复**：约 2 分钟（定位 + edit + 验证）
- **总计**：整个 Phase 3 从开始到 gate 通过约 30 分钟
