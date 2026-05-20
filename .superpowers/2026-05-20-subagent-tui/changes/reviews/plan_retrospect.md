---
phase: plan
verdict: pass
---

# Phase 2 Retrospect — subagent-tui

> 复盘分析师对 Phase 2 (plan) 全流程的回顾与评估，基于 plan.md、e2e-test-plan.md、test_cases_template.json、plan_review_v1.md、plan_review_v2.md、spec_retrospect.md。

---

## 维度一：Phase 执行质量

### 1. Plan 质量

**总评：高质量。** 8 个 task 粒度适中（单个 task 可由一个 subagent 完成），依赖关系清晰（T1→T2→T3→T4 主链，T5 依赖 T2，T6 依赖 T4，T7/T8 独立），Wave 编排逻辑正确。单文件约束被诚实面对——所有 task 串行执行，不伪并行。

**做得好的：**

- **Task 粒度控制**：最小 task（T7 getFinalOutput fix）只需改 1 个函数，最大 task（T4 render 重构）有明确的函数拆分和逐步迁移策略。中等复杂度（T8 temp cleanup）有完整的生命周期考虑（写入→清理→并发安全）。
- **代码级精度**：每个 task 包含具体代码片段而非伪代码。`renderSingleCollapsedText`、`renderChainCollapsedText`、`aggregateUsageFromViews` 等 helper 函数的提取降低了 T4 的认知负荷。
- **依赖显式化**：Dependency Graph & Wave Schedule 表格清晰体现了哪些 task 可以并行、哪些必须串行。
- **回归意识**：T4 明确保留 single/chain collapsed 的 tool call 显示（vs. 并行模式用表格），T8 意识到并行 agent 共享 temp dir 的删除冲突。这是好的失败模式预见。
- **Commit 节奏**：每个 task 配独立 commit，commit message 格式规范（`feat/fix/refactor` 前缀）。
- **AC 逐条覆盖**：plan.md 的 AC 对照表显示所有 8 条 AC 都被覆盖。

**计划中的问题（来自 review）：**

| 问题 | 严重度 | 根因 | 是否被 review 发现 |
|------|--------|------|-------------------|
| #1: ThrottleState.forceEmit() 逻辑错误 (`lastEmitTime = Date.now()` 使 shouldEmit 立刻返回 false) | MUST FIX | 未 trace `forceEmit` → `shouldEmit` 的完整时序链 | ✅ v1 |
| #2: Task 8 遗漏 2/3 的 rmdirSync 清理点（startBackgroundJob + cleanupJob） | MUST FIX | 未对 `rmdirSync` 做全源 grep 验证 | ✅ v1 |
| #3: "3 places" 描述不准确 | LOW | 措辞疏忽 | ✅ v1 |
| #4: renderParallelTable Total 行缺少零值判断 | LOW | renderParallelDetail 同步遗漏 | ✅ v1 |
| #5: renderParallelTable 中的 `totalParts` 死代码 | LOW | 改完后残留未清理 | ✅ v2 |
| #6: renderParallelDetail Total 行同样缺少零值判断 | LOW | renderParallelTable 已修，renderParallelDetail 未同步 | ✅ v2 |

**分析**：
- 2 条 MUST FIX 都是**"写了但没完全想清楚时序/生命周期"**类问题。forceEmit 是单 tick 时序问题（同一代码块内 `forceEmit` 后立即调用 `shouldEmit`，`Date.now()` 差 0ms），rmdirSync 是生命周期覆盖问题（只想到 `runSingleAgent` 的 finally 块，没 grep 另外两处调用）。这两类问题是 Plan 阶段最常见的缺陷模式。
- 2 条 LOW 是重构中的一致性问题（改了 A 忘了 B）。
- 没有"方向性错误"（如 task 顺序反了、依赖搞错、方案不可行）。这印证了 spec 阶段做充分调研的价值。

### 2. Review 流程有效性

**总评：非常有效。** review 流程在此案例中证明了其核心价值——**捕获了在 plan 中看起正确、但在实际代码中会出 Bug 的问题**。

**评审质量分析：**

| 维度 | 评价 | 证据 |
|------|------|------|
| 深度 | 优秀 | v1 评审 trace 了 forceEmit 的完整时序链（从 agent 完成到 emitParallelUpdate 到 shouldEmit），直指数据丢失根因 |
| 精确性 | 优秀 | rmdirSync 遗漏通过 `grep -n` 实际计数验证，精确到 3 处、行号 |
| 客观性 | 优秀 | 采用"不继承执行者上下文"原则，基于源文件独立判断 |
| 修正建议 | 高 | forceEmit 提供了替代方案比较（`lastEmitTime = 0` vs. `force` 参数），选了更简单的方案 |
| 再验证 | 到位 | v2 逐条验证了每处修复，包括 forceEmit 修复后的全新时序链分析 |

**值得注意的做法：**
- v1 评审中，MUST FIX 都附带了**"问题链路"**（producer-consumer trace），而不是说"这里不对"。这种表述让 plan 作者不仅能修复，还能理解为什么。
- v2 评审没有"为了找问题而找问题"——2 条新 LOW 是切实存在的代码质量问题（死代码 + 一致性遗漏），不是凑数。
- 评审保持了循环上限约束（2 轮→pass），不拖沓。

### 3. 交付物完整度

| 交付物 | 状态 | 质量评估 |
|--------|------|---------|
| plan.md | ✅ 完成 | 8 task + 2 轮 review 修正后稳定 |
| e2e-test-plan.md | ✅ 完成 | 8 个 scenario 覆盖全部 AC；有环境说明（manual testing in Pi TUI） |
| test_cases_template.json | ✅ 完成 | 14 个 test case，步骤级可执行；含回归测试（TC-8-01, TC-8-02） |
| plan_review_v1.md | ✅ 完成 | 结构化报告，YAML frontmatter 完整，含详细后端分析 |
| plan_review_v2.md | ✅ 完成 | 逐条验证，issue 继承和状态更新正确 |
| spec_retrospect.md | ✅ 完成（Phase 1） | 诚实评估 Phase 1 问题，建议已传递到 plan 阶段 |

**交付物完整度问题（跨阶段回顾）：**

| # | 问题 | 影响 | 是否应修复 |
|---|------|------|-----------|
| S1 | test_cases_template.json 的 AC 覆盖未显式标注（没有 AC 列） | 低 | 建议在 template 中加 AC 引用列，提升可追溯性 |
| S2 | plan_review H1 的 YAML 用了 `verdict` + `must_fix` 两个扁平字段 + 嵌套 `review.verdict`，有重复。`must_fix` 扁平字段未在 SKILL.md 的统一格式中要求。 | 低 | 不影响 gate check，但最好统一到 nested `review.verdict` |
| S3 | spec 到 plan 的 AC 传递是手动的——spec 没有显式 AC 章节，AC 是在 plan 中定义的。spec_retrospect 指出了这个问题但 plan 阶段没有回溯修复 spec。 | 中 | 如果后续要复用 spec，缺少标准 AC 章节会带来歧义 |

### 4. Review 发现的问题模式分析

**MUST FIX 的共同模式：producer-consumer 时序依赖被忽略。**

- **#1 (forceEmit)**：plan 作者只考虑了"forceEmit 要重置节流状态"的意图，没有 trace `forceEmit` → `emitParallelUpdate` → `shouldEmit` 的完整执行路径。这是一个**"同一 tick 内 read-after-write"**问题。
- **#2 (rmdirSync 遗漏)**：plan 作者只处理了 `runSingleAgent` finally 块中的 `rmdirSync`，但 `runSingleAgent` 还有 background job 分支，`startBackgroundJob` 和 `cleanupJob` 也有 `rmdirSync`。这是一个**"修改 A 时未扫描所有消费者"**问题。

**模式总结：**
1. **修改工具函数时，要 grep 所有调用点**（不只是直接调用，还有通过闭包/callback 间接使用的）。
2. **实现带有状态的辅助类（如 ThrottleState）时，要 trace 所有 public 方法的跨 tick 时序**。单看每个方法都正确，合起来可能出错。
3. **单文件修改看似简单，但 1754 行的文件中，生命周期路径分散在多个 goroutine-like 分支中（background job callback、parallel execution callback），容易遗漏。**

---

## 维度二：Harness 体验

### 1. Skill 流程顺畅度

| 环节 | 体验 | 说明 |
|------|------|------|
| Skill 触发 | ✅ 顺畅 | 直接按需加载 expert-reviewer skill，模式判断（plan_review）正确 |
| 输入准备 | ✅ 顺畅 | spec.md + plan.md + 源码，按 SKILL.md 要求准备即可 |
| 评审执行 | ✅ 顺畅 | 检查维度明确（spec 完整性/plan 可行性/一致性），逐项执行 |
| 问题标注 | ⚠️ 稍有摩擦 | MUST FIX 判定标准在实际执行中依赖 reviewer 的经验判断。SKILL.md 给了判断口诀（"生产环境会导致功能不可用或数据错误"），这很好，但 #1 的"数据丢失"判定需要 reviewer 自己想通时序链才能确认——规则只是 check，理解需要 domain knowledge |
| 报告输出 | ✅ 顺畅 | YAML frontmatter 格式统一，机器可读 |
| 轮次管理 | ✅ 顺畅 | v1→v2 流程清晰，上限约束保证了不陷入死循环 |

### 2. 卡顿点与瓶颈

**Bottleneck 1：Review 需要读源文件（高上下文负担）**

Expert-reviewer 在 plan_review 模式下需要读 spec.md + plan.md + **源文件**。本案中 `index.ts` 1754 行，reviewer 需要找到 `rmdirSync` 的精确位置、`runSingleAgent` 的 `currentResult` 初始化位置等，才能在 v1 评审中精确说 "3 处，line 684/765/887"。

虽然这保证了评审质量（不读源码无法发现 #2），但上下文成本高。对于 L1 单文件 plan，这种负担可以接受。如果 L2 多文件 plan 也需要 reviewer 读所有源文件，生产压力会很大。

**Bottleneck 2：行号引用漂移（跨 skill 问题）**

plan 中的行号引用（如 "~line 545"）是编写时的近似值。review 时 reviewer 需要自行 `grep -n` 确认精确位置。当源文件有多次 commit 后行号漂移，plan 的行号引用会逐渐失效。

**Bottleneck 3：跨轮次 issue 管理依赖 reviewer 手动维护**

v2 评审需要继承 v1 的 issues 列表，手动更新 `status` 和 `resolved_in_round`。目前没有任何自动化辅助。如果循环达到 3 轮，手维护 15+ 条 issue 会很容易出错。

**Bottleneck 4：Plan 作者与 Reviewer 之间的"责任鸿沟"**

Plan 作者写了一个看似正确的 `forceEmit()`，Reviewer 发现是错的。这很好。但问题是：**reviewer 为什么必须具备"一眼看出 forceEmit 时序错误"的熟练度？** 在这个案例中 reviewer 做到了，但如果 reviewer 本身不熟悉 `ThrottleState` 的 producer-consumer 模式呢？

### 3. 改进建议

**建议 1（高优先级）：在 plan 模板中要求"全源 grep"证据**

针对 #2（rmdirSync 遗漏）模式，建议在 plan task 的 modify 步骤模板中增加：

```
**目标检查：** 对所有被删除/替换/修改的标识符做全源 grep。
例如：`grep -n "rmdirSync" index.ts` → 3 处，需全部覆盖。
```

这样 plan 作者在执行 task 前自己就做了全量扫描。Reviewer 可以快速验证 grep 结果，不需要重新做一遍。

**建议 2（中优先级）：Shared state 类增加跨 tick 时序 trace 检查点**

针对 #1（forceEmit 时序）模式，建议在 review 的 check-0（通用检查）中增加：

```
**Shared State 时序检查：** 如果 plan 包含有状态辅助类（ThrottleState、队列、缓存等），
trace 所有 public method 的跨 tick 时序链，确认 read-after-write 是否跨 tick。
```

**建议 3（中优先级）：Review 工具化辅助**

考虑添加一个小脚本 `review-helper`，功能：
- `review-helper grep-index <pattern> <source-path>` → 输出匹配位置和行号
- `review-helper check-lines <plan-path> <source-path>` → 验证 plan 中的行号引用是否落在预期的函数范围内

目前这些靠 reviewer 手动做，效率低且容易遗漏。

**建议 4（低优先级）：标准化 YAML frontmatter 字段**

当前 SKILL.md 和评审产出之间存在 frontmatter 格式差异（v1 既有扁平 `verdict`/`must_fix` 又有嵌套 `review.verdict`）。建议 SKILL.md 统一明确——只允许一种格式（建议 nested，因为它可以扩展更多元信息）。

**建议 5（低优先级）：实现跨轮次 issue 管理的自动化**

如果 future 有更复杂的多轮 review，建议设计一个脚本读取 v{N}.md 的 YAML frontmatter → 合并修改 → 输出 v{N+1}.md 的 YAML。当前手动维护在小规模下可接受。

---

## 综合评价

| 维度 | 评分 | 说明 |
|------|------|------|
| **Plan 质量** | 8/10 | 8 task 结构清晰，AC 覆盖完整，但 2 条 MUST FIX 暴露了时序链和全量扫描的疏漏 |
| **Review 有效性** | 9/10 | 捕获了关键 bug，v2 验证彻底，独立性保持好 |
| **交付物完整度** | 9/10 | 全部产出，质量达标；test_cases 的 AC 标注和 spec AC 章节缺失是 minor 问题 |
| **Harness 流程** | 7/10 | 流程本身顺畅，但 reviewer 上下文负担重，缺少辅助工具（grep 验证、行号检查） |

**整体 verdict：pass**

Phase 2 的 plan 在 v1 中有 2 条 MUST FIX（均被 review 捕获并修复），v2 无 MUST FIX 通过。这是 review 流程成功运作的典型案例——发现了写 plan 时因"思路走太快"而漏掉的边界条件。Harness 本身表现良好，主要改进空间在工具化辅助减轻 reviewer 的负担。

**核心经验总结：**
1. 写 plan 时，碰到 "删除/替换" 操作 → 先 grep 全源确认所有调用点。
2. 写有状态辅助类 → trace 所有 public method 的完整时序链。
3. Review 不只是"检查 plan 对不对"，而是"检查 plan 在实际代码中是否真的正确"——这就是本案 review 的价值证明。

---

## 附件：两轮 review 问题生命周期

```
v1 (fail, 2 MUST FIX + 2 LOW + 1 INFO)
├── #1 MUST_FIX: forceEmit 时序错误    →  v2: resolved (lastEmitTime = 0)
├── #2 MUST_FIX: rmdirSync 遗漏        →  v2: resolved (3 处全覆盖)
├── #3 LOW: "3 places" 描述不准确      →  v2: resolved
├── #4 LOW: Total 行零值判断遗漏       →  v2: resolved
├── #5 INFO: 行号近似                  →  v2: open (预期内)
│
v2 (pass, 0 MUST FIX)
├── #5 LOW: renderParallelTable 死代码 →  open (建议实施前清理)
└── #6 LOW: renderParallelDetail 零值  →  open (建议实施前清理)
```
