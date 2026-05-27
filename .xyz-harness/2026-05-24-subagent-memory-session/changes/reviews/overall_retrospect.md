---
phase: pr
verdict: pass
---

# Overall Retrospect — subagent-memory-session

覆盖全部 5 个 phase（spec → plan → dev → test → pr）的整体复盘。

## 1. Phase Execution Review

### 全局时间线

| Phase | 轮次 | 关键事件 |
|-------|------|---------|
| 1. Spec | 3 轮 review | 并发竞态问题两轮迭代才收敛；gate reviewer skill 缺陷导致额外重试 |
| 2. Plan | 1 轮 review | 一轮通过；做出 copyFileSync 替代 --fork 的关键决策 |
| 3. Dev | 1 轮 review | 零返工；plan 精确到代码片段级别，执行高度可预测 |
| 4. Test | 1 轮 | 10 TC 全通过；8 个 integration test 用静态代码追踪替代 |
| 5. PR | 1 轮 gate | 首次 gate 失败（缺 test_review_v1.md），补写后通过 |

### 全局 Summary

为 subagent 扩展新增 `memory` 参数，实现跨调用的持久化 session。总代码变更：3 个文件，+159/-8 行。PR 已创建（#2），gate 已通过。

整个 feature 从 spec 到 PR 历经 5 个 phase，执行效率总体良好。主要时间消耗在 Phase 1（3 轮 review）和 Phase 5（补充遗漏的 test_review），Phase 2-4 均一轮通过。

### 跨 Phase 的关键决策轨迹

1. **Spec 阶段**：memory 仅限 single 模式（经过 background 并发竞态的教训）
2. **Plan 阶段**：copyFileSync 替代 --fork CLI（路径控制需求）
3. **Dev 阶段**：session resolution 放 index.ts 而非 spawn.ts（API 可用性约束）
4. **Test 阶段**：静态代码追踪替代运行时测试（Pi 扩展运行时限制）
5. **PR 阶段**：无 CI 环境下以 pre-commit hook + 本地 lint 替代

这些决策都是合理的——每个决策都有明确的技术约束作为理由，没有"拍脑袋"的选择。

### 跨 Phase 的问题模式

1. **边界枚举不完整（Phase 1）**：并发竞态问题需要两轮 review 才收敛。根因是没有在第一时间枚举所有模式（single/background/parallel/chain）的 memory 适用性。这个教训在后续 phase 没有重犯。

2. **YAML frontmatter 格式反复出错（Phase 1-2）**：review 文件的 verdict/must_fix 嵌套在子对象里而非顶层。Phase 1 手动修复，Phase 2 在 task prompt 中显式要求后解决，Phase 3+ 不再出现。学习曲线合理。

3. **Gate 依赖的 review 文件不完整（Phase 5）**：gate 检查要求每个 phase 都有 `{phase}_review_v*.md`，但 Phase 4 只写了 `test_retrospect.md` 没有写 `test_review_v1.md`。这是因为 test skill 的指令中只有 retrospect 步骤没有 review 步骤——skill 定义本身缺少这个 deliverable。

### What Would You Do Differently（全局）

1. **Phase 1 就用模式枚举表格**：一个 4 行的表格（single/background/parallel/chain × memory allowed）可以避免两轮并发竞态迭代。
2. **每个 phase 开始前检查 gate 要求的 deliverable 清单**：Phase 5 的 gate 失败是因为 Phase 4 的 skill 没有要求 test_review，但 gate 期望它存在。如果提前了解 gate 的完整检查项，可以在 Phase 4 就补齐。
3. **为纯函数写独立的 Node.js 测试脚本**：`sanitizeMemoryId` 和 `resolveMemorySessionFile` 可以脱离 Pi 运行时测试，这能将 8 个静态追踪 TC 升级为可执行的自动化测试。

### 遗留风险

1. **运行时验证缺口**：`copyFileSync` → `--session` 的完整链路从未在真实 Pi session 中验证。合并后需要手动测试。
2. **Memory session 文件清理**：没有机制在主 session 被清理时同步清理 `.mem-*.jsonl` 文件。
3. **Sanitization 边界**：64 字符截断、空字符串、纯特殊字符等边界输入未测试。

## 2. Harness Usability Review

### Flow Friction

1. **Phase 5 gate 要求 Phase 4 的 test_review，但 Phase 4 skill 没有要求产出这个文件。** 这是一个 skill 间的 deliverable 定义不一致——gate 期望 `{phase}_review_v*.md`，但 test skill 只产出 `test_retrospect.md`。需要在 test skill 中增加 review 步骤，或在 gate 中放宽对 test phase review 的要求。

2. **Brainstorming skill 与 coding-workflow 的衔接有重叠。** 用户在正式进入 workflow 之前已经完成了需求探索和方案选择，但 brainstorming skill 要求从 Step 1 开始。对"已有设计讨论"的场景缺少快速入口。

### Gate Quality

1. **Gate check 脚本准确可靠**：5 个 phase 的 gate 检查都正确识别了 deliverable 的存在性和格式，无 false positive。
2. **Gate reviewer skill 缺陷（Phase 1）**：`xyz-harness-gate-reviewer` skill 未安装导致 gate 调用失败，但 gate script 本身已通过。这个不稳定的依赖应该被移除或改为可选。
3. **Review YAML 格式的严格检查是必要的**：嵌套 vs 顶层字段的问题在 Phase 1 就暴露，gate 正确拦截了格式错误的文件。

### Prompt Clarity

1. **Plan skill 的 L1/L2 复杂度评估标准清晰**，直接判定为 L1 简单路径。
2. **Test skill 的 `test_execution.json` 字段文档优秀**——字段类型、常见错误、完整示例都有，避免了格式错误。
3. **PR skill 的步骤足够清晰**——CI 预检、push、PR 创建、CI 等待、证据文件，每一步都有 bash 命令模板。

### Automation Gaps

1. **缺少 post-phase git 状态检查**：多个 phase 之间代码处于未提交状态，harness 没有机制检测。建议在每个 phase 结束时检查 `git diff --stat`。
2. **Review subagent 的 YAML frontmatter 格式不可控**：需要每次在 task prompt 中手动指定格式要求。应该作为 review 输出的默认行为，或由 gate 脚本自动修复。
3. **静态追踪 vs 运行时测试无 guidance**：Pi 扩展这类运行时依赖特殊的代码，无法执行 integration test。Harness 没有 guidance 说明何时可以用 code trace 替代。
4. **`test_review_v*.md` 的产出时机不明确**：gate 期望它存在，但 test skill 不要求产出。需要在 skill 定义中补齐。

### Time Sinks

1. **Phase 1 三轮 review**（约占全局 40% 时间）：并发竞态问题的边界逐步收紧。用模式枚举表格可以一轮解决。
2. **Phase 5 gate 首次失败**：补写 test_review_v1.md 后通过。如果 Phase 4 skill 要求了这个 deliverable，这步可以省掉。

### 总评

harness 工作流在这个中等偏低复杂度的 feature 上表现良好。5 个 phase 的边界划分清晰，每个 phase 的 deliverable 定义明确（除 test_review 的遗漏）。最有价值的环节是 Plan——精确到代码片段的 plan 使得 Dev phase 零返工。最需要改进的是跨 phase 的 deliverable 一致性检查，避免 downstream phase 的 gate 因为 upstream skill 的遗漏而失败。
