---
review:
  type: spec_review
  round: 1
  timestamp: "2026-06-01T22:00:00"
  target: ".xyz-harness/2026-06-01-merge-harness-extensions-monorepo/spec.md"
  verdict: fail
  summary: "Spec 评审第1轮，4条MUST FIX（todolist 策略矛盾、缺少功能回归AC、subagent去重缺乏细节、Python脚本迁移未说明），需修改后重审"

statistics:
  total_issues: 8
  must_fix: 4
  must_fix_resolved: 0
  low: 3
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-6 + AC-5"
    title: "todolist 迁移策略自相矛盾"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "spec.md:AC (全体) + Constraint 7"
    title: "缺少功能回归验证的验收标准"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "spec.md:FR-5"
    title: "subagent 去重缺乏具体改动说明"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: MUST_FIX
    location: "spec.md:AC-3 + FR-3"
    title: "Python 脚本迁移位置和依赖管理未说明"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "spec.md:FR-3 + AC-3"
    title: "harness 的 agents 和 commands 缺完整清单"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "spec.md:全体"
    title: "缺少里程碑检查点和回滚策略"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: LOW
    location: "spec.md:业务用例"
    title: "业务用例完全为空，缺少受益方说明"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: INFO
    location: "spec.md:Complexity Assessment"
    title: "风险评估较笼统，未识别具体风险场景"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v1

## 评审记录
- 评审时间：2026-06-01 22:00
- 评审类型：计划评审（spec 阶段，仅 spec.md）
- 评审对象：`.xyz-harness/2026-06-01-merge-harness-extensions-monorepo/spec.md`
- 项目约束来源：`CLAUDE.md`（monorepo 架构、设计原则、运行时约束）

## 检查维度：spec 完整性

### 1. 目标明确性 ✅

目标明确：将 xyz-pi-extensions 和 xyz-harness-engineering 两个仓库合并为一个 pnpm workspaces monorepo。一段话能说清楚要做什么，无歧义。

### 2. 范围合理性 ✅

范围有明确边界：Constraint 7 明确"不改变运行时行为，只改变代码组织方式"。这是一个纯结构重构，不涉及功能变更，范围合理。

### 3. 验收标准可量化 ⚠️

大部分 AC 可量化（`pnpm install` 成功、`typecheck` 通过、`changeset publish --dry-run` 不报错等）。但存在以下问题：

**见下方 MUST FIX #1 和 #2。**

### 4. [待决议] 项

无显式 `[待决议]` 标记，但 FR-6 中的条件性描述实质上是未决议项（见 MUST FIX #1）。

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | FR-6 + AC-5 | **todolist 迁移策略自相矛盾**。FR-6 说"如果 todolist 有独特功能，评估后合并到 todo"（条件性保留），AC-5 说"todolist 不迁入"（无条件排除）。执行者无法判断到底要不要迁移。 | 在 spec 中做明确决策：要么"不迁入，如有独特功能记录为后续需求"，要么"先分析差异，再决定"。不能同时写条件性 FR 和无条件 AC。 |
| 2 | MUST FIX | Constraint 7 + AC 全体 | **缺少功能回归验证的验收标准**。Constraint 7 声明"不改变运行时行为"，但所有 AC 只检查结构（目录、package.json）和静态分析（typecheck），没有任何 AC 验证迁移后的 extensions 功能是否与迁移前一致。 | 增加 AC 项：对 coding-workflow 的 `coding-workflow-gate` 工具、goal 的 `goal_manager` 工具等核心扩展，执行 smoke test 验证基本功能可用。或至少增加"在 Pi 中加载所有扩展，无启动错误"的 AC。 |
| 3 | MUST FIX | FR-5 | **subagent 去重缺乏具体改动说明**。FR-5 说"改为通过 `workspace:*` 依赖"，但未说明：coding-workflow 中 `lib/subagent.ts` 和 `lib/model-resolve.ts` 的哪些 export 被 coding-workflow 内部使用、是否需要改 import 路径、coding-workflow 的 public API 是否受影响。 | 补充：列出 coding-workflow 中引用 subagent 功能的具体文件和函数，说明迁移后的 import 路径变化。 |
| 4 | MUST FIX | AC-3 + FR-3 | **Python 脚本迁移位置和依赖管理未说明**。AC-3 提到 `gate-check.py` 从 harness 迁入，但 spec 未说明：(1) gate-check.py 在新 monorepo 中的位置（packages/coding-workflow/scripts/? scripts/?）；(2) Python 依赖如何管理（requirements.txt? 随包发布?）；(3) 其他 Python 脚本是否也需要迁移。 | 增加 FR 或在现有 FR 中补充：Python 脚本的迁移目标位置、依赖管理方式、是否纳入 npm 包的 `files` 白名单。 |
| 5 | LOW | FR-3 + AC-3 | **harness 的 agents 和 commands 缺完整清单**。FR-3 列出了 skills 清单（约 20 个），AC-3 第 6 条提到"agents、commands 文件迁入"，但 spec 未列出 agents 和 commands 的完整清单。迁移执行时可能遗漏。 | 在 FR-3 或新的 FR 中列出 harness 仓库中所有 agents 和 commands 的文件名。 |
| 6 | LOW | spec 全体 | **缺少里程碑检查点和回滚策略**。两个仓库合并是高风险的不可逆操作。spec 没有定义中间检查点（如"所有 extension 迁移完成后做一次 typecheck 验证"），也没有回滚方案。 | 建议在 AC 中增加阶段性验证点，或在 Constraints 中说明回滚策略（如"合并前打 tag、合并后保留 harness 仓库只读状态 X 个月"）。 |
| 7 | LOW | 业务用例 | **业务用例完全为空**。虽然是技术性需求，但至少应说明受益方（谁在什么场景下受益）。当前 Background 章节列了问题，但没有说清楚"合并后谁能更高效地做什么"。 | 补充 1-2 个受益场景，如"扩展开发者：修改 subagent 只需改一处代码，不再需要跨仓库 PR"。 |
| 8 | INFO | Complexity Assessment | **风险评估较笼统**。"代码搬迁容易出错"没有具体化。实际上最大的风险点是 subagent 去重（两个独立实现可能有行为差异）和 skill 资源路径变化。 | 建议识别 2-3 个具体风险场景及对应缓解措施。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

### 等级判定校准验证

| # | 校验规则 | 适用？ | 判定 |
|---|---------|--------|------|
| 1 | 数据丢失 | 不适用 | — |
| 2 | 功能失效 | 不适用 | — |
| 3 | 数据语义错误 | 不适用 | — |
| 4 | 重复副作用 | 不适用 | — |
| 5 | 时序错误 | 不适用 | — |

本轮 MUST_FIX 均基于 spec 完整性不足（信息缺失导致无法正确执行），非运行时功能缺陷。

## 结论

需修改后重审。4 条 MUST_FIX 均为 spec 信息缺失问题，不影响整体方向的正确性，但会导致执行者在迁移过程中做出未经验证的决策。

## Summary

Spec 评审完成，第1轮，4条MUST FIX（todolist 策略矛盾、缺少功能回归 AC、subagent 去重缺乏细节、Python 脚本迁移未说明），需修改后重审。
