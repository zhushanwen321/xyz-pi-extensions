---
review:
  type: plan_review
  round: 1
  timestamp: "2026-06-01T18:00:00"
  target: ".xyz-harness/2026-06-01-merge-harness-extensions-monorepo/spec.md + plan.md + e2e-test-plan.md + use-cases.md + non-functional-design.md"
  verdict: fail
  summary: "计划评审第1轮，1条MUST FIX（Task 5 bash脚本将独立skills错误复制到coding-workflow），需修改后重审"

statistics:
  total_issues: 8
  must_fix: 1
  must_fix_resolved: 0
  low: 5
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 5 Step 1 (bash loop)"
    title: "Task 5 bash 循环将独立 skills 错误复制到 packages/coding-workflow/skills/"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "plan.md:Task 7 Step 1 (git mv 路径)"
    title: "Task 7 git mv 使用 packages/../../ 倒退路径，易出错"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "plan.md:Task 5 描述"
    title: "Skill 数量标注 28 个但实际循环中为 29 个"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "plan.md:Task 5/Task 7"
    title: "AC-9 CP-3 检查点无显式验证步骤"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "plan.md:BG3"
    title: "BG3 文件数约 35 个目录，超出每组 ≤10 文件的指导原则"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "e2e-test-plan.md:TS-3.5 vs spec.md:FR-3"
    title: "E2E 测试说 19 个 harness skill，spec 说 ~20 个，数量不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: INFO
    location: "plan.md:Task 5 Step 2 & Task 7 Step 2"
    title: "resources_discover 代码在 Task 5 和 Task 7 中重复"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: INFO
    location: "plan.md (全局)"
    title: "未说明 harness 仓库的 git 历史是否/如何保留"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-06-01 18:00
- 评审类型：计划评审（spec + plan + e2e-test-plan + use-cases + non-functional-design）
- 评审对象：`.xyz-harness/2026-06-01-merge-harness-extensions-monorepo/` 全部交付物

---

## 一、Spec 完整性

### 目标清晰度 ✅

目标明确：将 xyz-pi-extensions 和 xyz-harness-engineering 两个仓库合并为 pnpm workspaces monorepo，每个 extension 作为独立 npm 包发布。一段话说清楚了。

### 范围合理性 ✅

范围有明确边界：
- IN: 12 个 extension、~30 个 skill、7 个 agent、2 个 command、文档合并
- OUT: todolist（FR-6 不迁入）、edit-whitespace-normalizer（FR-7 删除）
- 约束明确列出（Constraints 1-7），特别是"不改变运行时行为"这条约束约束了重构的范围

### 验收标准可量化 ✅

AC-1 到 AC-9 大部分可量化：
- AC-1/AC-6: 命令行验证（pnpm install/typecheck）
- AC-2: changeset dry-run + resources_discover 存在性
- AC-3: 文件/目录存在性检查
- AC-4/AC-5: grep 验证无残留引用
- AC-7: Pi CLI 交互验证
- AC-8: GitHub 归档状态
- AC-9: 里程碑检查点

AC-7 的"基础流程"略模糊，但结合 Task 11 的具体验证步骤（gate tool、goal_manager、subagent single），可操作。

### 待决议项 ✅

无 `[待决议]` 项。

---

## 二、Plan 可行性

### 任务拆分 ✅

12 个 Task，每个有明确的 steps 和文件变更列表。粒度适中：
- Task 1-2（基础设施 + 迁移）：机械操作
- Task 3-4（harness extension 迁移）：文件复制 + package.json 创建
- Task 5/7/8（skills 迁移）：批量文件复制 + 事件注册代码
- Task 6（subagent 去重）：唯一的代码改动任务，有签名差异分析
- Task 9-10（文档 + 配置）：文件复制 + JSON 更新
- Task 11-12（验证 + 归档）：无文件变更

### 依赖关系 ✅

依赖链清晰：BG1 → BG2 → BG3 → BG5，BG4 与 BG3 可并行。关键路径 Task 6（subagent 去重）正确地排在 Task 3（coding-workflow 迁移）之后。

### 工作量估算 ✅

总体合理。最大风险点 Task 6 已有差异分析和适配策略说明。

### 遗漏 Task 检查 ⚠️

见 Issue #4（CP-3 无显式验证步骤）。

---

## 三、Spec 与 Plan 一致性

逐条对照：

| Spec 需求 | Plan Task | 状态 |
|-----------|-----------|------|
| FR-1 (Monorepo 结构) | Task 1, 2 | ✅ |
| FR-2 (npm 包) | Task 2, 10 | ✅ |
| FR-3 (Skills 内嵌) | Task 5, 7 | ✅ |
| FR-4 (独立 Skills) | Task 8 | ⚠️ 见 Issue #1 |
| FR-5 (Subagent 去重) | Task 6 | ✅ |
| FR-6 (todolist 不迁入) | 无需 task | ✅ |
| FR-7 (normalizer 删除) | 无需 task | ✅ |
| FR-8 (版本管理) | Task 10 | ✅ |
| FR-9 (共享类型) | Task 2 | ✅ |
| AC-1 到 AC-9 | 覆盖矩阵完整 | ✅ |

Plan 中无 spec 未提及的额外工作。

---

## 四、Execution Groups 合理性

### 分组合理性 ⚠️

BG3（Task 5, 7, 8）约 35 个目录，超出每组 ≤10 文件的指导原则（Issue #5）。但这些是机械的文件复制操作，无复杂逻辑，拆分的收益不大。标记为 LOW。

### 类型划分 ✅

所有 Task 标注为 backend，无前端 Task。纯结构重构，划分合理。

### 功能关联度 ✅

- BG1: 基础设施 + 迁移，关联紧密
- BG2: harness extension + 去重，关联紧密
- BG3: skills/agents/commands，同属资源迁移
- BG4: 文档 + 配置，同属收尾
- BG5: 验证 + 归档，同属收尾

### 依赖关系 ✅

BG3 依赖 BG2（coding-workflow 目录存在），BG4 依赖 BG1，BG5 依赖全部。正确。

### Wave 编排 ✅

实际执行顺序 BG1 → BG2 → BG3 + BG4 → BG5 正确处理了 BG2→BG3 的依赖。Wave 表中 Wave 2 同时包含 BG2/BG3/BG4 但注明了 BG2 必须先于 BG3，与实际执行顺序一致。

### Subagent 配置完整性 ✅

每组包含 Agent、注入上下文、读取文件、修改/创建文件。

### 上下文充分性 ✅

注入上下文包含 spec 相关 FR/AC + plan task 完整描述，subagent 可独立执行。

---

## 五、E2E Test Plan 检查

测试场景 TS-1 到 TS-8 覆盖了全部 AC（AC-1 到 AC-8）。每个 TS 有明确的验证命令和预期结果。测试环境前置条件清晰。

---

## 六、Use Cases 检查

4 个用例覆盖了核心场景：
- UC-1: 跨仓库改动（核心价值）
- UC-2: 用户安装扩展
- UC-3: 版本发布
- UC-4: Skill 迁移流程

UC 覆盖映射表完整，每个 UC 都关联了对应的 AC。

---

## 七、Non-Functional Design 检查

5 个维度（稳定性、数据一致性、性能、业务安全、数据安全）均有分析。其中"不适用"的维度（数据一致性、数据安全）有合理解释——纯结构重构不涉及持久化状态和敏感信息。性能分析给出了具体量化（< 10ms）。

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plan.md:Task 5 Step 1 (bash loop) | Task 5 bash 循环将独立 skills（create-worktree、merge-worktree 等 10 个）复制到 `packages/coding-workflow/skills/`，但 task 自身的注释（"注意：独立 skills 在 Task 8 中单独迁入 skills/ 目录，不放在 packages/coding-workflow/skills/ 下"）和 FR-4 都明确独立 skills 应放到根 `skills/` 目录。如果按 bash 脚本执行，独立 skills 会被复制到 coding-workflow/skills/，导致：1) coding-workflow 的 `resources_discover` 注册这些不属于它的 skills；2) Task 8 再次复制到 `skills/`，导致 Pi 运行时同一 skill 被注册两次 | 从 Task 5 Step 1 的 for 循环中移除独立 skills（create-worktree、merge-worktree、remove-worktree、code-review-worktree、zcommit、browser-automation、code-link、meta-sk-agent-writer、meta-sk-skill-writer、vision-analysis），只保留 coding-workflow 所属的 19 个 harness skills |
| 2 | LOW | plan.md:Task 7 Step 1 (git mv 路径) | `git mv packages/../../skills/evolve` 使用倒退相对路径。虽然路径解析正确（等价于 `skills/evolve`），但对 subagent 来说可读性差，容易误操作 | 改为从项目根目录执行的绝对/简单相对路径：`git mv skills/evolve packages/evolve-daily/skills/evolve` |
| 3 | LOW | plan.md:Task 5 描述 | Task 5 描述说"完整 skill 清单（28 个）"，但 for 循环实际包含 29 个 skill（19 coding-workflow + 10 independent） | 将描述改为"29 个"或改为"19 个"（仅 coding-workflow 所属），与修正后的 bash 循环保持一致 |
| 4 | LOW | plan.md:Task 5/Task 7 | AC-9 CP-3（"skills 迁入后，coding-workflow 的 resources_discover 正确注册所有内嵌 skills"）在 Spec Coverage Matrix 中对应 Task 5, 7，但这两个 Task 都没有显式的 CP-3 验证步骤。虽然 Task 11 的功能回归会隐式验证，但缺少中间检查点 | 在 Task 5 Step 3 之后、Task 7 Step 4 之后各添加一个 CP-3 验证步骤：启动 Pi 加载 coding-workflow/evolve-daily，检查 skill 列表是否包含所有内嵌 skills |
| 5 | LOW | plan.md:BG3 | BG3 包含 ~35 个目录，超出每组 ≤10 文件的指导原则 | 考虑将 BG3 拆分为 BG3a（coding-workflow skills + agents + commands）和 BG3b（evolve skills + independent skills）。不过考虑到这些都是机械复制操作，不拆分也可接受 |
| 6 | LOW | e2e-test-plan.md:TS-3.5 vs spec.md:FR-3 | E2E 测试 TS-3.5 说"19 个 harness skill 目录"，spec FR-3 说"~20 个 harness skills"。实际 Task 5 列出 19 个 coding-workflow 专属 skills | 统一为 19 个（spec 中的 ~20 是约数，plan 中明确列出了 19 个） |
| 7 | INFO | plan.md:Task 5 Step 2 & Task 7 Step 2 | resources_discover 事件注册代码在 Task 5 和 Task 7 中几乎完全相同（扫描 __dirname/skills/、过滤 SKILL.md、emit resources_discover）。迁移完成后可提取为共享 utility | 不阻塞。迁移完成后可考虑提取共享函数 |
| 8 | INFO | plan.md (全局) | Plan 未说明是否/如何保留 harness 仓库的 git 历史到 monorepo。spec 只提到"在 harness 仓库打 release tag"（Task 12 Step 1），但 monorepo 中是否需要 merge harness 的 git history 不确定 | 如果需要保留历史，可考虑 `git remote add harness <url> && git fetch harness && git merge --allow-unrelated-histories harness/main`。如果不需要保留历史，在 spec 中明确说明 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

### 结论

需修改后重审。

### Summary

计划评审完成，第1轮，1条MUST FIX（Task 5 bash脚本将独立skills错误复制到coding-workflow/skills/），需修改后重审。
