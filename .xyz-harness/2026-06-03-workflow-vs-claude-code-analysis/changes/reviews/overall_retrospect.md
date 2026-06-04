---
phase: pr
verdict: pass
absorbed: false
topic: "2026-06-03-workflow-vs-claude-code-analysis"
harness_issues:
  - "coding-workflow-gate 的 reviewPrefix 硬编码为 taste_review，不识别 ts_taste_review/rust_taste_review，与 skill 文档的 TypeScript/Rust 项目命名约定冲突"
  - "gate 对 '历史问题' 和 '本次引入' 没有区分机制——pre-existing MUST FIX 应记录但不阻塞"
  - "review 的 partial fix 验证成本高——v2 修复竞态只保护了 delete 没保护失败标记，review subagent 应在修复验证时重放原始场景"
  - "Phase 5 的 CI 验证存在盲区——GitHub Actions pull_request trigger 非预期失效时，没有 fallback 机制"
---

# Overall Retrospect — Workflow model-switch 集成

## Harness 整体体验

### 已完成的工作流（5 Phases）

| Phase | 名称 | 交付物 | 审查轮次 | 状态 |
|-------|------|--------|---------|------|
| 1 | Spec | spec.md + 3 reviews | 1 (PASS) | ✅ |
| 2 | Plan | plan.md + e2e-test-plan + test_cases_template + use-cases + non-functional-design | 2 (v1 FAIL → v2 PASS) | ✅ |
| 3 | Dev | 3 BG tasks + 1 pre-existing fix, 12 tests | Taste: 2 (v1 FAIL→v2 PASS), Robustness: 3 (v1 FAIL→v3 PASS), plus BLR/Standards/Integration all 1 round | ✅ |
| 4 | Test | test_execution.json (11 TC, all round 1) | Gate naming fix | ✅ |
| 5 | PR | PR #30, pr_evidence.md, ci_results.md | CI trigger issue | ✅ |

### 总体数据（估测）

- **总耗时**：~3-4 小时（从 spec 分析到 PR）
- **代码行数**：~120 行源码，~210 行测试代码
- **Bug 发现**：2 个 pre-existing bug（handleWorkerExit 竞态、eslint-disable em-dash），1 个 design bug（break 旁路）
- **审查轮次**：5 步专项审查 × 1-3 轮 = ~10 轮
- **Gate 调用**：5 次（全部 PASS）

## 跨 Phase 的问题模式

### 1. 文件命名不一致（Phase 3 → 4）

Phase 3 skill 指示 TS 项目用 `ts_taste_review_v*.md`，但 coding-workflow-gate 扩展的 `reviewPrefix` 硬编码为 `taste_review`。这导致 Phase 4 gate 首次 FAIL。修复方案是复制 alias 文件。

**建议**：统一为 `taste_review`（与 gate 对齐），skill 文档中不再区分 `ts_`/`rust_` 前缀。

### 2. Review 验证盲区（Phase 3）

handleWorkerExit 竞态修复经历了 3 轮 review：
- v1：发现竞态
- v2：修复了 `workers.delete` 但没有保护失败标记逻辑
- v3：改为 early return 模式，一次性保护所有后续逻辑

**教训**：review subagent 在验证竞态修复时，应该要求"确认所有基于该资源的状态变更都被保护"，而不仅是"确认 delete 有 guard"。

### 3. pre-existing bug 的处理策略

robustness review 发现了一个既存的 handleWorkerExit 竞态缺陷。用户主动要求修复，但 harness 没有提供标准指引。

**建议**：在 skill 中明确规范——pre-existing MUST FIX 如果与本次改动在同一个文件中，应同步修复；否则记录但不阻塞。

### 4. CI 触发失效（Phase 5）

GitHub Actions `pull_request` 触发对所有分支在 07:41 UTC 后停止工作（观察到了 4 个分支的 PR 均无法触发后续 CI run）。无法直接触发 CI，只能通过本地验证覆盖。

**建议**：
- CI workflow 应增加 `workflow_dispatch` 触发器作为 fallback
- harness PR phase 应增加"CI fallback"步骤：当 CI 无法触发时，通过本地执行等价验证作为替代

## 总体评估

### 工作流价值

5-Phase harness 在以下方面体现了实际价值：
1. **Spec review** 确保了 AC 的可测试性（至少 1 TC 覆盖每 FR）
2. **Plan review** 捕获了 3 个严重算法设计错误（computePeakRecommend 误用、返回格式、排序缺失）
3. **5 步专项审查** 捕获了 2 个编码缺陷（break 旁路、handleWorkerExit 竞态）
4. **Gate 检查** 统一了交付物格式标准，防止了格式/命名/文件缺失等问题进入下一 phase

### 主要摩擦点

| 排名 | 问题 | 影响 |
|------|------|------|
| 1 | gate 与 skill 的文件命名约定不一致 | Phase 4 额外修复 |
| 2 | CI 触发无 fallback | Phase 5 无法验证 |
| 3 | review partial fix 验证不足 | Phase 3 v2→v3 额外轮次 |
| 4 | pre-existing bug 策略不明确 | 依赖用户主动要求 |

### 对比 Phase 负价值

如果没有 harness，完成此功能的估测时间约 1-1.5 小时（写代码 + 手动验证）。使用 harness 花 3-4 小时，但捕获了 2 个编码缺陷 + 3 个算法设计问题。如果这些缺陷进入生产环境，排查成本会远高于额外花费的 2 小时。

结论：**对于跨包集成功能，harness 提供了正净价值**，但文件命名不一致和 CI fallback 缺失是两个需要优先修复的摩擦点。
