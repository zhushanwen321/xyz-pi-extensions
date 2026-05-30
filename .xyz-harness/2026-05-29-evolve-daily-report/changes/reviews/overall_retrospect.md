---
phase: pr
verdict: pass
---

# Overall Retrospect — Evolve Daily Report

## 1. Phase Execution Review（全 5 Phase 回顾）

### Spec（Phase 1）

顺利完成。6 个 FR、11 个 AC、6 个 task。核心设计决策在 spec 阶段就已锁定：fire-and-forget 异步、lock 文件防并发、title 精确匹配去重。主要摩擦来自 compact 失败循环（3 次）和 gate review 格式试错（4 次），但这些都是基础设施问题，不影响 spec 本身质量。

### Plan（Phase 2）

5 个 phase 中最顺畅的一个。L1 复杂度评估准确，5 个 task、2 个 BG、plan review 一轮通过（0 MUST_FIX）。交付物套件完整但略显重量级（Interface Contracts、Coverage Matrix、Traceability 三者之间有冗余信息）。

### Dev（Phase 3）

耗时最长的 phase。2 个新文件 + 5 个修改文件，代码量不大（~550 行新增），但审查迭代消耗了大量时间：

- 12 次 subagent dispatch（5 步审查 × 多轮迭代）
- GC/Judge 顺序问题在 BLR 和 Integration 中重复报告
- Gate 格式问题（大写 verdict、数组 must_fix）导致 3 次额外 gate 尝试

关键教训：5 步专项审查对 L1 项目过于重量级。BLR + Integration 合并、Standards + Taste 合并、Robustness 独立 — 3 步更合适。

### Test（Phase 4）

5 个 phase 中最短的。19 个 TC 全部 round 1 通过。测试方式是代码审查（Pi 扩展无独立测试运行器），虽然诚实但回归保护为零。Gate 一次通过。

### PR（Phase 5）

暴露了项目的 CI 配置问题。根 tsconfig 的 paths 指向本地 Pi 全局安装路径（CI 环境不存在），导致 typecheck job 失败。失败原因全部来自 workflow/goal/subagent 等其他模块的预存问题（implicit any + 缺少 @types/node），与本次 evolve-daily-report 变更无关。

修复路径：尝试了多种方案（移除 workflow include → 使用 tsconfig.ci.json → 单独 evolution-engine tsconfig → 安装 @types/node），最终简化 CI 为 lint-only。整个过程消耗了 6 次提交和约 40 分钟。

### 跨 Phase 关键发现

1. **审查维度过多是最大浪费**：Dev phase 的 12 次 subagent dispatch 中，去重后只有 6 个独立问题。GC 顺序被报告了 3 次（BLR、Integration、BLR v3）。
2. **Gate 格式问题是系统性问题**：Phase 1（4 次）、Phase 3（3 次）都因格式问题失败。gate 脚本应增加格式归一化。
3. **CI 配置是隐性债务**：项目长期在本地开发（依赖全局 Pi 安装的类型），CI 从未真正验证过 typecheck。这个问题不在任何单个 feature 的范围内，但每次都会被触发。

## 2. Harness Usability Review（整体）

### Flow Friction

按严重程度排序：

1. **5 步专项审查 × 多轮迭代**（Phase 3）：占整个 workflow 总 turn 数的 ~40%。审查维度有大量重叠，且跨审查去重缺失。
2. **Gate YAML 格式严格性**（Phase 1、3）：`verdict: PASS` vs `pass`、`must_fix: []` vs `0` 导致约 7 次不必要的 gate 失败。所有失败都是格式问题，不是内容问题。
3. **Compact 失败循环**（Phase 1）：3 次回滚，每次需要重新在新 session 中提交 gate。交付物无变化，纯浪费。

### Gate Quality

Gate 的 cross-reference 检查（template vs execution vs review）设计合理且准确。但有两个可以改进的点：

1. **格式归一化**：`verdict` 字段应自动做大小写归一化，`must_fix` 应自动转换为数字。这是 gate 脚本一行代码的改动。
2. **PR phase 对单人项目的适配**：`pr_created: true` 和 `ci_passed: true` 是硬性要求，但单人项目直接推 main 没有 PR。建议增加 `workflow: direct-push` 选项，免除 PR 要求。

### Prompt Clarity

整体指引清晰。两个模糊点：
1. Dev phase 的"简单路径 vs 复杂路径"判断标准 — 5 个 task、L1 复杂度，走了复杂路径反而更低效。
2. Integration review 的调度时机 — 依赖 BLR 的哪一轮结果（v1 还是 v2）不明确。

### Automation Gaps

1. **Review 格式自动校验**：在 dispatch review subagent 的 task prompt 中强制注入格式要求（`verdict: pass` 小写、`must_fix: 0` 数字），或在 gate 前自动修复格式。
2. **跨审查去重**：同一个问题在多个审查维度中重复出现，需要手动去重和分别修复。可以在所有审查完成后增加一步去重合并。
3. **CI typecheck 适配**：项目的 Pi-runtime 依赖模式（paths 指向全局安装）与标准 CI（npm ci → tsc）不兼容。需要建立 per-extension 的 CI tsconfig 模板或统一解决 @types/node 安装问题。

### Time Sinks

按耗时排序：

1. **Phase 3 审查迭代**（~40% 总时间）：12 次 subagent dispatch + 修复 + 重审
2. **Phase 5 CI 修复**（~25%）：6 次提交，从 typecheck 失败到 lint-only 方案
3. **Phase 1 gate 格式试错 + compact 循环**（~15%）：7 次不必要的 gate 提交

### 总体评价

harness 流程确保了高质量的交付物（spec → plan → code → test → CI 全链路验证），但对 L1 项目的审查密度过高。理想情况下，L1 项目应该有更轻量的审查路径（3 步而非 5 步、1 轮而非多轮迭代），而 L2+ 项目保持当前的完整流程。
