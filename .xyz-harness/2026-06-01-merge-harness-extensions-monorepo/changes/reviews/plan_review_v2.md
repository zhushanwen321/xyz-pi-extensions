---
review:
  type: plan_review
  round: 2
  timestamp: "2026-06-01T19:30:00"
  target: ".xyz-harness/2026-06-01-merge-harness-extensions-monorepo/spec.md + plan.md + e2e-test-plan.md + use-cases.md + non-functional-design.md"
  verdict: pass
  summary: "计划评审第2轮，v1 MUST_FIX #1 已修复，0条 open MUST_FIX，通过"

statistics:
  total_issues: 10
  must_fix: 0
  must_fix_resolved: 1
  low: 6
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 5 Step 1 (bash loop)"
    title: "Task 5 bash 循环将独立 skills 错误复制到 packages/coding-workflow/skills/"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
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
    title: "Skill 数量标注已修正为 19 个，与 for 循环一致"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
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
  - id: 9
    severity: LOW
    location: "plan.md:Task 5 Step 1 (L402-405)"
    title: "Task 5 Step 1 有 markdown 格式错误（重复的 ```bash 开头和游离的 mkdir 行）"
    status: open
    raised_in_round: 2
    resolved_in_round: null
  - id: 10
    severity: LOW
    location: "plan.md:Task 8 Files 描述 (L620)"
    title: "Task 8 Files 描述说「7 个独立 skill」但实际 for 循环包含 10 个"
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# 计划评审 v2

## 评审记录
- 评审时间：2026-06-01 19:30
- 评审类型：计划评审（增量审查模式）
- 评审对象：`.xyz-harness/2026-06-01-merge-harness-extensions-monorepo/` 全部交付物

---

## 增量审查：v1 MUST_FIX 修复验证

### [FIXED] Issue #1: Task 5 bash 循环已修正

**v1 问题**：Task 5 Step 1 的 for 循环包含了 10 个独立 skills（create-worktree、merge-worktree 等），会将它们错误复制到 `packages/coding-workflow/skills/`。

**v2 验证**：
- for 循环现在仅包含 19 个 coding-workflow 专属 skills（xyz-harness-*、harness-retrospect 等）
- 所有独立 skills 已从循环中移除
- 注释明确标注"复制 19 个 coding-workflow 所属 skills（不含独立 skills）"
- 下方清单列出 19 个 skill，与 for 循环一一对应
- Task 8 Step 1 仍然正确处理 10 个独立 skills → `skills/` 目录
- 无 skill 被遗漏或重复注册

**结论**：修复正确，无回归。

---

## 回归检查

### [REGRESSION] Issue #9: Task 5 Step 1 markdown 格式错误

plan.md L402-405 存在重复的代码块开头：

```
```bash          ← L402: 第一个 ```bash
mkdir -p packages/coding-workflow/skills
```bash          ← L404: 第二个 ```bash（关闭第一个代码块，开启新代码块）
mkdir -p packages/coding-workflow/skills
# 复制 19 个 coding-workflow 所属 skills...
```

L402-403 是一个游离的 `mkdir -p` 行，被 L404 的 ` ```bash` 关闭。实际有效的代码块从 L404 开始。这个格式错误是 v1 修复过程中引入的。

**影响**：`mkdir -p` 是幂等操作，不会造成功能错误。但对 subagent 来说可能产生困惑（多执行一次无害命令）。标记为 LOW。

---

## 新发现问题

### [NEW] Issue #10: Task 8 Files 描述数量不一致

Task 8 的 Files 描述（L620）说"Create: `skills/create-worktree/` 等 **7 个**独立 skill"，但 Step 1 的 for 循环实际包含 **10 个** skill：

1. create-worktree
2. merge-worktree
3. remove-worktree
4. code-review-worktree
5. zcommit
6. browser-automation
7. code-link
8. meta-sk-agent-writer
9. meta-sk-skill-writer
10. vision-analysis

for 循环是正确的（与 spec FR-4 完整清单一致），只有 Files 描述的数量文字有误。

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | ~~MUST FIX~~ | plan.md:Task 5 Step 1 | [FIXED] bash 循环已修正为仅含 19 个 coding-workflow 专属 skills | — |
| 2 | LOW | plan.md:Task 7 Step 1 | git mv 路径 `packages/../../skills/` 可读性差 | 改为从项目根目录执行：`git mv skills/evolve packages/evolve-daily/skills/evolve` |
| 3 | ~~LOW~~ | plan.md:Task 5 描述 | [FIXED] 数量已修正为 19 个 | — |
| 4 | LOW | plan.md:Task 5/Task 7 | CP-3 无显式验证步骤 | 在 Task 5 Step 3 后添加 CP-3 验证：启动 Pi 检查 coding-workflow 内嵌 skills 注册 |
| 5 | LOW | plan.md:BG3 | BG3 ~35 个目录超出指导原则 | 可接受（机械复制操作），建议不拆分 |
| 6 | LOW | e2e-test-plan.md:TS-3.5 | 说 19 个，spec 说 ~20 个 | spec 中 ~20 是约数，统一为 19 |
| 7 | INFO | plan.md:Task 5 & Task 7 | resources_discover 代码重复 | 迁移后可提取共享 utility |
| 8 | INFO | plan.md (全局) | 未说明 git 历史保留策略 | 如需保留可 `git merge --allow-unrelated-histories`，否则在 spec 中明确说明 |
| 9 | LOW | plan.md:Task 5 Step 1 (L402-405) | [REGRESSION] markdown 格式错误：重复的 ` ```bash` 和游离的 mkdir 行 | 删除 L402-403 的游离 ` ```bash` 和 `mkdir` 行，只保留 L404 开始的完整代码块 |
| 10 | LOW | plan.md:Task 8 Files (L620) | [NEW] 描述说「7 个独立 skill」但 for 循环有 10 个 | 将"7 个"改为"10 个" |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## 结论

通过。

v1 的唯一 MUST_FIX（Issue #1）已正确修复，Task 5 的 bash 循环现在只包含 19 个 coding-workflow 专属 skills，独立 skills 在 Task 8 中单独处理。修复未引入功能性回归。本轮新发现 2 条 LOW 级问题（markdown 格式错误 #9、数量描述不一致 #10），均不阻塞。

### Summary

计划评审完成，第2轮通过，0条MUST FIX。
