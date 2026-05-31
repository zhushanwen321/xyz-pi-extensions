---
phase: pr
verdict: pass
---

# Overall Retrospect: todo-v3-auto-clear-reminder

## 1. 全流程执行回顾

### Summary

5 个 Phase 全部完成。todo v3 新增了 3 个功能（自动清空、Todo Reminder、Verification Nudge），实际代码变更约 50 行，分布在 4 个 commit 中。整个工作流从调研到推送耗时约 2 小时，其中审查流程占时最多。

### 各 Phase 执行评估

| Phase | 耗时 | 核心产出 | 主要问题 |
|-------|------|----------|----------|
| 1. Spec | 中 | spec.md + 3 功能定义 + 调研矩阵 | OpenCode 调研错误，文件路径约定混淆 |
| 2. Plan | 短 | plan.md + 5 交付物 + 阈值 bug 修复 | `>= 2` vs `> 2` 边界争议首次出现，未同步修复 spec |
| 3. Dev | 长 | 50 行代码 + 10 次审查 subagent | Unicode 转义匹配失败；v1 审查 9 条 MUST_FIX 仅 2 条有效 |
| 4. Test | 短 | test_execution.json 8/8 pass | 文件名 glob 不匹配 |
| 5. PR | 短 | push + evidence | 无 CI pipeline；其他 topic 文件混入 |

### 跨 Phase 反复出现的问题

**1. `>= 2` vs `> 2` 边界争议（Phase 2 → 3）**

这是整个工作流中最大的摩擦点。Phase 2 reviewer 将 spec 的 `>= 2` 修正为 `> 2`（认为"保留 2 轮"语义上应保留 2 轮可见）。Phase 3 的 BLR 和 Integration Review 又改回 `>= 2`。最终按 reviewer 共识采用 `>= 2`。

根因：spec 中"保留 2 轮用户消息"表述有歧义。如果 Phase 1 用逐轮推演表格而非自然语言描述边界行为，这个争议不会发生。

**2. Gate 文件名匹配（Phase 3 → 4）**

taste review 文件命名为 `ts_taste_review_v2.md`，gate 脚本 glob `*taste_review_v*.md` 不匹配。需要在 Phase 4 额外复制一份。这是 subagent 文件命名自由度与 gate 脚本硬编码模式之间的冲突。

**3. 审查粒度与任务复杂度不匹配（Phase 3）**

L1 单文件 50 行修改，dispatch 了 10 次 subagent（5 步 v1 + 5 步 v2）。v1 的 9 条 MUST_FIX 中 7 条是已有技术债。投入产出严重不成比例。

### What would you do differently

1. **Spec 阶段用推演表格定义数值边界**：`allCompletedAtCount=N` → Round N+1 (diff=1, skip) → Round N+2 (diff=2, trigger)。一行表格消除所有歧义。
2. **Plan 阶段修复 spec 不一致**：发现 spec 错误时同步修正，不在 spec 和 plan 之间留下矛盾。
3. **L1 任务用单步 code review**：跳过 5 步专项审查，减少 8 次不必要的 subagent 调用。
4. **审查 task prompt 中明确文件命名规范**：`{review_type}_review_v{N}.md`，与 gate 脚本 glob 对齐。
5. **审查 task prompt 中区分新增代码 vs 已有技术债**：避免 reviewer 把历史债务标为 MUST_FIX。

### Key risks (post-merge)

- `>= 2` 的实际行为是"全部完成后第 2 条消息触发清空"（保留 1 轮可见），需要在实际使用中验证是否符合预期
- 无自动化测试覆盖，v3 逻辑正确性依赖代码审查
- `lastReminderCount` 与 Verification Nudge 共享，跨状态转换时有间接影响（理论分析无害，实际未验证）

---

## 2. Harness 体验评估

### Flow friction

**最大摩擦：5 步审查对 L1 任务过重。** 50 行代码触发 10 次 subagent 调用，且 78% 的 MUST_FIX 是无效噪声。这是流程设计和任务复杂度之间失配的典型案例。

**次要摩擦：文件命名约定不明确。** gate 脚本用 glob 匹配文件名，但 dispatch 审查 subagent 时没有强制指定文件名格式。导致 subagent 自由命名（`ts_taste_review` vs `taste_review`），gate 找不到文件。

### Gate quality

- Gate 在每个 Phase 都正确拦截了不合格的交付物（frontmatter 缺失、review verdict=fail、文件名不匹配、untracked files）。
- 无误报——所有 gate FAIL 都指向真实问题。
- 报错信息可以更友好：列出期望的文件名模式和实际存在的文件。

### Prompt clarity

- 5 个 Phase 的 skill 文档整体清晰，步骤可执行。
- **缺陷：缺少文件命名规范文档。** 审查文件、交付物文件的命名约定分散在 gate 脚本的 glob 模式中，没有集中说明。
- **缺陷：缺少"L1 快速路径"指引。** skill 假设所有任务都走 5 步审查，没有根据复杂度分级的机制。

### Automation gaps

1. **v1→v2 重审无自动化**：需要手动 dispatch 5 个 subagent，每个 task prompt 手写 v1 的问题摘要和修复状态。理想流程：gate FAIL → 自动 dispatch v2 重审，附带 v1 问题列表。
2. **文件命名校验无前置检查**：在 dispatch 审查 subagent 之前不检查文件名是否符合 gate glob 模式。
3. **技术债标记无机制**：没有"已知技术债"的标记让 reviewer 跳过已有代码的问题。

### Time sinks 排名

| 排名 | 时间消耗 | 原因 |
|------|----------|------|
| 1 | 10 次审查 subagent 调用 | L1 任务不应走 5 步审查 |
| 2 | `>= 2` vs `> 2` 争议（跨 2 个 Phase） | Spec 边界描述歧义 |
| 3 | Unicode 转义匹配失败（3 次 edit 尝试） | edit 工具限制，应直接用 Python |
| 4 | 文件名 glob 不匹配修复（2 次） | 命名约定不集中 |

### 改进建议（按优先级）

1. **P0: L1 快速审查路径** — 单步 code review subagent，跳过 5 步专项审查。预计节省 50%+ 工作流时间。
2. **P0: 文件命名规范文档** — 在 skill 或 CLAUDE.md 中列出所有 gate 期望的文件名模式，dispatch subagent 时强制指定。
3. **P1: Spec 边界条件推演模板** — 数值阈值必须用逐轮推演表格描述，禁止自然语言表述。
4. **P2: 技术债标记机制** — 在 plan.md 中标记已知技术债区域，审查 subagent 跳过这些区域。
5. **P2: Gate 错误信息增强** — 列出期望的 glob 模式和实际匹配到的文件列表。

---

## 总结

todo v3 功能实现简洁（50 行核心代码），工作流产出完整（spec → plan → code → test → PR 全链路）。主要效率损失来自审查粒度与任务复杂度的失配（L1 任务走了 L2+ 的审查流程）和 spec 边界条件的表述歧义（`>= 2` vs `> 2` 跨 2 个 Phase 争议）。建议优先实施 L1 快速路径和文件命名规范。
