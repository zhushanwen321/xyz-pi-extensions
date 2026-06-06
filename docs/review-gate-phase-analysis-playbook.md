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
| 现有 SKILL.md 能否复用？ | 能 / 需新建 agent.md |

**判断规则**：
- 单一产出物 + 低复杂度 → 1 个 reviewer
- 多维度独立审查（如代码的业务逻辑 vs 命名规范） → 多个 reviewer 并行
- 维度间有依赖（如 Integration 依赖 BLR 输出） → 分 batch，batch 内并行，batch 间串行

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
| ① 产出物 | 单文件文档 | 单文件文档 | 多文件代码 | 多文件测试代码 |
| ② Reviewer | 1 个（spec-reviewer.md） | 1 个（plan-reviewer.md） | 5 个（现有 SKILL.md） | 1 个（test-reviewer.md） |
| ③ 节点 | 2（review→fix） | 2 | 3（parallel→sync→fix） | 2（review→fix） |
| ④ 终止 | 3 轮 | 3 轮 | 3 轮 | 3 轮 |
| ⑤ SKILL.md 变更 | 删 Spec Review + Gate Handoff | 删 Plan Review + Gate Handoff | 删 Five-Step Review + Gate Handoff | 删 review 步骤 + Gate Handoff |

## 分析历史

| Phase | 分析轮次 | 关键决策 |
|-------|---------|---------|
| Spec | 第 1 轮 | 确认引入 review-gate；单 reviewer 无需 parallel/sync；2 节点配置 |
| Plan | 待分析 | — |
| Dev | 待分析 | — |
| Test | 待分析 | — |
