# Review-Gate Phase 分析范式

用于分析每个 phase 的 review-gate 配置。每个 phase 独立分析，产出物为该 phase 的 review-gate 配置决策。

## 分析步骤

### ① 产出物分析

| 问题 | 选项 |
|------|------|
| 产出物是什么？ | 单文件文档 / 多文件文档 / 多文件代码 |
| 产出物复杂度？ | 低（几十行）/ 中（几百行）/ 高（千行级 + 多文件） |
| 出错概率？ | 低 / 中 / 高 |

产出物性质决定 reviewer 的审查粒度和 fix 的复杂度。

### ② Reviewer 配置

| 问题 | 选项 |
|------|------|
| 需要几个 reviewer？ | 1 个 / 多个 |
| 审查维度是否独立？ | 独立（可并行）/ 依赖（需串行） |
| 是否有复杂度分级（L1/L2）？ | 是（每级独立配置）/ 否 |
| 需要 agent.md 还是复用现有 SKILL.md？ | 新建 agent.md / 复用现有 |

**判断规则**：
- 单一产出物 + 低复杂度 → 1 个 reviewer
- 多维度独立审查（如代码的业务逻辑 vs 命名规范） → 多个 reviewer 并行
- 维度间有依赖（如 Integration 依赖 BLR 输出） → 分 batch，batch 内并行，batch 间串行
- 有复杂度分级 → 每个级别独立配置 reviewer 数量和节点

**Agent 文件规则 [MANDATORY]**：
- 每个 reviewer 必须有独立的 agent.md，禁止"复用 expert-reviewer + 不同 task prompt"模式
- task prompt 只注入简单差异化内容：文件路径、输出目录、round 编号、上一轮报告路径
- task prompt 不包含审查逻辑、审查步骤、输出格式定义——这些全部在 agent.md 中
- 唯一例外：审查逻辑完全相同（如 Phase 3 Dev 的 5 个专项 reviewer 已有独立 SKILL.md）

### ③ 节点配置

```
review 通过 → 直接结束（无 fix 节点，进入下一 gate 或 phase）

review 不通过：
  单 reviewer → 2 节点（review → fix）
  多 reviewer → 3 节点（parallel review → sync → fix）
```

**Sync 节点是否需要**：
- 1 个 reviewer → 不需要 sync（单份报告，无去重对象）
- 多个 reviewer → 需要 sync（去重 + 排序 + 依赖分析）

**Fix 节点统一约束**：
- 独立 subagent 执行（非主 agent），消除 confirmation bias
- 单 worker 串行修复（避免文件冲突）
- 修复完成 git commit（作为下一轮 re-review 的 checkpoint）

### ④ 循环终止条件

| 条件 | 行为 |
|------|------|
| must_fix = 0 | 通过 |
| 达到最大轮数 | 强制通过（警告） |
| 连续 2 轮 must_fix 不降 | 人工介入 |

最大轮数默认 3，可在 Phase 配置中调整。

### ⑤ 与现有流程的变更点

| 问题 | 答案 |
|------|------|
| 删除 SKILL.md 中哪些章节？ | review 相关章节 + Gate Handoff 章节 |
| 新增什么？ | "完成后调用 review-gate" 指导 |
| Retrospect 触发方式是否变化？ | phase-gate 通过后 fork session dispatch（统一） |
| Gate Handoff 是否自动化？ | 是，review-gate 通过后自动进入 phase-gate |

## 已分析结果

| 步骤 | Phase 1 Spec | Phase 2 Plan | Phase 3 Dev | Phase 4 Test |
|------|-------------|-------------|------------|-------------|
| ① 产出物 | 单文件文档 | 多文件文档（5-6 个） | 多文件代码 | 多文件测试代码 |
| ② L1 Reviewer | 1 个（spec-reviewer.md） | 1 个（plan-reviewer.md） | — | — |
| ② L2 Reviewer | — | 2 个（plan-reviewer.md + plan-bl-reviewer.md） | 5 个（现有 SKILL.md） | — |
| ③ L1 节点 | 2（review→fix） | 2（review→fix） | — | — |
| ③ L2 节点 | — | 3（parallel→sync→fix） | 3（parallel→sync→fix） | — |
| ④ 终止 | 3 轮 | 3 轮 | 3 轮 | 3 轮 |
| ⑤ SKILL.md 变更 | 删 Spec Review + Gate Handoff | 删 Self-Review + Plan Review + Gate Handoff | 删 Five-Step Review + Gate Handoff | 删 review 步骤 + Gate Handoff |

### Phase 2 Plan 详细分析

**产出物清单**：

| 文件 | L1 | L2 | 审查维度 |
|------|:---:|:---:|---------- |
| plan.md | ✅ | ✅（总纲+子文档索引） | 整体可行性、一致性、无 placeholder |
| e2e-test-plan.md | ✅ | ✅ | AC 覆盖、场景完整性 |
| test_cases_template.json | ✅ | ✅ | JSON 合法性、字段完整性 |
| use-cases.md | ✅ | ✅ | UC-AC 映射、流程完整性 |
| non-functional-design.md | ✅ | ✅ | 五维度覆盖 |
| plan-backend.md | ❌ | ✅ | 后端设计可行性 |
| plan-frontend.md | ❌ | ✅ | 前端设计可行性 |
| plan-api-contract.md | ❌ | ✅ | 前后端契约一致性 |
| interface_chain.json | ❌ | ✅ | 方法签名一致性、data flow 完整性 |

**Reviewer 配置**：
- L1: 1 个 plan-reviewer.md，审查全部 L1 交付物
- L2: 2 个 reviewer 并行
  - plan-reviewer.md：审查总纲 + 5 个通用交付物（整体可行性 + AC 覆盖 + Execution Groups 合理性）
  - plan-bl-reviewer.md：审查 interface_chain.json + 子文档 + use-cases（接口契约一致性 + 前后端对齐 + data flow 完整性）

**节点配置**：
- L1: review → fix（2 节点）
- L2: parallel review (plan-reviewer + plan-bl-reviewer) → sync → fix（3 节点）

**SKILL.md 变更**：
- 删除：Self-Review、Plan Review（含 plan_bl_review）、Gate Handoff
- 保留：ADR Evaluation Step（设计步骤，非 review）、交付物验证中的格式检查项
- 保留：Retrospect（触发方式改为 phase-gate 通过后 fork session）
- 新增：review-gate 调用指导

**Workflow script 执行逻辑**：
```
review-gate(phase=2, complexity=read from plan.yaml):
  if L1:
    while round <= 3:
      Node 1: agent(plan-reviewer.md) → review 报告
      if must_fix == 0: break
      Node 2: agent(fix-worker) → 修复 + git commit
  if L2:
    while round <= 3:
      Node 1: parallel(
        agent(plan-reviewer.md) → plan_review_v{N}.md
        agent(plan-bl-reviewer.md) → plan_bl_review_v{N}.md
      )
      Node 2: sync → fix-plan.md
      if must_fix == 0: break
      Node 3: agent(fix-worker) → 修复 + git commit
```

## 分析历史

| Phase | 分析轮次 | 关键决策 |
|-------|---------|---------|
| Spec | 第 1 轮 | 确认引入 review-gate；单 reviewer 无需 parallel/sync；2 节点配置 |
| Plan | 第 1 轮 | 修正产出物为多文件（非单文件）；发现 L1/L2 分级导致不同节点配置；plan-bl-reviewer 需独立 agent.md |
| Dev | 待分析 | — |
| Test | 待分析 | — |
